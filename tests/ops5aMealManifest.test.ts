/**
 * OPS-5A — the physical meal manifest, and the label fan-out that consumes it.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7/§11.
 *
 * THE THREE DEFECTS OPS-5's own report left open, all one root cause:
 *
 *   D1  ProductionCalculator printed ONE label per recipe regardless of how
 *       many meals were being made, because its print batch never set `copies`
 *       and print-batch fell back to `copies || 1`.
 *   D2  A mixed Serves-5 + Serves-2 plan could only OMIT the tier, because the
 *       label path was built from prepTasks, which are keyed by recipe name
 *       alone and had already merged the two tiers together.
 *   D3  KitchenEngine's assemblyTasks derived its variant from the CURRENT
 *       Bundle.serving_tier instead of the sold OrderItem.variant_size
 *       snapshot -- the very re-derivation OPS-4/OPS-4A forbade everywhere else.
 *
 * ROOT CAUSE: prepTasks is an INGREDIENT-DEMAND aggregate being used as a meal
 * manifest. assemblyTasks was already the physical manifest -- its qty is
 * `order.quantity * (item.quantity || 1)` with NO serving multiplier and its
 * unit is literally 'meals' -- but it was never consumed by the label path and
 * its tier came from the wrong place. OPS-5A repairs it in place rather than
 * adding a competing meal-count authority.
 *
 * THE NUMBER THAT MUST NEVER BE ROUNDED:
 *   3 x Serves-2  ->  ingredient demand 1.5 base-equivalent
 *                 ->  physical packages 3
 * Both are asserted in the SAME scenario below (Part K).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KitchenEngine, type DBAdapter } from '@/lib/kitchen_engine';
import type { Recipe } from '@/types';
import {
    MEAL_UNIT,
    physicalMealCount,
    isPrintableMealCount,
    manifestKey,
    resolveManifestVariantSize,
} from '@/lib/mealManifest';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE — "one base recipe needs 5 lb chicken", the OPS-4/OPS-5 house example.
// Two bundles sharing ONE recipe, so tier merging is observable.
// ═════════════════════════════════════════════════════════════════════════════
const CHICKEN: Recipe = {
    id: 'rec-chicken', name: 'Chicken Alfredo', type: 'menu_item',
    base_yield_qty: 1, base_yield_unit: 'batch',
    items: [{
        id: 'ri-1', parent_recipe_id: 'rec-chicken',
        child_item_id: 'ing-chicken', child_type: 'ingredient',
        name: 'Chicken', quantity: 5, unit: 'lb',
        cost_per_unit: 1, cost_unit: 'lb', stock_quantity: 0,
    } as any],
};
const PORK: Recipe = {
    id: 'rec-pork', name: 'BBQ Pork', type: 'menu_item',
    base_yield_qty: 1, base_yield_unit: 'batch',
    items: [{
        id: 'ri-2', parent_recipe_id: 'rec-pork',
        child_item_id: 'ing-pork', child_type: 'ingredient',
        name: 'Pork', quantity: 4, unit: 'lb',
        cost_per_unit: 1, cost_unit: 'lb', stock_quantity: 0,
    } as any],
};

const B_S5 = 'bundle-s5';      // Bundle.serving_tier = serves_5, contains 1 chicken
const B_S2 = 'bundle-s2';      // Bundle.serving_tier = serves_2, contains 1 chicken
const B_DOUBLE = 'bundle-x2';  // contains 2 chicken  (BundleContent.quantity = 2)
const B_MULTI = 'bundle-multi'; // contains chicken + pork
/** Its CURRENT tier disagrees with the sold snapshot — the Part F case. */
const B_RETIERED = 'bundle-retiered'; // Bundle.serving_tier = serves_5 today

const CONTENTS: Record<string, { recipe_id: string; position: number; quantity?: number | null }[]> = {
    [B_S5]: [{ recipe_id: CHICKEN.id, position: 1, quantity: 1 }],
    [B_S2]: [{ recipe_id: CHICKEN.id, position: 1, quantity: 1 }],
    [B_DOUBLE]: [{ recipe_id: CHICKEN.id, position: 1, quantity: 2 }],
    [B_MULTI]: [
        { recipe_id: CHICKEN.id, position: 1, quantity: 1 },
        { recipe_id: PORK.id, position: 2, quantity: 1 },
    ],
    [B_RETIERED]: [{ recipe_id: CHICKEN.id, position: 1, quantity: 1 }],
};
const TIERS: Record<string, string> = {
    [B_S5]: 'serves_5',
    [B_S2]: 'serves_2',
    [B_DOUBLE]: 'serves_5',
    [B_MULTI]: 'serves_5',
    [B_RETIERED]: 'serves_5', // retiered AFTER the serves_2 order was sold
};

