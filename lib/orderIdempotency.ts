/**
 * Public Order Submission Idempotency — FR-LAUNCH-1E
 *
 * Two concerns, deliberately kept out of the route so the canonicalization is
 * independently reviewable:
 *
 *   1. Validating a client-supplied submission key.
 *   2. Deriving a deterministic fingerprint of the LOGICAL order payload, so a
 *      key replayed with materially different contents can be rejected instead
 *      of silently returning an unrelated order.
 *
 * SCOPE / BOUNDARY
 * ────────────────
 * This module performs NO database access, NO pricing, and NO eligibility work.
 * Pricing stays server-authoritative in lib/pricing.ts — client prices are never
 * fingerprinted, because fingerprinting them would treat a client-supplied
 * amount as meaningful input.
 *
 * The fingerprint is a SHA-256 hex digest. Only the digest is persisted, so no
 * raw personal data is stored for comparison purposes.
 *
 * @module orderIdempotency
 */

import { createHash } from 'crypto';

// ── Key validation ───────────────────────────────────────────────────────────

/** Minimum accepted key length. A UUID is 36 chars; 8 allows other schemes. */
const MIN_KEY_LENGTH = 8;
/** Maximum accepted key length — bounds index size and log noise. */
const MAX_KEY_LENGTH = 200;
/** Conservative charset: UUIDs plus common opaque-token punctuation. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export type SubmissionKeyResult =
    | { ok: true; key: string | null }
    | { ok: false; error: string };

/**
 * Validates the optional `submissionKey` field from a public order request.
 *
 * PHASED ROLLOUT (FR-LAUNCH-1E ruling 3): a MISSING key is currently valid and
 * yields `{ ok: true, key: null }` — the caller then takes the transactional
 * legacy-compatible path with no idempotency protection. A key that is PRESENT
 * but malformed is always rejected, so a broken client cannot silently lose
 * duplicate protection it believes it has.
 *
 * Mandatory enforcement for missing keys is deferred until cached old clients
 * have aged out; at that point this function's null branch becomes an error.
 */
export function validateSubmissionKey(raw: unknown): SubmissionKeyResult {
    if (raw === undefined || raw === null) {
        return { ok: true, key: null };
    }

    if (typeof raw !== 'string') {
        return { ok: false, error: 'Submission key must be a string' };
    }

    const key = raw.trim();

    // An explicitly empty string is treated as absent rather than malformed:
    // it is the shape a client produces when a field is present but unset.
    if (key.length === 0) {
        return { ok: true, key: null };
    }

    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
        return { ok: false, error: 'Submission key has an invalid length' };
    }

    if (!KEY_PATTERN.test(key)) {
        return { ok: false, error: 'Submission key contains invalid characters' };
    }

    return { ok: true, key };
}

// ── Request fingerprint ──────────────────────────────────────────────────────

export interface FingerprintItemInput {
    bundleId?: unknown;
    quantity?: unknown;
    serving_tier?: unknown;
}

export interface FingerprintInput {
    slug?: unknown;
    campaignId?: unknown;
    customerEmail?: unknown;
    customerName?: unknown;
    participantName?: unknown;
    items: FingerprintItemInput[];
}

/** Normalizes a value to a trimmed string; null/undefined become ''. */
function norm(value: unknown): string {
    return typeof value === 'string' ? value.trim() : (value === null || value === undefined ? '' : String(value).trim());
}

/**
 * Builds a deterministic SHA-256 fingerprint of the logical order payload.
 *
 * Canonical fields, in this fixed order:
 *   1. slug              — trimmed, lowercased (matches the route's own lookup)
 *   2. campaignId        — trimmed
 *   3. customer email    — trimmed, lowercased
 *   4. customer name     — trimmed
 *   5. participant name  — trimmed
 *   6. items             — {bundleId, quantity, serving_tier}, SORTED so client
 *                          array ordering cannot change the digest
 *
 * Excluded on purpose: every price (server-authoritative), phone, and address.
 * Those may legitimately differ between a submission and its retry without
 * making it a different logical order.
 */
export function buildSubmissionFingerprint(input: FingerprintInput): string {
    const items = (input.items || []).map(item => ({
        b: norm(item.bundleId),
        q: Number(item.quantity) || 0,
        v: norm(item.serving_tier).toLowerCase(),
    }));

    // Deterministic ordering: bundle, then variant, then quantity.
    items.sort((a, b) =>
        a.b.localeCompare(b.b) || a.v.localeCompare(b.v) || a.q - b.q
    );

    const canonical = JSON.stringify({
        slug: norm(input.slug).toLowerCase(),
        campaignId: norm(input.campaignId),
        email: norm(input.customerEmail).toLowerCase(),
        name: norm(input.customerName),
        participant: norm(input.participantName),
        items,
    });

    return createHash('sha256').update(canonical).digest('hex');
}
