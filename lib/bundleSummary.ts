/**
 * CLOSEOUT-BUNDLE-SUMMARY-1 — "what bundles and sizes did this fundraiser order?"
 *
 * PRESENTATION ONLY. This module never decides what was sold or what it cost.
 * It takes lines an existing authority already produced and arranges them as
 * one row per bundle + serving size:
 *
 *     closeout modal      the closeout response's own `lines` — the exact
 *                         aggregateBundleLines output the draft invoice froze
 *     invoices page       the invoice's frozen items, written by closeout and
 *                         never re-priced afterwards (INV-C leaves them alone)
 *     coordinator portal  the portal payload's FULL non-canceled order list,
 *                         through aggregateBundleLines for quantities only —
 *                         the coordinator is shown no prices
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  · Recompute a price. A row's sales figure is the SUM of the line totals it
 *    was handed, so a summary of an invoice can only ever add up to that
 *    invoice's own lines — and, through closeout's reconciliation gate
 *    (assertLinesReconcile), to the settlement gross.
 *  · Weight anything. Physical bundles are counted as sold. The weighted goal
 *    measure has one authority (computeBundleUnitsFromItems, behind
 *    /api/campaigns) and this is not a second one.
 *  · Read an order. Every caller passes data it already holds.
 *
 * Pure, and client-safe: the three modules it imports have no imports of their own.
 */

import { aggregateBundleLines, roundCents, type AggregatedLine } from '@/lib/fundraiserCloseoutMath';
import { servingTierLabel } from '@/lib/mealLabel';
import { normalizeStrictServingTier } from '@/lib/serving_multipliers';

/** One already-totalled line, as an existing authority produced it. */
export interface BundleSummaryLine {
    bundleId: string | null;
    description: string;
    variantSize: string | null;
    quantity: number;
    /** The line's own total. Summed as given — never re-derived from a price. */
    total: number;
}

export interface BundleSummaryRow {
    /** Grouping key (bundle + canonical serving size). Not for display. */
    key: string;
    bundleName: string;
    /** 'Serves 5' | 'Serves 2', or null when the line carries no recognised size. */
    sizeLabel: string | null;
    quantity: number;
    sales: number;
}

export interface BundleSummary {
    rows: BundleSummaryRow[];
    /** Physical bundles: every unit counted once, whatever its serving size. */
    totalQuantity: number;
    totalSales: number;
}

export const UNNAMED_BUNDLE = 'Unnamed bundle';

/**
 * The serving size as a label, through the two existing serving-tier
 * authorities: normalizeStrictServingTier ('family' -> serves_5, and never a
 * guess for anything it does not recognise), then servingTierLabel
 * ('serves_5' -> 'Serves 5'). Unrecognised or absent -> null, never invented.
 */
export function bundleSizeLabel(variantSize: string | null | undefined): string | null {
    return servingTierLabel(normalizeStrictServingTier(variantSize));
}

const SERVES_MARKER = /\(\s*(serves\s*\d+)\s*\)/gi;
const EDGE_SEPARATORS = /^[\s\-–—:|,]+|[\s\-–—:|,]+$/g;
const compact = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/**
 * The bundle's name without a "(Serves N)" marker that only repeats the Size
 * column. Serves-2 bundles are commonly named "Family Friendly (Serves 2) -
 * Fall 2026"; with the size in its own column the row would say it twice.
 *
 * A marker that DISAGREES with the line's recorded size is kept: hiding it
 * would hide a naming problem rather than tidy one.
 */
export function bundleDisplayName(description: string | null | undefined, sizeLabel: string | null): string {
    const raw = String(description ?? '').trim();
    if (!raw) return UNNAMED_BUNDLE;
    if (!sizeLabel) return raw;

    let removed = false;
    const without = raw.replace(SERVES_MARKER, (whole: string, inner: string) => {
        if (compact(inner) !== compact(sizeLabel)) return whole;
        removed = true;
        return ' ';
    });
    if (!removed) return raw;

    const cleaned = without.replace(/\s{2,}/g, ' ').replace(EDGE_SEPARATORS, '').trim();
    return cleaned || raw;
}

/** Serves 5 before Serves 2, unrecognised sizes last — the order a menu reads in. */
function sizeRank(label: string | null): number {
    if (label === 'Serves 5') return 0;
    if (label === 'Serves 2') return 1;
    return 2;
}

/**
 * Collapse already-totalled lines into ONE row per bundle + serving size.
 *
 * Grouped by bundle id when the line has one (a renamed bundle stays one row),
 * by its display name otherwise. Two lines of the same bundle and size at
 * different unit prices — which aggregateBundleLines deliberately keeps apart,
 * so no averaged price is ever printed — become one row here whose sales are
 * the SUM of both line totals. No unit price is shown, so none is invented.
 */
