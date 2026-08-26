/**
 * FR-HISTORY-1 — where a fundraiser is in its life, and therefore where to find it.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Closing out a fundraiser used to file it as "completed" the instant ordering
 * stopped. `triageCampaign` returned `completed` for anything in the closed
 * family, and CRM-CC-2 renders that section `collapsedByDefault: true` under the
 * heading "Recently completed — Finished campaigns, kept for reference". So the
 * moment the owner closed The Best Brew Test 2, a fundraiser with $202.50 still
 * owed folded itself away as a finished record.
 *
 * That was not a bug in either module. It was the honest consequence of a gap
 * they both documented: lib/growth/nextAction.ts says outright that "the
 * campaigns response carries no settlement or invoice linkage ... so whether a
 * settled campaign has been invoiced is UNKNOWABLE from this data", and it
 * declined to guess. The fix is to stop it being unknowable — /api/campaigns now
 * sends the campaign's invoice statuses and `settled_externally` — and then to
 * put the judgement in one place, here.
 *
 * ORDERING CLOSED IS NOT THE SAME AS MONEY RECEIVED. That distinction is the
 * whole module.
 *
 * ── WHY "OBLIGATION" AND NOT JUST "CLOSED" ──────────────────────────────────
 *
 * The owner's contract says a campaign stays findable until its invoice is PAID
 * or it is marked settled externally. Applied literally to Production that would
 * park 20 of 22 campaigns in "awaiting payment", including fourteen archived
 * test records with zero orders and zero invoices — nothing is owed on those, so
 * calling them awaiting payment would be a new untruth replacing the old one.
 *
 * So the test is whether a financial obligation actually EXISTS:
 *   - an unpaid campaign-linked invoice (DRAFT / SENT / PENDING / OVERDUE), or
 *   - real sales with no invoice raised at all.
 * A closed campaign with neither never had an obligation and is simply a record.
 *
 * ── WHY ARCHIVED DOES NOT AUTOMATICALLY COMPLETE ────────────────────────────
 *
 * Archiving is a filing action, not a payment. Edgar County and Coles County are
 * Archived, carry $2,065 and $1,410 of real orders, have no invoice, and are not
 * yet marked settled externally — so they read as awaiting payment, which is the
 * truthful reading of what FreezerIQ currently knows and is exactly the signal
 * that prompts the owner to mark them. Once `settled_externally` is set they
 * become COMPLETED with a truthful reason. Nothing here marks them.
 */

/** The closed-family vocabulary. Mirrors nextAction.ts CLOSED_FAMILY. */
export const CLOSED_STATUS_FAMILY = ['Closed', 'Settled', 'Completed', 'Archived'] as const;

/** Invoice statuses that mean money is still owed. Mirrors INV-C's outstanding set. */
export const UNPAID_INVOICE_STATUSES = ['DRAFT', 'PENDING', 'SENT', 'OVERDUE'] as const;

export type CampaignLifecycleBucket =
    /** No campaign running yet — a real lead, or an organization placeholder. */
    | 'lead'
    /** Selling, fulfilling, or otherwise operationally live. */
    | 'open'
    /** Ordering has closed and money is still owed. MUST stay easy to find. */
    | 'closed_awaiting_payment'
    /** Paid, settled outside FreezerIQ, or closed owing nothing. A record. */
    | 'completed';

export interface CampaignLifecycleInput {
    status?: string | null;
    closed_at?: string | Date | null;
    /** INV-D marker: the obligation was met outside FreezerIQ. */
    settled_externally?: boolean | null;
    /** Synthesised row for an organization with no campaign at all. */
    is_placeholder?: boolean | null;
    /**
     * This organization already completed business — it has a PAID invoice.
     * Only meaningful on a placeholder, where there is no campaign to judge.
     */
    has_settled_history?: boolean | null;
    /**
     * This organization has an OPEN FundraiserOpportunity — status `new`,
     * `in_conversation` or `date_confirmed`. The durable record of current
     * interest, and the only thing that makes an organization a LEAD today.
     * Paid history never suppresses it.
     */
    has_open_opportunity?: boolean | null;
    /**
     * Statuses of this campaign's linked invoices, flattened. Empty = none exist.
     * Sent by /api/campaigns.
     */
    invoice_statuses?: readonly (string | null | undefined)[] | null;
    /**
     * The raw Prisma relation, as /api/customers/[id] returns it for the
     * organization page. Accepted alongside `invoice_statuses` because the two
     * surfaces are served by different routes, and a classifier that silently
     * read the wrong key would reintroduce exactly the bug this module fixes —
     * a missing field being indistinguishable from "no invoice".
     */
    invoices?: readonly ({ status?: string | null } | null)[] | null;
    /** Gross frozen at closeout, when closeout has run. */
    settlement_total?: number | string | null;
    /** Live non-canceled fundraiser orders, for campaigns never closed out. */
    held_order_count?: number | null;
}

