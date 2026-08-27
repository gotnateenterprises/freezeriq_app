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
import { resolveCampaignOrderMode, validateBundleEligibility } from '@/lib/campaignOrderBundles';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl, formatOrderDeadline } from '@/lib/previousSupporterInvite';

/**
 * Phase 7E-1C: Returns true if the campaign has been server-closed.
 * Checks both the authoritative closed_at timestamp (set by the closeout
 * action in 7E-2) and the status string for forward-compatibility.
 * Used by POST, DELETE, and PATCH to block mutations on closed campaigns.
 */
function isCampaignClosed(campaign: any): boolean {
    return Boolean(campaign.closed_at) || campaign.status === 'Closed';
}

/**
 * PLAN GATE SCAFFOLDING — the plans whose coordinators may use the portal.
 *
 * The rule this encodes is unchanged and is stated at each call site: fundraising
 * is available on EVERY known tier today, and the gate exists to block a business
 * with a null, empty or unrecognised plan. When CONSTITUTION §5 plan-gating
 * lands, this is the one place to narrow to paid tiers.
 *
 * ── WHY THIS IS NOW A CONSTANT ──────────────────────────────────────────────
 *
 * It was three hand-written copies of the same literal in this file, and all
 * three had drifted from the rule they claim to implement: they listed four of
 * the five SubscriptionPlan values, omitting BASE — which is the SCHEMA DEFAULT
 * (prisma/schema.prisma: `plan SubscriptionPlan @default(BASE)`). Every business
 * created without an explicit plan is therefore BASE, and its coordinators were
 * answered "Portal unavailable (Plan Restriction)" 403 on the portal GET, the
 * order POST and the settings PUT alike.
 *
 * The omission was drift rather than commercial intent. BASE has been in the
 * enum since the initial commit, this list was written much later and never
 * contained it, and BASE is a PAID tier (lib/stripe.ts maps it to
 * STRIPE_PRICE_BASE) while FREE — which the list DOES allow — has no price at
 * all. Excluding BASE while admitting FREE is backwards under the current rule
 * and under the future paid-tiers-only one.
 *
 * Listing all five is not "allow anything": an unknown, null or empty plan still
 * fails the check, which is the only thing this gate was ever doing.
 */
export const COORDINATOR_PORTAL_PLANS = ['FREE', 'BASE', 'PRO', 'ULTIMATE', 'ENTERPRISE'] as const;

export function planAllowsCoordinatorPortal(plan: unknown): boolean {
    return typeof plan === 'string' && (COORDINATOR_PORTAL_PLANS as readonly string[]).includes(plan);
}

