import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

/**
 * Fawry Reference Code Payment Connector
 * 
 * Enables customers to pay at 194,000+ Fawry outlets across Egypt
 * using a generated reference code.
 * 
 * Flow:
 * 1. Create payment → Get reference number
 * 2. Customer pays at Fawry outlet/app with reference
 * 3. Webhook notification confirms payment
 * 
 * API Documentation: https://developer.fawrystaging.com/
 */

// ============================================================================
// Types
// ============================================================================

export interface FawryConfig {
  merchantCode: string;
  securityKey: string;
  baseUrl: string;
  isProduction: boolean;
}

export interface FawryChargeItem {
  itemId: string;
  description: string;
  price: number;
  quantity: number;
}

export interface FawryCreatePaymentRequest {
  merchantRefNum: string;
  customerProfileId: string;
  customerMobile: string;
  customerEmail?: string;
  customerName?: string;
  amount: number;
  currencyCode?: string;
  description?: string;
  chargeItems: FawryChargeItem[];
  expiryHours?: number;
  metadata?: Record<string, any>;
}

export interface FawryPaymentResponse {
  type: string;
  referenceNumber: string;
  merchantRefNumber: string;
  expirationTime: number;
  statusCode: number;
  statusDescription: string;
  fawryFees?: number;
}

export interface FawryPaymentStatus {
  referenceNumber: string;
  merchantRefNumber: string;
  paymentAmount: number;
  paymentMethod: string;
  paymentStatus: 'PAID' | 'UNPAID' | 'EXPIRED' | 'REFUNDED' | 'CANCELLED';
  paymentTime?: number;
  customerMobile?: string;
  customerMail?: string;
  statusCode: number;
  statusDescription: string;
}

export interface FawryRefundRequest {
  referenceNumber: string;
  refundAmount: number;
  reason?: string;
}

export interface FawryWebhookPayload {
  requestId: string;
  fawryRefNumber: string;
  merchantRefNumber: string;
  customerMobile: string;
  customerMail: string;
  paymentAmount: number;
  orderAmount: number;
  fawryFees: number;
  orderStatus: string;
  paymentMethod: string;
  paymentTime: number;
  messageSignature: string;
}

// ============================================================================
// Service Implementation
// ============================================================================

@Injectable()
export class FawryConnectorService {
  private readonly logger = new Logger(FawryConnectorService.name);
  private readonly config: FawryConfig;

  // API Endpoints
  private readonly ENDPOINTS = {
    CHARGE: '/ECommerceWeb/Fawry/payments/charge',
    STATUS: '/ECommerceWeb/Fawry/payments/status/v2',
    REFUND: '/ECommerceWeb/Fawry/payments/refund',
  };

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const isProduction = this.configService.get<boolean>('FAWRY_PRODUCTION', false);
    
    this.config = {
      merchantCode: this.configService.get<string>('FAWRY_MERCHANT_CODE', ''),
      securityKey: this.configService.get<string>('FAWRY_SECURITY_KEY', ''),
      baseUrl: isProduction 
        ? 'https://www.atfawry.com' 
        : 'https://atfawry.fawrystaging.com',
      isProduction,
    };

