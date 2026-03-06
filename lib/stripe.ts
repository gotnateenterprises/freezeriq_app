
import Stripe from 'stripe';

// Use a placeholder during build if STRIPE_SECRET_KEY is not set
// At runtime, the actual key will be required for Stripe operations to work
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_build', {
    apiVersion: '2026-01-28.clover', // Use latest stable API version (updated to match SDK requirements)
    typescript: true
});

/**
 * Creates or retrieves a Stripe Customer ID for a business.
 */
export async function getOrCreateStripeCustomer(
    businessId: string,
    email: string,
    name: string
): Promise<string> {
    // Note: Ideally, you'd store stripe_customer_id in DB and check before creating.
    // This function assumes the caller handles the DB check/update.

    // 1. Search existing customers by email/metadata
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
