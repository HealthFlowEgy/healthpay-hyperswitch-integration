# Webhook Configuration Guide

This document describes how to configure and handle webhooks from Hyperswitch for payment status updates.

## Webhook Configuration

Webhooks have been configured on the Hyperswitch server with the following settings:

| Setting | Value |
|---------|-------|
| **Webhook URL** | `https://api.healthpay.eg/webhooks/hyperswitch` |
| **Webhook Version** | 1.0.0 |
| **Username** | `healthpay_webhook` |
| **Password** | `whsec_healthpay_2026_secure` |

### Enabled Events

| Event | Enabled |
|-------|---------|
| Payment Created | ✅ Yes |
| Payment Succeeded | ✅ Yes |
| Payment Failed | ✅ Yes |

## Webhook Payload Structure

### Payment Succeeded Event

```json
{
  "event_type": "payment_succeeded",
  "event_id": "evt_xxxxxxxxxxxxx",
  "timestamp": "2026-01-02T12:00:00Z",
  "data": {
    "payment_id": "pay_xxxxxxxxxxxxx",
    "merchant_id": "healthpay_eg",
    "status": "succeeded",
    "amount": 10000,
    "currency": "EGP",
    "customer_id": "cus_xxxxxxxxxxxxx",
    "connector": "nmi",
    "connector_transaction_id": "txn_xxxxxxxxxxxxx",
    "metadata": {
      "prescription_id": "RX-12345",
      "pharmacy_id": "PH-001"
    }
  }
}
```

### Payment Failed Event

```json
{
  "event_type": "payment_failed",
  "event_id": "evt_xxxxxxxxxxxxx",
  "timestamp": "2026-01-02T12:00:00Z",
  "data": {
    "payment_id": "pay_xxxxxxxxxxxxx",
    "merchant_id": "healthpay_eg",
    "status": "failed",
    "amount": 10000,
    "currency": "EGP",
    "error_code": "card_declined",
    "error_message": "Your card was declined",
    "metadata": {
      "prescription_id": "RX-12345"
    }
  }
}
```

## Implementing Webhook Handler

### NestJS Controller

The webhook controller is already included in the integration package at `src/payment-adapter/webhook.controller.ts`.

```typescript
import { Controller, Post, Body, Headers, HttpCode, Logger } from '@nestjs/common';
import { PaymentAdapterService } from './payment-adapter.service';

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly paymentService: PaymentAdapterService) {}

  @Post('hyperswitch')
  @HttpCode(200)
  async handleHyperswitchWebhook(
    @Body() payload: any,
    @Headers('x-webhook-signature') signature: string,
  ) {
    this.logger.log(`Received webhook: ${payload.event_type}`);

    // Verify signature (recommended for production)
    // this.verifySignature(payload, signature);

    // Process the webhook
    await this.paymentService.handleWebhook(payload);

    return { received: true };
  }
}
```

### Handling Events in Your Service

```typescript
// In your prescription service or payment handler
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class PrescriptionPaymentHandler {
  
  @OnEvent('payment.succeeded')
  async handlePaymentSuccess(payment: any) {
    const prescriptionId = payment.metadata?.prescription_id;
    
    if (prescriptionId) {
      // Update prescription status
      await this.prescriptionService.markAsPaid(prescriptionId);
      
      // Send confirmation to patient
      await this.notificationService.sendPaymentConfirmation({
        prescriptionId,
        amount: payment.amount / 100, // Convert from piasters
        transactionId: payment.connector_transaction_id,
      });
    }
  }

  @OnEvent('payment.failed')
  async handlePaymentFailure(payment: any) {
    const prescriptionId = payment.metadata?.prescription_id;
    
    if (prescriptionId) {
      // Log failure
      await this.paymentLogService.logFailure({
        prescriptionId,
        errorCode: payment.error_code,
        errorMessage: payment.error_message,
      });
      
      // Notify patient
      await this.notificationService.sendPaymentFailedNotification({
        prescriptionId,
        reason: payment.error_message,
      });
    }
  }
}
```

## Webhook Security

### Signature Verification

Hyperswitch signs webhooks using HMAC-SHA256. Verify the signature to ensure authenticity:

```typescript
import * as crypto from 'crypto';

function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
}
```

### IP Whitelisting

For additional security, whitelist the Hyperswitch server IP:

```
178.128.196.71
```

## Testing Webhooks

### Using cURL

```bash
# Simulate a payment_succeeded webhook
curl -X POST https://api.healthpay.eg/webhooks/hyperswitch \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: test_signature" \
  -d '{
    "event_type": "payment_succeeded",
    "event_id": "evt_test_001",
    "timestamp": "2026-01-02T12:00:00Z",
    "data": {
      "payment_id": "pay_test_001",
      "merchant_id": "healthpay_eg",
      "status": "succeeded",
      "amount": 10000,
      "currency": "EGP",
      "metadata": {
        "prescription_id": "RX-TEST-001"
      }
    }
  }'
```

### Local Testing with ngrok

For local development, use ngrok to expose your local webhook endpoint:

```bash
# Install ngrok
npm install -g ngrok

# Expose local port
ngrok http 3000

# Update webhook URL in Hyperswitch to ngrok URL
# https://xxxx.ngrok.io/webhooks/hyperswitch
```

## Updating Webhook Configuration

To update webhook settings via API:

```bash
curl -X POST "http://178.128.196.71:8080/account/healthpay_eg/business_profile/pro_CILRiv5jY26Nri0wrChk" \
  -H "Content-Type: application/json" \
  -H "api-key: snd_Rh9hqv8uUmlwYeEtGcJgmlFuM1P2Cw4ueySA9fI3n9TQrBDvAq0gaqZ5vf3bGDVO" \
  -d '{
    "webhook_details": {
      "webhook_url": "https://your-new-url.com/webhooks/hyperswitch",
      "webhook_version": "1.0.0",
      "webhook_username": "healthpay_webhook",
      "webhook_password": "your_new_password",
      "payment_created_enabled": true,
      "payment_succeeded_enabled": true,
      "payment_failed_enabled": true
    }
  }'
```

## Troubleshooting

### Webhook Not Received

1. Check that the webhook URL is accessible from the internet
2. Verify SSL certificate is valid (for HTTPS endpoints)
3. Check firewall rules allow incoming connections
4. Review Hyperswitch logs for delivery errors

### Signature Verification Failed

1. Ensure you're using the correct webhook secret
2. Verify the payload hasn't been modified
3. Check that you're using the raw request body for verification

### Duplicate Events

Implement idempotency by storing processed event IDs:

```typescript
async handleWebhook(event: WebhookEvent) {
  // Check if already processed
  const exists = await this.webhookLogRepo.findOne({ eventId: event.event_id });
  if (exists) {
    this.logger.warn(`Duplicate webhook: ${event.event_id}`);
    return;
  }
  
  // Process and log
  await this.processEvent(event);
  await this.webhookLogRepo.save({ eventId: event.event_id, processedAt: new Date() });
}
```

## Support

- **Hyperswitch Docs**: https://docs.hyperswitch.io/webhooks
- **Control Center**: http://178.128.196.71:9000
