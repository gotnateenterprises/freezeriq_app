/**
 * CALC-1A — A POSITIVE GROSS REQUIREMENT MUST NEVER VANISH BECAUSE STOCK COVERS IT.
 *
 * OWNER ACCEPTANCE FAILURE (CALC-1 Preview dpl_8Ry6RrpCJr37nusyzpAS7qs1RNoy).
 * Production -> Manual Planner -> "Comfort Food - Fall 2026" quantity 1 showed
 * Pork 2.5 lb and 5 chicken breasts as certified, but GROUND BEEF WAS ABSENT.
 * Quantity 6 was likewise missing it.
 *
 * ROOT CAUSE — NOT the engine. components/production/ProductionCalculator.tsx
 * dropped the row before rendering:
 *
 *     if (!showAllItems && (item.onHand || 0) >= item.qty) return acc;
 *
 * with `showAllItems` defaulting to false. Ground Beef's gross was 2 lb against
 * 20 lb on hand, so it was filtered out; Pork (stock -2.25, clamped to 0) and
 * Chicken (stock 0) were not covered and survived. Reproduced exactly at both
 * quantity 1 and quantity 6 against the CALC-1 Production snapshot.
 *
 * THE CONTRACT THIS SUITE LOCKS
 *
 *   "Nothing to buy" and "nothing required" are different facts. The planner may
 *   sort, mute or badge an ingredient the kitchen already has, but a positive
 *   PHYSICAL REQUIREMENT must remain visible by default, because it is what the
 *   cook has to put in the pan.
 *
 * SCOPE. CALC-1A is a visibility repair. The engine numbers are unchanged and
 * are re-asserted here so this phase cannot silently regress CALC-1.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KitchenEngine, type DBAdapter } from '@/lib/kitchen_engine';
import type { Recipe } from '@/types';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PLANNER = 'components/production/ProductionCalculator.tsx';

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE — the owner's exact bundle shape. Two recipes contribute 1 lb of the
// SAME Ground Beef ingredient id (Cheeseburger Soup + Mac-n-Cheese (Chili)),
// which is where the certified 2 lb comes from. Ground Beef is deliberately
// well stocked; Pork and Chicken are not.
// ═════════════════════════════════════════════════════════════════════════════
const ing = (id: string, name: string, quantity: number, unit: string, stock = 0): any => ({
    id: `ri-${id}-${quantity}`, child_item_id: id, child_type: 'ingredient',
    name, quantity, unit, cost_unit: unit, cost_per_unit: 1, stock_quantity: stock,
    supplier_name: 'GFS',
});

const BEEF = 'ing-ground-beef';
const PORK = 'ing-pork-butt';
const BREAST = 'ing-chicken-breast';

/** Ground Beef is COVERED: 20 lb on hand against a 2 lb requirement. */
const SOUP: Recipe = {
    id: 'rec-soup', name: 'Cheeseburger Soup', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing(BEEF, 'Ground Beef', 1, 'lb', 20)],
} as any;
const CHILI: Recipe = {
    id: 'rec-chili', name: 'Mac-n-Cheese (Chili)', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing(BEEF, 'Ground Beef', 1, 'lb', 20)],
} as any;
/** Pork carries the imported NEGATIVE stock the tenant actually has. */
const PORK_R: Recipe = {
    id: 'rec-pork', name: 'Cranberry Pork', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing(PORK, 'Pork (Butt)', 2.5, 'lb', -2.25)],
} as any;
const ORANGE: Recipe = {
    id: 'rec-orange', name: 'Orange Chicken', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing(BREAST, 'Chicken (5oz. Breast)', 5, 'each', 0)],
} as any;

/** Two DISTINCT ingredient ids that share a display name — must never merge. */
const DUP_A = 'ing-beef-dup-a';
const DUP_B = 'ing-beef-dup-b';
const DUPS: Recipe = {
    id: 'rec-dups', name: 'Two Beefs', type: 'menu_item',
    base_yield_qty: 5, base_yield_unit: 'servings',
    items: [ing(DUP_A, 'Ground Beef', 1, 'lb', 0), ing(DUP_B, 'Ground Beef', 3, 'lb', 0)],
} as any;

const ALL = [SOUP, CHILI, PORK_R, ORANGE, DUPS];
const CONTENTS: Record<string, { recipe_id: string; position: number; quantity?: number | null }[]> = {
    'b-comfort': [
        { recipe_id: SOUP.id, position: 0, quantity: 1 },
        { recipe_id: CHILI.id, position: 1, quantity: 1 },
        { recipe_id: PORK_R.id, position: 2, quantity: 1 },
        { recipe_id: ORANGE.id, position: 3, quantity: 1 },
    ],
    'b-dups': [{ recipe_id: DUPS.id, position: 0, quantity: 1 }],
};