    this.logger.log(`Fawry Connector initialized (${isProduction ? 'PRODUCTION' : 'SANDBOX'})`);
  }

  /**
   * Create a Fawry reference code payment
   * Customer will use this reference to pay at Fawry outlets
   */
  async createPayment(request: FawryCreatePaymentRequest): Promise<FawryPaymentResponse> {
    this.logger.log(`Creating Fawry payment: ${request.merchantRefNum}`);

    const payload = {
      merchantCode: this.config.merchantCode,
      merchantRefNum: request.merchantRefNum,
      customerProfileId: request.customerProfileId,
      customerMobile: this.formatEgyptPhone(request.customerMobile),
      customerEmail: request.customerEmail || '',
      customerName: request.customerName || '',
      paymentMethod: 'PAYATFAWRY', // Reference code payment
      currencyCode: request.currencyCode || 'EGP',
      amount: request.amount,
      paymentExpiry: this.calculateExpiry(request.expiryHours || 24),
      chargeItems: request.chargeItems.map(item => ({
        itemId: item.itemId,
        description: item.description,
        price: item.price,
        quantity: item.quantity,
      })),
      description: request.description || 'HealthPay Payment',
      signature: '', // Will be calculated below
    };

    // Calculate signature
    payload.signature = this.calculateChargeSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.CHARGE}`,
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
          }
        )
      );

      const data = response.data;

      if (data.statusCode !== 200) {
        throw new HttpException(
          {
            message: data.statusDescription || 'Fawry payment creation failed',
            code: `FAWRY_${data.statusCode}`,
          },
          HttpStatus.BAD_REQUEST
        );
      }

      return {
        type: 'ChargeResponse',
        referenceNumber: data.referenceNumber,
        merchantRefNumber: data.merchantRefNumber,
        expirationTime: data.expirationTime,
        statusCode: data.statusCode,
        statusDescription: data.statusDescription,
        fawryFees: data.fawryFees,
      };
    } catch (error) {
      this.logger.error(`Fawry payment creation failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Check payment status by reference number
   */
  async getPaymentStatus(merchantRefNum: string): Promise<FawryPaymentStatus> {
    this.logger.log(`Checking Fawry payment status: ${merchantRefNum}`);

    const signature = this.calculateStatusSignature(merchantRefNum);
    const url = `${this.config.baseUrl}${this.ENDPOINTS.STATUS}`;
    const params = {
      merchantCode: this.config.merchantCode,
      merchantRefNumber: merchantRefNum,
      signature,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.get(url, { params })
      );

      const data = response.data;

      return {
        referenceNumber: data.referenceNumber,
        merchantRefNumber: data.merchantRefNumber,
        paymentAmount: data.paymentAmount,
        paymentMethod: data.paymentMethod,
        paymentStatus: data.paymentStatus,
        paymentTime: data.paymentTime,
        customerMobile: data.customerMobile,
        customerMail: data.customerMail,
        statusCode: data.statusCode,
        statusDescription: data.statusDescription,
      };
    } catch (error) {
      this.logger.error(`Fawry status check failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Refund a paid Fawry transaction
   */
  async refundPayment(request: FawryRefundRequest): Promise<any> {
    this.logger.log(`Refunding Fawry payment: ${request.referenceNumber}`);

    const payload = {
      merchantCode: this.config.merchantCode,
      referenceNumber: request.referenceNumber,
      refundAmount: request.refundAmount,
      reason: request.reason || 'Customer request',
      signature: this.calculateRefundSignature(request.referenceNumber, request.refundAmount),
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.REFUND}`,
          payload,
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        )
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Fawry refund failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Verify webhook signature from Fawry
   */
  verifyWebhookSignature(payload: FawryWebhookPayload): boolean {
    const signatureString = [
      payload.fawryRefNumber,
      payload.merchantRefNumber,
      payload.paymentAmount.toFixed(2),
      payload.orderAmount.toFixed(2),
      payload.orderStatus,
      payload.paymentMethod,
      payload.paymentTime?.toString() || '',
      this.config.securityKey,
    ].join('');

    const calculatedSignature = crypto
      .createHash('sha256')
      .update(signatureString)
      .digest('hex');

    return calculatedSignature === payload.messageSignature;
  }

  /**
   * Handle Fawry webhook notification
   */
  async handleWebhook(payload: FawryWebhookPayload): Promise<void> {
    this.logger.log(`Processing Fawry webhook: ${payload.merchantRefNumber}`);

    // Verify signature
    if (!this.verifyWebhookSignature(payload)) {
      this.logger.warn('Invalid Fawry webhook signature');
      throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
    }

    // Process based on status
    switch (payload.orderStatus) {
      case 'PAID':
        this.logger.log(`Fawry payment completed: ${payload.fawryRefNumber}`);
        // TODO: Update payment status in HealthPay
        // TODO: Update wallet balance
        // TODO: Send notification to customer
        break;

      case 'EXPIRED':
        this.logger.log(`Fawry payment expired: ${payload.fawryRefNumber}`);
        // TODO: Mark payment as expired
        break;

      case 'CANCELLED':
        this.logger.log(`Fawry payment cancelled: ${payload.fawryRefNumber}`);
        // TODO: Mark payment as cancelled
        break;

      default:
        this.logger.warn(`Unknown Fawry status: ${payload.orderStatus}`);
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private calculateChargeSignature(payload: any): string {
    // Signature = SHA256(merchantCode + merchantRefNum + customerProfileId + 
    //             paymentMethod + amount + chargeItems[].itemId + chargeItems[].quantity + 
    //             chargeItems[].price + securityKey)
    
    let signatureString = payload.merchantCode + payload.merchantRefNum;
    
    if (payload.customerProfileId) {
      signatureString += payload.customerProfileId;
    }
    
    signatureString += payload.paymentMethod;
    signatureString += payload.amount.toFixed(2);
    
    for (const item of payload.chargeItems) {
      signatureString += item.itemId;
      signatureString += item.quantity.toString();
      signatureString += item.price.toFixed(2);
    }
    
    signatureString += this.config.securityKey;

    return crypto.createHash('sha256').update(signatureString).digest('hex');
  }

  private calculateStatusSignature(merchantRefNum: string): string {
    const signatureString = this.config.merchantCode + merchantRefNum + this.config.securityKey;
    return crypto.createHash('sha256').update(signatureString).digest('hex');
  }

  private calculateRefundSignature(referenceNumber: string, refundAmount: number): string {
    const signatureString = this.config.merchantCode + referenceNumber + 
                           refundAmount.toFixed(2) + this.config.securityKey;
    return crypto.createHash('sha256').update(signatureString).digest('hex');
  }

  private calculateExpiry(hours: number): number {
    return Date.now() + (hours * 60 * 60 * 1000);
  }

  private formatEgyptPhone(phone: string): string {
    // Ensure phone is in format: 01xxxxxxxxx (11 digits)
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('20')) {
      cleaned = cleaned.substring(2);
    } else if (cleaned.startsWith('+20')) {
      cleaned = cleaned.substring(3);
    }
    
    if (!cleaned.startsWith('0')) {
      cleaned = '0' + cleaned;
    }
    
    return cleaned;
  }

  private handleError(error: any): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    if (error.response) {
      return new HttpException(
        {
          message: error.response.data?.statusDescription || 'Fawry service error',
          code: `FAWRY_${error.response.data?.statusCode || 'ERROR'}`,
        },
        error.response.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    return new HttpException(
      'Fawry service unavailable',
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }
}

// ============================================================================
// Module Export
// ============================================================================

export { FawryConnectorService as default };
