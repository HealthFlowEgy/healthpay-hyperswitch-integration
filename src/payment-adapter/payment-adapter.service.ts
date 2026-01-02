import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import {
  CreatePaymentRequest,
  PaymentResponse,
  RefundRequest,
  RefundResponse,
  CaptureRequest,
  WebhookEvent,
  PaymentStatus,
  PaymentMethod,
} from './types';

/**
 * HealthPay Payment Adapter Service
 * 
 * This service provides a bridge between HealthPay's NestJS application
 * and the Hyperswitch payment orchestration platform.
 * 
 * Features:
 * - Payment creation with automatic routing
 * - Payment confirmation with card details
 * - Capture, refund, and void operations
 * - Webhook handling for async updates
 * - Egypt-specific payment method support
 */
@Injectable()
export class PaymentAdapterService {
  private readonly logger = new Logger(PaymentAdapterService.name);
  private readonly hyperswitchUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.hyperswitchUrl = this.configService.get<string>(
      'HYPERSWITCH_BASE_URL',
      'http://178.128.196.71:8080',
    );
    this.apiKey = this.configService.get<string>(
      'HYPERSWITCH_API_KEY',
      'snd_Rh9hqv8uUmlwYeEtGcJgmlFuM1P2Cw4ueySA9fI3n9TQrBDvAq0gaqZ5vf3bGDVO',
    );

