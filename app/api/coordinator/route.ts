/**
 * Coordinator Portal API
 *
 * ACCESS MODEL: Token-based (no auth session required)
 * - GET/POST/PUT gated by `portal_token` on FundraiserCampaign
 * - Token holder has coordinator-level access:
 *   GET  → view campaign details, privacy-filtered orders, available bundles
 *   POST → submit compiled fundraiser order on behalf of supporters
 *   PUT  → update coordinator payment settings (Venmo link, instructions)
 *   PATCH → restore a canceled order; or mark a supporter order paid / not
 *           paid (FR-SUPPORTER-PAYMENT-STATUS-1 — supporter -> coordinator
 *           money only, never the organization's invoice)
 * - COORD-FULFILLMENT-1 contact scope: the GET returns supporter name, email and
 *   phone for THIS SESSION'S CAMPAIGN ONLY, matching the supporter-facing
 *   disclosure ("name, email, and phone ... shared with your fundraiser
 *   coordinator"). Home address is never returned — fundraiser supporters are
 *   not delivered to individually; FundraiserCampaign.pickup_location is the
 *   fulfilment address. The campaign projection is an explicit allowlist and
 *   never carries portal_token.
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
import { resolveSoldVariantSize } from '@/lib/orderItemTier';
import { buildBundlePriceMap } from '@/lib/pricing';
import { resolveCampaignOrderMode, validateBundleEligibility } from '@/lib/campaignOrderBundles';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl, formatOrderDeadline } from '@/lib/previousSupporterInvite';
import { customerFacingBusinessName } from '@/lib/tenantBrand';
import { resolveMaterialBundles, groupMaterialMenus } from '@/lib/coordinatorMaterialBundles';
import { hasInvalidOrderQuantity } from '@/lib/orderQuantity';
import { SUPPORTER_ORDER_SELECT, toSupporterOrder } from '@/lib/coordinatorSupporterOrders';
import {
    CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT,
    resolveCampaignCoordinator,
    type CoordinatorAssignmentRow,
} from '@/lib/campaignCoordinatorContact';
import { normalizeSupporterEmail } from '@/lib/previousSupporters';
import { computeSupporterOrderTax } from '@/lib/fundraiserTax';
import { roundCents } from '@/lib/fundraiserCloseoutMath';
import {
    SUPPORTER_PAYMENT_EVENT_TYPES,
    coordinatorPaymentActor,
    explainNoopPaymentTransition,
    isSupporterPaymentAction,
    paymentOwnershipWhere,
    paymentTransitionData,
    paymentTransitionWhere,
    type SupporterPaymentAction,
} from '@/lib/supporterPayment';

/**
 * Phase 7E-1C: Returns true if the campaign has been server-closed.
 * Checks both the authoritative closed_at timestamp (set by the closeout
 * action in 7E-2) and the status string for forward-compatibility.
 * Used by POST, DELETE, and PATCH restore to block mutations on closed campaigns.
 *
 * FR-SUPPORTER-PAYMENT-STATUS-1: deliberately NOT applied to the PATCH payment
 * marks. Those change nothing closeout counts, and supporters routinely pay at
 * pickup — which is after closeout — so gating them here would disable the
 * feature on the one day a coordinator most needs it.
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

        // 1. Fetch the session's campaign.
        //
        // COORD-FULFILLMENT-1 — ALLOWLIST, NOT BLACKLIST.
        //
        // This used to be `include`, which returns every scalar on the row. That
        // shipped FundraiserCampaign.portal_token — the coordinator's live access
        // credential — into the browser on every portal load, where it sat in
        // React state and in any response the client logged or cached. The whole
        // point of FR-COORD-SEC-1B was to stop that credential travelling; a
        // response body is quieter than a URL but it is still transport.
        //
        // Every field below is one a coordinator surface actually reads. Adding a
        // field here is a deliberate act; nothing arrives by default. Deleting a
        // secret after the fact was rejected — the secret must never be fetched.
        let campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
            select: {
                id: true,
                name: true,
                status: true,
                end_date: true,
                delivery_date: true,
                delivery_time: true,
                closed_at: true,
                settlement_total: true,
                pickup_location: true,
                external_payment_link: true,
                payment_instructions: true,
                bundle_goal: true,
                total_sales: true,
                org_share_percent: true,
                participant_label: true,
                bundle_selection_status: true,
                bundle_selection_limit: true,
                // The PUBLIC scoreboard identifier (/fundraiser/<public_token>),
                // which the portal renders as a shareable link. Public by design
                // and by route: app/fundraiser/[token] resolves it with no auth.
                // NOT portal_token, which is the private access credential.
                public_token: true,
                // Server-side only: distinguishes a coordinator-entered order
                // (linked to the ORGANISATION) from a supporter's own order.
                // Removed from the response below.
                customer_id: true,
                customer: {
                    select: {
                        name: true,
                        contact_name: true,
                        // The ORGANIZATION's own on-file contact. FR-COORD-123
                        // originally described this as "THE recipient" of the
                        // new-order notification; FR-COORD-ROUTING-DATE-1 ended
                        // that — the campaign's ASSIGNED coordinator now wins,
                        // and this is only the fallback when a campaign has no
                        // assignment. Still selected because it IS that
                        // fallback (see resolveCampaignCoordinator below) and
                        // because the dashboard shows the organization's
                        // relationship contact in its own right. Not supporter PII.
                        contact_email: true,
                        business_id: true,
                        business: {
                            select: {
                                name: true,
                                // FR-SHARE-COPY-1: the tenant's customer-facing
                                // brand (lib/tenantBrand.customerFacingBusinessName)
                                // — never the internal Business.name alone.
                                display_name: true,
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
                // COORD-FULFILLMENT-2: the supporter-order shape is now owned by
                // lib/coordinatorSupporterOrders.ts and shared with the printable
                // pickup tracker and the XLSX pickup sheet, so the three surfaces
                // cannot describe the same supporter differently. It carries
                // contact (name/email/phone) and STILL EXCLUDES delivery_address —
                // fundraiser supporters are not delivered to individually; the
                // campaign's own pickup_location is the fulfilment address.
                //
                // NOTE the deliberate difference between this surface and the
                // pickup tracker: the LIVE tracker shows every commitment,
                // including orders still at fundraiser_hold. Only the pickup
                // manifest filters to released work.
                orders: {
                    where: { canceled_at: null },
                    orderBy: { created_at: 'desc' },
                    select: SUPPORTER_ORDER_SELECT,
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
            select: SUPPORTER_ORDER_SELECT,
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
        //
        // FR-TAX-CORRECTNESS-1 REVIEWED AND DELIBERATELY LEFT PRE-TAX. This is
        // a SALES figure, not a collection figure: it drives goal progress and
        // the "raised" display, and it is the same basis the organization's
        // share is computed on. Collected sales tax is not money the fundraiser
        // raised — it is money held for the taxing authority — so adding it
        // here would inflate progress toward a goal by an amount the
        // organization never gets. The per-order collection figure the
        // coordinator reconciles against cash is `amount_due`, supplied by
        // toSupporterOrder below.
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

        // FR-SHARE-COPY-1: the tenant's customer-facing brand — never the
        // internal Business.name alone, and never a hardcoded tenant name.
        const shareTenantDisplayName = business ? customerFacingBusinessName(business) : 'freezer meal';

        // FR-SHARE-COPY-1: the campaign's ACTUAL selected Bundle families,
        // de-duplicated (a Serves-5/Serves-2 sibling pair counts once), in
        // campaign selection order — the SAME authority the Order Tracker and
        // marketing materials already use (lib/coordinatorMaterialBundles),
        // never a second, independently-derived list. A legacy campaign has
        // no "selected" subset to speak of (its whole catalog is orderable),
        // so it gets an empty list rather than a misleading full-catalog dump;
        // callers omit the bundle section entirely in that case.
        let shareBundleFamilyNames: string[] = [];
        try {
            if (orderMode?.mode === 'selected') {
                const activeAssignments = await prisma.campaignBundle.findMany({
                    where: { campaign_id: campaign.id, state: 'active' },
                    orderBy: { position: 'asc' },
                    select: {
                        bundle: {
                            select: { id: true, name: true, price: true, serving_tier: true, family_id: true },
                        },
                    },
                });
                const resolved = resolveMaterialBundles(
                    activeAssignments.map(({ bundle: b }) => ({
                        id: b.id,
                        name: b.name,
                        price: b.price,
                        serving_tier: b.serving_tier,
                        family_id: b.family_id,
                    }))
                );
                if (resolved.ok) {
                    shareBundleFamilyNames = groupMaterialMenus(resolved.bundles).map((m) => m.baseName);
                }
            }
        } catch (shareBundleErr) {
            console.error('Share bundle-family resolution error (non-blocking):', shareBundleErr);
            // Share copy omits the bundle section rather than blocking portal access.
        }

        // FR-SHARE-COPY-1: coordinator identity for the share copy's "contact"
        // block. The ASSIGNED coordinator (FundraiserCampaignCoordinator, the
        // only durable record of "who agreed to run this fundraiser" — see
        // app/api/campaigns/[id]/coordinator-email/route.ts for the same
        // chain) wins when one exists and is still an active contact. Only
        // when no assignment exists does this fall back to Customer.contact_name/
        // contact_email — the org's own on-file contact, already shown
        // elsewhere on this same dashboard. Never invents a name or email.
        //
        // FR-COORD-ROUTING-DATE-1: this chain used to be written out inline
        // here, a second copy of the same rule. It now comes from the ONE
        // shared resolver in lib/campaignCoordinatorContact.ts, which the
        // supporter-order notification path also uses — so the dashboard can
        // no longer name one coordinator while the notifications go to another.
        let coordinatorAssignment: CoordinatorAssignmentRow | null = null;
        try {
            coordinatorAssignment = await prisma.fundraiserCampaignCoordinator.findUnique({
                where: { campaign_id: campaign.id },
                select: CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT,
            }) as CoordinatorAssignmentRow | null;
        } catch (coordErr) {
            console.error('Assigned-coordinator resolution error (non-blocking):', coordErr);
        }
        const campaignCoordinator = resolveCampaignCoordinator({
            assignment: coordinatorAssignment,
            organization: campaign.customer as any,
        });
        const shareCoordinatorName = campaignCoordinator.name;
        const shareCoordinatorEmail = campaignCoordinator.email;

        // FR-SHARE-COPY-1: pickup/delivery logistics, only the facts actually
        // configured — never "TBD" or an invented value. Distinct from the
        // supporter ORDER deadline (end_date) above.
        const sharePickupDeliveryLines: string[] = [];
        const shareDeliveryDateLabel = formatOrderDeadline((campaign as any).delivery_date ?? null);
        if (shareDeliveryDateLabel) sharePickupDeliveryLines.push(`Date: ${shareDeliveryDateLabel}`);
        const shareDeliveryTime = ((campaign as any).delivery_time ?? '').trim();
        if (shareDeliveryTime) sharePickupDeliveryLines.push(`Time: ${shareDeliveryTime}`);
        const sharePickupLocation = ((campaign as any).pickup_location ?? '').trim();
        if (sharePickupLocation) sharePickupDeliveryLines.push(`Location: ${sharePickupLocation}`);

        // COORD-FULFILLMENT-2: the supporter projection — including the rule
        // deciding whether a linked email is truthfully the supporter's rather
        // than the organisation's own inbox — is owned by
        // lib/coordinatorSupporterOrders.ts and shared with the pickup tracker.
        // It drops the `customer` / `customer_id` working fields, so neither
        // reaches the client.
        const shapeOrder = (o: any) => toSupporterOrder(o, campaign.customer_id);

        // customer_id is fetched for that rule and is not part of the
        // coordinator's payload.
        const { customer_id: _campaignCustomerId, ...campaignResponse } = campaign as any;

        return NextResponse.json({
            ...campaignResponse,
            orders: (campaign.orders || []).map(shapeOrder),
            total_sales: computedTotalSales,
            canceledOrders: canceledOrders.map(shapeOrder),
            availableBundles: bundles,
            orderMode,
            share: {
                orderUrl: shareOrderUrl,
                deadlineLabel: shareDeadlineLabel,
                tenantDisplayName: shareTenantDisplayName,
                bundleFamilyNames: shareBundleFamilyNames,
                coordinatorName: shareCoordinatorName,
                coordinatorEmail: shareCoordinatorEmail,
                pickupDeliveryLines: sharePickupDeliveryLines,
            },
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

        // OPS-1: every quantity must be a positive integer, validated before any
        // total is computed or any Order/OrderItem write occurs. Coordinator orders
        // previously reached the database with no quantity check at all — a
        // zero-or-malformed quantity is exactly how an order can leave campaign
        // closeout unable to reconcile (lib/fundraiserCloseoutMath.ts). Same
        // predicate the public order route uses (lib/orderQuantity.ts), so the two
        // paths can never drift into two different rules.
        if (hasInvalidOrderQuantity(items)) {
            return NextResponse.json({
                error: 'Every item quantity must be a positive integer',
                code: 'INVALID_QUANTITY',
            }, { status: 400 });
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

        // Name lookup for display/error messages only (not security-critical).
        // FULFILLMENT-CONTINUITY-1: this same tenant-scoped row now also supplies
        // the serving tier, which IS security-critical — see bundleTierMap below.
        const dbBundles = bundleIds.length > 0
            ? await prisma.bundle.findMany({
                where: { id: { in: bundleIds }, business_id: businessId },
                select: { id: true, name: true, serving_tier: true }
            })
            : [];
        const bundleNameMap = new Map(dbBundles.map((b: any) => [b.id, b.name as string]));

        // FULFILLMENT-CONTINUITY-1 — the menu defines what was sold.
        // The tier comes from the tenant-scoped Bundle row, never from the
        // request body: variant_size drives the kitchen's ingredient multiplier,
        // so a client that could set it could make the kitchen cook a Serves-2
        // bundle at the Serves-5 rate. Price was already server-authoritative
        // (buildBundlePriceMap above); this makes tier agree.
        const bundleTierMap = new Map(dbBundles.map((b: any) => [b.id, b.serving_tier as string | null]));

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

        // FR-TAX-CORRECTNESS-1: pre-tax food subtotal, from server prices only.
        const serverSubtotal = roundCents(resolvedItems.reduce(
            (sum: number, item: any) => sum + (item.serverPrice * item.quantity), 0
        ));

        // A coordinator-entered order is the SAME sale as a supporter's own
        // order and must carry the same tax, from the same frozen campaign
        // snapshot. Leaving this path untaxed would under-bill the organization
        // at closeout by exactly the tax on every paper order it collected.
        const orderTax = computeSupporterOrderTax({
            subtotal: serverSubtotal,
            snapshot: {
                status: (campaign as any).tax_status ?? null,
                ratePercent: (campaign as any).tax_rate_percent ?? null,
            },
        });

        // total_amount stays PRE-TAX (see lib/fundraiserTax.ts supporterAmountDue).
        const serverTotal = serverSubtotal;

        // COORD-MANUAL-EMAIL-1B: goes on Order.email, never Customer.contact_email —
        // customer_id below is the campaign's own organization, shared by every
        // manual order, so writing here would overwrite the org's own address.
        const normalizedEmail = normalizeSupporterEmail(email);

        // 3. Create Order with server-validated prices
        const order = await prisma.order.create({
            data: {
                external_id: `fundraiser-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                source: 'fundraiser',
                customer_name: customerName,
                participant_name: participantName,
                status: 'fundraiser_hold',
                total_amount: serverTotal,
                // FR-TAX-CORRECTNESS-1: frozen alongside the total, so closeout
                // sums what was actually charged instead of re-deriving it.
                tax_amount: orderTax.taxAmount,
                delivery_address: deliveryAddress,
                business_id: businessId,
                customer_id: campaign.customer_id,
                campaign_id: campaign.id,
                phone: phone || null,
                email: normalizedEmail || null,
                items: {
                    create: resolvedItems.map((item: any) => ({
                        bundle_id: item.bundleId,
                        quantity: item.quantity,
                        variant_size: resolveSoldVariantSize(bundleTierMap.get(item.bundleId), item.serving_tier),
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
                // Every CAMPAIGN order — the public supporter route and the
                // coordinator's + Add Order route both write 'fundraiser'. (This
                // said 'Coordinator-entered only', which was never true.)
                source: 'fundraiser',
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
 * FR-SUPPORTER-PAYMENT-STATUS-1 — record that a supporter paid their
 * coordinator (mark_paid), or take that record back (mark_unpaid).
 *
 * WHAT IT CAN CHANGE: Order.paid_at and Order.paid_by. Nothing else. The data
 * object comes from lib/supporterPayment.ts paymentTransitionData, whose exact
 * key set is pinned by tests — amounts, tax, items, status and the invoice link
 * are unreachable from here.
 *
 * WHAT IT NEVER TOUCHES: the organization's invoice to My Freezer Chef, the
 * campaign's sales total, closeout, organization share, tax. Those read none of
 * these columns.
 *
 * AUTHORITY: the coordinator session (campaignId is never taken from the
 * request), then an atomic conditional update whose WHERE carries the order id,
 * that campaign, `source: 'fundraiser'`, not-canceled and the current paid
 * state. An order in another campaign matches nothing and is answered exactly
 * like one that does not exist.
 *
 * AUDIT: exactly one CoordinatorActionEvent per real transition, written in the
 * same transaction as the update — so a mark without its event, or an event
 * without its mark, cannot exist. A repeat tap changes nothing and logs nothing.
 *
 * No closed-campaign gate, on purpose: see isCampaignClosed.
 */
