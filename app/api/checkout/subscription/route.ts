import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { getCustomerSession } from '@/lib/customerAuth';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { businessId, tierId, priceId } = body;

        // 1. Verify Tenant
        const business = await prisma.business.findUnique({
            where: { id: businessId }
        });

        if (!business) {
            return NextResponse.json({ error: 'Business not found' }, { status: 404 });
        }

        if (!business.stripe_account_id || (process.env.NODE_ENV !== 'development' && !business.charges_enabled)) {
            return NextResponse.json({ error: 'Checkout is temporarily unavailable for this kitchen.' }, { status: 400 });
        }

        // 2. Resolve Customer Session
        // If they are already logged in to the portal via Magic Link, we can pass their email/ID directly.
        const session = await getCustomerSession();
        let customerEmail = undefined;

        if (session && session.businessId === businessId) {
            customerEmail = session.email;
        }

        // 3. Verify the requested Tier
        const tier = await prisma.subscriptionTier.findUnique({
            where: { id: tierId }
        });

        if (!tier || tier.business_id !== businessId || !tier.is_active) {
            return NextResponse.json({ error: 'Invalid or inactive subscription tier.' }, { status: 400 });
        }

        // 4. Calculate Application Fee (FreezerIQ SaaS Monitization)
        // For subscriptions, Stripe Connect handles fees slightly differently via `subscription_data.application_fee_percent`
        // We will pass the exact percentage the business agreed to.
        const applicationFeePercent = business.platform_fee_percent || 2; // Default 2%

        // 5. Generate Stripe Subscription Checkout Session
        // This MUST be mode: 'subscription'
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';

        const sessionParams: any = {
            payment_method_types: ['card', 'us_bank_account'],
            line_items: [
                {
                    price: priceId, // The exact Stripe Price ID saved in our DB from the Commercial Manager
                    quantity: 1,
                }
            ],
            mode: 'subscription',
            success_url: `${appUrl}/shop/${business.slug}/login?subscription=success`,
            cancel_url: `${appUrl}/shop/${business.slug}/subscribe`,
            customer_email: customerEmail, // Prefill if logged in
            metadata: {
                businessId: business.id,
                source: 'b2c',
                tierId: tierId,
                plan: tier.name
            },
            subscription_data: {
                application_fee_percent: applicationFeePercent,
                metadata: {
                    businessId: business.id,
                    tierId: tierId,
                    meal_credits: tier.meal_credits_per_cycle
                }
            }
        };

        const stripeSession = await stripe.checkout.sessions.create(
            sessionParams,
            // @ts-ignore
            { stripeAccount: business.stripe_account_id } // The MAGIC of Stripe Connect!
        );

        return NextResponse.json({ url: stripeSession.url });

    } catch (error: any) {
        console.error('[STRIPE_SUBSCRIPTION_CHECKOUT]', error);
        return NextResponse.json({ error: error.message || 'Internal Error' }, { status: 500 });
    }
}
