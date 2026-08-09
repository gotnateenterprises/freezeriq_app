/**
 * FR-RETENTION-4 — the tenant's incoming rebooking requests.
 *
 * GET → every submission for this tenant, newest first, with the per-organization
 *       opportunities attached.
 *
 * Tenant-scoped through session.user.businessId on every query. Nothing here
 * returns a token, a token digest, a normalized email, or an internal recipient
 * identifier that a tenant surface has no use for.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

/** Statuses that put a request in the tenant's "Needs action" queue. */
const NEEDS_ACTION = new Set(['interested', 'needs_review']);

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;

        const submissions = await prisma.rebookingSubmission.findMany({
            where: { business_id: businessId },
            orderBy: { updated_at: 'desc' },
            select: {
                id: true,
                current_revision: true,
                updated_at: true,
                seasonal_offering_id: true,
                recipient: {
                    select: {
                        display_name: true, email_masked: true, is_shared_inbox: true,
                        // The durable PEOPLE behind the address. OutreachRecipient
                        // .display_name is the masked address for a shared inbox,
                        // which is a useless thing to head a review screen with.
                        contacts: { select: { contact_display_name: true } },
                    },
                },
                // Full history, newest first. A revision is immutable, so this is
                // the audit trail — the tenant can see what was asked first and
                // what changed, not just the latest state.
                revisions: {
                    orderBy: { revision_number: 'desc' },
                    select: {
                        revision_number: true, created_at: true,
                        respondent_name: true, respondent_email: true, respondent_phone: true,
                        contact_update_requested: true,
                        preferred_start_date: true, alternate_start_date: true, preferred_end_date: true,
                        participant_estimate: true, notes: true,
                        orgs: { select: { organization_name: true, selected: true } },
                    },
                },
                opportunities: {
                    orderBy: { organization_name: 'asc' },
                    select: {
                        id: true, organization_name: true, status: true,
                        coordinator_intent: true, coordinator_name: true, coordinator_email: true,
                        preferred_start_date: true, alternate_start_date: true,
                        participant_estimate: true, canceled_at: true, reopened_at: true,
                        customer_id: true,
                    },
                },
            },
        });

        // "First fundraiser" on an organization card is a verified fact, so it is
        // looked up rather than guessed.
        //
        // FundraiserCampaign carries no business_id — it is tenant-scoped through
        // its customer. These ids all came from opportunities already filtered by
        // business_id, so the scope holds.
        const customerIds = [...new Set(submissions.flatMap((s) => s.opportunities.map((o) => o.customer_id)))];
        const withCampaigns = customerIds.length
            ? await prisma.fundraiserCampaign.findMany({
                where: { customer_id: { in: customerIds } },
                select: { customer_id: true },
                distinct: ['customer_id'],
            })
            : [];
        const hasRunBefore = new Set(withCampaigns.map((c) => c.customer_id));

        const lineupNameById = new Map<string, string>();
        const offerings = await prisma.seasonalOffering.findMany({
            where: { business_id: businessId },
            select: { id: true, name: true },
        });
        for (const o of offerings) lineupNameById.set(o.id, o.name);

        const requests = submissions.map((s) => {
            const latest = s.revisions[0] ?? null;
            const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

            // Name the PEOPLE, not the mailbox. Falls back to the recipient's
            // display name only when the address represents nobody we can name.
            //
            // DISTINCT names, deliberately. One person coordinating three
            // organizations is three separate FundraiserContact rows — that is
            // Checkpoint 1's identity rule working correctly — but rendering it
            // as "Riley Marsh, Riley Marsh, Riley Marsh" would make a correct
            // model look broken. The count that matters to a reviewer is how many
            // DIFFERENT people could have answered.
            const contactNames = [...new Set(
                s.recipient.contacts.map((c) => c.contact_display_name).filter(Boolean),
            )];
            const respondentName = contactNames.length === 0
                ? s.recipient.display_name
                : contactNames.length === 1
                    ? contactNames[0]
                    // Several different people share this inbox and we cannot
                    // know which one answered, so the header says so.
                    : `${contactNames[0]} + ${contactNames.length - 1} other${contactNames.length === 2 ? '' : 's'}`;

            return {
                id: s.id,
                lineupName: lineupNameById.get(s.seasonal_offering_id) ?? '',
                respondentName,
                respondentContactNames: contactNames,
                respondentEmailMasked: s.recipient.email_masked,
                isSharedInbox: s.recipient.is_shared_inbox,
                revisionNumber: s.current_revision,
                submittedAt: (latest?.created_at ?? s.updated_at).toISOString(),
                // Only true from revision 2 onward — a first submission is not
                // an edit, and calling it one would be misleading.
                wasEdited: s.current_revision > 1,
                details: latest
                    ? {
                        preferredStartDate: iso(latest.preferred_start_date),
                        alternateStartDate: iso(latest.alternate_start_date),
                        preferredEndDate: iso(latest.preferred_end_date),
                        participantEstimate: latest.participant_estimate,
                        notes: latest.notes,
                    }
                    : null,
                contactCorrection: latest?.contact_update_requested
                    ? {
                        name: latest.respondent_name,
                        email: latest.respondent_email,
                        phone: latest.respondent_phone,
                    }
                    : null,
                // Every earlier revision, newest first. Immutable, so this is a
                // record of what was actually said each time — not a reconstruction.
                history: s.revisions.slice(1).map((r) => ({
                    revisionNumber: r.revision_number,
                    submittedAt: r.created_at.toISOString(),
                    preferredStartDate: iso(r.preferred_start_date),
                    preferredEndDate: iso(r.preferred_end_date),
                    alternateStartDate: iso(r.alternate_start_date),
                    participantEstimate: r.participant_estimate,
                    notes: r.notes,
                    selectedOrganizations: r.orgs.filter((o) => o.selected).map((o) => o.organization_name),
                    notSelectedOrganizations: r.orgs.filter((o) => !o.selected).map((o) => o.organization_name),
                })),
                organizations: s.opportunities.map((o) => ({
                    id: o.id,
                    name: o.organization_name,
                    status: o.status,
                    isFirstFundraiser: !hasRunBefore.has(o.customer_id),
                    coordinatorIntent: o.coordinator_intent,
                    coordinatorName: o.coordinator_name,
                    coordinatorEmail: o.coordinator_email,
                    preferredStartDate: iso(o.preferred_start_date),
                    alternateStartDate: iso(o.alternate_start_date),
                    participantEstimate: o.participant_estimate,
                    canceledAt: o.canceled_at?.toISOString() ?? null,
                    reopenedAt: o.reopened_at?.toISOString() ?? null,
                })),
                needsAction: s.opportunities.some((o) => NEEDS_ACTION.has(o.status)),
            };
        });

        return NextResponse.json({
            requests,
            counts: {
                total: requests.length,
                needsAction: requests.filter((r) => r.needsAction).length,
            },
        });
    } catch (e) {
        console.error('[Rebooking requests] GET failed:', e);
        return NextResponse.json({ error: 'Failed to load rebooking requests' }, { status: 500 });
    }
}
