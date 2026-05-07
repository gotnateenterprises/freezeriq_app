/**
 * Mock Data Fixtures for Calculation Engine Snapshot Tests
 *
 * These fixtures represent a controlled, deterministic dataset
 * that exercises the full multiplier chain:
 *   Ingredient Qty × Recipe Yield Multiplier × Bundle Content Qty × Serving Multiplier × Order Qty
 *
 * CONSTITUTION COMPLIANCE:
 *   LAW 1 — Recipes are the single source of truth for ingredient quantities
 *   LAW 2 — Multipliers stack, never replace
 *   LAW 7 — Every calculation is traceable
 *
 * DO NOT modify these fixtures without updating snapshots via `npx jest --updateSnapshot`
 */

import { Recipe } from '../../types';
import { DBAdapter } from '../../lib/kitchen_engine';

// ═══════════════════════════════════════════════════════════
// INGREDIENTS (referenced by child_item_id in recipe items)
// ═══════════════════════════════════════════════════════════

const ING_CHICKEN_BREAST = 'ing-001-chicken-breast';
const ING_OLIVE_OIL = 'ing-002-olive-oil';
const ING_SALT = 'ing-003-salt';
const ING_GARLIC = 'ing-004-garlic';
const ING_PORK_LOIN = 'ing-005-pork-loin';
const ING_BBQ_SAUCE = 'ing-006-bbq-sauce';
const ING_BROWN_SUGAR = 'ing-007-brown-sugar';
const ING_RICE = 'ing-008-rice';
const ING_SOY_SAUCE = 'ing-009-soy-sauce';
const ING_BROCCOLI = 'ing-010-broccoli';

// ═══════════════════════════════════════════════════════════
// RECIPES
// ═══════════════════════════════════════════════════════════

/** Simple recipe: 3 ingredients, yields 5 servings (family baseline) */
export const RECIPE_CHICKEN_TERIYAKI: Recipe = {
    id: 'rec-001-chicken-teriyaki',
    name: 'Chicken Teriyaki',
    type: 'menu_item',
    base_yield_qty: 5,
    base_yield_unit: 'servings',
    label_text: 'Contains: Soy',
    allergens: 'Soy',
    instructions: 'Marinate chicken. Grill. Serve over rice.',
    items: [
        {
            id: 'ri-001', parent_recipe_id: 'rec-001-chicken-teriyaki',
            child_item_id: ING_CHICKEN_BREAST, child_type: 'ingredient',
            name: 'Chicken Breast', quantity: 2.5, unit: 'lbs',
            cost_per_unit: 3.99, cost_unit: 'lbs',
            supplier_name: 'GFS', supplier_url: 'https://gfsstore.com',
            stock_quantity: 5,
        },
        {
            id: 'ri-002', parent_recipe_id: 'rec-001-chicken-teriyaki',
            child_item_id: ING_SOY_SAUCE, child_type: 'ingredient',
            name: 'Soy Sauce', quantity: 0.5, unit: 'cup',
            cost_per_unit: 0.15, cost_unit: 'cup',
            supplier_name: 'GFS', supplier_url: 'https://gfsstore.com',
            stock_quantity: 2,
        },
        {
            id: 'ri-003', parent_recipe_id: 'rec-001-chicken-teriyaki',
            child_item_id: ING_RICE, child_type: 'ingredient',
            name: 'Rice', quantity: 3, unit: 'cup',
            cost_per_unit: 0.50, cost_unit: 'cup',
            supplier_name: 'GFS', supplier_url: 'https://gfsstore.com',
            stock_quantity: 10,
        },
    ],
};

/** Medium recipe: 4 ingredients, yields 5 servings */
export const RECIPE_BBQ_PULLED_PORK: Recipe = {
    id: 'rec-002-bbq-pulled-pork',
    name: 'BBQ Pulled Pork',
    type: 'menu_item',
    base_yield_qty: 5,
    base_yield_unit: 'servings',
    allergens: null as any,
    instructions: 'Slow cook pork. Shred. Mix with sauce.',
    items: [
        {
            id: 'ri-004', parent_recipe_id: 'rec-002-bbq-pulled-pork',
            child_item_id: ING_PORK_LOIN, child_type: 'ingredient',
            name: 'Pork Loin', quantity: 4, unit: 'lbs',
            cost_per_unit: 4.29, cost_unit: 'lbs',
            supplier_name: 'GFS',
            stock_quantity: 0,
        },
        {
            id: 'ri-005', parent_recipe_id: 'rec-002-bbq-pulled-pork',
            child_item_id: ING_BBQ_SAUCE, child_type: 'ingredient',
            name: 'BBQ Sauce', quantity: 2, unit: 'cup',
            cost_per_unit: 0.75, cost_unit: 'cup',
            supplier_name: 'Amazon', supplier_url: 'https://amazon.com',
            stock_quantity: 0,
        },
        {
            id: 'ri-006', parent_recipe_id: 'rec-002-bbq-pulled-pork',
            child_item_id: ING_BROWN_SUGAR, child_type: 'ingredient',
            name: 'Brown Sugar', quantity: 0.25, unit: 'cup',
            cost_per_unit: 0.10, cost_unit: 'cup',
            supplier_name: 'GFS',
            stock_quantity: 3,
        },
        {
            id: 'ri-007', parent_recipe_id: 'rec-002-bbq-pulled-pork',
            child_item_id: ING_SALT, child_type: 'ingredient',
            name: 'Salt', quantity: 1, unit: 'tsp',
            cost_per_unit: 0.01, cost_unit: 'tsp',
            supplier_name: 'GFS',
            stock_quantity: 100,
        },
    ],
};

