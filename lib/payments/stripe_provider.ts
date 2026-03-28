/**
 * Stripe Payment Provider
 * 
 * Implements PaymentProvider interface using Stripe Connect.
 * Charges are routed to the tenant's Connected Account.
 */

import { stripe } from '@/lib/stripe';
import { prisma } from '@/lib/db';
import type { PaymentProvider, CheckoutRequest, CheckoutResult, PaymentVerification } from './types';

export class StripePaymentProvider implements PaymentProvider {

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    // Resolve Stripe Connected Account from Integration table
    const integration = await prisma.integration.findUnique({
      where: {
        business_id_provider: {
          business_id: req.businessId,
          provider: 'stripe'
        }
      }
    });

    const connectedAccountId = integration?.access_token;
    if (!connectedAccountId) {
      throw new Error('Stripe onboarding incomplete for this business.');
    }

    // Verify charges are enabled (skip in dev for sandbox accounts)
    if (process.env.NODE_ENV !== 'development') {
      const acct = await stripe.accounts.retrieve(connectedAccountId);
      if (!acct.charges_enabled) {
        throw new Error('Stripe onboarding incomplete for this business.');
      }
    }

    // Build Stripe line items
    const lineItems = req.lineItems.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: item.image ? [item.image] : [],
        },
        unit_amount: item.unitAmountCents,
      },
      quantity: item.quantity,
    }));

    // Platform fee (future - currently 0)
    const platformFeePercent = 0;
    let applicationFeeAmountCents = 0;
    if (platformFeePercent > 0) {
      applicationFeeAmountCents = Math.round(req.totalAmountCents * (platformFeePercent / 100));
    }

    const sessionParams: any = {
      payment_method_types: ['card', 'us_bank_account'],
      allow_promotion_codes: true,
      line_items: lineItems,
      mode: 'payment',
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      customer_email: req.customerEmail,
      metadata: req.metadata,
    };

    if (applicationFeeAmountCents > 0) {
      sessionParams.payment_intent_data = {
        application_fee_amount: applicationFeeAmountCents,
      };
    }

    const session = await stripe.checkout.sessions.create(
      sessionParams,
      { stripeAccount: connectedAccountId }
    );

    return {
      type: 'redirect',
      redirectUrl: session.url!,
    };
  }

  async verifyPayment(sessionId: string, businessId: string): Promise<PaymentVerification> {
    // Resolve connected account
    const integration = await prisma.integration.findUnique({
      where: {
        business_id_provider: {
          business_id: businessId,
          provider: 'stripe'
        }
      }
    });
    const connectedAccountId = integration?.access_token;

    const session = await stripe.checkout.sessions.retrieve(
      sessionId,
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined
    );

    if (!session || session.payment_status !== 'paid') {
      return { paid: false };
    }

    let platformFeeAmountCents = 0;
    if (session.payment_intent && connectedAccountId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(
          session.payment_intent as string,
          { stripeAccount: connectedAccountId }
        );
        if (pi.application_fee_amount) {
          platformFeeAmountCents = pi.application_fee_amount;
        }
      } catch (e) {
        console.error('Error fetching Stripe PI for fee:', e);
      }
    }

    return {
      paid: true,
      providerPaymentId: session.payment_intent as string,
      platformFeeAmountCents,
    };
  }
}
