import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';

/**
 * OPay Egypt Wallet Payment Connector
 * 
 * Enables payments via OPay wallet using:
 * - QR Code payment
 * - Request to Pay (R2P) - push notification to customer's OPay app
 * - OPay Cashier (hosted checkout)
 * 
 * API Documentation: https://doc.opaycheckout.com/
 */

// ============================================================================
// Types
// ============================================================================

export interface OPayConfig {
  merchantId: string;
  publicKey: string;
  privateKey: string;
  baseUrl: string;
  isProduction: boolean;
}

export interface OPayAmount {
  currency: string;
  total: number;
}

export interface OPayProduct {
  name: string;
  description?: string;
}

export interface OPayUserInfo {
  userName: string;
  userEmail?: string;
  userMobile: string;
  userId?: string;
}

export interface OPayCreatePaymentRequest {
  reference: string;
  amount: OPayAmount;
  product: OPayProduct;
  userInfo: OPayUserInfo;
  callbackUrl: string;
  returnUrl?: string;
  cancelUrl?: string;
  expireAt?: number;
  payMethod?: 'EwalletQR' | 'Cashier' | 'BankCard';
  metadata?: Record<string, any>;
}

export interface OPayPaymentResponse {
  code: string;
  message: string;
  data: {
    reference: string;
    orderNo: string;
    status: string;
    amount: OPayAmount;
    qrCodeUrl?: string;
    cashierUrl?: string;
    expireAt?: string;
  };
}

export interface OPayStatusResponse {
  code: string;
  message: string;
  data: {
    reference: string;
    orderNo: string;
    status: 'INITIAL' | 'PENDING' | 'SUCCESS' | 'FAIL' | 'CLOSE';
    amount: OPayAmount;
    payMethod?: string;
    transactionTime?: string;
    failureReason?: string;
  };
}

export interface OPayRefundRequest {
  reference: string;
  originalOrderNo: string;
  amount: OPayAmount;
  reason?: string;
}

export interface OPayRefundResponse {
  code: string;
  message: string;
  data: {
    refundOrderNo: string;
    orderNo: string;
    reference: string;
    status: 'INITIAL' | 'PENDING' | 'SUCCESS' | 'FAIL';
    refundAmount: OPayAmount;
  };
}

export interface OPayWebhookPayload {
  country: string;
  reference: string;
  orderNo: string;
  status: string;
  amount: OPayAmount;
  fee: OPayAmount;
  payMethod: string;
  payChannel: string;
  transactionTime: string;
}

// ============================================================================
// Service Implementation
// ============================================================================

@Injectable()
export class OPayConnectorService {
  private readonly logger = new Logger(OPayConnectorService.name);
  private readonly config: OPayConfig;

  // API Endpoints for Egypt
  private readonly ENDPOINTS = {
    CASHIER_CREATE: '/api/v1/international/cashier/create',
    EWALLET_CREATE: '/api/v1/international/payment/create',
    QUERY_STATUS: '/api/v1/international/payment/status',
    REFUND: '/api/v1/international/refund/create',
    QUERY_REFUND: '/api/v1/international/refund/status',
    CANCEL: '/api/v1/international/payment/cancel',
  };

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const isProduction = this.configService.get<boolean>('OPAY_PRODUCTION', false);
    
    this.config = {
      merchantId: this.configService.get<string>('OPAY_MERCHANT_ID', ''),
      publicKey: this.configService.get<string>('OPAY_PUBLIC_KEY', ''),
      privateKey: this.configService.get<string>('OPAY_PRIVATE_KEY', ''),
      baseUrl: isProduction 
        ? 'https://api.opaycheckout.com' 
        : 'https://sandboxapi.opaycheckout.com',
      isProduction,
    };

