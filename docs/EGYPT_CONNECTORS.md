# Egypt Payment Connectors

Comprehensive payment connector implementations for Egypt's local payment ecosystem, integrated with HealthPay and the EPOP Hyperswitch platform.

## Supported Payment Methods

| Method | Provider | Type | Coverage | Use Case |
|--------|----------|------|----------|----------|
| **Fawry** | FawryPay | Cash/Reference | 194,000+ outlets | Cash payments at retail |
| **OPay Wallet** | OPay Egypt | E-Wallet/QR | 10M+ users | Mobile wallet payments |
| **OPay Cashier** | OPay Egypt | Hosted Checkout | Multi-method | Unified checkout page |
| **Meeza Card** | EBC/UPG | Debit Card | 35M+ cards | Egypt national card |
| **Meeza QR** | EBC/UPG | QR Code | Mobile apps | In-store payments |
| **InstaPay** | EBC/IPN | Bank Transfer | All banks | Real-time transfers |
| **Cards** | UPG | Credit/Debit | International | Visa, Mastercard |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        HealthPay Application                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                    EgyptPaymentService                             │ │
│  │  (Unified interface for all Egypt payment methods)                 │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│           │                    │                    │                    │
│           ▼                    ▼                    ▼                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │    Fawry     │    │    OPay      │    │     UPG      │              │
│  │  Connector   │    │  Connector   │    │  Connector   │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│           │                    │                    │                    │
└───────────┼────────────────────┼────────────────────┼────────────────────┘
            ▼                    ▼                    ▼
     ┌────────────┐       ┌────────────┐       ┌────────────┐
     │   Fawry    │       │   OPay     │       │    EBC     │
     │    API     │       │    API     │       │  UPG API   │
     └────────────┘       └────────────┘       └────────────┘
```

## Integration with Hyperswitch

The Egypt connectors work alongside Hyperswitch for a complete payment solution:

| Payment Type | Handler |
|--------------|---------|
| International Cards (Visa/MC) | Hyperswitch → MPGS |
| Egypt Local Cards (Meeza) | Egypt Connectors → UPG |
| Cash Payments (Fawry) | Egypt Connectors → Fawry |
| Mobile Wallets (OPay) | Egypt Connectors → OPay |
| Bank Transfers (InstaPay) | Egypt Connectors → UPG |

## Installation

### 1. The connectors are already included in this repository

```
src/egypt-connectors/
├── connectors/
│   ├── fawry.connector.ts    # Fawry reference code payments
│   ├── opay.connector.ts     # OPay wallet/QR payments
│   └── upg.connector.ts      # Meeza/InstaPay/Cards
├── egypt-payment.service.ts  # Unified payment service
├── egypt-payment.controller.ts
├── egypt-webhook.controller.ts
├── egypt-payment.module.ts
└── index.ts
```

### 2. Import the module in your NestJS application

```typescript
// app.module.ts
import { EgyptPaymentModule } from './egypt-connectors';

@Module({
  imports: [
    EgyptPaymentModule,
    // ... other modules
  ],
})
export class AppModule {}
```

### 3. Configure environment variables

Add the following to your `.env` file:

```bash
# Fawry
FAWRY_PRODUCTION=false
FAWRY_MERCHANT_CODE=your_code
FAWRY_SECURITY_KEY=your_key

# OPay
OPAY_PRODUCTION=false
OPAY_MERCHANT_ID=your_id
OPAY_PUBLIC_KEY=your_public_key
OPAY_PRIVATE_KEY=your_private_key

# UPG (Meeza/InstaPay)
UPG_PRODUCTION=false
UPG_MERCHANT_ID=your_id
UPG_TERMINAL_ID=your_terminal
UPG_SECRET_KEY=your_key
UPG_ACQUIRING_BANK=NBE
```

## Usage Examples

### Unified Payment Service

```typescript
import { EgyptPaymentService } from './egypt-connectors';

@Injectable()
export class PaymentService {
  constructor(private readonly egyptPayments: EgyptPaymentService) {}

