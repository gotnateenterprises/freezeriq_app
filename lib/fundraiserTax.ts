/**
 * FR-TAX-1 — the ONE authority for fundraiser tax status, rates, and amounts.
 *
 * WHAT THIS MODULE IS FOR
 * ───────────────────────
 * FreezerIQ needs to answer four questions and nothing more:
 *   1. is this organization / campaign taxable?
 *   2. if taxable, what rate applies?
 *   3. if exempt, do we hold supporting documentation?
 *   4. what taxable base does the invoice multiply?
 *
 * It is deliberately NOT a tax engine. There is no ZIP lookup, no Avalara or
 * TaxJar, no municipality geocoding, no multi-jurisdiction sourcing and no
 * supporter-by-supporter determination — matching the existing house position
 * in lib/fundraiserCloseoutMath.ts: "Whether it applies is an owner decision
 * made at closeout, not a jurisdiction FreezerIQ tries to infer." This file
 * gives no tax advice.
 *
 * THE BUSINESS TRANSACTION THIS MODELS
 * ────────────────────────────────────
 * Supporters tally orders through the fundraiser; the ORGANIZATION aggregates
 * them; Freezer Chef produces and delivers the whole order to the organization;
 * the organization distributes to its supporters; Freezer Chef invoices the
 * ORGANIZATION. So the organization is the purchaser/customer of record, and
 * the tax question belongs to the organization sale — not to 40 individual
 * supporter receipts.
 *
 * WHY NOTHING HERE IS HARDCODED TO 1%
 * ───────────────────────────────────
 * Illinois eliminated its statewide 1% grocery tax on 2026-01-01. A
 * municipality or county MAY levy exactly 1% locally, so 1.00 may well be the
 * correct configured value for this tenant — but it is a verified local fact a
 * tenant records, never a constant this product asserts. Every rate in this
 * module arrives as data.
 */

import { roundCents } from '@/lib/fundraiserCloseoutMath';

// ── Organization tax status ─────────────────────────────────────────────────

/** Mirrors the Prisma enum OrgTaxStatus. */
export type OrgTaxStatus = 'UNKNOWN' | 'TAXABLE' | 'TAX_EXEMPT';

export const ORG_TAX_STATUSES: readonly OrgTaxStatus[] = ['UNKNOWN', 'TAXABLE', 'TAX_EXEMPT'] as const;

export function isOrgTaxStatus(value: unknown): value is OrgTaxStatus {
    return typeof value === 'string' && (ORG_TAX_STATUSES as readonly string[]).includes(value);
}

/** Human-facing labels. One place, so two screens cannot word this differently. */
export const ORG_TAX_STATUS_LABELS: Record<OrgTaxStatus, string> = {
    UNKNOWN: 'Not set',
    TAXABLE: 'Taxable',
    TAX_EXEMPT: 'Tax exempt',
};

/**
 * Shown wherever a tenant is asked to choose. States the safe-default rule out
 * loud so the UNKNOWN option never reads as a quiet way to avoid tax.
 */
export const ORG_TAX_STATUS_HELPER_TEXT =
    'Record this deliberately. Being a school, church, charity, PTO or youth group does not by itself make an organization tax exempt — until you set it, campaigns are treated as taxable at your default rate.';

// ── Rate parsing / validation ───────────────────────────────────────────────

export const MIN_TAX_RATE_PERCENT = 0;
export const MAX_TAX_RATE_PERCENT = 100;

export type TaxRateParseResult =
    | { ok: true; percent: number }
    | { ok: false; error: string };

/**
 * Server-authoritative parse of a tenant-supplied tax rate, as a PERCENT
 * (1.00 means 1%), matching businesses.default_food_tax_percent,
 * fundraiser_campaigns.tax_rate_percent, org_share_percent and
 * Invoice.fundraiser_profit_percent. A fraction (0.01) would be a 100x error.
 *
 * Blank/absent is NOT silently 0 here — callers decide whether omission means
 * "leave unchanged" or "use the default"; a parser that invented 0% would be
 * asserting a tax position nobody typed.
 */
