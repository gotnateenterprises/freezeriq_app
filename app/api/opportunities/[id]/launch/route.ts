/**
 * FR-FLOW-2B — POST /api/opportunities/[id]/launch
 *
 * Turns a date-confirmed FundraiserOpportunity into a fundraiser campaign that
 * is waiting on its coordinator.
 *
 * WHY THIS IS A SEPARATE ROUTE FROM POST /api/campaigns
 * That route already takes an `opportunityId`, and it means a RebookingOpportunity
 * — a different model, with a different status enum that also happens to contain
 * the value 'converted'. Overloading the parameter would have claimed the wrong
 * table and quietly corrupted the rebooking funnel. Different concept, different
 * endpoint.
 *
 * WHAT IT WRITES, ALL IN ONE TRANSACTION
 *   1. the campaign               (delivery_date from the opportunity, required end_date,
 *                                  org share, pending selection state, minted credential)
 *   2. the candidate bundle pool  (one row per family, Serves-5 canonical tier only)
 *   3. the primary coordinator    (campaign -> organization-contact relationship)
 *   4. the opportunity claim      (status + campaign_id + converted_at, together)
 *
 * Any guard that fails rolls the whole thing back: no orphan campaign, no orphan
 * candidate rows, no half-converted opportunity.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { mintCoordinatorPortalToken } from '@/lib/coordinatorPortalToken';
import { resolveEligibleBundleFamilies } from '@/lib/campaignBundleSelection';
import { buildCoordinatorAccessUrl } from '@/lib/fundraiserUrls';
import { decideOrgShareChange, isOrgShareRejected } from '@/lib/fundraiserOrgShare';
import { DEFAULT_BUNDLE_GOAL } from '@/lib/fundraiserMetrics';
import { resolveCampaignTaxSnapshot } from '@/lib/fundraiserTax';
import {
    AWAITING_COORDINATOR_SETUP_SELECTION_STATUS,
    LAUNCHED_CAMPAIGN_STATUS,
    checkCampaignName,
    checkCandidateFamilies,
    checkOpportunityLaunchable,
    checkOrderDeadline,
    checkPrimaryCoordinator,
    checkSelectionLimit,
    isRefusal,
    type LaunchRefusal,
} from '@/lib/fundraiserLaunch';

/**
 * Thrown when the guarded claim matched no row, which means another request
 * converted this opportunity first. Rolls the transaction back.
 */
class OpportunityClaimFailed extends Error {
    /**
     * Identified by a marker rather than `instanceof`. Subclassing a built-in
     * loses the prototype link when the class is downlevelled, so `instanceof`
     * is false under the test transform even though it holds in the app build —
     * which would have sent a rollback down the 500 path in production the first
     * time the toolchain target changed. A field cannot drift like that.
     */
    readonly isOpportunityClaimFailed = true as const;
    constructor() { super('opportunity_claim_failed'); }
}

function isClaimFailure(e: unknown): e is OpportunityClaimFailed {
    return typeof e === 'object' && e !== null && (e as any).isOpportunityClaimFailed === true;
}

function refuse(r: LaunchRefusal) {
    return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
}

