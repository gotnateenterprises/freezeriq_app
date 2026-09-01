/**
 * OPS-5 — the ONE allergen-detection authority for meal labels.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7 (meal/recipe labels
 * are a distinct system from customer outer-box labels). This module serves the
 * MEAL LABEL semantic only.
 *
 * WHY THIS EXISTS
 *
 * Before this module, FOUR separate inline keyword maps answered "which
 * allergens does this ingredient text contain?", and they disagreed:
 *
 *   app/production/print-batch/page.tsx      23 keywords
 *   components/production/ProductionCalculator.tsx  16 keywords
 *   app/labels/LabelsClient.tsx (recipe autoload)   28 keywords
 *   app/labels/LabelsClient.tsx (AUTO-DETECT button) 28 keywords
 *
 * The same physical meal therefore printed different allergen text depending on
 * which button the kitchen happened to press. "Shrimp scampi" declared
 * Shellfish from the Labels page and from print-batch, but NOTHING from
 * ProductionCalculator's batch print, which has no `shrimp` keyword at all.
 * `lactose`, `casein` and `half and half` were recognised only by the Labels
 * page. On a food label that is not a cosmetic inconsistency.
 *
 * THE VOCABULARY IS NOT INVENTED HERE
 *
 * It is the vocabulary the product already decided, recorded in
 * app/api/recipes/detect-allergens/route.ts:
 *
 *     // FreezerIQ confirmed-allergen categories (product decision: Dairy not
 *     // Milk, no Gluten)
 *     ALLERGEN_ALLOWLIST = Dairy, Eggs, Fish, Crustacean Shellfish, Tree Nuts,
 *                          Peanuts, Wheat, Soy, Sesame
 *
 * ...and enforced in that route's own prompt: "Do NOT return 'Gluten' as a
 * category. Wheat ingredients should return 'Wheat' only." The four keyword
 * maps predated that decision and emitted the pre-decision spellings —
 * "Gluten", "Peanut", "Egg", "Tree Nut", "Shellfish". So a single print batch
 * could show BOTH vocabularies at once: one recipe's stored, AI-classified
 * allergens saying "Peanuts, Wheat" beside another recipe's keyword-derived
 * allergens saying "Peanut, Gluten". This module ends that split by speaking
 * the decided vocabulary.
 *
 * NO KEYWORD WAS DROPPED
 *
 * KEYWORD_TO_ALLERGEN below is the strict UNION of all four previous maps.
 * Every keyword any of them recognised is still recognised here, and the
 * surfaces that were missing keywords gain them. Detection coverage strictly
 * increases; it never regresses. tests/ops5MealLabelHardening.test.ts pins that
 * union explicitly so a future edit cannot quietly delete an allergen class.
 *
 * WHAT THIS IS NOT
 *
 * NOT a replacement for app/api/recipes/detect-allergens/route.ts. That is a
 * different thing: a Gemini-backed classifier a tenant runs ONCE at recipe
 * authoring time, which understands compound ingredients ("BBQ Sauce" ->
 * reviewRequired) and writes a durable Recipe.allergens value. This module is
 * the LAST-RESORT fallback used at label-render time when a recipe has no
 * stored allergens at all. Stored Recipe.allergens always wins — see
 * resolveLabelAllergens below. The two are kept separate on purpose.
 *
 * NOT a diet-tag or recipe-category helper. Allergens, diet tags and categories
 * are different concepts and must not be merged into one list.
 *
 * NOT a safety guarantee. This is keyword assistance over an ingredient string.
 * It can only ever say what it recognised; it never asserts absence. Nothing
 * here emits "allergen free" or "safe for" language, and nothing should.
 */

/** The FreezerIQ confirmed-allergen categories. Product-decided; see header. */
export const ALLERGEN_CATEGORIES = [
    'Crustacean Shellfish',
    'Dairy',
    'Eggs',
    'Fish',
    'Peanuts',
    'Sesame',
    'Soy',
    'Tree Nuts',
    'Wheat',
] as const;

export type AllergenCategory = (typeof ALLERGEN_CATEGORIES)[number];

