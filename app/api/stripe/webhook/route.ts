
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

            // 1. Handle B2C Storefront Order Completion
            if (session.metadata.source === 'b2c' && session.metadata.orderId) {
                const orderId = session.metadata.orderId;
                const existingOrder = await prisma.order.findUnique({
                    where: { id: orderId },
                    include: {
                        items: {
                            include: { bundle: true }
                        }
                    }
                });

                // @ts-ignore
                if (existingOrder && existingOrder.payment_status !== 'paid') {
                    // Check if entire order is digital donations
                    let allDonations = true;
                    if (existingOrder.items && existingOrder.items.length > 0) {
                        for (const item of existingOrder.items) {
                            if (!item.bundle?.is_donation) {
                                allDonations = false;
                                break;
                            }
                        }
                    } else {
                        allDonations = false; // Empty order fallback
                    }

                    const targetStatus = allDonations ? 'completed' : 'production_ready';

                    await prisma.order.update({
                        where: { id: orderId },
                        data: {
                            status: targetStatus,
                            // @ts-ignore
                            payment_status: 'paid',
                            payment_intent_id: session.payment_intent as string,
                        }
                    });
                    console.log(`[Stripe Webhook] Order ${orderId} marked paid/${targetStatus}`);
                }
                break;
            }

            // 2. Handle B2B Subscription Onboarding
            const subscriptionId = session.subscription as string;
            if (subscriptionId) {
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
            }
            break;
        }

        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const subscription = dataObject as Stripe.Subscription;

            // Try B2B Business First
            const business = await prisma.business.findFirst({
                where: { stripe_subscription_id: subscription.id }
            });

            if (business) {
                await prisma.business.update({
                    where: { id: business.id },
                    data: {
                        subscription_status: subscription.status as any,
                        // @ts-ignore
                        current_period_end: new Date((subscription as any).current_period_end * 1000)
                    }
                });
                break;
            }

            // Fallback: Try B2C Customer
            const customer = await prisma.customer.findFirst({
                // @ts-ignore
                where: { stripe_subscription_id: subscription.id }
            });

            if (customer) {
                await prisma.customer.update({
                    where: { id: customer.id },
                    data: {
                        subscription_status: subscription.status,
                        next_delivery_date: new Date((subscription as any).current_period_end * 1000)
                    } as any
                });
            }
            break;
        }

        case 'invoice.paid': {
            const invoice = dataObject as Stripe.Invoice;

            // @ts-ignore
            const subscriptionId = invoice.subscription as string;
            // We only care about subscription renewals for B2C Customers grabbing meal credits
            if (!subscriptionId) break;

            const customer = await prisma.customer.findFirst({
                // @ts-ignore
                where: { stripe_subscription_id: subscriptionId },
                include: { business: true }
            });

            if (!customer) break;

            let newCredits = 0;
            if (invoice.lines.data.length > 0) {
                const lineItem = invoice.lines.data[0] as any;
                const priceId = lineItem.price?.id;

                if (priceId) {
                    const tier = await prisma.subscriptionTier.findUnique({
                        where: { stripe_price_id: priceId }
                    });
                    if (tier) {
                        newCredits = tier.meal_credits_per_cycle;
                    }
                }
            }

            // Fallback just in case
            if (newCredits === 0) {
                newCredits = 10;
            }

            // Add credits and update next delivery date
            await prisma.customer.update({
                where: { id: customer.id },
                data: {
                    // @ts-ignore
                    meal_credits: ((customer.meal_credits as number) || 0) + newCredits,
                    subscription_status: 'active' as any // Ensure it's active if they paid
                } as any
            });

            console.log(`[Stripe Webhook] Granted ${newCredits} meal credits to Customer ${customer.id}`);
            break;
        }

        case 'invoice.payment_failed': {
            const invoice = dataObject as Stripe.Invoice;
            // @ts-ignore
            const subscriptionId = invoice.subscription as string;
            if (!subscriptionId) break;

            const customer = await prisma.customer.findFirst({
                // @ts-ignore
                where: { stripe_subscription_id: subscriptionId }
            });

            if (!customer) break;

            await prisma.customer.update({
                where: { id: customer.id },
                data: {
                    subscription_status: 'past_due' as any
                } as any
            });

            console.log(`[Stripe Webhook] Marked Customer ${customer.id} past_due due to failed payment.`);
            break;
        }
    }

    return NextResponse.json({ received: true });
}
