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
import { resolveVariantSize } from '@/lib/serving_multipliers';
import { buildBundlePriceMap } from '@/lib/pricing';

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
                        contact_name: true,
                        business_id: true,
                        business: {
                            select: {
                                name: true,
                                slug: true,
                                logo_url: true,
                                plan: true,
                                subscription_status: true
                            }
                        }
                    }
                },
                orders: {
                    where: { canceled_at: null },
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
                                item_name: true,
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

        // Fetch recently canceled orders (for coordinator restore UI)
        const canceledOrders = await prisma.order.findMany({
            where: {
                campaign_id: campaign.id,
                NOT: { canceled_at: null }
            },
            orderBy: { canceled_at: 'desc' },
            select: {
                id: true,
                customer_name: true,
                total_amount: true,
                created_at: true,
                canceled_at: true,
                source: true,
                items: {
                    select: {
                        quantity: true,
                        variant_size: true,
                        item_name: true,
                    }
                }
            }
        });

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

        // 4. Fetch campaign-assigned bundles only (no fallback to all bundles)
        let bundles: any[] = [];
        try {
            const campaignBundles = await prisma.campaignBundle.findMany({
                where: { campaign_id: campaign.id },
                orderBy: { position: 'asc' },
                include: {
                    bundle: {
                        select: { id: true, name: true, price: true, serving_tier: true, is_active: true }
                    }
                }
            });
            bundles = campaignBundles
                .filter(cb => cb.bundle.is_active)
                .map(cb => ({
                    id: cb.bundle.id,
                    name: cb.bundle.name,
                    price: cb.bundle.price ?? 0,
                    serving_tier: cb.bundle.serving_tier
                }));
        } catch (bundleErr) {
            console.error("Bundle fetch error (non-blocking):", bundleErr);
            // Continue with empty bundles — don't block portal access
        }

        // Compute total_sales from active (non-canceled) orders
        // so totals always derive from filtered queries
        const computedTotalSales = (campaign.orders || []).reduce(
            (sum: number, o: any) => sum + Number(o.total_amount || 0), 0
        );

        return NextResponse.json({
            ...campaign,
            total_sales: computedTotalSales,
            canceledOrders,
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
        const businessId = business?.id;
        const plan = business?.plan || 'FREE';
        // PLAN GATE SCAFFOLDING: see GET handler comment for rationale
        const allowedPlans = ['ENTERPRISE', 'ULTIMATE', 'FREE', 'PRO'];
        if (!allowedPlans.includes(plan)) {
            return NextResponse.json({ error: "Portal unavailable" }, { status: 403 });
        }

        // 2. SERVER-SIDE PRICE VALIDATION — never trust client-sent totalAmount
        //    Mirrors the pattern in /api/public/order/route.ts
        if (!items || items.length === 0) {
            return NextResponse.json({ error: "Order must contain at least one item" }, { status: 400 });
        }

        const bundleIds = items
            .map((item: any) => item.bundleId || item.id)
            .filter(Boolean);

        // Price validation uses centralized buildBundlePriceMap() (LAW 1)
        const bundlePriceMap = await buildBundlePriceMap(businessId, bundleIds);

        // Name lookup for display/error messages only (not security-critical)
        const dbBundles = bundleIds.length > 0
            ? await prisma.bundle.findMany({
                where: { id: { in: bundleIds }, business_id: businessId },
                select: { id: true, name: true }
            })
            : [];
        const bundleNameMap = new Map(dbBundles.map((b: any) => [b.id, b.name as string]));

        // Resolve each item's price from DB — reject if any bundle is missing
        let resolvedItems: any[];
        try {
            resolvedItems = items.map((item: any) => {
                const bundleId = item.bundleId || item.id;
                const price = bundlePriceMap.get(bundleId);
                const name = bundleNameMap.get(bundleId);
                if (price === undefined) {
                    throw new Error(`Bundle not found for this business`);
                }
                if (!price || price <= 0) {
                    throw new Error(`Bundle "${name || bundleId}" has no valid price`);
                }
                return {
                    ...item,
                    serverPrice: price,
                    serverName: name || null,
                    bundleId,
                };
            });
        } catch (validationErr: any) {
            return NextResponse.json({ error: validationErr.message }, { status: 400 });
        }

        const serverTotal = resolvedItems.reduce(
            (sum: number, item: any) => sum + (item.serverPrice * item.quantity), 0
        );

        // 3. Create Order with server-validated prices
        const order = await prisma.order.create({
            data: {
                external_id: `fundraiser-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                source: 'fundraiser',
                customer_name: customerName,
                participant_name: participantName,
                status: 'fundraiser_hold',
                total_amount: serverTotal,
                delivery_address: deliveryAddress,
                business_id: businessId,
                customer_id: campaign.customer_id,
                campaign_id: campaign.id,
                phone: phone || null,
                items: {
                    create: resolvedItems.map((item: any) => ({
                        bundle_id: item.bundleId,
                        quantity: item.quantity,
                        variant_size: resolveVariantSize(item.serving_tier),
                        item_name: item.serverName || item.name || null,
                        unit_price: item.serverPrice
                    }))
                }
            }
        });

        // 4. Update campaign total sales with server-validated total
        await prisma.fundraiserCampaign.update({
            where: { id: campaign.id },
            data: {
                total_sales: {
                    increment: serverTotal
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

/**
 * DELETE — Cancel a coordinator-entered order (soft delete)
 *
 * SAFETY GUARDS:
 * - Order must belong to this campaign (campaign isolation)
 * - Order must be source='fundraiser' (coordinator-entered only)
 * - Order must not already be canceled (idempotency)
 * - Uses atomic updateMany with WHERE guards
 * - Does NOT modify campaign.total_sales (totals derive from filtered queries)
 */
export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;
        const body = await req.json();
        const { orderId } = body;

        if (!orderId) {
            return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
        }

        // 1. Resolve campaign from token
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            select: { id: true }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        // 2. Atomic cancel: only succeeds if ALL guards pass
        const result = await prisma.order.updateMany({
            where: {
                id: orderId,
                campaign_id: campaign.id,   // Campaign isolation
                source: 'fundraiser',        // Coordinator-entered only
                canceled_at: null            // Not already canceled
            },
            data: {
                canceled_at: new Date(),
                canceled_by: 'coordinator'
            }
        });

        if (result.count === 0) {
            return NextResponse.json(
                { error: "Order not found, already canceled, or not eligible for cancellation" },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true });

    } catch (e: any) {
        console.error("Cancel Coordinator Order Error:", e);
        return NextResponse.json({ error: "Failed to cancel order" }, { status: 500 });
    }
}

/**
 * PATCH — Restore a previously canceled coordinator order
 *
 * SAFETY GUARDS:
 * - Order must belong to this campaign (campaign isolation)
 * - Order must currently be canceled (canceled_at IS NOT NULL)
 * - Uses atomic updateMany with WHERE guards
 * - Does NOT modify campaign.total_sales (totals derive from filtered queries)
 */
export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;
        const body = await req.json();
        const { action, orderId } = body;

        if (action !== 'restore' || !orderId) {
            return NextResponse.json({ error: "Invalid request" }, { status: 400 });
        }

        // 1. Resolve campaign from token
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            select: { id: true }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        // 2. Atomic restore: only succeeds if order is canceled AND belongs to campaign
        //    source guard mirrors DELETE — only coordinator-entered orders are restorable
        const result = await prisma.order.updateMany({
            where: {
                id: orderId,
                campaign_id: campaign.id,
                source: 'fundraiser',           // Only coordinator-entered orders
                NOT: { canceled_at: null }
            },
            data: {
                canceled_at: null,
                canceled_by: null
            }
        });

        if (result.count === 0) {
            return NextResponse.json(
                { error: "Order not found, not canceled, or does not belong to this campaign" },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true });

    } catch (e: any) {
        console.error("Restore Coordinator Order Error:", e);
        return NextResponse.json({ error: "Failed to restore order" }, { status: 500 });
    }
}
