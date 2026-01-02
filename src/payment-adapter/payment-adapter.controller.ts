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
import { PaymentAdapterService } from './payment-adapter.service';
import {
  CreatePaymentRequest,
  PaymentMethod,
  RefundRequest,
  CaptureRequest,
  PaymentStatus,
} from './types';

/**
 * Payment Adapter Controller
 * 
 * REST API endpoints for payment operations.
 * These endpoints can be used by HealthPay services or exposed via GraphQL.
 */
@Controller('payments')
export class PaymentAdapterController {
  private readonly logger = new Logger(PaymentAdapterController.name);

  constructor(private readonly paymentService: PaymentAdapterService) {}

  /**
   * Create a new payment intent
   * POST /payments
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createPayment(@Body() request: CreatePaymentRequest) {
    this.logger.log(`Creating payment: ${request.referenceId}`);
    return this.paymentService.createPayment(request);
  }

  /**
   * Confirm a payment with payment method
   * POST /payments/:id/confirm
   */
  @Post(':id/confirm')
  async confirmPayment(
    @Param('id') paymentId: string,
    @Body() paymentMethod: PaymentMethod,
  ) {
    this.logger.log(`Confirming payment: ${paymentId}`);
    return this.paymentService.confirmPayment(paymentId, paymentMethod);
  }

  /**
   * Capture an authorized payment
   * POST /payments/:id/capture
   */
  @Post(':id/capture')
  async capturePayment(
    @Param('id') paymentId: string,
    @Body() request: Partial<CaptureRequest>,
  ) {
    this.logger.log(`Capturing payment: ${paymentId}`);
    return this.paymentService.capturePayment({
      paymentId,
      amount: request.amount,
    });
  }

  /**
   * Void/Cancel an authorized payment
   * POST /payments/:id/void
   */
  @Post(':id/void')
  async voidPayment(@Param('id') paymentId: string) {
    this.logger.log(`Voiding payment: ${paymentId}`);
    return this.paymentService.voidPayment(paymentId);
  }

  /**
   * Get payment details
   * GET /payments/:id
   */
  @Get(':id')
  async getPayment(@Param('id') paymentId: string) {
    this.logger.log(`Retrieving payment: ${paymentId}`);
    return this.paymentService.getPayment(paymentId);
  }

  /**
   * List payments with filters
   * GET /payments
   */
  @Get()
  async listPayments(
    @Query('customerId') customerId?: string,
    @Query('status') status?: PaymentStatus,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.paymentService.listPayments({
      customerId,
      status,
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
    });
  }
}

/**
 * Refund Controller
 */
@Controller('refunds')
export class RefundController {
  private readonly logger = new Logger(RefundController.name);

  constructor(private readonly paymentService: PaymentAdapterService) {}

  /**
   * Create a refund
   * POST /refunds
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createRefund(@Body() request: RefundRequest) {
    this.logger.log(`Creating refund for payment: ${request.paymentId}`);
    return this.paymentService.refundPayment(request);
  }
}