/**
 * Lower-case ingredient-text keyword -> allergen category.
 *
 * The strict UNION of the four maps this module replaces. Matching is a
 * case-insensitive substring test over the joined ingredient text, which is
 * exactly what every previous implementation did — preserved deliberately so
 * this is a consolidation, not a silent behaviour change.
 */
const KEYWORD_TO_ALLERGEN: Readonly<Record<string, AllergenCategory>> = Object.freeze({
    // Peanuts
    'peanut': 'Peanuts',
    // Soy
    'soy': 'Soy',
    // Wheat — "Gluten" was the pre-decision spelling; both keywords still
    // MATCH, they simply report the decided category now.
    'wheat': 'Wheat',
    'gluten': 'Wheat',
    // Eggs
    'egg': 'Eggs',
    // Fish
    'fish': 'Fish',
    // Crustacean Shellfish
    'shellfish': 'Crustacean Shellfish',
    'crab': 'Crustacean Shellfish',
    'lobster': 'Crustacean Shellfish',
    'shrimp': 'Crustacean Shellfish',
    // Tree Nuts
    'tree nut': 'Tree Nuts',
    'almond': 'Tree Nuts',
    'walnut': 'Tree Nuts',
    'cashew': 'Tree Nuts',
    'pecan': 'Tree Nuts',
    // Sesame
    'sesame': 'Sesame',
    // Dairy
    'milk': 'Dairy',
    'dairy': 'Dairy',
    'butter': 'Dairy',
    'cheese': 'Dairy',
    'cream': 'Dairy',
    'yogurt': 'Dairy',
    'half n half': 'Dairy',
    'half-n-half': 'Dairy',
    'half and half': 'Dairy',
    'whey': 'Dairy',
    'casein': 'Dairy',
    'lactose': 'Dairy',
});

/** Every keyword this authority recognises. Exported so tests can pin the union. */
export function allergenKeywords(): string[] {
    return Object.keys(KEYWORD_TO_ALLERGEN).sort();
}

/**
 * The allergen categories recognisable in a block of ingredient text.
 *
 * Returns a sorted, de-duplicated array. Never throws; a null/undefined/empty
 * input yields [] rather than an error, because a label render must not crash
 * on a recipe with no ingredient text.
 */
export function detectAllergens(ingredientText: string | null | undefined): AllergenCategory[] {
    if (!ingredientText || typeof ingredientText !== 'string') return [];
    const haystack = ingredientText.toLowerCase();
    const found = new Set<AllergenCategory>();
    for (const [keyword, category] of Object.entries(KEYWORD_TO_ALLERGEN)) {
        if (haystack.includes(keyword)) found.add(category);
    }
    return Array.from(found).sort();
}

/**
 * The same detection, rendered the way every previous implementation rendered
 * it: sorted categories joined with ", ". Empty string when nothing matched,
 * so a caller can use falsiness to decide whether to show an allergen block.
 *
 * Deliberately returns "" and NOT "None" / "Allergen free" for the empty case.
 * This detector cannot prove absence, and a label must never imply it can.
 */
export function detectAllergenText(ingredientText: string | null | undefined): string {
    return detectAllergens(ingredientText).join(', ');
}

/**
 * The allergen string a MEAL LABEL should print.
 *
 * PRECEDENCE, and why:
 *   1. The recipe's own stored `allergens` value, when present. That is the
 *      tenant's reviewed answer — typed by hand, or written by the Gemini
 *      classifier which understands compound ingredients this keyword matcher
 *      cannot. A human/AI review always outranks a substring match.
 *   2. Otherwise, keyword detection over the ingredient text.
 *
 * This is the precedence all four replaced implementations already used
 * (`recipe.allergens || detect(...)`). It is preserved exactly, and centralised
 * so the fallback half can no longer differ between surfaces.
 */
export function resolveLabelAllergens(
    storedRecipeAllergens: string | null | undefined,
    ingredientText: string | null | undefined,
): string {
    const stored = (storedRecipeAllergens ?? '').trim();
    if (stored) return stored;
    return detectAllergenText(ingredientText);
}
