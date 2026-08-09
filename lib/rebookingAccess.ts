/**
 * FR-RETENTION-4 — resolving a rebooking link.
 *
 * This is the only place a raw rebooking token is ever accepted. It hashes the
 * incoming token, looks the digest up, and returns either a fully-scoped context
 * or an honest reason the link cannot be used.
 *
 * TENANT SCOPING: the URL carries no business identifier, and it must not — a
 * public link that names its tenant leaks the customer list. Scope is DERIVED:
 * everything below descends from the one recipient row the digest resolved to,
 * so no query can reach another tenant's data even in principle.
 *
 * LOGGING: nothing in this module logs the token, the digest, or the URL. Server
 * access logs at the platform layer will still record the request path, and that
 * is outside this repository's control — see the checkpoint report.
 */

import { prisma } from '@/lib/db';
import { resolveEligibleBundleFamilies } from '@/lib/campaignBundleSelection';
import {
    classifyRebookingCredential,
    hashRebookingToken,
    type RebookingTokenState,
} from '@/lib/rebookingToken';

/** `invalid` means no such digest — deliberately indistinguishable from a typo. */
export type RebookingAccessState = RebookingTokenState | 'invalid';

export interface RebookingOrgOption {
    customerId: string;
    organizationName: string;
}

export interface RebookingSubmittedOrg {
    customerId: string;
    organizationName: string;
    selected: boolean;
    coordinatorIntent: 'yes' | 'no' | 'not_sure';
    coordinatorName: string | null;
    coordinatorEmail: string | null;
}

export interface RebookingSubmittedState {
    revisionNumber: number;
    submittedAt: Date;
    preferredStartDate: Date | null;
    alternateStartDate: Date | null;
    preferredEndDate: Date | null;
    participantEstimate: number | null;
    notes: string | null;
    orgs: RebookingSubmittedOrg[];
}

export interface RebookingContext {
    businessId: string;
    businessName: string;
    recipientId: string;
    /** Who the email went to, as frozen in the audience snapshot. */
    recipientDisplayName: string;
    recipientEmailMasked: string | null;
    /**
     * True when this address stands for more than one durable contact. When it
     * does we genuinely do not know who is reading, and the form says so rather
     * than addressing them by a name that may not be theirs.
     */
    isSharedInbox: boolean;
    seasonalOfferingId: string;
    lineupName: string;
    lineupStartsAt: Date;
    lineupEndsAt: Date;
    /** Bundle family display names for the season, in lineup order. */
    familyNames: string[];
    organizations: RebookingOrgOption[];
    submission: RebookingSubmittedState | null;
    expiresAt: Date | null;
    refreshRequestedAt: Date | null;
}

export interface RebookingAccessResult {
    state: RebookingAccessState;
    /** Present for every state except `invalid`. */
    context: RebookingContext | null;
}

/** Shape of the recipient row this module needs. Kept explicit for clarity. */
const RECIPIENT_SELECT = {
    id: true,
    business_id: true,
    display_name: true,
    email_masked: true,
    is_shared_inbox: true,
    rebooking_token_issued_at: true,
    rebooking_token_expires_at: true,
    rebooking_token_revoked_at: true,
    refresh_requested_at: true,
    outreach_batch_id: true,
    orgs: { select: { customer_id: true, organization_name: true } },
} as const;

/**
 * Resolve a raw token to a usable context.
 *
 * Returns `invalid` with no context for an unknown digest. Every other state
 * still carries the context, because an expired or already-answered link must
 * still be able to say WHICH season and WHOSE request it refers to — a bare
 * "invalid" page for a link that merely expired is accurate and useless.
 */
