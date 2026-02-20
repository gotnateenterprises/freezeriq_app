import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

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
                    where: { status: { not: 'cancelled' } }, // Optional: hide cancelled
                    orderBy: { created_at: 'desc' },
                    select: {
                        id: true,
                        participant_name: true,
                        customer_name: true,
                        total_amount: true,
                        created_at: true,
                        source: true
                        // EXCLUDED: delivery_address, customer_email, phone, items
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

        // 4. Fetch Active Bundles for the business
        const bundles = await prisma.bundle.findMany({
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
                status: 'pending',
                total_amount: totalAmount,
                delivery_address: deliveryAddress,
                business_id: business.id,
                customer_id: campaign.customer_id,
                campaign_id: campaign.id,
                items: {
                    create: (items || []).map((item: any) => ({
                        bundle_id: item.bundleId || item.id,
                        quantity: item.quantity,
                        variant_size: item.variantSize || item.serving_tier || 'family'
                    }))
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
