/**
 * FR-REBOOK-2 — who supported this organization before.
 *
 * ── WHAT THE DATA ACTUALLY LOOKS LIKE ───────────────────────────────────────
 *
 * The obvious implementation reads `Order.customer_id -> Customer.contact_email`
 * and calls that the supporter. Against real Production data that is wrong, and
 * wrong in the most dangerous direction.
 *
 * Edgar County Farm Bureau's completed fundraiser holds 17 legitimate orders.
 * All 17 carry a distinct real person in `Order.customer_name` and a phone
 * number — Bonnie Marrs, Rebecca Schiver, Lori Brengle and so on — because the
 * coordinator entered paper orders on their behalf. All 17 also point at ONE
 * `customer_id`: the Edgar County Farm Bureau organization row itself, whose
 * `contact_email` is the coordinator's own address.
 *
 * So the obvious implementation would have reported "1 previous supporter",
 * deduplicated 17 real people down to their own coordinator, and then mailed
 * that coordinator an invitation thanking them for supporting themselves. The
 * organization is never a supporter of its own fundraiser, and this module
 * refuses to treat it as one.
 *
 * The storefront path produces the other shape: `/api/public/order` find-or-
 * creates a `direct_customer` Customer keyed on
 * (business_id, contact_email, type) and links the order to that. Those are
 * genuine individual supporters with genuine addresses.
 *
 * Both shapes are real and both are handled. Identity is taken from the ORDER
 * when the linked customer is an organization, and from the CUSTOMER when it is
 * an individual.
 *
 * ── LEGITIMACY IS BORROWED, NOT INVENTED ────────────────────────────────────
 *
 * A legitimate historical order is `{ campaign_id, canceled_at: null }` — the
 * identical rule the closeout route and GE-4 lifetime impact already use to
 * decide whose money counts. `OrderStatus` has no canceled member; cancellation
 * is the soft-delete `canceled_at`, and no refund column exists on Order. No
 * payment state is required: placing a fundraiser order IS the supporter
 * relationship, and demanding PAID would erase every coordinator-entered order
 * in the system, which is most of them.
 *
 * ── REACHABLE IS NOT THE SAME AS KNOWN ──────────────────────────────────────
 *
 * A supporter with no email address is still a supporter. Counting them as zero
 * would tell Edgar's coordinator they have no history at all, which is false and
 * insulting. They are counted, and reported separately as not reachable by
 * email. Only reachable, unsuppressed supporters can ever be written to.
 */

/** One historical order, reduced to what identity and legitimacy need. */
export interface PreviousSupporterOrderInput {
    id: string;
    campaign_id: string | null;
    /** Soft-delete marker. Non-null means canceled and therefore not legitimate. */
    canceled_at: Date | string | null;
    customer_id: string | null;
    /** The person on the order slip. Present on coordinator-entered orders. */
    customer_name: string | null;
    phone: string | null;
    /** The linked Customer row, when there is one. */
    customer: {
        id: string;
        business_id: string | null;
        contact_email: string | null;
        contact_phone: string | null;
        name: string | null;
    } | null;
}

export type SupporterExclusionReason = 'no_email' | 'invalid_email' | 'unsubscribed';

export interface PreviousSupporter {
    /** Stable identity key. Never contains a name — see dedupe rules below. */
    key: string;
    displayName: string;
    /** Normalized, lowercased address. Null when this person has none on file. */
    email: string | null;
    phone: string | null;
    /** How many legitimate historical orders this one person placed. */
    orderCount: number;
    /** True only when we may actually write to them. */
    reachable: boolean;
    exclusionReason: SupporterExclusionReason | null;
}

export interface PreviousSupporterAudience {
    supporters: PreviousSupporter[];
    /** Legitimate historical orders that fed the derivation. */
    legitimateOrders: number;
    /** Distinct people found. */
    supporterCount: number;
    /** Distinct people we may email. */
    reachableCount: number;
    /** Known people with no usable address. */
    noEmailCount: number;
    /** Reachable addresses held back by a durable opt-out. */
    suppressedCount: number;
    /** Orders that collapsed into an already-seen person. */
    duplicatesCollapsed: number;
}

export interface DerivePreviousSupportersInput {
    businessId: string;
    /** The organization running the CURRENT campaign. */
    organizationCustomerId: string;
    /**
     * Campaigns whose orders may be read. The caller resolves these from the
     * coordinator's own campaign; they are re-checked here so that a widened
     * caller cannot quietly widen the audience.
     */
    priorCampaignIds: readonly string[];
    /**
     * Every Customer id in this tenant that is a fundraiser ORGANIZATION. An
     * organization is never a supporter, not even of someone else's fundraiser.
     */
    organizationCustomerIds: ReadonlySet<string>;
    orders: readonly PreviousSupporterOrderInput[];
    /** Normalized addresses carrying a durable non-subscribed preference. */
    suppressedEmails: ReadonlySet<string>;
}

/**
 * Lowercased and trimmed, or null when the value cannot be an address.
 *
 * Case matters here for a concrete reason: `/api/public/order` finds an existing
 * supporter with an EXACT `contact_email` match, so `Bob@x.com` and `bob@x.com`
 * become two Customer rows for one human. Normalizing is what collapses them
 * back into one invitation.
 */
export function normalizeSupporterEmail(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    if (!v || v.length > 254) return null;
    if (/\s/.test(v)) return null;
    const at = v.indexOf('@');
    if (at <= 0 || at !== v.lastIndexOf('@') || at === v.length - 1) return null;
    const domain = v.slice(at + 1);
    // A domain with no dot is not deliverable outside a LAN, and is far more
    // often a typo than a real address.
    if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
    return v;
}

