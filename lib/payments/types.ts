/**
 * Payment Provider Abstraction Layer
 * 
 * Defines the interface between FreezerIQ's checkout flow and
 * payment processors (Stripe Connect, Square).
 * 
 * Per Constitution §9: Tenant storefront billing uses tenant-owned
 * payment credentials. Never mix with platform SaaS billing.
 */

export type PaymentProviderType = 'stripe' | 'square';

export interface CheckoutLineItem {
  name: string;
  unitAmountCents: number;
  quantity: number;
  image?: string;
}

export interface CheckoutRequest {
  businessId: string;
  slug: string;
  orderId: string;
  lineItems: CheckoutLineItem[];
  totalAmountCents: number;
  customerEmail?: string;
  customerName?: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

/**
 * Stripe → redirect to hosted Checkout
 * Square → return config for embedded Web Payments SDK form
 */
export interface CheckoutResult {
  type: 'redirect' | 'embedded';
  /** Stripe: hosted checkout URL */
  redirectUrl?: string;
  /** Square: config for Web Payments SDK */
  squareConfig?: {
    appId: string;
    locationId: string;
  };
}

export interface PaymentVerification {
  paid: boolean;
  providerPaymentId?: string;
  platformFeeAmountCents?: number;
}

export interface PaymentProvider {
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  verifyPayment(paymentRefId: string, businessId: string): Promise<PaymentVerification>;
}
