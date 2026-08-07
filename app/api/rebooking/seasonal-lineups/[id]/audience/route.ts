/**
 * FR-RETENTION-2 — audience review and snapshot.
 *
 *   GET  → calculate and preview the audience. Reads only; writes nothing.
 *   POST → finalize the reviewed audience into a durable snapshot.
 *
 * NO EMAIL IS SENT by either verb, and neither creates a rebooking token.
 * POST is the deliberate "Continue to Email Preview" action.
 *
 * TENANT-SAFE OUTPUT: normalized email addresses, recipient ids, preference
 * internals and suppression-event ids are never returned. Addresses appear only
 * masked.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { loadAudienceInputs } from '@/lib/seasonalLineup';
import { resolveAudience, type ResolvedRecipient } from '@/lib/seasonalAudience';

export interface AudienceRow {
    /** Stable within one response; derived from position, not from any id. */
    key: string;
    displayName: string;
    emailMasked: string | null;
    isSharedInbox: boolean;
    /** e.g. "Shared inbox — one email will represent 2 contacts / 2 organizations." */
    sharedInboxNote: string | null;
    contactNames: string[];
    organizationNames: string[];
    group: 'ready' | 'cant_email' | 'needs_review';
    statusLabel: string;
    reasonText: string | null;
    canResubscribe: boolean;
    canFixContact: boolean;
    /**
     * Durable contact ids, sent ONLY for rows the tenant may re-subscribe, so
     * the confirmation dialog has something to target. These are the same
     * FundraiserContact ids the Rebooking dashboard already works with — not
     * recipient ids, and never a normalized address.
     */
    resubscribeContactIds: string[];
}

function sharedNote(r: ResolvedRecipient): string | null {
    if (!r.isSharedInbox) return null;
    const people = r.contacts.length;
    const orgs = r.organizations.length;
    return `Shared inbox — one email will represent ${people} contact${people === 1 ? '' : 's'}`
        + ` / ${orgs} organization${orgs === 1 ? '' : 's'}.`;
}

function statusLabelFor(r: ResolvedRecipient): string {
    switch (r.exclusionReason) {
        case 'unsubscribed': return 'Unsubscribed';
        case 'shared_address_unsubscribed': return 'Shared address unsubscribed';
        case 'paused_until': return 'Paused';
        case 'not_interested_until': return 'Not interested';
        case 'invalid_email': return 'Invalid email';
        case 'no_email': return 'No email';
        case 'needs_review': return 'Needs review';
        default: return 'Ready to email';
    }
}

function toRow(r: ResolvedRecipient, i: number): AudienceRow {
    const group: AudienceRow['group'] =
        r.eligibility === 'included' ? 'ready' : r.eligibility === 'needs_review' ? 'needs_review' : 'cant_email';
    const canResubscribe = r.exclusionReason === 'unsubscribed' || r.exclusionReason === 'shared_address_unsubscribed';
    return {
        resubscribeContactIds: canResubscribe ? r.contacts.map((c) => c.contactId) : [],
        key: `r${i}`,
        displayName: r.displayName,
        emailMasked: r.emailMasked,
        isSharedInbox: r.isSharedInbox,
        sharedInboxNote: sharedNote(r),
        contactNames: r.contacts.map((c) => c.displayName),
        organizationNames: r.organizations.map((o) => o.name),
        group,
        statusLabel: statusLabelFor(r),
        reasonText: r.exclusionDetail,
        canResubscribe,
        canFixContact: r.exclusionReason === 'no_email' || r.exclusionReason === 'invalid_email',
    };
}

async function loadOwnedLineup(businessId: string, id: string) {
    return prisma.seasonalOffering.findFirst({
        where: { id, business_id: businessId },
        select: { id: true, name: true, status: true },
    });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const { id } = await ctx.params;

        const lineup = await loadOwnedLineup(businessId, id);
        if (!lineup) return NextResponse.json({ error: 'Seasonal lineup not found' }, { status: 404 });

        const { contacts, preferences } = await loadAudienceInputs(businessId);
        const audience = resolveAudience({ contacts, preferences, now: new Date() });

        const rows = audience.recipients.map(toRow);
        return NextResponse.json({
            lineupName: lineup.name,
            rows,
            counts: {
                ready: audience.includedCount,
                cantEmail: audience.excludedCount,
                needsReview: audience.needsReviewCount,
                // Organizations actually covered by the mail that would go out —
                // counting excluded rows here would overstate the reach.
                organizations: new Set(
                    audience.recipients
                        .filter((r) => r.eligibility === 'included')
                        .flatMap((r) => r.organizations.map((o) => o.customerId)),
                ).size,
            },
        });
    } catch (e) {
        console.error('[Audience] GET failed:', e);
        return NextResponse.json({ error: 'Failed to calculate the audience' }, { status: 500 });
    }
}