/** Digits only, last 10 — enough to recognise the same US number written differently. */
export function normalizeSupporterPhone(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const digits = raw.replace(/\D+/g, '');
    if (digits.length < 10) return null;
    return digits.slice(-10);
}

/** Shown beside an unreachable supporter. Never a full address in a list. */
export function maskSupporterEmail(email: string): string {
    const at = email.indexOf('@');
    if (at <= 0) return '•••';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const head = local.slice(0, 1);
    return `${head}${'•'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

/**
 * The one canonical previous-supporter derivation.
 *
 * Pure: it reads nothing, writes nothing, and creates nothing. Viewing an
 * audience must never create a Customer, an Order, or a participation record —
 * a previous supporter joins the new campaign only by placing a new order.
 *
 * ── DEDUPLICATION ───────────────────────────────────────────────────────────
 * The identity key is, in order: normalized email, else normalized phone, else
 * the order id. A NAME NEVER PARTICIPATES. Two different people called John
 * Smith with different phone numbers stay two people, and one person who
 * ordered three times receives one invitation.
 *
 * Falling back to the order id rather than the name means a nameless, emailless,
 * phoneless order counts as its own supporter instead of silently merging with
 * every other blank one.
 */
export function derivePreviousSupporters(
    input: DerivePreviousSupportersInput,
): PreviousSupporterAudience {
    const allowedCampaigns = new Set(input.priorCampaignIds);
    const byKey = new Map<string, PreviousSupporter>();
    let legitimateOrders = 0;
    let duplicatesCollapsed = 0;

    for (const o of input.orders) {
        // ── LEGITIMACY ──────────────────────────────────────────────────────
        if (o.canceled_at !== null && o.canceled_at !== undefined) continue;
        if (!o.campaign_id || !allowedCampaigns.has(o.campaign_id)) continue;

        // ── TENANT BOUNDARY ─────────────────────────────────────────────────
        // Re-checked rather than trusted. An order whose linked customer belongs
        // to another business cannot contribute an address to this audience.
        if (o.customer && o.customer.business_id !== input.businessId) continue;

        legitimateOrders += 1;

        // ── WHOSE IDENTITY IS THIS? ─────────────────────────────────────────
        // When the linked customer is the organization itself — or any other
        // fundraiser organization in this tenant — the order slip is the only
        // record of the actual human, and the organization's own address must
        // never be adopted as theirs.
        const linkedIsOrganization =
            !!o.customer
            && (o.customer.id === input.organizationCustomerId
                || input.organizationCustomerIds.has(o.customer.id));

        const rawEmail = linkedIsOrganization ? null : o.customer?.contact_email ?? null;
        const email = normalizeSupporterEmail(rawEmail);
        const phone = normalizeSupporterPhone(
            o.phone ?? (linkedIsOrganization ? null : o.customer?.contact_phone ?? null),
        );
        const displayName =
            (o.customer_name?.trim())
            || (linkedIsOrganization ? '' : o.customer?.name?.trim() ?? '')
            || 'Previous supporter';

        // Name is deliberately absent from every branch of this key.
        const key = email ? `email:${email}` : phone ? `phone:${phone}` : `order:${o.id}`;

        const existing = byKey.get(key);
        if (existing) {
            existing.orderCount += 1;
            // Keep the fullest name we have seen for this identity.
            if (existing.displayName === 'Previous supporter' && displayName !== 'Previous supporter') {
                existing.displayName = displayName;
            }
            if (!existing.phone && phone) existing.phone = phone;
            duplicatesCollapsed += 1;
            continue;
        }

        const suppressed = !!email && input.suppressedEmails.has(email);
        byKey.set(key, {
            key,
            displayName,
            email,
            phone,
            orderCount: 1,
            reachable: !!email && !suppressed,
            exclusionReason: !email
                ? (rawEmail ? 'invalid_email' : 'no_email')
                : suppressed
                    ? 'unsubscribed'
                    : null,
        });
    }

    const supporters = [...byKey.values()].sort((a, b) =>
        a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key));

    return {
        supporters,
        legitimateOrders,
        supporterCount: supporters.length,
        reachableCount: supporters.filter((s) => s.reachable).length,
        noEmailCount: supporters.filter((s) => s.exclusionReason === 'no_email' || s.exclusionReason === 'invalid_email').length,
        suppressedCount: supporters.filter((s) => s.exclusionReason === 'unsubscribed').length,
        duplicatesCollapsed,
    };
}

/**
 * The sentence the coordinator card leads with.
 *
 * Truthful in every branch, because each branch describes a different situation
 * and only one of them means "you can invite people".
 */
export function describePreviousSupporters(a: PreviousSupporterAudience): {
    headline: string;
    detail: string | null;
    canInvite: boolean;
} {
    if (a.supporterCount === 0) {
        return {
            headline: 'No previous supporters yet',
            detail: 'Orders from your past fundraisers will show up here.',
            canInvite: false,
        };
    }
    const people = `${a.supporterCount} ${a.supporterCount === 1 ? 'person' : 'people'}`;
    if (a.reachableCount === 0) {
        return {
            headline: `${people} supported your past fundraisers`,
            detail: 'No previous supporters with a usable email address were found, so there is nobody to invite by email yet.',
            canInvite: false,
        };
    }
    const bits: string[] = [];
    if (a.noEmailCount > 0) bits.push(`${a.noEmailCount} without an email address`);
    if (a.suppressedCount > 0) bits.push(`${a.suppressedCount} who opted out`);
    return {
        headline: `${people} supported your past fundraisers`,
        detail: bits.length
            ? `${a.reachableCount} can be invited by email · ${bits.join(' · ')}`
            : `${a.reachableCount} can be invited by email`,
        canInvite: true,
    };
}
