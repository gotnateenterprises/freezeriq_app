/**
 * FR-RETENTION-2 — Seasonal audience resolution.
 *
 * THE CENTRAL DISTINCTION, because everything here depends on it:
 *
 *   CRM identity  → one FundraiserContact per durable PERSON. Never merged.
 *   Audience      → one recipient per DELIVERY ADDRESS.
 *
 * Two coordinators who share an office inbox stay two people in the CRM and
 * become ONE recipient, because one email reaches both. The recipient records
 * every person and organization it represents. Sharing an address never
 * rewrites, merges, or weakens durable identity.
 *
 * This module is pure resolution: it reads and computes, it never writes.
 * Persistence lives in the audience-snapshot API so that "calculate" and
 * "commit" stay separable and testable.
 */

import type {
    RecipientEligibility,
    RecipientExclusionReason,
} from '@prisma/client';

// ── Inputs ───────────────────────────────────────────────────────────────────

/** A durable person plus the relationships and address the audience needs. */
export interface AudienceContactInput {
    contactId: string;
    displayName: string;
    archivedAt: Date | null;
    needsReview: boolean;
    reviewReason: string | null;
    /** Current primary email contact point, if any. */
    email: string | null;
    /** Organizations this person currently represents (ended_at IS NULL). */
    organizations: { customerId: string; name: string; archived: boolean }[];
}

/** Current marketing preference for a person or an address. */
export interface AudiencePreferenceInput {
    scope: 'contact' | 'email_address';
    contactId: string | null;
    normalizedEmail: string | null;
    status: 'subscribed' | 'unsubscribed' | 'paused' | 'not_interested';
    effectiveUntil: Date | null;
}

