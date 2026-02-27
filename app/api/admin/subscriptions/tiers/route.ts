import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { stripe } from '@/lib/stripe';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const tiers = await prisma.subscriptionTier.findMany({
            where: { business_id: session.user.businessId },
            orderBy: { price: 'asc' }
        });

        return NextResponse.json(tiers);
    } catch (error: any) {
        console.error('[TIERS_GET]', error);
        return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const business = await prisma.business.findUnique({
            where: { id: session.user.businessId }
        });

        // @ts-ignore
        if (!business || !business.stripe_account_id) {
            return NextResponse.json({ error: 'Please connect your Stripe account first in Settings' }, { status: 403 });
        }

        const body = await req.json();
        const { name, price, meal_credits_per_cycle } = body;

        // 1. Create the Product on the Connected Stripe Account
        const product = await stripe.products.create({
            name: `${name} (${business.name})`,
            description: `Automated subscription granting ${meal_credits_per_cycle} meal credits per cycle.`,
            metadata: {
                businessId: business.id,
                tierName: name,
                mealCredits: meal_credits_per_cycle.toString()
            }
            // @ts-ignore
        }, { stripeAccount: business.stripe_account_id });

        // 2. Create the Price for the Product (Recurring)
        const stripePrice = await stripe.prices.create({
            product: product.id,
            unit_amount: Math.round(price * 100),
            currency: 'usd',
            recurring: { interval: 'month' }, // Assuming monthly for now, could be made dynamic
            // @ts-ignore
        }, { stripeAccount: business.stripe_account_id });

        // 3. Save to the Database
        const tier = await prisma.subscriptionTier.create({
            data: {
                business_id: business.id,
                name,
                price,
                meal_credits_per_cycle,
                stripe_product_id: product.id,
                stripe_price_id: stripePrice.id,
            }
        });

        return NextResponse.json(tier);
    } catch (error: any) {
        console.error('[TIERS_POST]', error);
        return NextResponse.json({ error: error.message || 'Internal Error' }, { status: 500 });
    }
}
