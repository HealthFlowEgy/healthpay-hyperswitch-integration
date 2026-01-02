import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, IsNull, In, LessThanOrEqual } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';
import { Settlement, SettlementStatus } from '../entities/settlement.entity';
import { SettlementItem } from '../entities/settlement-item.entity';
import { SubMerchant } from '../entities/sub-merchant.entity';
import { Refund } from '../entities/refund.entity';
import { Dispute } from '../entities/dispute.entity';
import { Reserve } from '../entities/reserve.entity';
import { Payout, PayoutStatus } from '../entities/payout.entity';
import { PayoutService } from './payout.service';
import { NotificationService } from './notification.service';
import { Decimal } from 'decimal.js';

/**
 * Settlement Engine
 * 
 * Handles:
 * - Daily settlement calculation
 * - Fee aggregation
 * - Reserve management
 * - Settlement approval workflow
 * - Payout triggering
 */

export interface SettlementCalculation {
  subMerchantId: string;
  periodStart: Date;
  periodEnd: Date;
  grossSales: Decimal;
  grossRefunds: Decimal;
  grossDisputes: Decimal;
  grossAmount: Decimal;
  processorFees: Decimal;
  platformFees: Decimal;
  refundFees: Decimal;
  disputeFees: Decimal;
  totalFees: Decimal;
  reserveHeld: Decimal;
  reserveReleased: Decimal;
  netAmount: Decimal;
  transactionCount: number;
  refundCount: number;
  disputeCount: number;
  transactions: Transaction[];
  refunds: Refund[];
  disputes: Dispute[];
  releasableReserves: Reserve[];
}

