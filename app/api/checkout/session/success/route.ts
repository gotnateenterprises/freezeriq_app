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

        // @ts-ignore
        if (existingOrder.payment_status === 'paid') {
            // Already processed this stripe session!
            return NextResponse.json({ success: true, orderId: existingOrder.id });
        }

        // 2. Fetch business
        const business = await prisma.business.findUnique({
            where: { id: businessId }
        });

        if (!business) {
            return new NextResponse('Business not found', { status: 404 });
        }

        // 3. Calculate stats
        let platformFeeAmount = 0;

        // Retrieve Payment Intent for application fee
        if (session.payment_intent) {
            try {
                const pi = await stripe.paymentIntents.retrieve(session.payment_intent as string, {
                    // @ts-ignore
                    stripeAccount: business.stripe_account_id as string
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
                // @ts-ignore
                payment_status: 'paid',
                payment_intent_id: session.payment_intent as string,
                // @ts-ignore
                platform_fee_amount: platformFeeAmount || existingOrder.platform_fee_amount,
            }
        });

        return NextResponse.json({ success: true, orderId: order.id });

    } catch (error: any) {
        console.error('[STRIPE_CHECKOUT_SUCCESS_CALLBACK]', error);
        return new NextResponse(error.message || 'Internal Error', { status: 500 });
    }
}
