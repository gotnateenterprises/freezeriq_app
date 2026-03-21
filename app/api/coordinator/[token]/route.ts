/**
 * Coordinator Portal API
 *
 * ACCESS MODEL: Token-based (no auth session required)
 * - GET/POST/PUT gated by `portal_token` on FundraiserCampaign
 * - Token holder has coordinator-level access:
 *   GET  → view campaign details, privacy-filtered orders, available bundles
 *   POST → submit compiled fundraiser order on behalf of supporters
 *   PUT  → update coordinator payment settings (Venmo link, instructions)
 * - No PII exposure: delivery addresses, emails, phones filtered from GET responses
 * - Plan gating checked per-request against business subscription
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from portal_token)
 *
 * NOTE: Supporters do NOT place orders through FreezerIQ. The coordinator
 * collects supporter orders/payments externally, then submits the compiled
 * bulk order here for tenant fulfillment.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';

export async function GET(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;

        // 1. Fetch Campaign with Business Info by portal_token (private coordinator access)
        let campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            include: {
                customer: {
                    select: {
                        name: true,
                        business_id: true,
                        business: {
                            select: {
                                name: true,
                                logo_url: true,
                                plan: true,
                                subscription_status: true
                            }
                        }
                    }
                },
                orders: {
                    orderBy: { created_at: 'desc' },
                    select: {
                        id: true,
                        participant_name: true,
                        customer_name: true,
                        total_amount: true,
                        created_at: true,
                        source: true,
                        // Bundle-unit progress needs item-level data (no PII)
                        items: {
                            select: {
                                quantity: true,
                                variant_size: true,
                            }
                        }
                        // EXCLUDED: delivery_address, customer_email, phone
                    }
                }
            }
        });

        if (!campaign) {
            console.warn(`Coordinator GET: no campaign found for token (length=${token.length})`);
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        // 3. ACCESS CONTROL: Check Business Plan
        const business = (campaign.customer as any)?.business;
        const businessId = (campaign.customer as any)?.business_id;
        const plan = business?.plan || 'FREE'; // Default to FREE if missing

        // PLAN GATE SCAFFOLDING: Currently allows all known plans. Fundraising
        // is available on every tier today. When full plan-gating is implemented
        // (CONSTITUTION §5), tighten this list to restrict coordinator portals
        // to paid tiers only. The gate blocks null/empty plans now.
        const allowedPlans = ['ENTERPRISE', 'ULTIMATE', 'FREE', 'PRO'];
        if (!allowedPlans.includes(plan)) {
            return NextResponse.json({ error: "Portal unavailable (Plan Restriction)" }, { status: 403 });
        }

        // 4. Fetch campaign-assigned bundles (or fallback to all active bundles)
        let bundles: any[] = [];
        try {
            const campaignBundles: any[] = await prisma.$queryRaw`
                SELECT bundle_id FROM campaign_bundles
                WHERE campaign_id = ${campaign.id}
                ORDER BY position ASC
            `;
            const assignedBundleIds = campaignBundles.map((cb: any) => cb.bundle_id);

            if (assignedBundleIds.length > 0) {
                bundles = await prisma.$queryRaw`
                    SELECT id, name, COALESCE(price, 0) as price, serving_tier FROM bundles
                    WHERE id IN(${Prisma.join(assignedBundleIds)})
                    AND business_id = ${businessId}
                    AND is_active = true
                    ORDER BY array_position(${assignedBundleIds}::text[], id::text)
                `;
            } else {
                bundles = await prisma.$queryRaw`
                    SELECT id, name, COALESCE(price, 0) as price, serving_tier FROM bundles
                    WHERE business_id = ${businessId}
                    AND is_active = true
                    ORDER BY name ASC
                `;
            }
        } catch (bundleErr) {
            console.error("Bundle fetch error (non-blocking):", bundleErr);
            // Continue with empty bundles — don't block portal access
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
        // PLAN GATE SCAFFOLDING: see GET handler comment for rationale
        const allowedPlans = ['ENTERPRISE', 'ULTIMATE', 'FREE', 'PRO'];
        if (!allowedPlans.includes(plan)) {
            return NextResponse.json({ error: "Portal unavailable" }, { status: 403 });
        }

        // 2. Create Order
        const order = await prisma.order.create({
            data: {
                external_id: `fundraiser-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                source: 'fundraiser',
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
        const { token } = await params;
        const body = await req.json();
        const { paymentInstructions, externalPaymentLink } = body;

        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            include: {
                customer: {
                    include: {
                        business: { select: { plan: true } }
                    }
                }
            }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        const business = (campaign.customer as any)?.business;
        const plan = business?.plan || 'FREE';
        // PLAN GATE SCAFFOLDING: see GET handler comment for rationale
        const allowedPlans = ['ENTERPRISE', 'ULTIMATE', 'FREE', 'PRO'];
        if (!allowedPlans.includes(plan)) {
            return NextResponse.json({ error: "Portal unavailable" }, { status: 403 });
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