@Injectable()
export class SettlementEngineService {
  private readonly logger = new Logger(SettlementEngineService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    @InjectRepository(Settlement)
    private readonly settlementRepo: Repository<Settlement>,
    @InjectRepository(SettlementItem)
    private readonly settlementItemRepo: Repository<SettlementItem>,
    @InjectRepository(SubMerchant)
    private readonly subMerchantRepo: Repository<SubMerchant>,
    @InjectRepository(Refund)
    private readonly refundRepo: Repository<Refund>,
    @InjectRepository(Dispute)
    private readonly disputeRepo: Repository<Dispute>,
    @InjectRepository(Reserve)
    private readonly reserveRepo: Repository<Reserve>,
    private readonly payoutService: PayoutService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Daily settlement job - runs at 2:00 AM Egypt time
   */
  @Cron('0 2 * * *', { timeZone: 'Africa/Cairo' })
  async runDailySettlement(): Promise<void> {
    this.logger.log('Starting daily settlement calculation...');
    
    const settlementDate = new Date();
    settlementDate.setDate(settlementDate.getDate() - 1); // Settle previous day
    
    try {
      await this.calculateSettlementsForDate(settlementDate);
      this.logger.log('Daily settlement calculation completed');
    } catch (error) {
      this.logger.error(`Daily settlement failed: ${error.message}`, error.stack);
      // TODO: Alert operations team
    }
  }

  /**
   * Calculate settlements for all eligible sub-merchants for a specific date
   */
  async calculateSettlementsForDate(settlementDate: Date): Promise<Settlement[]> {
    const settlements: Settlement[] = [];
    
    // Get all active sub-merchants
    const subMerchants = await this.subMerchantRepo.find({
      where: { status: 'active' },
    });

    for (const subMerchant of subMerchants) {
      // Check if this sub-merchant should settle today based on their cycle
      if (!this.shouldSettleToday(subMerchant, settlementDate)) {
        continue;
      }

      try {
        const settlement = await this.calculateSettlementForMerchant(
          subMerchant,
          settlementDate,
        );
        
        if (settlement) {
          settlements.push(settlement);
        }
      } catch (error) {
        this.logger.error(
          `Settlement calculation failed for ${subMerchant.merchantCode}: ${error.message}`,
        );
      }
    }

    return settlements;
  }

  /**
   * Check if sub-merchant should settle based on their settlement cycle
   */
  private shouldSettleToday(subMerchant: SubMerchant, date: Date): boolean {
    const dayOfWeek = date.getDay(); // 0 = Sunday
    const dayOfMonth = date.getDate();

    switch (subMerchant.settlementCycle) {
      case 'D+0':
      case 'D+1':
      case 'D+2':
      case 'D+3':
        return true; // Daily settlement
      
      case 'WEEKLY':
        return dayOfWeek === (subMerchant.settlementDayOfWeek || 0);
      
      case 'BIWEEKLY':
        return dayOfWeek === (subMerchant.settlementDayOfWeek || 0) && 
               (Math.floor(dayOfMonth / 7) % 2 === 0);
      
      case 'MONTHLY':
        return dayOfMonth === (subMerchant.settlementDayOfMonth || 1);
      
      default:
        return true;
    }
  }

  /**
   * Calculate settlement for a single sub-merchant
   */
  async calculateSettlementForMerchant(
    subMerchant: SubMerchant,
    settlementDate: Date,
  ): Promise<Settlement | null> {
    // Determine period based on settlement cycle
    const { periodStart, periodEnd } = this.getSettlementPeriod(
      subMerchant,
      settlementDate,
    );

    // Calculate all amounts
    const calculation = await this.calculateAmounts(
      subMerchant.id,
      periodStart,
      periodEnd,
    );

    // Skip if no transactions
    if (calculation.transactionCount === 0 && 
        calculation.refundCount === 0 && 
        calculation.disputeCount === 0 &&
        calculation.releasableReserves.length === 0) {
      return null;
    }

    // Check minimum payout threshold
    if (calculation.netAmount.lessThan(subMerchant.minimumPayoutAmount || 100)) {
      this.logger.log(
        `Skipping ${subMerchant.merchantCode}: net amount ${calculation.netAmount} below minimum`,
      );
      return null;
    }

    // Create settlement record
    const settlement = await this.createSettlement(
      subMerchant,
      settlementDate,
      calculation,
    );

    // Create settlement line items
    await this.createSettlementItems(settlement, calculation);

    // Update transactions with settlement ID
    await this.markTransactionsSettled(calculation.transactions, settlement.id);
    await this.markRefundsSettled(calculation.refunds, settlement.id);
    await this.markDisputesSettled(calculation.disputes, settlement.id);

    // Handle reserves
    await this.processReserves(subMerchant, settlement, calculation);

    // Auto-approve if below threshold or if configured
    if (this.shouldAutoApprove(subMerchant, calculation.netAmount)) {
      await this.approveSettlement(settlement.id, 'system');
    }

    // Notify merchant
    await this.notificationService.sendSettlementNotification(
      subMerchant,
      settlement,
    );

    return settlement;
  }

  /**
   * Get settlement period based on cycle
   */
  private getSettlementPeriod(
    subMerchant: SubMerchant,
    settlementDate: Date,
  ): { periodStart: Date; periodEnd: Date } {
    const periodEnd = new Date(settlementDate);
    periodEnd.setHours(23, 59, 59, 999);
    
    let periodStart = new Date(settlementDate);
    periodStart.setHours(0, 0, 0, 0);

    // Adjust based on settlement cycle
    const cycleDays = this.getSettlementCycleDays(subMerchant.settlementCycle);
    periodStart.setDate(periodStart.getDate() - cycleDays + 1);

    return { periodStart, periodEnd };
  }

  private getSettlementCycleDays(cycle: string): number {
    switch (cycle) {
      case 'D+0':
      case 'D+1':
      case 'D+2':
      case 'D+3':
        return 1;
      case 'WEEKLY':
        return 7;
      case 'BIWEEKLY':
        return 14;
      case 'MONTHLY':
        return 30;
      default:
        return 1;
    }
  }

  /**
   * Calculate all settlement amounts
   */
  private async calculateAmounts(
    subMerchantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<SettlementCalculation> {
    // Get successful transactions
    const transactions = await this.transactionRepo.find({
      where: {
        subMerchantId,
        status: 'captured',
        settlementId: IsNull(),
        capturedAt: Between(periodStart, periodEnd),
      },
    });

    // Get refunds
    const refunds = await this.refundRepo.find({
      where: {
        subMerchantId,
        status: 'completed',
        settlementId: IsNull(),
        completedAt: Between(periodStart, periodEnd),
      },
    });

    // Get lost disputes
    const disputes = await this.disputeRepo.find({
      where: {
        subMerchantId,
        status: 'lost',
        settlementId: IsNull(),
        resolvedAt: Between(periodStart, periodEnd),
      },
    });

    // Get releasable reserves
    const releasableReserves = await this.reserveRepo.find({
      where: {
        subMerchantId,
        status: 'held',
        releaseDate: LessThanOrEqual(periodEnd),
      },
    });

    // Calculate totals
    let grossSales = new Decimal(0);
    let processorFees = new Decimal(0);
    let platformFees = new Decimal(0);

    for (const tx of transactions) {
      grossSales = grossSales.plus(tx.amount);
      processorFees = processorFees.plus(tx.processorFee || 0);
      platformFees = platformFees.plus(tx.platformFee || 0);
    }

    let grossRefunds = new Decimal(0);
    let refundFees = new Decimal(0);

    for (const refund of refunds) {
      grossRefunds = grossRefunds.plus(refund.amount);
      refundFees = refundFees.plus(refund.refundFee || 0);
    }

    let grossDisputes = new Decimal(0);
    let disputeFees = new Decimal(0);

    for (const dispute of disputes) {
      grossDisputes = grossDisputes.plus(dispute.amount);
      disputeFees = disputeFees.plus(dispute.disputeFee || 0);
    }

    let reserveReleased = new Decimal(0);
    for (const reserve of releasableReserves) {
      reserveReleased = reserveReleased.plus(reserve.amount);
    }

    const grossAmount = grossSales.minus(grossRefunds).minus(grossDisputes);
    const totalFees = processorFees.plus(platformFees).plus(refundFees).plus(disputeFees);
    const netBeforeReserve = grossAmount.minus(totalFees);

    // Calculate new reserve to hold
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId },
    });
    
