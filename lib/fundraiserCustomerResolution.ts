/**
 * FR-PUBLIC-IDENTITY-1 — which organization does a fundraiser inquiry belong to?
 *
 * WHAT WAS WRONG
 * The route used `customer.findFirst` on email alone, with no ORDER BY. When a
 * tenant has more than one Customer on an email address — Production has 5 such
 * groups covering 13 rows — PostgreSQL is free to return any of them, and it was
 * demonstrated that the winner flips based purely on which random UUID sorts
 * first. One Production group has three `organization` rows that each own a
 * campaign plus a `direct_customer` carrying 33 Square orders, all on one email.
 * Attaching a fundraiser lead to whichever row the planner happened to pick is
 * not a decision anyone made.
 *
 * THE CONTRACT
 * Email alone is NOT a fundraiser organization's identity. Two different
 * organizations can legitimately share a treasurer's mailbox. Organization NAME
 * is part of the identity, so it is what disambiguates.
 *
 * THE SAFETY RULE
 *      NO LOST LEAD  +  NO SILENT WRONG CUSTOMER LINK.
 * When the evidence does not leave exactly one defensible candidate, this module
 * refuses to guess and reports AMBIGUOUS. The caller then creates a fresh
 * organization for the submitted name rather than binding durable fundraiser
 * history to an arbitrary legacy row. Nothing is merged, deleted, reclassified,
 * or chosen by UUID — the tenant reconciles legacy identities deliberately.
 */

import type { CustomerIdentityRow } from './publicIdentity';

/** Marker for a lead whose organization identity needs a human decision. */
export const IDENTITY_REVIEW_TAG = 'identity_review_needed';

/** Customer.type values that represent an organization rather than a person. */
const ORGANIZATION_TYPES = ['fundraiser_org', 'organization'];

/** The durable "this customer has fundraiser intent" tag from FR-FLOW-1R. */
const FUNDRAISER_INQUIRY_TAG = 'fundraiser_inquiry';

/**
 * Conservative organization-name normalization: trim, collapse ordinary runs of
 * whitespace, lowercase.
 *
 * Deliberately NOT fuzzy. Punctuation is meaningful — "St. Mary's" and
 * "St Marys" may be two different organizations, and this module has no basis
 * for deciding they are the same. Whitespace and case are the only differences a
 * form submission plausibly introduces for the SAME name.
 */
export function normalizeOrganizationName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const name = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    return name.length > 0 ? name : null;
}

/**
 * Durable fundraiser evidence, strongest first.
 *
 * TIERED rather than a single boolean, deliberately. Two rows can both be
 * `organization` while only one of them actually owns the fundraiser history —
 * Production has exactly that shape, where one row owns three campaigns and its
 * twin owns none. Flattening every signal into one OR would call that pair
 * ambiguous and needlessly strand a lead, while a tier that owning-a-campaign
 * wins outright resolves it correctly and still refuses to guess when the
 * strongest available tier leaves more than one candidate.
 */
export const EVIDENCE_TIERS = [
    /** Owns at least one FundraiserCampaign — the strongest possible claim. */
    'campaign',
    /** Has a durable person↔organization relationship. */
    'org_contact',
    /** Classified as an organization, or carries fundraiser intent. */
    'classification',
] as const;

export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export function hasEvidenceAtTier(
    row: CustomerIdentityRow,
    tier: EvidenceTier,
    withCampaigns: ReadonlySet<string>,
    withOrgContacts: ReadonlySet<string>
): boolean {
    if (tier === 'campaign') return withCampaigns.has(row.id);
    if (tier === 'org_contact') return withOrgContacts.has(row.id);
    const typeMatch = typeof row.type === 'string' && ORGANIZATION_TYPES.includes(row.type);
    const tagMatch = Array.isArray(row.tags) && row.tags.includes(FUNDRAISER_INQUIRY_TAG);
    return typeMatch || tagMatch;
}

