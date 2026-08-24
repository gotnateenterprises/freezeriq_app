/**
 * INV-B — the fundraiser closeout financial model.
 *
 * WHAT THIS DOCUMENT IS
 * ─────────────────────
 * A tally and a settlement instruction, not accounting software. It answers four
 * questions and nothing else:
 *
 *     what did the fundraiser sell        -> aggregated bundle lines
 *     what did it total                   -> gross fundraiser sales
 *     what did the organization earn      -> organization amount
 *     what must the organization remit    -> total due
 *
 * THE 1% FOOD TAX — WHY IT IS EXPLICIT
 * ────────────────────────────────────
 * Five historical invoices settled at 81% of gross while recording a 20%
 * organization share, which reads like a 101% arithmetic error. It is not. The
 * owner charges a 1% food tax, and the database already proves it: every one of
 * those invoices stores the exact 1% in `invoices.tax_amount` ($64.20 on $6,420,
 * $8.45 on $845, $8.70 on $870, $8.60 on $860, $12.20 on $1,220). 80% remit plus
 * 1% tax reproduces all five totals to the cent.
 *
 * So the tax is real and is carried as its OWN labelled fact — never folded into
 * an unexplained 81%. Whether it applies is an owner decision made at closeout,
 * not a jurisdiction FreezerIQ tries to infer. There is deliberately no
 * geographic tax determination here and this file gives no tax advice.
 *
 * WHY NO SCHEMA WAS ADDED
 * ───────────────────────
 * All three tax facts survive in existing columns:
 *     tax amount   `invoices.tax_amount`, already used exactly this way
 *     tax applied  tax_amount > 0
 *     tax rate     tax_amount / gross x 100, and gross is itself durable in
 *                  `fundraiser_campaigns.settlement_total` and in the invoice's
 *                  own line totals, which reconcile to it exactly
 * The one lossy case is a $0 gross, where an applied tax and an unapplied tax are
 * both $0.00 — a fundraiser that sold nothing, which has no money to explain.
 *
 * ROUNDING
 * ────────
 * The organization amount is rounded half-up to the cent; the remit is then
 * SUBTRACTED rather than computed as its own percentage, so
 * `organizationAmount + baseRemit === gross` exactly, always. Computing both
 * sides independently is how a penny goes missing.
 */

/** The single rate this product charges when the owner turns the tax on. */
export const FOOD_TAX_RATE_PERCENT = 1.0;

/** Percent of gross the organization keeps when a campaign predates INV-A. */
export const DEFAULT_ORG_SHARE_PERCENT = 20;

/**
 * Default for the closeout toggle, derived from product truth rather than
 * assumed: all five historical fundraiser invoices in Production charged it
 * (5 of 5). The owner still chooses per campaign; this only decides which way
 * the switch starts.
 */
export const FOOD_TAX_DEFAULT_APPLIED = true;

