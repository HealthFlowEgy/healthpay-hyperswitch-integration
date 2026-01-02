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
import { InstapayService } from '../integrations/instapay.service';
import { BankTransferService } from '../integrations/bank-transfer.service';
import { WalletPayoutService } from '../integrations/wallet-payout.service';
import { Decimal } from 'decimal.js';

/**
 * Payout Service
 * 
 * Handles:
 * - Individual payout creation
 * - Batch payout processing
 * - InstaPay integration (instant)
 * - Bank transfer integration (ACH/RTGS)
 * - Wallet payout (Vodafone Cash, etc.)
 * - Retry logic for failed payouts
 * - Reconciliation
 */

export interface CreatePayoutDto {
  subMerchantId: string;
  settlementId?: string;
  amount: number;
  fee?: number;
  method: PayoutMethod;
  destinationDetails: PayoutDestination;
  scheduledDate?: Date;
  notes?: string;
}

export interface PayoutDestination {
  // Bank Transfer
  bankId?: string;
  accountNumber?: string;
  accountName?: string;
  iban?: string;
  swiftCode?: string;
  
  // InstaPay
  ipa?: string;
  
  // Wallet
  provider?: string;
  number?: string;
}

export interface PayoutResult {
  success: boolean;
  payoutId: string;
  processorReference?: string;
  status: PayoutStatus;
  message?: string;
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(
    @InjectRepository(Payout)
    private readonly payoutRepo: Repository<Payout>,
    @InjectRepository(PayoutBatch)
    private readonly payoutBatchRepo: Repository<PayoutBatch>,
    @InjectRepository(SubMerchant)
    private readonly subMerchantRepo: Repository<SubMerchant>,
    @InjectRepository(Settlement)
    private readonly settlementRepo: Repository<Settlement>,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly instapayService: InstapayService,
    private readonly bankTransferService: BankTransferService,
    private readonly walletPayoutService: WalletPayoutService,
  ) {}

