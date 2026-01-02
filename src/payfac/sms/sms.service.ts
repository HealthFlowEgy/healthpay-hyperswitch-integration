import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SendSmsDto {
  to: string;
  message: string;
  messageType?: 'text' | 'unicode';
}

export interface SendPaymentLinkSmsDto {
  to: string;
  paymentLink: string;
  amount: number;
  merchantName: string;
  description?: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly apiUrl = 'https://apis.cequens.com/sms/v1/messages';
  private readonly senderId: string;
  private readonly apiToken: string;
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    this.senderId = this.configService.get('CEQUENS_SENDER_ID', 'HealthPay');
    this.apiToken = this.configService.get('CEQUENS_API_TOKEN');
    this.apiKey = this.configService.get('CEQUENS_API_KEY');
  }

  /**
   * Send a generic SMS message
   */
  async sendSms(dto: SendSmsDto): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const phoneNumber = this.formatPhoneNumber(dto.to);
      
      const response = await axios.post(
        this.apiUrl,
        {
          senderName: this.senderId,
          messageType: dto.messageType || 'text',
          messageText: dto.message,
          recipients: phoneNumber,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        }
      );

      this.logger.log(`SMS sent successfully to ${phoneNumber}`);
      
      return {
        success: true,
        messageId: response.data?.messageId || response.data?.data?.messageId,
      };
    } catch (error) {
      this.logger.error(`Failed to send SMS to ${dto.to}: ${error.message}`);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  /**
   * Send a payment link via SMS
   */
  async sendPaymentLinkSms(dto: SendPaymentLinkSmsDto): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const message = this.buildPaymentLinkMessage(dto);
    
    return this.sendSms({
      to: dto.to,
      message,
      messageType: 'unicode', // Support Arabic
    });
  }

  /**
   * Send payment link in Arabic
   */
  async sendPaymentLinkSmsArabic(dto: SendPaymentLinkSmsDto): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const message = this.buildPaymentLinkMessageArabic(dto);
    
    return this.sendSms({
      to: dto.to,
      message,
      messageType: 'unicode',
    });
  }

  /**
   * Build English payment link message
   */
  private buildPaymentLinkMessage(dto: SendPaymentLinkSmsDto): string {
    const { paymentLink, amount, merchantName, description } = dto;
    
    let message = `HealthPay: ${merchantName} has requested a payment of EGP ${amount.toFixed(2)}`;
    
    if (description) {
      message += ` for ${description}`;
    }
    
    message += `. Pay securely: ${paymentLink}`;
    
    return message;
  }

  /**
   * Build Arabic payment link message
   */
  private buildPaymentLinkMessageArabic(dto: SendPaymentLinkSmsDto): string {
    const { paymentLink, amount, merchantName, description } = dto;
    
    let message = `هيلث باي: ${merchantName} يطلب دفع مبلغ ${amount.toFixed(2)} جنيه`;
    
    if (description) {
      message += ` مقابل ${description}`;
    }
    
    message += `. ادفع بأمان: ${paymentLink}`;
    
    return message;
  }

  /**
   * Send payment confirmation SMS
   */
  async sendPaymentConfirmationSms(params: {
    to: string;
    amount: number;
    merchantName: string;
    transactionId: string;
    paymentMethod: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { to, amount, merchantName, transactionId, paymentMethod } = params;
    
    const message = `HealthPay: تم استلام دفعتك بنجاح. المبلغ: ${amount.toFixed(2)} جنيه. التاجر: ${merchantName}. رقم العملية: ${transactionId}. طريقة الدفع: ${paymentMethod}`;
    
    return this.sendSms({
      to,
      message,
      messageType: 'unicode',
    });
  }

  /**
   * Send Fawry reference code SMS
   */
  async sendFawryReferenceSms(params: {
    to: string;
    referenceNumber: string;
    amount: number;
    merchantName: string;
    expiresAt: Date;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const { to, referenceNumber, amount, merchantName, expiresAt } = params;
    
    const expiryDate = expiresAt.toLocaleDateString('ar-EG');
    
    const message = `HealthPay: كود فوري للدفع: ${referenceNumber}. المبلغ: ${amount.toFixed(2)} جنيه. التاجر: ${merchantName}. صالح حتى: ${expiryDate}. ادفع في أي فرع فوري.`;
    
    return this.sendSms({
      to,
      message,
      messageType: 'unicode',
    });
  }

  /**
   * Format phone number to international format
   */
  private formatPhoneNumber(phone: string): string {
    // Remove any non-digit characters
    let cleaned = phone.replace(/\D/g, '');
    
    // Handle Egyptian numbers
    if (cleaned.startsWith('0')) {
      cleaned = '2' + cleaned; // Add Egypt country code
    } else if (!cleaned.startsWith('2')) {
      cleaned = '2' + cleaned;
    }
    
    // Ensure it starts with country code
    if (!cleaned.startsWith('+')) {
      cleaned = '+' + cleaned;
    }
    
    return cleaned;
  }

  /**
   * Validate Egyptian phone number
   */
  isValidEgyptianPhone(phone: string): boolean {
    const cleaned = phone.replace(/\D/g, '');
    
    // Egyptian mobile numbers: 01xxxxxxxxx (11 digits) or 201xxxxxxxxx (12 digits)
    const patterns = [
      /^01[0125]\d{8}$/, // Local format
      /^201[0125]\d{8}$/, // International format without +
      /^\+201[0125]\d{8}$/, // International format with +
    ];
    
    return patterns.some(pattern => pattern.test(cleaned) || pattern.test(phone));
  }
}
