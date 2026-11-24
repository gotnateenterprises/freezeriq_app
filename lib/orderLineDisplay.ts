/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S3) — the ONE way a fundraiser order line is described to a person.
 *
 * An order line is a MAIN meal-bundle line or the campaign's ADD-ON line (`item_role`, decided by the
 * server when the order was written — lib/campaignAddOns.ts). An add-on line is stored with
 * variant_size 'serves_5' because that column is a NOT NULL enum (and multiplier 1 keeps kitchen math
 * unchanged), but it is NOT a Serves 5 / Family Size meal and must never be described as one:
 *
 *     main    "Comfort Foods — Serves 5 ×1"            size from the line's own variant_size
 *     add-on  "Sides & Dessert Bundle (Add-On) ×2"     no serving size, ever
 *
 * Every surface that prints or counts order lines — coordinator portal, pickup tracker and
 * spreadsheet, box labels, packing slips, kitchen views, emails, invoices, QuickBooks — asks this
 * module instead of re-deriving the rule, so the add-on label cannot drift between them.
 *
 * Display only. Quantities, prices, multipliers and the kitchen engine are untouched; an add-on's
 * dollars stay in every total. Pure and import-light: safe in client components.
 */

import { isAddOnItemRole } from './campaignAddOns';
import { servingTierLabel } from './mealLabel';

/** The size cell for an add-on line, wherever a serving size would otherwise appear. */
export const ADD_ON_SIZE_LABEL = 'Add-On';

export interface OrderLineLike {
    /** 'main' | 'addon'. Anything else (including missing, on rows written before S1) is a main line. */
    item_role?: string | null;
    variant_size?: string | null;
}

/** True only for a line whose stored role is exactly 'addon'. */
export function isAddOnLine(line: OrderLineLike | null | undefined): boolean {
    return isAddOnItemRole(line?.item_role);
}

/**
 * The size text for a line: "Add-On" for the add-on, otherwise the canonical serving label
 * ("Serves 5" / "Serves 2"), or null when the main line's size is unknown (omitted, never guessed).
 */
export function orderLineSizeLabel(line: OrderLineLike | null | undefined): string | null {
    if (isAddOnLine(line)) return ADD_ON_SIZE_LABEL;
    return servingTierLabel(line?.variant_size ?? null);
}

/**
 * The add-on's display name: its bundle name plus "(Add-On)", unless the name already says it is an
 * add-on ("Holiday Pie Add-On" stays as it is rather than becoming "Holiday Pie Add-On (Add-On)").
 */
export function addOnDisplayName(name: string | null | undefined): string {
    const base = (name ?? '').trim() || 'Add-On';
    return /\badd[\s-]?on\b/i.test(base) ? base : `${base} (Add-On)`;
}

/** A line's name as shown: the add-on gets its "(Add-On)" marker; a main line is unchanged. */
export function orderLineDisplayName(line: OrderLineLike & { name?: string | null }): string {
    const name = (line.name ?? '').trim();
    return isAddOnLine(line) ? addOnDisplayName(name) : name;
}

/**
 * One line of text:
 *   main    "Comfort Foods — Serves 5 ×1"  (size omitted when unknown: "Comfort Foods ×1")
 *   add-on  "Sides & Dessert Bundle (Add-On) ×2"
 */
export function formatOrderLine(
    line: OrderLineLike & { name?: string | null; quantity?: number | string | null },
): string {
    const qty = Number(line.quantity) || 0;
    const suffix = qty > 0 ? ` ×${qty}` : '';
    if (isAddOnLine(line)) return `${addOnDisplayName(line.name)}${suffix}`;
    const name = (line.name ?? '').trim() || 'Item';
    const size = servingTierLabel(line.variant_size ?? null);
    return `${name}${size ? ` — ${size}` : ''}${suffix}`;
}

/**
 * Splits lines into meal-bundle lines and add-on lines. Meal-bundle counts ("Total Sets", "Total
 * physical bundles", "N bundles") must be taken from `main` only; dollar totals from both.
 */
export function partitionOrderLines<T extends OrderLineLike>(lines: readonly T[] | null | undefined): { main: T[]; addOns: T[] } {
    const main: T[] = [];
    const addOns: T[] = [];
    for (const l of lines ?? []) (isAddOnLine(l) ? addOns : main).push(l);
    return { main, addOns };
}