export async function GET(req: Request) {
    try {
        // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;

        // 1. Fetch Campaign with Business Info by portal_token (private coordinator access)
        let campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
            include: {
                customer: {
                    select: {
                        name: true,
                        contact_name: true,
                        // FR-COORD-123: the address the new-order notification
                        // actually goes to (lib/email.ts — Customer.contact_email
                        // is THE recipient). Shown to the coordinator so the
                        // dashboard's promise names a real inbox. This is the
                        // org's own contact, not supporter PII.
                        contact_email: true,
                        business_id: true,
                        business: {
                            select: {
                                name: true,
                                slug: true,
                                // FR-COORD-123: the canonical share URL prefers
                                // the tenant's storefront domain, exactly like
                                // the FR-REBOOK-2 invitation.
                                custom_domain: true,
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
            console.warn('Coordinator GET: session resolved to no campaign');
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

        // PLAN GATE SCAFFOLDING: allows all known plans — fundraising is
        // available on every tier today — and blocks a null, empty or
        // unrecognised plan. The list and the reason it now includes BASE live
        // on COORDINATOR_PORTAL_PLANS above; narrowing to paid tiers under
        // CONSTITUTION §5 is a change in that one place.
        if (!planAllowsCoordinatorPortal(plan)) {
            return NextResponse.json({ error: "Portal unavailable (Plan Restriction)" }, { status: 403 });
        }

        // 4. Determine ordering mode and fetch orderable bundles
        let bundles: any[] = [];
        type CampaignOrderBundleMode = Awaited<ReturnType<typeof resolveCampaignOrderMode>>;
        let orderMode: CampaignOrderBundleMode | null = null;
        try {
            orderMode = await resolveCampaignOrderMode(campaign, businessId);

            if (orderMode.allowed) {
                if (orderMode.mode === 'legacy') {
                    // Fall back to business-wide catalog for legacy campaigns
                    const legacyBundles = await prisma.bundle.findMany({
                        where: { business_id: businessId, is_active: true, show_on_storefront: true },
                        orderBy: { name: 'asc' },
                        select: { id: true, name: true, price: true, serving_tier: true }
                    });
                    bundles = legacyBundles.map(b => ({
                        ...b,
                        price: b.price ?? 0
                    }));
                } else if (orderMode.mode === 'selected' && orderMode.activeOrderableBundleIds.length > 0) {
                    const selectedBundles = await prisma.bundle.findMany({
                        where: { id: { in: orderMode.activeOrderableBundleIds } },
                        select: { id: true, name: true, price: true, serving_tier: true }
                    });

                    // Maintain original order based on activeOrderableBundleIds
                    type SelectedBundle = typeof selectedBundles[number];
                    bundles = orderMode.activeOrderableBundleIds
                        .map((id: string) => selectedBundles.find(b => b.id === id))
                        .filter((b): b is SelectedBundle => b !== undefined)
                        .map((b: SelectedBundle) => ({
                            id: b.id,
                            name: b.name,
                            price: b.price ?? 0,
                            serving_tier: b.serving_tier
                        }));
                }
            }
        } catch (bundleErr) {
            console.error("Bundle fetch error (non-blocking):", bundleErr);
            // Continue with empty bundles — don't block portal access
        }

        // Compute total_sales from active (non-canceled) orders
        // so totals always derive from filtered queries
        const computedTotalSales = (campaign.orders || []).reduce(
            (sum: number, o: any) => sum + Number(o.total_amount || 0), 0
        );

        // FR-COORD-123: the canonical supporter ordering URL, resolved
        // SERVER-SIDE through the same authority as the FR-REBOOK-2 invitation
        // and the printed materials — tenant storefront domain preferred,
        // pinned platform origin otherwise, never whichever host happened to
        // serve this request. Every share action on the dashboard uses this
        // one value, so a coordinator cannot hand out a preview or stale URL.
        const shareOrderUrl = buildSupporterOrderUrl(
            resolveOutreachOrigin(req),
            { id: campaign.id, public_token: campaign.public_token },
            {
                customDomain: (business as any)?.custom_domain ?? null,
                slug: business?.slug ?? null,
            },
        );
        // The CURRENT campaign's deadline, formatted without a timezone shift
        // (same helper as the invitation email). Null when the campaign has no
        // usable end_date — the share copy then omits the sentence.
        const shareDeadlineLabel = formatOrderDeadline(campaign.end_date);

        return NextResponse.json({
            ...campaign,
            total_sales: computedTotalSales,
            canceledOrders,
            availableBundles: bundles,
            orderMode,
            share: { orderUrl: shareOrderUrl, deadlineLabel: shareDeadlineLabel },
        });

    } catch (e: any) {
        console.error("Fetch Coordinator Portal Error:", e);
        return NextResponse.json({ error: "Failed to fetch portal data" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;
        const body = await req.json();
        const { customerName, items, totalAmount, deliveryAddress, participantName, email, phone } = body;

        // 1. Fetch Campaign & Check Plan
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
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
        if (!planAllowsCoordinatorPortal(plan)) {
            return NextResponse.json({ error: "Portal unavailable" }, { status: 403 });
        }

        // Phase 7E-1C: Block order creation on closed campaigns.
        // Checked after plan gate and before any item validation or DB writes.
        if (isCampaignClosed(campaign)) {
            return NextResponse.json(
                { error: 'Campaign is closed. Contact the organizer to add a late order.' },
                { status: 400 }
            );
        }

        // 2. SERVER-SIDE PRICE VALIDATION — never trust client-sent totalAmount
        //    Mirrors the pattern in /api/public/order/route.ts
        if (!items || items.length === 0) {
            return NextResponse.json({ error: "Order must contain at least one item" }, { status: 400 });
        }

        const bundleIds = items
            .map((item: any) => item.bundleId || item.id)
            .filter(Boolean);

        // CB-5: Campaign-level bundle eligibility enforcement.
        // Must run BEFORE buildBundlePriceMap, order creation, or any side effect.
        // Derives bundle_selection_status from the server-trusted campaign object.
        const bundleMode = await resolveCampaignOrderMode(
            campaign,
            businessId
        );
        const eligibility = validateBundleEligibility(bundleMode, bundleIds);
        if (!eligibility.ok) {
            return NextResponse.json({ error: eligibility.error }, { status: eligibility.status });
        }

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

export async function PUT(req: Request) {
    try {
        // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;
        const body = await req.json();
        const { paymentInstructions, externalPaymentLink } = body;

        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
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
        if (!planAllowsCoordinatorPortal(plan)) {
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
export async function DELETE(req: Request) {
    try {
        // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;
        const body = await req.json();
        const { orderId } = body;

        if (!orderId) {
            return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
        }

        // 1. Resolve campaign from token
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
            // Phase 7E-1C: also fetch closed_at and status for the closed-campaign gate below
            select: { id: true, closed_at: true, status: true }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        // Phase 7E-1C: Block order cancellation on closed campaigns.
        // Checked before updating canceled_at so no partial write occurs.
        if (isCampaignClosed(campaign)) {
            return NextResponse.json(
                { error: 'Campaign is closed. Order changes are no longer permitted.' },
                { status: 400 }
            );
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
export async function PATCH(req: Request) {
    try {
        // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;
        const body = await req.json();
        const { action, orderId } = body;

        if (action !== 'restore' || !orderId) {
            return NextResponse.json({ error: "Invalid request" }, { status: 400 });
        }

        // 1. Resolve campaign from token
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
            // Phase 7E-1C: also fetch closed_at and status for the closed-campaign gate below
            select: { id: true, closed_at: true, status: true }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Portal not found" }, { status: 404 });
        }

        // Phase 7E-1C: Block order restoration on closed campaigns.
        // Checked before restoring canceled_at so no partial write occurs.
        if (isCampaignClosed(campaign)) {
            return NextResponse.json(
                { error: 'Campaign is closed. Order changes are no longer permitted.' },
                { status: 400 }
            );
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
