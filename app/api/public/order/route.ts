import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveVariantSize, getServingMultiplier } from '@/lib/serving_multipliers';
import { buildBundlePriceMap, findInactiveBundleNames } from '@/lib/pricing';
import { resolveCampaignOrderMode, validateBundleEligibility } from '@/lib/campaignOrderBundles';
import { isCampaignClosed, isCampaignPastOrderDeadline } from '@/lib/campaignBundleSelection';
import { lockCampaignSelection } from '@/lib/campaignSelectionLock';
import { isValidIanaTimeZone } from '@/lib/tenantTimezone';
import { validateSubmissionKey, buildSubmissionFingerprint } from '@/lib/orderIdempotency';
import { normalizeSlug, NO_SUCH_SLUG } from '@/lib/publicIdentity';
import { purchaserDisplayName } from '@/lib/purchaserName';

/**
 * FR-LAUNCH-1E: sentinel used to abort the order transaction when the campaign
 * was closed between the preflight checks and the insert. Thrown inside the
 * transaction so every write rolls back together, then translated to a safe
 * public response outside it.
 */
class CampaignClosedError extends Error {
    constructor() {
        super('CAMPAIGN_CLOSED');
        this.name = 'CampaignClosedError';
    }
}

/**
 * FR-FLOW-3 — the campaign's sellable bundles changed between the preflight and
 * this insert, so the basket no longer matches what the fundraiser offers.
 *
 * Identified by a marker field rather than `instanceof`. Subclassing a built-in
 * loses the prototype link when the class is downlevelled, and this repository
 * compiles at an ES5 target — an `instanceof` here would silently stop matching
 * and send a routine conflict down the 500 path.
 */
class BundleSelectionChangedError extends Error {
    readonly isBundleSelectionChanged = true as const;
    constructor() {
        super('BUNDLE_SELECTION_CHANGED');
        this.name = 'BundleSelectionChangedError';
    }
}

