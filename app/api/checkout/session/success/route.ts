import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { v4 as uuidv4 } from 'uuid';

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get('session_id');
        const squareOrderId = url.searchParams.get('order_id');
        const businessId = url.searchParams.get('business_id');

        // ── Square verification path ────────────────────────────────────────
        // The square/pay route already promoted the order to production_ready
        // synchronously. The webhook provides backup. This route only READS
        // DB state — it never calls the Square API or mutates the order.
        if (squareOrderId && businessId) {
            const order = await prisma.order.findUnique({
                where: { id: squareOrderId },
                select: { id: true, status: true, business_id: true },
            });

            if (!order) {
                return NextResponse.json({ error: 'Order not found' }, { status: 404 });
            }

            if (order.business_id !== businessId) {
                return NextResponse.json({ error: 'Order does not belong to this business' }, { status: 403 });
            }

            // production_ready: square/pay already promoted it — fully confirmed
            // pending: payment completed but promotion is in-flight or
            //          webhook hasn't fired yet — safe to show the page,
            //          but the UI should display a "confirming" state, not
            //          a final green checkmark
            if (order.status === 'production_ready') {
                return NextResponse.json({ success: true, confirmed: true, orderId: order.id });
            }

            if (order.status === 'pending') {
                return NextResponse.json({ success: true, confirmed: false, orderId: order.id });
            }

            // Any other status (cancelled, etc.) — don't show false success
            return NextResponse.json(
                { error: 'Order is not in a confirmed state' },
                { status: 400 }
            );
        }

        // ── Stripe verification path (existing — unchanged) ─────────────────
        if (!sessionId) {
            return new NextResponse('Missing session_id or order_id', { status: 400 });
        }

        // Resolve connected account BEFORE retrieving the session
        // (the session was created on the connected account, not on the platform)
        let connectedAccountId: string | undefined;

        if (businessId) {
            const stripeIntegration = await prisma.integration.findUnique({
                where: {
                    business_id_provider: {
                        business_id: businessId,
                        provider: 'stripe'
                    }
                }
            });
            connectedAccountId = stripeIntegration?.access_token ?? undefined;
        }

        const session = await stripe.checkout.sessions.retrieve(
            sessionId,
            connectedAccountId ? { stripeAccount: connectedAccountId } : undefined
        );

        if (!session || session.payment_status !== 'paid') {
            return new NextResponse('Payment not completed', { status: 400 });
        }

        // Use metadata from the Stripe session as the canonical source
        const metaBusinessId = session.metadata?.businessId;
        const orderId = session.metadata?.orderId;

        if (!metaBusinessId || !orderId) {
            return new NextResponse('Invalid session metadata', { status: 400 });
        }

        const existingOrder = await prisma.order.findUnique({
            where: { id: orderId }
        });

        if (!existingOrder) {
            return new NextResponse('Order not found', { status: 404 });
        }

        if (existingOrder.status === 'production_ready') {
            // Already processed — prevent duplicate updates
            return NextResponse.json({ success: true, orderId: existingOrder.id });
        }

        if (existingOrder.status !== 'pending') {
            // Only promote orders awaiting payment confirmation
            return new NextResponse('Order not eligible for payment confirmation', { status: 400 });
        }

        // 3. Calculate stats
        let platformFeeAmount = 0;

        // Retrieve Payment Intent for application fee
        if (session.payment_intent && connectedAccountId) {
            try {
                const pi = await stripe.paymentIntents.retrieve(session.payment_intent as string, {
                    stripeAccount: connectedAccountId
                });
                if (pi.application_fee_amount) {
                    platformFeeAmount = pi.application_fee_amount / 100;
                }
            } catch (e) { console.error('Error fetching PI', e) }
        }

        // 4. Update Database Order
        const order = await prisma.order.update({
            where: { id: orderId },
            data: {
                status: 'production_ready',
                processor_payment_id: session.payment_intent
                    ? String(session.payment_intent)
                    : undefined,
            }
        });

        return NextResponse.json({ success: true, orderId: order.id });

    } catch (error: any) {
        console.error('[CHECKOUT_SUCCESS_CALLBACK]', error);
        return new NextResponse('Something went wrong. Please try again.', { status: 500 });
    }
}
