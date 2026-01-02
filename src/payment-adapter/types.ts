/**
 * HealthPay Payment Adapter Types
 * TypeScript definitions for Hyperswitch integration
 */

// ==================== Enums ====================

export enum PaymentStatus {
  PENDING = 'pending',
  REQUIRES_ACTION = 'requires_action',
  PROCESSING = 'processing',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
  PARTIALLY_CAPTURED = 'partially_captured',
}

export enum RefundStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

export enum PaymentMethodType {
  CREDIT = 'credit',
  DEBIT = 'debit',
}

export enum CardNetwork {
  VISA = 'Visa',
  MASTERCARD = 'Mastercard',
  AMEX = 'AmericanExpress',
  MEEZA = 'Meeza',
}

// ==================== Request Types ====================

export interface CreatePaymentRequest {
  /** Amount in minor units (e.g., 10000 = 100.00 EGP) */
  amount: number;
  
  /** ISO 4217 currency code (default: EGP) */
  currency?: string;
  
  /** HealthPay internal reference ID */
  referenceId: string;
  
  /** Customer ID in HealthPay */
  customerId?: string;
  
  /** Customer email */
  email?: string;
  
  /** Customer full name */
  customerName?: string;
  
  /** Customer phone (with country code) */
  phone?: string;
  
  /** Payment description */
  description?: string;
  
  /** Return URL after payment completion */
  returnUrl?: string;
  
  /** Capture method: 'automatic' or 'manual' */
  captureMethod?: 'automatic' | 'manual';
  
  /** Require 3D Secure authentication */
  require3DS?: boolean;
  
  /** Billing address */
  billingAddress?: Address;
  
  /** Shipping address */
  shippingAddress?: Address;
  
  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface Address {
  firstName?: string;
  lastName?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode?: string;
  country: string;
}

export interface PaymentMethod {
  type?: PaymentMethodType;
  
  /** Card details (for direct card input) */
  card?: CardDetails;
  
  /** Payment token (for saved cards) */
  token?: string;
  
  /** Wallet type for mobile wallets */
  walletType?: 'apple_pay' | 'google_pay';
  
  /** Wallet token data */
  walletData?: any;
}

export interface CardDetails {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  holderName: string;
  cvc: string;
}

export interface CaptureRequest {
  paymentId: string;
  amount?: number;
}

export interface RefundRequest {
  paymentId: string;
  amount?: number;
  reason?: string;
  referenceId?: string;
  metadata?: Record<string, any>;
}

// ==================== Response Types ====================

export interface PaymentResponse {
  /** Hyperswitch payment ID */
  paymentId: string;
  
  /** Same as paymentId (for clarity) */
  hyperswitchPaymentId: string;
  
  /** Current payment status */
  status: PaymentStatus;
  
  /** Payment amount in minor units */
  amount: number;
  
  /** Currency code */
  currency: string;
  
  /** Client secret for frontend confirmation */
  clientSecret?: string;
  
  /** Connector used (e.g., 'checkout' for MPGS) */
  connector?: string;
  
  /** Transaction ID from the connector */
  connectorTransactionId?: string;
  
  /** Payment method type used */
  paymentMethod?: string;
  
  /** Error code if failed */
  errorCode?: string;
  
  /** Error message if failed */
  errorMessage?: string;
  
  /** Metadata attached to payment */
  metadata?: Record<string, any>;
  
  /** Creation timestamp */
  createdAt: Date;
  
  /** Last update timestamp */
  updatedAt: Date;
  
  /** Next action required (for 3DS) */
  nextAction?: {
    type: string;
    redirect_to_url?: string;
  };
  
  /** 3DS redirect URL if applicable */
  authenticationUrl?: string;
}

export interface RefundResponse {
  refundId: string;
  paymentId: string;
  status: RefundStatus | string;
  amount: number;
  currency: string;
  reason?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

// ==================== Webhook Types ====================

export interface WebhookEvent {
  event_type: WebhookEventType;
  data: any;
  timestamp: string;
}

export type WebhookEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_processing'
  | 'payment_cancelled'
  | 'refund_succeeded'
  | 'refund_failed'
  | 'dispute_opened'
  | 'dispute_accepted'
  | 'dispute_expired'
  | 'dispute_won'
  | 'dispute_lost';

// ==================== HealthPay Specific Types ====================

/**
 * Prescription payment request
 */
export interface PrescriptionPaymentRequest extends CreatePaymentRequest {
  prescriptionId: string;
  pharmacyId: string;
  patientId: string;
  items: PrescriptionItem[];
}

export interface PrescriptionItem {
  medicineId: string;
  medicineName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

/**
 * Healthcare claim payment
 */
export interface ClaimPaymentRequest extends CreatePaymentRequest {
  claimId: string;
  insurerId: string;
  providerId: string;
  patientId: string;
  serviceType: string;
}

/**
 * Wallet top-up request
 */
export interface WalletTopUpRequest extends CreatePaymentRequest {
  walletId: string;
  userId: string;
}

// ==================== Configuration Types ====================

export interface HyperswitchConfig {
  baseUrl: string;
  apiKey: string;
  merchantId: string;
  webhookSecret?: string;
  timeout?: number;
  retryAttempts?: number;
}

export interface ConnectorConfig {
  name: string;
  merchantConnectorId: string;
  enabled: boolean;
  testMode: boolean;
  priority: number;
  supportedMethods: PaymentMethodType[];
  supportedNetworks: CardNetwork[];
}