/** Round half-up to whole cents. Money never carries a third decimal. */
export function roundCents(value: number): number {
    if (!Number.isFinite(value)) return 0;
    // Scale, nudge past binary-representation error, then round half-up.
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface AggregatedLineInput {
    bundleId: string | null;
    /** Bundle name at sale time; falls back to the order item's own label. */
    description: string;
    variantSize: string | null;
    quantity: number;
    unitPrice: number;
}

export interface AggregatedLine {
    bundleId: string | null;
    description: string;
    variantSize: string | null;
    quantity: number;
    unitPrice: number;
    total: number;
}

/**
 * Collapse every supporter order item into ONE line per bundle + serving size.
 *
 * A fundraiser with 26 supporter orders becomes four lines, which is what makes
 * the document readable. Serves-5 and serves-2 of the same bundle are separate
 * lines because they are different products at different prices.
 *
 * Items that share a bundle and size but sold at DIFFERENT unit prices are kept
 * as separate lines rather than averaged — an averaged unit price would be a
 * number that was never charged to anyone.
 */
export function aggregateBundleLines(items: AggregatedLineInput[]): AggregatedLine[] {
    const byKey = new Map<string, AggregatedLine>();

    for (const it of items) {
        const qty = Number(it.quantity) || 0;
        const price = roundCents(Number(it.unitPrice) || 0);
        if (qty <= 0) continue;

        const key = [it.bundleId ?? 'null', it.variantSize ?? 'null', it.description, price.toFixed(2)].join('\u0000');
        const existing = byKey.get(key);
        if (existing) {
            existing.quantity += qty;
            existing.total = roundCents(existing.quantity * existing.unitPrice);
        } else {
            byKey.set(key, {
                bundleId: it.bundleId ?? null,
                description: it.description,
                variantSize: it.variantSize ?? null,
                quantity: qty,
                unitPrice: price,
                total: roundCents(qty * price),
            });
        }
    }

    // Largest line first: the reviewer should see the biggest number at the top.
    return [...byKey.values()].sort((a, b) => b.total - a.total || a.description.localeCompare(b.description));
}

export function sumLineTotals(lines: AggregatedLine[]): number {
    return roundCents(lines.reduce((s, l) => s + l.total, 0));
}

export interface CloseoutFinancials {
    grossSales: number;
    orgSharePercent: number;
    organizationAmount: number;
    baseRemit: number;
    taxApplied: boolean;
    taxRatePercent: number;
    taxAmount: number;
    totalDue: number;
}

/**
 * The whole money model, in one place.
 *
 *   organizationAmount = gross x pct        (rounded to cents)
 *   baseRemit          = gross - organizationAmount
 *   taxAmount          = gross x 1%         (only when the owner applied it)
 *   totalDue           = baseRemit + taxAmount
 *
 * Note what is NOT here: no processor fees, no COGS, no delivery or card
 * deductions, no jurisdictional logic. Adding any of those silently would change
 * what a fundraiser is owed.
 */
export function computeCloseoutFinancials(input: {
    grossSales: number;
    orgSharePercent: number;
    applyFoodTax: boolean;
}): CloseoutFinancials {
    const grossSales = roundCents(input.grossSales);
    const orgSharePercent = Number(input.orgSharePercent);

    const organizationAmount = roundCents(grossSales * orgSharePercent / 100);
    // Subtraction, not a second percentage — see ROUNDING above.
    const baseRemit = roundCents(grossSales - organizationAmount);

    const taxApplied = input.applyFoodTax === true;
    const taxRatePercent = taxApplied ? FOOD_TAX_RATE_PERCENT : 0;
    const taxAmount = taxApplied ? roundCents(grossSales * FOOD_TAX_RATE_PERCENT / 100) : 0;

    return {
        grossSales,
        orgSharePercent,
        organizationAmount,
        baseRemit,
        taxApplied,
        taxRatePercent,
        taxAmount,
        totalDue: roundCents(baseRemit + taxAmount),
    };
}

export class CloseoutReconciliationError extends Error {
    readonly lineSum: number;
    readonly grossSales: number;
    readonly detail: string;

    constructor(lineSum: number, grossSales: number, detail: string) {
        super(
            `Fundraiser totals do not reconcile: bundle lines total $${lineSum.toFixed(2)} ` +
            `but order totals are $${grossSales.toFixed(2)}. ${detail}`,
        );
        // Restore the prototype chain. Subclassing Error under an ES5 target
        // leaves `instanceof` broken, and the closeout route decides between a
        // 409 and a 500 with exactly that check — so without this line a
        // reconciliation failure would surface as an opaque server error rather
        // than the diagnosable refusal it is meant to be. Caught by test, not by
        // inspection.
        Object.setPrototypeOf(this, CloseoutReconciliationError.prototype);
        this.name = 'CloseoutReconciliationError';
        this.lineSum = lineSum;
        this.grossSales = grossSales;
        this.detail = detail;
    }
}

/**
 * The hard gate: an invoice whose bundle tally disagrees with its own total is
 * not a document anyone can act on, so closeout REFUSES rather than emitting a
 * plausible-looking one.
 *
 * This is not hypothetical. Production contains an active campaign order with a
 * $125.00 total and no order items at all, which would otherwise produce an
 * invoice whose lines sum to $0 while claiming $125 of sales. `offenders` names
 * the specific orders so the data can actually be repaired.
 */
export function assertLinesReconcile(
    lines: AggregatedLine[],
    grossSales: number,
    offenders: Array<{ orderId: string; orderTotal: number; lineSum: number }> = [],
): void {
    const lineSum = sumLineTotals(lines);
    const gross = roundCents(grossSales);
    if (Math.abs(lineSum - gross) < 0.005) return;

    const detail = offenders.length
        ? `Orders whose own items do not match their total: ${offenders
            .map((o) => `${o.orderId} (total $${o.orderTotal.toFixed(2)}, items $${o.lineSum.toFixed(2)})`)
            .join('; ')}`
        : 'No single order could be identified as the cause; inspect this campaign\'s order items.';

    throw new CloseoutReconciliationError(lineSum, gross, detail);
}