const isClosedStatus = (s: unknown): boolean =>
    typeof s === 'string' && (CLOSED_STATUS_FAMILY as readonly string[]).includes(s);

const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

/** Has ordering finished? Either an explicit closeout stamp or a closed status. */
export function isCampaignClosedFamily(c: CampaignLifecycleInput): boolean {
    return Boolean(c?.closed_at) || isClosedStatus(c?.status);
}

/**
 * The campaign's invoice statuses, from whichever shape the serving route used.
 *
 * Returns null when NEITHER key is present — "nobody told us" is a different
 * fact from "no invoice exists", and collapsing the two is the mistake that made
 * a PAID campaign read as un-invoiced. Callers that must not guess check for null.
 */
export function readInvoiceStatuses(c: CampaignLifecycleInput): string[] | null {
    if (Array.isArray(c?.invoice_statuses)) {
        return c.invoice_statuses.filter((s): s is string => typeof s === 'string');
    }
    if (Array.isArray(c?.invoices)) {
        return c.invoices
            .map((i) => (i && typeof i.status === 'string' ? i.status : null))
            .filter((s): s is string => s !== null);
    }
    return null;
}

/** Does a campaign-linked invoice exist at all? */
export function hasCampaignInvoice(c: CampaignLifecycleInput): boolean {
    return (readInvoiceStatuses(c) ?? []).length > 0;
}

/** Is at least one campaign-linked invoice PAID? */
export function hasPaidCampaignInvoice(c: CampaignLifecycleInput): boolean {
    return (readInvoiceStatuses(c) ?? []).includes('PAID');
}

/** Is at least one campaign-linked invoice still owed? */
export function hasUnpaidCampaignInvoice(c: CampaignLifecycleInput): boolean {
    return (readInvoiceStatuses(c) ?? []).some((s) =>
        (UNPAID_INVOICE_STATUSES as readonly string[]).includes(s));
}

/**
 * Is the campaign's gross KNOWN, and is it zero?
 *
 * `settlement_total` is the authoritative frozen gross once closeout has run.
 * When it is absent — Edgar and Coles are Archived with closed_at NULL and no
 * settlement row — live non-canceled orders are the fallback.
 *
 * Returns null when NEITHER is present. An absent number is not a zero.
 */
function knownGross(c: CampaignLifecycleInput): number | null {
    if (c?.settlement_total !== null && c?.settlement_total !== undefined && c.settlement_total !== '') {
        const n = Number(c.settlement_total);
        if (Number.isFinite(n)) return n;
    }
    if (typeof c?.held_order_count === 'number' && Number.isFinite(c.held_order_count)) {
        return c.held_order_count;
    }
    return null;
}

/**
 * Is there money to collect on this campaign?
 *
 *   'owed'    — an unpaid invoice exists, or real sales exist with no invoice
 *               (the Edgar/Coles shape: an obligation plainly existed and
 *               FreezerIQ never recorded one).
 *   'none'    — POSITIVE proof there is nothing to collect.
 *   'unknown' — we were not told enough to say either way.
 *
 * ── WHY THIS IS A TRI-STATE ─────────────────────────────────────────────────
 *
 * The first version of this returned a boolean, and false therefore meant BOTH
 * "proven nothing owed" and "nobody told us". A caller that omitted invoice
 * linkage — or simply had no gross fields on the row — came out as "nothing
 * owed" and was filed as completed, which is the ORIGINAL BUG wearing a new
 * hat: a fundraiser that might still be owed money quietly folding itself away.
 *
 * Absence is never evidence. 'none' now requires all of:
 *   - invoice linkage was actually sent, and
 *   - no unpaid invoice exists, and
 *   - the gross is KNOWN and zero (or the only invoice is CANCELED).
 */
