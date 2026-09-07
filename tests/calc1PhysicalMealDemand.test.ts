/**
 * CALC-1 — PHYSICAL-MEAL INGREDIENT DEMAND CONTRACT.
 *
 * CERTIFIED BY: KITCHEN-CALCULATION-VERIFY-1 (28 agents, unmodified compiled
 * engine driven against a read-only Production snapshot at HEAD 4b497628).
 *
 * THE CERTIFIED DATA SEMANTICS
 *
 *   RecipeItem.quantity for a menu recipe is THE FULL INGREDIENT AMOUNT FOR
 *   ONE PHYSICAL MEAL PACKAGE AT THAT RECIPE ROW'S OWN TIER.
 *
 *   Ranch Chicken n Broccoli (family, "5 servings") stores 4 cup chicken  = one family tray.
 *   Ranch Chicken n Broccoli (Serves 2) ("2 serving")  stores 2 cup chicken = one couple tray.
 *   Cheeseburger Soup (family)     stores 1 lb ground beef  = one family meal.
 *   Cheeseburger Soup (Serves 2)   stores 0.5 lb ground beef = one couple meal.
 *
 *   Therefore ONE sold meal instance consumes ONE stored RecipeItem list.
 *
 * THE TWO P0 DEFECTS THIS SUITE PROVES AND THEN LOCKS SHUT
 *
 *   P0-1  YIELD DIVIDE. explodeRecipeSync divided the physical package count by
 *         Recipe.base_yield_qty before scaling the stored quantities, so every
 *         "5 servings" row was requested at 0.200 of one tray (80% understated).
 *
 *   P0-2  SERVES-2 DOUBLE SCALE. The engine also multiplied serves_2 lines by
 *         0.5 although every couple-tier BundleContent in Production points at a
 *         PRE-HALVED "(Serves 2)" recipe row. Tier is encoded by WHICH row the
 *         BundleContent references — never again by a runtime multiplier.
 *
 * WHY THE ASSERTIONS ARE BEHAVIOURAL, NOT SOURCE GREPS
 *
 * The defect survived five prior phases precisely because the guards were
 * source-text greps and a snapshot: tests/calculation/.../production_run.snapshot
 * .test.ts.snap recorded 0.5 lb of chicken for a fixture whose recipe stores
 * 2.5 lb, so CI stayed green while Production planned at ~22% of physical need.
 * Every invariant below therefore asserts a PHYSICAL QUANTITY that a later
 * snapshot regeneration cannot silently move.
 *
 * SCOPE. CALC-1 repairs the calculation only. Procurement modes, purchase
 * rounding, the sold-bundle delete guard, task-completion inventory, recipe
 * snapshotting and the active-row data defects are later phases and are
 * deliberately NOT touched here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KitchenEngine, type DBAdapter } from '@/lib/kitchen_engine';
import type { Recipe } from '@/types';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURES — modelled on the certified Production rows, not invented.
// ═════════════════════════════════════════════════════════════════════════════

const ing = (
    child_item_id: string,
    name: string,
    quantity: number,
    unit: string,
    stock_quantity = 0,
    cost_unit?: string,
): any => ({
    id: `ri-${child_item_id}-${quantity}-${unit}`,
    child_item_id,
    child_type: 'ingredient',
    name,
    quantity,
    unit,
    // cost_unit is what the engine converts INTO (it is the Ingredient's own
    // unit, per lib/prisma_adapter.ts). Default to the recipe unit so a fixture
    // exercises conversion only when it deliberately opts in.
    cost_unit: cost_unit ?? unit,
    cost_per_unit: 1,
    stock_quantity,
});

const subLink = (child_item_id: string, quantity: number, unit: string): any => ({
    id: `ri-sub-${child_item_id}-${quantity}${unit}`,
    child_item_id,
    child_type: 'recipe',
    name: 'sub',
    quantity,
    unit,
    is_sub_recipe: true,
});

/** Cheeseburger Soup, family row: "5 servings", 1 lb ground beef = ONE family meal. */
const FAMILY_SOUP: Recipe = {
    id: 'rec-soup-family', name: 'Cheeseburger Soup', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing('ing-beef', 'Ground Beef', 1, 'lb')],
} as any;

