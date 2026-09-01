/**
 * OPS-5 — meal-label truth rules.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7. A MEAL label
 * identifies the FOOD. It is not the customer outer-box label, and it carries
 * no supporter identity — no name, no email, no phone, no address. Nothing in
 * this module accepts or emits any of those.
 *
 * WHY THIS EXISTS
 *
 * A physical food label is not an ordinary UI card. A card that renders
 * "Ingredients loading..." for 300ms is a non-event; a LABEL that renders it is
 * a printed, adhesive, on-the-food falsehood that outlives the request that
 * produced it.
 *
 * app/production/print-batch/page.tsx did exactly that. Its label props read:
 *
 *     ingredients: detail.processedIngredients || "Ingredients loading...",
 *
 * and that expression fed the PRINT block, not just the preview. The recipe
 * fetch that populates `detail` swallowed its own failure (`catch { console.error }`)
 * without recording it, and the loading flag cleared unconditionally once the
 * fetch settled — so a failed fetch left the Print button enabled and the
 * literal string "Ingredients loading..." on every physical label for that
 * meal. No error, no warning, no way for the kitchen to tell.
 *
 * THE RULE
 *
 *   Required food data is FAIL CLOSED. If ingredients are required by the label
 *   format and could not be loaded, printing STOPS and says which meal failed.
 *   Optional decoration (a tenant logo) is FAIL OPEN — a missing logo must
 *   never halt a kitchen.
 *
 * We do not fabricate ingredients, and we do not silently drop the ingredient
 * section either: an empty section on a label that normally lists ingredients
 * reads as "confirmed: no ingredients", which is its own falsehood.
 */

/**
 * Strings that must never reach a printed label.
 *
 * The first four are the transitional/error placeholders this codebase has
 * actually produced. The rest are the JavaScript stringification accidents that
 * reach a DOM when an undefined or object value is interpolated — the classic
 * way a "[object Object]" ends up laminated to a tray of food.
 *
 * Compared case-insensitively against the TRIMMED candidate value.
 */
export const FORBIDDEN_LABEL_VALUES: readonly string[] = Object.freeze([
    'ingredients loading...',
    'ingredients loading',
    'loading...',
    'loading',
    'undefined',
    'null',
    '[object object]',
    'nan',
    'error',
    'failed to load',
]);

/**
 * True when a candidate value must not be printed.
 *
 * Empty/whitespace-only counts as unsafe for any REQUIRED field: the caller
 * decides whether a given field is required, but a blank required field is
 * never printable.
 */
export function isUnsafeLabelValue(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'string') return true;
    const trimmed = value.trim();
    if (!trimmed) return true;
    return FORBIDDEN_LABEL_VALUES.includes(trimmed.toLowerCase());
}

export type LabelFieldResult =
    | { ok: true; text: string }
    | { ok: false; reason: string };

/**
 * Resolve the ingredient text for one meal label, fail-closed.
 *
 * `loaded` is what the recipe fetch produced for this meal — undefined when the
 * fetch failed or was never attempted. There is deliberately no fallback
 * string: a caller that cannot supply real ingredients gets `ok: false` and
 * must stop, not a placeholder it can accidentally print.
 */
export function resolveLabelIngredients(
    mealName: string,
    loaded: string | null | undefined,
): LabelFieldResult {
    if (isUnsafeLabelValue(loaded)) {
        return {
            ok: false,
            reason: `Unable to load ingredients for ${mealName || 'this meal'}. `
                + 'Printing has been stopped so an incomplete food label is not produced.',
        };
    }
    return { ok: true, text: (loaded as string).trim() };
}

/** One queued label, reduced to just what the print gate needs to judge it. */
export interface GateableLabel {
    /** Recipe id — de-duplicates repeated meals in one batch. */
    id: string;
    /** Meal name, used to name the offender in the operator's error. */
    name: string;
}

export interface BlockedLabel {
    id: string;
    name: string;
    reason: string;
}

/**
 * The fail-closed print gate, as a pure function so it can be tested for real
 * rather than grepped for.
 *
 * Returns one entry per DISTINCT meal whose required food data is missing. An
 * empty array means every queued label is printable.
 *
 * `ingredientsRequired` is the caller's judgement about the CURRENT label
 * format — the 2.25x1.25 and 4x6 layouts never render an ingredient list, so
 * blocking them on ingredient data would be a kitchen stoppage for data they do
 * not use (Part H). When false, this gate passes everything.
 *
 * `ingredientsById` is what the recipe fetch actually produced. A missing key
 * means the fetch failed or never ran — which is exactly the case that used to
 * print "Ingredients loading..." onto food.
 */
export function collectBlockedLabels(
    items: readonly GateableLabel[],
    ingredientsById: Readonly<Record<string, string | null | undefined>>,
    ingredientsRequired: boolean,
): BlockedLabel[] {
    if (!ingredientsRequired) return [];
    const seen = new Set<string>();
    const blocked: BlockedLabel[] = [];
    for (const item of items || []) {
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        const check = resolveLabelIngredients(item.name, ingredientsById?.[item.id]);
        if (!check.ok) blocked.push({ id: item.id, name: item.name, reason: check.reason });
    }
    return blocked;
}

/**
 * The serving tier as a customer-readable meal-label phrase.
 *
 * Accepts ONLY the canonical VariantSize vocabulary that OPS-4/OPS-4A already
 * resolved authoritatively upstream — `serves_5` from a sold OrderItem
 * snapshot, or from a manual row's tenant-scoped Bundle.serving_tier. This
 * function deliberately does NOT normalise free text and does NOT consult a
 * Bundle: doing either would make printing a THIRD serving-tier authority,
 * which the OPS-5 contract forbids. Anything it does not recognise returns
 * null, and a null tier is omitted from the label rather than guessed.
 */
export function servingTierLabel(variantSize: string | null | undefined): string | null {
    if (variantSize === 'serves_5') return 'Serves 5';
    if (variantSize === 'serves_2') return 'Serves 2';
    return null;
}

/**
 * The single serving tier a whole production plan can truthfully claim, or null
 * when it cannot claim one.
 *
 * WHY PLAN-LEVEL, AND WHY null FOR MIXED
 *
 * KitchenEngine's prepTasks — the source the print batch is built from — are
 * keyed by RECIPE NAME alone (lib/kitchen_engine.ts, prepTasks.set(recipe.name, ...)).
 * A Serves-5 line and a Serves-2 line for the SAME recipe therefore merge into
 * ONE entry whose qty is an ingredient-scaled aggregate, not a per-tier meal
 * count. Once merged, no per-recipe tier can be recovered downstream.
 *
 * So: when every line in the plan shares one tier, every meal in that batch
 * genuinely IS that tier and the label may say so. When the plan mixes tiers,
 * the merge has already destroyed the attribution and ANY tier printed on the
 * merged meal would be false for some of it. We return null, the label omits
 * the tier rather than inventing one, and the UI tells the operator to plan the
 * tiers separately if they need per-tier labels.
 *
 * Conservative by construction: it never claims a tier it cannot prove.
 */
export function planServingTier(variantSizes: readonly (string | null | undefined)[]): string | null {
    const distinct = new Set<string>();
    for (const v of variantSizes || []) {
        const label = servingTierLabel(v);
        // An unrecognised/absent tier makes the plan unprovable, not ignorable.
        if (!label) return null;
        distinct.add(label);
    }
    if (distinct.size !== 1) return null;
    return [...distinct][0];
}
