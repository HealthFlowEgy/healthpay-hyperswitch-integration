import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { PaymentLinkService, CreatePaymentLinkDto, PaymentLinkResponse } from './payment-link.service';
import { PaymentLinkStatus } from '../entities/payment-link.entity';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { CurrentMerchant } from '../decorators/current-merchant.decorator';
import { SubMerchant } from '../entities/sub-merchant.entity';

/**
 * Payment Links API Controller
 * 
 * REST API for creating and managing payment links.
 * 
 * Authentication: API Key in header
 * Header: X-API-Key: sk_live_xxxxx
 */
@Controller('v1/payment-links')
export class PaymentLinkController {
  private readonly logger = new Logger(PaymentLinkController.name);

  constructor(private readonly paymentLinkService: PaymentLinkService) {}

  /**
   * Create a new payment link
   * POST /v1/payment-links
   */
  @Post()
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.CREATED)
  async createPaymentLink(
    @CurrentMerchant() merchant: SubMerchant,
    @Body() dto: CreatePaymentLinkDto,
  ): Promise<{ success: boolean; data: PaymentLinkResponse }> {
    this.logger.log(`Creating payment link for ${merchant.merchantCode}`);

    const link = await this.paymentLinkService.createPaymentLink(
      merchant.id,
      dto,
    );

    return {
      success: true,
      data: link,
    };
  }

  /**
   * Get payment links for current merchant
   * GET /v1/payment-links
   */
  @Get()
  @UseGuards(ApiKeyGuard)
  async getPaymentLinks(
    @CurrentMerchant() merchant: SubMerchant,
    @Query('status') status?: PaymentLinkStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<{
    success: boolean;
    data: any[];
    pagination: { page: number; limit: number; total: number };
  }> {
    const pageNum = parseInt(page || '1', 10);
    const limitNum = Math.min(parseInt(limit || '20', 10), 100);

    const { links, total } = await this.paymentLinkService.getPaymentLinks(
      merchant.id,
      status,
      pageNum,
      limitNum,
    );

    return {
      success: true,
      data: links,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
      },
    };
  }

  /**
   * Get single payment link
   * GET /v1/payment-links/:id
   */
  @Get(':id')
  @UseGuards(ApiKeyGuard)
  async getPaymentLink(
    @CurrentMerchant() merchant: SubMerchant,
    @Param('id') id: string,
  ): Promise<{ success: boolean; data: any }> {
    const link = await this.paymentLinkService.getPaymentLinkByCode(id);

    // Verify ownership
    if (link.subMerchantId !== merchant.id) {
      throw new Error('Payment link not found');
    }

    return {
      success: true,
      data: link,
    };
  }

  /**
   * Deactivate payment link
   * DELETE /v1/payment-links/:id
   */
  @Delete(':id')
  @UseGuards(ApiKeyGuard)
  async deactivatePaymentLink(
    @CurrentMerchant() merchant: SubMerchant,
    @Param('id') id: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.paymentLinkService.deactivateLink(merchant.id, id);

    return {
      success: true,
      message: 'Payment link deactivated',
    };
  }

  /**
   * Resend payment link notification
   * POST /v1/payment-links/:id/resend
   */
  @Post(':id/resend')
  @UseGuards(ApiKeyGuard)
  async resendPaymentLink(
    @CurrentMerchant() merchant: SubMerchant,
    @Param('id') id: string,
    @Body() body: {
      sms?: boolean;
      whatsapp?: boolean;
      email?: boolean;
      phone?: string;
      emailAddress?: string;
    },
  ): Promise<{ success: boolean; message: string }> {
    await this.paymentLinkService.resendLink(merchant.id, id, body);

    return {
      success: true,
      message: 'Payment link resent',
    };
  }

  /**
   * Bulk create payment links
   * POST /v1/payment-links/bulk
   */
  @Post('bulk')
  @UseGuards(ApiKeyGuard)
  @HttpCode(HttpStatus.CREATED)
  async bulkCreatePaymentLinks(
    @CurrentMerchant() merchant: SubMerchant,
    @Body() body: { links: CreatePaymentLinkDto[] },
  ): Promise<{
    success: boolean;
    data: PaymentLinkResponse[];
    summary: { total: number; created: number; failed: number };
  }> {
    const results = await this.paymentLinkService.bulkCreateLinks(
      merchant.id,
      body.links,
    );

    return {
      success: true,
      data: results,
      summary: {
        total: body.links.length,
        created: results.length,
        failed: body.links.length - results.length,
      },
    };
  }
}

/**
 * Public Payment Link Controller (no auth)
 * For checkout page to fetch link details
 */
@Controller('l')
export class PublicPaymentLinkController {
  private readonly logger = new Logger(PublicPaymentLinkController.name);

  constructor(private readonly paymentLinkService: PaymentLinkService) {}

  /**
   * Get payment link details for checkout
   * GET /l/:code
   */
  @Get(':code')
  async getPaymentLinkForCheckout(
    @Param('code') code: string,
  ): Promise<{
    success: boolean;
    data: {
      title: string;
      titleAr: string;
      description: string;
      descriptionAr: string;
      amount: number | null;
      currency: string;
      allowCustomAmount: boolean;
      minAmount: number | null;
      maxAmount: number | null;
      merchantName: string;
      merchantNameAr: string;
      collectCustomerInfo: boolean;
      collectAddress: boolean;
      customFields: any[];
      enabledPaymentMethods: string[];
      expiresAt: Date | null;
    };
  }> {
    const link = await this.paymentLinkService.getPaymentLinkByCode(code);

    return {
      success: true,
      data: {
        title: link.title,
        titleAr: link.titleAr,
        description: link.description,
        descriptionAr: link.descriptionAr,
        amount: link.amount,
        currency: link.currency,
        allowCustomAmount: link.allowCustomAmount,
        minAmount: link.minAmount,
        maxAmount: link.maxAmount,
        merchantName: link.subMerchant?.businessName,
        merchantNameAr: link.subMerchant?.businessNameAr,
        collectCustomerInfo: link.collectCustomerInfo,
        collectAddress: link.collectAddress,
        customFields: link.customFields || [],
        enabledPaymentMethods: link.enabledPaymentMethods,
        expiresAt: link.expiresAt,
      },
    };
  }

  /**
   * Create checkout session from payment link
   * POST /l/:code/session
   */
  @Post(':code/session')
  @HttpCode(HttpStatus.CREATED)
  async createSessionFromLink(
    @Param('code') code: string,
    @Body() body: {
      amount?: number;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
      customFields?: Record<string, any>;
      locale?: string;
    },
  ): Promise<{
    success: boolean;
    data: {
      sessionToken: string;
      checkoutUrl: string;
      expiresAt: Date;
    };
  }> {
    const session = await this.paymentLinkService.createSessionFromLink(
      code,
      body.amount,
      {
        name: body.customerName,
        email: body.customerEmail,
        phone: body.customerPhone,
        customFields: body.customFields,
        locale: body.locale,
      },
    );

    return {
      success: true,
      data: {
        sessionToken: session.sessionToken,
        checkoutUrl: `https://pay.healthpay.eg/checkout/${session.sessionToken}`,
        expiresAt: session.expiresAt,
      },
    };
  }
}
