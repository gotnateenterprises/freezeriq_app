/**
 * GE-5A — on-demand evaluator.
 *
 * POST — look for organizations worth recommending for one seasonal offering,
 * and record a candidate for each. That is the entire effect: candidates are
 * proposals a human must still approve, and GE-5A has no path that sends them.
 *
 * NO CRON. This runs only when a tenant asks. A background evaluator that can
 * create actions is the first step toward one that sends them, and nothing in
 * this phase needs it — scheduling is GE-7's decision to justify.
 *
 * REFUSES WHEN DISABLED. It never enables the policy as a side effect of being
 * called; a missing or disabled policy is a 409, not an invitation.
 *
 * Creates no OutreachBatch, OutreachMessage, EmailDeliveryAttempt,
 * MarketingPreference, EmailSuppressionEvent, or RebookingOpportunity.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { normalizeEmail } from '@/lib/seasonalAudience';
import { isRealCampaign, computeOrganizationImpact } from '@/lib/growth/impact';
import {
    AUTOMATION_ACTION_TYPE,
    decideCandidate,
    evaluateSuppression,
    buildRebookingReasons,
    type AutomationReason,
    type CandidateRefusal,
} from '@/lib/growth/automation';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const body = await req.json().catch(() => ({}));
        const offeringId = String(body.seasonal_offering_id ?? '');
        if (!offeringId) {
            return NextResponse.json({ error: 'seasonal_offering_id is required' }, { status: 400 });
        }

        const now = new Date();

        // ── 1. Policy ────────────────────────────────────────────────────────
        const policy = await prisma.automationPolicy.findUnique({
            where: {
                business_id_action_type: {
                    business_id: businessId,
                    action_type: AUTOMATION_ACTION_TYPE as never,
                },
            },
            select: { enabled: true },
        });

        if (!policy || !policy.enabled) {
            return NextResponse.json({
                error: 'Seasonal rebooking recommendations are turned off for this business.',
                policy_enabled: false,
            }, { status: 409 });
        }

        // ── 2. Offering — scoped to this tenant, so a foreign id simply misses
        const offering = await prisma.seasonalOffering.findFirst({
            where: { id: offeringId, business_id: businessId },
            select: { id: true, name: true, status: true, archived_at: true, ends_at: true },
        });
        if (!offering) {
            return NextResponse.json({ error: 'Seasonal offering not found' }, { status: 404 });
        }

        // Organizations already represented in the reviewed audience for this
        // offering. Read-only: GE-5A never edits an audience.
        const existingAudienceOrgs = await prisma.outreachRecipientOrg.findMany({
            where: {
                business_id: businessId,
                recipient: { batch: { seasonal_offering_id: offeringId } },
            },
            select: { customer_id: true },
        });
        const inAudience = new Set(existingAudienceOrgs.map(o => o.customer_id));

        // ── 3. Candidate organizations, with the history GE-4 already defines
        const orgs = await prisma.customer.findMany({
            where: {
                business_id: businessId,
                type: { in: ['fundraiser_org', 'organization'] as never },
            },
            select: {
                id: true,
                name: true,
                archived: true,
                campaigns: {
                    select: {
                        id: true, status: true, closed_at: true,
                        created_at: true, settlement_total: true,
                        orders: { select: { total_amount: true, canceled_at: true } },
                    },
                },
                org_contacts: {
                    where: { ended_at: null },
                    select: {
                        contact: {
                            select: {
                                contact_points: {
                                    where: { is_current: true },
                                    select: { normalized_value: true },
                                },
                            },
                        },
                    },
                },
            },
        });

        // ── 4. Suppression facts, straight from the FR-RETENTION tables ──────
        const [prefs, suppressions] = await Promise.all([
            prisma.marketingPreference.findMany({
                where: { business_id: businessId, status: { not: 'subscribed' as never } },
                select: { normalized_email: true, effective_until: true },
            }),
            prisma.emailSuppressionEvent.findMany({
                where: { business_id: businessId },
                select: { normalized_email: true, effective_until: true },
            }),
        ]);
        const suppressedEmails = new Set<string>();
        for (const p of [...prefs, ...suppressions]) {
            if (!p.normalized_email) continue;
            // An elapsed pause is not a suppression — same rule the send path uses.
            if (p.effective_until && p.effective_until.getTime() <= now.getTime()) continue;
            suppressedEmails.add(normalizeEmail(p.normalized_email));
        }

        const created: string[] = [];
        const skipped: Record<string, number> = {};
        const note = (r: CandidateRefusal | 'already_exists') => { skipped[r] = (skipped[r] ?? 0) + 1; };

        for (const org of orgs) {
            const impact = computeOrganizationImpact({
                organizationId: org.id,
                organizationName: org.name,
                campaigns: org.campaigns.map(c => ({
                    id: c.id,
                    status: String(c.status),
                    closed_at: c.closed_at,
                    created_at: c.created_at,
                    settlement_total: c.settlement_total === null ? null : Number(c.settlement_total),
                    orders: c.orders.map(o => ({
                        total_amount: o.total_amount === null ? null : Number(o.total_amount),
                        canceled_at: o.canceled_at,
                    })),
                })),
            }, now);

            const emails = org.org_contacts
                .flatMap(oc => oc.contact.contact_points)
                .map(cp => cp.normalized_value)
                .filter((v): v is string => !!v);

            const decision = decideCandidate({
                policyEnabled: true,
                offering: {
                    status: String(offering.status),
                    archived_at: offering.archived_at,
                    ends_at: offering.ends_at,
                },
                target: {
                    realCampaignCount: org.campaigns.filter(c => isRealCampaign({ status: String(c.status) })).length,
                    archived: org.archived,
                },
                alreadyInReviewedAudience: inAudience.has(org.id),
                suppression: evaluateSuppression({ normalizedEmails: emails, suppressedEmails }),
                now,
            });

            if (!decision.create) { note(decision.refusal!); continue; }

            const reasons: AutomationReason[] = buildRebookingReasons({
                realCampaignCount: impact.campaignCount,
                lifetimeFundraiserSales: impact.lifetimeFundraiserSales,
                daysSinceLastCampaign: impact.daysSinceLastCampaign,
                offeringName: offering.name,
            });

            // ── CLAIM-BEFORE-ACT ─────────────────────────────────────────────
            // Attempt the insert and let the unique index arbitrate. A
            // SELECT-then-INSERT would leave a window in which two concurrent
            // evaluators both see "none" and both write; this cannot.
            try {
                await prisma.automationAction.create({
                    data: {
                        business_id: businessId,
                        action_type: AUTOMATION_ACTION_TYPE as never,
                        status: 'candidate' as never,
                        seasonal_offering_id: offering.id,
                        customer_id: org.id,
                        reasons: reasons as never,
                        evidence_at: now,
                        expires_at: offering.ends_at,
                    },
                    select: { id: true },
                });
                created.push(org.id);
            } catch {
                // Already claimed — by an earlier run or a concurrent one.
                note('already_exists');
            }
        }

        return NextResponse.json({
            seasonal_offering_id: offering.id,
            created_count: created.length,
            skipped,
        });
    } catch (e: unknown) {
        console.error('[growth/automation/evaluate]', e);
        return NextResponse.json({ error: 'Failed to evaluate recommendations' }, { status: 500 });
    }
}
