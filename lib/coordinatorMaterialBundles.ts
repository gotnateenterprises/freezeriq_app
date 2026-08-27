/**
 * FR-COORD-123 — the ONE bundle/price authority for coordinator marketing
 * materials (flyer, packet, QR, promo scripts).
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * The printable flyer showed Family Size at the Serves-2 price. Each material
 * route passed `bundles.serving_tier` RAW into its renderer, and the renderer
 * recognized exactly one string — 'couple' — as the small tier. But the
 * canonical stored value for the small variant is 'serves_2' (written by the
 * CB-1 duplicate-serves-2 route, required by the CB-5 ordering validator), so
 * on every modern campaign the Serves-2 sibling fell into the family branch
 * and OVERWROTE the family price. Edgar-adjacent example, live in Production:
 * "Fall 2026 - Family Friendly" $125 family / $60 serves_2 printed as
 * "Family Size: $60.00" with no Serves-2 line at all.
 *
 * ── WHY THIS MODULE, NOT A FIX IN EACH ROUTE ────────────────────────────────
 *
 * Four routes carried the identical raw-passthrough (flyer/download,
 * flyer/generate, packet/download, promo-scripts). The same mistake four
 * times is a vocabulary authority problem, not four bugs. This module is that
 * authority: it classifies tiers with the SAME resolver the supporter
 * ordering path uses (normalizeStrictServingTier — the strict form, because a
 * printed price must never be a guess), and validates prices from the SAME
 * column the storefront charges from (bundles.price, per variant row —
 * see lib/pricing.ts buildBundlePriceMap and app/api/public/order).
 *
 * ── FAIL CLOSED, VISIBLY ────────────────────────────────────────────────────
 *
 * A bundle whose tier cannot be strictly resolved, or whose price is missing,
 * zero, or not a finite positive number, refuses the WHOLE material with an
 * error naming the offending bundle. The alternative each route used to take —
 * COALESCE(price, 0) and default-to-family — printed $0.00 and swapped sizes
 * on paper handed to real supporters. Paper cannot be hotfixed.
 */

import { normalizeStrictServingTier, type DbVariantSize } from '@/lib/serving_multipliers';

/** The raw row shape every material route selects from `bundles`. */
export interface MaterialBundleRow {
    id: string;
    name: string;
    /** Raw from SQL — Prisma Decimal, number, string, or null. NEVER pre-coalesced to 0. */
    price: unknown;
    serving_tier: string | null;
    family_id: string | null;
}

/** A bundle that is safe to print: canonical tier, validated positive price. */
export interface MaterialBundle {
    id: string;
    name: string;
    price: number;
    servingTier: DbVariantSize; // 'serves_2' | 'serves_5' — nothing else exists here
    familyId: string | null;
}

export type MaterialBundlesResult =
    | { ok: true; bundles: MaterialBundle[] }
    | { ok: false; code: 'unknown_serving_tier' | 'missing_price'; error: string };

/**
 * Classify and validate raw bundle rows for a printed/shared material.
 *
 * Tier: normalizeStrictServingTier — the exact vocabulary the CB-5 ordering
 * validator accepts ('family', 'couple', 'serves_2', … per DB_MAP), and like
 * CB-5 it never defaults an unrecognized tier. A tier the ordering path would
 * refuse to sell under is a tier this refuses to print under.
 *
 * Price: the storefront renders Number(bundles.price) and the order route
 * rejects null/<=0 before charging. A material printing what the supporter
 * cannot actually be charged is refused for the same reason.
 */
export function resolveMaterialBundles(rows: readonly MaterialBundleRow[]): MaterialBundlesResult {
    const out: MaterialBundle[] = [];

    for (const row of rows) {
        const tier = normalizeStrictServingTier(row.serving_tier);
        if (!tier) {
            return {
                ok: false,
                code: 'unknown_serving_tier',
                error: `Bundle "${row.name}" has serving size "${row.serving_tier ?? '(none)'}", `
                    + `which is not a recognized size. Set it to Family (serves_5) or `
                    + `Serves 2 (serves_2) in the bundle editor, then try again.`,
            };
        }

        // Number(null) is 0 and Number(Decimal) is the numeric value, so the
        // null/absent case must be tested BEFORE coercion or it prints as $0.
        const price = row.price === null || row.price === undefined ? NaN : Number(row.price);
        if (!Number.isFinite(price) || price <= 0) {
            return {
                ok: false,
                code: 'missing_price',
                error: `Bundle "${row.name}" has no valid price. Set its price in the `
                    + `bundle editor before generating supporter-facing materials.`,
            };
        }

        out.push({
            id: row.id,
            name: row.name,
            price,
            servingTier: tier,
            familyId: row.family_id ?? null,
        });
    }

    return { ok: true, bundles: out };
}

/**
 * One entry per MENU (bundle family), for materials that list bundles as text
 * lines rather than cards — promo scripts, the tracker.
 *
 * Grouped by family_id when present (the structural CB-1 sibling key), by
 * serving-suffix-stripped name otherwise (legacy rows predate family_id).
 * Without this, both size variants entered the scripts as separate "bundles"
 * and every menu was advertised twice.
 */
export interface MaterialMenu {
    /** The menu's display name — family variant's name, serving suffix stripped. */
    baseName: string;
    familyPrice: number | null;
    couplePrice: number | null;
}

/** Strips a trailing "(Serves …)" suffix — same rule generateFlyer applies. */
export function stripServingSuffix(value: string): string {
    return value.replace(/\s*\(serves\b[^)]*\)\s*$/i, '').trim();
}

export function groupMaterialMenus(bundles: readonly MaterialBundle[]): MaterialMenu[] {
    const menus = new Map<string, MaterialMenu>();

    for (const b of bundles) {
        const key = b.familyId ?? `name:${stripServingSuffix(b.name).toLowerCase()}`;
        let menu = menus.get(key);
        if (!menu) {
            menu = { baseName: stripServingSuffix(b.name), familyPrice: null, couplePrice: null };
            menus.set(key, menu);
        }
        if (b.servingTier === 'serves_2') {
            menu.couplePrice = b.price;
        } else {
            menu.familyPrice = b.price;
            // The family variant's name is the menu's name — its sibling's
            // carries the "(Serves 2)" suffix.
            menu.baseName = stripServingSuffix(b.name);
        }
    }

    return Array.from(menus.values());
}
