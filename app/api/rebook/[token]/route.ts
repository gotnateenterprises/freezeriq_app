/**
 * FR-RETENTION-4 — the public rebooking endpoint.
 *
 *   GET  → the state of this link, and the current answer if there is one.
 *   POST → record a submission (or a revision of one).
 *
 * PUBLIC AND UNAUTHENTICATED. The token IS the credential, so:
 *   · the raw token is hashed before it touches the database, and is never
 *     logged, echoed back, or written into any response body;
 *   · tenant scope is DERIVED from the resolved recipient, never taken from the
 *     request, so a caller cannot address another tenant's data;
 *   · every organization is checked against the ones this link represents, so a
 *     crafted payload cannot book for a group that was never invited.
 *
 * WHAT THIS ENDPOINT DELIBERATELY DOES NOT DO: it does not touch FundraiserContact,
 * it does not create a CampaignContact or any access grant, it does not create a
 * FundraiserCampaign, and it does not schedule anything. A contact correction is
 * recorded as EVIDENCE on the revision for the tenant to accept or reject.
 */

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { resolveRebookingAccess, isWritableState } from '@/lib/rebookingAccess';
import {
    planOpportunityReconciliation,
    validateSubmission,
    type CoordinatorIntent,
    type ExistingOpportunity,
    type SubmittedDetails,
    type SubmittedOrg,
} from '@/lib/rebookingSubmission';

export const dynamic = 'force-dynamic';

const INTENTS: CoordinatorIntent[] = ['yes', 'no', 'not_sure'];

function asIntent(value: unknown): CoordinatorIntent {
    return INTENTS.includes(value as CoordinatorIntent) ? (value as CoordinatorIntent) : 'not_sure';
}

function asTrimmed(value: unknown, max = 500): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    return v ? v.slice(0, max) : null;
}

/**
 * A date-only answer, stored the way the rest of this codebase stores calendar
 * dates: UTC midnight. Anything else re-introduces the "Sep 1 renders as Aug 31"
 * bug that FR-RETENTION-3C fixed.
 */
