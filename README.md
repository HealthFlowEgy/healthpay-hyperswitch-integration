# HealthPay Hyperswitch Integration

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![NestJS](https://img.shields.io/badge/NestJS-10.x-red.svg)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

## Overview

This module provides the Payment Adapter Service for integrating HealthPay with the EPOP Hyperswitch payment orchestration platform.

## 🏦 Live Payment Gateway Configuration

| Property | Value |
|----------|-------|
| **Gateway** | Mastercard Payment Gateway Services (MPGS) |
| **Acquirer** | Banque Misr |
| **Merchant ID** | `HEALTHPAY_PF` |
| **Merchant Name** | HEALTHPAY_PF |
| **Currency** | EGP (Egyptian Pound) |
| **Integration Mode** | Hosted Payment Form |
| **Status** | ✅ **LIVE** |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     HealthPay Application                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  hp-fence   │  │  hp-gate    │  │       hp-core           │ │
│  │  (GraphQL)  │  │  (Auth)     │  │  ┌───────────────────┐  │ │
│  └──────┬──────┘  └─────────────┘  │  │ PaymentAdapter    │  │ │
│         │                          │  │    Service        │  │ │
│         │                          │  └─────────┬─────────┘  │ │
│         └──────────────────────────┴────────────┼────────────┘ │
└─────────────────────────────────────────────────┼──────────────┘
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Hyperswitch (EPOP)                            │
│                   http://178.128.196.71:8080                     │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐    │
│  │   MPGS    │  │   Fawry   │  │   Meeza   │  │ InstaPay  │    │
│  │ (Banque   │  │           │  │           │  │           │    │
│  │   Misr)   │  │           │  │           │  │           │    │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

1. Copy the `payment-adapter` folder to your HealthPay monorepo:

```bash
cp -r payment-adapter /path/to/healthpay/libs/shared/src/
```

2. Add to your module imports:

```typescript
// app.module.ts
import { PaymentAdapterModule } from '@shared/payment-adapter';

@Module({
  imports: [PaymentAdapterModule],
})
export class AppModule {}
```

3. Configure environment variables:

```bash
# .env
HYPERSWITCH_BASE_URL=http://178.128.196.71:8080
HYPERSWITCH_API_KEY=snd_Rh9hqv8uUmlwYeEtGcJgmlFuM1P2Cw4ueySA9fI3n9TQrBDvAq0gaqZ5vf3bGDVO
HYPERSWITCH_PUBLISHABLE_KEY=pk_snd_e4f81070ebf44edc8d0e6a3bb72deebd
HYPERSWITCH_WEBHOOK_SECRET=your_webhook_secret
```

## Usage

### Creating a Payment

```typescript
import { PaymentAdapterService } from '@shared/payment-adapter';

@Injectable()
export class PrescriptionPaymentService {
  constructor(private readonly paymentAdapter: PaymentAdapterService) {}

  async createPrescriptionPayment(prescription: Prescription) {
    const payment = await this.paymentAdapter.createPayment({
      amount: prescription.totalAmount * 100, // Convert to minor units
      currency: 'EGP',
      referenceId: prescription.id,
      customerId: prescription.patientId,
      email: prescription.patientEmail,
      customerName: prescription.patientName,
      description: `Payment for prescription ${prescription.id}`,
      metadata: {
        prescription_id: prescription.id,
        pharmacy_id: prescription.pharmacyId,
        patient_id: prescription.patientId,
      },
    });

    return payment;
  }
}
```

### Confirming with Card Details

```typescript
async confirmPayment(paymentId: string, cardDetails: CardInput) {
  return this.paymentAdapter.confirmPayment(paymentId, {
    type: 'credit',
    card: {
      number: cardDetails.number,
      expiryMonth: cardDetails.expiryMonth,
      expiryYear: cardDetails.expiryYear,
      holderName: cardDetails.holderName,
      cvc: cardDetails.cvc,
    },
  });
}
```

### Processing Refunds

```typescript
async refundPayment(paymentId: string, amount?: number) {
  return this.paymentAdapter.refundPayment({
    paymentId,
    amount, // Optional: partial refund amount in minor units
    reason: 'customer_request',
  });
}
```

## GraphQL Integration

Add these to your GraphQL schema:

```graphql
# schema.graphql

type Payment {
  id: ID!
  hyperswitchPaymentId: String!
  status: PaymentStatus!
  amount: Float!
  currency: String!
  clientSecret: String
  connector: String
  connectorTransactionId: String
  createdAt: DateTime!
  updatedAt: DateTime!
}

enum PaymentStatus {
  PENDING
  REQUIRES_ACTION
  PROCESSING
  AUTHORIZED
  CAPTURED
  FAILED
  CANCELLED
  REFUNDED
}

input CreatePaymentInput {
  amount: Float!
  currency: String
  referenceId: String!
  customerId: String
  email: String
  customerName: String
  description: String
  returnUrl: String
}

input ConfirmPaymentInput {
  paymentId: String!
  cardNumber: String!
  expiryMonth: String!
  expiryYear: String!
  holderName: String!
  cvc: String!
}

type Mutation {
  createPayment(input: CreatePaymentInput!): Payment!
  confirmPayment(input: ConfirmPaymentInput!): Payment!
  capturePayment(paymentId: String!, amount: Float): Payment!
  voidPayment(paymentId: String!): Payment!
  refundPayment(paymentId: String!, amount: Float, reason: String): Refund!
}

type Query {
  payment(id: String!): Payment
  payments(customerId: String, status: PaymentStatus, limit: Int, offset: Int): [Payment!]!
}
```

## Webhook Configuration

1. Configure the webhook URL in Hyperswitch Control Center:
   - URL: `https://api.healthpay.eg/webhooks/hyperswitch`
   - Events: All payment events

2. The webhook controller handles:
   - `payment_succeeded`
   - `payment_failed`
   - `payment_processing`
   - `refund_succeeded`
   - `refund_failed`

## Test Cards

| Card Number | Scenario |
|-------------|----------|
| 5123450000000008 | Successful transaction |
| 5123450000000016 | Declined transaction |
| 5123450000000024 | 3DS authentication required |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /payments | Create payment |
| POST | /payments/:id/confirm | Confirm with payment method |
| POST | /payments/:id/capture | Capture authorized payment |
| POST | /payments/:id/void | Void/cancel payment |
| GET | /payments/:id | Get payment details |
| GET | /payments | List payments |
| POST | /refunds | Create refund |
| POST | /webhooks/hyperswitch | Webhook endpoint |

## Error Handling

The service throws `HttpException` with structured error responses:

```typescript
{
  message: "Payment processing failed",
  code: "PAYMENT_ERROR",
  details: {
    // Hyperswitch error details
  }
}
```

## Security Considerations

1. **PCI Compliance**: Card data is sent directly to Hyperswitch, not stored in HealthPay
2. **Webhook Verification**: HMAC-SHA256 signature verification
3. **API Key Security**: Store API keys in environment variables or secrets manager
4. **3DS Authentication**: Enable for production to reduce fraud

## Support

- Hyperswitch Docs: https://docs.hyperswitch.io
- MPGS Docs: https://banquemisr.gateway.mastercard.com/api/documentation/
- HealthPay Team: dev@healthpay.eg

---

## 🇪🇬 Egypt Local Payment Methods

In addition to international card payments via MPGS, this integration includes connectors for Egypt's local payment ecosystem:

| Method | Provider | Type | Use Case |
|--------|----------|------|----------|
| **Fawry** | FawryPay | Cash/Reference | 194,000+ retail outlets |
| **OPay Wallet** | OPay Egypt | E-Wallet/QR | Mobile wallet payments |
| **Meeza Card** | EBC/UPG | Debit Card | Egypt national card (35M+ users) |
| **Meeza QR** | EBC/UPG | QR Code | In-store mobile payments |
| **InstaPay** | EBC/IPN | Bank Transfer | Real-time P2P/P2M transfers |

### Quick Example

```typescript
import { EgyptPaymentService } from './egypt-connectors';

// Create a Fawry reference code payment
const payment = await egyptPayments.createPayment({
  orderId: 'ORDER-123',
  amount: 150.00,
  paymentMethod: 'FAWRY',
  customer: {
    name: 'أحمد محمد',
    mobile: '01012345678',
  },
  callbackUrl: 'https://api.healthpay.eg/webhooks/egypt/fawry',
});

// Customer receives reference number to pay at any Fawry outlet
```

📖 **Full Documentation**: [docs/EGYPT_CONNECTORS.md](docs/EGYPT_CONNECTORS.md)

---
## 📊 Server Status

| Service | URL | Status |
|---------|-----|--------|
| **Hyperswitch API** | http://178.128.196.71:8080 | ✅ Operational |
| **Control Center** | http://178.128.196.71:9000 | ✅ Running |
| **PayFac Backend** | http://178.128.196.71:3002 | ✅ Running |
| **Egypt Connectors** | http://178.128.196.71:3001 | ✅ Running |
| **Grafana** | http://178.128.196.71:3000 | ✅ Running |

---

## 💼 PayFac Services

The PayFac backend (`src/payfac/`) provides:

- **Settlement Engine** - Daily automated settlement calculation
- **Payout Service** - InstaPay, Bank Transfer, Wallet payouts
- **Payment Links** - Zero-integration payment collection with SMS
- **Sub-Merchant Onboarding** - Complete KYC workflow
- **SMS Notifications** - Cequens integration for payment link delivery

### Payment Links with SMS

```typescript
import { PaymentLinkService } from './payfac/payment-links/payment-link.service';

const link = await paymentLinkService.createPaymentLink({
  amount: 50000, // 500.00 EGP
  title: 'Lab Test Payment',
  customerPhone: '+201234567890',
  sendSms: true,
  merchantName: 'HealthPay Clinic',
});
// SMS sent automatically via Cequens
```

---

## 🌐 GitHub Repositories

| Repository | Description |
|------------|-------------|
| [epop-devops](https://github.com/HealthFlowEgy/epop-devops) | Infrastructure & DevOps |
| [healthpay-hyperswitch-integration](https://github.com/HealthFlowEgy/healthpay-hyperswitch-integration) | Payment Integration |
| [epop-checkout](https://github.com/HealthFlowEgy/epop-checkout) | Hosted Checkout (Next.js) |

**Last Updated**: January 2, 2026
