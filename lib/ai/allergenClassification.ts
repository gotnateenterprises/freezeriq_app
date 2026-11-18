/**
 * RECIPE-AI-RECOVERY-1 — the AI allergen answer: what we ask for, and what we will accept.
 *
 * app/api/recipes/detect-allergens used to pull the first `{…}` span out of the model's text with a
 * greedy regex, JSON.parse it, and then read `parsed.confirmed || []` without checking types. Two
 * consequences:
 *   - an answer cut off mid-object (Gemini 3 thinking tokens count against maxOutputTokens; the
 *     route allowed 500) could not parse, and the tenant got the "could not be parsed" fallback;
 *   - an answer that DID parse but had the wrong shape (a string where an array belongs, an item
 *     with no ingredient) was partly trusted anyway.
 *
 * Now the request carries an explicit JSON Schema (ALLERGEN_RESPONSE_SCHEMA), and the answer must
 * be EXACTLY one JSON object of the documented shape — optionally inside a single ```json fence,
 * which is the one wrapper models are known to add. No span extraction, no prose tolerance. Anything
 * else is a parse failure, and a parse failure never produces a confirmed allergen.
 *
 * The product rules are unchanged and still enforced here, after the schema, because a schema is a
 * request to the model and this is the check:
 *   - only the nine FreezerIQ categories survive (lib/allergens.ts ALLERGEN_CATEGORIES);
 *   - Milk and milk-derived names normalize to Dairy;
 *   - Gluten is never a category (it has no alias, so it is dropped);
 *   - compound ingredients stay in reviewRequired; nothing here promotes them to confirmed.
 */

import { ALLERGEN_CATEGORIES, type AllergenCategory } from '@/lib/allergens';

const ALLOWLIST: ReadonlySet<string> = new Set(ALLERGEN_CATEGORIES);

/**
 * The alias map the route already used, moved here unchanged so the rules live in one tested place.
 * No 'gluten' entry, deliberately: Gluten is not a FreezerIQ category and must not survive.
 */
const ALIASES: Readonly<Record<string, AllergenCategory>> = Object.freeze({
    // Dairy derivatives
    'milk': 'Dairy', 'cream': 'Dairy', 'heavy cream': 'Dairy',
    'heavy whipping cream': 'Dairy', 'sour cream': 'Dairy',
    'butter': 'Dairy', 'cheese': 'Dairy', 'yogurt': 'Dairy',
    'whey': 'Dairy', 'casein': 'Dairy', 'milk powder': 'Dairy',
    'dry milk': 'Dairy',
    // Egg variants
    'egg': 'Eggs',
    // Shellfish
    'shellfish': 'Crustacean Shellfish', 'crustacean': 'Crustacean Shellfish',
    // Nuts
    'peanut': 'Peanuts', 'tree nut': 'Tree Nuts', 'treenut': 'Tree Nuts',
    'tree nuts': 'Tree Nuts',
    // Soy variants
    'soybeans': 'Soy', 'soybean': 'Soy',
});

/** A model-supplied category → a FreezerIQ category, or null (dropped). */
export function normalizeAllergenCategory(raw: unknown): AllergenCategory | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    for (const allowed of ALLERGEN_CATEGORIES) {
        if (trimmed.toLowerCase() === allowed.toLowerCase()) return allowed;
    }
    return ALIASES[trimmed.toLowerCase()] ?? null;
}

/**
 * The response schema sent as generationConfig.responseJsonSchema. Categories are an enum of the
 * nine allowed names, so a schema-honoring model cannot even emit "Gluten" or "Milk" — the
 * normalizer above still runs, because honoring the schema is the model's job and checking it is ours.
 */
