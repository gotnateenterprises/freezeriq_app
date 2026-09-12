/**
 * FR-COORD-ROUTING-DATE-1 — who receives a CAMPAIGN's operational mail.
 *
 * ── THE PROBLEM THIS EXISTS TO END ──────────────────────────────────────────
 *
 * "The coordinator" had three different answers in three different files:
 *
 *   app/api/campaigns/[id]/coordinator-email  the ASSIGNED coordinator, strictly
 *                                             (refuses rather than guess)
 *   app/api/coordinator (portal share copy)   the ASSIGNED coordinator, with an
 *                                             organization fallback
 *   app/api/public/order (new-order notice)   Customer.contact_email ONLY
 *
 * The third one is how Cumberland Co Farm Bureau's first supporter order
 * notified Lindsey Vogt — the ORGANIZATION's on-file contact — instead of
 * Kristi Shirley, the coordinator actually assigned to that campaign, who had
 * received the setup email and was running the fundraiser. Nothing in the data
 * was wrong: both people are real, both records are correct. The code simply
 * asked the wrong question.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 *   assigned campaign coordinator  →  organization contact  →  nobody
 *
 * The assignment wins because it is the only record of "who agreed to run THIS
 * fundraiser". The organization contact is a real and separate concept — the
 * relationship owner — and is deliberately NOT overwritten or displaced by any
 * of this; it simply stops being the first answer to a campaign-scoped question.
 *
 * ── WHY THIS IS A PURE FUNCTION ─────────────────────────────────────────────
 *
 * The policy takes already-fetched rows and returns a decision, matching the
 * house pattern (resolveCampaignTaxSnapshot, decideOrgShareChange). That makes
 * the rule testable without Prisma, a session, or a route — and it means the
 * query shape lives in exactly one exported constant that every caller reuses.
 */
import { normalizeSupporterEmail } from '@/lib/previousSupporters';

/**
 * The Prisma `select` every caller uses to load a campaign's coordinator
 * assignment. Exported so the query shape cannot drift between routes.
 *
 * Contact points are narrowed to CURRENT email addresses and ordered primary-
 * first, so `contact_points[0]` is "the address to use" with no further logic.
 */
// NOT `as const`: Prisma's select types require a MUTABLE orderBy array, and a
// readonly tuple is rejected at the call site. The object is exported as a
// plain literal so every caller shares the identical shape.
export const CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT = {
    org_contact: {
        select: {
            ended_at: true,
            contact: {
                select: {
                    display_name: true,
                    contact_points: {
                        where: { type: 'email' as const, is_current: true },
                        select: { value: true, is_primary: true },
                        orderBy: [{ is_primary: 'desc' as const }, { id: 'asc' as const }],
                    },
                },
            },
        },
    },
};

/** The shape CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT produces, loosened so a
 *  caller that selects extra fields still type-checks. */
export interface CoordinatorAssignmentRow {
    org_contact?: {
        ended_at?: Date | string | null;
        contact?: {
            display_name?: string | null;
            contact_points?: ReadonlyArray<{ value?: string | null }> | null;
        } | null;
    } | null;
}

export type AssignedCoordinatorRejection =
    | 'no_assignment'
    /** The person is no longer a contact of this organization. */
    | 'relationship_ended'
    /** Assigned, current — but nothing deliverable on file. */
    | 'no_usable_email';

export type AssignedCoordinatorOutcome =
    | { usable: true; name: string | null; email: string }
    | { usable: false; reason: AssignedCoordinatorRejection };

/**
 * Read the assigned coordinator, or say precisely why there isn't a usable one.
 *
 * The email is validated with normalizeSupporterEmail — the same deliverability
 * check the supporter path uses (one @, a dotted domain, no whitespace, length
 * capped). A row can hold anything; "there is a string here" is not the same as
 * "this is an address we can send to", and sending operational mail into a typo
 * is worse than falling back to a contact we know is reachable.
 *
 * The ORIGINAL trimmed value is returned, not the normalized one: normalization
 * lowercases, and while domains are case-insensitive the local part is not
 * guaranteed to be. Normalization decides validity; it does not rewrite the
 * address we send to.
 */
export function readAssignedCoordinator(
    assignment: CoordinatorAssignmentRow | null | undefined
): AssignedCoordinatorOutcome {
    const orgContact = assignment?.org_contact;
    if (!assignment || !orgContact) {
        return { usable: false, reason: 'no_assignment' };
    }
    if (orgContact.ended_at) {
        return { usable: false, reason: 'relationship_ended' };
    }

    const name = orgContact.contact?.display_name?.trim() || null;
    const points = orgContact.contact?.contact_points ?? [];
    for (const point of points) {
        const raw = typeof point?.value === 'string' ? point.value.trim() : '';
        if (raw && normalizeSupporterEmail(raw)) {
            return { usable: true, name, email: raw };
        }
    }
    return { usable: false, reason: 'no_usable_email' };
}

export type CampaignCoordinatorSource = 'assigned' | 'organization' | 'none';

export interface CampaignCoordinatorContact {
    /** Display name for the resolved recipient, when one is on file. */
    name: string | null;
    /** The address to send campaign operational mail to. Null means send nothing. */
    email: string | null;
    source: CampaignCoordinatorSource;
    /** Why the assignment was or wasn't used — for logging and for callers
     *  (like the setup-email route) that must refuse rather than fall back. */
    assigned: AssignedCoordinatorOutcome;
}

export interface OrganizationContactRow {
    contact_name?: unknown;
    contact_email?: unknown;
}

/**
 * Resolve the recipient for CAMPAIGN-SCOPED operational mail.
 *
 * Name and email fall back together, as a pair. Falling back to the
 * organization's address while keeping the assigned coordinator's name would
 * produce a message addressed to Kristi that lands in Lindsey's inbox — a
 * worse outcome than either contact alone, because the reader cannot tell the
 * message was misrouted.
 */
export function resolveCampaignCoordinator(input: {
    assignment: CoordinatorAssignmentRow | null | undefined;
    organization?: OrganizationContactRow | null;
}): CampaignCoordinatorContact {
    const assigned = readAssignedCoordinator(input.assignment);
    if (assigned.usable) {
        return { name: assigned.name, email: assigned.email, source: 'assigned', assigned };
    }

    const orgRaw = typeof input.organization?.contact_email === 'string'
        ? input.organization.contact_email.trim()
        : '';
    if (orgRaw && normalizeSupporterEmail(orgRaw)) {
        const orgName = typeof input.organization?.contact_name === 'string'
            ? input.organization.contact_name.trim() || null
            : null;
        return { name: orgName, email: orgRaw, source: 'organization', assigned };
    }

    // Nothing deliverable anywhere. Callers must treat a null email as "do not
    // send", never as "send to whatever was lying around".
    return { name: null, email: null, source: 'none', assigned };
}