  async processPayment(order: Order, method: string) {
    return this.egyptPayments.createPayment({
      orderId: order.id,
      amount: order.total,
      currency: 'EGP',
      description: `Order ${order.id}`,
      customer: {
        name: order.customerName,
        mobile: order.customerPhone,
        email: order.customerEmail,
      },
      paymentMethod: method, // FAWRY, OPAY_WALLET, MEEZA_CARD, etc.
      callbackUrl: 'https://api.healthpay.eg/webhooks/egypt/payments',
      returnUrl: 'https://healthpay.eg/payment/complete',
    });
  }
}
```

### Fawry Reference Code Payment

```typescript
// Customer pays at any Fawry outlet with the reference number
const payment = await egyptPayments.createPayment({
  orderId: 'ORDER-123',
  amount: 150.00,
  paymentMethod: 'FAWRY',
  customer: {
    name: 'أحمد محمد',
    mobile: '01012345678',
  },
  callbackUrl: 'https://api.healthpay.eg/webhooks/egypt/fawry',
  fawryItems: [{
    itemId: 'MEDICINE-001',
    description: 'Prescription Medication',
    price: 150.00,
    quantity: 1,
  }],
});

// Response:
// {
//   referenceNumber: "123456789",
//   expiresAt: "2026-01-03T12:00:00Z",
//   instructions: ["ادفع في أي منفذ فوري باستخدام الرقم المرجعي"]
// }
```

### OPay Wallet Payment

```typescript
// QR code + push notification to customer's OPay app
const payment = await egyptPayments.createPayment({
  orderId: 'ORDER-124',
  amount: 200.00,
  paymentMethod: 'OPAY_WALLET',
  customer: {
    name: 'سارة أحمد',
    mobile: '01112345678',
  },
  callbackUrl: 'https://api.healthpay.eg/webhooks/egypt/opay',
});

// Response:
// {
//   qrCodeUrl: "https://opay.com/qr/...",
//   transactionId: "OP123456789"
// }
```

### Meeza Card Payment

```typescript
// Egypt's national debit card (35M+ cards issued)
const payment = await egyptPayments.createPayment({
  orderId: 'ORDER-125',
  amount: 500.00,
  paymentMethod: 'MEEZA_CARD',
  customer: {
    name: 'محمد علي',
    mobile: '01234567890',
    nationalId: '12345678901234',
  },
  returnUrl: 'https://healthpay.eg/payment/return',
  callbackUrl: 'https://api.healthpay.eg/webhooks/egypt/upg',
});

// Response:
// {
//   paymentUrl: "https://upg.egyptianbanks.com/pay/...",
//   transactionId: "UPG123456789"
// }
```

### InstaPay (Real-time Bank Transfer)

```typescript
// Request to Pay - sends notification to customer's banking app
const payment = await egyptPayments.createPayment({
  orderId: 'ORDER-126',
  amount: 1000.00,
  paymentMethod: 'INSTAPAY',
  customer: {
    name: 'فاطمة حسن',
    mobile: '01098765432',
  },
  ipaAddress: 'fatma.hassan@instapay', // Customer's IPA address
  callbackUrl: 'https://api.healthpay.eg/webhooks/egypt/instapay',
});

// Customer receives R2P notification in their banking app
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/egypt-payments/methods` | List available payment methods |
| POST | `/egypt-payments` | Create payment (any method) |
| POST | `/egypt-payments/fawry` | Create Fawry payment |
| POST | `/egypt-payments/opay/wallet` | Create OPay wallet payment |
| POST | `/egypt-payments/opay/cashier` | Create OPay cashier payment |
| POST | `/egypt-payments/meeza/card` | Create Meeza card payment |
| POST | `/egypt-payments/meeza/qr` | Create Meeza QR payment |
| POST | `/egypt-payments/instapay` | Create InstaPay payment |
| GET | `/egypt-payments/:id/status` | Get payment status |
| POST | `/egypt-payments/:id/refund` | Refund payment |

## Webhook Endpoints

Configure these URLs in each provider's dashboard:

| Provider | Webhook URL |
|----------|-------------|
| Fawry | `https://api.healthpay.eg/webhooks/egypt/fawry` |
| OPay | `https://api.healthpay.eg/webhooks/egypt/opay` |
| UPG/Meeza | `https://api.healthpay.eg/webhooks/egypt/upg` |
| InstaPay | `https://api.healthpay.eg/webhooks/egypt/instapay` |