/** Simple recipe for side dish — used in mixed bundles */
export const RECIPE_GARLIC_BROCCOLI: Recipe = {
    id: 'rec-003-garlic-broccoli',
    name: 'Garlic Broccoli',
    type: 'prep',
    base_yield_qty: 5,
    base_yield_unit: 'servings',
    items: [
        {
            id: 'ri-008', parent_recipe_id: 'rec-003-garlic-broccoli',
            child_item_id: ING_BROCCOLI, child_type: 'ingredient',
            name: 'Broccoli', quantity: 2, unit: 'lbs',
            cost_per_unit: 1.99, cost_unit: 'lbs',
            supplier_name: 'GFS',
            stock_quantity: 0,
        },
        {
            id: 'ri-009', parent_recipe_id: 'rec-003-garlic-broccoli',
            child_item_id: ING_GARLIC, child_type: 'ingredient',
            name: 'Garlic', quantity: 4, unit: 'tsp',
            cost_per_unit: 0.05, cost_unit: 'tsp',
            supplier_name: 'GFS',
            stock_quantity: 20,
        },
        {
            id: 'ri-010', parent_recipe_id: 'rec-003-garlic-broccoli',
            child_item_id: ING_OLIVE_OIL, child_type: 'ingredient',
            name: 'Olive Oil', quantity: 2, unit: 'tbsp',
            cost_per_unit: 0.10, cost_unit: 'tbsp',
            supplier_name: 'Amazon',
            stock_quantity: 10,
        },
    ],
};

// ═══════════════════════════════════════════════════════════
// ALL RECIPES (used by DBAdapter.getAllRecipes)
// ═══════════════════════════════════════════════════════════

export const ALL_RECIPES: Recipe[] = [
    RECIPE_CHICKEN_TERIYAKI,
    RECIPE_BBQ_PULLED_PORK,
    RECIPE_GARLIC_BROCCOLI,
];

// ═══════════════════════════════════════════════════════════
// BUNDLE DEFINITIONS
// ═══════════════════════════════════════════════════════════

/** Single-recipe bundle: Chicken Teriyaki only */
export const BUNDLE_SIMPLE = 'bundle-001-simple';
const BUNDLE_SIMPLE_CONTENTS = [
    { recipe_id: 'rec-001-chicken-teriyaki', position: 1, quantity: 1 },
];

/** Multi-recipe bundle: Chicken Teriyaki + BBQ Pulled Pork */
export const BUNDLE_COMBO = 'bundle-002-combo';
const BUNDLE_COMBO_CONTENTS = [
    { recipe_id: 'rec-001-chicken-teriyaki', position: 1, quantity: 1 },
    { recipe_id: 'rec-002-bbq-pulled-pork', position: 2, quantity: 1 },
];

/** Full bundle: All 3 recipes */
export const BUNDLE_FULL = 'bundle-003-full';
const BUNDLE_FULL_CONTENTS = [
    { recipe_id: 'rec-001-chicken-teriyaki', position: 1, quantity: 1 },
    { recipe_id: 'rec-002-bbq-pulled-pork', position: 2, quantity: 1 },
    { recipe_id: 'rec-003-garlic-broccoli', position: 3, quantity: 1 },
];

/** Scaled bundle: Chicken Teriyaki × 2 portions */
export const BUNDLE_DOUBLE_CHICKEN = 'bundle-004-double-chicken';
const BUNDLE_DOUBLE_CHICKEN_CONTENTS = [
    { recipe_id: 'rec-001-chicken-teriyaki', position: 1, quantity: 2 },
];

// Bundle info lookup (for serving_tier)
const BUNDLE_INFO: Record<string, { serving_tier: string }> = {
    [BUNDLE_SIMPLE]: { serving_tier: 'family' },
    [BUNDLE_COMBO]: { serving_tier: 'family' },
    [BUNDLE_FULL]: { serving_tier: 'family' },
    [BUNDLE_DOUBLE_CHICKEN]: { serving_tier: 'family' },
};

// Bundle contents lookup
const BUNDLE_CONTENTS: Record<string, { recipe_id: string; position: number; quantity?: number | null }[]> = {
    [BUNDLE_SIMPLE]: BUNDLE_SIMPLE_CONTENTS,
    [BUNDLE_COMBO]: BUNDLE_COMBO_CONTENTS,
    [BUNDLE_FULL]: BUNDLE_FULL_CONTENTS,
    [BUNDLE_DOUBLE_CHICKEN]: BUNDLE_DOUBLE_CHICKEN_CONTENTS,
};

// ═══════════════════════════════════════════════════════════
// MOCK DB ADAPTER
// ═══════════════════════════════════════════════════════════

/**
 * Creates a deterministic mock DBAdapter for snapshot tests.
 * Returns the same data every time — no database, no network.
 */
export function createMockDBAdapter(): DBAdapter {
    const recipeMap = new Map(ALL_RECIPES.map(r => [r.id, r]));

    return {
        async getRecipe(id: string) {
            return recipeMap.get(id) || null;
        },
        async getAllRecipes() {
            return ALL_RECIPES;
        },
        async getBundleContents(bundleId: string) {
            return BUNDLE_CONTENTS[bundleId] || [];
        },
        async getBundleInfo(bundleId: string) {
            return BUNDLE_INFO[bundleId] || null;
        },
    };
}
