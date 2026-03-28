import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import Stripe from 'stripe';
import { getPlanFromPriceId } from '@/lib/stripe';
import { SubscriptionStatus } from '@prisma/client';

// Stripe requires raw body for signature verification — disable Next.js body parsing
export const dynamic = 'force-dynamic';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-01-28.clover',
});

export async function POST(req: Request) {
    let event: Stripe.Event;

    // 1. Verify Stripe Signature
    const body = await req.text();
    const signature = req.headers.get('stripe-signature');

    if (!signature) {
        console.error('[Webhook] Missing stripe-signature header');
        return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        console.error('[Webhook] STRIPE_WEBHOOK_SECRET is not configured');
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
    }

    try {
        event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err: any) {
        console.error('[Webhook] Signature verification failed:', err.message);
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // 2. Route by Event Type
    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
                break;

            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
                break;

            default:
                // Accept but ignore unhandled event types (Stripe best practice)
                console.log(`[Webhook] Unhandled event type: ${event.type}`);
        }
    } catch (err: any) {
        console.error(`[Webhook] Error processing event ${event.type}:`, err);
        // We still return 200 to acknowledge receipt, but log the error for monitoring
    }

    // 3. Always acknowledge receipt (Stripe retries on non-2xx)
    return NextResponse.json({ received: true });
}

// ─── Handler: checkout.session.completed ────────────────────────────────────────

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const type = session.metadata?.type;
    const businessId = session.metadata?.businessId;

    if (!businessId) {
        console.error('[Webhook] Missing businessId in metadata:', session.id);
        return;
    }

    // A. PLATFORM SaaS SUBSCRIPTION
    if (type === 'platform_subscription') {
        const subscriptionId = session.subscription as string;
        if (!subscriptionId) return;

        // Fetch subscription to get the price/plan
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = subscription.items.data[0].price.id;
        const plan = getPlanFromPriceId(priceId);

        await prisma.business.update({
            where: { id: businessId },
            data: {
                stripe_subscription_id: subscriptionId,
                subscription_status: subscription.status as SubscriptionStatus,
                current_period_end: new Date(subscription.current_period_end * 1000),
                plan: plan || undefined,
            }
        });

        console.log(`[Webhook] ✓ Platform subscription created for business ${businessId} (sub: ${subscriptionId})`);
        return;
    }

    // B. STOREFRONT ORDER (Legacy/Tenant commerce)
    const orderId = session.metadata?.orderId;
    if (orderId) {
        await processStorefrontOrder(orderId, businessId, session);
        return;
    }

    console.warn('[Webhook] Unrecognized checkout session type:', { sessionId: session.id, metadata: session.metadata });
}

// ─── Handler: customer.subscription.updated ─────────────────────────────────────

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
    const businessId = subscription.metadata?.businessId;
    if (!businessId) return;

    const priceId = subscription.items.data[0].price.id;
    const plan = getPlanFromPriceId(priceId);

    await prisma.business.update({
        where: { id: businessId },
        data: {
            subscription_status: subscription.status as SubscriptionStatus,
            current_period_end: new Date(subscription.current_period_end * 1000),
            plan: plan || undefined,
        }
    });

    console.log(`[Webhook] ✓ Subscription updated for business ${businessId} (status: ${subscription.status})`);
}

// ─── Handler: customer.subscription.deleted ─────────────────────────────────────

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    const businessId = subscription.metadata?.businessId;
    if (!businessId) return;

    await prisma.business.update({
        where: { id: businessId },
        data: {
            subscription_status: 'canceled',
            stripe_subscription_id: null,
        }
    });

    console.log(`[Webhook] ⚠ Subscription deleted for business ${businessId}`);
}

// ─── Helper: processStorefrontOrder (Internal Storefront) ─────────────────────────

async function processStorefrontOrder(orderId: string, businessId: string, session: Stripe.Checkout.Session) {
    const existingOrder = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, business_id: true },
    });

    if (!existingOrder || existingOrder.business_id !== businessId) {
        console.error(`[Webhook] Order mismatch or not found: ${orderId}`);
        return;
    }

    if (existingOrder.status !== 'pending' && existingOrder.status !== 'PENDING') {
        console.log(`[Webhook] Order ${orderId} already processed (status: ${existingOrder.status})`);
        return;
    }

    await prisma.order.update({
        where: { id: orderId },
        data: {
            status: 'production_ready',
            processor_payment_id: session.payment_intent ? String(session.payment_intent) : undefined,
        },
    });

    console.log(`[Webhook] ✓ Order ${orderId} promoted to production_ready`);
}