  /**
   * Process scheduled payouts - runs at 10:00 AM Egypt time
   */
  @Cron('0 10 * * *', { timeZone: 'Africa/Cairo' })
  async processScheduledPayouts(): Promise<void> {
    this.logger.log('Starting scheduled payout processing...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get pending payouts scheduled for today or earlier
    const pendingPayouts = await this.payoutRepo.find({
      where: {
        status: PayoutStatus.PENDING,
        scheduledDate: LessThanOrEqual(today),
      },
      relations: ['subMerchant'],
      order: { scheduledDate: 'ASC' },
    });

    if (pendingPayouts.length === 0) {
      this.logger.log('No pending payouts to process');
      return;
    }

    this.logger.log(`Processing ${pendingPayouts.length} payouts`);

    // Group by payout method for batch processing
    const byMethod = this.groupByMethod(pendingPayouts);

    // Process InstaPay (instant, one by one)
    if (byMethod[PayoutMethod.INSTAPAY]?.length > 0) {
      await this.processInstapayPayouts(byMethod[PayoutMethod.INSTAPAY]);
    }

    // Process Bank Transfers (batched)
    if (byMethod[PayoutMethod.BANK_TRANSFER]?.length > 0) {
      await this.processBankTransferBatch(byMethod[PayoutMethod.BANK_TRANSFER]);
    }

    // Process Wallet Payouts
    if (byMethod[PayoutMethod.WALLET]?.length > 0) {
      await this.processWalletPayouts(byMethod[PayoutMethod.WALLET]);
    }

    this.logger.log('Scheduled payout processing completed');
  }

  /**
   * Retry failed payouts - runs at 3:00 PM Egypt time
   */
  @Cron('0 15 * * *', { timeZone: 'Africa/Cairo' })
  async retryFailedPayouts(): Promise<void> {
    this.logger.log('Retrying failed payouts...');

    const failedPayouts = await this.payoutRepo.find({
      where: {
        status: PayoutStatus.FAILED,
      },
      relations: ['subMerchant'],
    });

    // Filter payouts that can be retried
    const retriable = failedPayouts.filter(p => p.retryCount < p.maxRetries);

    for (const payout of retriable) {
      try {
        await this.processSinglePayout(payout);
      } catch (error) {
        this.logger.error(`Retry failed for payout ${payout.id}: ${error.message}`);
      }
    }
  }

  /**
   * Create a new payout
   */
  async createPayout(dto: CreatePayoutDto): Promise<Payout> {
    const netAmount = new Decimal(dto.amount).minus(dto.fee || 0).toNumber();

    const payout = this.payoutRepo.create({
      payoutReference: this.generatePayoutReference(),
      subMerchantId: dto.subMerchantId,
      settlementId: dto.settlementId,
      amount: dto.amount,
      fee: dto.fee || this.calculatePayoutFee(dto.method, dto.amount),
      netAmount,
      payoutMethod: dto.method,
      destinationBankId: dto.destinationDetails.bankId,
      destinationAccountNumber: dto.destinationDetails.accountNumber,
      destinationAccountName: dto.destinationDetails.accountName,
      destinationIban: dto.destinationDetails.iban,
      destinationIpa: dto.destinationDetails.ipa,
      destinationWalletNumber: dto.destinationDetails.number,
      destinationWalletProvider: dto.destinationDetails.provider,
      status: PayoutStatus.PENDING,
      scheduledDate: dto.scheduledDate || new Date(),
      notes: dto.notes,
    });

    return this.payoutRepo.save(payout);
  }

  /**
   * Process a single payout
   */
  async processSinglePayout(payout: Payout): Promise<PayoutResult> {
    this.logger.log(`Processing payout ${payout.payoutReference}`);

    // Update status to processing
    payout.status = PayoutStatus.PROCESSING;
    payout.initiatedAt = new Date();
    await this.payoutRepo.save(payout);

    try {
      let result: PayoutResult;

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

      // Update payout with result
      if (result.success) {
        payout.status = PayoutStatus.COMPLETED;
        payout.completedAt = new Date();
        payout.processorReference = result.processorReference;

        // Notify merchant
        await this.notifyPayoutSuccess(payout);
      } else {
        payout.status = PayoutStatus.FAILED;
        payout.failureMessage = result.message;
        payout.retryCount += 1;

        // Notify on final failure
        if (payout.retryCount >= payout.maxRetries) {
          await this.notifyPayoutFailure(payout);
        }
      }

      await this.payoutRepo.save(payout);
      return result;

    } catch (error) {
      this.logger.error(`Payout ${payout.payoutReference} failed: ${error.message}`);

      payout.status = PayoutStatus.FAILED;
      payout.failureMessage = error.message;
      payout.retryCount += 1;
      await this.payoutRepo.save(payout);

      return {
        success: false,
        payoutId: payout.id,
        status: PayoutStatus.FAILED,
        message: error.message,
      };
    }
  }

  /**
   * Process InstaPay payout (instant)
   */
  private async processInstapayPayout(payout: Payout): Promise<PayoutResult> {
    if (!payout.destinationIpa) {
      throw new Error('InstaPay IPA address is required');
    }

    const result = await this.instapayService.sendPayment({
      amount: payout.netAmount,
      currency: 'EGP',
      recipientIpa: payout.destinationIpa,
      reference: payout.payoutReference,
      narration: `HealthPay Payout - ${payout.payoutReference}`,
    });

    return {
      success: result.success,
      payoutId: payout.id,
      processorReference: result.transactionId,
      status: result.success ? PayoutStatus.COMPLETED : PayoutStatus.FAILED,
      message: result.message,
    };
  }

  /**
   * Process bank transfer payout
   */
  private async processBankTransferPayout(payout: Payout): Promise<PayoutResult> {
    const result = await this.bankTransferService.initiateTransfer({
      amount: payout.netAmount,
      currency: 'EGP',
      recipientAccountNumber: payout.destinationAccountNumber,
      recipientAccountName: payout.destinationAccountName,
      recipientBankCode: payout.destinationBankId,
      recipientIban: payout.destinationIban,
      reference: payout.payoutReference,
      narration: `HealthPay Settlement - ${payout.payoutReference}`,
    });

    return {
      success: result.success,
      payoutId: payout.id,
      processorReference: result.transactionId,
      status: result.success ? PayoutStatus.SENT : PayoutStatus.FAILED,
      message: result.message,
    };
  }

  /**
   * Process wallet payout
   */
  private async processWalletPayout(payout: Payout): Promise<PayoutResult> {
    const result = await this.walletPayoutService.sendToWallet({
      amount: payout.netAmount,
      provider: payout.destinationWalletProvider,
      walletNumber: payout.destinationWalletNumber,
      reference: payout.payoutReference,
    });

    return {
      success: result.success,
      payoutId: payout.id,
      processorReference: result.transactionId,
      status: result.success ? PayoutStatus.COMPLETED : PayoutStatus.FAILED,
      message: result.message,
    };
  }

  /**
   * Process multiple InstaPay payouts
   */
  private async processInstapayPayouts(payouts: Payout[]): Promise<void> {
    for (const payout of payouts) {
      try {
        await this.processSinglePayout(payout);
        // Small delay between instant payments
        await this.delay(500);
      } catch (error) {
        this.logger.error(`InstaPay payout failed: ${error.message}`);
      }
    }
  }

  /**
   * Process bank transfer batch
   */
  private async processBankTransferBatch(payouts: Payout[]): Promise<void> {
    // Create batch record
    const batch = this.payoutBatchRepo.create({
      batchReference: this.generateBatchReference(),
      payoutMethod: PayoutMethod.BANK_TRANSFER,
      scheduledDate: new Date(),
      totalAmount: payouts.reduce((sum, p) => sum + p.netAmount, 0),
      totalFees: payouts.reduce((sum, p) => sum + p.fee, 0),
      payoutCount: payouts.length,
      status: 'processing',
    });
    await this.payoutBatchRepo.save(batch);

    // Link payouts to batch
    await this.payoutRepo.update(
      { id: In(payouts.map(p => p.id)) },
      { batchId: batch.id },
    );

    // Submit batch to bank
    try {
      const batchResult = await this.bankTransferService.submitBatch({
        batchReference: batch.batchReference,
        transfers: payouts.map(p => ({
          reference: p.payoutReference,
          amount: p.netAmount,
          accountNumber: p.destinationAccountNumber,
          accountName: p.destinationAccountName,
          bankCode: p.destinationBankId,
          iban: p.destinationIban,
          narration: `HealthPay - ${p.payoutReference}`,
        })),
      });

      if (batchResult.success) {
        batch.status = 'processing';
        batch.processedAt = new Date();

        // Update individual payouts
        await this.payoutRepo.update(
          { batchId: batch.id },
          { status: PayoutStatus.SENT },
        );
      } else {
        batch.status = 'failed';
      }

      await this.payoutBatchRepo.save(batch);

    } catch (error) {
      this.logger.error(`Bank transfer batch failed: ${error.message}`);
      batch.status = 'failed';
      await this.payoutBatchRepo.save(batch);

      // Mark all payouts as failed
      for (const payout of payouts) {
        payout.status = PayoutStatus.FAILED;
        payout.failureMessage = error.message;
        payout.retryCount += 1;
        await this.payoutRepo.save(payout);
      }
    }
  }

  /**
   * Process wallet payouts
   */
  private async processWalletPayouts(payouts: Payout[]): Promise<void> {
    for (const payout of payouts) {
      try {
        await this.processSinglePayout(payout);
        await this.delay(300);
      } catch (error) {
        this.logger.error(`Wallet payout failed: ${error.message}`);
      }
    }
  }

  /**
   * Get payout by ID
   */
  async getPayoutById(payoutId: string): Promise<Payout> {
    return this.payoutRepo.findOne({
      where: { id: payoutId },
      relations: ['subMerchant', 'settlement'],
    });
  }

  /**
   * Get payouts for a sub-merchant
   */
  async getPayoutsForMerchant(
    subMerchantId: string,
    status?: PayoutStatus,
    startDate?: Date,
    endDate?: Date,
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
   * Cancel a pending payout
   */
  async cancelPayout(payoutId: string, reason: string): Promise<Payout> {
    const payout = await this.payoutRepo.findOne({
      where: { id: payoutId },
    });

    if (!payout) {
      throw new Error('Payout not found');
    }

    if (payout.status !== PayoutStatus.PENDING) {
      throw new Error(`Cannot cancel payout in status: ${payout.status}`);
    }

    payout.status = PayoutStatus.CANCELLED;
    payout.notes = reason;

    return this.payoutRepo.save(payout);
  }

  /**
   * Get payout statistics
   */
  async getPayoutStats(subMerchantId?: string): Promise<{
    totalPaid: number;
    pendingAmount: number;
    failedCount: number;
    todayPaid: number;
  }> {
    const where: any = {};
    if (subMerchantId) {
      where.subMerchantId = subMerchantId;
    }

    const completed = await this.payoutRepo.sum('netAmount', {
      ...where,
      status: PayoutStatus.COMPLETED,
    });

    const pending = await this.payoutRepo.sum('netAmount', {
      ...where,
      status: PayoutStatus.PENDING,
    });

    const failedCount = await this.payoutRepo.count({
      where: { ...where, status: PayoutStatus.FAILED },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayCompleted = await this.payoutRepo
      .createQueryBuilder('payout')
      .select('SUM(payout.netAmount)', 'total')
      .where('payout.status = :status', { status: PayoutStatus.COMPLETED })
      .andWhere('payout.completedAt >= :today', { today })
      .getRawOne();

    return {
      totalPaid: completed || 0,
      pendingAmount: pending || 0,
      failedCount,
      todayPaid: todayCompleted?.total || 0,
    };
  }

  /**
   * Handle webhook from payment provider
   */
  async handlePayoutWebhook(
    provider: string,
    reference: string,
    status: string,
    data: any,
  ): Promise<void> {
    const payout = await this.payoutRepo.findOne({
      where: { processorReference: reference },
      relations: ['subMerchant'],
    });

    if (!payout) {
      this.logger.warn(`Payout not found for reference: ${reference}`);
      return;
    }

    // Update status based on webhook
    if (status === 'completed' || status === 'success') {
      payout.status = PayoutStatus.COMPLETED;
      payout.completedAt = new Date();
      await this.notifyPayoutSuccess(payout);
    } else if (status === 'failed' || status === 'rejected') {
      payout.status = PayoutStatus.FAILED;
      payout.failureMessage = data.reason || 'Payment failed';
      payout.retryCount += 1;
      
      if (payout.retryCount >= payout.maxRetries) {
        await this.notifyPayoutFailure(payout);
      }
    } else if (status === 'returned') {
      payout.status = PayoutStatus.RETURNED;
      payout.failureMessage = data.reason || 'Payment returned';
      await this.notifyPayoutFailure(payout);
    }

    payout.processorResponse = data;
    await this.payoutRepo.save(payout);
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private generatePayoutReference(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `PAY-${dateStr}-${random}`;
  }

  private generateBatchReference(): string {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `BATCH-${dateStr}-${random}`;
  }

  private calculatePayoutFee(method: PayoutMethod, amount: number): number {
    switch (method) {
      case PayoutMethod.INSTAPAY:
        return 5.00; // EGP 5 flat fee
      case PayoutMethod.BANK_TRANSFER:
        return amount > 50000 ? 25.00 : 10.00; // Tiered fee
      case PayoutMethod.WALLET:
        return 3.00; // EGP 3 flat fee
      default:
        return 10.00;
    }
  }

  private groupByMethod(payouts: Payout[]): Record<PayoutMethod, Payout[]> {
    return payouts.reduce((acc, payout) => {
      const method = payout.payoutMethod;
      if (!acc[method]) {
        acc[method] = [];
      }
      acc[method].push(payout);
      return acc;
    }, {} as Record<PayoutMethod, Payout[]>);
  }

  private async notifyPayoutSuccess(payout: Payout): Promise<void> {
    const subMerchant = payout.subMerchant || 
      await this.subMerchantRepo.findOne({ where: { id: payout.subMerchantId } });

    if (subMerchant) {
      await this.notificationService.sendPayoutNotification(subMerchant, payout, 'success');
    }
  }

  private async notifyPayoutFailure(payout: Payout): Promise<void> {
    const subMerchant = payout.subMerchant || 
      await this.subMerchantRepo.findOne({ where: { id: payout.subMerchantId } });

    if (subMerchant) {
      await this.notificationService.sendPayoutNotification(subMerchant, payout, 'failed');
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