/** True when a row is a holding record FreezerIQ created, not a real history. */
export function isReviewIdentity(row: CustomerIdentityRow): boolean {
    return Array.isArray(row.tags) && row.tags.includes(IDENTITY_REVIEW_TAG);
}

export type ResolutionOutcome =
    /** No candidate on this email — create a new organization. */
    | { kind: 'create'; reason: 'no_candidates' }
    /** Exactly one defensible candidate — reuse it. */
    | {
          kind: 'reuse';
          customer: CustomerIdentityRow;
          reason:
              | 'sole_candidate'
              | 'name_match'
              | 'fundraiser_evidence'
              | 'review_identity'
              /**
               * Several EQUIVALENT synthetic holding records exist for this exact
               * identity. Picking a canonical one by id is safe here and ONLY
               * here: every row in this set was created by FreezerIQ for the same
               * unresolved identity, carries the review marker, and matches the
               * same tenant, email and organization name — so they are
               * interchangeable placeholders, not competing real organizations.
               * The previous behaviour dropped the lead instead, which the
               * concurrency test proved was reachable.
               */
              | 'canonical_review_identity';
      }
    /** Several defensible candidates and no holding record yet — create one. */
    | { kind: 'create'; reason: 'ambiguous'; candidateCount: number };

export interface ResolutionInput {
    /** Every same-tenant customer matching the email LITERALLY. */
    candidates: CustomerIdentityRow[];
    /** The organization name as submitted. */
    organizationName: string;
    /** Ids among the candidates that own at least one FundraiserCampaign. */
    campaignOwnerIds?: ReadonlySet<string>;
    /** Ids among the candidates with a FundraiserOrganizationContact. */
    orgContactIds?: ReadonlySet<string>;
}

/**
 * Decide which existing organization (if any) this inquiry belongs to.
 *
 * Pure: no database access, no ordering assumptions. Given the same candidate
 * SET it returns the same answer regardless of the order they arrive in, which
 * is the property the old `findFirst` lacked.
 */
/**
 * Canonical choice among EQUIVALENT synthetic holding records.
 *
 * Ordering by id is permitted here and nowhere else. Every row reaching this
 * function carries the review marker and matches the same tenant, normalized
 * email and normalized organization name, so they are interchangeable
 * placeholders FreezerIQ itself created for one unresolved identity. Choosing
 * a stable one keeps the lead and adds no further duplicates. It is NEVER used
 * to decide which REAL organization is correct.
 */
