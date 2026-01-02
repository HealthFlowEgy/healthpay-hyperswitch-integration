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
} from '@nestjs/common';
import { Request } from 'express';
import { FawryConnectorService, FawryWebhookPayload } from './connectors/fawry.connector';
import { OPayConnectorService, OPayWebhookPayload } from './connectors/opay.connector';
import { UPGConnectorService, UPGWebhookPayload } from './connectors/upg.connector';

/**
 * Egypt Payment Webhook Controller
 * 
 * Handles webhook notifications from:
 * - Fawry
 * - OPay
 * - UPG (Meeza/InstaPay/Cards)
 */
@Controller('webhooks/egypt')
export class EgyptWebhookController {
  private readonly logger = new Logger(EgyptWebhookController.name);

  constructor(
    private readonly fawryConnector: FawryConnectorService,
    private readonly opayConnector: OPayConnectorService,
    private readonly upgConnector: UPGConnectorService,
  ) {}

  /**
   * Fawry webhook endpoint
   * POST /webhooks/egypt/fawry
   */
  @Post('fawry')
  @HttpCode(HttpStatus.OK)
  async handleFawryWebhook(@Body() payload: FawryWebhookPayload) {
    this.logger.log(`Fawry webhook received: ${payload.merchantRefNumber}`);

    try {
      await this.fawryConnector.handleWebhook(payload);
      
      return {
        statusCode: 200,
        statusDescription: 'Notification received successfully',
      };
    } catch (error) {
      this.logger.error(`Fawry webhook processing failed: ${error.message}`);
      
      // Return success to prevent Fawry from retrying
      // Log error for investigation
      return {
        statusCode: 200,
        statusDescription: 'Notification received',
      };
    }
  }

  /**
   * OPay webhook endpoint
   * POST /webhooks/egypt/opay
   */
  @Post('opay')
  @HttpCode(HttpStatus.OK)
  async handleOPayWebhook(
    @Body() payload: OPayWebhookPayload,
    @Headers('authorization') authorization: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    this.logger.log(`OPay webhook received: ${payload.reference}`);

    try {
      // Extract signature from Authorization header (Bearer <signature>)
      const signature = authorization?.replace('Bearer ', '') || '';
      const rawBody = request.rawBody?.toString() || JSON.stringify(payload);

      await this.opayConnector.handleWebhook(payload, rawBody, signature);
      
      return {
        code: '00000',
        message: 'SUCCESS',
      };
    } catch (error) {
      this.logger.error(`OPay webhook processing failed: ${error.message}`);
      
      return {
        code: '00000',
        message: 'Received',
      };
    }
  }

  /**
   * UPG webhook endpoint (Meeza/InstaPay/Cards)
   * POST /webhooks/egypt/upg
   */
  @Post('upg')
  @HttpCode(HttpStatus.OK)
  async handleUPGWebhook(@Body() payload: UPGWebhookPayload) {
    this.logger.log(`UPG webhook received: ${payload.transactionId}`);

    try {
      await this.upgConnector.handleWebhook(payload);
      
      return {
        success: true,
        message: 'Notification processed',
      };
    } catch (error) {
      this.logger.error(`UPG webhook processing failed: ${error.message}`);
      
      return {
        success: true,
        message: 'Notification received',
      };
    }
  }

  /**
   * Meeza-specific webhook (if separate from UPG)
   * POST /webhooks/egypt/meeza
   */
  @Post('meeza')
  @HttpCode(HttpStatus.OK)
  async handleMeezaWebhook(@Body() payload: UPGWebhookPayload) {
    return this.handleUPGWebhook(payload);
  }

  /**
   * InstaPay-specific webhook (if separate from UPG)
   * POST /webhooks/egypt/instapay
   */
  @Post('instapay')
  @HttpCode(HttpStatus.OK)
  async handleInstapayWebhook(@Body() payload: UPGWebhookPayload) {
    return this.handleUPGWebhook(payload);
  }

  /**
   * Health check for webhook endpoints
   * POST /webhooks/egypt/health
   */
  @Post('health')
  @HttpCode(HttpStatus.OK)
  healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      endpoints: [
        '/webhooks/egypt/fawry',
        '/webhooks/egypt/opay',
        '/webhooks/egypt/upg',
        '/webhooks/egypt/meeza',
        '/webhooks/egypt/instapay',
      ],
    };
  }
}
