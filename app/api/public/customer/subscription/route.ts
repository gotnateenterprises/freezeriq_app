import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCustomerSession } from '@/lib/customerAuth';
import { stripe } from '@/lib/stripe';

export async function POST(req: Request) {
    try {
        const session = await getCustomerSession();

        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { action } = await req.json();

        if (!['pause', 'resume', 'cancel'].includes(action)) {
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
        }

        const customer = await prisma.customer.findUnique({
            where: { id: session.customerId },
            include: { business: true }
        });

        if (!customer) {
            return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
        }

        // Apply logic to update subscription status
        // Depending on actual Stripe integration, this might ALSO require a Stripe API call
        // For now, we update the local Freeziq record.
        let newStatus = customer.subscription_status;
        let credits = customer.meal_credits;
        let plan = customer.subscription_plan_id;

        const stripeAccountId = customer.business?.stripe_account_id;
        const subId = customer.stripe_subscription_id;

        if (action === 'pause') {
            newStatus = 'paused';
            if (subId && stripeAccountId) {
                await stripe.subscriptions.update(
                    subId,
                    { pause_collection: { behavior: 'void' } },
                    { stripeAccount: stripeAccountId }
                );
            }
        } else if (action === 'resume') {
            if (customer.subscription_status === 'paused') {
                newStatus = 'active';
                if (subId && stripeAccountId) {
                    await stripe.subscriptions.update(
                        subId,
                        { pause_collection: '' as any }, // Stripe API uses empty string to unset
                        { stripeAccount: stripeAccountId }
                    );
                }
            }
        } else if (action === 'cancel') {
            newStatus = 'canceled';
            credits = 0; // Prevent further selections if canceled mid-cycle
            plan = null;
            if (subId && stripeAccountId) {
                await stripe.subscriptions.cancel(
                    subId,
                    { stripeAccount: stripeAccountId }
                );
            }
        }

        await prisma.customer.update({
            where: { id: session.customerId },
            data: {
                subscription_status: newStatus,
                // @ts-ignore
                meal_credits: credits,
                subscription_plan_id: plan
            }
        });

        return NextResponse.json({
            success: true,
            message: `Subscription successfully ${action}d`
        });

    } catch (error: any) {
        console.error('[Customer Subscription API] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