export function parseTaxRatePercent(input: unknown): TaxRateParseResult {
    if (input === null || input === undefined || input === '') {
        return { ok: false, error: 'Tax rate is required.' };
    }
    if (typeof input !== 'number' && typeof input !== 'string') {
        return { ok: false, error: 'Tax rate must be a number.' };
    }
    if (typeof input === 'string' && input.trim() === '') {
        return { ok: false, error: 'Tax rate is required.' };
    }

    const n = Number(input);
    if (!Number.isFinite(n)) {
        return { ok: false, error: 'Tax rate must be a number.' };
    }
    if (n < MIN_TAX_RATE_PERCENT || n > MAX_TAX_RATE_PERCENT) {
        return {
            ok: false,
            error: `Tax rate must be between ${MIN_TAX_RATE_PERCENT} and ${MAX_TAX_RATE_PERCENT}.`,
        };
    }

    // DECIMAL(5,2) — normalise here so what we store is what we validated.
    return { ok: true, percent: Math.round(n * 100) / 100 };
}

/** Display formatting: natural percentages, never engineering notation. */
export function formatTaxRate(value: number | string | null | undefined): string {
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '—';
    return `${parseFloat(n.toFixed(2))}%`;
}

// ── The campaign tax snapshot ───────────────────────────────────────────────

export interface CampaignTaxSnapshot {
    status: Exclude<OrgTaxStatus, 'UNKNOWN'>;
    /** PERCENT. Always 0 when status is TAX_EXEMPT. */
    ratePercent: number;
}

/**
 * Resolve the tax treatment a campaign should FREEZE at launch.
 *
 * THE UNKNOWN RULE, which is the safety-critical part: an organization whose
 * status was never recorded resolves to TAXABLE at the tenant's default rate.
 * UNKNOWN means "nobody has been asked", and treating that as exempt would let
 * an unanswered question quietly become a tax position. A tenant who holds real
 * documentation sets TAX_EXEMPT deliberately, or overrides at launch.
 *
 * `override` is the tenant's explicit choice on the launch form and always
 * wins — the tenant owns this decision. Coordinators and supporters never reach
 * this function's callers.
 */
export function resolveCampaignTaxSnapshot(input: {
    organizationStatus: OrgTaxStatus | null | undefined;
    tenantDefaultRatePercent: number | string | null | undefined;
    override?: { status: Exclude<OrgTaxStatus, 'UNKNOWN'>; ratePercent?: number | string | null } | null;
}): CampaignTaxSnapshot {
    const defaultRate = Number(input.tenantDefaultRatePercent);
    const safeDefaultRate = Number.isFinite(defaultRate) && defaultRate >= 0 ? defaultRate : 0;

    // ── FR-TAX-CORRECTNESS-1 HARDENING: THE ORGANIZATION WINS, FIRST ────────
    //
    // This check used to sit BELOW the override branch, which meant a client
    // form posting taxStatus:'TAXABLE' silently beat an organization the server
    // itself had recorded as TAX_EXEMPT. While the tenant default was 0.00%
    // that mistake was free. It is not free any more: the same slip now freezes
    // a real rate onto a campaign and charges real supporters real money that
    // an exempt organization should never have collected.
    //
    // Exemption is authoritative at the ORGANIZATION level — Customer.tax_status,
    // backed by tax_document and tax_exemption_number, written only through the
    // session-authenticated, tenant-scoped PATCH /api/customers/[id]. A browser
    // form is not that record and cannot outrank it.
    if (input.organizationStatus === 'TAX_EXEMPT') {
        return { status: 'TAX_EXEMPT', ratePercent: 0 };
    }

    if (input.override) {
        // An override can no longer GRANT exemption. Reaching here means the
        // organization is not recorded exempt, so an override asking for
        // TAX_EXEMPT is a browser inventing a tax position it has no authority
        // to invent — the caller is expected to have already refused it via
        // decideCampaignTaxOverride below. If one arrives anyway (a direct
        // caller, a future route), resolving it as TAXABLE is the deliberate
        // fail-safe direction: over-collecting is recoverable and visible,
        // silently granting exemption is neither.
        //
        // What an override legitimately still does is set the RATE on a taxable
        // campaign. That is the tenant's own decision about their own campaign,
        // made by an authenticated tenant user, and it stays theirs.
        const parsed = parseTaxRatePercent(
            input.override.ratePercent ?? safeDefaultRate,
        );
        return { status: 'TAXABLE', ratePercent: parsed.ok ? parsed.percent : safeDefaultRate };
    }

    // TAXABLE, and the safe default for UNKNOWN / null / anything unrecognised.
    return { status: 'TAXABLE', ratePercent: safeDefaultRate };
}

