import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;

        // 1. Fetch Campaign with Business Info
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            include: {
                customer: {
                    select: {
                        name: true,
                        business_id: true,
                        business: {
                            select: {
                                plan: true,
                                subscription_status: true
                            }
                        }
                    }
                },
                // 2. PRIVACY FIX: Only select fields needed for Leaderboard/Progress
                orders: {
                    orderBy: { created_at: 'desc' },
                    select: {
                        id: true,
                        participant_name: true,
                        customer_name: true,
                        total_amount: true,
                        created_at: true,
                        source: true,
                        customer_email: true,
                        customer_phone: true,
                        coordinator_paid: true,
                        coordinator_check: true,
                        coordinator_picked_up: true,
                        items: {
                            select: {
                                bundle_id: true,
                                quantity: true,
                                variant_size: true
                            }
                        }
                    }
                }
            }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        // 3. ACCESS CONTROL: Check Business Plan
        const business = (campaign.customer as any)?.business;
        const businessId = (campaign.customer as any)?.business_id;
        const plan = business?.plan || 'FREE'; // Default to FREE if missing

        // Allow ENTERPRISE, ULTIMATE, FREE, or specific legacy plans
        const allowedPlans = ['ENTERPRISE', 'ULTIMATE', 'FREE', 'PRO'];
        if (!allowedPlans.includes(plan)) {
            return NextResponse.json({ error: "Portal unavailable (Plan Restriction)" }, { status: 403 });
        }

        // 4. Fetch Specific Bundles assigned to the Fundraiser via Invoice
        let bundles: any[] = [];

        const latestInvoice = await prisma.invoice.findFirst({
            where: { customer_id: campaign.customer_id },
            orderBy: { created_at: 'desc' },
            include: {
                items: {
                    include: {
                        bundle: {
                            select: {
                                id: true,
                                name: true,
                                price: true,
                                serving_tier: true
                            }
                        }
                    }
                }
            }
        });

        if (latestInvoice && latestInvoice.items.length > 0) {
            // Extract bundles from invoice items, filtering out nulls
            bundles = latestInvoice.items
                .filter(item => item.bundle)
                .map(item => item.bundle);

            // Deduplicate bundles by ID
            bundles = Array.from(new Map(bundles.map(b => [b.id, b])).values());
        } else {
            // Fallback for dummy/new campaigns with no invoices
            bundles = await prisma.bundle.findMany({
                where: {
                    business_id: businessId,
                    is_active: true
                },
                select: {
                    id: true,
                    name: true,
                    price: true,
                    serving_tier: true
                }
            });
        }

        return NextResponse.json({
            ...campaign,
            availableBundles: bundles
        });

    } catch (e: any) {
        console.error("Fetch Coordinator Portal Error:", e);
        return NextResponse.json({ error: "Failed to fetch portal data" }, { status: 500 });
    }
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;
        const body = await req.json();
        const { customerName, items, totalAmount, deliveryAddress, participantName, email, phone } = body;

        // 1. Fetch Campaign & Check Plan
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            include: {
                customer: {
                    include: {
                        business: { select: { plan: true, id: true } }
                    }
                }
            }
        });

        if (!campaign || !(campaign as any).customer?.business_id) {
            return NextResponse.json({ error: "Portal not found or invalid" }, { status: 404 });
        }

        const business = (campaign.customer as any).business;
        const plan = business?.plan || 'FREE';
        const allowedPlans = ['ENTERPRISE', 'ULTIMATE', 'FREE', 'PRO'];
        if (!allowedPlans.includes(plan)) {
            return NextResponse.json({ error: "Portal unavailable" }, { status: 403 });
        }

        // 2. Create Order
        const order = await prisma.order.create({
            data: {
                external_id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                source: 'manual',
                customer_name: customerName,
                participant_name: participantName,
                status: 'pending' as any,
                total_amount: totalAmount,
                delivery_address: deliveryAddress,
                business_id: business.id,
                customer_id: campaign.customer_id,
                campaign_id: campaign.id,
                customer_email: email || null,
                customer_phone: phone || null,
                items: {
                    create: (items || []).map((item: any) => {
                        let mappedVariant = item.variantSize || item.serving_tier || 'serves_5';
                        if (mappedVariant === 'family') mappedVariant = 'serves_5';
                        if (mappedVariant === 'serves 2') mappedVariant = 'serves_2';

                        return {
                            bundle_id: item.bundleId || item.id,
                            quantity: item.quantity,
                            variant_size: mappedVariant
                        };
                    })
                }
            }
        });

        // 3. Update campaign total sales
        await prisma.fundraiserCampaign.update({
            where: { id: campaign.id },
            data: {
                total_sales: {
                    increment: totalAmount
                }
            }
        });

        return NextResponse.json(order);

    } catch (e: any) {
        console.error("Create Coordinator Order Error:", e);
        return NextResponse.json({ error: `Failed to create order: ${e.message}` }, { status: 500 });
    }
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        // Note: Ideally we'd have a checkEnterprisePlan helper here, 
        // but for now we'll rely on the token being private and the frontend gating.
        const { token } = await params;
        const body = await req.json();
        const { paymentInstructions, externalPaymentLink } = body;

        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        const updated = await prisma.fundraiserCampaign.update({
            where: { id: campaign.id },
            data: {
                payment_instructions: paymentInstructions,
                external_payment_link: externalPaymentLink
            }
        });

        return NextResponse.json(updated);

    } catch (e: any) {
        console.error("Update Coordinator Settings Error:", e);
        return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;
        const body = await req.json();
        const { orderId, updates } = body;

        if (!orderId || !updates) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        // Verify the token belongs to the campaign that owns this order
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        const order = await prisma.order.findFirst({
            where: { id: orderId, campaign_id: campaign.id }
        });

        if (!order) {
            return NextResponse.json({ error: "Order not found in this campaign" }, { status: 404 });
        }

        // Update the explicitly allowed fields
        const safeUpdates: any = {};
        if (updates.coordinator_paid !== undefined) safeUpdates.coordinator_paid = updates.coordinator_paid;
        if (updates.coordinator_check !== undefined) safeUpdates.coordinator_check = updates.coordinator_check;
        if (updates.coordinator_picked_up !== undefined) safeUpdates.coordinator_picked_up = updates.coordinator_picked_up;

        const updatedOrder = await prisma.order.update({
            where: { id: orderId },
            data: safeUpdates
        });

        return NextResponse.json(updatedOrder);

    } catch (e: any) {
        console.error("Coordinator Order Patch Error:", e);
        return NextResponse.json({ error: "Failed to update order" }, { status: 500 });
    }
}