async function markSupporterPayment(
    action: SupporterPaymentAction,
    rawOrderId: unknown,
    campaignId: string,
    sessionId: string,
): Promise<NextResponse> {
    const orderId = typeof rawOrderId === 'string' ? rawOrderId.trim() : '';
    if (!orderId) {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const scope = { orderId, campaignId };
    const now = new Date();
    const actor = coordinatorPaymentActor(sessionId);

    // Who was ASSIGNED to run this campaign when the mark was made — context
    // for a tenant reading the event later. It is deliberately recorded as the
    // assignment, not as "who clicked": a coordinator session identifies no
    // person, so claiming more would be an identity the system cannot prove.
    // Never allowed to block the mark itself.
    let assignedCoordinatorName: string | null = null;
    try {
        const assignment = await prisma.fundraiserCampaignCoordinator.findUnique({
            where: { campaign_id: campaignId },
            select: CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT,
        }) as CoordinatorAssignmentRow | null;
        assignedCoordinatorName = resolveCampaignCoordinator({ assignment, organization: null }).name;
    } catch (lookupErr) {
        console.error('[FR-SUPPORTER-PAYMENT-STATUS-1] coordinator context lookup failed (non-blocking):', lookupErr);
    }

    const changed = await prisma.$transaction(async (tx) => {
        const updated = await tx.order.updateMany({
            where: paymentTransitionWhere(action, scope),
            data: paymentTransitionData(action, { now, actor }),
        });
        if (updated.count !== 1) return false;

        await tx.coordinatorActionEvent.create({
            data: {
                campaign_id: campaignId,
                action_type: SUPPORTER_PAYMENT_EVENT_TYPES[action],
                source: null,
                metadata: {
                    actorType: 'coordinator',
                    actorId: null,
                    sessionId,
                    channel: 'coordinator_portal',
                    orderId,
                    assignedCoordinatorName,
                    ...(action === 'mark_paid' ? { paidAt: now.toISOString() } : {}),
                },
            },
        });
        return true;
    });

    if (changed) {
        return NextResponse.json({
            success: true,
            changed: true,
            paid_at: action === 'mark_paid' ? now.toISOString() : null,
        });
    }

    // Zero rows. Explain it without ever widening the ownership scope.
    const row = await prisma.order.findFirst({
        where: paymentOwnershipWhere(scope),
        select: { paid_at: true },
    });
    const outcome = explainNoopPaymentTransition(action, row);

    if (outcome === 'already_in_state') {
        // A repeat tap or a second device. The coordinator's intent is already
        // true; say so, and report the state that actually stands.
        return NextResponse.json({ success: true, changed: false, paid_at: row?.paid_at ?? null });
    }
    if (outcome === 'conflict') {
        return NextResponse.json(
            { error: 'This order was just updated. Refresh and try again.' },
            { status: 409 },
        );
    }
    return NextResponse.json(
        { error: 'Order not found, canceled, or not part of this fundraiser.' },
        { status: 404 },
    );
}

/**
 * PATCH — Restore a previously canceled coordinator order, or (see
 * markSupporterPayment above) mark a supporter order paid / not paid.
 *
 * RESTORE SAFETY GUARDS:
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

        // FR-SUPPORTER-PAYMENT-STATUS-1: payment marks branch off here, BEFORE
        // the restore path and its closed-campaign gate — see isCampaignClosed.
        // They share this route's session guard and nothing else.
        if (isSupporterPaymentAction(action)) {
            return await markSupporterPayment(action, orderId, campaignId, guard.sessionId);
        }

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
        //    source guard mirrors DELETE — every campaign order (both order routes
        //    write 'fundraiser'), not only coordinator-entered ones as this once said
        const result = await prisma.order.updateMany({
            where: {
                id: orderId,
                campaign_id: campaign.id,
                source: 'fundraiser',           // Every campaign order (see DELETE)
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
