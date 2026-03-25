import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import Stripe from 'stripe';

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
    if (event.type === 'checkout.session.completed') {
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    } else {
        // Accept but ignore unhandled event types (Stripe best practice)
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    // 3. Always acknowledge receipt (Stripe retries on non-2xx)
    return NextResponse.json({ received: true });
}

// ─── Handler: checkout.session.completed ────────────────────────────────────────

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
    const orderId = session.metadata?.orderId;
    const businessId = session.metadata?.businessId;

    if (!orderId || !businessId) {
        console.error('[Webhook] checkout.session.completed missing metadata:', {
            sessionId: session.id,
            metadata: session.metadata,
        });
        return; // Don't throw — we already acknowledged to Stripe
    }

    // Idempotency: Check current order state before updating
    const existingOrder = await prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, business_id: true },
    });

    if (!existingOrder) {
        console.error(`[Webhook] Order not found: ${orderId} (session: ${session.id})`);
        return;
    }

    // Guard: Only promote orders belonging to the correct business
    if (existingOrder.business_id !== businessId) {
        console.error(`[Webhook] Business mismatch: order belongs to ${existingOrder.business_id}, metadata says ${businessId}`);
        return;
    }

    // Idempotency: Already processed — skip silently
    if (existingOrder.status === 'production_ready') {
        console.log(`[Webhook] Order ${orderId} already production_ready — skipping (idempotent)`);
        return;
    }

    // Guard: Only promote from pending
    if (existingOrder.status !== 'pending') {
        console.warn(`[Webhook] Order ${orderId} in unexpected state "${existingOrder.status}" — skipping`);
        return;
    }

    // Promote to production_ready
    await prisma.order.update({
        where: { id: orderId },
        data: {
            status: 'production_ready',
        },
    });

    console.log(`[Webhook] ✓ Order ${orderId} confirmed via webhook (session: ${session.id})`);
}
