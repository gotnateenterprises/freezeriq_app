
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { prisma } from '@/lib/db';
import Stripe from 'stripe';

export async function POST(req: Request) {
    const body = await req.text();
    const signature = (await headers()).get('Stripe-Signature') as string;

    let event: Stripe.Event;

    try {
        event = stripe.webhooks.constructEvent(
            body,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET!
        );
    } catch (error: any) {
        return NextResponse.json({ error: `Webhook Error: ${error.message}` }, { status: 400 });
    }

    // We'll cast inside the switch for better type safety
    const dataObject = event.data.object;

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = dataObject as Stripe.Checkout.Session;
            if (!session.metadata?.businessId) break;

            const subscriptionId = session.subscription as string;

            await prisma.business.update({
                where: { id: session.metadata.businessId },
                data: {
                    stripe_subscription_id: subscriptionId,
                    stripe_customer_id: session.customer as string,
                    plan: (session.metadata.plan as any) || 'BASE',
                    subscription_status: 'active',
                    trial_ends_at: null // Trial over, they paid (or started sub)
                }
            });
            break;
        }

        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const subscription = dataObject as Stripe.Subscription;
            // Find business by stripe_subscription_id
            const business = await prisma.business.findFirst({
                where: { stripe_subscription_id: subscription.id }
            });

            if (!business) break;

            await prisma.business.update({
                where: { id: business.id },
                data: {
                    subscription_status: subscription.status as any,
                    current_period_end: new Date((subscription as any).current_period_end * 1000)
                }
            });
            break;
        }
    }

    return NextResponse.json({ received: true });
}