export async function resolveRebookingAccess(
    rawToken: string,
    now: Date = new Date(),
): Promise<RebookingAccessResult> {
    const token = (rawToken ?? '').trim();
    if (!token) return { state: 'invalid', context: null };

    const digest = hashRebookingToken(token);

    const recipient = await prisma.outreachRecipient.findUnique({
        where: { rebooking_token_hash: digest },
        select: RECIPIENT_SELECT,
    });
    if (!recipient) return { state: 'invalid', context: null };

    const businessId = recipient.business_id;

    const [business, batch, submission] = await Promise.all([
        prisma.business.findUnique({ where: { id: businessId }, select: { name: true } }),
        prisma.outreachBatch.findFirst({
            where: { business_id: businessId, id: recipient.outreach_batch_id },
            select: {
                seasonal_offering_id: true,
                offering: {
                    select: {
                        id: true, name: true, starts_at: true, ends_at: true,
                        families: { select: { family_id: true, position: true }, orderBy: { position: 'asc' } },
                    },
                },
            },
        }),
        prisma.rebookingSubmission.findFirst({
            where: { business_id: businessId, outreach_recipient_id: recipient.id },
            select: {
                id: true,
                revisions: {
                    orderBy: { revision_number: 'desc' },
                    take: 1,
                    select: {
                        revision_number: true, created_at: true,
                        preferred_start_date: true, alternate_start_date: true, preferred_end_date: true,
                        participant_estimate: true, notes: true,
                        orgs: {
                            select: {
                                customer_id: true, organization_name: true, selected: true,
                                coordinator_intent: true, coordinator_name: true, coordinator_email: true,
                            },
                        },
                    },
                },
            },
        }),
    ]);

    // A recipient whose lineup or business has gone is not a usable link.
    if (!business || !batch?.offering) return { state: 'invalid', context: null };

    // Family display names come from the CB-4 resolver, so the public page can
    // never show a family the tenant could not actually sell.
    const eligible = await resolveEligibleBundleFamilies(businessId);
    const nameByFamily = new Map(eligible.map((f) => [f.familyId, f.serves5.name]));
    const familyNames = batch.offering.families
        .map((f) => nameByFamily.get(f.family_id))
        .filter((n): n is string => Boolean(n));

    const latest = submission?.revisions[0] ?? null;

    const context: RebookingContext = {
        businessId,
        businessName: business.name,
        recipientId: recipient.id,
        recipientDisplayName: recipient.display_name,
        recipientEmailMasked: recipient.email_masked,
        isSharedInbox: recipient.is_shared_inbox,
        seasonalOfferingId: batch.offering.id,
        lineupName: batch.offering.name,
        lineupStartsAt: batch.offering.starts_at,
        lineupEndsAt: batch.offering.ends_at,
        familyNames,
        organizations: recipient.orgs.map((o) => ({
            customerId: o.customer_id,
            organizationName: o.organization_name,
        })),
        submission: latest
            ? {
                revisionNumber: latest.revision_number,
                submittedAt: latest.created_at,
                preferredStartDate: latest.preferred_start_date,
                alternateStartDate: latest.alternate_start_date,
                preferredEndDate: latest.preferred_end_date,
                participantEstimate: latest.participant_estimate,
                notes: latest.notes,
                orgs: latest.orgs.map((o) => ({
                    customerId: o.customer_id,
                    organizationName: o.organization_name,
                    selected: o.selected,
                    coordinatorIntent: o.coordinator_intent,
                    coordinatorName: o.coordinator_name,
                    coordinatorEmail: o.coordinator_email,
                })),
            }
            : null,
        expiresAt: recipient.rebooking_token_expires_at,
        refreshRequestedAt: recipient.refresh_requested_at,
    };

    const state = classifyRebookingCredential(
        {
            issuedAt: recipient.rebooking_token_issued_at,
            expiresAt: recipient.rebooking_token_expires_at,
            revokedAt: recipient.rebooking_token_revoked_at,
            hasSubmission: Boolean(submission),
        },
        now,
    );

    return { state, context };
}

/**
 * Can this link still ACCEPT a submission?
 *
 * `already_submitted` counts as writable, because updating an existing answer is
 * a first-class action — it appends a revision rather than creating a duplicate.
 * Expiry is checked independently so an old link cannot be edited forever.
 */
export function isWritableState(
    state: RebookingAccessState,
    expiresAt: Date | null,
    now: Date = new Date(),
): boolean {
    if (state === 'invalid' || state === 'revoked' || state === 'expired') return false;
    if (expiresAt && expiresAt <= now) return false;
    return true;
}
