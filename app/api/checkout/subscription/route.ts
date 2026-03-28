import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { 
    getOrCreateStripeCustomer, 
    createSubscriptionCheckoutSession, 
    PRICE_ID_MAP 
} from '@/lib/stripe';
import { SubscriptionPlan } from '@prisma/client';

export async function POST(req: Request) {
    try {
        // 1. Authenticate the User
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized: Business not found.' }, { status: 401 });
        }

        const businessId = session.user.businessId;

        // 2. Parse and Validate the Request
        const { plan } = await req.json();

        if (!plan || !Object.values(SubscriptionPlan).includes(plan as SubscriptionPlan)) {
            return NextResponse.json({ error: 'Invalid plan selected.' }, { status: 400 });
        }

        // 3. Resolve Price ID
        const priceId = PRICE_ID_MAP[plan as SubscriptionPlan];
        if (!priceId) {
            return NextResponse.json({ error: `Price ID for plan ${plan} is not configured.` }, { status: 500 });
        }

        // 4. Fetch Business Details for Stripe Customer
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { name: true, contact_email: true, stripe_customer_id: true }
        });

        if (!business) {
            return NextResponse.json({ error: 'Business record not found.' }, { status: 404 });
        }

        // 5. Ensure Stripe Customer Exists
        let stripeCustomerId = business.stripe_customer_id;
        if (!stripeCustomerId) {
            stripeCustomerId = await getOrCreateStripeCustomer(
                businessId,
                business.contact_email || session.user.email!,
                business.name
            );

            // Update business with customer ID
            await prisma.business.update({
                where: { id: businessId },
                data: { stripe_customer_id: stripeCustomerId }
            });
        }

        // 6. Create Stripe Checkout Session
        const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
        const host = req.headers.get('host');
        const baseUrl = `${protocol}://${host}`;

        const checkoutSession = await createSubscriptionCheckoutSession({
            customerId: stripeCustomerId,
            priceId: priceId,
            businessId: businessId,
            successUrl: `${baseUrl}/settings?session_id={CHECKOUT_SESSION_ID}&success=true`,
            cancelUrl: `${baseUrl}/settings?success=false`,
        });

        return NextResponse.json({ url: checkoutSession.url });

    } catch (error: any) {
        console.error('[SubscriptionCheckout] Critical Error:', error);
        return NextResponse.json(
            { error: error.message || 'Internal Server Error' },
            { status: 500 }
        );
    }
}
