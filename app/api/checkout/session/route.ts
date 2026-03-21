import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { getCustomerSession } from '@/lib/customerAuth';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { businessId, items, deliveryDate, orderTotal, customerNotes, customerName, customerEmail: customerEmailInput, customerPhone } = body;

        // 1. Verify Tenant
        const business = await prisma.business.findUnique({
            where: { id: businessId }
        });

        if (!business) {
            return new NextResponse('Business not found', { status: 404 });
        }

        // Resolve Stripe Connected Account from Integration (source of truth)
        const stripeIntegration = await prisma.integration.findUnique({
            where: {
                business_id_provider: {
                    business_id: businessId,
                    provider: 'stripe'
                }
            }
        });

        const connectedAccountId = stripeIntegration?.access_token;

        if (!connectedAccountId) {
            return NextResponse.json({ error: 'Checkout is temporarily unavailable for this kitchen (Stripe Onboarding Incomplete).' }, { status: 400 });
        }

        if (process.env.NODE_ENV !== 'development') {
            const acct = await stripe.accounts.retrieve(connectedAccountId);
            if (!acct.charges_enabled) {
                return NextResponse.json({ error: 'Checkout is temporarily unavailable for this kitchen (Stripe Onboarding Incomplete).' }, { status: 400 });
            }
        }

        // 2. Resolve Customer (Optional: if they are logged into the Account Portal)
        const session = await getCustomerSession();
        let customerId = undefined;
        let customerEmail = undefined;

        if (session && session.businessId === businessId) {
            customerId = session.customerId;
            customerEmail = session.email;
        }

        // 3. Build Line Items
        const lineItems = items.map((item: any) => {
            return {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: item.name,
                        images: item.image_url ? [item.image_url] : [],
                    },
                    unit_amount: Math.round(item.price * 100), // Stripe uses cents
                },
                quantity: item.quantity,
            };
        });

        // 4. Calculate Application Fee (FreezerIQ SaaS Monetization)
        // TODO: Platform fee configuration not yet implemented. Set to 0 until fee settings are built.
        const totalAmountCents = Math.round(orderTotal * 100);
        let applicationFeeAmountCents = 0;
        const platformFeePercent = 0;

        if (platformFeePercent > 0) {
            applicationFeeAmountCents = Math.round(totalAmountCents * (platformFeePercent / 100));
        }

        // 5. Generate Database Order First (Pending Stripe Payment)
        const mapServingTier = (tier: string) => {
            switch (tier) {
                case 'single': return 'serves_1';
                case 'couple': return 'serves_2';
                case 'family': return 'serves_5';
                case 'party': return 'serves_10';
                default: return 'serves_5';
            }
        };

        const externalId = Math.random().toString(36).substring(2, 9).toUpperCase();

        const pendingOrder = await prisma.order.create({
            data: {
                business_id: business.id,
                customer_id: customerId || null,
                external_id: externalId,
                source: 'storefront',
                status: 'pending',
                total_amount: orderTotal,
                customer_name: customerName,
                delivery_date: deliveryDate ? new Date(deliveryDate) : null,
                items: {
                    create: items.map((item: any) => ({
                        bundle_id: item.bundleId === 'manual_upsell' ? null : item.bundleId,
                        quantity: item.quantity,
                        item_name: item.name,
                        unit_price: item.price,
                        variant_size: mapServingTier(item.serving_tier)
                    }))
                }
            }
        });

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';

        // 6. Generate Stripe Checkout Session routed to the Connected Account
        const sessionParams: any = {
            payment_method_types: ['card', 'us_bank_account'],
            line_items: lineItems,
            mode: 'payment',
            success_url: `${appUrl}/shop/${business.slug}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/shop/${business.slug}/cart`,
            customer_email: customerEmail || customerEmailInput,
            metadata: {
                businessId: business.id,
                customerId: customerId || '',
                orderId: pendingOrder.id,
                source: 'b2c'
            }
        };

        // Inject the SaaS Fee if applicable
        if (applicationFeeAmountCents > 0) {
            sessionParams.payment_intent_data = {
                application_fee_amount: applicationFeeAmountCents,
            };
        }

        const stripeSession = await stripe.checkout.sessions.create(
            sessionParams,
            { stripeAccount: connectedAccountId }
        );

        return NextResponse.json({ url: stripeSession.url });

    } catch (error: any) {
        console.error('[STRIPE_CHECKOUT]', error);
        return NextResponse.json({ error: error.message || 'Internal Error' }, { status: 500 });
    }
}