/**
 * Does this request's tax override carry the authority it is claiming?
 *
 * Shaped like decideOrgShareChange in lib/fundraiserOrgShare.ts — the house
 * pattern for "a route needs to refuse something for a stated reason" — so the
 * rule is unit-testable without a route, a session, or Prisma.
 *
 * There is exactly one thing to refuse: a client asking for TAX_EXEMPT on an
 * organization the server has NOT recorded as exempt. Exemption is a documented
 * CRM fact (Customer.tax_status + tax_document + tax_exemption_number), not a
 * radio button, and a fundraiser that collects no tax because a form said so is
 * a liability nobody signed for.
 *
 * The mirror case — a client asking for TAXABLE on an organization that IS
 * recorded exempt — is deliberately NOT an error. resolveCampaignTaxSnapshot
 * already resolves it to exempt, which is the correct outcome, and failing the
 * whole launch over a stale radio button would punish the tenant for a UI race
 * rather than protect anyone.
 */
export type CampaignTaxOverrideDecision =
    | { rejected?: false }
    | { rejected: true; status: 409; error: string };

export const CAMPAIGN_TAX_EXEMPTION_NOT_ON_RECORD =
    'This organization is not recorded as tax exempt, so this fundraiser cannot be launched as exempt. '
    + 'Record the exemption on the organization first (with its documentation), then launch.';

export function decideCampaignTaxOverride(input: {
    organizationStatus: OrgTaxStatus | null | undefined;
    requestedStatus: unknown;
}): CampaignTaxOverrideDecision {
    // Not a recognised override at all — nothing claimed, nothing to refuse.
    if (!isOrgTaxStatus(input.requestedStatus) || input.requestedStatus === 'UNKNOWN') {
        return { rejected: false };
    }

    if (input.requestedStatus === 'TAX_EXEMPT' && input.organizationStatus !== 'TAX_EXEMPT') {
        return { rejected: true, status: 409, error: CAMPAIGN_TAX_EXEMPTION_NOT_ON_RECORD };
    }

    return { rejected: false };
}

export function isCampaignTaxOverrideRejected(
    d: CampaignTaxOverrideDecision
): d is { rejected: true; status: 409; error: string } {
    return (d as any).rejected === true;
}

/**
 * FR-TAX-CORRECTNESS-1 HARDENING — the activation boundary.
 *
 * Three routes CREATE a campaign and each freezes a tax snapshot as it does
 * (POST /api/campaigns, POST /api/opportunities/[id]/launch, the CSV importer).
 * But a campaign can also reach 'Active' WITHOUT passing through any of them:
 * PATCH /api/campaigns/[id] accepts a status change and resolves no tax at all.
 * A campaign that becomes publicly orderable with tax_status NULL collects
 * nothing, permanently and silently, because resolveCloseoutTaxRate reads NULL
 * as "legacy, collect nothing".
 *
 * This is the one gate for that transition. It is a DECISION, not a writer: it
 * returns what should happen and the route performs the write inside its own
 * transaction, so the rule can be tested without a route or a database. It
 * delegates every actual tax question to resolveCampaignTaxSnapshot above —
 * there is still exactly one resolver.
 *
 * ── WHAT IT REFUSES TO TOUCH, AND WHY ───────────────────────────────────────
 *
 * Existing live campaigns keep their frozen contract, guarded twice over:
 *
 *   1. It only fires on a NOT-ACTIVE -> ACTIVE transition. A campaign already
 *      Active is never re-snapshotted, so Edgar County Farm Bureau's live
 *      NULL/NULL contract and the TAXABLE@0.00% campaigns are untouchable here.
 *   2. Even on a genuine transition, a campaign carrying ANY financial activity
 *      is left exactly as it is. Repricing a fundraiser that already took a
 *      supporter's money is never the right repair.
 *
 * A campaign that already HAS a snapshot keeps it — this fills a gap, it does
 * not re-decide a question that was already answered at launch.
 */
export type ActivationTaxSnapshotDecision =
    | { write: false; reason: string }
    | { write: true; snapshot: CampaignTaxSnapshot; reason: string };

export const ACTIVE_CAMPAIGN_STATUS = 'Active';