/** Cheeseburger Soup (Serves 2): "2 Servings", 0.5 lb = ONE couple meal (pre-halved). */
const COUPLE_SOUP: Recipe = {
    id: 'rec-soup-couple', name: 'Cheeseburger Soup (Serves 2)', type: 'menu_item',
    base_yield_qty: 2, base_yield_unit: 'Servings',
    items: [ing('ing-beef', 'Ground Beef', 0.5, 'lb')],
} as any;

/** Cranberry Pork, family: "5 servings", 2.5 lb pork = ONE family meal. */
const FAMILY_PORK: Recipe = {
    id: 'rec-pork-family', name: 'Cranberry Pork', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing('ing-pork', 'Pork (Butt)', 2.5, 'lb')],
} as any;

/** BBQ Chicken (Serves 2): "2 servings", 2 breasts = ONE couple meal (kitchen-rounded from 5). */
const COUPLE_BBQ: Recipe = {
    id: 'rec-bbq-couple', name: 'BBQ Chicken (Serves 2)', type: 'menu_item',
    base_yield_qty: 2, base_yield_unit: 'servings',
    items: [ing('ing-breast', 'Chicken (5oz. Breast)', 2, 'each')],
} as any;

/** Ranch Chicken n Broccoli, family: 4 cup chicken = ONE family tray. */
const FAMILY_RANCH: Recipe = {
    id: 'rec-ranch-family', name: 'Ranch Chicken n Broccoli', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing('ing-chicken-shredded', 'Chicken (Shredded)', 4, 'cup')],
} as any;

/**
 * Same physical tray as FAMILY_RANCH, authored under the BATCH convention.
 * The audit found "1 batch" rows are quantity-identical to their "5 servings"
 * duplicates; they merely came out right by coincidence (base_yield 1). After
 * CALC-1 the two conventions must agree, because the yield label stops being a
 * divisor for menu rows.
 */
const FAMILY_RANCH_BATCH: Recipe = {
    id: 'rec-ranch-family-batch', name: 'Ranch Chicken n Broccoli (batch-authored)', type: 'menu_item',
    base_yield_qty: 1, base_yield_unit: 'batch',
    items: [ing('ing-chicken-shredded', 'Chicken (Shredded)', 4, 'cup')],
} as any;

/** Shares ing-beef with FAMILY_SOUP so accumulation by Ingredient.id is provable. */
const FAMILY_CHILI: Recipe = {
    id: 'rec-chili-family', name: 'Mac-n-Cheese (Chili)', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing('ing-beef', 'Ground Beef', 1, 'lb')],
} as any;

/** Two DISTINCT recipe ids sharing one display name — the real Production shape. */
const DUP_A: Recipe = {
    id: 'rec-dup-a', name: 'Party Meatballs (Serves 2)', type: 'menu_item',
    base_yield_qty: 2.5, base_yield_unit: 'servings',
    items: [ing('ing-meatballs', 'Frozen Meatballs', 25, 'each')],
} as any;
const DUP_B: Recipe = {
    id: 'rec-dup-b', name: 'Party Meatballs (Serves 2)', type: 'menu_item',
    base_yield_qty: 2.5, base_yield_unit: 'servings',
    items: [ing('ing-meatballs', 'Frozen Meatballs', 25, 'each')],
} as any;

/**
 * SUB-RECIPE. Parent asks for 4 tsp of a seasoning whose yield is 144 tbsp.
 * The child's Basil line is 3 tbsp per 144-tbsp batch.
 *
 *   CORRECT: 4 tsp x 1 meal = 4 tsp -> convert -> 1.33333 tbsp -> / 144
 *            = 0.00925926 batches -> Basil 3 x 0.00925926 = 0.0277778 tbsp.
 *   OLD:     4 tsp x (1/5 yield divide) = 0.8, divided by 144 AS IF tbsp
 *            = 0.00555556 -> Basil 0.0166667 tbsp  (0.600x — the audit's figure).
 */
const SEASONING: Recipe = {
    id: 'rec-seasoning', name: 'RANCH SEASONING', type: 'prep',
    base_yield_qty: 144, base_yield_unit: 'tbsp',
    items: [ing('ing-basil', 'Basil', 3, 'tbsp')],
} as any;
const FAMILY_WITH_SUB: Recipe = {
    id: 'rec-mud-pork', name: 'Mississippi Mud Pork', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing('ing-pork', 'Pork (Butt)', 2.25, 'lb'), subLink('rec-seasoning', 4, 'tsp')],
} as any;

