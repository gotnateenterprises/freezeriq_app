import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
  isCanonicalFamilyTier,
  isCanonicalServes2Tier,
} from '@/lib/campaignBundleSelection';
import { computeBundleUnitsFromItems } from '@/lib/fundraiserMetrics';
import {
  evaluateConversion,
  refusalHttpStatus,
  type ConvertibleOpportunity,
} from '@/lib/rebookingConversion';


// Helper to safely serialize BigInt
function safeJSON(data: any) {
    return JSON.parse(JSON.stringify(data, (key, value) =>
        typeof value === 'bigint'
            ? value.toString()
            : value // return everything else unchanged
    ));
}

// ── CB-4: Bundle selection request types ─────────────────────────────────────

type CoordinatorSelectsPayload = {
  mode: 'coordinator_selects';
  candidateFamilyIds: string[];
  selectionLimit: number;
};

type NotRequiredPayload = {
  mode: 'not_required';
};

type BundleSelectionPayload =
  | CoordinatorSelectsPayload
  | NotRequiredPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isBundleSelectionPayload(value: unknown): value is BundleSelectionPayload {
    if (!isRecord(value) || typeof value.mode !== 'string') {
        return false;
    }

    if (value.mode === 'coordinator_selects') {
        return (
            Array.isArray(value.candidateFamilyIds) &&
            value.candidateFamilyIds.every((id): id is string => typeof id === 'string') &&
            typeof value.selectionLimit === 'number'
        );
    }

    return value.mode === 'not_required';
}

interface CreateCampaignBody {
  customerId: string;
  name: string;
  bundleGoal?: number | null;
  endDate?: string | null;
  missionText?: string | null;
  aboutText?: string | null;
  participantLabel?: string | null;
  groupLabel?: string | null;
  // CB-4: new field — if absent, legacy branch applies
  bundleSelection?: unknown; // We validate this manually at runtime
  // FR-RETENTION-5: optional. When present this campaign is being created from
  // an approved rebooking opportunity, which is claimed and linked in the same
  // transaction as the campaign. Everything else about creation is unchanged.
  opportunityId?: string | null;
}

/**
 * FR-RETENTION-5 — thrown when the opportunity could not be claimed inside the
 * transaction. Carries no message the tenant sees; the caller re-reads the row
 * and produces the accurate reason.
 */
class OpportunityClaimFailed extends Error {
    constructor() { super('opportunity_claim_failed'); }
}

