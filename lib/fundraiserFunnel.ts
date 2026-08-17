/**
 * FR-FUNNEL-1 — the acquisition funnel's shared vocabulary.
 *
 * WHY THIS FILE EXISTS
 * Three things must never drift apart: what the inquiry route WRITES, what the
 * CRM READS, and what reporting GROUPS BY. FR-FLOW-1R already learned this the
 * hard way — the CRM inclusion rule lives in lib/fundraiserLead.ts precisely so
 * the writer and the reader cannot disagree. This module is the same idea for
 * the funnel: source channels, open-status membership, and the inquiry
 * fingerprint are defined once here and imported everywhere else.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * No database access, no tenant resolution, no notification. Everything below
 * is pure so it can be reasoned about and tested without a database.
 */

import { createHash } from 'crypto';

// ── Source attribution ───────────────────────────────────────────────────────

/**
 * The controlled acquisition-channel vocabulary.
 *
 * A validated STRING rather than a PostgreSQL enum, deliberately. This list has
 * to grow every time a tenant tries a new ad platform, and growing a PG enum
 * means `ALTER TYPE ... ADD VALUE` — a migration hazard this repository has
 * already been bitten by. The precedent for a code-owned controlled vocabulary
 * is AutomationAction.expired_reason, which is documented in schema.prisma as
 * "Controlled value from AutomationExpiredReason in lib/growth/automation.ts,
 * not tenant-authored text".
 *
 * Reporting consistency is preserved by rejecting unknown values at the write
 * boundary rather than by a database type.
 */
export const FUNDRAISER_SOURCE_CHANNELS = [
    'tenant_website',
    'freezeriq_site',
    'meta_lead',
    'instagram',
    'paid_ad',
    'organic_social',
    'referral',
    'email',
    'phone',
    'manual',
    'returning_org',
    'other',
] as const;

export type FundraiserSourceChannel = (typeof FUNDRAISER_SOURCE_CHANNELS)[number];

/** What a public storefront inquiry is attributed to when nothing says otherwise. */
export const DEFAULT_SOURCE_CHANNEL: FundraiserSourceChannel = 'tenant_website';

/** Free-text `source_detail` is context only; it is never a grouping key. */
export const SOURCE_DETAIL_MAX_LENGTH = 300;

export function isFundraiserSourceChannel(value: unknown): value is FundraiserSourceChannel {
    return typeof value === 'string' &&
        (FUNDRAISER_SOURCE_CHANNELS as readonly string[]).includes(value);
}

export type SourceChannelResult =
    | { ok: true; channel: FundraiserSourceChannel }
    | { ok: false; error: string };

/**
 * Resolves the channel for one inquiry.
 *
 * An ABSENT channel is the ordinary public-form case and yields the default. A
 * PRESENT but unrecognised channel is rejected rather than stored, because a
 * typo that reaches the column silently becomes its own bucket in every future
 * funnel report and there is no way to tell it apart from a real channel later.
 */
export function resolveSourceChannel(raw: unknown): SourceChannelResult {
    if (raw === undefined || raw === null || raw === '') {
        return { ok: true, channel: DEFAULT_SOURCE_CHANNEL };
    }
    if (!isFundraiserSourceChannel(raw)) {
        return { ok: false, error: 'Unrecognized source channel.' };
    }
    return { ok: true, channel: raw };
}

// ── Opportunity status membership ────────────────────────────────────────────

/**
 * The statuses that count as an OPEN opportunity.
 *
 * This list is the application-side mirror of the partial unique index
 * `fundraiser_opportunities_one_open_per_org`. The database is what guarantees
 * one-open-per-organization; this constant is what lets the route find the open
 * row before trying to create one. If the two ever disagree the database wins
 * and the route sees a P2002 — which it handles — so the failure mode is a
 * retry, never a duplicate.
 */
export const OPEN_OPPORTUNITY_STATUSES = ['new', 'in_conversation', 'date_confirmed'] as const;

/** Terminal statuses. Reaching one frees the organization for a future cycle. */
export const TERMINAL_OPPORTUNITY_STATUSES = ['converted', 'lost'] as const;

export function isOpenOpportunityStatus(status: unknown): boolean {
    return typeof status === 'string' &&
        (OPEN_OPPORTUNITY_STATUSES as readonly string[]).includes(status);
}

// ── Inquiry fingerprint ──────────────────────────────────────────────────────

export interface InquiryFingerprintInput {
    slug?: unknown;
    organizationName?: unknown;
    contactEmail?: unknown;
    contactName?: unknown;
    contactPhone?: unknown;
}

function norm(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Deterministic SHA-256 of the LOGICAL identity of one inquiry.
 *
 * Canonical fields, fixed order: storefront slug (lowercased), organization
 * name, contact email (lowercased), contact name, contact phone.
 *
 * EXCLUDED ON PURPOSE: website, cause, notes, delivery location. Those are free
 * text a submitter may legitimately reword between an attempt and its retry
 * without it becoming a different inquiry. Including them would turn a
 * corrected typo into a hard conflict. This mirrors the reasoning in
 * lib/orderIdempotency.ts, which excludes phone and address for the same
 * reason — only the fields that IDENTIFY the submission are fingerprinted.
 *
 * Only the digest is persisted, so no personal data is stored for comparison.
 */
export function buildInquiryFingerprint(input: InquiryFingerprintInput): string {
    const canonical = JSON.stringify({
        slug: norm(input.slug).toLowerCase(),
        org: norm(input.organizationName),
        email: norm(input.contactEmail).toLowerCase(),
        name: norm(input.contactName),
        phone: norm(input.contactPhone),
    });
    return createHash('sha256').update(canonical).digest('hex');
}

// ── Free-text normalization ──────────────────────────────────────────────────

/** Trim, collapse internal whitespace, cap length. Empty becomes null. */
export function cleanText(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim().replace(/\s+/g, ' ').slice(0, max);
    return v.length > 0 ? v : null;
}

// ── Customer-resolution serialization ───────────────────────────────────────
//
// FR-FUNNEL-1R implemented an advisory identity lock here. FR-PUBLIC-IDENTITY-1
// shipped a behaviourally identical lock to PRODUCTION in lib/publicIdentity.ts
// — same namespace, same SQL, same trim+lowercase normalization.
//
// The Production copy is canonical and this duplicate is deliberately removed.
// Not because either was wrong, but because the lock MUST agree with the
// candidate query it protects, and that query (findCustomersByEmailIdentity)
// lives in lib/publicIdentity.ts using the same normalizeEmailIdentity. Keeping
// two definitions in two files is exactly how a lock and its lookup drift apart
// and silently reopen the race.
//
// See: identityLockKey / IDENTITY_LOCK_SQL in lib/publicIdentity.ts.
