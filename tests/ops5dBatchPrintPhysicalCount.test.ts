/**
 * OPS-5D — Direct Batch Print physical-count + truthful printing closeout.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7/§11.
 *
 * OWNER-OBSERVED DEFECT, freshly traced (not assumed) at 3dd7fb2: Manual
 * Planner -> "Clean Eating/Paleo (Serves 2) - Fall 2026" -> qty 3 ->
 * Calculate Plan -> Batch Print All Labels. Vercel logs proved five POST
 * requests reached /api/production/print-label, one per meal recipe, EVERY
 * payload carrying `quantity: 2` -- the number of physical label COPIES
 * requested, not the correct 3. The UI then displayed "All 5 label print
 * jobs sent successfully!" even though the endpoint logged "[MOCK PRINT]"
 * and no printer exists to receive anything.
 *
 * ROOT CAUSE, freshly proven (not assumed): ProductionCalculator.tsx's
 * "Batch Print All Labels" handler iterated `Object.entries(result.prepTasks)`
 * and sent `quantity: Math.round(task.qty)`. prepTasks is INGREDIENT DEMAND
 * (lib/kitchen_engine.ts's own comment: "Nothing downstream may derive a
 * label count from prepTasks, which is the ingredient-scaled number.") --
 * for 3 x Serves-2, that demand is 1.5 base-equivalent, and
 * `Math.round(1.5)` is 2. The individual per-row "Print Labels (N)" button
 * had the identical bug (`Math.round(data.qty)`, same prepTasks source).
 *
 * assemblyTasks (OPS-5A's physical meal manifest) already carries the
 * CORRECT count for this exact scenario -- `order.quantity * BundleContent.quantity`,
 * no serving multiplier -- so 3 x Serves-2 is 3 physical packages per
 * recipe. Both print actions are repaired to consume that ONE authority,
 * never prepTasks, for a copy count.
 *
 * TRANSPORT TRUTHFULNESS: app/production/print-batch/page.tsx (OPS-5) was
 * already the launch-safe, truthful surface -- printMethod defaults to
 * 'browser' (genuine window.print(), fanning out `Array.from({length:
 * item.copies})` per recipe), and its 'api' branch already says "API
 * Printing not yet configured" rather than claiming success. "Batch Print
 * All Labels" is repaired to build the SAME manifest-based batch and
 * navigate there -- reusing the existing renderer rather than creating a
 * second one, and eliminating its own direct, unauthoritative call to the
 * (currently MOCK) print-label API entirely. The Label Designer
 * (app/labels/LabelsClient.tsx) still legitimately calls
 * /api/production/print-label directly as its own dedicated feature, so
 * ITS success message is repaired instead to reflect the printer's real
 * `mock` flag rather than an unconditional "Sent Successfully."
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KitchenEngine, type DBAdapter } from '@/lib/kitchen_engine';
import type { Recipe } from '@/types';
import { physicalMealCount } from '@/lib/mealManifest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FILE = 'components/production/ProductionCalculator.tsx';

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE — the owner's exact Bundle: "Clean Eating/Paleo (Serves 2)", five
// distinct recipes, one of each per Bundle unit.
// ═════════════════════════════════════════════════════════════════════════════
function recipe(id: string, name: string, ingredientId: string, qty: number): Recipe {
    return {
        id, name, type: 'menu_item',
        base_yield_qty: 1, base_yield_unit: 'batch',
        items: [{
            id: `ri-${id}`, parent_recipe_id: id,
            child_item_id: ingredientId, child_type: 'ingredient',
            name: ingredientId, quantity: qty, unit: 'lb',
            cost_per_unit: 1, cost_unit: 'lb', stock_quantity: 0,
        } as any],
    };
}

const APPLE_ROSEMARY_PORK = recipe('rec-arp', 'Apple Rosemary Pork', 'ing-pork-arp', 3);
const CAJUN_CHICKEN = recipe('rec-ccd', 'Cajun Chicken Dinner', 'ing-chicken-ccd', 2);
const CHICKEN_FAJITAS = recipe('rec-cf', 'Chicken Fajitas', 'ing-chicken-cf', 2.5);
const CHILI_PALEO = recipe('rec-cp', 'Chili - Paleo', 'ing-beef-cp', 4);
const ITALIAN_PORK = recipe('rec-ipcv', 'Italian Pork Chops n Veggies', 'ing-pork-ipcv', 3.5);
const ALL_RECIPES = [APPLE_ROSEMARY_PORK, CAJUN_CHICKEN, CHICKEN_FAJITAS, CHILI_PALEO, ITALIAN_PORK];

const CLEAN_EATING_S2 = 'bundle-clean-eating-s2';
const CLEAN_EATING_S5 = 'bundle-clean-eating-s5'; // sibling for Part L mixed-tier
const CONTENTS: Record<string, { recipe_id: string; position: number; quantity?: number | null }[]> = {
    [CLEAN_EATING_S2]: ALL_RECIPES.map((r, i) => ({ recipe_id: r.id, position: i + 1, quantity: 1 })),
    // Part L: same recipe (Chicken Fajitas) also sold at Serves 5.
    [CLEAN_EATING_S5]: [{ recipe_id: CHICKEN_FAJITAS.id, position: 1, quantity: 1 }],
};
const TIERS: Record<string, string> = {
    [CLEAN_EATING_S2]: 'serves_2',
    [CLEAN_EATING_S5]: 'serves_5',
};

function adapter(): DBAdapter {
    const byId = new Map(ALL_RECIPES.map(r => [r.id, r]));
    return {
        async getRecipe(id) { return byId.get(id) || null; },
        async getAllRecipes() { return ALL_RECIPES; },
        async getBundleContents(id) { return CONTENTS[id] || []; },
        async getBundleInfo(id) { return TIERS[id] ? { serving_tier: TIERS[id] } : null; },
    };
}
const run = (orders: any[]) => new KitchenEngine(adapter()).generateProductionRun(orders);
const manifest = (r: any) =>
    Object.values(r.assemblyTasks as Record<string, any>)
        .sort((a: any, b: any) => (a.name + a.variantSize).localeCompare(b.name + b.variantSize));

// ═════════════════════════════════════════════════════════════════════════════
// PART C/D/I/J — fresh, failing-first-proven behavioral reproduction of the
// owner's exact scenario. FAILS on nothing here (the engine was already
// correct since OPS-5A) -- this is the "freshly re-prove" requirement, and
// the baseline every UI-layer fix below is checked against.
// ═════════════════════════════════════════════════════════════════════════════
describe('the physical meal manifest for the owner\'s exact Bundle+qty', () => {
    it('S2 Bundle qty 3 -> 3 physical meals for EVERY one of the five recipes (item 1)', async () => {
        const result = await run([{ bundle_id: CLEAN_EATING_S2, quantity: 3, variant_size: 'serves_2' }]);
        const rows = manifest(result);
        expect(rows).toHaveLength(5);
        for (const row of rows) {
            expect(row.qty).toBe(3);
            expect(row.unit).toBe('meals');
        }
    });

    it('total physical label count across the batch is 15 (item 6)', async () => {
        const result = await run([{ bundle_id: CLEAN_EATING_S2, quantity: 3, variant_size: 'serves_2' }]);
        const total = manifest(result).reduce((sum: number, row: any) => sum + row.qty, 0);
        expect(total).toBe(15);
    });

    it('every row still resolves to the serves_2 tier (item 7)', async () => {
        const result = await run([{ bundle_id: CLEAN_EATING_S2, quantity: 3, variant_size: 'serves_2' }]);
        for (const row of manifest(result)) {
            expect(row.variantSize).toBe('serves_2');
        }
    });

    it('PART J: ingredient demand (prepTasks) and physical count (assemblyTasks) are asserted TOGETHER in the same run', async () => {
        const result = await run([{ bundle_id: CLEAN_EATING_S2, quantity: 3, variant_size: 'serves_2' }]);
        // Chicken Fajitas: 2.5 lb chicken per batch, serves_2 multiplier 0.5.
        // Ingredient demand = 3 orders x 1 BundleContent x 0.5 multiplier x 2.5 lb = 3.75 lb.
        expect(result.rawIngredients['ing-chicken-cf']?.qty).toBeCloseTo(3.75, 5);
        const fajitasPrep = result.prepTasks['Chicken Fajitas'];
        expect(fajitasPrep.qty).toBeCloseTo(1.5, 5); // 3 orders x 0.5 multiplier -- ingredient-scaled, NOT a label count
        const fajitasManifest = manifest(result).find((r: any) => r.name === 'Chicken Fajitas');
        expect(fajitasManifest.qty).toBe(3); // physical packages -- unaffected by the multiplier
    });

    it('item 8: copies do not come from the numeral in "Serves 2" -- a Serves-5 Bundle at the SAME qty gets the SAME copies', async () => {
        const s2 = await run([{ bundle_id: CLEAN_EATING_S2, quantity: 3, variant_size: 'serves_2' }]);
        // A hypothetical Serves-5 sibling bundle at the identical order quantity (3).
        const s5 = await run([{ bundle_id: CLEAN_EATING_S5, quantity: 3, variant_size: 'serves_5' }]);
        const s2Qty = manifest(s2).find((r: any) => r.name === 'Chicken Fajitas').qty;
        const s5Qty = manifest(s5).find((r: any) => r.name === 'Chicken Fajitas').qty;
        expect(s2Qty).toBe(3);
        expect(s5Qty).toBe(3); // same order qty -> same copies, regardless of "2" vs "5" in the tier name
    });

    it('item 9: copies do not come from prepTask quantity -- the two numbers genuinely differ here (3 vs 1.5)', async () => {
        const result = await run([{ bundle_id: CLEAN_EATING_S2, quantity: 3, variant_size: 'serves_2' }]);
        const prepQty = result.prepTasks['Chicken Fajitas'].qty;
        const manifestQty = manifest(result).find((r: any) => r.name === 'Chicken Fajitas').qty;
        expect(prepQty).not.toBe(manifestQty);
        expect(Math.round(prepQty)).toBe(2); // this IS the exact wrong value the owner observed
        expect(manifestQty).toBe(3); // this is the correct one
    });

    it('item 11: S5 qty 2 -> 2 copies, tier Serves 5 (Part L baseline)', async () => {
        const result = await run([{ bundle_id: CLEAN_EATING_S5, quantity: 2, variant_size: 'serves_5' }]);
        const row = manifest(result).find((r: any) => r.name === 'Chicken Fajitas');
        expect(row.qty).toBe(2);
        expect(row.variantSize).toBe('serves_5');
    });

    it('item 12: mixed S5 qty2 + S2 qty3, SAME recipe, remains split into two rows -- no collapse', async () => {
        const result = await run([
            { bundle_id: CLEAN_EATING_S5, quantity: 2, variant_size: 'serves_5' },
            { bundle_id: CLEAN_EATING_S2, quantity: 3, variant_size: 'serves_2' },
        ]);
        const fajitasRows = manifest(result).filter((r: any) => r.name === 'Chicken Fajitas');
        expect(fajitasRows).toHaveLength(2);
        const s5Row = fajitasRows.find((r: any) => r.variantSize === 'serves_5');
        const s2Row = fajitasRows.find((r: any) => r.variantSize === 'serves_2');
        expect(s5Row.qty).toBe(2);
        expect(s2Row.qty).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART E/F — UI wiring. FAILING-FIRST against the unfixed source: these
// pin the presence of the CORRECT authority and the ABSENCE of the
// prepTasks-derived defect.
// ═════════════════════════════════════════════════════════════════════════════
function batchAllLabelsHandler(src: string): string {
    const idx = src.indexOf('Batch Print All Labels');
    const start = src.lastIndexOf('onClick={', idx);
    if (start === -1) throw new Error('Could not locate the Batch Print All Labels handler');
    return src.slice(start, idx);
}

describe('"Batch Print All Labels" derives copies from the physical manifest, never prepTasks', () => {
    it('DEFECT: the handler no longer reads Object.entries(result.prepTasks)', () => {
        const src = strip(read(FILE));
        const block = batchAllLabelsHandler(src);
        expect(block).not.toMatch(/Object\.entries\(result\.prepTasks\)/);
    });

    it('DEFECT: the handler no longer computes Math.round(task.qty) as a print quantity', () => {
        const src = strip(read(FILE));
        const block = batchAllLabelsHandler(src);
        expect(block).not.toMatch(/quantity:\s*Math\.round\(task\.qty\)/);
    });

    it('the handler is built from result.assemblyTasks -- item 2/3 authority', () => {
        const src = strip(read(FILE));
        const block = batchAllLabelsHandler(src);
        expect(block).toMatch(/Object\.values\(result\.assemblyTasks\)/);
        expect(block).toMatch(/copies:\s*row\.qty/);
    });

    it('the handler reuses the existing browser-print batch surface -- no second renderer (Part F/Part D)', () => {
        const src = strip(read(FILE));
        const block = batchAllLabelsHandler(src);
        expect(block).toMatch(/_printBatch/);
        expect(block).toMatch(/router\.push\(['"`]\/production\/print-batch['"`]\)/);
    });

    it('DEFECT: the handler no longer POSTs directly to /api/production/print-label for meal labels', () => {
        const src = strip(read(FILE));
        const block = batchAllLabelsHandler(src);
        expect(block).not.toMatch(/fetch\(['"`]\/api\/production\/print-label['"`]/);
    });

    it('DEFECT: the false "sent successfully" claim is gone from this handler', () => {
        const src = strip(read(FILE));
        const block = batchAllLabelsHandler(src);
        expect(block).not.toMatch(/sent successfully/i);
    });
});

describe('the individual "Print Labels (N)" button shows and requests the physical count, never prepTasks', () => {
    function individualButtonBlock(src: string): string {
        const idx = src.indexOf("Print Labels ({");
        const start = src.lastIndexOf('const physicalCopies', idx);
        if (idx === -1 || start === -1) throw new Error('Could not locate the individual Print Labels button');
        return src.slice(start, idx + 30);
    }

    it('DEFECT: no longer displays or requests Math.round(data.qty)', () => {
        const src = strip(read(FILE));
        const block = individualButtonBlock(src);
        expect(block).not.toMatch(/Math\.round\(data\.qty\)/);
    });

    it('derives its copy count from result.assemblyTasks, matched by recipe id', () => {
        const src = strip(read(FILE));
        const block = individualButtonBlock(src);
        expect(block).toMatch(/assemblyTasks/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART G/H — print transport truthfulness. FAILING-FIRST against the mock
// printer's current unconditional "sent" claim.
// ═════════════════════════════════════════════════════════════════════════════
describe('the mock printer never claims physical delivery (item 13/14)', () => {
    it('DEFECT: MockLabelPrinter reports mock: true in its result', async () => {
        const { getLabelPrinter } = await import('@/lib/label_printer');
        delete process.env.DCG_API_KEY;
        delete process.env.DCG_LOCATION_ID;
        const printer = getLabelPrinter();
        const result = await printer.printLabel({
            recipeName: 'Chicken Fajitas', ingredients: 'chicken', expiryDate: '1/1/2027',
            quantity: 3, user: 'test',
        } as any);
        expect(result.success).toBe(true);
        expect((result as any).mock).toBe(true);
    });

    it('DEFECT: the mock printer message does not claim unconditional physical delivery', async () => {
        const { getLabelPrinter } = await import('@/lib/label_printer');
        delete process.env.DCG_API_KEY;
        delete process.env.DCG_LOCATION_ID;
        const printer = getLabelPrinter();
        const result = await printer.printLabel({
            recipeName: 'Chicken Fajitas', ingredients: 'chicken', expiryDate: '1/1/2027',
            quantity: 3, user: 'test',
        } as any);
        expect(result.message).toMatch(/mock/i);
        expect(result.message).not.toBe('Label sent to Mock Printer (Final)');
    });

    it('/api/production/print-label propagates the mock flag through to the client', () => {
        const src = strip(read('app/api/production/print-label/route.ts'));
        expect(src).toMatch(/mock:\s*result\.mock/);
    });

    it('DEFECT: LabelsClient.tsx no longer shows an unconditional "Sent Successfully" claim', () => {
        const src = strip(read('app/labels/LabelsClient.tsx'));
        expect(src).not.toMatch(/Print Job Sent Successfully/);
    });

    it('LabelsClient.tsx wires the response mock flag into its own messaging', () => {
        const src = strip(read('app/labels/LabelsClient.tsx'));
        expect(src).toMatch(/data\.mock/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 15 — the browser-print surface's own fan-out genuinely uses each
// item's copies, not a hardcoded 1. This is the launch-safe operational
// path "Batch Print All Labels" now redirects into (Part G/H).
// ═════════════════════════════════════════════════════════════════════════════
describe('the browser-print batch surface fans out the real copy count per item', () => {
    it('renders Array.from({ length: copies }) driven by item.copies, not a fixed count', () => {
        const src = strip(read('app/production/print-batch/page.tsx'));
        expect(src).toMatch(/Math\.max\(1,\s*Math\.round\(item\.copies\s*\|\|\s*1\)\)/);
        expect(src).toMatch(/Array\.from\(\{\s*length:\s*copies\s*\}\)/);
    });

    it('printMethod defaults to the genuine browser print path, not the unconfigured API path', () => {
        const src = strip(read('app/production/print-batch/page.tsx'));
        expect(src).toMatch(/useState<'browser' \| 'api'>\('browser'\)/);
    });

    it('the "api" print method truthfully says it is not configured, rather than claiming success', () => {
        const src = strip(read('app/production/print-batch/page.tsx'));
        expect(src).toMatch(/API Printing not yet configured/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 18 — no supporter PII in the rebuilt batch payload.
// ═════════════════════════════════════════════════════════════════════════════
describe('no supporter PII in the rebuilt "Batch Print All Labels" payload', () => {
    it('the handler carries no customer/supporter name, email, phone, or address field', () => {
        const src = strip(read(FILE));
        const block = batchAllLabelsHandler(src);
        expect(block).not.toMatch(/purchaserName|customerName|supporterName|email|phone|address/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 19/20 — regression: OPS-4A manual-tier authority and OPS-5C Bundle
// loader are untouched by this phase. Full suites re-run in validation; this
// is a light existence pin so a careless edit to those files is caught here
// too.
// ═════════════════════════════════════════════════════════════════════════════
describe('regression: adjacent authorities are untouched', () => {
    it('the manual-tier authority (/api/production/plan) file is unmodified by this phase', () => {
        const src = read('app/api/production/plan/route.ts');
        expect(src).toMatch(/manualOrders/);
    });

    it('lib/bundleLoader.ts (OPS-5C) is unmodified by this phase', () => {
        const src = read('lib/bundleLoader.ts');
        expect(src).toMatch(/export async function loadBundles/);
    });
});