export async function POST(req: Request) {
    // FR-RETENTION-5: captured outside the try so the claim-failure handler can
    // report accurately without re-reading an already-consumed request body.
    let attemptedOpportunityId: string | null = null;
    let attemptedBusinessId: string | null = null;
    try {
        const session = await auth();
        if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        if (!session.user.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const businessId = session.user.businessId;

        let body: CreateCampaignBody;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }

        const {
            customerId,
            name,
            bundleGoal,
            endDate,
            missionText,
            aboutText,
            participantLabel,
            groupLabel,
            bundleSelection,
            opportunityId,
        } = body;

        if (!customerId || !name) {
            return NextResponse.json({ error: "Customer ID and Name are required" }, { status: 400 });
        }

        attemptedOpportunityId = opportunityId ?? null;
        attemptedBusinessId = businessId;

        // Verify customer belongs to this tenant before creating any campaign or minting
        // a portal_token. Using findFirst with both id AND business_id in the WHERE clause
        // prevents cross-tenant access and avoids leaking whether a foreign customer exists.
        // Returns 404 (not 403) so the response is indistinguishable from "not found".
        const customer = await prisma.customer.findFirst({
            where: {
                id: customerId,
                business_id: businessId,
            },
            select: { id: true },
        });

        if (!customer) {
            return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
        }

        // ── FR-RETENTION-5: rebooking conversion pre-flight ───────────────────
        //
        // Only a read at this point, for two reasons: to give an accurate refusal
        // before doing any work, and to answer a repeated request idempotently
        // with the campaign that already exists.
        //
        // It is NOT the guarantee. The guarantee is the conditional UPDATE inside
        // the transaction below, which is the only thing that can be trusted when
        // two requests arrive at once.
        if (opportunityId) {
            const existing = await prisma.rebookingOpportunity.findFirst({
                where: { id: opportunityId, business_id: businessId },
                select: { id: true, business_id: true, customer_id: true, status: true, campaign_id: true },
            });

            const shape: ConvertibleOpportunity | null = existing
                ? {
                    id: existing.id, businessId: existing.business_id, customerId: existing.customer_id,
                    status: existing.status, campaignId: existing.campaign_id,
                }
                : null;

            const verdict = evaluateConversion(shape, businessId, customerId);

            if (!verdict.ok) {
                // A repeated request after a successful conversion resolves the
                // campaign that exists rather than creating a second one.
                if (verdict.refusal === 'already_converted' && verdict.existingCampaignId) {
                    const already = await prisma.fundraiserCampaign.findFirst({
                        where: { id: verdict.existingCampaignId, customer: { business_id: businessId } },
                    });
                    if (already) {
                        return NextResponse.json({ ...already, alreadyConverted: true });
                    }
                }
                return NextResponse.json(
                    { error: verdict.message, refusal: verdict.refusal },
                    { status: refusalHttpStatus(verdict.refusal!) },
                );
            }
        }

        /**
         * FR-RETENTION-5 — run a branch's campaign creation, optionally claiming
         * and linking a rebooking opportunity in the SAME transaction.
         *
         * Every branch below routes its creation through here, so the campaign
         * data written is byte-for-byte what it was before this checkpoint.
         *
         * THE ONE-CAMPAIGN GUARANTEE lives in the conditional UPDATE. It matches
         * only an approved, unlinked opportunity for this tenant AND this
         * organization. Two concurrent requests serialize on that row: the loser
         * re-evaluates the predicate after the winner commits, matches zero rows,
         * and its whole transaction — campaign included — rolls back. So a failed
         * or losing attempt cannot leave a stray campaign behind, and cannot
         * leave the opportunity stranded in `converted` either.
         */
        const runCreate = async <T>(create: (tx: typeof prisma) => Promise<T>): Promise<T> => {
            if (!opportunityId) {
                return prisma.$transaction(async (tx) => create(tx as unknown as typeof prisma));
            }
            return prisma.$transaction(async (tx) => {
                const claimed = await tx.rebookingOpportunity.updateMany({
                    where: {
                        id: opportunityId,
                        business_id: businessId,
                        customer_id: customerId,
                        status: 'approved',
                        campaign_id: null,
                    },
                    data: { status: 'converted' },
                });
                if (claimed.count !== 1) throw new OpportunityClaimFailed();

                const created = await create(tx as unknown as typeof prisma);

                await tx.rebookingOpportunity.update({
                    where: { id: opportunityId },
                    data: { campaign_id: (created as unknown as { id: string }).id },
                });
                return created;
            });
        };

        // ── CB-4: Determine bundle selection mode ─────────────────────────────
        //
        // THREE branches:
        //
        //   A. bundleSelection.mode = 'coordinator_selects'
        //      → Validate candidateFamilyIds + selectionLimit, create campaign as
        //        pending + candidate rows (Serves-5 only, one per family).
        //
        //   B. bundleSelection.mode = 'not_required'
        //      → Explicit legacy/exempt campaign. No candidate pool.
        //
        //   C. bundleSelection absent (legacy callers without the new field)
        //      → Explicit legacy branch: not_required, no candidate pool.
        //        Legacy callers: the handoff CRM-4 code skeleton and any pre-CB-4
        //        callers that POST without bundleSelection.
        //        NOT a fallback for bad coordinator_selects submissions.

        if (bundleSelection !== undefined && bundleSelection !== null) {
            if (!isBundleSelectionPayload(bundleSelection)) {
                return NextResponse.json({
                    error: `Invalid bundleSelection payload. Mode must be 'coordinator_selects' or 'not_required' with appropriate fields.`,
                }, { status: 400 });
            }

            // ── Mode A: coordinator_selects ────────────────────────────────────
            if (bundleSelection.mode === 'coordinator_selects') {
                const rawFamilyIds = bundleSelection.candidateFamilyIds;
                const selectionLimit = bundleSelection.selectionLimit;

                if (!Number.isInteger(selectionLimit) || selectionLimit < 1) {
                    return NextResponse.json({
                        error: 'selectionLimit must be a positive integer',
                    }, { status: 400 });
                }

                const candidateFamilyIds = rawFamilyIds.map((id) => id.trim());

                if (candidateFamilyIds.some((id) => id.length === 0)) {
                    return NextResponse.json({
                        error: 'Candidate family IDs must be non-empty strings.',
                    }, { status: 400 });
                }

                if (new Set(candidateFamilyIds).size !== candidateFamilyIds.length) {
                    return NextResponse.json({
                        error: 'Duplicate bundle families are not allowed.',
                    }, { status: 400 });
                }

                if (candidateFamilyIds.length === 0) {
                    return NextResponse.json({
                        error: 'Choose at least one eligible bundle family.',
                    }, { status: 400 });
                }

                if (selectionLimit > candidateFamilyIds.length) {
                    return NextResponse.json({
                        error: 'The coordinator must choose fewer families than are available in the pool.',
                    }, { status: 400 });
                }

                // Validate each candidateFamilyId resolves to a canonical S5 bundle
                // belonging to this tenant, with exactly one active S2 sibling.
                const allFamilyBundles = await prisma.bundle.findMany({
                    where: {
                        business_id: businessId,
                        family_id: { in: candidateFamilyIds },
                        is_active: true,
                    },
                    select: {
                        id: true,
                        name: true,
                        serving_tier: true,
                        family_id: true,
                    },
                });

                // Group by family_id and validate each
                const familyBundleMap = new Map<
                    string,
                    { s5: typeof allFamilyBundles[number] | null; s5Count: number; s2Count: number }
                >();

                for (const b of allFamilyBundles) {
                    if (!b.family_id) continue;
                    const entry = familyBundleMap.get(b.family_id) ?? { s5: null, s5Count: 0, s2Count: 0 };
                    if (isCanonicalFamilyTier(b.serving_tier)) {
                        entry.s5 = b;
                        entry.s5Count += 1;
                    } else if (isCanonicalServes2Tier(b.serving_tier)) {
                        entry.s2Count += 1;
                    }
                    familyBundleMap.set(b.family_id, entry);
                }

                // Every submitted family ID must:
                //  - belong to this tenant (validated by business_id in query above)
                //  - have exactly one canonical S5 variant
                //  - have exactly one active S2 sibling
                const candidateS5Bundles: Array<{ id: string; familyId: string; position: number }> = [];
                const invalidFamilies: string[] = [];

                for (let i = 0; i < candidateFamilyIds.length; i++) {
                    const familyId = candidateFamilyIds[i];
                    const entry = familyBundleMap.get(familyId);

                    if (!entry) {
                        // Family not found under this tenant
                        invalidFamilies.push(familyId);
                        continue;
                    }

                    if (entry.s5Count !== 1 || entry.s2Count !== 1 || entry.s5 === null) {
                        // Malformed or ambiguous family
                        invalidFamilies.push(familyId);
                        continue;
                    }

                    candidateS5Bundles.push({
                        id: entry.s5.id,
                        familyId,
                        position: i,
                    });
                }

                if (invalidFamilies.length > 0) {
                    return NextResponse.json({
                        error: 'One or more selected families are no longer available. Refresh and try again.',
                    }, { status: 400 });
                }

                // ── Atomic transaction: create campaign + candidate rows ────────
                // FR-RETENTION-5: routed through runCreate so an optional
                // rebooking opportunity is claimed and linked in this same
                // transaction. The campaign data below is unchanged.
                const campaign = await runCreate(async (tx) => {
                    // Create campaign with pending bundle selection status
                    const newCampaign = await tx.fundraiserCampaign.create({
                        data: {
                            customer_id: customerId,
                            name,
                            // @ts-ignore - Stale client: bundle_goal added in CB-1 migration
                            bundle_goal: bundleGoal ? Number(bundleGoal) : undefined,
                            end_date: endDate ? new Date(endDate) : undefined,
                            // @ts-ignore - Stale client
                            mission_text: missionText,
                            // @ts-ignore - Stale client
                            about_text: aboutText,
                            // @ts-ignore - Stale client
                            participant_label: participantLabel || 'Seller',
                            // @ts-ignore - Stale client
                            group_label: groupLabel,
                            // @ts-ignore - Stale client
                            is_group_enabled: !!groupLabel,
                            status: 'Active',
                            // CB-4: Set bundle selection fields
                            bundle_selection_status: 'pending',
                            bundle_selection_limit: selectionLimit,
                            bundle_selection_at: null,
                        },
                    });

                    // Create one candidate CampaignBundle row per family.
                    // ONLY the Serves-5 (canonical family tier) bundle is stored as the candidate row.
                    // The Serves-2 sibling is resolved at load time by loadCandidateFamilies()
                    // using family_id + serving_tier — never stored as a separate candidate row.
                    // This is the exact representation expected by CB-2 loadCandidateFamilies().
                    if (candidateS5Bundles.length > 0) {
                        await tx.campaignBundle.createMany({
                            data: candidateS5Bundles.map(({ id: bundleId, position }) => ({
                                campaign_id: newCampaign.id,
                                bundle_id: bundleId,
                                state: 'candidate',
                                position,
                            })),
                        });
                    }

                    return newCampaign;
                });

                return NextResponse.json(campaign);
            }

            // ── Mode B: not_required (explicit) ───────────────────────────────
            if (bundleSelection.mode === 'not_required') {
                const campaign = await runCreate((tx) => tx.fundraiserCampaign.create({
                    data: {
                        customer_id: customerId,
                        name,
                        // @ts-ignore - Stale client
                        bundle_goal: bundleGoal ? Number(bundleGoal) : undefined,
                        end_date: endDate ? new Date(endDate) : undefined,
                        // @ts-ignore - Stale client
                        mission_text: missionText,
                        // @ts-ignore - Stale client
                        about_text: aboutText,
                        participant_label: participantLabel || 'Seller',
                        group_label: groupLabel,
                        is_group_enabled: !!groupLabel,
                        status: 'Active',
                        bundle_selection_status: 'not_required',
                    },
                }));
                return NextResponse.json(campaign);
            }

            // Unreachable due to isBundleSelectionPayload, but required for exhaustiveness
            return NextResponse.json({
                error: `Invalid bundleSelection.mode. Expected 'coordinator_selects' or 'not_required'.`,
            }, { status: 400 });
        }

        // ── Branch C: Legacy caller (no bundleSelection field) ─────────────────
        // Pre-CB-4 callers that POST without bundleSelection are treated as not_required.
        // This includes any integrations built before CB-4, or the CRM-4 handoff skeleton.
        // The new wizard always sends an explicit bundleSelection.mode and never reaches here.
        const campaign = await runCreate((tx) => tx.fundraiserCampaign.create({
            data: {
                customer_id: customerId,
                name,
                // @ts-ignore - Stale client
                bundle_goal: bundleGoal ? Number(bundleGoal) : undefined,
                end_date: endDate ? new Date(endDate) : undefined,
                // @ts-ignore - Stale client
                mission_text: missionText,
                // @ts-ignore - Stale client
                about_text: aboutText,
                // @ts-ignore - Stale client
                participant_label: participantLabel || 'Seller',
                // @ts-ignore - Stale client
                group_label: groupLabel,
                // @ts-ignore - Stale client
                is_group_enabled: !!groupLabel,
                status: 'Active',
                bundle_selection_status: 'not_required',
            }
        }));

        return NextResponse.json(campaign);

    } catch (e: any) {
        // FR-RETENTION-5: the opportunity could not be claimed, which means a
        // concurrent request won the race or the state changed underneath us.
        // The transaction rolled back, so no campaign was created. Re-read and
        // answer with what is now true rather than a generic error.
        if (e instanceof OpportunityClaimFailed) {
            if (attemptedBusinessId && attemptedOpportunityId) {
                const now = await prisma.rebookingOpportunity.findFirst({
                    where: { id: attemptedOpportunityId, business_id: attemptedBusinessId },
                    select: { campaign_id: true },
                });
                if (now?.campaign_id) {
                    const already = await prisma.fundraiserCampaign.findFirst({
                        where: { id: now.campaign_id, customer: { business_id: attemptedBusinessId } },
                    });
                    if (already) return NextResponse.json({ ...already, alreadyConverted: true });
                }
            }
            return NextResponse.json({
                error: 'A fundraiser for this organization was just created somewhere else. Reload to see it.',
                refusal: 'already_converted',
            }, { status: 409 });
        }
        console.error("Failed to create campaign:", e);
        return NextResponse.json({ error: e.message || "Internal Server Error" }, { status: 500 });
    }
}


