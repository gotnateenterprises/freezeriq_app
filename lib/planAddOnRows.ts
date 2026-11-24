/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S4) — the Manual Planner's add-on rows.
 *
 * A campaign add-on line (e.g. a Sides & Dessert Bundle) is stored with variant_size 'serves_5' — the
 * column is a NOT NULL enum, and multiplier 1 keeps the kitchen math exactly as it is. The Manual Planner's
 * plan (KitchenEngine.generateProductionRun → assemblyTasks, keyed by recipe id + tier) therefore built the
 * add-on's recipes as 'serves_5' rows, and its meal labels printed "Serves 5" on add-on food.
 *
 * This module labels those rows without touching the engine or any quantity:
 *
 *   classifyPlanAssemblyRows   which manifest keys (recipe id + tier, the engine's own manifestKey) come
 *                              ONLY from add-on bundles ('addon'), or from add-on AND meal bundles ('mixed').
 *                              A key from meal bundles only is absent — those rows are unchanged.
 *   annotateAssemblyTasks      adds `addOn: true` / `addOnMixed: true` to the plan's rows. Nothing else.
 *   assemblyRowServingLabel    the label tier for a row: "Add-On" for add-on food, null for a mixed row
 *                              (the existing OPS-5 rule: omit a claim that cannot be proven rather than
 *                              guess), otherwise the row's own canonical "Serves 5" / "Serves 2".
 *
 * Bundle type is the tenant's own stored classification (bundles.bundle_type), read server-side and
 * tenant-scoped by /api/production/plan. An add-on bundle can only ever be sold as an add-on line
 * (lib/campaignAddOns.ts), so its type identifies its food. Pure; safe in client components.
 */

import { manifestKey, resolveManifestVariantSize } from './mealManifest';
import { servingTierLabel } from './mealLabel';
import { ADD_ON_SIZE_LABEL } from './orderLineDisplay';
import { ADD_ON_BUNDLE_TYPE, normalizeBundleType } from './campaignAddOns';

export interface PlanLineLike {
    bundle_id?: string | null;
    variant_size?: string | null;
}

export interface PlanBundleFact {
    id: string;
    serving_tier?: string | null;
    bundle_type?: unknown;
    contents?: Array<{ recipe_id?: string | null }> | null;
}

export type PlanRowAddOnKind = 'addon' | 'mixed';

export function classifyPlanAssemblyRows(
    lines: readonly PlanLineLike[],
    bundles: readonly PlanBundleFact[],
): Map<string, PlanRowAddOnKind> {
    const byId = new Map(bundles.map((b) => [b.id, b]));
    const sources = new Map<string, { addon: boolean; main: boolean }>();
    for (const line of lines) {
        const bundle = line?.bundle_id ? byId.get(line.bundle_id) : undefined;
        if (!bundle) continue;
        const isAddOn = normalizeBundleType(bundle.bundle_type) === ADD_ON_BUNDLE_TYPE;
        // The engine's own tier rule for the row this line builds (lib/kitchen_engine.ts step 2).
        const variant = resolveManifestVariantSize(line.variant_size ?? null, bundle.serving_tier ?? null);
        for (const c of bundle.contents ?? []) {
            if (!c?.recipe_id) continue;
            const key = manifestKey(c.recipe_id, variant);
            const s = sources.get(key) ?? { addon: false, main: false };
            if (isAddOn) s.addon = true; else s.main = true;
            sources.set(key, s);
        }
    }
    const out = new Map<string, PlanRowAddOnKind>();
    for (const [key, s] of sources) {
        if (s.addon && s.main) out.set(key, 'mixed');
        else if (s.addon) out.set(key, 'addon');
    }
    return out;
}

/** True when any line of the plan is an add-on bundle's line. */
export function planHasAddOnLine(lines: readonly PlanLineLike[], bundles: readonly PlanBundleFact[]): boolean {
    const addOnIds = new Set(bundles.filter((b) => normalizeBundleType(b.bundle_type) === ADD_ON_BUNDLE_TYPE).map((b) => b.id));
    return lines.some((l) => !!l?.bundle_id && addOnIds.has(l.bundle_id));
}

/** The plan's assembly rows with `addOn` / `addOnMixed` added where they apply. Quantities untouched. */
export function annotateAssemblyTasks<T extends Record<string, any>>(
    assemblyTasks: Record<string, T> | null | undefined,
    kinds: Map<string, PlanRowAddOnKind>,
): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [key, row] of Object.entries(assemblyTasks ?? {})) {
        const kind = kinds.get(key);
        out[key] = kind === 'addon' ? { ...row, addOn: true } : kind === 'mixed' ? { ...row, addOnMixed: true } : row;
    }
    return out;
}

/** The serving label a meal label prints for one assembly row. */
export function assemblyRowServingLabel(row: { variantSize?: string | null; addOn?: unknown; addOnMixed?: unknown } | null | undefined): string | null {
    if (row?.addOn === true) return ADD_ON_SIZE_LABEL;
    if (row?.addOnMixed === true) return null;
    return servingTierLabel(row?.variantSize ?? null);
}
