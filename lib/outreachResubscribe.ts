/**
 * OUTREACH-RESUBSCRIBE-1 — releasing an ADDRESS-scoped opt-out.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * "Re-subscribe with permission" wrote a `contact`-scoped `subscribed` row and
 * reported success. Send time does not work that way: checkSuppressionAtSend
 * reads BOTH scopes and treats ANY row saying `unsubscribed` as suppressing,
 * with no recency contest. So a recipient who used the public unsubscribe — which
 * writes an `email_address` row — stayed suppressed while the tenant was told
 * they had been re-subscribed. The tenant would only discover it by watching a
 * send skip people it claimed were ready.
 *
 * ── WHY THE ORIGINAL RULE EXISTED, AND IS KEPT ──────────────────────────────
 *
 * FR-RETENTION-2 chose this deliberately: "re-subscribing clears the
 * contact-scoped preference rather than the address. Where an address itself was
 * suppressed, that is recorded separately and is not lifted by re-subscribing one
 * individual." That is not an oversight — it protects SHARED INBOXES. If
 * office@school.org is used by three contacts and one of them opts out, letting a
 * tenant re-subscribe one person would silently resume mail to all three, and the
 * two who never agreed have no idea it happened.
 *
 * So the address opt-out is released only when the re-subscribe genuinely covers
 * everyone it speaks for: every contact in this tenant who currently uses that
 * address must be part of the same re-subscribe. One person cannot consent on
 * behalf of an inbox they share.
 *
 * When the address is held back, that is REPORTED rather than hidden — the whole
 * point is to stop the UI claiming a restoration that did not happen.
 */

export type AddressReleaseOutcome =
    /** No address-scope opt-out was in force; nothing to release. */
    | 'not_suppressed'
    /** Released: this re-subscribe covers every contact using the address. */
    | 'released'
    /** Held back: other contacts share this inbox and were not included. */
    | 'shared_with_others';

export interface AddressReleaseDecision {
    normalizedEmail: string;
    outcome: AddressReleaseOutcome;
    /** Contacts in this tenant using the address who are NOT being re-subscribed. */
    heldBackForContactIds: string[];
}

export interface AddressOwnershipRow {
    /** Contact that currently uses this address. */
    contactId: string;
    /** Canonical form — must already be normalized by the caller. */
    normalizedEmail: string;
}

export interface AddressPreferenceRow {
    normalizedEmail: string;
    status: 'subscribed' | 'unsubscribed' | 'paused' | 'not_interested';
}

/**
 * Decides, per address, whether an approved re-subscribe may release it.
 *
 * Pure: it reads nothing and writes nothing. The caller supplies the tenant's
 * current address ownership and the address-scope preference rows it already
 * loaded, and applies the decisions inside its own transaction.
 */
export function decideAddressRelease(input: {
    /** Contacts the tenant is re-subscribing in THIS request. */
    resubscribingContactIds: readonly string[];
    /** Every current (contact, address) pair in this tenant for those addresses. */
    ownership: readonly AddressOwnershipRow[];
    /** Address-scope preference rows currently on file for this tenant. */
    addressPreferences: readonly AddressPreferenceRow[];
}): AddressReleaseDecision[] {
    const inRequest = new Set(input.resubscribingContactIds);

    // Addresses actually reached by the contacts being re-subscribed.
    const targets = new Set(
        input.ownership
            .filter((o) => inRequest.has(o.contactId))
            .map((o) => o.normalizedEmail),
    );

    const suppressed = new Set(
        input.addressPreferences
            .filter((p) => p.status === 'unsubscribed')
            .map((p) => p.normalizedEmail),
    );

    const decisions: AddressReleaseDecision[] = [];
    for (const email of [...targets].sort()) {
        if (!suppressed.has(email)) {
            decisions.push({ normalizedEmail: email, outcome: 'not_suppressed', heldBackForContactIds: [] });
            continue;
        }

        // Everyone in this tenant who currently uses the inbox.
        const sharers = [...new Set(
            input.ownership.filter((o) => o.normalizedEmail === email).map((o) => o.contactId),
        )];
        const notIncluded = sharers.filter((id) => !inRequest.has(id)).sort();

        decisions.push({
            normalizedEmail: email,
            outcome: notIncluded.length === 0 ? 'released' : 'shared_with_others',
            heldBackForContactIds: notIncluded,
        });
    }
    return decisions;
}

/** What the tenant is told, in their words rather than the schema's. */
export function describeAddressRelease(decisions: readonly AddressReleaseDecision[]): {
    released: number;
    heldBack: number;
    warning: string | null;
} {
    const released = decisions.filter((d) => d.outcome === 'released').length;
    const held = decisions.filter((d) => d.outcome === 'shared_with_others');
    return {
        released,
        heldBack: held.length,
        warning: held.length === 0
            ? null
            : held.length === 1
                ? 'One of these email addresses is shared with someone else who has not been re-subscribed, '
                  + 'so it stays unsubscribed and they will still not receive promotional email. '
                  + 'Re-subscribe everyone who uses that address to restore it.'
                : `${held.length} of these email addresses are shared with people who have not been re-subscribed, `
                  + 'so they stay unsubscribed. Re-subscribe everyone who uses those addresses to restore them.',
    };
}