function asCalendarDate(value: unknown): Date | null {
    if (typeof value !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const d = new Date(`${m[0]}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Returns NaN rather than null for unparseable input, so "I typed nonsense" is
 * distinguishable from "I left it blank" — the first earns an error message, the
 * second is a perfectly good answer.
 */
function asCount(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

/**
 * Deterministic claim key for one submit.
 *
 * Includes the revision number this submit is TARGETING, which is what makes a
 * double-tap and a genuine change-your-mind-back-again distinguishable: the
 * double-tap aims at the same revision and dedupes, while a later revert aims at
 * a different one and is correctly recorded as its own revision.
 */
function submissionIdempotencyKey(recipientId: string, revisionNumber: number, payload: unknown): string {
    return createHash('sha256')
        .update(`${recipientId}|${revisionNumber}|${JSON.stringify(payload)}`, 'utf8')
        .digest('hex');
}

/** Everything a respondent-facing surface is allowed to know. No token, no ids. */
function publicView(state: string, ctx: Awaited<ReturnType<typeof resolveRebookingAccess>>['context']) {
    if (!ctx) return { state };
    return {
        state,
        businessName: ctx.businessName,
        lineupName: ctx.lineupName,
        familyNames: ctx.familyNames,
        isSharedInbox: ctx.isSharedInbox,
        recipientDisplayName: ctx.recipientDisplayName,
        recipientEmailMasked: ctx.recipientEmailMasked,
        refreshRequested: Boolean(ctx.refreshRequestedAt),
        organizations: ctx.organizations.map((o) => ({ id: o.customerId, name: o.organizationName })),
        submission: ctx.submission
            ? {
                revisionNumber: ctx.submission.revisionNumber,
                submittedAt: ctx.submission.submittedAt.toISOString(),
                preferredStartDate: ctx.submission.preferredStartDate?.toISOString().slice(0, 10) ?? null,
                alternateStartDate: ctx.submission.alternateStartDate?.toISOString().slice(0, 10) ?? null,
                preferredEndDate: ctx.submission.preferredEndDate?.toISOString().slice(0, 10) ?? null,
                participantEstimate: ctx.submission.participantEstimate,
                notes: ctx.submission.notes,
                orgs: ctx.submission.orgs.map((o) => ({
                    id: o.customerId,
                    name: o.organizationName,
                    selected: o.selected,
                    coordinatorIntent: o.coordinatorIntent,
                    coordinatorName: o.coordinatorName,
                    coordinatorEmail: o.coordinatorEmail,
                })),
            }
            : null,
    };
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
    try {
        const { token } = await ctx.params;
        const { state, context } = await resolveRebookingAccess(token);
        return NextResponse.json(publicView(state, context));
    } catch (e) {
        // Deliberately does not include the error's message, which could carry
        // the query and therefore the digest.
        console.error('[Rebooking] link lookup failed');
        void e;
        return NextResponse.json({ state: 'error' }, { status: 500 });
    }
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
    try {
        const { token } = await ctx.params;
        const now = new Date();
        const { state, context } = await resolveRebookingAccess(token, now);

        if (!context) {
            return NextResponse.json({ ok: false, state: 'invalid' }, { status: 404 });
        }
        if (!isWritableState(state, context.expiresAt, now)) {
            // 409, not 403: the link was real, it just cannot be used now.
            return NextResponse.json({ ok: false, state }, { status: 409 });
        }

        const body = await req.json().catch(() => ({} as Record<string, unknown>));

        const representedIds = context.organizations.map((o) => o.customerId);
        const nameById = new Map(context.organizations.map((o) => [o.customerId, o.organizationName]));

        const rawOrgs = Array.isArray(body.organizations) ? body.organizations : [];
        // Built from the REPRESENTED list, not from the payload, so an unselected
        // organization is always recorded rather than being able to vanish by
        // simply being left out of the request.
        const orgs: SubmittedOrg[] = representedIds.map((customerId) => {
            const sent = rawOrgs.find((o: Record<string, unknown>) => o && o.id === customerId) as
                Record<string, unknown> | undefined;
            const selected = Boolean(sent?.selected);
            return {
                customerId,
                organizationName: nameById.get(customerId)!,
                selected,
                coordinatorIntent: selected ? asIntent(sent?.coordinatorIntent) : 'not_sure',
                coordinatorName: selected ? asTrimmed(sent?.coordinatorName, 200) : null,
                coordinatorEmail: selected ? asTrimmed(sent?.coordinatorEmail, 320) : null,
                orgNotes: selected ? asTrimmed(sent?.orgNotes, 1000) : null,
            };
        });

        // Any organization in the payload that this link does not represent is a
        // hard refusal, not a silent drop.
        const unknown = rawOrgs.filter(
            (o: Record<string, unknown>) => o && typeof o.id === 'string' && !representedIds.includes(o.id),
        );
        if (unknown.length > 0) {
            return NextResponse.json(
                { ok: false, errors: ['This link cannot book for one of the organizations that was submitted.'] },
                { status: 400 },
            );
        }

        const details: SubmittedDetails = {
            preferredStartDate: asCalendarDate(body.preferredStartDate),
            alternateStartDate: asCalendarDate(body.alternateStartDate),
            preferredEndDate: asCalendarDate(body.preferredEndDate),
            participantEstimate: asCount(body.participantEstimate),
            notes: asTrimmed(body.notes, 2000),
        };

        const validation = validateSubmission(orgs, details, representedIds);
        if (!validation.ok) {
            return NextResponse.json({ ok: false, errors: validation.errors }, { status: 400 });
        }

        // Contact correction: EVIDENCE ONLY. Recorded on the revision so the
        // tenant can accept or reject it. Nothing here writes to FundraiserContact.
        const respondentName = asTrimmed(body.respondentName, 200);
        const respondentEmail = asTrimmed(body.respondentEmail, 320);
        const respondentPhone = asTrimmed(body.respondentPhone, 60);
        const contactUpdateRequested = Boolean(respondentName || respondentEmail || respondentPhone);

        const businessId = context.businessId;

        const result = await prisma.$transaction(async (tx) => {
            const submission = await tx.rebookingSubmission.upsert({
                where: { outreach_recipient_id: context.recipientId },
                create: {
                    business_id: businessId,
                    seasonal_offering_id: context.seasonalOfferingId,
                    outreach_recipient_id: context.recipientId,
                    current_revision: 0,
                },
                update: {},
                select: { id: true, current_revision: true },
            });

            const revisionNumber = submission.current_revision + 1;
            const idempotencyKey = submissionIdempotencyKey(context.recipientId, revisionNumber, {
                orgs, details, respondentName, respondentEmail, respondentPhone,
            });

            const revision = await tx.rebookingSubmissionRevision.create({
                data: {
                    business_id: businessId,
                    submission_id: submission.id,
                    revision_number: revisionNumber,
                    respondent_name: respondentName,
                    respondent_email: respondentEmail,
                    respondent_phone: respondentPhone,
                    preferred_start_date: details.preferredStartDate,
                    alternate_start_date: details.alternateStartDate,
                    preferred_end_date: details.preferredEndDate,
                    participant_estimate: details.participantEstimate,
                    notes: details.notes,
                    contact_update_requested: contactUpdateRequested,
                    idempotency_key: idempotencyKey,
                },
                select: { id: true, revision_number: true },
            });

            // Written separately rather than nested: the org rows join back on
            // the COMPOSITE key (business_id, revision_id), and Prisma refuses to
            // let a nested create set business_id because it considers that
            // column part of the relation it is managing.
            //
            // EVERY represented organization is recorded, selected or not — that
            // is what makes a later deselection legible instead of a row that
            // silently disappears between revisions.
            await tx.rebookingSubmissionRevisionOrg.createMany({
                data: orgs.map((o) => ({
                    business_id: businessId,
                    revision_id: revision.id,
                    customer_id: o.customerId,
                    organization_name: o.organizationName,
                    selected: o.selected,
                    coordinator_intent: o.coordinatorIntent,
                    coordinator_name: o.coordinatorName,
                    coordinator_email: o.coordinatorEmail,
                    org_notes: o.orgNotes,
                })),
            });

            const existingRows = await tx.rebookingOpportunity.findMany({
                where: {
                    business_id: businessId,
                    seasonal_offering_id: context.seasonalOfferingId,
                    customer_id: { in: representedIds },
                },
                select: {
                    id: true, customer_id: true, status: true, coordinator_intent: true,
                    coordinator_name: true, coordinator_email: true,
                    preferred_start_date: true, alternate_start_date: true, participant_estimate: true,
                },
            });

            const existing: ExistingOpportunity[] = existingRows.map((r) => ({
                id: r.id,
                customerId: r.customer_id,
                status: r.status,
                coordinatorIntent: r.coordinator_intent,
                coordinatorName: r.coordinator_name,
                coordinatorEmail: r.coordinator_email,
                preferredStartDate: r.preferred_start_date,
                alternateStartDate: r.alternate_start_date,
                participantEstimate: r.participant_estimate,
            }));

            const plan = planOpportunityReconciliation(orgs, details, existing);
            const orgById = new Map(orgs.map((o) => [o.customerId, o]));

            for (const action of plan.actions) {
                const org = orgById.get(action.customerId)!;
                const shared = {
                    coordinator_intent: org.coordinatorIntent,
                    coordinator_name: org.coordinatorName,
                    coordinator_email: org.coordinatorEmail,
                    preferred_start_date: details.preferredStartDate,
                    alternate_start_date: details.alternateStartDate,
                    participant_estimate: details.participantEstimate,
                    notes: details.notes,
                    source_revision_id: revision.id,
                };

                if (action.kind === 'create') {
                    await tx.rebookingOpportunity.create({
                        data: {
                            business_id: businessId,
                            seasonal_offering_id: context.seasonalOfferingId,
                            customer_id: action.customerId,
                            outreach_recipient_id: context.recipientId,
                            submission_id: submission.id,
                            organization_name: action.organizationName,
                            status: action.status,
                            ...shared,
                        },
                    });
                } else if (action.kind === 'reopen') {
                    await tx.rebookingOpportunity.update({
                        where: { id: action.id },
                        data: { status: action.status, canceled_at: null, reopened_at: now, ...shared },
                    });
                } else if (action.kind === 'update') {
                    await tx.rebookingOpportunity.update({
                        where: { id: action.id },
                        data: { status: action.status, ...shared },
                    });
                } else if (action.kind === 'cancel') {
                    await tx.rebookingOpportunity.update({
                        where: { id: action.id },
                        data: { status: 'canceled', canceled_at: now },
                    });
                }
                // 'leave_converted' intentionally writes nothing.
            }

            await tx.rebookingSubmission.update({
                where: { id: submission.id },
                data: { current_revision: revisionNumber },
            });

            return { revisionNumber: revision.revision_number, plan };
        });

        const selectedCount = orgs.filter((o) => o.selected).length;

        return NextResponse.json({
            ok: true,
            revisionNumber: result.revisionNumber,
            selectedCount,
            added: result.plan.addedCustomerIds.map((id) => nameById.get(id)).filter(Boolean),
            removed: result.plan.removedCustomerIds.map((id) => nameById.get(id)).filter(Boolean),
            needsSecondLook: result.plan.changedAfterApprovalCustomerIds.map((id) => nameById.get(id)).filter(Boolean),
            alreadyUnderway: result.plan.untouchedConvertedCustomerIds.map((id) => nameById.get(id)).filter(Boolean),
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : '';

        // The deterministic claim key rejected an identical re-submit. That is a
        // double-tap, not a failure — report success without a second revision.
        if (message.includes('rebooking_submission_revisions_idempotency_key')) {
            return NextResponse.json({ ok: true, duplicate: true });
        }
        // Two submits raced for the same revision number. The other one won.
        if (message.includes('rebooking_submission_revisions_submission_number_key')
            || message.includes('rebooking_submissions_outreach_recipient_id_key')) {
            return NextResponse.json(
                { ok: false, errors: ['This request was just updated somewhere else. Reload the page to see it.'] },
                { status: 409 },
            );
        }

        console.error('[Rebooking] submission failed');
        return NextResponse.json(
            { ok: false, errors: ['Something went wrong. Your answers are still here — try again.'] },
            { status: 500 },
        );
    }
}