export type ObligationVerdict = 'owed' | 'none' | 'unknown';

export function assessObligation(c: CampaignLifecycleInput): ObligationVerdict {
    if (hasPaidCampaignInvoice(c)) return 'none';
    if (hasUnpaidCampaignInvoice(c)) return 'owed';

    const statuses = readInvoiceStatuses(c);
    // Nobody told us about invoices. We cannot conclude anything.
    if (statuses === null) return 'unknown';
    // An invoice exists but is neither paid nor collectable — CANCELED.
    if (statuses.length > 0) return 'none';

    // No invoice was ever raised. Then the question is whether there were sales.
    const gross = knownGross(c);
    if (gross === null) return 'unknown';
    return gross > 0 ? 'owed' : 'none';
}

/**
 * Kept as the readable predicate for callers that only need "is money owed".
 * `unknown` counts as owed here on purpose — see classifyCampaignLifecycle.
 */
export function hasOutstandingObligation(c: CampaignLifecycleInput): boolean {
    return assessObligation(c) !== 'none';
}

/**
 * The one canonical bucket. Pure, total, and deterministic.
 *
 * Order matters, and each step is a separate claim:
 *   1. settled externally  -> the owner recorded that it was paid elsewhere.
 *   2. invoice PAID        -> INV-D recorded a real payment.
 *   3. still open          -> ordering has not finished.
 *   4. obligation exists   -> closed, money owed. Stays findable.
 *   5. otherwise           -> closed owing nothing. A record.
 */
export function classifyCampaignLifecycle(c: CampaignLifecycleInput): CampaignLifecycleBucket {
    if (c?.settled_externally === true) return 'completed';
    if (hasPaidCampaignInvoice(c)) return 'completed';

    if (!isCampaignClosedFamily(c)) {
        // A placeholder stands in for an organization with no campaign at all.
        if (c?.is_placeholder === true) {
            // An OPEN FundraiserOpportunity (new / in_conversation /
            // date_confirmed) is the durable record of current interest, and it
            // wins over history every time. An organization that ran a fundraiser
            // last year and has just asked about another one is a live lead, and
            // burying it under "completed" because it once paid an invoice would
            // hide exactly the rebooking business this dashboard exists to find.
            if (c?.has_open_opportunity === true) return 'lead';
            // No current interest, but completed business behind it: history.
            // "Exists and has no running campaign" is not a sales signal, and
            // treating it as one is what put five long-finished organizations
            // under "Leads & upcoming".
            if (c?.has_settled_history === true) return 'completed';
            // Neither. A genuine prospect nobody has done business with yet.
            return 'lead';
        }
        if (c?.status === 'Lead') return 'lead';
        return 'open';
    }

    // Closed. 'unknown' deliberately lands in awaiting-payment rather than
    // completed: the failure mode this whole phase exists to remove is a
    // fundraiser hiding itself while money is outstanding, so when we cannot
    // tell, we stay visible. Being wrong here shows a paid fundraiser in the
    // work list; being wrong the other way loses money silently.
    return assessObligation(c) === 'none' ? 'completed' : 'closed_awaiting_payment';
}

// ───────────────────────────────────────────────────────────────────────────
// PRESENTATION
// ───────────────────────────────────────────────────────────────────────────

/**
 * What the settlement/invoice box may say about a campaign.
 *
 * This replaces `c.invoice_id ? 'invoiced ✓' : 'not yet invoiced'`, which read a
 * field that does not exist on any campaign row — there is no `invoice_id`
 * column on FundraiserCampaign and /api/campaigns never sent one — so the banner
 * said "not yet invoiced" for every campaign in the product, including one whose
 * invoice was already PAID.
 */
export type CampaignInvoiceState =
    | 'unknown'             // the serving route did not send invoice linkage
    | 'none'                // closeout has not produced an invoice
    | 'draft'               // generated, awaiting owner review
    | 'sent'                // issued, awaiting payment
    | 'overdue'             // issued, late
    | 'paid'                // INV-D settlement recorded
    | 'settled_externally'  // paid outside FreezerIQ
    | 'canceled';           // withdrawn