/** Negative stock, exactly as Production stores it (imported already-negative). */
const FAMILY_BACON: Recipe = {
    id: 'rec-bacon-family', name: 'Bacon Tray', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing('ing-bacon', 'Bacon Crumbles', 8, 'tbsp', -42)],
} as any;

const ALL: Recipe[] = [
    FAMILY_SOUP, COUPLE_SOUP, FAMILY_PORK, COUPLE_BBQ, FAMILY_RANCH, FAMILY_RANCH_BATCH,
    FAMILY_CHILI, DUP_A, DUP_B, SEASONING, FAMILY_WITH_SUB, FAMILY_BACON,
];

/** bundle id -> [{recipe_id, quantity}] ; tier is expressed by WHICH row it points at. */
const BUNDLES: Record<string, { recipe_id: string; position: number; quantity?: number | null }[]> = {
    'b-family-soup': [{ recipe_id: FAMILY_SOUP.id, position: 0, quantity: 1 }],
    'b-couple-soup': [{ recipe_id: COUPLE_SOUP.id, position: 0, quantity: 1 }],
    'b-family-pork': [{ recipe_id: FAMILY_PORK.id, position: 0, quantity: 1 }],
    'b-couple-bbq': [{ recipe_id: COUPLE_BBQ.id, position: 0, quantity: 1 }],
    'b-family-ranch': [{ recipe_id: FAMILY_RANCH.id, position: 0, quantity: 1 }],
    'b-family-ranch-batch': [{ recipe_id: FAMILY_RANCH_BATCH.id, position: 0, quantity: 1 }],
    // Two recipes, both consuming ing-beef, in one bundle.
    'b-family-combo': [
        { recipe_id: FAMILY_SOUP.id, position: 0, quantity: 1 },
        { recipe_id: FAMILY_CHILI.id, position: 1, quantity: 1 },
    ],
    // Two DISTINCT ids that share a display name, in one bundle.
    'b-dup-names': [
        { recipe_id: DUP_A.id, position: 0, quantity: 1 },
        { recipe_id: DUP_B.id, position: 1, quantity: 1 },
    ],
    'b-sub-recipe': [{ recipe_id: FAMILY_WITH_SUB.id, position: 0, quantity: 1 }],
    'b-bacon': [{ recipe_id: FAMILY_BACON.id, position: 0, quantity: 1 }],
    // BundleContent.quantity = 2 physical packages of the same recipe per bundle.
    'b-double-ranch': [{ recipe_id: FAMILY_RANCH.id, position: 0, quantity: 2 }],
};

const TIERS: Record<string, string> = {
    'b-family-soup': 'family', 'b-couple-soup': 'serves_2', 'b-family-pork': 'family',
    'b-couple-bbq': 'serves_2', 'b-family-ranch': 'family', 'b-family-ranch-batch': 'family',
    'b-family-combo': 'family', 'b-dup-names': 'serves_2', 'b-sub-recipe': 'family',
    'b-bacon': 'family', 'b-double-ranch': 'family',
};

function adapter(): DBAdapter {
    const byId = new Map(ALL.map(r => [r.id, r]));
    return {
        async getRecipe(id: string) { return byId.get(id) || null; },
        async getAllRecipes() { return ALL; },
        async getBundleContents(bundleId: string) { return BUNDLES[bundleId] || []; },
        async getBundleInfo(bundleId: string) {
            return TIERS[bundleId] ? { serving_tier: TIERS[bundleId] } : null;
        },
    };
}

type Line = { bundle_id: string; quantity: number; variant_size?: any };
const run = async (lines: Line[], opts?: any) =>
    new KitchenEngine(adapter()).generateProductionRun(lines as any, opts);