export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { searchParams } = new URL(req.url);
        const customerId = searchParams.get('customerId');

        try {
            // Fetch Business Slug for Public URL construction
            const business = await prisma.business.findUnique({
                where: { id: session.user.businessId },
                select: { slug: true }
            });
            const businessSlug = business?.slug || 'demo';

            // 1. Fetch Customers (Scoped to Business)
            const customers = await prisma.customer.findMany({
                where: {
                    business_id: session.user.businessId,
                    type: { in: ['fundraiser_org', 'organization'] as any }, // Cast to any to avoid Enum issues if stale
                    ...(customerId ? { id: customerId } : {})
                },
                orderBy: { name: 'asc' }
            });

            // 2. Fetch Campaigns (Scoped to Business)
            // We fetch ALL campaigns for this business to map them, 
            // or we could filter by the customer IDs we just found, but business_id is enough safety.
            const campaigns = await prisma.fundraiserCampaign.findMany({
                where: {
                    customer: {
                        business_id: session.user.businessId
                    },
                    ...(customerId ? { customer_id: customerId } : {})
                },
                orderBy: { created_at: 'desc' },
                select: {
                    id: true,
                    name: true,
                    status: true,
                    start_date: true,
                    end_date: true,
                    goal_amount: true,
                    bundle_goal: true,
                    total_sales: true,
                    participant_label: true,
                    group_label: true,
                    is_group_enabled: true,
                    customer_id: true,
                    created_at: true,
                    portal_token: true,
                    // Include ALL coordinator-entered orders for settlement visibility
                    // (covers both new fundraiser_hold AND historical pending/completed)
                    orders: {
                        where: { source: 'fundraiser' as any, canceled_at: null },
                        select: {
                            total_amount: true,
                            status: true,
                            // FR-LAUNCH-1C-1: item-level data for the canonical
                            // weighted-bundle calculation. variant_size is
                            // authoritative; bundle.serving_tier is the fallback.
                            items: {
                                select: {
                                    quantity: true,
                                    variant_size: true,
                                    bundle: { select: { serving_tier: true } }
                                }
                            }
                        }
                    }
                } as any // Use 'as any' for select to avoid TS errors on potential missing fields
            });

            // 3. In-Memory Join
            const results: any[] = [];
            const campaignMap = new Map<string, any[]>();

            // Group campaigns by customer
            for (const camp of campaigns) {
                const cid = (camp as any).customer_id;
                if (!campaignMap.has(cid)) {
                    campaignMap.set(cid, []);
                }
                campaignMap.get(cid)?.push(camp);
            }

            for (const c of customers) {
                const customerCampaigns = campaignMap.get(c.id) || [];

                if (customerCampaigns.length > 0) {
                    for (const fc of customerCampaigns) {
                        // ── FR-LAUNCH-1C-1: weighted bundle progress ──────────
                        // Bundle progress is derived from the ACTIVE (non-canceled)
                        // fundraiser ORDER ITEMS through the single canonical
                        // weighting source — never from denormalized dollars
                        // (total_sales / sales_total) or goal_amount.
                        const activeFundraiserOrders: any[] = (fc as any).orders || [];
                        const weightedBundlesSold = activeFundraiserOrders.reduce(
                            (sum: number, o: any) => sum + computeBundleUnitsFromItems(
                                (o.items || []).map((i: any) => ({
                                    quantity: Number(i.quantity) || 0,
                                    variant_size: i.variant_size,
                                    serving_tier: i.bundle?.serving_tier ?? null,
                                }))
                            ),
                            0
                        );
                        const bundleGoalValue = Number((fc as any).bundle_goal || 0);
                        // Safe for zero, missing, or invalid goals; capped at 100%.
                        const progressPercent = Number.isFinite(bundleGoalValue) && bundleGoalValue > 0
                            ? Math.min((weightedBundlesSold / bundleGoalValue) * 100, 100)
                            : 0;

                        results.push({
                            id: fc.id,
                            name: fc.name,
                            status: fc.status,
                            start_date: fc.start_date,
                            end_date: fc.end_date,
                            goal_amount: Number(fc.goal_amount || 0),
                            bundle_goal: Number((fc as any).bundle_goal || 0),
                            sales_total: Number(fc.total_sales || 0),
                            customer_id: c.id,
                            customer: { name: c.name, contact_name: (c as any).contact_name || null },
                            is_placeholder: false,
                            business_slug: businessSlug,
                            participant_label: (fc as any).participant_label || 'Seller',
                            group_label: (fc as any).group_label,
                            is_group_enabled: (fc as any).is_group_enabled,
                            portal_token: (fc as any).portal_token,
                            // Settlement visibility — held order counts.
                            // These three metrics measure DIFFERENT things and are
                            // intentionally independent: order rows, dollars, and
                            // weighted bundle units.
                            held_order_count: activeFundraiserOrders.length,
                            held_order_total: activeFundraiserOrders.reduce((sum: number, o: any) => sum + Number(o.total_amount || 0), 0),
                            weighted_bundles_sold: weightedBundlesSold,
                            progress_percent: progressPercent
                        });
                    }
                } else {
                    // Lead Placeholder
                    results.push({
                        id: `new-${c.id}`,
                        name: `${c.name} Fundraiser`,
                        status: 'Lead',
                        customer_id: c.id,
                        customer: { name: c.name, contact_name: (c as any).contact_name || null },
                        is_placeholder: true,
                        business_slug: businessSlug,
                        goal_amount: 0,
                        bundle_goal: 0,
                        sales_total: 0,
                        // A lead placeholder has no campaign and therefore no orders.
                        weighted_bundles_sold: 0,
                        progress_percent: 0
                    });
                }
            }

            return NextResponse.json(safeJSON(results));

        } catch (dbError) {
            console.error("Database Error in Campaign Fetch:", dbError);
            return NextResponse.json({ error: "Database Error" }, { status: 500 });
        }

    } catch (e: any) {
        console.error("Failed to fetch campaigns:", e);
        return NextResponse.json({ error: e.message || "Unknown Error" }, { status: 500 });
    }
}
