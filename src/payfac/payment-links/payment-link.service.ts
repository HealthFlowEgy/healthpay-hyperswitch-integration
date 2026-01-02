import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PaymentLink, PaymentLinkStatus, PaymentLinkType } from '../entities/payment-link.entity';
import { SubMerchant } from '../entities/sub-merchant.entity';
import { Transaction } from '../entities/transaction.entity';
import { CheckoutSession } from '../entities/checkout-session.entity';
import { SmsService } from './sms.service';
import { WhatsAppService } from './whatsapp.service';
import { EmailService } from './email.service';
import { QrCodeService } from './qr-code.service';
import { nanoid } from 'nanoid';

/**
 * Payment Links Service
 * 
 * Creates and manages payment links for:
 * - One-time payments (prescriptions, invoices)
 * - Reusable links (donations, tips)
 * - Variable amount links
 * 
 * Features:
 * - Short URL generation
 * - QR code generation
 * - SMS/WhatsApp/Email delivery
 * - Expiration handling
 * - Custom fields
 */

export interface CreatePaymentLinkDto {
  // Amount
  amount?: number; // Optional for variable amount links
  currency?: string;
  allowCustomAmount?: boolean;
  minAmount?: number;
  maxAmount?: number;
  
  // Details
  title: string;
  titleAr?: string;
  description?: string;
  descriptionAr?: string;
  
  // Link Type
  type?: PaymentLinkType;
  maxUses?: number;
  
  // Customer pre-fill
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  
  // Configuration
  collectCustomerInfo?: boolean;
  collectAddress?: boolean;
  enabledPaymentMethods?: string[];
  
  // Expiration
  expiresAt?: Date;
  expiresInHours?: number;
  
  // URLs
  successUrl?: string;
  cancelUrl?: string;
  
  // Notifications
  notifyOnPayment?: boolean;
  notificationEmail?: string;
  notificationPhone?: string;
  
  // Custom fields for customer to fill
  customFields?: CustomField[];
  
  // Merchant reference
  referenceId?: string;
  metadata?: Record<string, any>;
  
  // Delivery
  sendSms?: boolean;
  sendWhatsApp?: boolean;
  sendEmail?: boolean;
}

export interface CustomField {
  name: string;
  label: string;
  labelAr?: string;
  type: 'text' | 'number' | 'email' | 'phone' | 'date' | 'select';
  required: boolean;
  options?: string[]; // For select type
  placeholder?: string;
}

export interface PaymentLinkResponse {
  id: string;
  linkCode: string;
  url: string;
  shortUrl: string;
  qrCodeUrl: string;
  amount?: number;
  currency: string;
  title: string;
  status: PaymentLinkStatus;
  expiresAt?: Date;
  smsSent?: boolean;
  whatsappSent?: boolean;
  emailSent?: boolean;
}

@Injectable()
export class PaymentLinkService {
  private readonly logger = new Logger(PaymentLinkService.name);
  private readonly baseUrl: string;
  private readonly shortDomain: string;

  constructor(
    @InjectRepository(PaymentLink)
    private readonly paymentLinkRepo: Repository<PaymentLink>,
    @InjectRepository(SubMerchant)
    private readonly subMerchantRepo: Repository<SubMerchant>,
    @InjectRepository(CheckoutSession)
    private readonly checkoutSessionRepo: Repository<CheckoutSession>,
    private readonly configService: ConfigService,
    private readonly smsService: SmsService,
    private readonly whatsAppService: WhatsAppService,
    private readonly emailService: EmailService,
    private readonly qrCodeService: QrCodeService,
  ) {
    this.baseUrl = this.configService.get<string>('CHECKOUT_BASE_URL', 'https://pay.healthpay.eg');
    this.shortDomain = this.configService.get<string>('SHORT_URL_DOMAIN', 'https://hpay.eg');
  }

