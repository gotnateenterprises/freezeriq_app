import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { mintCoordinatorPortalToken } from '@/lib/coordinatorPortalToken';
import { fundraiserCrmCustomerFilter } from '@/lib/fundraiserLead';
import {
  isCanonicalFamilyTier,
  isCanonicalServes2Tier,
} from '@/lib/campaignBundleSelection';
import { computeBundleUnitsFromItems, parseBundleGoal, resolveBundleGoal } from '@/lib/fundraiserMetrics';
import { isOrgTaxStatus, parseTaxRatePercent, resolveCampaignTaxSnapshot } from '@/lib/fundraiserTax';
import { decideOrgShareChange, isOrgShareRejected } from '@/lib/fundraiserOrgShare';
import { evaluateCampaignHealth } from '@/lib/growth/health';
import {
  evaluateConversion,
  refusalHttpStatus,
  type ConvertibleOpportunity,
} from '@/lib/rebookingConversion';
// OPS-2 (gap 1): the same confirmed-delivery-date and order-deadline checks
// the canonical opportunity launch already enforces, reused rather than
// reinvented so a direct creation can never require a weaker date contract
// than a launched one.
import { checkConfirmedDate, checkOrderDeadline } from '@/lib/fundraiserLaunch';


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
  // OPS-2 (gap 1): the confirmed delivery/pickup day — the DELIVERY/PICKUP
  // day, distinct from endDate (the supporter order deadline). Required for
  // every normal creation; see the coordinator_selects branch below.
  deliveryDate?: string | null;
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
  // INV-A: optional per-campaign organization share, as a PERCENT (25 = 25%).
  // Omitted by every pre-INV-A caller, which is why the column carries a 20.00
  // database default rather than requiring a value here.
  orgSharePercent?: number | string | null;
  // FR-TAX-1: the tenant's explicit tax treatment for THIS campaign, confirming
  // or overriding what the organization's own status would prefill. Omitted by
  // every pre-FR-TAX-1 caller, which then gets the resolved default.
  taxStatus?: 'UNKNOWN' | 'TAXABLE' | 'TAX_EXEMPT' | null;
  taxRatePercent?: number | string | null;
}

/**
 * FR-RETENTION-5 — thrown when the opportunity could not be claimed inside the
 * transaction. Carries no message the tenant sees; the caller re-reads the row
 * and produces the accurate reason.
 *
 * OPS-2 (gap 2): identified by a marker rather than `instanceof`, discovered
 * while adding DuplicateCampaignSubmission right below — subclassing a
 * built-in loses the prototype link when the class is downlevelled, so
 * `instanceof` is false under the test transform even though it holds in the
 * app build today. Same fix already applied for this exact reason to
 * app/api/opportunities/[id]/launch/route.ts's own claim-failure class; a
 * field cannot drift the way a downlevel target can.
 */
class OpportunityClaimFailed extends Error {
    readonly isOpportunityClaimFailed = true as const;
    constructor() { super('opportunity_claim_failed'); }
}

function isOpportunityClaimFailure(e: unknown): e is OpportunityClaimFailed {
    return typeof e === 'object' && e !== null && (e as any).isOpportunityClaimFailed === true;
}

/**
 * OPS-2 (gap 2) — thrown when a concurrent or resubmitted request already
 * created the campaign this request was about to create. Carries the
 * existing campaign's id so the catch handler can hand it back instead of
 * creating a second one. Marker property, not `instanceof` — see
 * OpportunityClaimFailed just above.
 */
class DuplicateCampaignSubmission extends Error {
    readonly isDuplicateCampaignSubmission = true as const;
    constructor(readonly existingCampaignId: string) { super('duplicate_campaign_submission'); }
}

function isDuplicateCampaignSubmission(e: unknown): e is DuplicateCampaignSubmission {
    return typeof e === 'object' && e !== null && (e as any).isDuplicateCampaignSubmission === true;
}

/**
 * OPS-2 (gap 2): how recent a same-(customer, name) campaign must be to
 * count as "this same submission, again." A heuristic, not an identity —
 * nothing here actually knows whether two requests are the same submission
 * retried or two different ones that happen to share a name (StartFundraiserWizard
 * auto-fills `${orgName} ${year} Fundraiser`, so this is a real collision the
 * UI can produce, not just a contrived one). Within the window, a
 * legitimately different second campaign is silently collapsed into the
 * first instead of being created; outside it, protection stops and a true
 * resubmission creates a second row. See T3/T4/T5 in
 * tests/ops2CampaignCreationBypass.test.ts.
 */
