import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { FawryConnectorService, FawryCreatePaymentRequest, FawryPaymentResponse } from './connectors/fawry.connector';
import { OPayConnectorService, OPayCreatePaymentRequest, OPayPaymentResponse } from './connectors/opay.connector';
import { UPGConnectorService, UPGCreatePaymentRequest, UPGPaymentResponse } from './connectors/upg.connector';

/**
 * Unified Egypt Payment Service
 * 
 * Orchestrates all Egypt-specific payment methods:
 * - Fawry (Cash payment at 194,000+ outlets)
 * - OPay (E-Wallet with QR and R2P)
 * - UPG (Meeza, InstaPay, Cards)
 * 
 * Provides a single interface for HealthPay to process payments
 * across all Egyptian payment rails.
 */

// ============================================================================
// Types
// ============================================================================

export type EgyptPaymentMethod = 
  | 'FAWRY'           // Cash at Fawry outlets
  | 'OPAY_WALLET'     // OPay wallet QR/R2P
  | 'OPAY_CASHIER'    // OPay hosted checkout
  | 'MEEZA_CARD'      // Egypt national debit card
  | 'MEEZA_QR'        // Meeza QR code payment
  | 'INSTAPAY'        // Instant bank transfer
  | 'CARD';           // Visa/Mastercard

export interface EgyptPaymentRequest {
  // Common fields
  orderId: string;
  amount: number;
  currency?: string;
  description?: string;
  
  // Customer info
  customer: {
    name: string;
    email?: string;
    mobile: string;
    nationalId?: string;
  };
  
  // Payment method
  paymentMethod: EgyptPaymentMethod;
  
  // URLs
  returnUrl?: string;
  callbackUrl: string;
  
  // Method-specific fields
  fawryItems?: Array<{
    itemId: string;
    description: string;
    price: number;
    quantity: number;
  }>;
  
  ipaAddress?: string; // For InstaPay
  expiryMinutes?: number;
  
  // Metadata
  metadata?: Record<string, any>;
}

export interface EgyptPaymentResponse {
  success: boolean;
  paymentMethod: EgyptPaymentMethod;
  transactionId: string;
  orderId: string;
  status: string;
  
  // Payment-specific data
  referenceNumber?: string;    // Fawry reference
  qrCodeUrl?: string;          // OPay/Meeza QR
  qrCodeData?: string;         // Raw QR data
  paymentUrl?: string;         // Redirect URL
  cashierUrl?: string;         // OPay cashier
  ipaAddress?: string;         // InstaPay IPA
  
  // Expiration
  expiresAt?: Date;
  
  // Error info
  errorCode?: string;
  errorMessage?: string;
  
  // Instructions for customer
  instructions?: string[];
}

export interface EgyptPaymentStatusResponse {
  transactionId: string;
  orderId: string;
  paymentMethod: EgyptPaymentMethod;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'CANCELLED';
  amount: number;
  currency: string;
  paidAt?: Date;
  paymentDetails?: Record<string, any>;
}

// ============================================================================
// Service Implementation
// ============================================================================

@Injectable()
export class EgyptPaymentService {
  private readonly logger = new Logger(EgyptPaymentService.name);

  constructor(
    private readonly fawryConnector: FawryConnectorService,
    private readonly opayConnector: OPayConnectorService,
    private readonly upgConnector: UPGConnectorService,
  ) {
    this.logger.log('Egypt Payment Service initialized');
  }

  /**
   * Create a payment using any Egypt payment method
   */
  async createPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    this.logger.log(`Creating ${request.paymentMethod} payment: ${request.orderId}`);