/**
 * Finalize. Idempotent by construction: the snapshot is rebuilt inside one
 * transaction, so a double-click produces the same single set of rows rather
 * than duplicates. The composite unique indexes are the backstop.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const { id } = await ctx.params;

        const lineup = await loadOwnedLineup(businessId, id);
        if (!lineup) return NextResponse.json({ error: 'Seasonal lineup not found' }, { status: 404 });

        const { contacts, preferences } = await loadAudienceInputs(businessId);
        const now = new Date();
        const audience = resolveAudience({ contacts, preferences, now });

        const batchId = await prisma.$transaction(async (tx) => {
            // Any existing audience for this lineup is REUSED, whatever its
            // status. Filtering to 'draft' here would let a second click create
            // a second audience, because the first click already promoted it to
            // audience_ready. A unique index on seasonal_offering_id is the
            // database-level backstop for the same rule.
            const existing = await tx.outreachBatch.findFirst({
                where: { business_id: businessId, seasonal_offering_id: id },
                select: { id: true },
            });

            const batch = existing
                ? await tx.outreachBatch.update({
                    where: { id: existing.id },
                    data: {
                        status: 'audience_ready',
                        audience_calculated_at: now,
                        recipient_count: audience.recipients.length,
                        included_count: audience.includedCount,
                        excluded_count: audience.excludedCount,
                        needs_review_count: audience.needsReviewCount,
                    },
                })
                : await tx.outreachBatch.create({
                    data: {
                        business_id: businessId,
                        seasonal_offering_id: id,
                        status: 'audience_ready',
                        audience_calculated_at: now,
                        recipient_count: audience.recipients.length,
                        included_count: audience.includedCount,
                        excluded_count: audience.excludedCount,
                        needs_review_count: audience.needsReviewCount,
                        created_by_user_id: (session.user as { id?: string }).id ?? null,
                    },
                });

            // Rebuilding rather than diffing is what makes re-finalizing safe:
            // the batch always ends with exactly one row per address.
            await tx.outreachRecipient.deleteMany({
                where: { business_id: businessId, outreach_batch_id: batch.id },
            });

            for (const r of audience.recipients) {
                const rec = await tx.outreachRecipient.create({
                    data: {
                        business_id: businessId,
                        outreach_batch_id: batch.id,
                        normalized_email: r.normalizedEmail,
                        display_name: r.displayName,
                        email_masked: r.emailMasked,
                        is_shared_inbox: r.isSharedInbox,
                        represented_contact_count: r.contacts.length,
                        represented_org_count: r.organizations.length,
                        represented_org_names: r.organizations.map((o) => o.name),
                        eligibility: r.eligibility,
                        exclusion_reason: r.exclusionReason,
                        exclusion_detail: r.exclusionDetail,
                        excluded_until: r.excludedUntil,
                        snapshot_at: now,
                    },
                });
                for (const c of r.contacts) {
                    await tx.outreachRecipientContact.create({
                        data: {
                            business_id: businessId,
                            outreach_recipient_id: rec.id,
                            contact_id: c.contactId,
                            contact_display_name: c.displayName,
                        },
                    });
                }
                for (const o of r.organizations) {
                    await tx.outreachRecipientOrg.create({
                        data: {
                            business_id: businessId,
                            outreach_recipient_id: rec.id,
                            customer_id: o.customerId,
                            organization_name: o.name,
                        },
                    });
                }
            }

            // The lineup is now locked against silent edits.
            await tx.seasonalOffering.update({ where: { id }, data: { status: 'in_use' } });

            return batch.id;
        });

        return NextResponse.json({
            ok: true,
            audienceId: batchId,
            counts: {
                ready: audience.includedCount,
                cantEmail: audience.excludedCount,
                needsReview: audience.needsReviewCount,
            },
        });
    } catch (e) {
        console.error('[Audience] POST failed:', e);
        return NextResponse.json({ error: 'Failed to save the audience' }, { status: 500 });
    }
}
