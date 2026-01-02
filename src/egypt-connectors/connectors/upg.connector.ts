import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

/**
 * UPG Egypt Payment Gateway Connector
 * 
 * The Unified Payment Gateway (UPG) is Egypt's national payment gateway
 * operated by EBC (Egyptian Banks Company) and powered by Paysky.
 * 
 * Supports:
 * - Meeza Card (Egypt's national debit card)
 * - Meeza Digital (QR code payments)
 * - InstaPay (Instant Payment Network)
 * - International cards (Visa, Mastercard) via acquiring banks
 * - Request to Pay (R2P)
 * - PayLink
 * 
 * Note: UPG integration typically requires partnership with an acquiring bank
 * (e.g., Banque Misr, NBE, CIB) that is connected to UPG.
 * 
 * Portal: https://upgportal.egyptianbanks.com/
 */

// ============================================================================
// Types
// ============================================================================

export interface UPGConfig {
  merchantId: string;
  terminalId: string;
  secretKey: string;
  acquiringBank: string;
  baseUrl: string;
  isProduction: boolean;
}

export interface UPGMerchantInfo {
  merchantId: string;
  terminalId: string;
  merchantName: string;
  merchantCategoryCode: string;
}

export interface UPGAmount {
  value: number;
  currency: string;
}

export interface UPGCustomer {
  name: string;
  email?: string;
  mobile: string;
  nationalId?: string;
}

export interface UPGCreatePaymentRequest {
  orderId: string;
  amount: UPGAmount;
  customer: UPGCustomer;
  description?: string;
  returnUrl: string;
  callbackUrl: string;
  paymentMethod: 'MEEZA' | 'MEEZA_QR' | 'INSTAPAY' | 'CARD' | 'R2P';
  expiryMinutes?: number;
  metadata?: Record<string, any>;
}

export interface UPGPaymentResponse {
  success: boolean;
  transactionId: string;
  orderId: string;
  status: UPGPaymentStatus;
  paymentUrl?: string;
  qrCodeData?: string;
  ipaAddress?: string;
  referenceNumber?: string;
  errorCode?: string;
  errorMessage?: string;
}

export type UPGPaymentStatus = 
  | 'CREATED'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'EXPIRED';

export interface UPGStatusResponse {
  transactionId: string;
  orderId: string;
  status: UPGPaymentStatus;
  amount: UPGAmount;
  paymentMethod: string;
  cardType?: string;
  maskedPan?: string;
  authCode?: string;
  rrn?: string;
  transactionTime?: string;
}

export interface UPGRefundRequest {
  transactionId: string;
  amount: UPGAmount;
  reason?: string;
}

export interface UPGInstapayRequest {
  orderId: string;
  amount: UPGAmount;
  senderIpa: string;
  receiverIpa: string;
  description?: string;
  callbackUrl: string;
}

export interface UPGMeezaQRRequest {
  orderId: string;
  amount: UPGAmount;
  customer: UPGCustomer;
  callbackUrl: string;
  expiryMinutes?: number;
}

export interface UPGWebhookPayload {
  transactionId: string;
  orderId: string;
  merchantId: string;
  status: UPGPaymentStatus;
  amount: UPGAmount;
  paymentMethod: string;
  timestamp: string;
  signature: string;
  additionalData?: Record<string, any>;
}

// ============================================================================
// Service Implementation
// ============================================================================

@Injectable()
export class UPGConnectorService {
  private readonly logger = new Logger(UPGConnectorService.name);
  private readonly config: UPGConfig;

  // API Endpoints (these may vary based on acquiring bank implementation)
  private readonly ENDPOINTS = {
    CREATE_PAYMENT: '/api/v1/payments/create',
    PAYMENT_STATUS: '/api/v1/payments/status',
    CAPTURE: '/api/v1/payments/capture',
    REFUND: '/api/v1/payments/refund',
    CANCEL: '/api/v1/payments/cancel',
    MEEZA_QR: '/api/v1/meeza/qr/create',
    INSTAPAY_TRANSFER: '/api/v1/instapay/transfer',
    INSTAPAY_R2P: '/api/v1/instapay/r2p',
  };

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const isProduction = this.configService.get<boolean>('UPG_PRODUCTION', false);
    