/**
 * Everything the launch form needs, in one tenant-scoped read: the organization,
 * the locked delivery date, the coordinator candidates from this organization's
 * address book, and the bundle families this tenant may offer.
 *
 * Creates nothing — the same shape as the rebooking handoff endpoint. No
 * coordinator credential is returned; the campaign does not exist yet.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id: opportunityId } = await params;

        const opportunity = await prisma.fundraiserOpportunity.findFirst({
            where: { id: opportunityId, business_id: businessId },
            select: {
                id: true,
                status: true,
                customer_id: true,
                confirmed_delivery_date: true,
                campaign_id: true,
                participant_estimate: true,
                customer: { select: { id: true, name: true } },
            },
        });
        if (!opportunity) {
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }

        const launchable = checkOpportunityLaunchable(opportunity);

        // Coordinator candidates: ACTIVE relationships belonging to THIS
        // organization only. A tenant's wider address book is deliberately not
        // offered — a coordinator has to be a contact of the organization running
        // the fundraiser.
        const relationships = await prisma.fundraiserOrganizationContact.findMany({
            where: { business_id: businessId, customer_id: opportunity.customer_id, ended_at: null },
            select: {
                id: true,
                role: true,
                is_primary_relationship: true,
                contact: {
                    select: {
                        display_name: true,
                        archived_at: true,
                        contact_points: {
                            where: { is_current: true },
                            select: { type: true, value: true, is_primary: true },
                        },
                    },
                },
            },
        });

        const coordinatorCandidates = relationships
            .filter((r) => !r.contact.archived_at)
            .map((r) => {
                const pick = (t: string) =>
                    r.contact.contact_points.find((p) => p.type === t && p.is_primary)?.value
                    ?? r.contact.contact_points.find((p) => p.type === t)?.value
                    ?? null;
                return {
                    orgContactId: r.id,
                    displayName: r.contact.display_name,
                    role: r.role,
                    isPrimaryRelationship: r.is_primary_relationship,
                    email: pick('email'),
                    phone: pick('phone'),
                };
            });

        const families = await resolveEligibleBundleFamilies(businessId);

        return NextResponse.json({
            opportunity: {
                id: opportunity.id,
                status: opportunity.status,
                participantEstimate: opportunity.participant_estimate,
                // Read-only in the wizard: changing the date belongs to the
                // date-confirmation workflow, not to campaign launch.
                confirmedDeliveryDate: launchable.ok ? launchable.confirmedDeliveryDate : null,
                launchable: launchable.ok,
                refusal: launchable.ok ? null : { code: launchable.code, error: launchable.error },
                alreadyLaunchedCampaignId: opportunity.campaign_id,
            },
            organization: { id: opportunity.customer.id, name: opportunity.customer.name },
            coordinatorCandidates,
            bundleFamilies: families.map((f) => ({
                familyId: f.familyId,
                name: f.serves5.name,
                serves5: f.serves5,
                serves2: f.serves2,
            })),
        });
    } catch (e) {
        console.error('FR-FLOW-2 launch GET error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id: opportunityId } = await params;

        let body: any;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
        }

        // ── Resolve the opportunity, tenant-scoped ────────────────────────────
        // 404 rather than 403 so a tenant cannot probe for another tenant's ids.
        const opportunity = await prisma.fundraiserOpportunity.findFirst({
            where: { id: opportunityId, business_id: businessId },
            select: {
                id: true,
                status: true,
                customer_id: true,
                confirmed_delivery_date: true,
                campaign_id: true,
                // FR-TAX-1: the organization's tax posture, read here so the
                // campaign can freeze its own snapshot at launch.
                customer: { select: { tax_status: true } },
            },
        });
        if (!opportunity) {
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }

        // ── PART L: the date-confirmed server gate ────────────────────────────
        const launchable = checkOpportunityLaunchable(opportunity);
        if (isRefusal(launchable)) {
            // A retry after an ambiguous network result must not look like a
            // failure. If this opportunity already produced a campaign, hand back
            // that campaign instead of an error — the caller's intent is satisfied.
            if (launchable.code === 'already_converted' && opportunity.campaign_id) {
                return NextResponse.json(
                    { campaignId: opportunity.campaign_id, alreadyLaunched: true },
                    { status: 200 }
                );
            }
            return refuse(launchable);
        }

        // ── Validate the tenant's inputs ──────────────────────────────────────
        const named = checkCampaignName(body?.name);
        if (isRefusal(named)) return refuse(named);

        const deadline = checkOrderDeadline({
            endDate: body?.endDate,
            confirmedDeliveryDate: launchable.confirmedDeliveryDate,
        });
        if (isRefusal(deadline)) return refuse(deadline);

        const eligible = await resolveEligibleBundleFamilies(businessId);
        const candidates = checkCandidateFamilies({
            candidateFamilyIds: body?.candidateFamilyIds,
            eligibleFamilyIds: eligible.map((f) => f.familyId),
        });
        if (isRefusal(candidates)) return refuse(candidates);

        const limit = checkSelectionLimit({
            selectionLimit: body?.selectionLimit,
            candidateFamilyCount: candidates.candidateFamilyIds.length,
        });
        if (isRefusal(limit)) return refuse(limit);

        // ── PART Q: the primary coordinator ───────────────────────────────────
        // Scoped by business_id in the query, then checked against the
        // opportunity's organization. The same-tenant-wrong-organization case is
        // refused here by name, and is separately unwritable at the database.
        const orgContactId = typeof body?.orgContactId === 'string' ? body.orgContactId.trim() : '';
        const relationship = orgContactId
            ? await prisma.fundraiserOrganizationContact.findFirst({
                where: { id: orgContactId, business_id: businessId },
                select: { id: true, business_id: true, customer_id: true, ended_at: true },
            })
            : null;
        const coordinator = checkPrimaryCoordinator({
            row: relationship,
            expectedBusinessId: businessId,
            expectedCustomerId: opportunity.customer_id,
        });
        if (isRefusal(coordinator)) return refuse(coordinator);

        // ── PART N: organization share, via the existing INV-A contract ───────
        const shareDecision = decideOrgShareChange({
            requested: body?.orgSharePercent,
            user: session.user as any,
            campaignClosed: false,
        });
        if (isOrgShareRejected(shareDecision)) {
            return NextResponse.json({ error: shareDecision.error }, { status: shareDecision.status });
        }

        // ── FR-TAX-1: resolve the campaign's frozen tax treatment ─────────────
        const launchTaxBusiness = await prisma.business.findUnique({
            where: { id: businessId },
            select: { default_food_tax_percent: true },
        });
        const launchTaxSnapshot = resolveCampaignTaxSnapshot({
            organizationStatus: (opportunity.customer as any)?.tax_status ?? null,
            tenantDefaultRatePercent: launchTaxBusiness?.default_food_tax_percent as any,
        });

        // Candidate rows store the Serves-5 canonical bundle only; the Serves-2
        // sibling is resolved at read time from family_id + serving_tier. This is
        // the representation loadCandidateFamilies() already expects.
        const byFamily = new Map(eligible.map((f) => [f.familyId, f]));
        const candidateBundleIds = candidates.candidateFamilyIds.map(
            (familyId) => byFamily.get(familyId)!.serves5.id
        );

        // ── PART S: one transaction for the whole logical launch ──────────────
        let createdCampaignId: string;
        try {
            createdCampaignId = await prisma.$transaction(async (tx) => {
                const campaign = await tx.fundraiserCampaign.create({
                    data: {
                        customer_id: opportunity.customer_id,
                        name: named.name,
                        status: LAUNCHED_CAMPAIGN_STATUS,
                        // PART L: the confirmed date is the DELIVERY day. Never start_date.
                        delivery_date: new Date(`${launchable.confirmedDeliveryDate}T00:00:00.000Z`),
                        end_date: new Date(`${deadline.endDate}T00:00:00.000Z`),
                        // portal_token has no schema default on purpose; omitting it
                        // would write NULL and produce a campaign with no coordinator access.
                        portal_token: mintCoordinatorPortalToken(),
                        bundle_selection_status: AWAITING_COORDINATOR_SETUP_SELECTION_STATUS,
                        bundle_selection_limit: limit.selectionLimit,
                        bundle_selection_at: null,
                        // FR-GOAL-CONFIG-1: this streamlined flow has no goal
                        // input UI, so it always gets the shared default —
                        // written explicitly rather than left to the DB
                        // default, so the JS constant stays the one authority.
                        bundle_goal: DEFAULT_BUNDLE_GOAL,
                        // FR-TAX-1: this streamlined flow has no tax input UI,
                        // so the snapshot is whatever the organization's own
                        // status and the tenant's default rate resolve to —
                        // frozen here, never recomputed later.
                        tax_status: launchTaxSnapshot.status as any,
                        tax_rate_percent: launchTaxSnapshot.ratePercent,
                        ...(shareDecision.change ? { org_share_percent: shareDecision.percent } : {}),
                    },
                    select: { id: true },
                });

                await tx.campaignBundle.createMany({
                    data: candidateBundleIds.map((bundleId, position) => ({
                        campaign_id: campaign.id,
                        bundle_id: bundleId,
                        state: 'candidate',
                        position,
                    })),
                });

                // PART Q: the campaign's primary coordinator. Both foreign keys are
                // keyed on this one customer_id, so Postgres will refuse the row
                // outright if the campaign and the relationship disagree about the
                // organization.
                await tx.fundraiserCampaignCoordinator.create({
                    data: {
                        campaign_id: campaign.id,
                        customer_id: opportunity.customer_id,
                        org_contact_id: coordinator.orgContactId,
                    },
                });

                // ── PART G: the claim, as ONE indivisible statement ────────────
                //
                // status, campaign_id and converted_at move together. Writing
                // campaign_id while leaving the status at 'date_confirmed' would
                // leave the row inside the predicate of
                // fundraiser_opportunities_one_open_per_org, which covers
                // ('new','in_conversation','date_confirmed') — permanently locking
                // the organization out of ever filing another inquiry. Flipping the
                // status is what releases the organization for a future season.
                //
                // The WHERE clause carries the full guard, so two concurrent
                // requests serialize on this row: the loser re-evaluates after the
                // winner commits, matches zero rows, and its entire transaction —
                // campaign, candidates and coordinator included — rolls back.
                const claimed = await tx.fundraiserOpportunity.updateMany({
                    where: {
                        id: opportunityId,
                        business_id: businessId,
                        status: 'date_confirmed',
                        campaign_id: null,
                    },
                    data: {
                        status: 'converted',
                        campaign_id: campaign.id,
                        converted_at: new Date(),
                    },
                });
                if (claimed.count !== 1) throw new OpportunityClaimFailed();

                return campaign.id;
            });
        } catch (e) {
            if (isClaimFailure(e)) {
                // The winner has committed by now. Return ITS campaign, so a
                // double-click or a retry resolves to one fundraiser rather than an error.
                const settled = await prisma.fundraiserOpportunity.findFirst({
                    where: { id: opportunityId, business_id: businessId },
                    select: { campaign_id: true },
                });
                if (settled?.campaign_id) {
                    return NextResponse.json(
                        { campaignId: settled.campaign_id, alreadyLaunched: true },
                        { status: 200 }
                    );
                }
                return NextResponse.json(
                    { error: 'This opportunity could not be launched. Refresh and try again.', code: 'claim_failed' },
                    { status: 409 }
                );
            }
            throw e;
        }

        // The setup link, so the tenant can hand it to the coordinator immediately.
        //
        // This returns the credential to an AUTHENTICATED, tenant-scoped caller in a
        // response body — the same way /api/campaigns already ships portal_token to
        // this same tenant for CampaignCard to build the link from. It is not a new
        // exposure, and it is what FR-COORD-SEC actually forbade that matters: the
        // credential never appears in a URL path, a query string, a log line, or a
        // referrer. It is minted once, sent once, over TLS, to the person entitled
        // to it. Nothing here is written to the server log.
        const coordinatorAccessUrl = await (async () => {
            const c = await prisma.fundraiserCampaign.findUnique({
                where: { id: createdCampaignId },
                select: { portal_token: true },
            });
            return c?.portal_token ? buildCoordinatorAccessUrl(req, c.portal_token) : null;
        })();

        return NextResponse.json(
            { campaignId: createdCampaignId, alreadyLaunched: false, coordinatorAccessUrl },
            { status: 201 }
        );
    } catch (e) {
        console.error('FR-FLOW-2 launch error:', e);
        return NextResponse.json({ error: 'Server Error' }, { status: 500 });
    }
}
