import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { EgyptPaymentService, EgyptPaymentRequest, EgyptPaymentMethod } from './egypt-payment.service';

/**
 * Egypt Payment Controller
 * 
 * REST API endpoints for Egypt payment methods:
 * - Fawry Reference Code
 * - OPay Wallet
 * - Meeza Card/QR
 * - InstaPay
 * - International Cards
 */
@Controller('egypt-payments')
export class EgyptPaymentController {
  private readonly logger = new Logger(EgyptPaymentController.name);

  constructor(private readonly paymentService: EgyptPaymentService) {}

  /**
   * Get available Egypt payment methods
   * GET /egypt-payments/methods
   */
  @Get('methods')
  getPaymentMethods() {
    return {
      success: true,
      data: this.paymentService.getAvailablePaymentMethods(),
    };
  }

  /**
   * Create a payment
   * POST /egypt-payments
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createPayment(@Body() request: EgyptPaymentRequest) {
    this.logger.log(`Creating ${request.paymentMethod} payment: ${request.orderId}`);
    
    const result = await this.paymentService.createPayment(request);
    
    return {
      success: result.success,
      data: result,
    };
  }

  /**
   * Create Fawry payment
   * POST /egypt-payments/fawry
   */
  @Post('fawry')
  @HttpCode(HttpStatus.CREATED)
  async createFawryPayment(@Body() request: Omit<EgyptPaymentRequest, 'paymentMethod'>) {
    return this.createPayment({ ...request, paymentMethod: 'FAWRY' });
  }

  /**
   * Create OPay wallet payment
   * POST /egypt-payments/opay/wallet
   */
  @Post('opay/wallet')
  @HttpCode(HttpStatus.CREATED)
  async createOPayWalletPayment(@Body() request: Omit<EgyptPaymentRequest, 'paymentMethod'>) {
    return this.createPayment({ ...request, paymentMethod: 'OPAY_WALLET' });
  }

  /**
   * Create OPay cashier payment
   * POST /egypt-payments/opay/cashier
   */
  @Post('opay/cashier')
  @HttpCode(HttpStatus.CREATED)
  async createOPayCashierPayment(@Body() request: Omit<EgyptPaymentRequest, 'paymentMethod'>) {
    return this.createPayment({ ...request, paymentMethod: 'OPAY_CASHIER' });
  }

  /**
   * Create Meeza card payment
   * POST /egypt-payments/meeza/card
   */
  @Post('meeza/card')
  @HttpCode(HttpStatus.CREATED)
  async createMeezaCardPayment(@Body() request: Omit<EgyptPaymentRequest, 'paymentMethod'>) {
    return this.createPayment({ ...request, paymentMethod: 'MEEZA_CARD' });
  }

  /**
   * Create Meeza QR payment
   * POST /egypt-payments/meeza/qr
   */
  @Post('meeza/qr')
  @HttpCode(HttpStatus.CREATED)
  async createMeezaQRPayment(@Body() request: Omit<EgyptPaymentRequest, 'paymentMethod'>) {
    return this.createPayment({ ...request, paymentMethod: 'MEEZA_QR' });
  }

  /**
   * Create InstaPay payment
   * POST /egypt-payments/instapay
   */
  @Post('instapay')
  @HttpCode(HttpStatus.CREATED)
  async createInstapayPayment(@Body() request: Omit<EgyptPaymentRequest, 'paymentMethod'>) {
    return this.createPayment({ ...request, paymentMethod: 'INSTAPAY' });
  }

  /**
   * Create card payment (Visa/MC)
   * POST /egypt-payments/card
   */
  @Post('card')
  @HttpCode(HttpStatus.CREATED)
  async createCardPayment(@Body() request: Omit<EgyptPaymentRequest, 'paymentMethod'>) {
    return this.createPayment({ ...request, paymentMethod: 'CARD' });
  }

  /**
   * Get payment status
   * GET /egypt-payments/:transactionId/status
   */
  @Get(':transactionId/status')
  async getPaymentStatus(
    @Param('transactionId') transactionId: string,
    @Query('method') paymentMethod: EgyptPaymentMethod,
  ) {
    this.logger.log(`Checking status for ${transactionId}`);
    
    const status = await this.paymentService.getPaymentStatus(transactionId, paymentMethod);
    
    return {
      success: true,
      data: status,
    };
  }

  /**
   * Refund a payment
   * POST /egypt-payments/:transactionId/refund
   */
  @Post(':transactionId/refund')
  async refundPayment(
    @Param('transactionId') transactionId: string,
    @Body() body: {
      paymentMethod: EgyptPaymentMethod;
      amount?: number;
      reason?: string;
    },
  ) {
    this.logger.log(`Refunding payment ${transactionId}`);
    
    const result = await this.paymentService.refundPayment(
      transactionId,
      body.paymentMethod,
      body.amount,
      body.reason,
    );
    
    return {
      success: true,
      data: result,
    };
  }
}