    try {
      switch (request.paymentMethod) {
        case 'FAWRY':
          return this.createFawryPayment(request);
        
        case 'OPAY_WALLET':
          return this.createOPayWalletPayment(request);
        
        case 'OPAY_CASHIER':
          return this.createOPayCashierPayment(request);
        
        case 'MEEZA_CARD':
          return this.createMeezaPayment(request);
        
        case 'MEEZA_QR':
          return this.createMeezaQRPayment(request);
        
        case 'INSTAPAY':
          return this.createInstapayPayment(request);
        
        case 'CARD':
          return this.createCardPayment(request);
        
        default:
          throw new HttpException(
            `Unsupported payment method: ${request.paymentMethod}`,
            HttpStatus.BAD_REQUEST
          );
      }
    } catch (error) {
      this.logger.error(`Payment creation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get payment status across all connectors
   */
  async getPaymentStatus(
    transactionId: string, 
    paymentMethod: EgyptPaymentMethod
  ): Promise<EgyptPaymentStatusResponse> {
    this.logger.log(`Checking ${paymentMethod} payment status: ${transactionId}`);

    try {
      switch (paymentMethod) {
        case 'FAWRY':
          const fawryStatus = await this.fawryConnector.getPaymentStatus(transactionId);
          return {
            transactionId: fawryStatus.referenceNumber,
            orderId: fawryStatus.merchantRefNumber,
            paymentMethod: 'FAWRY',
            status: this.mapFawryStatus(fawryStatus.paymentStatus),
            amount: fawryStatus.paymentAmount,
            currency: 'EGP',
            paidAt: fawryStatus.paymentTime ? new Date(fawryStatus.paymentTime) : undefined,
          };

        case 'OPAY_WALLET':
        case 'OPAY_CASHIER':
          const opayStatus = await this.opayConnector.getPaymentStatus(transactionId, transactionId);
          return {
            transactionId: opayStatus.data.orderNo,
            orderId: opayStatus.data.reference,
            paymentMethod: paymentMethod,
            status: this.mapOPayStatus(opayStatus.data.status),
            amount: opayStatus.data.amount.total,
            currency: opayStatus.data.amount.currency,
            paidAt: opayStatus.data.transactionTime ? new Date(opayStatus.data.transactionTime) : undefined,
          };

        case 'MEEZA_CARD':
        case 'MEEZA_QR':
        case 'INSTAPAY':
        case 'CARD':
          const upgStatus = await this.upgConnector.getPaymentStatus(transactionId);
          return {
            transactionId: upgStatus.transactionId,
            orderId: upgStatus.orderId,
            paymentMethod: paymentMethod,
            status: this.mapUPGStatus(upgStatus.status),
            amount: upgStatus.amount.value,
            currency: upgStatus.amount.currency,
            paidAt: upgStatus.transactionTime ? new Date(upgStatus.transactionTime) : undefined,
            paymentDetails: {
              cardType: upgStatus.cardType,
              maskedPan: upgStatus.maskedPan,
              authCode: upgStatus.authCode,
            },
          };

        default:
          throw new HttpException('Invalid payment method', HttpStatus.BAD_REQUEST);
      }
    } catch (error) {
      this.logger.error(`Status check failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Refund a payment
   */
  async refundPayment(
    transactionId: string,
    paymentMethod: EgyptPaymentMethod,
    amount?: number,
    reason?: string
  ): Promise<any> {
    this.logger.log(`Refunding ${paymentMethod} payment: ${transactionId}`);

    try {
      switch (paymentMethod) {
        case 'FAWRY':
          return this.fawryConnector.refundPayment({
            referenceNumber: transactionId,
            refundAmount: amount || 0,
            reason,
          });

        case 'OPAY_WALLET':
        case 'OPAY_CASHIER':
          return this.opayConnector.refundPayment({
            reference: `REF-${Date.now()}`,
            originalOrderNo: transactionId,
            amount: { currency: 'EGP', total: amount || 0 },
            reason,
          });

        case 'MEEZA_CARD':
        case 'MEEZA_QR':
        case 'INSTAPAY':
        case 'CARD':
          return this.upgConnector.refundPayment({
            transactionId,
            amount: { value: amount || 0, currency: 'EGP' },
            reason,
          });

        default:
          throw new HttpException('Invalid payment method', HttpStatus.BAD_REQUEST);
      }
    } catch (error) {
      this.logger.error(`Refund failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get available payment methods for Egypt
   */
  getAvailablePaymentMethods(): Array<{
    code: EgyptPaymentMethod;
    name: string;
    nameAr: string;
    description: string;
    icon: string;
    minAmount: number;
    maxAmount: number;
  }> {
    return [
      {
        code: 'FAWRY',
        name: 'Fawry',
        nameAr: 'فوري',
        description: 'Pay at 194,000+ Fawry outlets across Egypt',
        icon: 'fawry.png',
        minAmount: 1,
        maxAmount: 50000,
      },
      {
        code: 'OPAY_WALLET',
        name: 'OPay Wallet',
        nameAr: 'محفظة أوباي',
        description: 'Pay with OPay wallet QR or push notification',
        icon: 'opay.png',
        minAmount: 1,
        maxAmount: 30000,
      },
      {
        code: 'MEEZA_CARD',
        name: 'Meeza Card',
        nameAr: 'بطاقة ميزة',
        description: 'Egypt national debit card',
        icon: 'meeza.png',
        minAmount: 1,
        maxAmount: 100000,
      },
      {
        code: 'MEEZA_QR',
        name: 'Meeza QR',
        nameAr: 'ميزة كيو آر',
        description: 'Scan QR code with Meeza-enabled app',
        icon: 'meeza-qr.png',
        minAmount: 1,
        maxAmount: 50000,
      },
      {
        code: 'INSTAPAY',
        name: 'InstaPay',
        nameAr: 'انستاباي',
        description: 'Instant bank transfer via IPN',
        icon: 'instapay.png',
        minAmount: 1,
        maxAmount: 100000,
      },
      {
        code: 'CARD',
        name: 'Credit/Debit Card',
        nameAr: 'بطاقة ائتمان',
        description: 'Visa, Mastercard, American Express',
        icon: 'cards.png',
        minAmount: 10,
        maxAmount: 1000000,
      },
    ];
  }

  // ============================================================================
  // Private Payment Creation Methods
  // ============================================================================

  private async createFawryPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    const fawryRequest: FawryCreatePaymentRequest = {
      merchantRefNum: request.orderId,
      customerProfileId: request.customer.mobile,
      customerMobile: request.customer.mobile,
      customerEmail: request.customer.email,
      customerName: request.customer.name,
      amount: request.amount,
      currencyCode: request.currency || 'EGP',
      description: request.description,
      chargeItems: request.fawryItems || [{
        itemId: request.orderId,
        description: request.description || 'HealthPay Payment',
        price: request.amount,
        quantity: 1,
      }],
      expiryHours: request.expiryMinutes ? Math.ceil(request.expiryMinutes / 60) : 24,
      metadata: request.metadata,
    };

    const response = await this.fawryConnector.createPayment(fawryRequest);

    return {
      success: response.statusCode === 200,
      paymentMethod: 'FAWRY',
      transactionId: response.referenceNumber,
      orderId: response.merchantRefNumber,
      status: 'PENDING',
      referenceNumber: response.referenceNumber,
      expiresAt: new Date(response.expirationTime),
      instructions: [
        `رقم المرجع: ${response.referenceNumber}`,
        'اذهب إلى أي منفذ فوري',
        'اختر "دفع فاتورة"',
        'أدخل رقم المرجع',
        `ادفع ${request.amount} جنيه`,
      ],
    };
  }

  private async createOPayWalletPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    const opayRequest: OPayCreatePaymentRequest = {
      reference: request.orderId,
      amount: {
        currency: request.currency || 'EGP',
        total: Math.round(request.amount * 100), // OPay uses minor units
      },
      product: {
        name: request.description || 'HealthPay Payment',
      },
      userInfo: {
        userName: request.customer.name,
        userEmail: request.customer.email,
        userMobile: request.customer.mobile,
      },
      callbackUrl: request.callbackUrl,
      returnUrl: request.returnUrl,
      expireAt: request.expiryMinutes || 30,
    };

    const response = await this.opayConnector.createWalletPayment(opayRequest);

    return {
      success: response.code === '00000',
      paymentMethod: 'OPAY_WALLET',
      transactionId: response.data.orderNo,
      orderId: response.data.reference,
      status: 'PENDING',
      qrCodeUrl: response.data.qrCodeUrl,
      expiresAt: response.data.expireAt ? new Date(response.data.expireAt) : undefined,
      instructions: [
        'افتح تطبيق OPay',
        'امسح رمز QR',
        'أو انتظر إشعار الدفع',
        'أكد الدفع في التطبيق',
      ],
    };
  }

  private async createOPayCashierPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    const opayRequest: OPayCreatePaymentRequest = {
      reference: request.orderId,
      amount: {
        currency: request.currency || 'EGP',
        total: Math.round(request.amount * 100),
      },
      product: {
        name: request.description || 'HealthPay Payment',
      },
      userInfo: {
        userName: request.customer.name,
        userEmail: request.customer.email,
        userMobile: request.customer.mobile,
      },
      callbackUrl: request.callbackUrl,
      returnUrl: request.returnUrl,
      cancelUrl: request.returnUrl,
    };

    const response = await this.opayConnector.createCashierPayment(opayRequest);

    return {
      success: response.code === '00000',
      paymentMethod: 'OPAY_CASHIER',
      transactionId: response.data.orderNo,
      orderId: response.data.reference,
      status: 'PENDING',
      cashierUrl: response.data.cashierUrl,
      paymentUrl: response.data.cashierUrl,
      instructions: [
        'سيتم توجيهك إلى صفحة الدفع',
        'اختر طريقة الدفع المفضلة',
        'أكمل عملية الدفع',
      ],
    };
  }

  private async createMeezaPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    const upgRequest: UPGCreatePaymentRequest = {
      orderId: request.orderId,
      amount: { value: request.amount, currency: request.currency || 'EGP' },
      customer: {
        name: request.customer.name,
        email: request.customer.email,
        mobile: request.customer.mobile,
        nationalId: request.customer.nationalId,
      },
      description: request.description,
      returnUrl: request.returnUrl || '',
      callbackUrl: request.callbackUrl,
      paymentMethod: 'MEEZA',
      metadata: request.metadata,
    };

    const response = await this.upgConnector.createMeezaPayment(upgRequest);

    return {
      success: response.success,
      paymentMethod: 'MEEZA_CARD',
      transactionId: response.transactionId,
      orderId: response.orderId,
      status: response.status,
      paymentUrl: response.paymentUrl,
      referenceNumber: response.referenceNumber,
      instructions: [
        'سيتم توجيهك إلى صفحة بطاقة ميزة',
        'أدخل بيانات البطاقة',
        'أكد عملية الدفع',
      ],
    };
  }

  private async createMeezaQRPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    const response = await this.upgConnector.createMeezaQRPayment({
      orderId: request.orderId,
      amount: { value: request.amount, currency: request.currency || 'EGP' },
      customer: {
        name: request.customer.name,
        mobile: request.customer.mobile,
      },
      callbackUrl: request.callbackUrl,
      expiryMinutes: request.expiryMinutes || 15,
    });

    return {
      success: response.success,
      paymentMethod: 'MEEZA_QR',
      transactionId: response.transactionId,
      orderId: response.orderId,
      status: 'PENDING',
      qrCodeData: response.qrCodeData,
      referenceNumber: response.referenceNumber,
      expiresAt: new Date(Date.now() + (request.expiryMinutes || 15) * 60 * 1000),
      instructions: [
        'امسح رمز QR بتطبيق ميزة',
        'أو استخدم أي تطبيق بنكي يدعم ميزة',
        'أكد الدفع في التطبيق',
      ],
    };
  }

  private async createInstapayPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    if (!request.ipaAddress) {
      throw new HttpException(
        'IPA address is required for InstaPay payments',
        HttpStatus.BAD_REQUEST
      );
    }

    const response = await this.upgConnector.createInstapayR2P({
      orderId: request.orderId,
      amount: { value: request.amount, currency: request.currency || 'EGP' },
      senderIpa: request.ipaAddress,
      receiverIpa: 'healthpay@ipa', // Merchant's IPA
      description: request.description,
      callbackUrl: request.callbackUrl,
    });

    return {
      success: response.success,
      paymentMethod: 'INSTAPAY',
      transactionId: response.transactionId,
      orderId: response.orderId,
      status: 'PENDING',
      ipaAddress: response.ipaAddress,
      referenceNumber: response.referenceNumber,
      instructions: [
        'ستصلك طلب دفع في تطبيق البنك',
        'افتح التطبيق وأكد الدفع',
        'أو ادفع عبر انستاباي',
      ],
    };
  }

  private async createCardPayment(request: EgyptPaymentRequest): Promise<EgyptPaymentResponse> {
    const upgRequest: UPGCreatePaymentRequest = {
      orderId: request.orderId,
      amount: { value: request.amount, currency: request.currency || 'EGP' },
      customer: {
        name: request.customer.name,
        email: request.customer.email,
        mobile: request.customer.mobile,
      },
      description: request.description,
      returnUrl: request.returnUrl || '',
      callbackUrl: request.callbackUrl,
      paymentMethod: 'CARD',
      metadata: request.metadata,
    };

    const response = await this.upgConnector.createCardPayment(upgRequest);

    return {
      success: response.success,
      paymentMethod: 'CARD',
      transactionId: response.transactionId,
      orderId: response.orderId,
      status: response.status,
      paymentUrl: response.paymentUrl,
      instructions: [
        'سيتم توجيهك إلى صفحة الدفع الآمنة',
        'أدخل بيانات البطاقة',
        'أكمل التحقق ثلاثي الأبعاد',
      ],
    };
  }

  // ============================================================================
  // Status Mapping Helpers
  // ============================================================================

  private mapFawryStatus(status: string): EgyptPaymentStatusResponse['status'] {
    const map: Record<string, EgyptPaymentStatusResponse['status']> = {
      'PAID': 'PAID',
      'UNPAID': 'PENDING',
      'EXPIRED': 'EXPIRED',
      'REFUNDED': 'REFUNDED',
      'CANCELLED': 'CANCELLED',
    };
    return map[status] || 'PENDING';
  }

  private mapOPayStatus(status: string): EgyptPaymentStatusResponse['status'] {
    const map: Record<string, EgyptPaymentStatusResponse['status']> = {
      'SUCCESS': 'PAID',
      'PENDING': 'PENDING',
      'INITIAL': 'PENDING',
      'FAIL': 'FAILED',
      'CLOSE': 'EXPIRED',
    };
    return map[status] || 'PENDING';
  }

  private mapUPGStatus(status: string): EgyptPaymentStatusResponse['status'] {
    const map: Record<string, EgyptPaymentStatusResponse['status']> = {
      'CAPTURED': 'PAID',
      'AUTHORIZED': 'PENDING',
      'PENDING': 'PENDING',
      'CREATED': 'PENDING',
      'FAILED': 'FAILED',
      'CANCELLED': 'CANCELLED',
      'REFUNDED': 'REFUNDED',
      'EXPIRED': 'EXPIRED',
    };
    return map[status] || 'PENDING';
  }
}

export { EgyptPaymentService as default };
