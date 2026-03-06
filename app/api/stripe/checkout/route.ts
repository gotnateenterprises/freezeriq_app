
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { stripe, getOrCreateStripeCustomer } from '@/lib/stripe';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id || !(session.user as any).businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { plan, priceId } = await req.json(); // plan: 'PRO', priceId: 'price_...'
        const businessId = (session.user as any).businessId;

        const business = await prisma.business.findUnique({
            where: { id: businessId }
        });

        if (!business) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

        // 1. Get/Create Stripe Customer
        const customerId = business.stripe_customer_id || await getOrCreateStripeCustomer(businessId, session.user.email ?? '', business.name);

        // Update DB if we just created it
        if (!business.stripe_customer_id) {
            await prisma.business.update({
                where: { id: businessId },
                data: { stripe_customer_id: customerId }
            });
        }

        // 2. Create Checkout Session
        const checkoutSession = await stripe.checkout.sessions.create({
            customer: customerId,
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/settings/billing?success=true`,
            cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/settings/billing?canceled=true`,
            subscription_data: {
                metadata: {
                    businessId: businessId,
                    plan: plan // 'PRO' or 'BASE'
                }
            },
            metadata: {
                businessId: businessId,
                plan: plan
            }
        });

        return NextResponse.json({ url: checkoutSession.url });

    } catch (error: any) {
        console.error('[StripeCheckout] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