function isBundleSelectionChanged(e: unknown): e is BundleSelectionChangedError {
    return typeof e === 'object' && e !== null && (e as any).isBundleSelectionChanged === true;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { items, customer, slug, campaignId } = body;

        if (!items || items.length === 0) {
            return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
        }

        // FR-LAUNCH-1A: every quantity must be a positive integer. Validated up
        // front — before totals, customer/order creation, or inventory decrement —
        // and never silently coerced, rounded, dropped, or defaulted. A single bad
        // quantity rejects the whole request.
        const hasInvalidQuantity = items.some((item: any) =>
            typeof item?.quantity !== 'number' ||
            !Number.isFinite(item.quantity) ||
            !Number.isInteger(item.quantity) ||
            item.quantity <= 0
        );
        if (hasInvalidQuantity) {
            return NextResponse.json({
                error: 'Every item quantity must be a positive integer',
                code: 'INVALID_QUANTITY',
            }, { status: 400 });
        }

        // FR-SUPPORTER-CONTACT-1: separate First Name / Last Name, never a single
        // ambiguous "Full Name" — the field this replaced sat directly next to
        // Phone in the checkout form and was mistaken for it in practice.
        //
        // FR-SUPPORTER-CONTACT-1A — OWNER RULING: all four are now required.
        // A coordinator following up on payment, pickup/delivery, or a
        // fulfillment question needs both a name they can act on and both ways
        // to reach the purchaser. Checked by NAMED property, independently of
        // the client's own canSubmit gate — a caller invoking this route
        // directly cannot bypass the browser form's requirement. Each check is
        // `typeof === 'string'` before `.trim()`, matching the strictness the
        // quantity check above already uses, so a non-string value fails the
        // same as a missing one rather than throwing.
        if (!customer || typeof customer !== 'object') {
            return NextResponse.json({ error: 'Customer details required' }, { status: 400 });
        }
        const missingContactFields: string[] = [];
        if (typeof customer.firstName !== 'string' || !customer.firstName.trim()) missingContactFields.push('First name');
        if (typeof customer.lastName !== 'string' || !customer.lastName.trim()) missingContactFields.push('Last name');
        if (typeof customer.email !== 'string' || !customer.email.trim()) missingContactFields.push('Email');
        if (typeof customer.phone !== 'string' || !customer.phone.trim()) missingContactFields.push('Phone number');
        if (missingContactFields.length > 0) {
            return NextResponse.json({
                error: `${missingContactFields.join(', ')} ${missingContactFields.length === 1 ? 'is' : 'are'} required`,
                code: 'CONTACT_INFO_REQUIRED',
                missingFields: missingContactFields,
            }, { status: 400 });
        }

        if (!slug || typeof slug !== 'string') {
            return NextResponse.json({ error: "Store identifier required" }, { status: 400 });
        }

        // The ONE place first/last combine into a display string — every
        // downstream write below (Customer.name, Order.customer_name, the lead
        // notification) uses this SAME value, never its own concatenation.
        const purchaserFirstName = String(customer.firstName ?? '').trim();
        const purchaserLastName = String(customer.lastName ?? '').trim();
        const purchaserName = purchaserDisplayName(purchaserFirstName, purchaserLastName);

        // FR-LAUNCH-1E: validate the optional submission key BEFORE any database
        // work. Phased rollout — a MISSING key stays backward-compatible (the
        // order is created without idempotency protection); a key that is
        // PRESENT but malformed is rejected, so a broken client can never
        // silently lose protection it believes it has.
        const keyResult = validateSubmissionKey(body?.submissionKey);
        if (!keyResult.ok) {
            return NextResponse.json({
                error: 'A valid submission key is required.',
                code: 'INVALID_SUBMISSION_KEY',
            }, { status: 400 });
        }
        const submissionKey = keyResult.key;

        // 1. Resolve Business from slug (server-trusted, never from client businessId)
        const business = await prisma.business.findFirst({
            // FR-PUBLIC-IDENTITY-1: literal slug, never a LIKE pattern.
            where: { slug: normalizeSlug(slug) ?? NO_SUCH_SLUG }
        });

        if (!business) {
            return NextResponse.json({ error: "Business not found" }, { status: 404 });
        }

        const businessId = business.id;

        // CB-5: Resolve campaign BEFORE price validation to enforce bundle eligibility.
        // For non-campaign (direct storefront) orders, campaignId is absent and this
        // block is skipped — preserving the existing storefront flow exactly.
        type CampaignWithCustomer = Prisma.FundraiserCampaignGetPayload<{ include: { customer: true } }>;
        let campaign: CampaignWithCustomer | null = null;
        let orgContactEmail: string | null = null;
        let paymentInstructions: string | null = null;
        let externalPaymentLink: string | null = null;
        let orgName: string | null = null;

        // FR-LAUNCH-1A: campaign behavior is driven by a campaign the SERVER
        // resolved and owns — never by the presence of a client-supplied id. A
        // supplied-but-unresolvable campaignId is a hard 404 so a raw, unverified
        // value can never reach Order.campaign_id.
        if (campaignId !== undefined && campaignId !== null) {
            if (typeof campaignId !== 'string' || campaignId.trim().length === 0) {
                return NextResponse.json({
                    error: 'Campaign not found',
                    code: 'CAMPAIGN_NOT_FOUND',
                }, { status: 404 });
            }

            campaign = await prisma.fundraiserCampaign.findUnique({
                where: { id: campaignId.trim() },
                include: { customer: true }
            });

            // Missing campaign and wrong-tenant campaign are treated identically,
            // so campaign ownership is never disclosed across businesses.
            if (!campaign || campaign.customer?.business_id !== businessId) {
                return NextResponse.json({
                    error: 'Campaign not found',
                    code: 'CAMPAIGN_NOT_FOUND',
                }, { status: 404 });
            }

            paymentInstructions = campaign.payment_instructions;
            externalPaymentLink = campaign.external_payment_link;
            orgName = campaign.customer?.name || null;

            if (campaign.customer?.contact_email) {
                orgContactEmail = campaign.customer.contact_email;
            }
        }

        // Single server-authoritative condition used for every campaign branch below.
        const isCampaignOrder = campaign !== null;

        // Extract bundle IDs for validation and pricing (excludes manual_upsell sentinel)
        const bundleIds = items
            .filter((item: any) => item.bundleId && item.bundleId !== 'manual_upsell')
            .map((item: any) => item.bundleId);

        // CB-5: Campaign-level bundle eligibility enforcement.
        // Must run BEFORE buildBundlePriceMap, order creation, payment, or email.
        // Non-campaign orders skip this (no campaignId → no campaign → no gate).
        if (campaign) {
            // Supporter submission, so the ordering deadline applies. The zone
            // is the server-resolved Business row — never anything the client sent.
            const bundleMode = await resolveCampaignOrderMode(
                campaign,
                businessId,
                business.timezone
            );
            const eligibility = validateBundleEligibility(bundleMode, bundleIds);
            if (!eligibility.ok) {
                return NextResponse.json({ error: eligibility.error }, { status: eligibility.status });
            }
        }

        // 1.5 SERVER-SIDE PRICE VALIDATION — never trust client prices
        //     Uses centralized buildBundlePriceMap() from lib/pricing.ts (LAW 1)
        // A deactivated bundle is no longer sellable. It is filtered out of the
        // storefront payload, but a stale tab or a hand-edited request can still
        // carry its id here, so refuse it at the server rather than trusting that
        // the customer only ever saw eligible bundles.
        const inactiveNames = await findInactiveBundleNames(businessId, bundleIds);
        if (inactiveNames.length > 0) {
            return NextResponse.json({
                error: `${inactiveNames.join(', ')} ${inactiveNames.length === 1 ? 'is' : 'are'} no longer available. Please remove ${inactiveNames.length === 1 ? 'it' : 'them'} from your bag.`,
            }, { status: 400 });
        }

        const bundlePriceMap = await buildBundlePriceMap(businessId, bundleIds);

        let manualUpsellPrice: number | null = null;
        const hasManualUpsell = items.some((item: any) => item.bundleId === 'manual_upsell');
        if (hasManualUpsell) {
            const sfConfig = await prisma.storefrontConfig.findUnique({
                where: { business_id: businessId },
                select: { manual_upsell_price: true }
            });
            manualUpsellPrice = sfConfig?.manual_upsell_price ? Number(sfConfig.manual_upsell_price) : null;
        }

        // Resolve each item's price from DB — reject if no valid price
        let resolvedItems: any[];
        try {
            resolvedItems = items.map((item: any) => {
                let serverPrice: number;

                if (item.bundleId === 'manual_upsell') {
                    if (manualUpsellPrice === null || manualUpsellPrice <= 0) {
                        throw new Error(`Upsell item "${item.name}" has no valid price configured`);
                    }
                    serverPrice = manualUpsellPrice;
                } else if (item.bundleId) {
                    const dbPrice = bundlePriceMap.get(item.bundleId);
                    if (dbPrice === undefined) {
                        throw new Error(`Bundle not found for this business`);
                    }
                    if (!dbPrice || dbPrice <= 0) {
                        throw new Error(`Bundle "${item.name}" has no valid price`);
                    }
                    serverPrice = dbPrice;
                } else {
                    throw new Error(`Item "${item.name}" has no bundle reference`);
                }

                return { ...item, serverPrice };
            });
        } catch (validationErr: any) {
            return NextResponse.json({ error: validationErr.message }, { status: 400 });
        }

        const serverTotal = resolvedItems.reduce(
            (sum: number, item: any) => sum + (item.serverPrice * item.quantity), 0
        );

        // FR-LAUNCH-1E: fingerprint of the LOGICAL order payload. Server prices are
        // deliberately excluded — pricing stays server-authoritative, and a client
        // price is never treated as meaningful identity input.
        const submissionFingerprint = submissionKey
            ? buildSubmissionFingerprint({
                slug,
                campaignId: campaign ? campaign.id : null,
                customerEmail: customer.email,
                customerName: purchaserName,
                participantName: customer.participantCode,
                items: resolvedItems.map((item: any) => ({
                    bundleId: item.bundleId,
                    quantity: item.quantity,
                    serving_tier: item.serving_tier,
                })),
            })
            : null;

        // The public success response is built identically for a first creation and
        // for a replay, so the two are byte-compatible.
        const buildSuccessResponse = (persistedOrder: { id: string; total_amount: any }) =>
            NextResponse.json({
                success: true,
                orderId: persistedOrder.id,
                // FR-LAUNCH-1B: response-only addition. The server-authoritative total
                // as PERSISTED on the order row — never a client-supplied value — so a
                // confirmation screen can show the same amount the coordinator will
                // collect. No order-creation, pricing, or side-effect behavior changes.
                total: Number(persistedOrder.total_amount),
                paymentData: {
                    paymentInstructions,
                    externalPaymentLink,
                    orgName
                }
            });

        // FR-LAUNCH-1E: replay fast path. A non-authoritative optimization only —
        // the partial unique index on (business_id, submission_key) remains the
        // actual guarantee, enforced below. Scoped by the server-resolved
        // businessId, so one tenant's key can never surface another tenant's order.
        if (submissionKey) {
            const existing = await prisma.order.findFirst({
                where: { business_id: businessId, submission_key: submissionKey } as any,
                select: { id: true, total_amount: true, submission_fingerprint: true } as any,
            }) as any;

            if (existing) {
                if (existing.submission_fingerprint !== submissionFingerprint) {
                    return NextResponse.json({
                        error: 'This order could not be processed. Please refresh and try again.',
                        code: 'SUBMISSION_CONFLICT',
                    }, { status: 409 });
                }
                console.log(`[FR-1E] Replayed submission for order ${existing.id} (no writes, no email)`);
                return buildSuccessResponse(existing);
            }
        }

        const formattedAddress = customer.address ? `${customer.address}, ${customer.city}, ${customer.state} ${customer.zip}` : null;

        // ── FR-LAUNCH-1E: single atomic write boundary ───────────────────────────
        // Customer create/update, the campaign closed-state recheck, order + nested
        // item creation, and every stock decrement now succeed or roll back TOGETHER.
        // Previously these were independent writes: a failure partway through left a
        // created order with partially decremented stock while the caller received a
        // 500. No email is sent inside this transaction.
        let txResult: { order: any; createdCustomer: boolean };
        try {
            txResult = await prisma.$transaction(async (tx) => {
                // ── FR-FLOW-3: join the campaign's selection lock, FIRST ──────
                //
                // A coordinator may revise the fundraiser's bundles right up until
                // the first supporter order exists. That makes their update a
                // check-then-write, and THIS insert is the write that invalidates
                // their check. Both paths take the same transaction-scoped advisory
                // lock so exactly one reaches its decision first:
                //
                //   this order first        -> the order commits, and the
                //                              coordinator's reselection then sees
                //                              it and is refused.
                //   reselection first       -> the new bundles are committed, and
                //                              the recheck below rejects a basket
                //                              built from the old ones.
                //
                // Serializable on the coordinator side alone could not do this:
                // this transaction runs at READ COMMITTED, so it never joins
                // PostgreSQL's SSI dependency graph and neither side would abort.
                // Only campaign orders take it — the ordinary storefront path is
                // untouched and contends for nothing.
                if (campaign) {
                    await lockCampaignSelection(tx, campaign.id);
                }

                // 2. Find or Create Customer (Individual)
                // We try to find by email AND type='Individual' to avoid mixing with Org contacts
                let dbCustomer = await tx.customer.findFirst({
                    where: {
                        business_id: businessId,
                        contact_email: customer.email,
                        type: 'direct_customer' // Enum value for Individual
                    }
                });

                let createdCustomer = false;

                if (!dbCustomer) {
                    // Create new "Lead" customer. The lead notification email that used
                    // to be awaited here now runs AFTER commit — no email may be sent
                    // inside the transaction.
                    dbCustomer = await tx.customer.create({
                        data: {
                            business_id: businessId,
                            name: purchaserName,
                            contact_email: customer.email,
                            contact_phone: customer.phone,
                            delivery_address: formattedAddress,
                            type: 'direct_customer',
                            status: 'LEAD',
                            // FR-LAUNCH-1A: driven by the resolved campaign, not the raw request.
                            source: isCampaignOrder ? 'Fundraiser' : 'Storefront',
                            notes: `Created via ${isCampaignOrder ? 'Fundraiser' : 'Storefront'} Order.${campaign ? ` Campaign: ${campaign.name}` : ''}`,
                            external_id: `sf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                        }
                    });
                    createdCustomer = true;
                } else if (formattedAddress && dbCustomer.delivery_address !== formattedAddress) {
                    // Update existing customer with new address if it changed or was empty
                    dbCustomer = await tx.customer.update({
                        where: { id: dbCustomer.id },
                        data: { delivery_address: formattedAddress, contact_phone: customer.phone } // Opportunistically update phone as well
                    });
                }

                // 2.5 FR-LAUNCH-1E: campaign closeout recheck.
                // The preflight campaign read and CB-5 eligibility gate happen before
                // this transaction, so a campaign closed in between would otherwise
                // still accept the order. Re-read the closure state here, immediately
                // before the insert, using the canonical isCampaignClosed() predicate
                // (closed_at OR a closed status) so the precedence cannot drift.
                //
                // BOUNDARY: this is the narrow FINAL closed-state recheck only. The
                // full bundle-selection/eligibility matrix (resolveCampaignOrderMode)
                // is NOT re-run inside the transaction — it performs its own queries
                // against the base client and re-running it here was outside the
                // authorized scope for this phase.
                //
                // FR-ORDERABILITY-1: the ordering deadline is rechecked here too,
                // for the same reason the closed state is. A campaign can cross
                // midnight between the preflight and the insert, and a deadline
                // enforced only in the stale preflight would let that order through.
                if (campaign) {
                    const currentCampaign = await tx.fundraiserCampaign.findUnique({
                        where: { id: campaign.id },
                        select: {
                            closed_at: true, status: true, end_date: true,
                            // FR-FLOW-3: read by the bundle-selection recheck below.
                            bundle_selection_status: true,
                            // FR-ORDERABILITY-1-R: re-read the tenant zone from the
                            // durable Business row inside the transaction rather than
                            // trusting the value captured during preflight, so the
                            // deadline decision here rests on current stored data.
                            customer: { select: { business: { select: { timezone: true } } } },
                        },
                    });

                    const tenantZone = currentCampaign?.customer?.business?.timezone;

                    if (!currentCampaign
                        || isCampaignClosed(currentCampaign)
                        || !isValidIanaTimeZone(tenantZone)
                        || isCampaignPastOrderDeadline(currentCampaign, tenantZone)) {
                        throw new CampaignClosedError();
                    }

                    // ── FR-FLOW-3: the bundle-selection recheck ───────────────
                    //
                    // Narrow on purpose. It does NOT re-run the whole eligibility
                    // matrix; it answers the one question the lock above made
                    // answerable: are the bundles in this basket still the ones
                    // this fundraiser sells?
                    //
                    // 'pending' means a coordinator has reopened setup and nothing
                    // is on sale — before FR-FLOW-3 a campaign could only become
                    // pending by tenant action, but reselection makes that window
                    // reachable in ordinary use.
                    //
                    // 'not_required' is the legacy contract where every active
                    // bundle is available, so there is no selected set to check
                    // against and the basket is left alone.
                    const selectionStatus = (currentCampaign as any).bundle_selection_status;

                    if (selectionStatus === 'pending') {
                        throw new BundleSelectionChangedError();
                    }

                    if (selectionStatus === 'selected') {
                        const activeRows = await tx.campaignBundle.findMany({
                            where: { campaign_id: campaign.id, state: 'active' },
                            select: { bundle_id: true },
                        });
                        const sellable = new Set(activeRows.map((r) => r.bundle_id));
                        const ordered = resolvedItems
                            .map((i: any) => i.bundleId)
                            .filter((b: any) => b && b !== 'manual_upsell');
                        if (ordered.some((b: string) => !sellable.has(b))) {
                            throw new BundleSelectionChangedError();
                        }
                    }
                }

                // 3. Create Order
                const order = await tx.order.create({
                    data: {
                        business_id: businessId,
                        customer_id: dbCustomer.id,
                        customer_name: purchaserName,
                        // FR-SUPPORTER-CONTACT-1: the real distinct values, kept
                        // alongside customer_name (above) rather than instead of
                        // it, so every existing reader of customer_name keeps
                        // working unmodified.
                        first_name: purchaserFirstName || null,
                        last_name: purchaserLastName || null,
                        // Previously silently dropped here despite the column
                        // existing — phone reached Customer.contact_phone and the
                        // notification emails, but never the order row itself.
                        phone: (typeof customer.phone === 'string' ? customer.phone.trim() : '') || null,
                        participant_name: customer.participantCode || null,
                        // FR-LAUNCH-1A: a server-resolved campaign order enters the fundraiser
                        // lifecycle so campaign closeout — the sole owner of
                        // fundraiser_hold -> production_ready — can release it. Without this it
                        // would count toward settlement_total yet never reach production.
                        // The regular storefront fallback path is unchanged.
                        // @ts-ignore - 'storefront' was just added to enum
                        source: isCampaignOrder ? 'fundraiser' : 'storefront',
                        status: isCampaignOrder ? 'fundraiser_hold' : 'pending',
                        total_amount: serverTotal,
                        delivery_address: customer.address ? `${customer.address}, ${customer.city}, ${customer.state} ${customer.zip}` : customer.notes,
                        external_id: `ord_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        // Server-resolved campaign id only — never the raw request value.
                        campaign_id: campaign ? campaign.id : null,
                        // FR-LAUNCH-1E: NULL when the client sent no key (legacy-compatible
                        // path). When present, the partial unique index on
                        // (business_id, submission_key) makes this insert the point at
                        // which concurrent duplicates are serialized.
                        submission_key: submissionKey,
                        submission_fingerprint: submissionFingerprint,
                        items: {
                            create: resolvedItems.map((item: any) => ({
                                bundle_id: (item.bundleId === 'manual_upsell' || !item.bundleId) ? null : item.bundleId,
                                quantity: item.quantity,
                                variant_size: resolveVariantSize(item.serving_tier),
                                item_name: item.name,
                                unit_price: item.serverPrice,
                                is_subscription: !!item.isSubscription
                            }))
                        }
                    } as any,
                    include: {
                        items: {
                            include: { bundle: true }
                        }
                    }
                });

                // 4. Update Stock (family-equivalent units)
                //    stock_on_hand represents family-size-equivalent bundle units.
                //    serves_5 = 1.0, serves_2 = 0.5 per unit.
                //    Decrement = quantity × servingMultiplier
                //
                //    FR-LAUNCH-1E: now inside the transaction, so a throw partway
                //    through rolls back the order and every earlier decrement rather
                //    than leaving inventory partially applied. Negative stock is still
                //    permitted — inventory reservation remains out of scope.
                for (const item of items) {
                    if (item.bundleId && item.bundleId !== 'manual_upsell') {
                        const variantSize = resolveVariantSize(item.serving_tier);
                        const multiplier = getServingMultiplier(variantSize); // throws if undefined (LAW 8)
                        const decrementAmount = item.quantity * multiplier;

                        await tx.bundle.update({
                            where: { id: item.bundleId },
                            data: {
                                stock_on_hand: {
                                    decrement: decrementAmount
                                }
                            } as any // Cast to any to avoid partial type mismatch on Decimal decrement
                        });
                    }
                }

                return { order, createdCustomer };
            });
        } catch (txErr: any) {
            if (txErr instanceof CampaignClosedError) {
                return NextResponse.json({
                    error: 'This campaign is closed and is no longer accepting orders.',
                    code: 'CAMPAIGN_CLOSED',
                }, { status: 409 });
            }

            // FR-FLOW-3: the fundraiser's bundles changed while this order was in
            // flight. Nothing was written. The supporter is told to refresh rather
            // than shown anything about coordinators or internal selection state.
            if (isBundleSelectionChanged(txErr)) {
                return NextResponse.json({
                    error: 'This fundraiser\'s options just changed. Please refresh and place your order again.',
                    code: 'BUNDLE_SELECTION_CHANGED',
                }, { status: 409 });
            }

            // FR-LAUNCH-1E: unique violation on (business_id, submission_key) — a
            // concurrent request with the same key won the insert. Everything this
            // attempt wrote has already rolled back. Resolve to the winner's order
            // and replay it; never create a second order.
            if (
                submissionKey &&
                txErr instanceof Prisma.PrismaClientKnownRequestError &&
                txErr.code === 'P2002'
            ) {
                const winner = await prisma.order.findFirst({
                    where: { business_id: businessId, submission_key: submissionKey } as any,
                    select: { id: true, total_amount: true, submission_fingerprint: true } as any,
                }) as any;

                if (winner && winner.submission_fingerprint === submissionFingerprint) {
                    console.log(`[FR-1E] Concurrent duplicate resolved to order ${winner.id} (no writes, no email)`);
                    return buildSuccessResponse(winner);
                }

                return NextResponse.json({
                    error: 'This order could not be processed. Please refresh and try again.',
                    code: 'SUBMISSION_CONFLICT',
                }, { status: 409 });
            }

            throw txErr;
        }

        const order = txResult.order;

        // ── Post-commit side effects ────────────────────────────────────────────
        // Everything below runs ONLY for a newly created order. A replay returns
        // above and therefore sends nothing. All email is best-effort: a failure
        // here can never roll back or invalidate the committed order.

        // Lead notification to the business owner — moved out of the transaction
        // (it previously ran between customer creation and order creation).
        if (txResult.createdCustomer) {
            try {
                const owner = await prisma.user.findFirst({
                    where: { business_id: businessId }
                });
                if (owner?.email) {
                    const { sendLeadNotificationEmail } = await import('@/lib/email');
                    await sendLeadNotificationEmail(owner.email, {
                        name: purchaserName,
                        email: customer.email,
                        phone: customer.phone,
                        source: isCampaignOrder ? 'Fundraiser' : 'Storefront'
                    });
                }
            } catch (leadErr) {
                console.error('[FR-1E] Lead notification failed after commit:', leadErr);
            }
        }

        // 5. Send Confirmation Email
        // Import dynamically to avoid circular deps if any, though likely fine
        try {
            const { sendOrderConfirmationEmail } = await import('@/lib/email');
            await sendOrderConfirmationEmail(
                customer.email,
                order,
                (order as any).items, // Cast to any because TS isn't inferring the include
                orgContactEmail,
                paymentInstructions,
                externalPaymentLink
            );
        } catch (confirmErr) {
            console.error('[FR-1E] Customer confirmation failed after commit:', confirmErr);
        }

        // 6. FR-LAUNCH-1D: coordinator notification (transactional, best-effort).
        // Gated to a SERVER-RESOLVED, tenant-validated campaign, so a normal
        // storefront order can never reach it. Runs only after the order and its
        // nested items are durable and the stock decrements have completed.
        //
        // Wrapped in its own try/catch: tenant sender resolution happens OUTSIDE
        // the email utility's internal provider catch, so an unexpected throw here
        // would otherwise fall into this route's outer catch and report a 500 for
        // an order that was already saved. A notification must never do that.
        if (campaign) {
            const coordinatorEmail = orgContactEmail?.trim();
            if (coordinatorEmail) {
                try {
                    const { sendFundraiserCoordinatorNotification } = await import('@/lib/email');
                    const notified = await sendFundraiserCoordinatorNotification({
                        coordinatorEmail,
                        campaignName: campaign.name,
                        organizationName: orgName,
                        supporterName: order.customer_name,
                        supporterEmail: customer.email || null,
                        supporterPhone: customer.phone || null,
                        participantName: order.participant_name,
                        items: (order as any).items || [],
                        // Persisted server-authoritative total — never recomputed here.
                        totalAmount: Number(order.total_amount),
                        orderReference: order.external_id,
                        businessId,
                        // FR-COORD-123 Part H: when the campaign offers ANY way to
                        // pay outside the coordinator's hand — a payment link OR
                        // written instructions like "Venmo @our-boosters" — the
                        // supporter MAY already have paid, unverified. The email
                        // then says "verify", never "Paid", and never the false
                        // "no online payment was taken". Instructions count:
                        // they are shown to the supporter on the confirmation
                        // screen and in their receipt exactly like the link is.
                        hasExternalPaymentLink: Boolean(externalPaymentLink) || Boolean(paymentInstructions?.trim()),
                    });

                    if (!notified) {
                        console.warn(
                            `[FR-1D] Coordinator notification not delivered for order ${order.external_id} (campaign ${campaign.id})`
                        );
                    }
                } catch (notifyErr) {
                    console.error('[FR-1D] Coordinator notification threw unexpectedly:', notifyErr);
                }
            } else {
                console.warn(
                    `[FR-1D] Coordinator notification skipped for order ${order.external_id}: campaign ${campaign.id} has no contact email`
                );
            }
        }

        // Identical shape to the replay path above (buildSuccessResponse).
        return buildSuccessResponse(order);

    } catch (e: any) {
        console.error("Failed to place storefront order:", e);
        return NextResponse.json({ error: 'Failed to place order' }, { status: 500 });
    }
}
