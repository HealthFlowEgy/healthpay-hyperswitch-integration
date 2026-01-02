import {
  Controller,
  Post,
  Body,
  Headers,
  RawBodyRequest,
  Req,
  HttpCode,
  HttpStatus,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'crypto';
import { PaymentAdapterService } from './payment-adapter.service';
import { WebhookEvent } from './types';

/**
 * Webhook Controller
 * 
 * Handles incoming webhook events from Hyperswitch.
 * Verifies webhook signatures and processes events asynchronously.
 */
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private readonly webhookSecret: string;

  constructor(
    private readonly paymentService: PaymentAdapterService,
    private readonly configService: ConfigService,
  ) {
    this.webhookSecret = this.configService.get<string>(
      'HYPERSWITCH_WEBHOOK_SECRET',
      '',
    );
  }

  /**
   * Handle Hyperswitch webhook
   * POST /webhooks/hyperswitch
   */
  @Post('hyperswitch')
  @HttpCode(HttpStatus.OK)
  async handleHyperswitchWebhook(
    @Body() event: WebhookEvent,
    @Headers('x-webhook-signature') signature: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    this.logger.log(`Received webhook: ${event.event_type}`);

    // Verify signature if secret is configured
    if (this.webhookSecret && signature) {
      const isValid = this.verifySignature(
        request.rawBody?.toString() || JSON.stringify(event),
        signature,
      );
      
      if (!isValid) {
        this.logger.warn('Invalid webhook signature');
        throw new UnauthorizedException('Invalid webhook signature');
      }
    }

    try {
      // Process webhook asynchronously
      await this.paymentService.handleWebhook(event);
      
      return { received: true };
    } catch (error) {
      this.logger.error(`Webhook processing failed: ${error.message}`);
      // Still return 200 to prevent retries for processing errors
      return { received: true, error: error.message };
    }
  }

  /**
   * Health check for webhook endpoint
   * POST /webhooks/health
   */
  @Post('health')
  @HttpCode(HttpStatus.OK)
  healthCheck() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Verify webhook signature using HMAC-SHA256
   */
  private verifySignature(payload: string, signature: string): boolean {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(payload)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      );
    } catch (error) {
      this.logger.error(`Signature verification failed: ${error.message}`);
      return false;
    }
  }
}