export interface ResolveAudienceOptions {
    contacts: AudienceContactInput[];
    preferences: AudiencePreferenceInput[];
    /** Injected so tests can pin "now" rather than depend on wall-clock time. */
    now: Date;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export interface ResolvedRecipient {
    /** Internal only. Never returned to tenant UI, never a tenant-facing id. */
    normalizedEmail: string | null;
    displayName: string;
    emailMasked: string | null;
    isSharedInbox: boolean;
    contacts: { contactId: string; displayName: string }[];
    organizations: { customerId: string; name: string }[];
    eligibility: RecipientEligibility;
    exclusionReason: RecipientExclusionReason | null;
    /** Plain-language sentence for the tenant. Never technical. */
    exclusionDetail: string | null;
    excludedUntil: Date | null;
}

export interface ResolvedAudience {
    recipients: ResolvedRecipient[];
    includedCount: number;
    excludedCount: number;
    needsReviewCount: number;
}

// ── Normalization ────────────────────────────────────────────────────────────

/** Grouping key only. The original value is always what gets stored/displayed. */
export function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Deliberately permissive: this catches obviously unusable addresses (missing
 * @, missing domain, whitespace) without pretending to adjudicate RFC 5322.
 * Over-strict validation here would silently drop reachable coordinators.
 */
export function isPlausibleEmail(value: string): boolean {
    const v = value.trim();
    if (!v || /\s/.test(v)) return false;
    const at = v.indexOf('@');
    if (at <= 0 || at !== v.lastIndexOf('@')) return false;
    const domain = v.slice(at + 1);
    return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function maskEmail(email: string | null): string | null {
    if (!email) return null;
    const [user, domain] = email.split('@');
    if (!domain) return email;
    return `${user.slice(0, 1)}•••@${domain}`;
}

function formatMonthYear(d: Date): string {
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ── Suppression evaluation ───────────────────────────────────────────────────

interface Suppression {
    reason: RecipientExclusionReason;
    detail: string;
    until: Date | null;
    /** True when it came from the ADDRESS rather than an individual person. */
    fromAddress: boolean;
}

/**
 * Resolves one preference row into an active suppression, or null.
 *
 * A paused / not-interested window that has already elapsed is NOT a
 * suppression — the person becomes mailable again on their own, without the
 * tenant having to remember to clear anything.
 */
function evaluatePreference(
    pref: AudiencePreferenceInput,
    now: Date,
    fromAddress: boolean,
): Suppression | null {
    switch (pref.status) {
        case 'subscribed':
            return null;

        case 'unsubscribed':
            return {
                reason: fromAddress ? 'shared_address_unsubscribed' : 'unsubscribed',
                detail: fromAddress
                    ? 'Someone at this address unsubscribed, so marketing is paused for everyone using it.'
                    : 'This person unsubscribed from marketing email.',
                until: null,
                fromAddress,
            };

        case 'paused':
            if (pref.effectiveUntil && pref.effectiveUntil <= now) return null;
            return {
                reason: 'paused_until',
                detail: pref.effectiveUntil
                    ? `Paused until ${formatMonthYear(pref.effectiveUntil)}.`
                    : 'Paused.',
                until: pref.effectiveUntil,
                fromAddress,
            };

        case 'not_interested':
            if (pref.effectiveUntil && pref.effectiveUntil <= now) return null;
            return {
                reason: 'not_interested_until',
                detail: pref.effectiveUntil
                    ? `Not interested until ${formatMonthYear(pref.effectiveUntil)}.`
                    : 'Not interested right now.',
                until: pref.effectiveUntil,
                fromAddress,
            };
    }
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Builds the audience: one recipient per delivery address, plus one
 * non-deliverable recipient per person who has no usable address (so the tenant
 * can see and fix them rather than have them quietly disappear).
 *
 * Candidate population = contacts with at least one CURRENT organization
 * relationship. An open campaign never excludes anyone: a tenant may plan the
 * next season while the current one is still running.
 */
export function resolveAudience(opts: ResolveAudienceOptions): ResolvedAudience {
    const { contacts, preferences, now } = opts;

    const contactPrefs = new Map<string, AudiencePreferenceInput>();
    const addressPrefs = new Map<string, AudiencePreferenceInput>();
    for (const p of preferences) {
        if (p.scope === 'contact' && p.contactId) contactPrefs.set(p.contactId, p);
        else if (p.scope === 'email_address' && p.normalizedEmail) addressPrefs.set(p.normalizedEmail, p);
    }

    // Only people who currently represent at least one organization.
    const candidates = contacts.filter((c) => c.organizations.length > 0);

    const recipients: ResolvedRecipient[] = [];
    const byAddress = new Map<string, AudienceContactInput[]>();

    for (const c of candidates) {
        // No address, or an unusable one: a person-shaped row so the tenant can
        // act on it. These are never grouped, because there is nothing to group.
        if (!c.email || !c.email.trim()) {
            recipients.push(buildUndeliverable(c, 'no_email', 'No email address on file.'));
            continue;
        }
        if (!isPlausibleEmail(c.email)) {
            recipients.push(buildUndeliverable(c, 'invalid_email', "This email address doesn't look usable."));
            continue;
        }
        const key = normalizeEmail(c.email);
        const bucket = byAddress.get(key);
        if (bucket) bucket.push(c);
        else byAddress.set(key, [c]);
    }

    for (const [normalized, group] of byAddress) {
        // Deterministic display so repeated calculation is stable.
        group.sort((a, b) => a.displayName.localeCompare(b.displayName));

        const orgMap = new Map<string, { customerId: string; name: string }>();
        for (const c of group) {
            for (const o of c.organizations) {
                if (!orgMap.has(o.customerId)) orgMap.set(o.customerId, { customerId: o.customerId, name: o.name });
            }
        }
        const organizations = [...orgMap.values()].sort((a, b) => a.name.localeCompare(b.name));
        const isShared = group.length > 1;

        // ── Suppression, in priority order ───────────────────────────────────
        // An address-scoped rule wins: if the inbox itself is suppressed, every
        // person behind it is suppressed, which is the whole point of the
        // shared-address rule.
        let suppression: Suppression | null = null;

        const addrPref = addressPrefs.get(normalized);
        if (addrPref) suppression = evaluatePreference(addrPref, now, isShared);

        if (!suppression) {
            // Any represented person's own opt-out suppresses the shared inbox,
            // because we cannot reach the others without also reaching them.
            for (const c of group) {
                const p = contactPrefs.get(c.contactId);
                if (!p) continue;
                const s = evaluatePreference(p, now, isShared && p.status === 'unsubscribed');
                if (s) { suppression = s; break; }
            }
        }

        const allArchived = group.every((c) => c.archivedAt !== null)
            || (organizations.length > 0 && group.every((c) => c.organizations.every((o) => o.archived)));
        const anyNeedsReview = group.some((c) => c.needsReview);

        let eligibility: RecipientEligibility = 'included';
        let exclusionReason: RecipientExclusionReason | null = null;
        let exclusionDetail: string | null = null;
        let excludedUntil: Date | null = null;

        if (suppression) {
            eligibility = 'excluded';
            exclusionReason = suppression.reason;
            exclusionDetail = suppression.detail;
            excludedUntil = suppression.until;
        } else if (allArchived) {
            eligibility = 'needs_review';
            exclusionReason = 'needs_review';
            exclusionDetail = 'This relationship is archived — check before including it.';
        } else if (anyNeedsReview) {
            eligibility = 'needs_review';
            exclusionReason = 'needs_review';
            exclusionDetail = group.find((c) => c.needsReview)?.reviewReason
                ?? 'This contact needs a quick check before emailing.';
        }

        const primary = group[0];
        recipients.push({
            normalizedEmail: normalized,
            // A shared inbox is labelled by the address, since no single person
            // owns it. A sole occupant is labelled by their own name.
            displayName: isShared ? (maskEmail(primary.email) ?? primary.displayName) : primary.displayName,
            emailMasked: maskEmail(primary.email),
            isSharedInbox: isShared,
            contacts: group.map((c) => ({ contactId: c.contactId, displayName: c.displayName })),
            organizations,
            eligibility,
            exclusionReason,
            exclusionDetail,
            excludedUntil,
        });
    }

    recipients.sort((a, b) => {
        const rank = (r: ResolvedRecipient) => (r.eligibility === 'included' ? 0 : r.eligibility === 'needs_review' ? 1 : 2);
        return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName);
    });

    return {
        recipients,
        includedCount: recipients.filter((r) => r.eligibility === 'included').length,
        excludedCount: recipients.filter((r) => r.eligibility === 'excluded').length,
        needsReviewCount: recipients.filter((r) => r.eligibility === 'needs_review').length,
    };
}

function buildUndeliverable(
    c: AudienceContactInput,
    reason: RecipientExclusionReason,
    detail: string,
): ResolvedRecipient {
    return {
        normalizedEmail: null,
        displayName: c.displayName,
        emailMasked: null,
        isSharedInbox: false,
        contacts: [{ contactId: c.contactId, displayName: c.displayName }],
        organizations: c.organizations.map((o) => ({ customerId: o.customerId, name: o.name })),
        eligibility: 'excluded',
        exclusionReason: reason,
        exclusionDetail: detail,
        excludedUntil: null,
    };
}
