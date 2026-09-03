/**
 * OPS-5E — Batch Print client handoff / navigation closeout.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11.
 *
 * OWNER-OBSERVED DEFECT, freshly traced (not assumed) at 3001297: Manual
 * Planner -> Clean Eating/Paleo (Serves 2) -> qty 3 -> Calculate Plan ->
 * "Batch Print All Labels" did NOTHING. No navigation, no print page, no
 * request. Vercel logs confirm GET /api/bundles 200 and POST
 * /api/production/plan 200 before the click, then NOTHING after it: no GET
 * /production/print-batch, no POST /api/production/print-label. The click
 * died in client code before any navigation or server interaction.
 *
 * ROOT CAUSE, proven at components/production/ProductionCalculator.tsx:1087
 * as shipped in 3001297:
 *
 *     if (businessId) {
 *         localStorage.setItem(`${businessId}_printBatch`, ...);
 *         router.push('/production/print-batch');
 *     }
 *     // <-- no else. A falsy businessId swallows the entire click.
 *
 * OPS-5B and OPS-5C had already proven TWICE that useSession()'s
 * `session.user.businessId` is not reliably present in this component.
 * OPS-5C removed that dependency from Bundle loading; the identical
 * dependency survived on the print-batch handoff in FIVE places that each
 * re-derived the storage key -- including the READER, which gated its own
 * load effect on the same value and would therefore have shown "Loading
 * batch..." forever even if only the writers had been repaired.
 *
 * THE FIX: lib/printBatchStorage.ts is now the ONE storage-key authority.
 * The key is fixed (writer and reader agree by construction, not by both
 * resolving the same client value at the same instant), businessId is
 * recorded inside the payload as an advisory mismatch guard rather than a
 * gate, and every read/write returns a discriminated result so no click can
 * end in silence.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KitchenEngine, type DBAdapter } from '@/lib/kitchen_engine';
import type { Recipe } from '@/types';
import {
    PRINT_BATCH_STORAGE_KEY,
    writePrintBatch,
    readPrintBatch,
    clearPrintBatch,
    distinctTierCount,
    type PrintBatchPayload,
} from '@/lib/printBatchStorage';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CALC = 'components/production/ProductionCalculator.tsx';
const READER = 'app/production/print-batch/page.tsx';
const PREPLIST = 'components/production/PrepList.tsx';

// ═════════════════════════════════════════════════════════════════════════════
// A minimal in-memory localStorage, so the handoff can be exercised for real
// (Part J: "Do not rely only on source regex").
// ═════════════════════════════════════════════════════════════════════════════
function installStorage(impl?: Partial<Storage>) {
    const store = new Map<string, string>();
    const base: any = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => store.clear(),
    };
    (globalThis as any).localStorage = { ...base, ...(impl || {}) };
    return store;
}

afterEach(() => { delete (globalThis as any).localStorage; });

const BATCH = (over: Partial<PrintBatchPayload> = {}): PrintBatchPayload => ({
    name: 'Batch - test',
    items: [{ name: 'Chicken Fajitas', id: 'rec-cf', qty: 3, unit: 'meals', copies: 3, variantSize: 'serves_2', servingTier: 'Serves 2' }],
    servingTier: 'Serves 2',
    // OPS-5F: every real writer now stamps the server-authenticated owner, so
    // the default fixture does too. Tests that specifically exercise a missing
    // or foreign owner override it.
    businessId: 'biz-a',
    ...over,
});

// ═════════════════════════════════════════════════════════════════════════════
// PART B/C/J — the handoff must complete with NO client businessId at all.
// This is the exact deployed failure, reproduced behaviorally.
// ═════════════════════════════════════════════════════════════════════════════
describe('the print-batch handoff completes without any client businessId', () => {
    // SUPERSEDED IN PART BY OPS-5F. The defect this suite exists to pin -- an
    // unreliable CLIENT session value silently killing the handoff -- is
    // unchanged and still enforced below and throughout this file. What OPS-5F
    // changed, at the owner's explicit instruction ahead of multi-tenant
    // launch, is WHERE the tenant id comes from and how strictly it is
    // enforced at READ time: it is now the SERVER-authenticated id
    // (/api/tenant/identity) and ownership must be positively proven, because
    // localStorage is per-browser and a stale Tenant A batch must never render
    // for Tenant B. So a batch is no longer readable without a proven owner --
    // and correspondingly, every writer now stamps one. See
    // tests/ops5fPrintCloseout.test.ts.

    it('writes successfully when the CLIENT businessId is undefined (the deployed failure state)', () => {
        // Still the core OPS-5E guarantee: nothing about the client session
        // can prevent the batch from being written.
        installStorage();
        const result = writePrintBatch(BATCH({ businessId: undefined }));
        expect(result.ok).toBe(true);
    });

    it('OPS-5F: a batch stamped with the server-authenticated owner round-trips', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: 'biz-a' }));
        const result = readPrintBatch('biz-a');
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.batch.items).toHaveLength(1);
    });

    it('OPS-5F: a batch that cannot prove its owner is refused rather than rendered', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: undefined }));
        expect(readPrintBatch('biz-a').ok).toBe(false);
        expect(readPrintBatch(undefined).ok).toBe(false);
    });

    it('OPS-5F: a reader that cannot confirm its own tenant refuses rather than rendering', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: 'biz-a' }));
        expect(readPrintBatch(undefined).ok).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — one storage-key authority; writer and reader agree by construction.
// ═════════════════════════════════════════════════════════════════════════════
describe('there is exactly ONE print-batch storage key authority', () => {
    it('the key is a fixed constant, not built from session state', () => {
        expect(PRINT_BATCH_STORAGE_KEY).toBe('freezeriq_printBatch');
        expect(PRINT_BATCH_STORAGE_KEY).not.toMatch(/\$\{/);
    });

    it('writer and reader round-trip through the same key with no coordination', () => {
        // SUPERSEDED BY OPS-5F: the round trip now also proves ownership, so
        // the read passes the batch's (server-stamped) owner. The key-agreement
        // assertion this test exists for is unchanged.
        const store = installStorage();
        writePrintBatch(BATCH());
        expect(store.has(PRINT_BATCH_STORAGE_KEY)).toBe(true);
        expect(readPrintBatch('biz-a').ok).toBe(true);
    });

    it('DEFECT: no live file re-derives a `${businessId}_printBatch` key any more', () => {
        for (const f of [CALC, READER, PREPLIST]) {
            expect(strip(read(f))).not.toMatch(/\$\{[^}]*businessId[^}]*\}_printBatch/);
        }
    });

    it('DEFECT: every live print-batch surface imports the shared authority', () => {
        for (const f of [CALC, READER, PREPLIST]) {
            expect(strip(read(f))).toMatch(/from ['"]@\/lib\/printBatchStorage['"]/);
        }
    });

    it('clearPrintBatch removes exactly that key', () => {
        const store = installStorage();
        writePrintBatch(BATCH());
        clearPrintBatch();
        expect(store.has(PRINT_BATCH_STORAGE_KEY)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART E — silence is forbidden. Every failure mode yields a reason.
// ═════════════════════════════════════════════════════════════════════════════
describe('no handoff failure is ever silent', () => {
    it('a storage write failure (quota / private mode) reports a reason', () => {
        installStorage({ setItem: () => { throw new Error('QuotaExceededError'); } });
        const result = writePrintBatch(BATCH());
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    });

    it('a serialization failure reports a reason rather than throwing', () => {
        installStorage();
        const circular: any = BATCH();
        circular.items[0].self = circular; // JSON.stringify will throw
        const result = writePrintBatch(circular);
        expect(result.ok).toBe(false);
    });

    it('an empty batch is refused with a reason, not written', () => {
        const store = installStorage();
        const result = writePrintBatch(BATCH({ items: [] }));
        expect(result.ok).toBe(false);
        expect(store.has(PRINT_BATCH_STORAGE_KEY)).toBe(false);
    });

    it('a missing batch reports a reason instead of loading forever', () => {
        installStorage();
        const result = readPrintBatch();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/no print batch/i);
    });

    it('a malformed (unparseable) batch reports a reason', () => {
        const store = installStorage();
        store.set(PRINT_BATCH_STORAGE_KEY, '{not valid json');
        const result = readPrintBatch();
        expect(result.ok).toBe(false);
    });

    it('a batch missing its item list reports a reason', () => {
        const store = installStorage();
        store.set(PRINT_BATCH_STORAGE_KEY, JSON.stringify({ name: 'x' }));
        const result = readPrintBatch();
        expect(result.ok).toBe(false);
    });

    it('an unreadable storage (disabled) reports a reason', () => {
        installStorage({ getItem: () => { throw new Error('SecurityError'); } });
        const result = readPrintBatch();
        expect(result.ok).toBe(false);
    });

    it('DEFECT: the Batch Print All Labels handler cannot be gated on businessId in EITHER polarity', () => {
        const src = strip(read(CALC));
        const idx = src.indexOf('Batch Print All Labels');
        const start = src.lastIndexOf('onClick={', idx);
        const handler = src.slice(start, idx);
        // The shipped defect: `if (businessId) { ...navigate... }` with no else.
        expect(handler).not.toMatch(/if\s*\(\s*businessId\s*\)\s*\{/);
        // The equally-lethal inverse: `if (!businessId) return;` -- a silent
        // early return on the same unreliable value. Neither may exist.
        expect(handler).not.toMatch(/if\s*\(\s*!\s*businessId\s*\)/);
        // Belt and braces: businessId may appear ONLY as recorded payload
        // metadata, never in a conditional in this handler.
        const conditionalUse = /(if|\?|&&|\|\|)[^\n]*\bbusinessId\b/.test(handler);
        expect(conditionalUse).toBe(false);
    });

    it('DEFECT: neither print-batch writer in this file gates navigation on businessId', () => {
        // Covers "Print Batch (N)" as well as "Batch Print All Labels" -- both
        // shipped the identical silent swallow.
        const src = strip(read(CALC));
        expect(src).not.toMatch(/if\s*\(\s*businessId\s*\)\s*\{[\s\S]{0,400}?router\.push\(['"`]\/production\/print-batch/);
        expect(src).not.toMatch(/if\s*\(\s*!\s*businessId\s*\)\s*return;[\s\S]{0,400}?writePrintBatch\(/);
    });

    it('DEFECT: the handler surfaces a failed write instead of navigating or doing nothing', () => {
        const src = strip(read(CALC));
        const idx = src.indexOf('Batch Print All Labels');
        const start = src.lastIndexOf('onClick={', idx);
        const handler = src.slice(start, idx);
        expect(handler).toMatch(/writePrintBatch\(/);
        // A failure path exists and it tells the operator something.
        expect(handler).toMatch(/\.ok/);
        expect(handler).toMatch(/alert\(/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — tenant mismatch is a GUARD, never an authorization gate.
// ═════════════════════════════════════════════════════════════════════════════
describe('tenant safety without gating', () => {
    it('a batch belonging to another tenant is refused when both ids are known', () => {
        // SUPERSEDED BY OPS-5F only in wording: the rejection message now says
        // "different business". The refusal itself is unchanged and stricter.
        installStorage();
        writePrintBatch(BATCH({ businessId: 'biz-a' }));
        const result = readPrintBatch('biz-b');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/different business/i);
    });

    it('a matching tenant id reads normally', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: 'biz-a' }));
        expect(readPrintBatch('biz-a').ok).toBe(true);
    });

    it('businessId is never used to decide whether the WRITE may happen', () => {
        // Unchanged by OPS-5F: the storage helper never gates a write on the
        // tenant id. (Callers now refuse EARLIER when the SERVER cannot
        // confirm the tenant -- a visible refusal, never a silent one.)
        installStorage();
        expect(writePrintBatch(BATCH({ businessId: null })).ok).toBe(true);
        expect(writePrintBatch(BATCH({ businessId: undefined })).ok).toBe(true);
        expect(writePrintBatch(BATCH({ businessId: 'biz-a' })).ok).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART G — OPS-5D physical counts must survive untouched.
// ═════════════════════════════════════════════════════════════════════════════
function recipe(id: string, name: string, ing: string, qty: number): Recipe {
    return {
        id, name, type: 'menu_item', base_yield_qty: 1, base_yield_unit: 'batch',
        items: [{
            id: `ri-${id}`, parent_recipe_id: id, child_item_id: ing,
            child_type: 'ingredient', name: ing, quantity: qty, unit: 'lb',
            cost_per_unit: 1, cost_unit: 'lb', stock_quantity: 0,
        } as any],
    };
}
const R = [
    recipe('rec-arp', 'Apple Rosemary Pork', 'ing-arp', 3),
    recipe('rec-ccd', 'Cajun Chicken Dinner', 'ing-ccd', 2),
    recipe('rec-cf', 'Chicken Fajitas', 'ing-cf', 2.5),
    recipe('rec-cp', 'Chili - Paleo', 'ing-cp', 4),
    recipe('rec-ipcv', 'Italian Pork Chops n Veggies', 'ing-ipcv', 3.5),
];
const S2 = 'bundle-clean-eating-s2';
const S5 = 'bundle-clean-eating-s5';
const CONTENTS: Record<string, any[]> = {
    [S2]: R.map((r, i) => ({ recipe_id: r.id, position: i + 1, quantity: 1 })),
    [S5]: [{ recipe_id: 'rec-cf', position: 1, quantity: 1 }],
};
const TIERS: Record<string, string> = { [S2]: 'serves_2', [S5]: 'serves_5' };
function adapter(): DBAdapter {
    const byId = new Map(R.map(r => [r.id, r]));
    return {
        async getRecipe(id) { return byId.get(id) || null; },
        async getAllRecipes() { return R; },
        async getBundleContents(id) { return CONTENTS[id] || []; },
        async getBundleInfo(id) { return TIERS[id] ? { serving_tier: TIERS[id] } : null; },
    };
}
const run = (orders: any[]) => new KitchenEngine(adapter()).generateProductionRun(orders);

/** Mirrors the handler's DTO construction, so the real numbers are asserted. */
const toBatchItems = (result: any) =>
    Object.values(result.assemblyTasks as Record<string, any>).map(row => ({
        name: row.name, id: row.id, qty: row.qty, unit: row.unit,
        copies: row.qty, variantSize: row.variantSize ?? null,
        servingTier: row.variantSize === 'serves_2' ? 'Serves 2' : 'Serves 5',
    }));