function adapter(): DBAdapter {
    const byId = new Map([[CHICKEN.id, CHICKEN], [PORK.id, PORK]]);
    return {
        async getRecipe(id) { return byId.get(id) || null; },
        async getAllRecipes() { return [CHICKEN, PORK]; },
        async getBundleContents(id) { return CONTENTS[id] || []; },
        async getBundleInfo(id) { return TIERS[id] ? { serving_tier: TIERS[id] } : null; },
    };
}
const run = (orders: any[]) => new KitchenEngine(adapter()).generateProductionRun(orders);
const chickenLb = (r: any) => Number(r.rawIngredients?.['ing-chicken']?.qty ?? 0);
/** Manifest rows, as an array, sorted for deterministic assertions. */
const manifest = (r: any) =>
    Object.values(r.assemblyTasks as Record<string, any>)
        .sort((a, b) => (a.name + a.variantSize).localeCompare(b.name + b.variantSize));

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE COUNT FORMULA — pure, behavioural. Part D.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. physical meal count: order.quantity x BundleContent.quantity, never the multiplier', () => {
    it('S5 qty 1 -> 1 package', () => expect(physicalMealCount(1, 1)).toBe(1));
    it('S2 qty 1 -> 1 package', () => expect(physicalMealCount(1, 1)).toBe(1));
    it('S2 qty 3 -> 3 packages (the multiplier does NOT reduce it)', () => expect(physicalMealCount(3, 1)).toBe(3));
    it('S5 qty 2 -> 2 packages', () => expect(physicalMealCount(2, 1)).toBe(2));

    it('BundleContent.quantity > 1 multiplies packages: 3 bundles x 2 per bundle = 6', () => {
        expect(physicalMealCount(3, 2)).toBe(6);
    });

    it('a missing bundle-content quantity defaults to 1 (matches prisma @default(1.0))', () => {
        expect(physicalMealCount(4, null)).toBe(4);
        expect(physicalMealCount(4, undefined)).toBe(4);
    });

    it('refuses nonsense rather than inventing a count', () => {
        expect(physicalMealCount(0, 1)).toBe(0);
        expect(physicalMealCount(-2, 1)).toBe(0);
        expect(physicalMealCount(NaN as any, 1)).toBe(0);
        expect(physicalMealCount(3, 0)).toBe(0);
    });

    it('PART D / M1: a decimal ingredient quantity is NOT a printable label count', () => {
        // 3 x Serves-2 has an ingredient demand of 1.5. If that number were ever
        // used as a label count, rounding would print 2 labels for 3 meals.
        expect(isPrintableMealCount(1.5)).toBe(false);
        expect(isPrintableMealCount(0.5)).toBe(false);
        expect(isPrintableMealCount(2.0000001)).toBe(false);
        expect(isPrintableMealCount(0)).toBe(false);
        expect(isPrintableMealCount(-1)).toBe(false);
        expect(isPrintableMealCount(NaN)).toBe(false);
        expect(isPrintableMealCount('3' as any)).toBe(false);
        expect(isPrintableMealCount(3)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. IDENTITY + TIER RESOLUTION — Part E / Part F.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. manifest identity and tier authority', () => {
    it('the key is recipe IDENTITY plus tier, so two same-named recipes never merge', () => {
        expect(manifestKey('rec-a', 'serves_5')).not.toBe(manifestKey('rec-b', 'serves_5'));
        // ...which is what stops one label carrying the other recipe's allergens.
        expect(manifestKey('rec-a', 'serves_5')).toBe(manifestKey('rec-a', 'serves_5'));
    });

    it('the same recipe at two tiers gets two distinct keys', () => {
        expect(manifestKey('rec-a', 'serves_5')).not.toBe(manifestKey('rec-a', 'serves_2'));
    });

    it('PART F: the sold snapshot outranks the current Bundle tier', () => {
        expect(resolveManifestVariantSize('serves_2', 'serves_5')).toBe('serves_2');
        expect(resolveManifestVariantSize('serves_5', 'serves_2')).toBe('serves_5');
    });

    it('the Bundle tier is consulted ONLY when the line carries no tier (legacy)', () => {
        expect(resolveManifestVariantSize(null, 'serves_2')).toBe('serves_2');
        expect(resolveManifestVariantSize(undefined, 'family')).toBe('serves_5');
    });

    it('returns null when neither source is recognisable, so the caller omits rather than guesses', () => {
        expect(resolveManifestVariantSize(null, null)).toBeNull();
        expect(resolveManifestVariantSize('nonsense', 'also-nonsense')).toBeNull();
    });

    it('start_fresh normalises through the existing vocabulary owner, not a new one', () => {
        expect(resolveManifestVariantSize('start_fresh', null)).toBe('serves_5');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE ENGINE MANIFEST — behavioural, against the real KitchenEngine.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. KitchenEngine assemblyTasks IS the physical meal manifest', () => {
    it('PART K: 3 x Serves-2 yields 3 PACKAGES and 1.5 base-equivalent INGREDIENTS in the same run', async () => {
        const r = await run([{ bundle_id: B_S2, quantity: 3, variant_size: 'serves_2' }]);
        // Physical packages: three trays, three labels.
        const rows = manifest(r);
        expect(rows).toHaveLength(1);
        expect(rows[0].qty).toBe(3);
        expect(rows[0].unit).toBe(MEAL_UNIT);
        // Ingredient demand: 3 x 0.5 = 1.5 base-equivalent -> 1.5 x 5lb = 7.5lb.
        expect(chickenLb(r)).toBe(7.5);
    });

    it('S5 qty 1 -> 1 package, 5 lb', async () => {
        const r = await run([{ bundle_id: B_S5, quantity: 1, variant_size: 'serves_5' }]);
        expect(manifest(r)[0].qty).toBe(1);
        expect(chickenLb(r)).toBe(5);
    });

    it('S2 qty 1 -> 1 package, 2.5 lb', async () => {
        const r = await run([{ bundle_id: B_S2, quantity: 1, variant_size: 'serves_2' }]);
        expect(manifest(r)[0].qty).toBe(1);
        expect(chickenLb(r)).toBe(2.5);
    });

    it('S5 qty 2 -> 2 packages', async () => {
        const r = await run([{ bundle_id: B_S5, quantity: 2, variant_size: 'serves_5' }]);
        expect(manifest(r)[0].qty).toBe(2);
    });

    it('PART D: BundleContent.quantity 2 multiplies packages -> 3 bundles = 6 meals', async () => {
        const r = await run([{ bundle_id: B_DOUBLE, quantity: 3, variant_size: 'serves_5' }]);
        expect(manifest(r)[0].qty).toBe(6);
    });

    it('PART E / D2: the SAME recipe at two tiers produces TWO rows, never one merged row', async () => {
        const r = await run([
            { bundle_id: B_S5, quantity: 2, variant_size: 'serves_5' },
            { bundle_id: B_S2, quantity: 3, variant_size: 'serves_2' },
        ]);
        const rows = manifest(r);
        expect(rows).toHaveLength(2);
        const s5 = rows.find(x => x.variantSize === 'serves_5');
        const s2 = rows.find(x => x.variantSize === 'serves_2');
        expect(s5?.qty).toBe(2);
        expect(s2?.qty).toBe(3);
        // The pre-OPS-5A behaviour: one row of 5 with the tier unknowable.
        expect(rows.some(x => x.qty === 5)).toBe(false);
        // Ingredients still aggregate correctly: 2x1.0 + 3x0.5 = 3.5 -> 17.5 lb
        expect(chickenLb(r)).toBe(17.5);
    });

    it('PART F / D3: a sold serves_2 snapshot survives even though the Bundle now says serves_5', async () => {
        const r = await run([{ bundle_id: B_RETIERED, quantity: 4, variant_size: 'serves_2' }]);
        const rows = manifest(r);
        expect(rows).toHaveLength(1);
        expect(rows[0].variantSize).toBe('serves_2');
        expect(rows[0].qty).toBe(4);
        // and the ingredient math used the sold tier too: 4 x 0.5 x 5lb = 10lb
        expect(chickenLb(r)).toBe(10);
    });

    it('a multi-recipe bundle fans out EVERY included meal', async () => {
        const r = await run([{ bundle_id: B_MULTI, quantity: 3, variant_size: 'serves_5' }]);
        const rows = manifest(r);
        expect(rows).toHaveLength(2);
        expect(rows.map(x => x.name).sort()).toEqual(['BBQ Pork', 'Chicken Alfredo']);
        for (const row of rows) expect(row.qty).toBe(3);
    });

    it('every manifest row carries recipe identity, canonical tier and a whole package count', async () => {
        const r = await run([{ bundle_id: B_S2, quantity: 3, variant_size: 'serves_2' }]);
        const row = manifest(r)[0];
        expect(row.id).toBe(CHICKEN.id);
        expect(row.name).toBe('Chicken Alfredo');
        expect(row.variantSize).toBe('serves_2');
        expect(isPrintableMealCount(row.qty)).toBe(true);
    });

    it('a legacy line with NO variant_size falls back to the Bundle tier, unchanged behaviour', async () => {
        const r = await run([{ bundle_id: B_S2, quantity: 2 } as any]);
        expect(manifest(r)[0].variantSize).toBe('serves_2');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. /api/production/plan carries the manifest to the client.
// ═════════════════════════════════════════════════════════════════════════════
const RECIPE_ROW = {
    id: 'rec-chicken', name: 'Chicken Alfredo', type: 'menu_item',
    base_yield_qty: 1, base_yield_unit: 'batch', container_type: 'tray', category_id: null,
    label_text: null, macros: null, image_url: null, description: null, allergens: null, cook_time: null,
    child_items: [{
        id: 'ri-1', parent_recipe_id: 'rec-chicken',
        child_recipe_id: null, child_ingredient_id: 'ing-chicken',
        child_ingredient: { name: 'Chicken', unit: 'lb', cost_per_unit: 1, stock_quantity: 0, supplier: null },
        child_recipe: null, quantity: 5, unit: 'lb',
        is_sub_recipe: false, section_name: null, section_batch: null,
    }],
};
let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops5aPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops5aPrisma = m.client; };
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
const BIZ = 'biz-ops5a';

const planMock = (bundles: { id: string; serving_tier: string }[]) => ({
    'recipe.findMany': [RECIPE_ROW],
    'bundleContent.findMany': (args: any) =>
        CONTENTS[args.where.bundle_id]
            ? CONTENTS[args.where.bundle_id].map(c => ({ bundle_id: args.where.bundle_id, ...c }))
            : [],
    'bundle.findFirst': (args: any) => {
        const t = TIERS[args.where.id];
        return t ? { serving_tier: t } : null;
    },
    'bundle.findMany': (args: any) => bundles.filter(b => args.where.id.in.includes(b.id)),
});
const postPlan = async (body: any) => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: BIZ } });
    const { POST } = await import('@/app/api/production/plan/route');
    const res = await POST(new Request('http://localhost/api/production/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as any);
    return res.json();
};

describe('4. /api/production/plan exposes the manifest', () => {
    beforeEach(() => jest.clearAllMocks());

    it('a synced Serves-2 x3 plan reports 3 packages and 7.5 lb', async () => {
        useMock(createPrismaMock({ results: planMock([]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: B_S2, quantity: 3, variant_size: 'serves_2' }] });
        const rows = Object.values(body.assemblyTasks as Record<string, any>);
        expect(rows).toHaveLength(1);
        expect((rows[0] as any).qty).toBe(3);
        expect((rows[0] as any).variantSize).toBe('serves_2');
        expect(Number(body.rawIngredients['ing-chicken'].qty)).toBe(7.5);
    });

    it('PART G: a MANUAL row uses the tenant-scoped Bundle tier and still fans out 3 packages', async () => {
        useMock(createPrismaMock({ results: planMock([{ id: B_S2, serving_tier: 'serves_2' }]) }));
        const body = await postPlan({
            // Malicious client claim; OPS-4A says it must be ignored for a manual row.
            manualOrders: [{ bundle_id: B_S2, quantity: 3, variant_size: 'serves_5' }],
        });
        const rows = Object.values(body.assemblyTasks as Record<string, any>);
        expect((rows[0] as any).variantSize).toBe('serves_2');
        expect((rows[0] as any).qty).toBe(3);
        expect(Number(body.rawIngredients['ing-chicken'].qty)).toBe(7.5);
    });

    it('PART I: a mixed plan returns SEPARATE tier rows instead of an omitted tier', async () => {
        useMock(createPrismaMock({ results: planMock([]) }));
        const body = await postPlan({
            syncedOrders: [
                { bundle_id: B_S5, quantity: 2, variant_size: 'serves_5' },
                { bundle_id: B_S2, quantity: 3, variant_size: 'serves_2' },
            ],
        });
        const rows = Object.values(body.assemblyTasks as Record<string, any>) as any[];
        expect(rows).toHaveLength(2);
        expect(rows.find(r => r.variantSize === 'serves_5').qty).toBe(2);
        expect(rows.find(r => r.variantSize === 'serves_2').qty).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE TWO PRINT-BATCH WRITERS share ONE count authority. Part H.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. PrepList and ProductionCalculator use the same authority', () => {
    it('D1: ProductionCalculator builds the batch from the manifest and sets real copies', () => {
        const s = strip(read('components/production/ProductionCalculator.tsx'));
        const block = s.slice(s.indexOf('const selectedRecipes'), s.indexOf('router.push(\'/production/print-batch\')'));
        expect(block).toMatch(/assemblyTasks/);
        expect(block).toMatch(/copies:/);
        expect(block).toMatch(/variantSize|servingTier/);
        // It must NOT go back to prepTasks for the batch.
        expect(block).not.toMatch(/prepTasks/);
    });

    it('PART H: neither component invents its own package count', () => {
        // Two different-but-equivalent routes to the ONE authority:
        //   PrepList  computes from raw Kitchen-Board rows, so it CALLS the
        //             shared formula in lib/mealManifest.ts.
        //   ProductionCalculator has no raw rows — it CONSUMES the manifest the
        //             engine already built with that same formula.
        // Neither multiplies quantities inline any more.
        const pl = strip(read('components/production/PrepList.tsx'));
        expect(pl).toMatch(/from ['"]@\/lib\/mealManifest['"]/);
        expect(pl).toMatch(/physicalMealCount\(/);

        const pc = strip(read('components/production/ProductionCalculator.tsx'));
        expect(pc).toMatch(/result\?\.assemblyTasks/);
        // It must not recompute a count from quantities of its own.
        const block = pc.slice(pc.indexOf('const selectedRecipes'), pc.indexOf('router.push(\'/production/print-batch\')'));
        expect(block).not.toMatch(/\*/);
    });

    it('the ONE formula lives in exactly one module', () => {
        // The engine and PrepList are the only two places a package count is
        // produced, and both route through lib/mealManifest.ts.
        expect(strip(read('lib/kitchen_engine.ts'))).toMatch(/physicalMealCount\(order\.quantity, item\.quantity\)/);
        expect(strip(read('components/production/PrepList.tsx'))).toMatch(/physicalMealCount\(item\.total_quantity, r\.quantity\)/);
    });

    it('PrepList no longer multiplies quantities inline', () => {
        const s = strip(read('components/production/PrepList.tsx'));
        expect(s).not.toMatch(/copies:\s*item\.total_quantity \* r\.quantity/);
        expect(s).toMatch(/physicalMealCount\(/);
    });

    it('the prep lane is tier-aware so PrepList can label truthfully', () => {
        const s = strip(read('app/api/production/dashboard/route.ts'));
        // Pin the actual grouping key and the carried field, not a loose
        // substring anywhere in the file.
        expect(s).toMatch(/const key = `\$\{bid\}-\$\{status\}-\$\{variantSize \?\? 'unknown'\}`/);
        expect(s).toMatch(/variant_size: variantSize/);
    });

    it('M14: `copies || 1` is no longer the normal quantity authority', () => {
        const s = strip(read('app/production/print-batch/page.tsx'));
        // The fallback may remain as a last-resort guard, but a real count must
        // be supplied by both writers - proven by the two assertions above.
        const pc = strip(read('components/production/ProductionCalculator.tsx'));
        const pl = strip(read('components/production/PrepList.tsx'));
        expect(pc).toMatch(/copies:/);
        expect(pl).toMatch(/copies:/);
        expect(s).toMatch(/copies/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PER-ITEM TIER ON THE PRINTED LABEL. Part I.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. print-batch prints a per-item tier', () => {
    it('BatchItem carries its own servingTier', () => {
        const s = strip(read('app/production/print-batch/page.tsx'));
        const iface = s.slice(s.indexOf('interface BatchItem'), s.indexOf('interface BatchJob'));
        expect(iface).toMatch(/servingTier/);
    });

    it('the label prefers the item tier over the batch-level one', () => {
        const s = strip(read('app/production/print-batch/page.tsx'));
        expect(s).toMatch(/item\.servingTier/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. OPS-5 FOOD-SAFETY PRESERVATION. Part J — none of this may regress.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. OPS-5 protections still intact', () => {
    const pb = () => strip(read('app/production/print-batch/page.tsx'));

    it('ingredient fail-closed gate survives', () => {
        expect(pb()).toMatch(/collectBlockedLabels/);
        expect(pb()).toMatch(/blockedLabels\.length > 0/);
    });

    it('the DO NOT USE printable sheet survives (Ctrl+P stays fail-closed)', () => {
        const printBlock = pb().slice(pb().indexOf('hidden print:block'));
        expect(printBlock).toMatch(/blockedLabels\.length > 0 \?/);
        expect(printBlock).toMatch(/DO NOT USE/);
    });

    it('no placeholder can reach printable output', () => {
        const code = pb();
        expect(code).not.toMatch(/["'`]Ingredients loading/i);
        const printable = code.slice(code.indexOf('hidden print:block'));
        expect(printable).not.toMatch(/Loading/i);
    });

    it('the print:hidden loading guard survives', () => {
        const line = pb().split('\n').find(l => l.includes('Loading batch'));
        expect(line).toMatch(/print:hidden/);
    });

    it('the centralized allergen authority survives on every live surface', () => {
        // OPS-5D: ProductionCalculator.tsx removed from this list -- it no
        // longer formats label content at all (both its print actions now
        // delegate to these two surfaces, proven in
        // tests/ops5MealLabelHardening.test.ts). Not a safety reduction:
        // allergen resolution used to happen in three places, now two, both
        // still covered here.
        for (const f of [
            'app/production/print-batch/page.tsx',
            'app/labels/LabelsClient.tsx',
        ]) {
            expect(strip(read(f))).toMatch(/from ['"]@\/lib\/allergens['"]/);
            expect(strip(read(f))).not.toMatch(/keywordMap\s*:\s*Record<string, string>/);
        }
    });

    it('no supporter PII on a meal label', () => {
        for (const f of ['app/production/print-batch/page.tsx', 'components/LabelTemplate.tsx', 'lib/mealManifest.ts']) {
            const s = strip(read(f));
            expect(s).not.toMatch(/customer_email|customer_phone|delivery_address/);
        }
    });

    it('this phase did NOT build outer-box / Box N of M labels', () => {
        expect(pb()).not.toMatch(/Box \d+ of|boxNumber|box_number/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. KITCHEN QUANTITY PRESERVATION. Part K — ingredient math is frozen.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. ingredient math untouched', () => {
    it('the multiplier chain line is unchanged', () => {
        const s = read('lib/kitchen_engine.ts');
        expect(s).toMatch(/const servingMultiplier = getServingMultiplier\(order\.variant_size\);/);
        expect(s).toMatch(/const multiplier = order\.quantity \* bundleContentQty \* servingMultiplier;/);
    });

    it('lib/serving_multipliers.ts is untouched (LOCKED)', () => {
        const s = read('lib/serving_multipliers.ts');
        expect(s).toMatch(/LOCK STATUS: PERMANENT/);
        expect(s).toMatch(/serves_5:\s*1\.0,/);
        expect(s).toMatch(/serves_2:\s*0\.5,/);
    });

    it('the manifest never applies a serving multiplier', () => {
        const s = strip(read('lib/mealManifest.ts'));
        expect(s).not.toMatch(/getServingMultiplier|SERVING_MULTIPLIERS|0\.5/);
    });

    it('OPS-4 sync tier preservation untouched', () => {
        expect(strip(read('app/api/production/sync/route.ts')))
            .toMatch(/const key = `\$\{bid\}::\$\{variant \?\? ''\}`;/);
    });

    it('OPS-4A manual/synced split untouched', () => {
        const s = strip(read('app/api/production/plan/route.ts'));
        expect(s).toMatch(/variant_size: resolveVariantSize\(o\.variant_size \?\? o\.serving_tier \?\? 'family'\)/);
        expect(s).toMatch(/business_id: session\.user\.businessId/);
    });

    it('no schema change', () => {
        const schema = read('prisma/schema.prisma');
        const m = schema.slice(schema.indexOf('model BundleContent'), schema.indexOf('model Customer'));
        expect(m).toMatch(/quantity\s+Float\s+@default\(1\.0\)/);
    });
});