function canonicalReviewIdentity(rows: CustomerIdentityRow[]): CustomerIdentityRow {
    return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

export function resolveFundraiserCustomer(input: ResolutionInput): ResolutionOutcome {
    const campaignOwners = input.campaignOwnerIds ?? new Set<string>();
    const orgContacts = input.orgContactIds ?? new Set<string>();

    // REAL history is decided first and on its own. A synthetic holding record
    // must never outrank a uniquely defensible historical organization, so the
    // review rows are held back and only consulted once the real rows have
    // genuinely failed to produce a winner.
    const real = input.candidates.filter((c) => !isReviewIdentity(c));
    const review = input.candidates.filter((c) => isReviewIdentity(c));
    const submitted = normalizeOrganizationName(input.organizationName);
    const nameMatches = (c: CustomerIdentityRow) =>
        submitted !== null && normalizeOrganizationName(c.name) === submitted;

    /**
     * Consulted ONLY when the real candidates are ambiguous.
     *
     * This is what stops an ambiguous organization breeding a new duplicate on
     * every repeat inquiry: the first ambiguous submission creates one holding
     * record, and every identical submission afterwards finds and reuses it.
     */
    const settleWithReviewIdentity = (candidateCount: number): ResolutionOutcome => {
        const matching = review.filter(nameMatches);
        if (matching.length === 1) {
            return { kind: 'reuse', customer: matching[0], reason: 'review_identity' };
        }
        if (matching.length > 1) {
            return { kind: 'reuse', customer: canonicalReviewIdentity(matching), reason: 'canonical_review_identity' };
        }
        return { kind: 'create', reason: 'ambiguous', candidateCount };
    };

    // 1. Nobody real on this email, and no holding record for this name either.
    if (real.length === 0) {
        const matchingReview = review.filter(nameMatches);
        if (matchingReview.length === 1) {
            return { kind: 'reuse', customer: matchingReview[0], reason: 'review_identity' };
        }
        if (matchingReview.length > 1) {
            return { kind: 'reuse', customer: canonicalReviewIdentity(matchingReview), reason: 'canonical_review_identity' };
        }
        return { kind: 'create', reason: 'no_candidates' };
    }

    // 2. Exactly one real row.
    //
    //    A PERSON (direct_customer, storefront signup) is reused whatever
    //    organization they are inquiring for — that is the FR-FLOW-1R contract:
    //    tag the existing person so the CRM shows them, do not duplicate them.
    //
    //    An ORGANIZATION with a DIFFERENT name is a different organization that
    //    merely shares a mailbox, and must not be collapsed. Serializing on email
    //    is what makes this case reachable: the first request creates "Alpha PTA",
    //    and without this check the very next request for "Beta Boosters" would
    //    find Alpha as the sole candidate and silently reuse it.
    if (real.length === 1) {
        const only = real[0];
        const isOrganizationRow =
            typeof only.type === 'string' && ORGANIZATION_TYPES.includes(only.type);
        const nameConflicts =
            submitted !== null && isOrganizationRow && normalizeOrganizationName(only.name) !== submitted;

        if (!nameConflicts) {
            return { kind: 'reuse', customer: only, reason: 'sole_candidate' };
        }
        // Different organization on a shared mailbox — fall through to the
        // holding-record check for THIS name, then create.
        const matchingReview = review.filter(nameMatches);
        if (matchingReview.length === 1) {
            return { kind: 'reuse', customer: matchingReview[0], reason: 'review_identity' };
        }
        if (matchingReview.length > 1) {
            return { kind: 'reuse', customer: canonicalReviewIdentity(matchingReview), reason: 'canonical_review_identity' };
        }
        return { kind: 'create', reason: 'no_candidates' };
    }

    // 3. Several real rows. Organization NAME is part of the identity.
    if (!submitted) return settleWithReviewIdentity(real.length);

    const byName = real.filter(nameMatches);
    if (byName.length === 1) {
        return { kind: 'reuse', customer: byName[0], reason: 'name_match' };
    }

    // 4. Same name on several REAL rows — durable fundraiser evidence, tried
    //    strongest-first. The first tier isolating exactly one candidate wins;
    //    a tier matching several is not a decision. A real winner here beats any
    //    holding record, which is why this runs before step 5.
    if (byName.length > 1) {
        for (const tier of EVIDENCE_TIERS) {
            const evidenced = byName.filter((c) => hasEvidenceAtTier(c, tier, campaignOwners, orgContacts));
            if (evidenced.length === 1) {
                return { kind: 'reuse', customer: evidenced[0], reason: 'fundraiser_evidence' };
            }
        }
        // 5. Real history cannot decide. NOW the holding record may settle it.
        return settleWithReviewIdentity(byName.length);
    }

    // byName.length === 0: the email is known but this organization is not — a
    // genuinely NEW organization sharing a mailbox. Still check for a holding
    // record under this name, so a repeat of THAT case converges too.
    const matchingReview = review.filter(nameMatches);
    if (matchingReview.length === 1) {
        return { kind: 'reuse', customer: matchingReview[0], reason: 'review_identity' };
    }
    if (matchingReview.length > 1) {
        return { kind: 'reuse', customer: canonicalReviewIdentity(matchingReview), reason: 'canonical_review_identity' };
    }
    return { kind: 'create', reason: 'no_candidates' };
}