describe('OPS-5D physical counts survive the handoff repair', () => {
    it('S2 qty3 produces 5 meal rows, each copies 3 (items 9/10/11)', async () => {
        const result = await run([{ bundle_id: S2, quantity: 3, variant_size: 'serves_2' }]);
        const items = toBatchItems(result);
        expect(items).toHaveLength(5);
        for (const item of items) {
            expect(item.copies).toBe(3);
            expect(item.servingTier).toBe('Serves 2');
        }
        expect(items.reduce((s, i) => s + i.copies, 0)).toBe(15);
    });

    it('those exact counts survive a real write/read round trip', async () => {
        installStorage();
        const result = await run([{ bundle_id: S2, quantity: 3, variant_size: 'serves_2' }]);
        expect(writePrintBatch({ name: 'b', items: toBatchItems(result) as any, businessId: 'biz-a' }).ok).toBe(true);
        const back = readPrintBatch('biz-a');
        expect(back.ok).toBe(true);
        if (back.ok) {
            expect(back.batch.items).toHaveLength(5);
            expect(back.batch.items.reduce((s, i) => s + i.copies, 0)).toBe(15);
        }
    });

    it('item 12: prepTasks never supplies the copy count (1.5 would round to the wrong 2)', async () => {
        const result = await run([{ bundle_id: S2, quantity: 3, variant_size: 'serves_2' }]);
        expect(result.prepTasks['Chicken Fajitas'].qty).toBeCloseTo(1.5, 5);
        expect(toBatchItems(result).find(i => i.name === 'Chicken Fajitas')!.copies).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART H — the mixed-tier individual action must not collapse tiers.
// ═════════════════════════════════════════════════════════════════════════════
describe('the individual Print Labels action cannot collapse mixed tiers', () => {
    it('distinctTierCount detects a single-tier recipe', () => {
        expect(distinctTierCount([{ variantSize: 'serves_2' }, { variantSize: 'serves_2' }])).toBe(1);
    });

    it('distinctTierCount detects a mixed-tier recipe', () => {
        expect(distinctTierCount([{ variantSize: 'serves_5' }, { variantSize: 'serves_2' }])).toBe(2);
    });

    it('item 15: S5 qty2 + S2 qty3 of the SAME recipe stays two tier-distinct rows', async () => {
        const result = await run([
            { bundle_id: S5, quantity: 2, variant_size: 'serves_5' },
            { bundle_id: S2, quantity: 3, variant_size: 'serves_2' },
        ]);
        const fajitas = toBatchItems(result).filter(i => i.name === 'Chicken Fajitas');
        expect(fajitas).toHaveLength(2);
        expect(fajitas.find(i => i.variantSize === 'serves_5')!.copies).toBe(2);
        expect(fajitas.find(i => i.variantSize === 'serves_2')!.copies).toBe(3);
        // And the ambiguous collapse (5 labels at one tier) is NOT what happens.
        expect(fajitas.map(i => i.copies)).not.toEqual([5]);
    });

    it('DEFECT (item 16): the per-row action routes mixed-tier recipes through the tier-aware batch surface', () => {
        const src = strip(read(CALC));
        const idx = src.indexOf('Print Labels ({');
        const start = src.lastIndexOf('const physicalCopies', idx);
        const block = src.slice(start, idx + 40);
        // It must consult how many tiers this recipe spans...
        expect(block).toMatch(/distinctTierCount|tierCount|mixedTier/);
        // ...and must not hand a summed count to the single-tier Label Designer.
        expect(block).toMatch(/print-batch|writePrintBatch/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART F / items 13-14 — the other live writer and the reader stay compatible.
// ═════════════════════════════════════════════════════════════════════════════
describe('PrepList and the print-batch reader use the same authority', () => {
    it('item 13: a PrepList-shaped batch round-trips through the shared helper', () => {
        installStorage();
        const prepListBatch: PrintBatchPayload = {
            name: 'Production: Clean Eating/Paleo',
            items: [{ name: 'Chicken Fajitas', id: 'rec-cf', qty: 3, unit: 'ea', copies: 3, servingTier: 'Serves 2' }],
            businessId: 'biz-a',
        };
        expect(writePrintBatch(prepListBatch).ok).toBe(true);
        const back = readPrintBatch('biz-a');
        expect(back.ok).toBe(true);
        if (back.ok) expect(back.batch.items[0].copies).toBe(3);
    });

    it('DEFECT: PrepList no longer blocks its print click on a client session id', () => {
        const src = strip(read(PREPLIST));
        expect(src).not.toMatch(/if\s*\(\s*!session\?\.\s*user\?\.\s*businessId\s*\)/);
    });

    it('DEFECT (item 14): the reader loads through the shared helper, not a session-gated effect', () => {
        const src = strip(read(READER));
        expect(src).toMatch(/readPrintBatch\(/);
        expect(src).not.toMatch(/if\s*\(\s*!businessId\s*\)\s*return;/);
    });

    it('DEFECT (M8): a missing batch renders a visible message, not an endless "Loading batch..."', () => {
        const src = strip(read(READER));
        // The old unconditional `if (!batch) return <div>Loading batch...</div>`
        // must now distinguish "still loading" from "nothing queued / failed".
        expect(src).toMatch(/batchError/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Items 17/18 — adjacent guarantees stay intact.
// ═════════════════════════════════════════════════════════════════════════════
describe('regression: adjacent authorities untouched', () => {
    it('item 17: the OPS-5 fail-closed ingredient + allergen guards are still in the reader', () => {
        const src = strip(read(READER));
        expect(src).toMatch(/collectBlockedLabels/);
        expect(src).toMatch(/resolveLabelIngredients/);
        expect(src).toMatch(/from ['"]@\/lib\/allergens['"]/);
        expect(src).not.toMatch(/["'`]Ingredients loading/i);
    });

    it('item 18: the OPS-5C Bundle loader is unmodified', () => {
        expect(read('lib/bundleLoader.ts')).toMatch(/export async function loadBundles/);
        const src = strip(read(CALC));
        expect(src).toMatch(/loadBundles\(/);
    });

    it('the physical fan-out in the reader still uses item.copies', () => {
        const src = strip(read(READER));
        expect(src).toMatch(/Math\.max\(1,\s*Math\.round\(item\.copies\s*\|\|\s*1\)\)/);
    });
});
