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

    if (input.override) {
        if (input.override.status === 'TAX_EXEMPT') {
            return { status: 'TAX_EXEMPT', ratePercent: 0 };
        }
        const parsed = parseTaxRatePercent(
            input.override.ratePercent ?? safeDefaultRate,
        );
        return { status: 'TAXABLE', ratePercent: parsed.ok ? parsed.percent : safeDefaultRate };
    }

    if (input.organizationStatus === 'TAX_EXEMPT') {
        return { status: 'TAX_EXEMPT', ratePercent: 0 };
    }

    // TAXABLE, and the safe default for UNKNOWN / null / anything unrecognised.
    return { status: 'TAXABLE', ratePercent: safeDefaultRate };
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
export const CONFIRMED_TAXABLE_BASE = 'net' as const;

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
