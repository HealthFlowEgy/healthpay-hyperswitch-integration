import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThanOrEqual } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Payout, PayoutStatus, PayoutMethod } from '../entities/payout.entity';
import { PayoutBatch } from '../entities/payout-batch.entity';
import { SubMerchant } from '../entities/sub-merchant.entity';
import { Settlement } from '../entities/settlement.entity';
import { NotificationService } from './notification.service';
import { InstapayService } from './instapay.service';
import { BankTransferService } from './bank-transfer.service';
import { Decimal } from 'decimal.js';

/**
 * Payout Service
 * 
 * Handles automated payouts to sub-merchants via:
 * - InstaPay (instant transfers)
 * - Bank Transfer (ACH/SWIFT)
 * - Mobile Wallets (Vodafone Cash, Orange, etc.)
 * 
 * Features:
 * - Scheduled payout processing
 * - Batch processing for efficiency
 * - Retry logic for failed payouts
 * - Reconciliation support
 */

export interface CreatePayoutDto {
  subMerchantId: string;
  settlementId?: string;
  amount: number;
  fee: number;
  method: PayoutMethod;
  destinationDetails: any;
  scheduledDate: Date;
  notes?: string;
}

export interface PayoutResult {
  success: boolean;
  payoutId: string;
  processorReference?: string;
  error?: string;
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    @InjectRepository(Payout)
    private readonly payoutRepo: Repository<Payout>,
    @InjectRepository(PayoutBatch)
    private readonly batchRepo: Repository<PayoutBatch>,
    @InjectRepository(SubMerchant)
    private readonly subMerchantRepo: Repository<SubMerchant>,
    @InjectRepository(Settlement)
    private readonly settlementRepo: Repository<Settlement>,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly instapayService: InstapayService,
    private readonly bankTransferService: BankTransferService,
  ) {}

  /**
   * Process scheduled payouts - runs every hour at :15
   */
  @Cron('15 * * * *', { timeZone: 'Africa/Cairo' })
  async processScheduledPayouts(): Promise<void> {
    this.logger.log('Processing scheduled payouts...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get pending payouts scheduled for today or earlier
    const pendingPayouts = await this.payoutRepo.find({
      where: {
        status: PayoutStatus.APPROVED,
        scheduledDate: LessThanOrEqual(today),
      },
      relations: ['subMerchant'],
      order: { scheduledDate: 'ASC' },
    });

    if (pendingPayouts.length === 0) {
      this.logger.log('No pending payouts to process');
      return;
    }

    this.logger.log(`Found ${pendingPayouts.length} payouts to process`);

    // Group by payout method for batch processing
    const byMethod = this.groupPayoutsByMethod(pendingPayouts);

    // Process each method
    for (const [method, payouts] of Object.entries(byMethod)) {
      await this.processPayoutBatch(method as PayoutMethod, payouts);
    }
  }

  /**
   * Create a new payout
   */
  async createPayout(dto: CreatePayoutDto): Promise<Payout> {
    const netAmount = new Decimal(dto.amount).minus(dto.fee).toNumber();

    const payout = this.payoutRepo.create({
      payoutReference: this.generatePayoutReference(),
      subMerchantId: dto.subMerchantId,
      amount: dto.amount,
      fee: dto.fee,
      netAmount,
      payoutMethod: dto.method,
      ...this.extractDestinationDetails(dto.method, dto.destinationDetails),
      scheduledDate: dto.scheduledDate,
      notes: dto.notes,
      status: this.requiresApproval(dto.amount) 
        ? PayoutStatus.PENDING 
        : PayoutStatus.APPROVED,
      requiresApproval: this.requiresApproval(dto.amount),
    });

    const savedPayout = await this.payoutRepo.save(payout);

    // Link to settlement if provided
    if (dto.settlementId) {
      await this.settlementRepo.update(dto.settlementId, {
        payoutId: savedPayout.id,
      });
    }

    return savedPayout;
  }

  /**
   * Approve a payout
   */
  async approvePayout(payoutId: string, approvedBy: string): Promise<Payout> {
    const payout = await this.payoutRepo.findOne({
      where: { id: payoutId },
    });

    if (!payout) {
      throw new Error('Payout not found');
    }

    if (payout.status !== PayoutStatus.PENDING) {
      throw new Error(`Cannot approve payout in status: ${payout.status}`);
    }

    payout.status = PayoutStatus.APPROVED;
    payout.approvedAt = new Date();
    payout.approvedBy = approvedBy;

    return this.payoutRepo.save(payout);
  }

  /**
   * Process a single payout immediately
   */
  async processPayout(payoutId: string): Promise<PayoutResult> {
    const payout = await this.payoutRepo.findOne({
      where: { id: payoutId },
      relations: ['subMerchant'],
    });

    if (!payout) {
      return { success: false, payoutId, error: 'Payout not found' };
    }

    if (payout.status !== PayoutStatus.APPROVED) {
      return { success: false, payoutId, error: `Invalid status: ${payout.status}` };
    }

    // Update status to processing
    payout.status = PayoutStatus.PROCESSING;
    payout.initiatedAt = new Date();
    await this.payoutRepo.save(payout);

    try {
      let result: { success: boolean; reference?: string; error?: string };

      switch (payout.payoutMethod) {
        case PayoutMethod.INSTAPAY:
          result = await this.processInstapayPayout(payout);
          break;
        case PayoutMethod.BANK_TRANSFER:
          result = await this.processBankTransferPayout(payout);
          break;
        case PayoutMethod.WALLET:
          result = await this.processWalletPayout(payout);
          break;
        default:
          throw new Error(`Unsupported payout method: ${payout.payoutMethod}`);
      }

      if (result.success) {
        payout.status = PayoutStatus.SENT;
        payout.processorReference = result.reference;
        payout.processorStatus = 'sent';
        await this.payoutRepo.save(payout);

        // Send notification to merchant
        await this.notificationService.sendPayoutNotification(
          payout.subMerchant,
          payout,
          'sent',
        );

        return {
          success: true,
          payoutId: payout.id,
          processorReference: result.reference,
        };
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      this.logger.error(`Payout ${payoutId} failed: ${error.message}`);

      payout.retryCount += 1;
      payout.failureCode = 'PROCESSING_ERROR';
      payout.failureMessage = error.message;

      if (payout.retryCount >= payout.maxRetries) {
        payout.status = PayoutStatus.FAILED;
        
        // Notify operations team
        await this.notificationService.sendPayoutFailureAlert(payout);
      } else {
        // Will retry next processing cycle
        payout.status = PayoutStatus.APPROVED;
      }

      await this.payoutRepo.save(payout);

      return {
        success: false,
        payoutId: payout.id,
        error: error.message,
      };
    }
  }

  /**
   * Process InstaPay payout
   */
  private async processInstapayPayout(
    payout: Payout,
  ): Promise<{ success: boolean; reference?: string; error?: string }> {
    try {
      const result = await this.instapayService.sendPayment({
        destinationIPA: payout.destinationIpa,
        amount: payout.netAmount,
        currency: 'EGP',
        reference: payout.payoutReference,
        narration: `HealthPay Payout - ${payout.subMerchant?.businessName}`,
      });

      return {
        success: true,
        reference: result.transactionReference,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Process Bank Transfer payout
   */
  private async processBankTransferPayout(
    payout: Payout,
  ): Promise<{ success: boolean; reference?: string; error?: string }> {
    try {
      const result = await this.bankTransferService.initiateTransfer({
        destinationBank: payout.destinationBank?.swiftCode,
        accountNumber: payout.destinationAccountNumber,
        accountName: payout.destinationAccountName,
        iban: payout.destinationIban,
        amount: payout.netAmount,
        currency: 'EGP',
        reference: payout.payoutReference,
        narration: `HealthPay Settlement`,
      });

      return {
        success: true,
        reference: result.transactionReference,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Process Wallet payout (Vodafone Cash, etc.)
   */
  private async processWalletPayout(
    payout: Payout,
  ): Promise<{ success: boolean; reference?: string; error?: string }> {
    // TODO: Implement wallet payout integration
    // This would integrate with Vodafone Cash, Orange Money, etc.
    return {
      success: false,
      error: 'Wallet payouts not yet implemented',
    };
  }

  /**
   * Process batch of payouts for a specific method
   */
  private async processPayoutBatch(
    method: PayoutMethod,
    payouts: Payout[],
  ): Promise<void> {
    this.logger.log(`Processing ${payouts.length} ${method} payouts`);

    // Create batch record
    const totalAmount = payouts.reduce((sum, p) => sum + p.amount, 0);
    const totalFees = payouts.reduce((sum, p) => sum + p.fee, 0);

    const batch = this.batchRepo.create({
      batchReference: this.generateBatchReference(),
      payoutMethod: method,
      scheduledDate: new Date(),
      totalAmount,
      totalFees,
      payoutCount: payouts.length,
      status: 'processing',
    });

    await this.batchRepo.save(batch);

    // Update payouts with batch ID
    await this.payoutRepo.update(
      { id: In(payouts.map(p => p.id)) },
      { batchId: batch.id },
    );

    // Process each payout
    let successCount = 0;
    let failedCount = 0;

    for (const payout of payouts) {
      const result = await this.processPayout(payout.id);
      if (result.success) {
        successCount++;
      } else {
        failedCount++;
      }

      // Add small delay between payouts to avoid rate limiting
      await this.delay(500);
    }

    // Update batch status
    batch.successfulCount = successCount;
    batch.failedCount = failedCount;
    batch.status = failedCount === 0 
      ? 'completed' 
      : successCount === 0 
        ? 'failed' 
        : 'partially_completed';
    batch.processedAt = new Date();

    await this.batchRepo.save(batch);

    this.logger.log(
      `Batch ${batch.batchReference} completed: ${successCount} successful, ${failedCount} failed`,
    );
  }

  /**
   * Confirm payout completion (from webhook or reconciliation)
   */
  async confirmPayoutCompletion(
    processorReference: string,
    status: 'completed' | 'failed',
    details?: any,
  ): Promise<void> {
    const payout = await this.payoutRepo.findOne({
      where: { processorReference },
      relations: ['subMerchant'],
    });

    if (!payout) {
      this.logger.warn(`Payout not found for reference: ${processorReference}`);
      return;
    }

    if (status === 'completed') {
      payout.status = PayoutStatus.COMPLETED;
      payout.completedAt = new Date();
      payout.processorStatus = 'completed';
      payout.processorResponse = details;

      // Notify merchant
      await this.notificationService.sendPayoutNotification(
        payout.subMerchant,
        payout,
        'completed',
      );
    } else {
      payout.status = PayoutStatus.FAILED;
      payout.processorStatus = 'failed';
      payout.processorResponse = details;
      payout.failureMessage = details?.reason || 'Transfer failed';

      // Notify operations
      await this.notificationService.sendPayoutFailureAlert(payout);
    }

    await this.payoutRepo.save(payout);
  }

  /**
   * Get payout by ID
   */
  async getPayoutById(payoutId: string): Promise<Payout> {
    return this.payoutRepo.findOne({
      where: { id: payoutId },
      relations: ['subMerchant', 'settlement', 'destinationBank'],
    });
  }

  /**
   * Get payouts for sub-merchant
   */
  async getPayoutsForMerchant(
    subMerchantId: string,
    status?: PayoutStatus,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ payouts: Payout[]; total: number }> {
    const where: any = { subMerchantId };
    if (status) {
      where.status = status;
    }

    const [payouts, total] = await this.payoutRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { payouts, total };
  }

  /**
   * Get pending payout summary
   */
  async getPendingPayoutSummary(): Promise<{
    totalPending: number;
    totalAmount: number;
    byMethod: Record<string, { count: number; amount: number }>;
  }> {
    const pending = await this.payoutRepo.find({
      where: { status: In([PayoutStatus.PENDING, PayoutStatus.APPROVED]) },
    });

    const byMethod: Record<string, { count: number; amount: number }> = {};

    for (const payout of pending) {
      if (!byMethod[payout.payoutMethod]) {
        byMethod[payout.payoutMethod] = { count: 0, amount: 0 };
      }
      byMethod[payout.payoutMethod].count++;
      byMethod[payout.payoutMethod].amount += payout.netAmount;
    }

    return {
      totalPending: pending.length,
      totalAmount: pending.reduce((sum, p) => sum + p.netAmount, 0),
      byMethod,
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private generatePayoutReference(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `PO-${dateStr}-${random}`;
  }

  private generateBatchReference(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `BAT-${dateStr}-${random}`;
  }

  private requiresApproval(amount: number): boolean {
    const threshold = this.configService.get<number>('PAYOUT_AUTO_APPROVE_THRESHOLD', 50000);
    return amount > threshold;
  }

  private extractDestinationDetails(method: PayoutMethod, details: any): any {
    switch (method) {
      case PayoutMethod.BANK_TRANSFER:
        return {
          destinationBankId: details.bankId,
          destinationAccountNumber: details.accountNumber,
          destinationAccountName: details.accountName,
          destinationIban: details.iban,
        };
      case PayoutMethod.INSTAPAY:
        return {
          destinationIpa: details.ipa,
        };
      case PayoutMethod.WALLET:
        return {
          destinationWalletNumber: details.number,
          destinationWalletProvider: details.provider,
        };
      default:
        return {};
    }
  }

  private groupPayoutsByMethod(payouts: Payout[]): Record<string, Payout[]> {
    return payouts.reduce((groups, payout) => {
      const method = payout.payoutMethod;
      if (!groups[method]) {
        groups[method] = [];
      }
      groups[method].push(payout);
      return groups;
    }, {} as Record<string, Payout[]>);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