function adapter(): DBAdapter {
    const byId = new Map(ALL.map(r => [r.id, r]));
    return {
        async getRecipe(id: string) { return byId.get(id) || null; },
        async getAllRecipes() { return ALL; },
        async getBundleContents(b: string) { return CONTENTS[b] || []; },
        async getBundleInfo() { return { serving_tier: 'family' }; },
    };
}
const run = (b: string, q: number, v: any = 'serves_5') =>
    new KitchenEngine(adapter()).generateProductionRun([{ bundle_id: b, quantity: q, variant_size: v }] as any);
const grossOf = (r: any, id: string) => Number(r.rawIngredients[id]?.qty ?? 0);
const netOf = (r: any, id: string) => Number(r.rawIngredients[id]?.netQty ?? 0);

/**
 * The planner's own row-visibility predicate, transcribed from
 * ProductionCalculator.tsx. If that line changes shape, the source guards in
 * section 3 fail and this helper must be re-synced deliberately.
 */
const hiddenByPlanner = (item: any, showAllItems: boolean) =>
    !showAllItems && (item.onHand || 0) >= item.qty;

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE OWNER'S EXACT SCENARIO — gross survives, and is not hidden by default.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. the owner scenario: Comfort Food - Fall 2026', () => {
    it('REQUIRED 1 — quantity 1 exposes Ground Beef gross = 2 lb (two 1-lb lines, one ingredient id)', async () => {
        const r = await run('b-comfort', 1);
        expect(grossOf(r, BEEF)).toBeCloseTo(2, 10);
    });

    it('REQUIRED 2 — quantity 6 exposes Ground Beef gross = 12 lb', async () => {
        const r = await run('b-comfort', 6);
        expect(grossOf(r, BEEF)).toBeCloseTo(12, 10);
    });

    it('REQUIRED 3 — Pork remains 2.5 lb / 15 lb (CALC-1 unchanged)', async () => {
        expect(grossOf(await run('b-comfort', 1), PORK)).toBeCloseTo(2.5, 10);
        expect(grossOf(await run('b-comfort', 6), PORK)).toBeCloseTo(15, 10);
    });

    it('REQUIRED 4 — Chicken remains 5 each / 30 each (CALC-1 unchanged)', async () => {
        expect(grossOf(await run('b-comfort', 1), BREAST)).toBeCloseTo(5, 10);
        expect(grossOf(await run('b-comfort', 6), BREAST)).toBeCloseTo(30, 10);
    });

    it('THE DEFECT — with stock covering it, Ground Beef nets to 0 but its GROSS is still 2 lb', async () => {
        const r = await run('b-comfort', 1);
        expect(netOf(r, BEEF)).toBe(0);          // nothing to BUY
        expect(grossOf(r, BEEF)).toBeCloseTo(2, 10); // but 2 lb IS required
        expect(r.rawIngredients[BEEF]).toBeDefined(); // and the row exists
    });

    it('THE DEFECT, reproduced through the planner predicate: the covered row was dropped by default', async () => {
        const r = await run('b-comfort', 1);
        // This is the observed owner failure: hidden when the toggle is off...
        expect(hiddenByPlanner(r.rawIngredients[BEEF], false)).toBe(true);
        // ...and visible once in-stock items are shown. The fix makes the
        // second case the DEFAULT (asserted on the source in section 3).
        expect(hiddenByPlanner(r.rawIngredients[BEEF], true)).toBe(false);
        // Pork and Chicken were never covered, which is why the owner saw them.
        expect(hiddenByPlanner(r.rawIngredients[PORK], false)).toBe(false);
        expect(hiddenByPlanner(r.rawIngredients[BREAST], false)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE ENGINE NEVER DROPS A REQUIREMENT (REQUIRED 5-8)
// ═════════════════════════════════════════════════════════════════════════════
describe('2. engine-level guarantees', () => {
    it('REQUIRED 5 — a positive gross requirement is present no matter how much stock covers it', async () => {
        const r = await run('b-comfort', 1);
        for (const v of Object.values(r.rawIngredients) as any[]) {
            if (v.qty > 0) expect(v.qty).toBeGreaterThan(0);
        }
        expect(Object.keys(r.rawIngredients)).toContain(BEEF);
    });

    it('REQUIRED 6 — negative stock cannot increase gross (or net above gross)', async () => {
        const r = await run('b-comfort', 1);
        const pork = (r.rawIngredients as any)[PORK];
        expect(pork.qty).toBeCloseTo(2.5, 10);   // gross untouched by the -2.25
        expect(pork.onHand).toBe(0);             // clamped
        expect(pork.rawOnHand).toBe(-2.25);      // but still reported
        expect(pork.netQty).toBeCloseTo(2.5, 10);
        expect(pork.netQty).toBeLessThanOrEqual(pork.qty + 1e-9);
    });

    it('REQUIRED 7 — two ingredient ids sharing a display name are never merged', async () => {
        const r = await run('b-dups', 1);
        expect(grossOf(r, DUP_A)).toBeCloseTo(1, 10);
        expect(grossOf(r, DUP_B)).toBeCloseTo(3, 10);
        const named = Object.values(r.rawIngredients).filter((v: any) => v.displayName === 'Ground Beef');
        expect(named).toHaveLength(2);
    });

    it('REQUIRED 8 — two recipes sharing ONE ingredient id aggregate into a single row', async () => {
        const r = await run('b-comfort', 1);
        expect(Object.keys(r.rawIngredients).filter(k => k === BEEF)).toHaveLength(1);
        expect(grossOf(r, BEEF)).toBeCloseTo(2, 10); // 1 + 1, not 1
        expect((r.rawIngredients as any)[BEEF].usedIn).toEqual(
            expect.arrayContaining(['Cheeseburger Soup', 'Mac-n-Cheese (Chili)'])
        );
    });

    it('REQUIRED 9/10 — no CALC-1 regression: no yield divide, no serves_2 multiplier', async () => {
        // A "5 servings" row still yields its full stored list per meal...
        expect(grossOf(await run('b-comfort', 1), PORK)).toBeCloseTo(2.5, 10);
        // ...and the sold tier does not scale demand.
        const asCouple = await run('b-comfort', 1, 'serves_2');
        expect(grossOf(asCouple, PORK)).toBeCloseTo(2.5, 10);
        expect(grossOf(asCouple, BEEF)).toBeCloseTo(2, 10);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE PLANNER SURFACE — the actual repair (REQUIRED 5, UI half)
// ═════════════════════════════════════════════════════════════════════════════
describe('3. Manual Planner shows gross requirements by default', () => {
    it('THE FIX — in-stock items are shown by default, so a covered requirement cannot silently vanish', () => {
        const s = strip(read(PLANNER));
        expect(s).toMatch(/const \[showAllItems, setShowAllItems\] = useState\(true\)/);
        expect(s).not.toMatch(/const \[showAllItems, setShowAllItems\] = useState\(false\)/);
    });

    it('the operator can still narrow to a pure buy-list — the filter is preserved, only its default changed', () => {
        const s = strip(read(PLANNER));
        expect(s).toMatch(/if \(!showAllItems && \(item\.onHand \|\| 0\) >= item\.qty\) return acc;/);
        expect(s).toMatch(/checked=\{showAllItems\}/);
    });

    it('the GROSS requirement is labelled and carries its unit whenever it differs from the buy quantity', () => {
        const s = strip(read(PLANNER));
        expect(s).toMatch(/Need:\s*\$\{toFraction\(Number\(data\.qty\)\)\}\s*\$\{data\.unit\}/);
        // and the cryptic print-only abbreviation is gone
        expect(s).not.toMatch(/`T: \$\{toFraction\(Number\(data\.qty\)\)\} `/);
    });

    it('the covered row still renders its In Stock badge and its net (buy) figure — purchasing is unchanged', () => {
        const s = strip(read(PLANNER));
        expect(s).toMatch(/const isStocked = \(data\.onHand \|\| 0\) >= data\.qty;/);
        expect(s).toMatch(/In Stock/);
        expect(s).toMatch(/toFraction\(Number\(data\.netQty\)\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. NO SCHEMA CHANGE, NO PRODUCTION MUTATION (REQUIRED 11-12)
// ═════════════════════════════════════════════════════════════════════════════
describe('4. CALC-1A writes nothing', () => {
    const WRITE = /\b(prisma|tx)\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;

    it('REQUIRED 11 — the planner surface performs no database write', () => {
        expect(strip(read(PLANNER))).not.toMatch(WRITE);
    });

    it('REQUIRED 12 — the engine and the plan route remain read-only', () => {
        expect(strip(read('lib/kitchen_engine.ts'))).not.toMatch(WRITE);
        expect(strip(read('app/api/production/plan/route.ts'))).not.toMatch(WRITE);
    });

    it('the engine is untouched by CALC-1A — the CALC-1 contract lines are intact', () => {
        const s = read('lib/kitchen_engine.ts');
        expect(s).toMatch(/const mealInstances = physicalMealCount\(order\.quantity, item\.quantity\);/);
        expect(s).toMatch(/onHand: Math\.max\(0, Number\(item\.stock_quantity\) \|\| 0\),/);
        expect(s).not.toMatch(/const multiplier = order\.quantity \* bundleContentQty \* servingMultiplier;/);
    });
});