## Payment Flow Diagrams

### Fawry Reference Code Flow

```
Customer          HealthPay           Fawry API         Fawry Outlet
    │                  │                   │                  │
    │─── Request ─────>│                   │                  │
    │                  │─── Create ───────>│                  │
    │                  │<── Reference ─────│                  │
    │<── Show Ref ─────│                   │                  │
    │                  │                   │                  │
    │─────────────────────────────────────────── Pay ────────>│
    │                  │                   │<── Notify ───────│
    │                  │<── Webhook ───────│                  │
    │<── Confirm ──────│                   │                  │
```

### OPay Wallet Flow

```
Customer          HealthPay           OPay API          OPay App
    │                  │                   │                │
    │─── Request ─────>│                   │                │
    │                  │─── Create ───────>│                │
    │                  │<── QR + Order ────│                │
    │<── Show QR ──────│                   │                │
    │                  │                   │─── R2P ───────>│
    │                  │                   │                │
    │──────────────────────────────────────────── Approve ──>│
    │                  │<── Webhook ───────│<── Confirm ────│
    │<── Success ──────│                   │                │
```

### InstaPay R2P Flow

```
Customer          HealthPay           UPG/IPN           Bank App
    │                  │                   │                │
    │─── Request ─────>│                   │                │
    │                  │─── R2P ──────────>│                │
    │                  │<── Pending ───────│                │
    │                  │                   │─── Push ──────>│
    │                  │                   │                │
    │──────────────────────────────────────────── Approve ──>│
    │                  │<── Webhook ───────│<── Confirm ────│
    │<── Success ──────│                   │                │
```

## Provider Credentials

### Fawry
- **Sandbox Portal**: https://developer.fawrystaging.com/
- **Production Portal**: https://developer.fawry.com/
- **Contact**: merchant.support@fawry.com

### OPay
- **Merchant Portal**: https://merchant.opaycheckout.com/
- **API Documentation**: https://doc.opaycheckout.com/
- **Contact**: merchant.eg@opay-inc.com

### UPG (Meeza/InstaPay)
- **Portal**: https://upgportal.egyptianbanks.com/
- **Contact**: Your acquiring bank (NBE, CIB, Banque Misr)

## Error Handling

All connectors throw `HttpException` with structured error responses:

```typescript
{
  statusCode: 400,
  message: "Payment creation failed",
  error: {
    code: "FAWRY_9901",
    details: "Invalid merchant credentials"
  }
}
```

### Common Error Codes

| Provider | Code | Description |
|----------|------|-------------|
| Fawry | 9901 | Invalid merchant credentials |
| Fawry | 9942 | Duplicate reference number |
| OPay | 20000 | Duplicate order reference |
| OPay | 20001 | Invalid signature |
| UPG | 51 | Insufficient funds |
| UPG | 54 | Expired card |

## Best Practices

1. **Always verify webhooks** - Use signature verification for all providers
2. **Handle expiration** - Fawry references expire (24h default), OPay QR codes expire (30min default)
3. **Idempotency** - Use unique order IDs to prevent duplicate payments
4. **Retry logic** - Implement exponential backoff for network failures
5. **Logging** - Log all payment events for reconciliation
6. **Arabic support** - Display Arabic instructions for Egyptian customers

## Testing

### Fawry Sandbox
- Use staging URL: `https://atfawry.fawrystaging.com`
- Test reference numbers are generated but won't process real payments

### OPay Sandbox
- Use sandbox URL: `https://sandboxapi.opaycheckout.com`
- Test with OPay sandbox app

### UPG Sandbox
- Contact your acquiring bank for sandbox credentials
- Test cards provided by the bank

## Support

- **Fawry**: developer.fawrystaging.com
- **OPay**: doc.opaycheckout.com
- **UPG/Meeza**: egyptianbanks.com
- **HealthPay**: support@healthpay.eg