export function decideActivationTaxSnapshot(input: {
    /** The campaign's status as currently stored. */
    currentStatus: unknown;
    /** The status this request is asking for; undefined when unchanged. */
    nextStatus: unknown;
    /** The campaign's stored snapshot, if it has one. */
    existingTaxStatus: OrgTaxStatus | null | undefined;
    /** True if the campaign has any order, invoice, or closeout. */
    hasFinancialActivity: boolean;
    /** The ORGANIZATION's authoritative recorded status. */
    organizationStatus: OrgTaxStatus | null | undefined;
    tenantDefaultRatePercent: number | string | null | undefined;
}): ActivationTaxSnapshotDecision {
    const becomingActive =
        input.nextStatus === ACTIVE_CAMPAIGN_STATUS
        && input.currentStatus !== ACTIVE_CAMPAIGN_STATUS;

    if (!becomingActive) {
        return { write: false, reason: 'not a not-active -> Active transition' };
    }

    if (input.existingTaxStatus) {
        return { write: false, reason: 'campaign already carries a frozen tax snapshot' };
    }

    if (input.hasFinancialActivity) {
        return {
            write: false,
            reason: 'campaign already has financial activity; its legacy contract is preserved',
        };
    }

    return {
        write: true,
        reason: 'activation of a campaign with no snapshot and no financial activity',
        // No override: an activation is not a place to set a tax position by
        // hand. The organization record and the tenant default decide it, the
        // same way every creation path decides it.
        snapshot: resolveCampaignTaxSnapshot({
            organizationStatus: input.organizationStatus,
            tenantDefaultRatePercent: input.tenantDefaultRatePercent,
        }),
    };
}

// ── The one tax calculation ─────────────────────────────────────────────────

export interface TaxComputation {
    taxApplied: boolean;
    ratePercent: number;
    taxableBase: number;
    taxAmount: number;
}

/**
 * tax = taxable base x rate, rounded once at the edge with the SAME roundCents
 * the closeout math already uses (imported, never re-implemented — two rounding
 * functions is how a penny goes missing).
 *
 * The taxable BASE is a parameter, never derived inside this function. That is
 * deliberate: which amount is legally the selling price from Freezer Chef to
 * the organization is an unresolved accounting question (see
 * TAXABLE_BASE_STATUS below), so this module refuses to bake in an answer. Once
 * the owner's accountant confirms the base, exactly one call site changes.
 *
 * A TAX_EXEMPT campaign is always 0 — no rate, no base, no rounding edge case.
 */
export function computeCampaignTax(input: {
    snapshot: Pick<CampaignTaxSnapshot, 'status' | 'ratePercent'> | null | undefined;
    taxableBase: number;
}): TaxComputation {
    const base = roundCents(Number(input.taxableBase) || 0);

    if (!input.snapshot || input.snapshot.status === 'TAX_EXEMPT') {
        return { taxApplied: false, ratePercent: 0, taxableBase: base, taxAmount: 0 };
    }

    const rate = Number(input.snapshot.ratePercent);
    if (!Number.isFinite(rate) || rate <= 0) {
        return { taxApplied: false, ratePercent: 0, taxableBase: base, taxAmount: 0 };
    }

    return {
        taxApplied: true,
        ratePercent: rate,
        taxableBase: base,
        taxAmount: roundCents(base * rate / 100),
    };
}

// ── FR-TAX-CORRECTNESS-1: the supporter-order tax ───────────────────────────

export interface SupporterOrderTax {
    /** True only when a rate actually applied and produced a charge decision. */
    taxApplied: boolean;
    /** PERCENT frozen onto this order. 0 for exempt, legacy, and unset rates. */
    ratePercent: number;
    /** Pre-tax food subtotal this order was priced from. */
    subtotal: number;
    /** Rounded tax the supporter owes. */
    taxAmount: number;
    /** subtotal + taxAmount — what the supporter actually pays. */
    total: number;
}

/**
 * THE one place a supporter's food tax is calculated, for BOTH order writers
 * (the public storefront route and the coordinator's manual "+ Add Order").
 *
 * Takes the campaign's FROZEN snapshot, never the organization's live tax
 * status: a tenant editing an organization mid-campaign must not change what
 * supporters are charged for a fundraiser already taking orders. The snapshot
 * is the contract.
 *
 * THE LEGACY RULE, which is what makes this safe to deploy while three
 * campaigns are live and taking real orders:
 *
 *   no snapshot (tax_status NULL)  -> $0.00, exactly as today
 *   TAX_EXEMPT                     -> $0.00, no supporter override, ever
 *   TAXABLE with rate <= 0 / unset -> $0.00, exactly as today
 *   TAXABLE with rate > 0          -> subtotal x rate, the new behaviour
 *
 * Every campaign currently live in Production falls into one of the first three
 * branches, so deploying this changes nothing about what any existing supporter
 * is charged. Only a campaign launched AFTER a tenant configures a real rate
 * reaches the fourth branch.
 *
 * Rounded once, with the same roundCents the closeout uses, so an order's own
 * arithmetic and the settlement that later sums it cannot disagree by a cent.
 */