    this.logger.log(`PaymentAdapter initialized with URL: ${this.hyperswitchUrl}`);
  }

  /**
   * Create a new payment intent
   */
  async createPayment(request: CreatePaymentRequest): Promise<PaymentResponse> {
    this.logger.log(`Creating payment for amount: ${request.amount} ${request.currency}`);

    const payload = {
      amount: request.amount,
      currency: request.currency || 'EGP',
      confirm: false,
      capture_method: request.captureMethod || 'automatic',
      customer_id: request.customerId,
      email: request.email,
      name: request.customerName,
      phone: request.phone,
      phone_country_code: '+20',
      description: request.description,
      return_url: request.returnUrl || 'https://healthpay.eg/payment/return',
      authentication_type: request.require3DS ? 'three_ds' : 'no_three_ds',
      billing: this.formatAddress(request.billingAddress),
      shipping: this.formatAddress(request.shippingAddress),
      metadata: {
        healthpay_reference: request.referenceId,
        source: 'healthpay',
        ...request.metadata,
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.hyperswitchUrl}/payments`, payload, {
          headers: this.getHeaders(),
        }),
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`Failed to create payment: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Confirm a payment with payment method details
   */
  async confirmPayment(
    paymentId: string,
    paymentMethod: PaymentMethod,
  ): Promise<PaymentResponse> {
    this.logger.log(`Confirming payment: ${paymentId}`);

    const payload = this.buildPaymentMethodPayload(paymentMethod);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.hyperswitchUrl}/payments/${paymentId}/confirm`,
          payload,
          { headers: this.getHeaders() },
        ),
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`Failed to confirm payment: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Capture an authorized payment
   */
  async capturePayment(request: CaptureRequest): Promise<PaymentResponse> {
    this.logger.log(`Capturing payment: ${request.paymentId}`);

    const payload = request.amount ? { amount_to_capture: request.amount } : {};

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.hyperswitchUrl}/payments/${request.paymentId}/capture`,
          payload,
          { headers: this.getHeaders() },
        ),
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`Failed to capture payment: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Void/Cancel an authorized payment
   */
  async voidPayment(paymentId: string): Promise<PaymentResponse> {
    this.logger.log(`Voiding payment: ${paymentId}`);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.hyperswitchUrl}/payments/${paymentId}/cancel`,
          { cancellation_reason: 'requested_by_customer' },
          { headers: this.getHeaders() },
        ),
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`Failed to void payment: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Create a refund for a payment
   */
  async refundPayment(request: RefundRequest): Promise<RefundResponse> {
    this.logger.log(`Refunding payment: ${request.paymentId}, amount: ${request.amount}`);

    const payload = {
      payment_id: request.paymentId,
      amount: request.amount,
      reason: request.reason || 'customer_request',
      refund_type: request.amount ? 'partial' : 'full',
      metadata: {
        healthpay_refund_reference: request.referenceId,
        ...request.metadata,
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.hyperswitchUrl}/refunds`, payload, {
          headers: this.getHeaders(),
        }),
      );

      return this.mapRefundResponse(response.data);
    } catch (error) {
      this.logger.error(`Failed to refund payment: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Get payment details
   */
  async getPayment(paymentId: string): Promise<PaymentResponse> {
    this.logger.log(`Retrieving payment: ${paymentId}`);

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.hyperswitchUrl}/payments/${paymentId}`, {
          headers: this.getHeaders(),
        }),
      );

      return this.mapPaymentResponse(response.data);
    } catch (error) {
      this.logger.error(`Failed to retrieve payment: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * List payments with filters
   */
  async listPayments(filters: {
    customerId?: string;
    status?: PaymentStatus;
    createdAfter?: Date;
    createdBefore?: Date;
    limit?: number;
    offset?: number;
  }): Promise<PaymentResponse[]> {
    const params = new URLSearchParams();
    
    if (filters.customerId) params.append('customer_id', filters.customerId);
    if (filters.status) params.append('status', filters.status);
    if (filters.createdAfter) params.append('created_gte', filters.createdAfter.toISOString());
    if (filters.createdBefore) params.append('created_lte', filters.createdBefore.toISOString());
    if (filters.limit) params.append('limit', filters.limit.toString());
    if (filters.offset) params.append('offset', filters.offset.toString());

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.hyperswitchUrl}/payments/list?${params.toString()}`, {
          headers: this.getHeaders(),
        }),
      );

      return response.data.data?.map(this.mapPaymentResponse) || [];
    } catch (error) {
      this.logger.error(`Failed to list payments: ${error.message}`);
      throw this.handleError(error);
    }
  }

  /**
   * Handle incoming webhook from Hyperswitch
   */
  async handleWebhook(event: WebhookEvent): Promise<void> {
    this.logger.log(`Processing webhook: ${event.event_type}`);

    switch (event.event_type) {
      case 'payment_succeeded':
        await this.onPaymentSucceeded(event.data);
        break;
      case 'payment_failed':
        await this.onPaymentFailed(event.data);
        break;
      case 'payment_processing':
        await this.onPaymentProcessing(event.data);
        break;
      case 'refund_succeeded':
        await this.onRefundSucceeded(event.data);
        break;
      case 'refund_failed':
        await this.onRefundFailed(event.data);
        break;
      default:
        this.logger.warn(`Unhandled webhook event: ${event.event_type}`);
    }
  }

  // ==================== Private Methods ====================

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'api-key': this.apiKey,
    };
  }

  private buildPaymentMethodPayload(paymentMethod: PaymentMethod): any {
    const base = {
      payment_method: 'card',
      payment_method_type: paymentMethod.type || 'credit',
      browser_info: {
        user_agent: 'HealthPay-Integration/1.0',
        accept_header: 'application/json',
        language: 'ar-EG',
        color_depth: 24,
        screen_height: 1080,
        screen_width: 1920,
        time_zone: 120, // Egypt GMT+2
        java_enabled: false,
        java_script_enabled: true,
      },
    };

    if (paymentMethod.card) {
      return {
        ...base,
        payment_method_data: {
          card: {
            card_number: paymentMethod.card.number,
            card_exp_month: paymentMethod.card.expiryMonth,
            card_exp_year: paymentMethod.card.expiryYear,
            card_holder_name: paymentMethod.card.holderName,
            card_cvc: paymentMethod.card.cvc,
          },
        },
      };
    }

    if (paymentMethod.token) {
      return {
        ...base,
        payment_token: paymentMethod.token,
      };
    }

    throw new HttpException('Invalid payment method', HttpStatus.BAD_REQUEST);
  }

  private formatAddress(address?: any): any {
    if (!address) return undefined;

    return {
      address: {
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        zip: address.postalCode,
        country: address.country || 'EG',
        first_name: address.firstName,
        last_name: address.lastName,
      },
    };
  }

  private mapPaymentResponse(data: any): PaymentResponse {
    return {
      paymentId: data.payment_id,
      hyperswitchPaymentId: data.payment_id,
      status: this.mapStatus(data.status),
      amount: data.amount,
      currency: data.currency,
      clientSecret: data.client_secret,
      connector: data.connector,
      connectorTransactionId: data.connector_transaction_id,
      paymentMethod: data.payment_method,
      errorCode: data.error_code,
      errorMessage: data.error_message,
      metadata: data.metadata,
      createdAt: new Date(data.created),
      updatedAt: new Date(data.modified),
      // 3DS data if applicable
      nextAction: data.next_action,
      authenticationUrl: data.next_action?.redirect_to_url,
    };
  }

  private mapRefundResponse(data: any): RefundResponse {
    return {
      refundId: data.refund_id,
      paymentId: data.payment_id,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      reason: data.reason,
      metadata: data.metadata,
      createdAt: new Date(data.created),
    };
  }

  private mapStatus(hyperswitchStatus: string): PaymentStatus {
    const statusMap: Record<string, PaymentStatus> = {
      requires_payment_method: PaymentStatus.PENDING,
      requires_confirmation: PaymentStatus.PENDING,
      requires_customer_action: PaymentStatus.REQUIRES_ACTION,
      processing: PaymentStatus.PROCESSING,
      requires_capture: PaymentStatus.AUTHORIZED,
      succeeded: PaymentStatus.CAPTURED,
      failed: PaymentStatus.FAILED,
      cancelled: PaymentStatus.CANCELLED,
      partially_captured: PaymentStatus.PARTIALLY_CAPTURED,
      partially_captured_and_capturable: PaymentStatus.PARTIALLY_CAPTURED,
    };

    return statusMap[hyperswitchStatus] || PaymentStatus.PENDING;
  }

  private handleError(error: any): HttpException {
    if (error.response) {
      const data = error.response.data;
      return new HttpException(
        {
          message: data.message || 'Payment processing failed',
          code: data.error?.code || 'PAYMENT_ERROR',
          details: data.error,
        },
        error.response.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return new HttpException(
      'Payment service unavailable',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  // Webhook handlers - to be implemented based on HealthPay's business logic
  private async onPaymentSucceeded(data: any): Promise<void> {
    this.logger.log(`Payment succeeded: ${data.payment_id}`);
    // TODO: Update HealthPay transaction status
    // TODO: Update wallet balance
    // TODO: Send notification to customer
  }

  private async onPaymentFailed(data: any): Promise<void> {
    this.logger.log(`Payment failed: ${data.payment_id}`);
    // TODO: Update HealthPay transaction status
    // TODO: Notify customer of failure
  }

  private async onPaymentProcessing(data: any): Promise<void> {
    this.logger.log(`Payment processing: ${data.payment_id}`);
    // TODO: Update transaction status to processing
  }

  private async onRefundSucceeded(data: any): Promise<void> {
    this.logger.log(`Refund succeeded: ${data.refund_id}`);
    // TODO: Update refund status
    // TODO: Update wallet balance
  }

  private async onRefundFailed(data: any): Promise<void> {
    this.logger.log(`Refund failed: ${data.refund_id}`);
    // TODO: Update refund status
    // TODO: Notify operations team
  }
}