export const ALLERGEN_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        confirmed: {
            type: 'array',
            items: { type: 'string', enum: [...ALLERGEN_CATEGORIES] },
        },
        reviewRequired: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    ingredient: { type: 'string' },
                    possibleAllergens: { type: 'array', items: { type: 'string', enum: [...ALLERGEN_CATEGORIES] } },
                    reason: { type: 'string' },
                },
                required: ['ingredient', 'possibleAllergens', 'reason'],
                additionalProperties: false,
            },
        },
    },
    required: ['confirmed', 'reviewRequired'],
    additionalProperties: false,
} as const;

export interface ReviewItem {
    ingredient: string;
    possibleAllergens: AllergenCategory[];
    reason: string;
}

export type AllergenParseFailure = 'empty' | 'truncated' | 'invalid_json' | 'invalid_shape';

export type AllergenParseResult =
    | { ok: true; confirmed: AllergenCategory[]; reviewRequired: ReviewItem[]; droppedCategories: number }
    | { ok: false; reason: AllergenParseFailure };

/** Exactly one ```json … ``` (or ``` … ```) fence around the whole text — nothing before or after. */
const WHOLE_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse and validate the model's answer. `finishReason` is the candidate's; anything other than
 * STOP means the answer may be incomplete, and an incomplete answer is never trusted.
 */
export function parseAllergenResponse(text: string, finishReason = 'STOP'): AllergenParseResult {
    if (finishReason === 'MAX_TOKENS') return { ok: false, reason: 'truncated' };
    const trimmed = (text ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'empty' };

    const fenced = trimmed.match(WHOLE_FENCE);
    const body = fenced ? fenced[1].trim() : trimmed;

    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { ok: false, reason: 'invalid_json' };
    }

    // ── Shape: every field present with the right type, or nothing is trusted. ──
    if (!isPlainObject(parsed)) return { ok: false, reason: 'invalid_shape' };
    const { confirmed, reviewRequired } = parsed;
    if (!Array.isArray(confirmed) || !confirmed.every((c) => typeof c === 'string')) {
        return { ok: false, reason: 'invalid_shape' };
    }
    if (!Array.isArray(reviewRequired)) return { ok: false, reason: 'invalid_shape' };
    for (const item of reviewRequired) {
        if (!isPlainObject(item)
            || typeof item.ingredient !== 'string' || !item.ingredient.trim()
            || !Array.isArray(item.possibleAllergens) || !item.possibleAllergens.every((a) => typeof a === 'string')
            || typeof item.reason !== 'string') {
            return { ok: false, reason: 'invalid_shape' };
        }
    }

    // ── Rules: normalize to the nine categories, drop the rest, de-duplicate. ──
    let dropped = 0;
    const confirmedSet = new Set<AllergenCategory>();
    for (const raw of confirmed as string[]) {
        const c = normalizeAllergenCategory(raw);
        if (c) confirmedSet.add(c); else dropped++;
    }

    // One review entry per ingredient (case-insensitive), allergen lists merged.
    const byIngredient = new Map<string, ReviewItem>();
    for (const item of reviewRequired as { ingredient: string; possibleAllergens: string[]; reason: string }[]) {
        const allergens: AllergenCategory[] = [];
        for (const raw of item.possibleAllergens) {
            const c = normalizeAllergenCategory(raw);
            if (c) { if (!allergens.includes(c)) allergens.push(c); } else dropped++;
        }
        // A review item with no recognizable category says nothing actionable (current behavior).
        if (allergens.length === 0) continue;
        const ingredient = item.ingredient.trim();
        const key = ingredient.toLowerCase();
        const existing = byIngredient.get(key);
        if (existing) {
            for (const a of allergens) if (!existing.possibleAllergens.includes(a)) existing.possibleAllergens.push(a);
        } else {
            byIngredient.set(key, {
                ingredient,
                possibleAllergens: allergens,
                reason: item.reason.trim() || 'Compound ingredient; verify manufacturer label',
            });
        }
    }

    return {
        ok: true,
        confirmed: [...confirmedSet].sort(),
        reviewRequired: [...byIngredient.values()],
        droppedCategories: dropped,
    };
}