export function summarizeBundleLines(lines: readonly BundleSummaryLine[] | null | undefined): BundleSummary {
    const byKey = new Map<string, BundleSummaryRow>();

    for (const line of lines ?? []) {
        if (!line) continue;
        const quantity = Number(line.quantity) || 0;
        const total = roundCents(Number(line.total) || 0);
        // Neither a unit nor a cent: nothing to show.
        if (quantity === 0 && total === 0) continue;

        const sizeLabel = bundleSizeLabel(line.variantSize);
        const bundleName = bundleDisplayName(line.description, sizeLabel);
        const sizeKey = normalizeStrictServingTier(line.variantSize) ?? `raw:${line.variantSize ?? ''}`;
        const bundleKey = line.bundleId ? `bundle:${line.bundleId}` : `name:${bundleName.toLowerCase()}`;
        const key = `${bundleKey}|${sizeKey}`;

        const row = byKey.get(key);
        if (row) {
            row.quantity += quantity;
            row.sales = roundCents(row.sales + total);
        } else {
            byKey.set(key, { key, bundleName, sizeLabel, quantity, sales: total });
        }
    }

    const rows = [...byKey.values()].sort((a, b) =>
        a.bundleName.localeCompare(b.bundleName, 'en-US', { sensitivity: 'base' })
        || sizeRank(a.sizeLabel) - sizeRank(b.sizeLabel)
        || a.key.localeCompare(b.key));

    return {
        rows,
        totalQuantity: rows.reduce((sum, r) => sum + r.quantity, 0),
        totalSales: roundCents(rows.reduce((sum, r) => sum + r.sales, 0)),
    };
}

/**
 * The closeout response's `lines`. Null when the response carried none — an
 * idempotent retry returns no lines — so the caller omits the section rather
 * than rebuilding one from anything else.
 */
export function bundleSummaryFromCloseoutLines(lines: readonly AggregatedLine[] | null | undefined): BundleSummary | null {
    if (!Array.isArray(lines)) return null;
    return summarizeBundleLines(lines.map((l) => ({
        bundleId: l?.bundleId ?? null,
        description: String(l?.description ?? ''),
        variantSize: l?.variantSize ?? null,
        quantity: Number(l?.quantity) || 0,
        total: Number(l?.total) || 0,
    })));
}

/** A frozen invoice item as GET /api/tenant/invoices returns it (Decimals arrive as strings). */
export interface FrozenInvoiceItem {
    bundle_id?: string | null;
    description?: string | null;
    variant_size?: string | null;
    quantity?: number | string | null;
    total?: number | string | null;
}

/** A fundraiser invoice's own frozen lines — what closeout wrote, not what the orders say today. */
export function bundleSummaryFromInvoiceItems(items: readonly FrozenInvoiceItem[] | null | undefined): BundleSummary {
    return summarizeBundleLines((items ?? []).map((it) => ({
        bundleId: it?.bundle_id ?? null,
        description: String(it?.description ?? ''),
        variantSize: it?.variant_size ?? null,
        quantity: Number(it?.quantity) || 0,
        total: Number(it?.total) || 0,
    })));
}

/** The fields of a coordinator-visible order the totals card reads. */
export interface SummaryOrder {
    canceled_at?: string | Date | null;
    items?: ReadonlyArray<{
        quantity?: number | string | null;
        variant_size?: string | null;
        item_name?: string | null;
        bundle_id?: string | null;
    } | null> | null;
}

/** Orders that count: a canceled order never contributes, whatever list it arrived in. */
export function activeSummaryOrders<T extends SummaryOrder>(orders: readonly (T | null | undefined)[] | null | undefined): T[] {
    return (orders ?? []).filter((o): o is T => Boolean(o) && !o!.canceled_at);
}

/**
 * Quantities for the coordinator portal, from the FULL order collection the
 * caller holds. The coordinator payload carries no prices, by design, and the
 * card shows none: aggregateBundleLines is reused for its quantity rules only
 * (the same coercion as closeout; non-positive quantities dropped).
 */
export function bundleSummaryFromSupporterOrders(orders: readonly (SummaryOrder | null | undefined)[] | null | undefined): BundleSummary {
    const lines = aggregateBundleLines(activeSummaryOrders(orders).flatMap((o) =>
        (o.items ?? []).filter(Boolean).map((it) => ({
            bundleId: it!.bundle_id ?? null,
            description: String(it!.item_name ?? ''),
            variantSize: it!.variant_size ?? null,
            quantity: Number(it!.quantity) || 0,
            unitPrice: 0,
        }))));
    return summarizeBundleLines(lines);
}

const isWholeDollars = (v: number) => Number.isInteger(roundCents(v));

/**
 * Whole dollars when every figure in the table is whole ("$1,750"); two
 * decimals for ALL of them otherwise, so one column never mixes "$1,750" with
 * "$1,320.50" — and a real $121.20 is never shown as "$121".
 */
export function bundleSummaryShowsCents(summary: BundleSummary): boolean {
    return summary.rows.some((r) => !isWholeDollars(r.sales)) || !isWholeDollars(summary.totalSales);
}

export function formatSummaryMoney(value: number, showCents: boolean): string {
    const digits = showCents ? 2 : 0;
    return '$' + roundCents(Number(value) || 0).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

/** One standalone amount: cents only when it has them. */
export function formatDollars(value: number): string {
    return formatSummaryMoney(value, !isWholeDollars(Number(value) || 0));
}

export function pluralCount(n: number, singular: string, plural: string): string {
    return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`;
}