export function computeSupporterOrderTax(input: {
    subtotal: number;
    snapshot: { status: OrgTaxStatus | null | undefined; ratePercent: number | string | null | undefined } | null | undefined;
}): SupporterOrderTax {
    const subtotal = roundCents(Number(input.subtotal) || 0);

    const rate = resolveCloseoutTaxRate({
        taxStatus: input.snapshot?.status ?? null,
        taxRatePercent: input.snapshot?.ratePercent ?? null,
    });

    if (rate <= 0) {
        return { taxApplied: false, ratePercent: 0, subtotal, taxAmount: 0, total: subtotal };
    }

    const taxAmount = roundCents(subtotal * rate / 100);
    return {
        taxApplied: true,
        ratePercent: rate,
        subtotal,
        taxAmount,
        total: roundCents(subtotal + taxAmount),
    };
}

/**
 * THE one derivation of what a supporter actually owes on a persisted order.
 *
 * `Order.total_amount` keeps its long-standing meaning — PRE-TAX food sales —
 * because campaign metrics, the organization-share basis, the closeout gross
 * and the reconciliation gate all already read it that way, and 79 Production
 * orders were written under it. Redefining it would have forced a semantic
 * change on every one of those readers while three fundraisers were live.
 *
 * So the amount due is DERIVED here instead, in one place, rather than as an
 * ad-hoc `total_amount + tax_amount` scattered through components. Legacy rows
 * carry tax_amount = 0 and therefore return their total unchanged.
 *
 *     food sales = total_amount
 *     tax        = tax_amount
 *     amount due = total_amount + tax_amount
 */
export function supporterAmountDue(order: { total_amount: unknown; tax_amount?: unknown }): number {
    const subtotal = roundCents(Number(order?.total_amount) || 0);
    const tax = roundCents(Number(order?.tax_amount) || 0);
    return roundCents(subtotal + tax);
}

// ── The unresolved question, stated in code so it cannot be forgotten ───────

/**
 * THE TAXABLE BASE — RESOLVED BY OWNER DECISION (FR-TAX-1B).
 *
 * FR-TAX-1 deliberately shipped the foundation WITHOUT changing what closeout
 * charged, because two authorities in this repository pointed at different
 * bases and nothing reconciled them:
 *
 *   GROSS — what the code charged. lib/fundraiserCloseoutMath.ts computed
 *     `grossSales * FOOD_TAX_RATE_PERCENT / 100`. All five historical
 *     Production invoices reconcile to the cent on that basis and none on a
 *     net basis ($6,420 gross -> $64.20 tax -> $5,200.20 total; a net basis
 *     would have produced $51.36 / $5,187.36).
 *
 *   NET — what the repository repeatedly called the amount the organization
 *     actually pays (lib/fundraiserOrgShare.ts balanceDueToTenant,
 *     docs/ai/SETTLEMENT_CONSTITUTION.md).
 *
 * THE OWNER HAS NOW RULED: the base is NET AFTER ORGANIZATION SHARE.
 *
 *     supporter-facing gross merchandise sales
 *   - organization fundraiser share
 *   = taxable selling price from Freezer Chef to the organization
 *
 * This follows the business model: Freezer Chef sells the aggregated order TO
 * THE ORGANIZATION, and the selling price is what the organization actually
 * pays. The organization share is therefore a seller-funded reduction of
 * consideration, not a commission out of a full-price sale.
 *
 * The historical gross x 1% behaviour is NOT preserved merely because old
 * invoices used it — reproducing history was a fidelity argument, never a legal
 * one. Existing finalized invoices are equally NOT rewritten: they remain
 * historical records of what was actually billed and settled.
 */
export const CONFIRMED_TAXABLE_BASE = 'gross' as const;