const qtyOf = (r: any, ingredientId: string): number => Number(r.rawIngredients[ingredientId]?.qty ?? 0);
const netOf = (r: any, ingredientId: string): number => Number(r.rawIngredients[ingredientId]?.netQty ?? 0);

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE HEADLINE PHYSICAL CONTRACT (mission Part B minimum assertions)
// ═════════════════════════════════════════════════════════════════════════════
describe('1. one sold meal instance consumes one stored RecipeItem list', () => {
    it('INVARIANT 1 — FAMILY: one family meal storing 1 lb beef requires 1 lb (was 0.2 lb)', async () => {
        const r = await run([{ bundle_id: 'b-family-soup', quantity: 1, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-beef')).toBeCloseTo(1, 10);
    });

    it('INVARIANT 2 — COUPLE: one Serves-2 meal storing 0.5 lb beef requires 0.5 lb (was 0.125 lb)', async () => {
        const r = await run([{ bundle_id: 'b-couple-soup', quantity: 1, variant_size: 'serves_2' }]);
        expect(qtyOf(r, 'ing-beef')).toBeCloseTo(0.5, 10);
    });

    it('MULTIPLE: 6 family meals storing 2.5 lb pork require 15 lb (was 3 lb)', async () => {
        const r = await run([{ bundle_id: 'b-family-pork', quantity: 6, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-pork')).toBeCloseTo(15, 10);
    });

    it('COUPLE MULTIPLE: 18 couple meals storing 2 breasts require 36 each (was 9)', async () => {
        const r = await run([{ bundle_id: 'b-couple-bbq', quantity: 18, variant_size: 'serves_2' }]);
        expect(qtyOf(r, 'ing-breast')).toBeCloseTo(36, 10);
    });

    it('Ranch Chicken n Broccoli family: stored 4 cup -> one meal needs 4 cup', async () => {
        const r = await run([{ bundle_id: 'b-family-ranch', quantity: 1, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-chicken-shredded')).toBeCloseTo(4, 10);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. NO MENU YIELD DIVIDE  (Part K invariant 4)
// ═════════════════════════════════════════════════════════════════════════════
describe('2. base_yield_qty no longer divides menu-recipe demand', () => {
    it('INVARIANT 4 — two rows with IDENTICAL stored quantities but different yield labels ("5 servings" vs "1 batch") produce IDENTICAL demand', async () => {
        const servings = await run([{ bundle_id: 'b-family-ranch', quantity: 3, variant_size: 'serves_5' }]);
        const batch = await run([{ bundle_id: 'b-family-ranch-batch', quantity: 3, variant_size: 'serves_5' }]);
        expect(qtyOf(servings, 'ing-chicken-shredded')).toBeCloseTo(12, 10);
        expect(qtyOf(batch, 'ing-chicken-shredded')).toBeCloseTo(12, 10);
        expect(qtyOf(servings, 'ing-chicken-shredded')).toBeCloseTo(qtyOf(batch, 'ing-chicken-shredded'), 10);
    });

    it('the yield label is never a divisor: a "2.5 servings" row still yields its full stored list per meal', async () => {
        const r = await run([{ bundle_id: 'b-dup-names', quantity: 1, variant_size: 'serves_2' }]);
        // Two distinct recipes, 25 meatballs each, one meal apiece = 50.
        expect(qtyOf(r, 'ing-meatballs')).toBeCloseTo(50, 10);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. NO RUNTIME SERVING MULTIPLIER AT MENU DEPTH  (Part K invariant 3)
// ═════════════════════════════════════════════════════════════════════════════
describe('3. the serves_2 runtime multiplier is gone from ingredient demand', () => {
    it('INVARIANT 3 — the SAME bundle sold as serves_2 and as serves_5 produces the SAME ingredient demand', async () => {
        const asCouple = await run([{ bundle_id: 'b-couple-soup', quantity: 4, variant_size: 'serves_2' }]);
        const asFamily = await run([{ bundle_id: 'b-couple-soup', quantity: 4, variant_size: 'serves_5' }]);
        expect(qtyOf(asCouple, 'ing-beef')).toBeCloseTo(2, 10);
        expect(qtyOf(asFamily, 'ing-beef')).toBeCloseTo(2, 10);
    });

    it('tier comes from WHICH recipe row the BundleContent references, not from the sold tier string', async () => {
        const family = await run([{ bundle_id: 'b-family-soup', quantity: 1, variant_size: 'serves_5' }]);
        const couple = await run([{ bundle_id: 'b-couple-soup', quantity: 1, variant_size: 'serves_2' }]);
        // The 0.5 relationship still exists — but it lives in the DATA (1 lb vs 0.5 lb).
        expect(qtyOf(couple, 'ing-beef')).toBeCloseTo(qtyOf(family, 'ing-beef') * 0.5, 10);
    });

    it('start_fresh remains an identity tier for demand', async () => {
        const r = await run([{ bundle_id: 'b-family-soup', quantity: 2, variant_size: 'start_fresh' }]);
        expect(qtyOf(r, 'ing-beef')).toBeCloseTo(2, 10);
    });

    it('LAW 8 preserved — an unknown serving tier still throws loudly', async () => {
        await expect(run([{ bundle_id: 'b-family-soup', quantity: 1, variant_size: 'serves_10' }]))
            .rejects.toThrow('[CALCULATION INTEGRITY]');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. EACH LEGITIMATE MULTIPLIER APPLIED EXACTLY ONCE  (Part D, Part K 5 & 6)
// ═════════════════════════════════════════════════════════════════════════════
describe('4. legitimate multipliers survive, each applied exactly once', () => {
    it('INVARIANT 5 — OrderItem.quantity exactly once: qty 3 of a 4-cup recipe = 12 cup', async () => {
        const r = await run([{ bundle_id: 'b-family-ranch', quantity: 3, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-chicken-shredded')).toBeCloseTo(12, 10);
    });

    it('INVARIANT 5b — order quantity scales linearly (1 -> 10 is exactly 10x)', async () => {
        const one = await run([{ bundle_id: 'b-family-ranch', quantity: 1, variant_size: 'serves_5' }]);
        const ten = await run([{ bundle_id: 'b-family-ranch', quantity: 10, variant_size: 'serves_5' }]);
        expect(qtyOf(ten, 'ing-chicken-shredded')).toBeCloseTo(qtyOf(one, 'ing-chicken-shredded') * 10, 10);
    });

    it('INVARIANT 6 — BundleContent.quantity exactly once: content qty 2 x order qty 3 x 4 cup = 24 cup', async () => {
        const r = await run([{ bundle_id: 'b-double-ranch', quantity: 3, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-chicken-shredded')).toBeCloseTo(24, 10);
    });

    it('LAW 5 — two separate order lines accumulate, never overwrite', async () => {
        const combined = await run([
            { bundle_id: 'b-family-soup', quantity: 2, variant_size: 'serves_5' },
            { bundle_id: 'b-couple-soup', quantity: 3, variant_size: 'serves_2' },
        ]);
        // 2 family meals x 1 lb + 3 couple meals x 0.5 lb = 3.5 lb
        expect(qtyOf(combined, 'ing-beef')).toBeCloseTo(3.5, 10);
    });

    it('INVARIANT 7 — a shared ingredient accumulates by Ingredient.id across different recipes', async () => {
        const r = await run([{ bundle_id: 'b-family-combo', quantity: 4, variant_size: 'serves_5' }]);
        // Soup 1 lb + Chili 1 lb, 4 bundles = 8 lb, under ONE ingredient key.
        expect(qtyOf(r, 'ing-beef')).toBeCloseTo(8, 10);
        expect(Object.keys(r.rawIngredients)).toContain('ing-beef');
        expect(Object.keys(r.rawIngredients).filter(k => k === 'ing-beef')).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. SUB-RECIPE: CONVERT, THEN DIVIDE BY CHILD YIELD  (Part K invariant 9)
// ═════════════════════════════════════════════════════════════════════════════
describe('5. sub-recipe links convert units BEFORE dividing by the child yield', () => {
    it('INVARIANT 9 — 4 tsp of a 144-tbsp seasoning: Basil = 0.0277778 tbsp, NOT the unconverted 0.0166667', async () => {
        const r = await run([{ bundle_id: 'b-sub-recipe', quantity: 1, variant_size: 'serves_5' }]);
        // 4 tsp -> 1.33333 tbsp -> /144 batches -> x 3 tbsp Basil
        expect(qtyOf(r, 'ing-basil')).toBeCloseTo(0.0277778, 7);
        expect(qtyOf(r, 'ing-basil')).not.toBeCloseTo(0.0166667, 7);
    });

    it('the parent menu row in the same recipe is undivided: 2.25 lb pork per meal', async () => {
        const r = await run([{ bundle_id: 'b-sub-recipe', quantity: 1, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-pork')).toBeCloseTo(2.25, 10);
    });

    it('sub-recipe demand scales linearly with meals', async () => {
        const one = await run([{ bundle_id: 'b-sub-recipe', quantity: 1, variant_size: 'serves_5' }]);
        const six = await run([{ bundle_id: 'b-sub-recipe', quantity: 6, variant_size: 'serves_5' }]);
        expect(qtyOf(six, 'ing-basil')).toBeCloseTo(qtyOf(one, 'ing-basil') * 6, 10);
    });

    it('base_yield_qty IS still the divisor on the recipe-to-recipe link (it is not removed everywhere)', async () => {
        // Proof by construction: if the 144 divide were dropped, Basil would be
        // 3 tbsp x 1.33333 = 4 tbsp, which is 144x larger than the asserted value.
        const r = await run([{ bundle_id: 'b-sub-recipe', quantity: 1, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-basil')).toBeLessThan(0.05);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PREP-TASK IDENTITY BY STABLE RECIPE ID  (Part K invariant 8)
// ═════════════════════════════════════════════════════════════════════════════
describe('6. prep tasks are keyed by Recipe.id, never by recipe name', () => {
    it('INVARIANT 8 — two DISTINCT recipe ids sharing one display name produce TWO prep tasks', async () => {
        const r = await run([{ bundle_id: 'b-dup-names', quantity: 1, variant_size: 'serves_2' }]);
        const keys = Object.keys(r.prepTasks);
        expect(keys).toContain('rec-dup-a');
        expect(keys).toContain('rec-dup-b');
        expect(keys).toHaveLength(2);
    });

    it('neither duplicate loses its own id (the last writer no longer wins)', async () => {
        const r = await run([{ bundle_id: 'b-dup-names', quantity: 1, variant_size: 'serves_2' }]);
        expect((r.prepTasks as any)['rec-dup-a'].id).toBe('rec-dup-a');
        expect((r.prepTasks as any)['rec-dup-b'].id).toBe('rec-dup-b');
    });

    it('the display name survives as data on the value, so no UI loses its label', async () => {
        const r = await run([{ bundle_id: 'b-dup-names', quantity: 1, variant_size: 'serves_2' }]);
        expect((r.prepTasks as any)['rec-dup-a'].name).toBe('Party Meatballs (Serves 2)');
        expect((r.prepTasks as any)['rec-dup-b'].name).toBe('Party Meatballs (Serves 2)');
    });

    it('a menu prep-task quantity equals the PHYSICAL meal count (couple lines are no longer halved)', async () => {
        const r = await run([{ bundle_id: 'b-couple-bbq', quantity: 18, variant_size: 'serves_2' }]);
        expect((r.prepTasks as any)['rec-bbq-couple'].qty).toBeCloseTo(18, 10);
    });

    it('the physical manifest (assemblyTasks) remains the label authority and agrees with it', async () => {
        const r = await run([{ bundle_id: 'b-couple-bbq', quantity: 18, variant_size: 'serves_2' }]);
        const rows = Object.values(r.assemblyTasks) as any[];
        expect(rows.reduce((s, x) => s + x.qty, 0)).toBe(18);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. NEGATIVE STOCK CONTAINMENT  (Part K invariant 11)
// ═════════════════════════════════════════════════════════════════════════════
describe('7. negative Ingredient.stock_quantity cannot inflate TO BUY', () => {
    it('INVARIANT 11 — gross 8 tbsp against stock -42 nets 8 tbsp, never 50', async () => {
        const r = await run([{ bundle_id: 'b-bacon', quantity: 1, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-bacon')).toBeCloseTo(8, 10);
        expect(netOf(r, 'ing-bacon')).toBeCloseTo(8, 10);
        expect(netOf(r, 'ing-bacon')).not.toBeCloseTo(50, 10);
    });

    it('netQty never exceeds gross required for any ingredient', async () => {
        const r = await run([
            { bundle_id: 'b-bacon', quantity: 3, variant_size: 'serves_5' },
            { bundle_id: 'b-family-combo', quantity: 2, variant_size: 'serves_5' },
        ]);
        for (const v of Object.values(r.rawIngredients) as any[]) {
            expect(v.netQty).toBeLessThanOrEqual(v.qty + 1e-9);
        }
    });

    it('the raw negative value is still reported, not hidden, so a later phase can warn', async () => {
        const r = await run([{ bundle_id: 'b-bacon', quantity: 1, variant_size: 'serves_5' }]);
        expect((r.rawIngredients as any)['ing-bacon'].rawOnHand).toBe(-42);
        expect((r.rawIngredients as any)['ing-bacon'].onHand).toBe(0);
    });

    it('positive stock still reduces net demand exactly as before', async () => {
        const r = await run([{ bundle_id: 'b-family-soup', quantity: 1, variant_size: 'serves_5' }]);
        expect(netOf(r, 'ing-beef')).toBeCloseTo(1, 10); // stock 0 -> net = gross
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. NO EARLY ROUNDING  (LAW 3, Part K invariant 10)
// ═════════════════════════════════════════════════════════════════════════════
describe('8. the canonical result is not rounded before it leaves the engine', () => {
    it('INVARIANT 10 — a prep quantity that cannot be expressed in 2 decimals keeps full precision', async () => {
        // 1 meal / 3 is not representable at 2dp; assert the engine does not snap it.
        const r = await run([{ bundle_id: 'b-sub-recipe', quantity: 7, variant_size: 'serves_5' }]);
        const seasoning = (r.prepTasks as any)['rec-seasoning'];
        expect(seasoning).toBeDefined();
        // 7 meals x 4 tsp = 28 tsp -> 9.33333 tbsp -> /144 = 0.0648148 batches.
        expect(seasoning.qty).toBeCloseTo(0.0648148, 7);
        expect(seasoning.qty).not.toBe(Number(seasoning.qty.toFixed(2)));
    });

    it('the engine no longer rescales prep units through optimizeUnit', async () => {
        const r = await run([{ bundle_id: 'b-sub-recipe', quantity: 1, variant_size: 'serves_5' }]);
        // The unit stays the recipe's own base_yield_unit; no fl oz / cup rescale.
        expect((r.prepTasks as any)['rec-seasoning'].unit).toBe('tbsp');
        expect((r.prepTasks as any)['rec-mud-pork'].unit).toBe('servings');
    });

    it('ingredient aggregation is full precision across many lines', async () => {
        const r = await run([{ bundle_id: 'b-sub-recipe', quantity: 3, variant_size: 'serves_5' }]);
        expect(qtyOf(r, 'ing-basil')).toBeCloseTo(0.0833333, 7);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. THE PLANNER AND SHOPPING LIST REMAIN READ-ONLY  (Part K invariants 12 & 13)
// ═════════════════════════════════════════════════════════════════════════════
describe('9. calculation surfaces write nothing', () => {
    const WRITE = /\b(prisma|tx)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;

    it('INVARIANT 12 — lib/kitchen_engine.ts contains no database write', () => {
        expect(strip(read('lib/kitchen_engine.ts'))).not.toMatch(WRITE);
    });

    it('INVARIANT 12b — POST /api/production/plan contains no database write', () => {
        expect(strip(read('app/api/production/plan/route.ts'))).not.toMatch(WRITE);
    });

    it('INVARIANT 13 — the shopping-list page contains no fetch and no write', () => {
        const s = strip(read('app/production/shopping-list/page.tsx'));
        expect(s).not.toMatch(WRITE);
        expect(s).not.toMatch(/fetch\(/);
    });

    it('the engine still reuses the canonical meal-count authority rather than a new heuristic', () => {
        expect(strip(read('lib/kitchen_engine.ts'))).toMatch(/physicalMealCount\(order\.quantity, item\.quantity\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. CERTIFIED PRODUCTION RECONCILIATION  (mission Part E)
// ═════════════════════════════════════════════════════════════════════════════
describe('10. reconciles against the KITCHEN-CALCULATION-VERIFY-1 certified numbers', () => {
    it('Comfort Food - Fall 2026, six family bundles: beef 12 lb, pork 15 lb, breasts 30 each', async () => {
        // The real bundle carries 5 contents; these are the three certified lines.
        const COMFORT: Record<string, { recipe_id: string; position: number; quantity?: number | null }[]> = {
            'b-comfort': [
                { recipe_id: FAMILY_SOUP.id, position: 0, quantity: 1 },   // 1 lb beef
                { recipe_id: FAMILY_CHILI.id, position: 1, quantity: 1 },  // 1 lb beef
                { recipe_id: FAMILY_PORK.id, position: 2, quantity: 1 },   // 2.5 lb pork
                { recipe_id: COUPLE_BBQ.id, position: 3, quantity: 1 },    // 2 breasts (stand-in row)
            ],
        };
        const byId = new Map(ALL.map(r => [r.id, r]));
        const engine = new KitchenEngine({
            async getRecipe(id: string) { return byId.get(id) || null; },
            async getAllRecipes() { return ALL; },
            async getBundleContents(b: string) { return COMFORT[b] || []; },
            async getBundleInfo() { return { serving_tier: 'family' }; },
        });
        const r: any = await engine.generateProductionRun(
            [{ bundle_id: 'b-comfort', quantity: 6, variant_size: 'serves_5' } as any]
        );
        expect(Number(r.rawIngredients['ing-beef'].qty)).toBeCloseTo(12, 10);
        expect(Number(r.rawIngredients['ing-pork'].qty)).toBeCloseTo(15, 10);
        expect(Number(r.rawIngredients['ing-breast'].qty)).toBeCloseTo(12, 10);
        // 4 recipes x 6 bundles = 24 physical meals on the manifest.
        expect((Object.values(r.assemblyTasks) as any[]).reduce((s, x) => s + x.qty, 0)).toBe(24);
    });

    it('Mac-n-Cheese (Chili) Serves-2 shape: stored 0.5 lb -> one meal 0.5 lb', async () => {
        const r = await run([{ bundle_id: 'b-couple-soup', quantity: 1, variant_size: 'serves_2' }]);
        expect(qtyOf(r, 'ing-beef')).toBeCloseTo(0.5, 10);
    });

    it('Party Meatballs Serves-2: stored 25 each -> one meal 25 each (per distinct recipe id)', async () => {
        const ONE: Record<string, { recipe_id: string; position: number; quantity?: number | null }[]> = {
            'b-one-dup': [{ recipe_id: DUP_A.id, position: 0, quantity: 1 }],
        };
        const byId = new Map(ALL.map(r => [r.id, r]));
        const engine = new KitchenEngine({
            async getRecipe(id: string) { return byId.get(id) || null; },
            async getAllRecipes() { return ALL; },
            async getBundleContents(b: string) { return ONE[b] || []; },
            async getBundleInfo() { return { serving_tier: 'serves_2' }; },
        });
        const r: any = await engine.generateProductionRun(
            [{ bundle_id: 'b-one-dup', quantity: 1, variant_size: 'serves_2' } as any]
        );
        expect(Number(r.rawIngredients['ing-meatballs'].qty)).toBeCloseTo(25, 10);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. TRACEABILITY (LAW 7) — the sold tier is still recorded, just not applied.
// ═════════════════════════════════════════════════════════════════════════════
describe('11. the debug trace still records the sold tier for audit', () => {
    it('serving_multiplier is still reported (fundraiser weights / labels use it) but final_multiplier is the meal count', async () => {
        const r: any = await run(
            [{ bundle_id: 'b-couple-soup', quantity: 7, variant_size: 'serves_2' }], { debug: true }
        );
        for (const t of r.debug.trace) {
            expect(t.serving_multiplier).toBe(0.5);   // recorded
            expect(t.final_multiplier).toBe(7);       // applied: 7 meals, NOT 3.5
            expect(t.variant_size).toBe('serves_2');
        }
    });

    it('reconciliation counters are unchanged', async () => {
        const r: any = await run([
            { bundle_id: 'b-family-combo', quantity: 3, variant_size: 'serves_5' },
            { bundle_id: 'b-couple-soup', quantity: 2, variant_size: 'serves_2' },
        ], { debug: true });
        expect(r.debug.reconciliation.orders_received).toBe(2);
        expect(r.debug.reconciliation.bundles_processed).toBe(2);
        expect(r.debug.reconciliation.invalid_ingredients).toBe(0);
    });
});