    const reservePercentage = new Decimal(subMerchant?.reservePercentage || 0);
    const reserveHeld = grossSales.times(reservePercentage).toDecimalPlaces(2);

    const netAmount = netBeforeReserve.minus(reserveHeld).plus(reserveReleased);

    return {
      subMerchantId,
      periodStart,
      periodEnd,
      grossSales,
      grossRefunds,
      grossDisputes,
      grossAmount,
      processorFees,
      platformFees,
      refundFees,
      disputeFees,
      totalFees,
      reserveHeld,
      reserveReleased,
      netAmount,
      transactionCount: transactions.length,
      refundCount: refunds.length,
      disputeCount: disputes.length,
      transactions,
      refunds,
      disputes,
      releasableReserves,
    };
  }

  /**
   * Create settlement record
   */
  private async createSettlement(
    subMerchant: SubMerchant,
    settlementDate: Date,
    calculation: SettlementCalculation,
  ): Promise<Settlement> {
    const settlement = this.settlementRepo.create({
      settlementReference: this.generateSettlementReference(),
      subMerchantId: subMerchant.id,
      settlementDate,
      periodStart: calculation.periodStart,
      periodEnd: calculation.periodEnd,
      grossSales: calculation.grossSales.toNumber(),
      grossRefunds: calculation.grossRefunds.toNumber(),
      grossDisputes: calculation.grossDisputes.toNumber(),
      grossAmount: calculation.grossAmount.toNumber(),
      processorFees: calculation.processorFees.toNumber(),
      platformFees: calculation.platformFees.toNumber(),
      refundFees: calculation.refundFees.toNumber(),
      disputeFees: calculation.disputeFees.toNumber(),
      totalFees: calculation.totalFees.toNumber(),
      reserveHeld: calculation.reserveHeld.toNumber(),
      reserveReleased: calculation.reserveReleased.toNumber(),
      netAmount: calculation.netAmount.toNumber(),
      transactionCount: calculation.transactionCount,
      refundCount: calculation.refundCount,
      disputeCount: calculation.disputeCount,
      status: SettlementStatus.CALCULATED,
      calculatedAt: new Date(),
    });

    return this.settlementRepo.save(settlement);
  }

  /**
   * Create settlement line items for detailed breakdown
   */
  private async createSettlementItems(
    settlement: Settlement,
    calculation: SettlementCalculation,
  ): Promise<void> {
    const items: Partial<SettlementItem>[] = [];

    // Transaction items
    for (const tx of calculation.transactions) {
      items.push({
        settlementId: settlement.id,
        itemType: 'transaction',
        referenceId: tx.id,
        referenceNumber: tx.transactionReference,
        description: `Payment - ${tx.paymentMethod}`,
        grossAmount: tx.amount,
        feeAmount: (tx.processorFee || 0) + (tx.platformFee || 0),
        netAmount: tx.netAmount,
      });
    }

    // Refund items
    for (const refund of calculation.refunds) {
      items.push({
        settlementId: settlement.id,
        itemType: 'refund',
        referenceId: refund.id,
        referenceNumber: refund.refundReference,
        description: `Refund`,
        grossAmount: -refund.amount,
        feeAmount: refund.refundFee || 0,
        netAmount: -refund.netAmount,
      });
    }

    // Dispute items
    for (const dispute of calculation.disputes) {
      items.push({
        settlementId: settlement.id,
        itemType: 'dispute',
        referenceId: dispute.id,
        referenceNumber: dispute.disputeReference,
        description: `Dispute - ${dispute.reasonCode}`,
        grossAmount: -dispute.amount,
        feeAmount: dispute.disputeFee || 0,
        netAmount: -(dispute.amount + (dispute.disputeFee || 0)),
      });
    }

    // Reserve held
    if (calculation.reserveHeld.greaterThan(0)) {
      items.push({
        settlementId: settlement.id,
        itemType: 'reserve',
        description: 'Rolling reserve held',
        grossAmount: 0,
        feeAmount: 0,
        netAmount: -calculation.reserveHeld.toNumber(),
      });
    }

    // Reserve released
    for (const reserve of calculation.releasableReserves) {
      items.push({
        settlementId: settlement.id,
        itemType: 'reserve',
        referenceId: reserve.id,
        description: 'Rolling reserve released',
        grossAmount: 0,
        feeAmount: 0,
        netAmount: reserve.amount,
      });
    }

    await this.settlementItemRepo.save(items);
  }

  /**
   * Mark transactions as settled
   */
  private async markTransactionsSettled(
    transactions: Transaction[],
    settlementId: string,
  ): Promise<void> {
    if (transactions.length === 0) return;

    await this.transactionRepo.update(
      { id: In(transactions.map(t => t.id)) },
      { settlementId, settledAt: new Date() },
    );
  }

  private async markRefundsSettled(
    refunds: Refund[],
    settlementId: string,
  ): Promise<void> {
    if (refunds.length === 0) return;

    await this.refundRepo.update(
      { id: In(refunds.map(r => r.id)) },
      { settlementId },
    );
  }

  private async markDisputesSettled(
    disputes: Dispute[],
    settlementId: string,
  ): Promise<void> {
    if (disputes.length === 0) return;

    await this.disputeRepo.update(
      { id: In(disputes.map(d => d.id)) },
      { settlementId },
    );
  }

  /**
   * Process reserves - hold new reserves and release old ones
   */
  private async processReserves(
    subMerchant: SubMerchant,
    settlement: Settlement,
    calculation: SettlementCalculation,
  ): Promise<void> {
    // Create new reserve if applicable
    if (calculation.reserveHeld.greaterThan(0)) {
      const releaseDate = new Date();
      releaseDate.setDate(releaseDate.getDate() + (subMerchant.reserveDays || 90));

      await this.reserveRepo.save({
        subMerchantId: subMerchant.id,
        settlementId: settlement.id,
        reserveType: 'rolling',
        amount: calculation.reserveHeld.toNumber(),
        releaseDate,
        status: 'held',
      });
    }

    // Release old reserves
    for (const reserve of calculation.releasableReserves) {
      reserve.status = 'released';
      reserve.releasedAt = new Date();
      await this.reserveRepo.save(reserve);
    }
  }

  /**
   * Check if settlement should be auto-approved
   */
  private shouldAutoApprove(subMerchant: SubMerchant, netAmount: Decimal): boolean {
    // Auto-approve if below threshold (e.g., 50,000 EGP)
    const autoApproveThreshold = 50000;
    
    // Also check merchant risk score
    if (subMerchant.riskScore && subMerchant.riskScore > 70) {
      return false; // Require manual review for high-risk merchants
    }

    return netAmount.lessThanOrEqualTo(autoApproveThreshold);
  }

  /**
   * Approve a settlement and trigger payout
   */
  async approveSettlement(
    settlementId: string,
    approvedBy: string,
  ): Promise<Settlement> {
    const settlement = await this.settlementRepo.findOne({
      where: { id: settlementId },
      relations: ['subMerchant'],
    });

    if (!settlement) {
      throw new Error('Settlement not found');
    }

    if (settlement.status !== SettlementStatus.CALCULATED) {
      throw new Error(`Cannot approve settlement in status: ${settlement.status}`);
    }

    settlement.status = SettlementStatus.APPROVED;
    settlement.approvedAt = new Date();
    settlement.approvedBy = approvedBy;

    await this.settlementRepo.save(settlement);

    // Trigger payout
    await this.createPayoutForSettlement(settlement);

    return settlement;
  }

  /**
   * Create payout for an approved settlement
   */
  private async createPayoutForSettlement(settlement: Settlement): Promise<Payout> {
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: settlement.subMerchantId },
      relations: ['bank'],
    });

    // Calculate payout fee
    const payoutFee = this.calculatePayoutFee(
      subMerchant.payoutMethod,
      settlement.netAmount,
    );

    const payout = await this.payoutService.createPayout({
      subMerchantId: subMerchant.id,
      settlementId: settlement.id,
      amount: settlement.netAmount,
      fee: payoutFee,
      method: subMerchant.payoutMethod,
      destinationDetails: this.getPayoutDestination(subMerchant),
      scheduledDate: this.getPayoutDate(subMerchant.settlementCycle),
    });

    // Update settlement with payout ID
    settlement.payoutId = payout.id;
    await this.settlementRepo.save(settlement);

    return payout;
  }

  private calculatePayoutFee(method: string, amount: number): number {
    switch (method) {
      case 'bank_transfer':
        return 10.00;
      case 'instapay':
        return 5.00;
      case 'wallet':
        return 3.00;
      default:
        return 10.00;
    }
  }

  private getPayoutDestination(subMerchant: SubMerchant): any {
    switch (subMerchant.payoutMethod) {
      case 'bank_transfer':
        return {
          bankId: subMerchant.bankId,
          accountNumber: subMerchant.bankAccountNumber,
          accountName: subMerchant.bankAccountName,
          iban: subMerchant.iban,
        };
      case 'instapay':
        return {
          ipa: subMerchant.instapayIpa,
        };
      case 'wallet':
        return {
          provider: 'vodafone',
          number: subMerchant.vodafoneCashNumber,
        };
      default:
        throw new Error('Invalid payout method');
    }
  }

  private getPayoutDate(settlementCycle: string): Date {
    const date = new Date();
    
    switch (settlementCycle) {
      case 'D+0':
        return date;
      case 'D+1':
        date.setDate(date.getDate() + 1);
        return date;
      case 'D+2':
        date.setDate(date.getDate() + 2);
        return date;
      case 'D+3':
        date.setDate(date.getDate() + 3);
        return date;
      default:
        date.setDate(date.getDate() + 1);
        return date;
    }
  }

  /**
   * Generate unique settlement reference
   */
  private generateSettlementReference(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `STL-${dateStr}-${random}`;
  }

  /**
   * Get settlement by ID with all details
   */
  async getSettlementDetails(settlementId: string): Promise<Settlement> {
    return this.settlementRepo.findOne({
      where: { id: settlementId },
      relations: ['subMerchant', 'items', 'payout'],
    });
  }

  /**
   * Get settlements for a sub-merchant
   */
  async getSettlementsForMerchant(
    subMerchantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<Settlement[]> {
    const where: any = { subMerchantId };

    if (startDate && endDate) {
      where.settlementDate = Between(startDate, endDate);
    }

    return this.settlementRepo.find({
      where,
      order: { settlementDate: 'DESC' },
      relations: ['payout'],
    });
  }

  /**
   * Reject a settlement
   */
  async rejectSettlement(
    settlementId: string,
    rejectedBy: string,
    reason: string,
  ): Promise<Settlement> {
    const settlement = await this.settlementRepo.findOne({
      where: { id: settlementId },
    });

    if (!settlement) {
      throw new Error('Settlement not found');
    }

    // Unsettle transactions
    await this.transactionRepo.update(
      { settlementId },
      { settlementId: null, settledAt: null },
    );

    await this.refundRepo.update(
      { settlementId },
      { settlementId: null },
    );

    // Update settlement
    settlement.status = SettlementStatus.ON_HOLD;
    settlement.adjustmentNotes = reason;

    return this.settlementRepo.save(settlement);
  }
}