/**
 * FR-TAX-CORRECTNESS-1 — THE OWNER HAS RE-RULED, AND THIS SUPERSEDES FR-TAX-1B.
 *
 * FR-TAX-1B (the block immediately above, kept because the reasoning it records
 * is real history) moved the taxable base to NET-after-organization-share and
 * left tax as a single organization-level charge computed at closeout. The
 * owner has now ruled the other way, on both axes, and the two changes are one
 * decision rather than two:
 *
 *   WHO PAYS   the SUPPORTER, at order time, on the retail price they see.
 *              Not the organization, and not later.
 *   WHAT BASE  GROSS supporter food sales. The organization's fundraiser share
 *              no longer reduces the taxable amount, because the tax was
 *              already collected at retail before any share is computed.
 *
 * The organization's percentage applies to PRE-TAX food sales only; the tax the
 * supporters paid is pass-through money the organization holds and remits.
 *
 *     supporter pays        subtotal + subtotal x rate
 *     organization keeps    pre-tax subtotal x share%
 *     organization remits   (pre-tax subtotal - share) + tax collected
 *
 * On $1,000.00 of food at a 20% share and a 1% rate:
 *     supporters paid       $1,010.00
 *     organization keeps    $200.00      (20% of $1,000, NOT of $1,010)
 *     food proceeds owed    $800.00
 *     tax remitted          $10.00
 *     organization owes     $810.00
 *
 * Under the superseded NET basis the same campaign produced $8.00 of tax and
 * $808.00 owed. That difference is the whole point of the re-ruling, so it is
 * stated here in numbers rather than left for a reader to derive.
 *
 * WHAT IS NOT REWRITTEN. Campaigns whose orders were accepted under the old
 * contract keep it. Every such campaign in Production carries either a 0.00%
 * frozen rate or no snapshot at all, so its tax is $0.00 under BOTH models and
 * this re-ruling cannot reprice it — see resolveCloseoutTaxRate's legacy rule,
 * which is unchanged, and the closeout's use of tax actually COLLECTED rather
 * than tax recomputed from a rate.
 */
export const TAXABLE_BASE_SUPERSEDES = 'FR-TAX-1B net basis, superseded by FR-TAX-CORRECTNESS-1' as const;

/**
 * The candidate bases. `gross` is campaign.settlement_total; `net` is gross
 * minus the organization's share (closeout's baseRemit).
 */
export type TaxableBaseChoice = 'gross' | 'net';

/**
 * The taxable selling price, per the confirmed NET basis.
 *
 * DELIBERATELY takes the organization's share as an INPUT rather than a
 * percent to re-multiply: closeout already computes `organizationAmount` and
 * derives its remit by SUBTRACTION so that
 * `organizationAmount + baseRemit === gross` exactly. Recomputing the share
 * here from a percentage would be a second, independent calculation that can
 * round to a different cent — precisely the "how a penny goes missing" failure
 * lib/fundraiserCloseoutMath.ts already warns about. One computation, reused.
 */
export function resolveTaxableSellingPrice(input: {
    grossSales: number;
    organizationAmount: number;
}): number {
    const gross = roundCents(Number(input.grossSales) || 0);
    const orgAmount = roundCents(Number(input.organizationAmount) || 0);
    return roundCents(gross - orgAmount);
}

/**
 * The rate closeout should charge for one campaign — including the deliberate
 * rule for campaigns that carry NO FR-TAX-1 snapshot.
 *
 * THE LEGACY RULE, stated explicitly because silence here would be a money
 * decision made by accident:
 *
 *   TAX_EXEMPT snapshot        -> 0. The exemption is authoritative on its own,
 *                                 even if a rate somehow rode along with it.
 *   TAXABLE snapshot           -> that campaign's own frozen rate.
 *   NO snapshot (NULL status)  -> 0, and the closeout is NOT silently
 *                                 reinterpreted.
 *
 * Why 0 for a legacy campaign rather than "resolve it live from the
 * organization and the tenant default": every campaign that predates FR-TAX-1
 * was launched, and its organization was told what the fundraiser would cost,
 * under a world where this product charged 1% of GROSS. The owner has since
 * ruled that base wrong. Applying the NEW base and a rate NOBODY chose at that
 * campaign's launch would invent a number that was never agreed — and reading
 * the tenant's CURRENT default would be exactly the live-value read that
 * snapshotting exists to prevent. Charging nothing is the only option that
 * neither fabricates a rate nor rewrites history.
 *
 * The consequence is explicit and small: a legacy OPEN campaign closes out with
 * $0.00 tax. If the owner wants tax on such a campaign, the honest path is to
 * relaunch it (a new campaign snapshots the current treatment) rather than have
 * this function guess. Already-CLOSED campaigns are unaffected in any case:
 * closeout is idempotent and refuses to run twice.
 */
export function resolveCloseoutTaxRate(input: {
    taxStatus: OrgTaxStatus | null | undefined;
    taxRatePercent: number | string | null | undefined;
}): number {
    if (!input.taxStatus) return 0;              // pre-FR-TAX-1 campaign
    if (input.taxStatus !== 'TAXABLE') return 0; // TAX_EXEMPT, or UNKNOWN never frozen

    const rate = Number(input.taxRatePercent);
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
}