  /**
   * Create a new payment link
   */
  async createPaymentLink(
    subMerchantId: string,
    dto: CreatePaymentLinkDto,
  ): Promise<PaymentLinkResponse> {
    // Validate sub-merchant
    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: subMerchantId, status: 'active' },
    });

    if (!subMerchant) {
      throw new HttpException('Sub-merchant not found or inactive', HttpStatus.NOT_FOUND);
    }

    // Validate amount if fixed
    if (dto.amount && dto.amount < 1) {
      throw new HttpException('Amount must be at least 1 EGP', HttpStatus.BAD_REQUEST);
    }

    // Generate unique link code
    const linkCode = this.generateLinkCode();
    const fullUrl = `${this.baseUrl}/l/${linkCode}`;
    const shortUrl = `${this.shortDomain}/${linkCode}`;

    // Calculate expiration
    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      expiresAt = dto.expiresAt;
    } else if (dto.expiresInHours) {
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + dto.expiresInHours);
    }

    // Generate QR code
    const qrCodeUrl = await this.qrCodeService.generateQrCode(shortUrl);

    // Create payment link
    const paymentLink = this.paymentLinkRepo.create({
      subMerchantId,
      linkCode,
      linkUrl: fullUrl,
      shortUrl,
      linkType: dto.type || PaymentLinkType.ONE_TIME,
      amount: dto.amount,
      currency: dto.currency || 'EGP',
      allowCustomAmount: dto.allowCustomAmount || !dto.amount,
      minAmount: dto.minAmount,
      maxAmount: dto.maxAmount,
      title: dto.title,
      titleAr: dto.titleAr,
      description: dto.description,
      descriptionAr: dto.descriptionAr,
      customerName: dto.customerName,
      customerEmail: dto.customerEmail,
      customerPhone: dto.customerPhone,
      collectCustomerInfo: dto.collectCustomerInfo ?? true,
      collectAddress: dto.collectAddress ?? false,
      enabledPaymentMethods: dto.enabledPaymentMethods || subMerchant.enabledPaymentMethods,
      maxUses: dto.maxUses,
      expiresAt,
      successUrl: dto.successUrl,
      cancelUrl: dto.cancelUrl,
      notifyOnPayment: dto.notifyOnPayment ?? true,
      notificationEmail: dto.notificationEmail || subMerchant.email,
      notificationPhone: dto.notificationPhone || subMerchant.phone,
      customFields: dto.customFields,
      referenceId: dto.referenceId,
      metadata: dto.metadata || {},
      qrCodeUrl,
      status: PaymentLinkStatus.ACTIVE,
    });

    await this.paymentLinkRepo.save(paymentLink);

    // Send notifications if requested
    const deliveryResults = await this.sendLinkNotifications(
      paymentLink,
      dto.customerPhone,
      dto.customerEmail,
      dto.sendSms,
      dto.sendWhatsApp,
      dto.sendEmail,
    );

    // Update delivery status
    if (deliveryResults.smsSent) {
      paymentLink.smsSent = true;
      paymentLink.smsSentAt = new Date();
    }
    if (deliveryResults.whatsappSent) {
      paymentLink.whatsappSent = true;
      paymentLink.whatsappSentAt = new Date();
    }
    if (deliveryResults.emailSent) {
      paymentLink.emailSent = true;
      paymentLink.emailSentAt = new Date();
    }

    await this.paymentLinkRepo.save(paymentLink);

    return this.toResponse(paymentLink, deliveryResults);
  }

  /**
   * Get payment link by code
   */
  async getPaymentLinkByCode(linkCode: string): Promise<PaymentLink> {
    const paymentLink = await this.paymentLinkRepo.findOne({
      where: { linkCode },
      relations: ['subMerchant'],
    });

    if (!paymentLink) {
      throw new HttpException('Payment link not found', HttpStatus.NOT_FOUND);
    }

    // Check if expired
    if (paymentLink.expiresAt && new Date() > paymentLink.expiresAt) {
      paymentLink.status = PaymentLinkStatus.EXPIRED;
      await this.paymentLinkRepo.save(paymentLink);
      throw new HttpException('Payment link has expired', HttpStatus.GONE);
    }

    // Check if exhausted
    if (paymentLink.maxUses && paymentLink.currentUses >= paymentLink.maxUses) {
      paymentLink.status = PaymentLinkStatus.EXHAUSTED;
      await this.paymentLinkRepo.save(paymentLink);
      throw new HttpException('Payment link has reached maximum uses', HttpStatus.GONE);
    }

    // Check if active
    if (paymentLink.status !== PaymentLinkStatus.ACTIVE) {
      throw new HttpException(`Payment link is ${paymentLink.status}`, HttpStatus.GONE);
    }

    return paymentLink;
  }

  /**
   * Create checkout session from payment link
   */
  async createSessionFromLink(
    linkCode: string,
    amount?: number,
    customerData?: any,
  ): Promise<CheckoutSession> {
    const paymentLink = await this.getPaymentLinkByCode(linkCode);

    // Validate amount
    let paymentAmount = paymentLink.amount;
    
    if (paymentLink.allowCustomAmount && amount) {
      if (paymentLink.minAmount && amount < paymentLink.minAmount) {
        throw new HttpException(
          `Amount must be at least ${paymentLink.minAmount} EGP`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (paymentLink.maxAmount && amount > paymentLink.maxAmount) {
        throw new HttpException(
          `Amount cannot exceed ${paymentLink.maxAmount} EGP`,
          HttpStatus.BAD_REQUEST,
        );
      }
      paymentAmount = amount;
    }

    if (!paymentAmount) {
      throw new HttpException('Amount is required', HttpStatus.BAD_REQUEST);
    }

    // Create checkout session
    const sessionToken = this.generateSessionToken();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 30); // 30 minute session

    const session = this.checkoutSessionRepo.create({
      subMerchantId: paymentLink.subMerchantId,
      sessionToken,
      amount: paymentAmount,
      currency: paymentLink.currency,
      description: paymentLink.title,
      customerEmail: customerData?.email || paymentLink.customerEmail,
      customerPhone: customerData?.phone || paymentLink.customerPhone,
      customerName: customerData?.name || paymentLink.customerName,
      enabledPaymentMethods: paymentLink.enabledPaymentMethods,
      locale: customerData?.locale || 'ar',
      successUrl: paymentLink.successUrl || `${this.baseUrl}/success`,
      cancelUrl: paymentLink.cancelUrl || `${this.baseUrl}/cancel`,
      metadata: {
        ...paymentLink.metadata,
        paymentLinkId: paymentLink.id,
        paymentLinkCode: paymentLink.linkCode,
        customFieldValues: customerData?.customFields,
      },
      merchantReference: paymentLink.referenceId,
      status: 'open',
      expiresAt,
    });

    await this.checkoutSessionRepo.save(session);

    // Update link usage
    paymentLink.lastUsedAt = new Date();
    await this.paymentLinkRepo.save(paymentLink);

    return session;
  }

  /**
   * Record successful payment from link
   */
  async recordPayment(
    linkCode: string,
    transactionId: string,
    amount: number,
  ): Promise<void> {
    const paymentLink = await this.paymentLinkRepo.findOne({
      where: { linkCode },
    });

    if (!paymentLink) return;

    // Update stats
    paymentLink.currentUses += 1;
    paymentLink.successfulPayments += 1;
    paymentLink.totalCollected += amount;
    paymentLink.lastUsedAt = new Date();

    // Check if exhausted
    if (paymentLink.maxUses && paymentLink.currentUses >= paymentLink.maxUses) {
      paymentLink.status = PaymentLinkStatus.EXHAUSTED;
    }

    // For one-time links, deactivate after use
    if (paymentLink.linkType === PaymentLinkType.ONE_TIME) {
      paymentLink.status = PaymentLinkStatus.INACTIVE;
    }

    await this.paymentLinkRepo.save(paymentLink);

    // Send payment notification if configured
    if (paymentLink.notifyOnPayment) {
      await this.sendPaymentNotification(paymentLink, amount, transactionId);
    }
  }

  /**
   * Get payment links for a sub-merchant
   */
  async getPaymentLinks(
    subMerchantId: string,
    status?: PaymentLinkStatus,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ links: PaymentLink[]; total: number }> {
    const where: any = { subMerchantId };
    if (status) {
      where.status = status;
    }

    const [links, total] = await this.paymentLinkRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { links, total };
  }

  /**
   * Deactivate a payment link
   */
  async deactivateLink(subMerchantId: string, linkId: string): Promise<PaymentLink> {
    const paymentLink = await this.paymentLinkRepo.findOne({
      where: { id: linkId, subMerchantId },
    });

    if (!paymentLink) {
      throw new HttpException('Payment link not found', HttpStatus.NOT_FOUND);
    }

    paymentLink.status = PaymentLinkStatus.INACTIVE;
    return this.paymentLinkRepo.save(paymentLink);
  }

  /**
   * Resend payment link
   */
  async resendLink(
    subMerchantId: string,
    linkId: string,
    options: { sms?: boolean; whatsapp?: boolean; email?: boolean; phone?: string; emailAddress?: string },
  ): Promise<void> {
    const paymentLink = await this.paymentLinkRepo.findOne({
      where: { id: linkId, subMerchantId },
    });

    if (!paymentLink) {
      throw new HttpException('Payment link not found', HttpStatus.NOT_FOUND);
    }

    const phone = options.phone || paymentLink.customerPhone;
    const email = options.emailAddress || paymentLink.customerEmail;

    await this.sendLinkNotifications(
      paymentLink,
      phone,
      email,
      options.sms,
      options.whatsapp,
      options.email,
    );
  }

  /**
   * Bulk create payment links (for invoicing)
   */
  async bulkCreateLinks(
    subMerchantId: string,
    links: CreatePaymentLinkDto[],
  ): Promise<PaymentLinkResponse[]> {
    const results: PaymentLinkResponse[] = [];

    for (const linkDto of links) {
      try {
        const link = await this.createPaymentLink(subMerchantId, linkDto);
        results.push(link);
      } catch (error) {
        this.logger.error(`Failed to create link: ${error.message}`);
        // Continue with other links
      }
    }

    return results;
  }

  /**
   * Expire old links (cron job)
   */
  async expireOldLinks(): Promise<number> {
    const result = await this.paymentLinkRepo.update(
      {
        status: PaymentLinkStatus.ACTIVE,
        expiresAt: LessThan(new Date()),
      },
      { status: PaymentLinkStatus.EXPIRED },
    );

    return result.affected || 0;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private generateLinkCode(): string {
    // Generate 8-character alphanumeric code
    return nanoid(8).toLowerCase();
  }

  private generateSessionToken(): string {
    return `sess_${nanoid(24)}`;
  }

  private async sendLinkNotifications(
    paymentLink: PaymentLink,
    phone?: string,
    email?: string,
    sendSms?: boolean,
    sendWhatsApp?: boolean,
    sendEmail?: boolean,
  ): Promise<{ smsSent: boolean; whatsappSent: boolean; emailSent: boolean }> {
    const results = {
      smsSent: false,
      whatsappSent: false,
      emailSent: false,
    };

    const subMerchant = await this.subMerchantRepo.findOne({
      where: { id: paymentLink.subMerchantId },
    });

    const amountText = paymentLink.amount
      ? `${paymentLink.amount} جنيه`
      : 'المبلغ المطلوب';

    // SMS
    if (sendSms && phone) {
      try {
        await this.smsService.send({
          to: phone,
          message: `${subMerchant.businessNameAr || subMerchant.businessName}: ادفع ${amountText} - ${paymentLink.title}\n${paymentLink.shortUrl}`,
        });
        results.smsSent = true;
      } catch (error) {
        this.logger.error(`SMS send failed: ${error.message}`);
      }
    }

    // WhatsApp
    if (sendWhatsApp && phone) {
      try {
        await this.whatsAppService.sendPaymentLink({
          to: phone,
          merchantName: subMerchant.businessNameAr || subMerchant.businessName,
          amount: paymentLink.amount,
          title: paymentLink.title,
          linkUrl: paymentLink.shortUrl,
        });
        results.whatsappSent = true;
      } catch (error) {
        this.logger.error(`WhatsApp send failed: ${error.message}`);
      }
    }

    // Email
    if (sendEmail && email) {
      try {
        await this.emailService.sendPaymentLinkEmail({
          to: email,
          merchantName: subMerchant.businessName,
          amount: paymentLink.amount,
          currency: paymentLink.currency,
          title: paymentLink.title,
          description: paymentLink.description,
          linkUrl: paymentLink.linkUrl,
          qrCodeUrl: paymentLink.qrCodeUrl,
          expiresAt: paymentLink.expiresAt,
        });
        results.emailSent = true;
      } catch (error) {
        this.logger.error(`Email send failed: ${error.message}`);
      }
    }

    return results;
  }

  private async sendPaymentNotification(
    paymentLink: PaymentLink,
    amount: number,
    transactionId: string,
  ): Promise<void> {
    // Notify merchant of payment received
    if (paymentLink.notificationEmail) {
      try {
        await this.emailService.sendPaymentReceivedEmail({
          to: paymentLink.notificationEmail,
          amount,
          transactionId,
          linkTitle: paymentLink.title,
          referenceId: paymentLink.referenceId,
        });
      } catch (error) {
        this.logger.error(`Payment notification email failed: ${error.message}`);
      }
    }

    if (paymentLink.notificationPhone) {
      try {
        await this.smsService.send({
          to: paymentLink.notificationPhone,
          message: `تم استلام ${amount} جنيه - ${paymentLink.title} - رقم العملية: ${transactionId}`,
        });
      } catch (error) {
        this.logger.error(`Payment notification SMS failed: ${error.message}`);
      }
    }
  }

  private toResponse(
    paymentLink: PaymentLink,
    deliveryResults?: { smsSent: boolean; whatsappSent: boolean; emailSent: boolean },
  ): PaymentLinkResponse {
    return {
      id: paymentLink.id,
      linkCode: paymentLink.linkCode,
      url: paymentLink.linkUrl,
      shortUrl: paymentLink.shortUrl,
      qrCodeUrl: paymentLink.qrCodeUrl,
      amount: paymentLink.amount,
      currency: paymentLink.currency,
      title: paymentLink.title,
      status: paymentLink.status,
      expiresAt: paymentLink.expiresAt,
      smsSent: deliveryResults?.smsSent,
      whatsappSent: deliveryResults?.whatsappSent,
      emailSent: deliveryResults?.emailSent,
    };
  }
}