    this.logger.log(`OPay Connector initialized (${isProduction ? 'PRODUCTION' : 'SANDBOX'})`);
  }

  /**
   * Create OPay E-Wallet payment (QR + R2P)
   * Returns QR code URL and sends push notification to customer's OPay wallet
   */
  async createWalletPayment(request: OPayCreatePaymentRequest): Promise<OPayPaymentResponse> {
    this.logger.log(`Creating OPay wallet payment: ${request.reference}`);

    const payload = {
      country: 'EG',
      reference: request.reference,
      amount: {
        currency: request.amount.currency || 'EGP',
        total: request.amount.total,
      },
      product: {
        name: request.product.name,
        description: request.product.description || '',
      },
      userInfo: {
        userName: request.userInfo.userName,
        userEmail: request.userInfo.userEmail || '',
        userMobile: this.formatEgyptPhone(request.userInfo.userMobile),
        userId: request.userInfo.userId || '',
      },
      callbackUrl: request.callbackUrl,
      returnUrl: request.returnUrl || '',
      cancelUrl: request.cancelUrl || '',
      payMethod: 'EwalletQR',
      expireAt: request.expireAt || 30, // Default 30 minutes
    };

    const signature = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.EWALLET_CREATE}`,
          payload,
          {
            headers: this.getHeaders(signature),
          }
        )
      );

      const data = response.data;

      if (data.code !== '00000') {
        throw new HttpException(
          {
            message: data.message || 'OPay payment creation failed',
            code: `OPAY_${data.code}`,
          },
          HttpStatus.BAD_REQUEST
        );
      }

      return data;
    } catch (error) {
      this.logger.error(`OPay wallet payment creation failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Create OPay Cashier payment (hosted checkout page)
   * Redirects customer to OPay's checkout page
   */
  async createCashierPayment(request: OPayCreatePaymentRequest): Promise<OPayPaymentResponse> {
    this.logger.log(`Creating OPay cashier payment: ${request.reference}`);

    const payload = {
      country: 'EG',
      reference: request.reference,
      amount: {
        currency: request.amount.currency || 'EGP',
        total: request.amount.total,
      },
      product: {
        name: request.product.name,
        description: request.product.description || '',
      },
      userInfo: {
        userName: request.userInfo.userName,
        userEmail: request.userInfo.userEmail || '',
        userMobile: this.formatEgyptPhone(request.userInfo.userMobile),
        userId: request.userInfo.userId || '',
      },
      callbackUrl: request.callbackUrl,
      returnUrl: request.returnUrl || '',
      cancelUrl: request.cancelUrl || '',
      expireAt: request.expireAt || 30,
      // Cashier supports multiple payment methods
      payTypes: ['EwalletQR', 'BankCard'],
    };

    const signature = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.CASHIER_CREATE}`,
          payload,
          {
            headers: this.getHeaders(signature, true), // Use public key for cashier
          }
        )
      );

      const data = response.data;

      if (data.code !== '00000') {
        throw new HttpException(
          {
            message: data.message || 'OPay cashier creation failed',
            code: `OPAY_${data.code}`,
          },
          HttpStatus.BAD_REQUEST
        );
      }

      return data;
    } catch (error) {
      this.logger.error(`OPay cashier payment creation failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Query payment status
   */
  async getPaymentStatus(orderNo: string, reference: string): Promise<OPayStatusResponse> {
    this.logger.log(`Checking OPay payment status: ${reference}`);

    const payload = {
      country: 'EG',
      orderNo,
      reference,
    };

    const signature = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.QUERY_STATUS}`,
          payload,
          {
            headers: this.getHeaders(signature),
          }
        )
      );

      return response.data;
    } catch (error) {
      this.logger.error(`OPay status check failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Refund a payment
   */
  async refundPayment(request: OPayRefundRequest): Promise<OPayRefundResponse> {
    this.logger.log(`Refunding OPay payment: ${request.originalOrderNo}`);

    const payload = {
      country: 'EG',
      reference: request.reference,
      orderNo: request.originalOrderNo,
      amount: {
        currency: request.amount.currency || 'EGP',
        total: request.amount.total,
      },
      reason: request.reason || 'Customer request',
    };

    const signature = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.REFUND}`,
          payload,
          {
            headers: this.getHeaders(signature),
          }
        )
      );

      const data = response.data;

      if (data.code !== '00000') {
        throw new HttpException(
          {
            message: data.message || 'OPay refund failed',
            code: `OPAY_${data.code}`,
          },
          HttpStatus.BAD_REQUEST
        );
      }

      return data;
    } catch (error) {
      this.logger.error(`OPay refund failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Cancel a pending payment
   */
  async cancelPayment(orderNo: string, reference: string): Promise<any> {
    this.logger.log(`Cancelling OPay payment: ${reference}`);

    const payload = {
      country: 'EG',
      orderNo,
      reference,
    };

    const signature = this.calculateSignature(payload);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.config.baseUrl}${this.ENDPOINTS.CANCEL}`,
          payload,
          {
            headers: this.getHeaders(signature),
          }
        )
      );

      return response.data;
    } catch (error) {
      this.logger.error(`OPay cancel failed: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Verify webhook signature from OPay
   */
  verifyWebhookSignature(payload: string, receivedSignature: string): boolean {
    const calculatedSignature = crypto
      .createHmac('sha512', this.config.privateKey)
      .update(payload)
      .digest('hex');

    return calculatedSignature.toLowerCase() === receivedSignature.toLowerCase();
  }

  /**
   * Handle OPay webhook notification
   */
  async handleWebhook(payload: OPayWebhookPayload, rawBody: string, signature: string): Promise<void> {
    this.logger.log(`Processing OPay webhook: ${payload.reference}`);

    // Verify signature
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Invalid OPay webhook signature');
      throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
    }

    // Process based on status
    switch (payload.status) {
      case 'SUCCESS':
        this.logger.log(`OPay payment completed: ${payload.orderNo}`);
        // TODO: Update payment status in HealthPay
        // TODO: Update wallet balance
        // TODO: Send notification to customer
        break;

      case 'FAIL':
        this.logger.log(`OPay payment failed: ${payload.orderNo}`);
        // TODO: Mark payment as failed
        // TODO: Notify customer
        break;

      case 'CLOSE':
        this.logger.log(`OPay payment closed/expired: ${payload.orderNo}`);
        // TODO: Mark payment as expired
        break;

      case 'PENDING':
        this.logger.log(`OPay payment pending: ${payload.orderNo}`);
        // Payment is still processing
        break;

      default:
        this.logger.warn(`Unknown OPay status: ${payload.status}`);
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private calculateSignature(payload: any): string {
    const payloadString = JSON.stringify(payload);
    return crypto
      .createHmac('sha512', this.config.privateKey)
      .update(payloadString)
      .digest('hex');
  }

  private getHeaders(signature: string, usePublicKey: boolean = false): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'MerchantId': this.config.merchantId,
      'Authorization': usePublicKey 
        ? `Bearer ${this.config.publicKey}` 
        : `Bearer ${signature}`,
    };
  }

  private formatEgyptPhone(phone: string): string {
    // Format to: +20xxxxxxxxxx
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('0')) {
      cleaned = cleaned.substring(1);
    }
    
    if (!cleaned.startsWith('20')) {
      cleaned = '20' + cleaned;
    }
    
    return '+' + cleaned;
  }

  private handleError(error: any): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    if (error.response) {
      return new HttpException(
        {
          message: error.response.data?.message || 'OPay service error',
          code: `OPAY_${error.response.data?.code || 'ERROR'}`,
        },
        error.response.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    return new HttpException(
      'OPay service unavailable',
      HttpStatus.SERVICE_UNAVAILABLE
    );
  }
}

// ============================================================================
// Module Export
// ============================================================================

export { OPayConnectorService as default };
