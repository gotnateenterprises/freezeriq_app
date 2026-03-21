import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { v4 as uuidv4 } from 'uuid';

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const sessionId = url.searchParams.get('session_id');

        if (!sessionId) {
            return new NextResponse('Missing session_id', { status: 400 });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (!session || session.payment_status !== 'paid') {
            return new NextResponse('Payment not completed', { status: 400 });
        }

        const { businessId, orderId } = session.metadata || {};

        if (!businessId || !orderId) {
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

        // 2. Fetch business
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
            }
        });

        return NextResponse.json({ success: true, orderId: order.id });

    } catch (error: any) {
        console.error('[STRIPE_CHECKOUT_SUCCESS_CALLBACK]', error);
        return new NextResponse(error.message || 'Internal Error', { status: 500 });
    }
}