export function resolveCampaignInvoiceState(c: CampaignLifecycleInput): CampaignInvoiceState {
    if (c?.settled_externally === true) return 'settled_externally';
    const statuses = readInvoiceStatuses(c);
    // Not told. Distinct from "none exists" on purpose — see describeCampaignInvoice.
    if (statuses === null) return 'unknown';
    if (statuses.includes('PAID')) return 'paid';
    if (statuses.includes('OVERDUE')) return 'overdue';
    if (statuses.includes('SENT')) return 'sent';
    if (statuses.includes('DRAFT')) return 'draft';
    if (statuses.includes('PENDING')) return 'sent';
    if (statuses.length > 0) return 'canceled';
    return 'none';
}

export interface CampaignInvoiceDisplay {
    label: string;
    /** True only when no invoice exists and closeout has frozen a settlement. */
    canCreateInvoice: boolean;
    tone: 'neutral' | 'pending' | 'good' | 'warn';
    /**
     * False when the serving route sent no invoice linkage. Callers append the
     * label only when this is true, so an uninformed surface stays silent
     * instead of inventing a status.
     */
    known: boolean;
}

/**
 * The words shown, and whether "Create invoice" is offered.
 *
 * `canCreateInvoice` is false for every state except `none`. A campaign that
 * already has an invoice must never offer to create a second one — the partial
 * unique index `invoices_one_per_campaign` would reject it anyway, so offering
 * the action could only ever produce an error.
 */
export function describeCampaignInvoice(c: CampaignLifecycleInput): CampaignInvoiceDisplay {
    switch (resolveCampaignInvoiceState(c)) {
        case 'settled_externally':
            return { label: 'Settled outside FreezerIQ', canCreateInvoice: false, tone: 'good', known: true };
        case 'paid':
            return { label: 'Paid', canCreateInvoice: false, tone: 'good', known: true };
        case 'overdue':
            return { label: 'Invoice overdue', canCreateInvoice: false, tone: 'warn', known: true };
        case 'sent':
            return { label: 'Invoice sent — awaiting payment', canCreateInvoice: false, tone: 'pending', known: true };
        case 'draft':
            return { label: 'Draft invoice — review and send', canCreateInvoice: false, tone: 'pending', known: true };
        case 'canceled':
            return { label: 'Invoice canceled', canCreateInvoice: false, tone: 'neutral', known: true };
        case 'unknown':
            // The route did not send invoice linkage, so we do not know. Say the
            // neutral true thing and offer NOTHING — asserting "not yet invoiced"
            // from a missing field is precisely the defect this module replaces,
            // and offering "Create invoice" on a guess could duplicate a real one.
            return { label: 'Settlement frozen at closeout', canCreateInvoice: false, tone: 'neutral', known: false };
        case 'none':
        default:
            return {
                label: 'Not yet invoiced',
                // Only offer creation once closeout has actually frozen a settlement.
                canCreateInvoice: isCampaignClosedFamily(c),
                tone: 'neutral',
                known: true,
            };
    }
}

export interface LifecycleBucketMeta {
    title: string;
    description: string;
    collapsedByDefault: boolean;
}

/**
 * Section presentation. The one rule that matters:
 * `closed_awaiting_payment` is NEVER collapsed by default.
 */
export const LIFECYCLE_BUCKET_META: Record<CampaignLifecycleBucket, LifecycleBucketMeta> = {
    open: {
        title: 'Open fundraisers',
        description: 'Setting up, selling, or fulfilling.',
        collapsedByDefault: false,
    },
    closed_awaiting_payment: {
        title: 'Closed — awaiting payment',
        description: 'Ordering has finished and the money has not been collected yet.',
        collapsedByDefault: false,
    },
    lead: {
        title: 'Leads & upcoming',
        description: 'Organizations without a running campaign yet.',
        collapsedByDefault: false,
    },
    completed: {
        title: 'Completed',
        description: 'Paid or settled. Kept for reference.',
        collapsedByDefault: true,
    },
};

/** Display order: live work first, money owed second, leads third, records last. */
export const LIFECYCLE_BUCKET_ORDER: readonly CampaignLifecycleBucket[] = [
    'closed_awaiting_payment',
    'open',
    'lead',
    'completed',
] as const;