    this.config = {
      merchantId: this.configService.get<string>('UPG_MERCHANT_ID', ''),
      terminalId: this.configService.get<string>('UPG_TERMINAL_ID', ''),
      secretKey: this.configService.get<string>('UPG_SECRET_KEY', ''),
      acquiringBank: this.configService.get<string>('UPG_ACQUIRING_BANK', 'NBE'),
      baseUrl: this.configService.get<string>(
        'UPG_BASE_URL',
        isProduction 
          ? 'https://upg.egyptianbanks.com/api' 
          : 'https://upg-sandbox.egyptianbanks.com/api'
      ),
      isProduction,
    };

    this.logger.log(`UPG Connector initialized (${isProduction ? 'PRODUCTION' : 'SANDBOX'})`);
    this.logger.log(`Acquiring Bank: ${this.config.acquiringBank}`);
  }

  /**
   * Create a Meeza card payment
   * Supports Egypt's national debit card scheme
   */
  async createMeezaPayment(request: UPGCreatePaymentRequest): Promise<UPGPaymentResponse> {
    this.logger.log(`Creating Meeza payment: ${request.orderId}`);

    const payload = {
      merchantId: this.config.merchantId,
      terminalId: this.config.terminalId,
      orderId: request.orderId,
      amount: this.formatAmount(request.amount),
      currency: request.amount.currency || 'EGP',
      customer: {
        name: request.customer.name,
        mobile: this.formatEgyptPhone(request.customer.mobile),
        email: request.customer.email || '',
        nationalId: request.customer.nationalId || '',
      },
      paymentMethod: 'MEEZA',
      description: request.description || 'HealthPay Payment',
      returnUrl: request.returnUrl,
      callbackUrl: request.callbackUrl,
      timestamp: new Date().toISOString(),
    };

    payload['signature'] = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.CREATE_PAYMENT}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`Meeza payment creation failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Create Meeza QR code payment
   * Generates QR code for in-store or P2M payments
   */
  async createMeezaQRPayment(request: UPGMeezaQRRequest): Promise<UPGPaymentResponse> {
    this.logger.log(`Creating Meeza QR payment: ${request.orderId}`);

    const payload = {
      merchantId: this.config.merchantId,
      terminalId: this.config.terminalId,
      orderId: request.orderId,
      amount: this.formatAmount(request.amount),
      currency: request.amount.currency || 'EGP',
      customer: {
        name: request.customer.name,
        mobile: this.formatEgyptPhone(request.customer.mobile),
      },
      expiryMinutes: request.expiryMinutes || 15,
      callbackUrl: request.callbackUrl,
      timestamp: new Date().toISOString(),
    };

    payload['signature'] = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.MEEZA_QR}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      const data = response.data;
      
      return {
        success: data.success,
        transactionId: data.transactionId,
        orderId: request.orderId,
        status: 'CREATED',
        qrCodeData: data.qrCodeData, // Base64 encoded QR image or QR string
        referenceNumber: data.referenceNumber,
      };
    } catch (error) {
      this.logger.error(`Meeza QR payment creation failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Create InstaPay Request to Pay (R2P)
   * Sends payment request to customer's mobile banking app
   */
  async createInstapayR2P(request: UPGInstapayRequest): Promise<UPGPaymentResponse> {
    this.logger.log(`Creating InstaPay R2P: ${request.orderId}`);

    const payload = {
      merchantId: this.config.merchantId,
      terminalId: this.config.terminalId,
      orderId: request.orderId,
      amount: this.formatAmount(request.amount),
      currency: request.amount.currency || 'EGP',
      receiverIpa: request.receiverIpa, // Merchant's IPA address
      senderIpa: request.senderIpa, // Customer's IPA address
      description: request.description || 'HealthPay Payment',
      callbackUrl: request.callbackUrl,
      timestamp: new Date().toISOString(),
    };

    payload['signature'] = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.INSTAPAY_R2P}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      const data = response.data;
      
      return {
        success: data.success,
        transactionId: data.transactionId,
        orderId: request.orderId,
        status: 'PENDING',
        ipaAddress: data.ipaAddress,
        referenceNumber: data.referenceNumber,
      };
    } catch (error) {
      this.logger.error(`InstaPay R2P creation failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Create international card payment (Visa/Mastercard)
   * Routes through acquiring bank's card processor
   */
  async createCardPayment(request: UPGCreatePaymentRequest): Promise<UPGPaymentResponse> {
    this.logger.log(`Creating card payment: ${request.orderId}`);

    const payload = {
      merchantId: this.config.merchantId,
      terminalId: this.config.terminalId,
      orderId: request.orderId,
      amount: this.formatAmount(request.amount),
      currency: request.amount.currency || 'EGP',
      customer: {
        name: request.customer.name,
        mobile: this.formatEgyptPhone(request.customer.mobile),
        email: request.customer.email || '',
      },
      paymentMethod: 'CARD',
      description: request.description || 'HealthPay Payment',
      returnUrl: request.returnUrl,
      callbackUrl: request.callbackUrl,
      timestamp: new Date().toISOString(),
    };

    payload['signature'] = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.CREATE_PAYMENT}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`Card payment creation failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Query payment status
   */
  async getPaymentStatus(transactionId: string): Promise<UPGStatusResponse> {
    this.logger.log(`Checking UPG payment status: ${transactionId}`);

    const payload = {
      merchantId: this.config.merchantId,
      transactionId,
      timestamp: new Date().toISOString(),
    };

    payload['signature'] = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.PAYMENT_STATUS}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      return response.data;
    } catch (error) {
      this.logger.error(`UPG status check failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Capture an authorized payment
   */
  async capturePayment(transactionId: string, amount?: UPGAmount): Promise<UPGPaymentResponse> {
    this.logger.log(`Capturing UPG payment: ${transactionId}`);

    const payload: any = {
      merchantId: this.config.merchantId,
      transactionId,
      timestamp: new Date().toISOString(),
    };

    if (amount) {
      payload.amount = this.formatAmount(amount);
    }

    payload.signature = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.CAPTURE}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`UPG capture failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Refund a payment
   */
  async refundPayment(request: UPGRefundRequest): Promise<UPGPaymentResponse> {
    this.logger.log(`Refunding UPG payment: ${request.transactionId}`);

    const payload = {
      merchantId: this.config.merchantId,
      transactionId: request.transactionId,
      amount: this.formatAmount(request.amount),
      reason: request.reason || 'Customer request',
      timestamp: new Date().toISOString(),
    };

    payload['signature'] = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.REFUND}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`UPG refund failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Cancel a pending payment
   */
  async cancelPayment(transactionId: string): Promise<UPGPaymentResponse> {
    this.logger.log(`Cancelling UPG payment: ${transactionId}`);

    const payload = {
      merchantId: this.config.merchantId,
      transactionId,
      timestamp: new Date().toISOString(),
    };

    payload['signature'] = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.CANCEL}`,
          payload,
          {
            headers: this.getHeaders(),
          }
        )
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`UPG cancel failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: UPGWebhookPayload): boolean {
    const signatureData = [
      payload.transactionId,
      payload.orderId,
      payload.merchantId,
      payload.status,
      payload.amount.value.toString(),
      payload.timestamp,
      this.config.secretKey,
    ].join('|');

    const calculatedSignature = crypto
      .createHash('sha256')
      .update(signatureData)
      .digest('hex');

    return calculatedSignature === payload.signature;
  }

  /**
   * Handle UPG webhook notification
   */
  async handleWebhook(payload: UPGWebhookPayload): Promise<void> {
    this.logger.log(`Processing UPG webhook: ${payload.transactionId}`);

    // Verify signature
    if (!this.verifyWebhookSignature(payload)) {
      this.logger.warn('Invalid UPG webhook signature');
      throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
    }

    // Process based on status
    switch (payload.status) {
      case 'CAPTURED':
        this.logger.log(`UPG payment captured: ${payload.transactionId}`);
        // TODO: Update payment status in HealthPay
        // TODO: Update wallet balance
        // TODO: Send notification
        break;

      case 'AUTHORIZED':
        this.logger.log(`UPG payment authorized: ${payload.transactionId}`);
        // TODO: Mark as authorized, await capture
        break;

      case 'FAILED':
        this.logger.log(`UPG payment failed: ${payload.transactionId}`);
        // TODO: Mark as failed
        // TODO: Notify customer
        break;

      case 'REFUNDED':
        this.logger.log(`UPG payment refunded: ${payload.transactionId}`);
        // TODO: Process refund
        break;

      case 'EXPIRED':
        this.logger.log(`UPG payment expired: ${payload.transactionId}`);
        // TODO: Mark as expired
        break;

      default:
        this.logger.warn(`Unknown UPG status: ${payload.status}`);
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private calculateSignature(payload: any): string {
    // Create signature string from sorted payload keys
    const sortedKeys = Object.keys(payload).sort();
    const signatureData = sortedKeys
      .filter(key => key !== 'signature' && payload[key] !== undefined && payload[key] !== '')
      .map(key => {
        const value = typeof payload[key] === 'object' 
          ? JSON.stringify(payload[key]) 
          : payload[key];
        return `${key}=${value}`;
      })
      .join('&');

    const dataToSign = signatureData + '&secretKey=' + this.config.secretKey;

    return crypto
      .createHash('sha256')
      .update(dataToSign)
      .digest('hex')
      .toUpperCase();
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Merchant-Id': this.config.merchantId,
      'X-Terminal-Id': this.config.terminalId,
      'X-Acquiring-Bank': this.config.acquiringBank,
    };
  }

  private formatAmount(amount: UPGAmount): number {
    // UPG typically expects amount in minor units (piasters for EGP)
    // But some implementations expect major units - check your specific bank
    return Math.round(amount.value * 100);
  }

  private formatEgyptPhone(phone: string): string {
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('20')) {
      cleaned = '0' + cleaned.substring(2);
    } else if (cleaned.startsWith('+20')) {
      cleaned = '0' + cleaned.substring(3);
    } else if (!cleaned.startsWith('0')) {
      cleaned = '0' + cleaned;
    }
    
    return cleaned;
  }

  private mapPaymentResponse(data: any): UPGPaymentResponse {
    return {
      success: data.success || data.responseCode === '00',
      transactionId: data.transactionId,
      orderId: data.orderId,
      status: data.status || this.mapResponseCodeToStatus(data.responseCode),
      paymentUrl: data.paymentUrl || data.redirectUrl,
      qrCodeData: data.qrCodeData,
      ipaAddress: data.ipaAddress,
      referenceNumber: data.referenceNumber || data.rrn,
      errorCode: data.errorCode || data.responseCode,
      errorMessage: data.errorMessage || data.responseDescription,
    };
  }

  private mapResponseCodeToStatus(responseCode: string): UPGPaymentStatus {
    const statusMap: Record<string, UPGPaymentStatus> = {
      '00': 'CAPTURED',
      '01': 'PENDING',
      '05': 'FAILED',
      '12': 'FAILED',
      '14': 'FAILED',
      '51': 'FAILED',
      '54': 'FAILED',
      '61': 'FAILED',
    };

    return statusMap[responseCode] || 'PENDING';
  }

  private handleError(error: any): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    if (error.response) {
      return new HttpException(
        {
          message: error.response.data?.errorMessage || 'UPG service error',
          code: `UPG_${error.response.data?.errorCode || 'ERROR'}`,
        },
        error.response.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    return new HttpException(
      'UPG service unavailable',
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }
}

// ============================================================================
// Module Export
// ============================================================================

export { UPGConnectorService as default };