const DUPLICATE_SUBMISSION_WINDOW_MS = 30_000;

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
            deliveryDate,
            missionText,
            aboutText,
            participantLabel,
            groupLabel,
            bundleSelection,
            opportunityId,
            orgSharePercent,
        } = body;

        if (!customerId || !name) {
            return NextResponse.json({ error: "Customer ID and Name are required" }, { status: 400 });
        }

        // ── FR-GOAL-CONFIG-1: tenant-controlled weighted bundle goal. Blank
        //    or absent resolves to the shared default; a malformed or
        //    non-positive value is rejected outright rather than silently
        //    coerced — every branch below reuses this ONE resolved value.
        const bundleGoalParsed = parseBundleGoal(bundleGoal);
        if (!bundleGoalParsed.ok) {
            return NextResponse.json({ error: bundleGoalParsed.error }, { status: 400 });
        }
        const resolvedBundleGoal = bundleGoalParsed.goal;

        // ── INV-A: organization share. Server-authoritative; omitted means the
        //    database default (20.00) applies, so every legacy caller is safe.
        //
        //    An EXPLICIT override is a financial-terms change and is ADMIN or
        //    super-admin only. The gate is inside this branch on purpose:
        //    creating a fundraiser is not ADMIN-only and must not become so.
        //    Authorization is checked before validation, so an unauthorized
        //    caller is refused outright rather than told whether their number
        //    was well-formed.
        const orgShareDecision = decideOrgShareChange({
            requested: orgSharePercent,
            user: {
                role: (session.user as any).role,
                isSuperAdmin: (session.user as any).isSuperAdmin === true,
            },
            campaignClosed: false, // a campaign being created cannot be closed
        });
        if (isOrgShareRejected(orgShareDecision)) {
            return NextResponse.json({ error: orgShareDecision.error }, { status: orgShareDecision.status });
        }
        const orgSharePercentValue: number | undefined = orgShareDecision.change
            ? orgShareDecision.percent
            : undefined;

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
            select: { id: true, tax_status: true },
        });

        if (!customer) {
            return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
        }

        // ── FR-TAX-1: FREEZE the campaign's tax treatment at launch ───────────
        // Read the organization's CURRENT status and the tenant's CURRENT
        // default rate once, here, and store the result on the campaign. Every
        // later read uses the stored snapshot, never these live values, so a
        // subsequent change to either cannot retroactively rewrite what an
        // already-launched fundraiser was told.
        //
        // An organization whose status was never recorded (UNKNOWN) resolves to
        // TAXABLE at the tenant default — never to exempt. See
        // lib/fundraiserTax.ts resolveCampaignTaxSnapshot.
        const taxBusiness = await prisma.business.findUnique({
            where: { id: businessId },
            select: { default_food_tax_percent: true },
        });

        let taxOverride: { status: 'TAXABLE' | 'TAX_EXEMPT'; ratePercent?: number | string | null } | null = null;
        if (isOrgTaxStatus(body.taxStatus) && body.taxStatus !== 'UNKNOWN') {
            taxOverride = { status: body.taxStatus, ratePercent: body.taxRatePercent };
        }
        if (taxOverride?.status === 'TAXABLE' && body.taxRatePercent !== undefined && body.taxRatePercent !== null && body.taxRatePercent !== '') {
            const parsedRate = parseTaxRatePercent(body.taxRatePercent);
            if (!parsedRate.ok) {
                return NextResponse.json({ error: parsedRate.error }, { status: 400 });
            }
        }

        const taxSnapshot = resolveCampaignTaxSnapshot({
            organizationStatus: customer.tax_status as any,
            tenantDefaultRatePercent: taxBusiness?.default_food_tax_percent as any,
            override: taxOverride,
        });

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
                // OPS-2 (gap 2) — CORRECTED: a direct create has no
                // pre-existing row to conditionally claim the way the
                // opportunityId branch below does (RebookingOpportunity) or
                // the canonical launch route does (FundraiserOpportunity) —
                // there is nothing durable to point at when the wizard opens
                // for a brand-new organization with no tracked opportunity.
                // This advisory transaction lock is real, Postgres-serialized
                // protection against a genuinely CONCURRENT identical
                // submission (two open tabs, a double-click, a retry that
                // overlaps the first request in flight): the second blocks on
                // the lock until the first commits or rolls back, then sees
                // what the first left behind and resolves to it instead of
                // racing it. It is NOT durable request-level idempotency —
                // a retry that arrives after DUPLICATE_SUBMISSION_WINDOW_MS
                // has elapsed is indistinguishable from a new, unrelated
                // campaign and WILL create a second row. Closing that
                // remaining gap durably would need either a schema change
                // (a client-supplied idempotency key column) or a
                // pre-existing durable row to claim, neither of which exists
                // for this path today; see
                // tests/ops2CampaignCreationBypass.test.ts's T3/T4/T5 tests
                // for the exact, proven boundary. Postgres releases the
                // advisory lock automatically when the transaction ends,
                // committed or not.
                return prisma.$transaction(async (tx) => {
                    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${customerId} || ':' || ${name}))`;

                    const recentDuplicate = await tx.fundraiserCampaign.findFirst({
                        where: {
                            customer_id: customerId,
                            name,
                            created_at: { gte: new Date(Date.now() - DUPLICATE_SUBMISSION_WINDOW_MS) },
                        },
                        select: { id: true },
                        orderBy: { created_at: 'desc' },
                    });
                    if (recentDuplicate) throw new DuplicateCampaignSubmission(recentDuplicate.id);

                    return create(tx as unknown as typeof prisma);
                });
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

        // ── CB-4 / OPS-2: Determine bundle selection mode ──────────────────────
        //
        // OPS-2: a normal new campaign must always enter the coordinator-setup
        // funnel, so bundleSelection is now REQUIRED and must be
        // 'coordinator_selects' — the one mode the canonical wizard
        // (components/crm2/StartFundraiserWizard.tsx) has ever sent. Two prior
        // branches are gone, both of which were a confirmed, live bypass:
        //
        //   - explicit bundleSelection.mode = 'not_required' ("legacy/exempt")
        //   - bundleSelection omitted entirely (silently treated as
        //     not_required "for legacy callers" — this is exactly what
        //     components/crm/FundraisersTab.tsx's "New Campaign" form sent)
        //
        // Both created an Active campaign whose bundle-selection status was the
        // "not required" value, with no delivery date and no allowed-Bundle
        // pool — and lib/campaignOrderBundles.ts's resolveCampaignOrderMode
        // treats that status as immediately orderable against the tenant's
        // ENTIRE active Bundle catalog (its own doc comment: "legacy fallback:
        // business-wide validation preserved"). Existing historical rows that
        // already carry that status are untouched — this only closes the
        // write path that could still create more of them for a brand-new
        // campaign.
        if (!isBundleSelectionPayload(bundleSelection) || bundleSelection.mode !== 'coordinator_selects') {
            return NextResponse.json({
                error: `A new fundraiser campaign must specify the allowed Bundle pool: bundleSelection with mode 'coordinator_selects', candidateFamilyIds, and selectionLimit.`,
            }, { status: 400 });
        }

        // ── OPS-2 (gap 1): confirmed delivery/pickup date is required ──────────
        //
        // The canonical opportunity launch (app/api/opportunities/[id]/launch)
        // has always required a confirmed delivery date before a campaign can
        // exist. This route — the direct creation path StartFundraiserWizard
        // posts to for an organization with no FundraiserOpportunity at all —
        // never asked for one: delivery_date was simply left null, on every
        // campaign this route has ever created. Reusing checkConfirmedDate (the
        // exact check the launch route itself runs, not a second copy of its
        // logic) means both creation paths can never define "confirmed"
        // differently.
        const dateCheck = checkConfirmedDate(deliveryDate);
        if (!dateCheck.ok) {
            return NextResponse.json({ error: dateCheck.error }, { status: 400 });
        }
        // endDate's own presence is unchanged by this phase — it was optional
        // on this route before OPS-2 and stays optional here. What's new is
        // only the relationship: an endDate that IS supplied must not sit
        // after the now-required delivery date, reusing checkOrderDeadline
        // (the launch route's own relationship check) rather than a second
        // copy of "deadline cannot be after delivery."
        if (endDate) {
            const deadlineCheck = checkOrderDeadline({
                endDate,
                confirmedDeliveryDate: dateCheck.confirmedDeliveryDate,
            });
            if (!deadlineCheck.ok) {
                return NextResponse.json({ error: deadlineCheck.error }, { status: 400 });
            }
        }

        // ── coordinator_selects: the only campaign-creation path this route
        //    now allows ────────────────────────────────────────────────────────
            {
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
                            // FR-FLOW-1R: mint the coordinator credential explicitly.
                            // Omitting it falls back to the schema's @default(cuid()),
                            // which is a sortable identifier, not a secret.
                            portal_token: mintCoordinatorPortalToken(),
                            // @ts-ignore - Stale client: bundle_goal added in CB-1 migration
                            bundle_goal: resolvedBundleGoal,
                            // FR-TAX-1: frozen at launch; never recomputed afterwards.
                            tax_status: taxSnapshot.status as any,
                            tax_rate_percent: taxSnapshot.ratePercent,
                            end_date: endDate ? new Date(endDate) : undefined,
                            // OPS-2 (gap 1): PART L's own pattern — the confirmed
                            // date is the DELIVERY day, never start_date.
                            delivery_date: new Date(`${dateCheck.confirmedDeliveryDate}T00:00:00.000Z`),
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
                            // INV-A: when omitted, the DB default (20.00) applies.
                            ...(orgSharePercentValue !== undefined
                                ? { org_share_percent: orgSharePercentValue }
                                : {}),
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

    } catch (e: any) {
        // FR-RETENTION-5: the opportunity could not be claimed, which means a
        // concurrent request won the race or the state changed underneath us.
        // The transaction rolled back, so no campaign was created. Re-read and
        // answer with what is now true rather than a generic error.
        if (isOpportunityClaimFailure(e)) {
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
        // OPS-2 (gap 2): a concurrent or resubmitted request already created
        // this campaign. Tenant-scoped re-read, exactly like the claim-failure
        // handler above — the id on the error is never trusted blindly.
        if (isDuplicateCampaignSubmission(e) && attemptedBusinessId) {
            const already = await prisma.fundraiserCampaign.findFirst({
                where: { id: e.existingCampaignId, customer: { business_id: attemptedBusinessId } },
            });
            if (already) return NextResponse.json({ ...already, alreadyConverted: true });
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
            // GE-3: one clock for the whole response, so two campaigns in the
            // same payload can never disagree about what "today" is.
            const healthNow = new Date();

            // 1. Fetch Customers (Scoped to Business)
            //
            // FR-FLOW-1R: inclusion is "fundraiser organization by type OR carries
            // the fundraiser-inquiry tag". The tag arm is what makes a public
            // inquiry from an EXISTING customer visible — previously such a lead
            // was saved and then filtered out of this very list, because the
            // storefront and waitlist write type 'direct_customer'.
            //
            // Customer.type is deliberately NOT rewritten to achieve this:
            // marketing audience segmentation, growth analytics and the Customers
            // page all route on it. See lib/fundraiserLead.ts.
            const customers = await prisma.customer.findMany({
                where: {
                    business_id: session.user.businessId,
                    ...fundraiserCrmCustomerFilter(),
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
                    // GE-3 health inputs. `closed_at` and the bundle-selection
                    // pair decide applicability and one reason; `_count` gives the
                    // coordinator-engagement signal without a second round trip.
                    closed_at: true,
                    // INV-A: the per-campaign organization share, for the
                    // fundraiser setup/edit UI. Display data only — every
                    // change goes through the authorized POST/PATCH paths.
                    org_share_percent: true,
                    // FR-TAX-1B: the campaign's frozen tax snapshot, so the
                    // closeout dialog can state THIS campaign's rate instead of
                    // a product constant. Display data only.
                    tax_status: true,
                    tax_rate_percent: true,
                    bundle_selection_status: true,
                    bundle_selection_at: true,
                    // CRM-ACTIVE-STATUS-UX-1: the durable, provider-confirmed
                    // "invite actually sent" timestamp, so the Active card can
                    // distinguish "coordinator invite not sent" from "waiting on
                    // coordinator" instead of both showing as one vague status.
                    primary_coordinator: { select: { setup_email_sent_at: true } },
                    // ── FR-HISTORY-1: settlement truth, so the dashboard can tell
                    //    "ordering finished" apart from "money received".
                    //
                    //    Without these, lib/growth/nextAction.ts was right to call
                    //    invoice state UNKNOWABLE and refuse to guess — and the
                    //    consequence was that closeout alone filed a campaign as
                    //    completed and collapsed it out of sight while it was still
                    //    owed. Two scalars and a one-column relation close that gap.
                    settlement_total: true,
                    settled_externally: true,
                    // Status only. No amounts, no dates, no customer — this feeds a
                    // lifecycle bucket, not a financial display, and the invoice
                    // page remains the authority for money.
                    invoices: { select: { status: true } },
                    _count: { select: { coordinator_actions: true } },
                    // Include ALL coordinator-entered orders for settlement visibility
                    // (covers both new fundraiser_hold AND historical pending/completed)
                    orders: {
                        where: { source: 'fundraiser' as any, canceled_at: null },
                        select: {
                            total_amount: true,
                            status: true,
                            // GE-3: powers the "no orders in N days" signal.
                            created_at: true,
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

            // ── FR-HISTORY-1: which organizations have SETTLED fundraiser history.
            //
            // The placeholder branch below fabricates a `status: 'Lead'` row for any
            // customer with no campaign rows, which is why organizations that
            // finished fundraisers years ago — Clark Co, Cumberland Co, Jasper Co,
            // Ag in the Classroom, St John's — sit under "Leads & upcoming" today.
            // Each has zero campaign rows but a PAID invoice, so existence alone was
            // being read as a current lead.
            //
            // Existence is not a lead. A PAID invoice is durable proof this
            // organization already completed business, so those placeholders are
            // filed as history instead. Tenant-scoped, one grouped query, no writes.
            const settledCustomerRows = await prisma.invoice.groupBy({
                by: ['customer_id'],
                where: { business_id: session.user.businessId, status: 'PAID' as any },
            });
            const customersWithSettledHistory = new Set(
                settledCustomerRows.map((r: any) => r.customer_id as string),
            );

            // ── FR-HISTORY-1: which organizations have CURRENT interest.
            //
            // An open FundraiserOpportunity is the durable record of a live
            // lead. Without it, "has paid history" alone would decide, and an
            // organization that ran a fundraiser last year and has just asked
            // about another would be filed as history — hiding precisely the
            // rebooking business this dashboard exists to surface. Paid history
            // must never suppress a real opportunity.
            const openOpportunityRows = await prisma.fundraiserOpportunity.groupBy({
                by: ['customer_id'],
                where: {
                    business_id: session.user.businessId,
                    status: { in: ['new', 'in_conversation', 'date_confirmed'] as any },
                },
            });
            const customersWithOpenOpportunity = new Set(
                openOpportunityRows.map((r: any) => r.customer_id as string),
            );

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
                        // FR-GOAL-CONFIG-1: the same authority as every other
                        // surface — never a locally-decided fallback.
                        const bundleGoalValue = resolveBundleGoal((fc as any).bundle_goal);
                        const progressPercent = Math.min((weightedBundlesSold / bundleGoalValue) * 100, 100);

                        // ── GE-3 campaign health (read-only) ──────────────────
                        // Derived from the same tenant-scoped rows already loaded
                        // above; adds no query and mutates nothing. Progress is
                        // the canonical weighted-bundle measure, not dollars.
                        const orderDates = activeFundraiserOrders
                            .map((o: any) => (o.created_at ? new Date(o.created_at) : null))
                            .filter((d: Date | null): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
                        const lastOrderAt = orderDates.length
                            ? new Date(Math.max(...orderDates.map((d: Date) => d.getTime())))
                            : null;

                        const healthResult = evaluateCampaignHealth({
                            status: String(fc.status),
                            closed_at: (fc as any).closed_at ? new Date((fc as any).closed_at) : null,
                            created_at: new Date((fc as any).created_at),
                            start_date: fc.start_date ? new Date(fc.start_date) : null,
                            end_date: fc.end_date ? new Date(fc.end_date) : null,
                            weightedBundlesSold,
                            bundle_goal: bundleGoalValue,
                            orderCount: activeFundraiserOrders.length,
                            lastOrderAt,
                            coordinatorActionCount: Number((fc as any)._count?.coordinator_actions ?? 0),
                            bundle_selection_status: (fc as any).bundle_selection_status ?? null,
                            bundle_selection_at: (fc as any).bundle_selection_at
                                ? new Date((fc as any).bundle_selection_at)
                                : null,
                        }, healthNow);

                        results.push({
                            id: fc.id,
                            name: fc.name,
                            status: fc.status,
                            start_date: fc.start_date,
                            end_date: fc.end_date,
                            goal_amount: Number(fc.goal_amount || 0),
                            bundle_goal: bundleGoalValue,
                            sales_total: Number(fc.total_sales || 0),
                            customer_id: c.id,
                            customer: { name: c.name, contact_name: (c as any).contact_name || null },
                            is_placeholder: false,
                            business_slug: businessSlug,
                            participant_label: (fc as any).participant_label || 'Seller',
                            group_label: (fc as any).group_label,
                            is_group_enabled: (fc as any).is_group_enabled,
                            portal_token: (fc as any).portal_token,
                            // INV-A: share + closed_at for the setup/edit UI.
                            // closed_at was already selected for GE-3 health; it
                            // is surfaced so the UI can render the share as
                            // locked once the fundraiser is financially closed.
                            org_share_percent: (fc as any).org_share_percent != null
                                ? Number((fc as any).org_share_percent)
                                : 20,
                            // FR-TAX-1B: the frozen snapshot, passed through
                            // as-is. NULL stays NULL — a campaign launched
                            // before FR-TAX-1 has no tax treatment, which is a
                            // different fact from "0%".
                            tax_status: (fc as any).tax_status ?? null,
                            tax_rate_percent: (fc as any).tax_rate_percent != null
                                ? Number((fc as any).tax_rate_percent)
                                : null,
                            closed_at: (fc as any).closed_at ?? null,
                            // ── FR-HISTORY-1: the facts that separate "ordering
                            //    finished" from "money received". Additive — every
                            //    existing consumer ignores them.
                            settlement_total: (fc as any).settlement_total != null
                                ? Number((fc as any).settlement_total)
                                : null,
                            settled_externally: Boolean((fc as any).settled_externally),
                            // Statuses only, flattened. An empty array means closeout
                            // has produced no invoice yet — which is a DIFFERENT fact
                            // from "we do not know", and the UI may now rely on it.
                            invoice_statuses: Array.isArray((fc as any).invoices)
                                ? (fc as any).invoices.map((i: any) => String(i.status))
                                : [],
                            // Settlement visibility — held order counts.
                            // These three metrics measure DIFFERENT things and are
                            // intentionally independent: order rows, dollars, and
                            // weighted bundle units.
                            held_order_count: activeFundraiserOrders.length,
                            held_order_total: activeFundraiserOrders.reduce((sum: number, o: any) => sum + Number(o.total_amount || 0), 0),
                            weighted_bundles_sold: weightedBundlesSold,
                            progress_percent: progressPercent,
                            // GE-3 — additive; existing consumers ignore these.
                            health: healthResult.health,
                            health_reasons: healthResult.reasons,
                            health_metrics: healthResult.metrics,
                            // CRM-ACTIVE-STATUS-UX-1 — already selected above for
                            // GE-3 health, now also surfaced so the Active card can
                            // show a real workflow status instead of "No signal yet".
                            bundle_selection_status: (fc as any).bundle_selection_status ?? null,
                            coordinator_invite_sent_at: (fc as any).primary_coordinator?.setup_email_sent_at ?? null,
                            // CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1 — `c` (Customer) is
                            // already fetched in full above with no select
                            // restriction, so `archived` needs no new query. This is
                            // the organization-level archive signal; the campaign's
                            // own status can independently be 'Archived'.
                            organization_archived: Boolean((c as any).archived),
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
                        progress_percent: 0,
                        // ── FR-HISTORY-1: a placeholder is a stand-in for an
                        //    organization, not a campaign, so it has no settlement
                        //    facts. Sent explicitly rather than left undefined so the
                        //    lifecycle classifier reads the same shape for every row.
                        settlement_total: null,
                        settled_externally: false,
                        invoice_statuses: [],
                        // True when this organization has already completed business
                        // with a PAID invoice. The lifecycle classifier files those
                        // as history rather than as a current lead.
                        has_settled_history: customersWithSettledHistory.has(c.id),
                        // An open opportunity means live interest, and outranks
                        // history: this organization IS a lead right now.
                        has_open_opportunity: customersWithOpenOpportunity.has(c.id),
                        // GE-3: a placeholder is not a running campaign to judge.
                        health: 'not_applicable',
                        health_reasons: [],
                        health_metrics: null,
                        // CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1: an archived organization
                        // with no campaign at all must not surface a "Lead" placeholder
                        // under Leads & upcoming either.
                        organization_archived: Boolean((c as any).archived),
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
