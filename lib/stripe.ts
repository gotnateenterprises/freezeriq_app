import Stripe from 'stripe';
import { SubscriptionPlan } from '@prisma/client';

if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error(
        'STRIPE_SECRET_KEY is not set. Add it to .env.local (dev) or Vercel Environment Variables (prod).'
    );
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-01-28.clover',
    typescript: true
});

/**
 * Mapping of Business Subscription Plans to their corresponding Stripe Price IDs.
 * These should be configured in your environment variables.
 */
export const PRICE_ID_MAP: Record<string, string | undefined> = {
    [SubscriptionPlan.FREE]: undefined,
    [SubscriptionPlan.BASE]: process.env.STRIPE_PRICE_BASE,
    [SubscriptionPlan.PRO]: process.env.STRIPE_PRICE_PRO,
    [SubscriptionPlan.ULTIMATE]: process.env.STRIPE_PRICE_ULTIMATE,
    [SubscriptionPlan.ENTERPRISE]: process.env.STRIPE_PRICE_ENTERPRISE,
};

/**
 * Creates or retrieves a Stripe Customer ID for a business.
 */
export async function getOrCreateStripeCustomer(
    businessId: string,
    email: string,
    name: string
): Promise<string> {
    // 1. Search existing customers by metadata
    const existing = await stripe.customers.search({
        query: `metadata['businessId']:'${businessId}'`,
    });

    if (existing.data.length > 0) {
        return existing.data[0].id;
    }

    // 2. Create new customer
    const newCustomer = await stripe.customers.create({
        email,
        name,
        metadata: {
            businessId
        }
    });

    return newCustomer.id;
}

/**
 * Creates a Stripe Checkout Session for a platform subscription.
 */
export async function createSubscriptionCheckoutSession(params: {
    customerId: string;
    priceId: string;
    businessId: string;
    successUrl: string;
    cancelUrl: string;
}) {
    return await stripe.checkout.sessions.create({
        customer: params.customerId,
        line_items: [{ price: params.priceId, quantity: 1 }],
        mode: 'subscription',
        metadata: {
            businessId: params.businessId,
            type: 'platform_subscription',
        },
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        allow_promotion_codes: true,
        billing_address_collection: 'required',
    });
}

/**
 * Returns the SubscriptionPlan enum for a given Stripe Price ID.
 */
export function getPlanFromPriceId(priceId: string): SubscriptionPlan | undefined {
    const entry = Object.entries(PRICE_ID_MAP).find(([_, id]) => id === priceId);
    return entry ? (entry[0] as SubscriptionPlan) : undefined;
}

/**
 * Generates a billing portal session for managing subscriptions.
 */
export async function createPortalSession(
    stripeCustomerId: string,
    returnUrl: string
): Promise<string> {
    const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
    });
    return session.url;
}
