/**
 * OPS-5F — final print-label closeout: trailing blank page, allergen display,
 * and stored-batch tenant isolation.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7/§11.
 *
 * THREE OWNER-VERIFIED ITEMS, freshly traced (not assumed) at 6c412aa:
 *
 * A. TRAILING BLANK PAGE. The 15-label run printed 16 sheets; page 16 was
 *    blank. Cause: `.print-page { break-after: always; page-break-after:
 *    always; }` applied to EVERY label including the last, so the browser
 *    emitted an empty trailing sheet. The label count was never wrong.
 *
 * B. "None Confirmed". Apple Rosemary Pork printed an allergen box reading
 *    "None Confirmed" while another meal with no allergens printed no box.
 *    Cause: "None Confirmed" is a STORED Recipe.allergens value written by
 *    the authoring-time classifier (app/api/recipes/detect-allergens), and
 *    resolveLabelAllergens returns a stored review verbatim. The renderer
 *    shows a box for any non-empty string. Owner ruling: allergens present ->
 *    show them; none identified -> show nothing.
 *
 * C. TENANT ISOLATION. OPS-5E moved the print batch to one fixed localStorage
 *    key with an ADVISORY ownership field, so a missing id never blocked a
 *    read. localStorage is per-browser: after Tenant A builds a batch, logs
 *    out, and Tenant B logs in, that batch is still there. OPS-5F makes
 *    ownership verification strict and sources the current tenant from the
 *    SERVER (/api/tenant/identity), because OPS-5B/5C/5E each traced a
 *    production failure to useSession().user.businessId being absent -- a
 *    value that unreliable cannot carry a security decision.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    readPrintBatch,
    writePrintBatch,
    fetchAuthenticatedBusinessId,
    PRINT_BATCH_STORAGE_KEY,
    type PrintBatchPayload,
} from '@/lib/printBatchStorage';
import { labelAllergenDisplay, resolveLabelAllergens } from '@/lib/allergens';
import { collectBlockedLabels } from '@/lib/mealLabel';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PRINT_PAGE = 'app/production/print-batch/page.tsx';
const CALC = 'components/production/ProductionCalculator.tsx';
const PREPLIST = 'components/production/PrepList.tsx';

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

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

const BATCH = (over: Partial<PrintBatchPayload> = {}): PrintBatchPayload => ({
    name: 'Batch - test',
    items: [{ name: 'Chicken Fajitas', id: 'rec-cf', qty: 3, unit: 'meals', copies: 3, variantSize: 'serves_2', servingTier: 'Serves 2' }],
    servingTier: 'Serves 2',
    businessId: TENANT_A,
    ...over,
});

// ═════════════════════════════════════════════════════════════════════════════
// PART B/C — the trailing blank sheet (items 1-5).
//
// Jest cannot count browser-generated sheets, so this asserts the exact CSS
// mechanism that produces them: a forced break after EVERY page vs. after
// every page EXCEPT the last. Owner visual print preview remains final
// acceptance (Part M).
// ═════════════════════════════════════════════════════════════════════════════
describe('the print sheet count has no trailing blank page', () => {
    const css = () => {
        const src = read(PRINT_PAGE);
        const start = src.indexOf('@media print');
        const end = src.indexOf('`', start);
        return src.slice(start, end);
    };

    it('DEFECT: the LAST label does not force a page break after itself', () => {
        expect(css()).toMatch(/\.print-page:last-child\s*\{[^}]*break-after:\s*auto/);
        expect(css()).toMatch(/\.print-page:last-child\s*\{[^}]*page-break-after:\s*auto/);
    });

    it('every OTHER label still breaks, so labels never share a sheet', () => {
        expect(css()).toMatch(/\.print-page\s*\{[^}]*break-after:\s*always/);
        expect(css()).toMatch(/\.print-page\s*\{[^}]*page-break-after:\s*always/);
    });

    it('the last-child rule out-specifies the general rule (2 classes vs 1), so order cannot defeat it', () => {
        // `.print-page:last-child` = (0,2,0); `.print-page` = (0,1,0).
        const c = css();
        expect(c.indexOf('.print-page:last-child')).toBeGreaterThan(-1);
        expect(c.indexOf('.print-page {')).toBeGreaterThan(-1);
    });

    it('item 4/5: the fix does not hide or shrink the final label', () => {
        const c = css();
        // No display:none, visibility:hidden, or zero-height applied to the last page.
        const lastRule = c.slice(c.indexOf('.print-page:last-child'), c.indexOf('}', c.indexOf('.print-page:last-child')));
        expect(lastRule).not.toMatch(/display:\s*none/);
        expect(lastRule).not.toMatch(/visibility:\s*hidden/);
        expect(lastRule).not.toMatch(/height:\s*0/);
        expect(lastRule).not.toMatch(/content-visibility/);
    });

    it('items 1-3: the label fan-out itself is untouched -- N labels still produce N pages', () => {
        const src = strip(read(PRINT_PAGE));
        expect(src).toMatch(/Math\.max\(1,\s*Math\.round\(item\.copies\s*\|\|\s*1\)\)/);
        expect(src).toMatch(/Array\.from\(\{\s*length:\s*copies\s*\}\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D/E — allergen display, one presentation rule (items 6-12).
// ═════════════════════════════════════════════════════════════════════════════
describe('allergen display follows the owner ruling exactly', () => {
    it('item 6: a real allergen is shown', () => {
        expect(labelAllergenDisplay('Dairy')).toBe('Dairy');
    });

    it('item 7: multiple allergens are listed unchanged', () => {
        expect(labelAllergenDisplay('Dairy, Wheat, Soy')).toBe('Dairy, Wheat, Soy');
    });

    it('item 8/9: DEFECT -- "None Confirmed" renders nothing', () => {
        expect(labelAllergenDisplay('None Confirmed')).toBe('');
        expect(labelAllergenDisplay('none confirmed')).toBe('');
        expect(labelAllergenDisplay('  None Confirmed  ')).toBe('');
    });

    it('item 8: other no-allergen phrasings also render nothing', () => {
        for (const phrase of ['None', 'none', 'None Identified', 'No Allergens', 'N/A', 'na', '-']) {
            expect(labelAllergenDisplay(phrase)).toBe('');
        }
    });

    it('item 10: an empty or absent value renders nothing (no empty box)', () => {
        expect(labelAllergenDisplay('')).toBe('');
        expect(labelAllergenDisplay('   ')).toBe('');
        expect(labelAllergenDisplay(null)).toBe('');
        expect(labelAllergenDisplay(undefined)).toBe('');
    });

    it('a real allergen that merely CONTAINS a sentinel word is still shown', () => {
        // Guard against an over-broad substring rule.
        expect(labelAllergenDisplay('Nonefat Milk')).toBe('Nonefat Milk');
        expect(labelAllergenDisplay('Dairy, None Confirmed')).toBe('Dairy, None Confirmed');
    });

    it('item 12: stored tenant-reviewed precedence over keyword detection is unchanged', () => {
        // resolveLabelAllergens still returns the stored review verbatim...
        expect(resolveLabelAllergens('Dairy', 'peanut butter')).toBe('Dairy');
        expect(resolveLabelAllergens('None Confirmed', 'peanut butter')).toBe('None Confirmed');
        // ...and only the PRESENTATION layer collapses the no-allergen sentinel.
        expect(labelAllergenDisplay(resolveLabelAllergens('None Confirmed', 'peanut butter'))).toBe('');
        // Falls back to keyword detection when nothing is stored.
        expect(resolveLabelAllergens('', 'whole milk')).toBe('Dairy');
    });

    it('the print page renders through the display rule, not the raw resolved value', () => {
        const src = strip(read(PRINT_PAGE));
        expect(src).toMatch(/allergens:\s*labelAllergenDisplay\(/);
        expect(src).not.toMatch(/allergens:\s*detail\.processedAllergens\s*\|\|\s*""/);
    });

    it('the authoring-time classifier is untouched -- "None Confirmed" is still the right thing to STORE', () => {
        const src = read('app/api/recipes/detect-allergens/route.ts');
        expect(src).toMatch(/None Confirmed/);
    });
});

describe('an allergen/ingredient data FAILURE never looks like "no allergens"', () => {
    it('item 11: a meal whose ingredients failed to load still blocks the print run', () => {
        const blocked = collectBlockedLabels(
            [{ name: 'Chicken Fajitas', id: 'rec-cf' } as any],
            { 'rec-cf': undefined },   // fetch failed -> no ingredient text at all
            true,
        );
        expect(blocked.length).toBe(1);
        expect(blocked[0].name).toBe('Chicken Fajitas');
    });

    it('the fail-closed gate still runs on the print page, ahead of any label render', () => {
        const src = strip(read(PRINT_PAGE));
        expect(src).toMatch(/collectBlockedLabels/);
        expect(src).toMatch(/blockedLabels\.length > 0/);
    });

    it('suppressing the box cannot mask a failure, because a failure renders no labels at all', () => {
        // The blocked branch replaces the entire label list with the DO NOT USE
        // sheet -- getLabelProps (and therefore labelAllergenDisplay) is never
        // reached for a failed batch.
        // Anchor on the PRINTABLE DOM branch, not the button-label ternary
        // that also tests blockedLabels.length.
        const src = strip(read(PRINT_PAGE));
        const idx = src.lastIndexOf('blockedLabels.length > 0 ?');
        expect(idx).toBeGreaterThan(-1);
        expect(src.slice(idx, idx + 400)).toMatch(/DO NOT USE/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART F/G/H — stored-batch tenant isolation (items 13-20).
// ═════════════════════════════════════════════════════════════════════════════
describe('a stored print batch is verified against the authenticated tenant', () => {
    it('item 13: Tenant A batch + Tenant A session renders', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: TENANT_A }));
        const result = readPrintBatch(TENANT_A);
        expect(result.ok).toBe(true);
    });

    it('item 14: DEFECT -- Tenant A batch + Tenant B session is REJECTED', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: TENANT_A }));
        const result = readPrintBatch(TENANT_B);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/different business/i);
    });

    it('item 15: DEFECT -- Tenant A batch + MISSING current tenant is REJECTED', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: TENANT_A }));
        for (const missing of [null, undefined, '']) {
            const result = readPrintBatch(missing as any);
            expect(result.ok).toBe(false);
        }
    });

    it('item 16: DEFECT -- a batch with NO stored businessId is REJECTED (legacy/unsafe)', () => {
        const store = installStorage();
        store.set(PRINT_BATCH_STORAGE_KEY, JSON.stringify({ name: 'legacy', items: BATCH().items }));
        const result = readPrintBatch(TENANT_A);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/could not prove which business/i);
    });

    it('item 16: an explicitly null/empty stored owner is also rejected', () => {
        const store = installStorage();
        for (const bad of [null, '', undefined]) {
            store.set(PRINT_BATCH_STORAGE_KEY, JSON.stringify({ name: 'x', items: BATCH().items, businessId: bad }));
            expect(readPrintBatch(TENANT_A).ok).toBe(false);
        }
    });

    it('item 20: a rejected batch yields NO items to the caller -- no partial leakage', () => {
        installStorage();
        writePrintBatch(BATCH({ businessId: TENANT_A }));
        const result = readPrintBatch(TENANT_B);
        expect(result.ok).toBe(false);
        expect((result as any).batch).toBeUndefined();
    });

    it('item 18: the print page DISCARDS a batch that fails verification', () => {
        const src = strip(read(PRINT_PAGE));
        const idx = src.indexOf('if (!result.ok)');
        expect(src.slice(idx, idx + 300)).toMatch(/clearPrintBatch\(\)/);
    });

    it('item 17: nothing renders before verification completes -- batch stays null until proven', () => {
        const src = strip(read(PRINT_PAGE));
        // The read is awaited behind the server identity fetch, inside an async
        // effect, and setBatch is only reached on the ok path.
        expect(src).toMatch(/await fetchAuthenticatedBusinessId\(\)/);
        const effect = src.slice(src.indexOf('await fetchAuthenticatedBusinessId'), src.indexOf('return () => { cancelled = true; };'));
        expect(effect.indexOf('readPrintBatch(')).toBeLessThan(effect.indexOf('setBatch(result.batch'));
    });
});

describe('the current tenant comes from server-authenticated authority, not the client session', () => {
    it('item 19: the print page does NOT pass useSession businessId into the ownership check', () => {
        const src = strip(read(PRINT_PAGE));
        expect(src).not.toMatch(/readPrintBatch\(businessId/);
        expect(src).toMatch(/readPrintBatch\(currentBusinessId\)/);
    });

    it('fetchAuthenticatedBusinessId asks the server endpoint', async () => {
        const calls: string[] = [];
        const id = await fetchAuthenticatedBusinessId((async (url: any) => {
            calls.push(String(url));
            return { ok: true, json: async () => ({ businessId: TENANT_A }) } as any;
        }) as any);
        expect(calls).toEqual(['/api/tenant/identity']);
        expect(id).toBe(TENANT_A);
    });

    it('a 401 yields null -- "cannot verify", never a default tenant', async () => {
        const id = await fetchAuthenticatedBusinessId((async () => ({ ok: false, status: 401, json: async () => ({}) })) as any);
        expect(id).toBeNull();
    });

    it('a network failure yields null rather than throwing', async () => {
        const id = await fetchAuthenticatedBusinessId((async () => { throw new Error('offline'); }) as any);
        expect(id).toBeNull();
    });

    it('a malformed identity response yields null', async () => {
        for (const body of [{}, { businessId: '' }, { businessId: 42 }, null]) {
            const id = await fetchAuthenticatedBusinessId((async () => ({ ok: true, json: async () => body })) as any);
            expect(id).toBeNull();
        }
    });

    it('the identity endpoint is server-authenticated and derives the tenant from the session only', () => {
        const src = strip(read('app/api/tenant/identity/route.ts'));
        expect(src).toMatch(/await auth\(\)/);
        expect(src).toMatch(/status:\s*401/);
        expect(src).toMatch(/session\?\.user as any\)\?\.businessId/);
        // Never from the request.
        expect(src).not.toMatch(/searchParams|req\.json\(\)|headers\.get/);
    });

    it('every writer stamps the batch with the SERVER id, never the client session value', () => {
        for (const f of [CALC, PREPLIST]) {
            const src = strip(read(f));
            expect(src).toMatch(/await fetchAuthenticatedBusinessId\(\)/);
            expect(src).not.toMatch(/businessId:\s*businessId\s*\?\?\s*null/);
            expect(src).not.toMatch(/businessId:\s*session\?\.user\?\.businessId/);
        }
    });

    it('a writer that cannot confirm the tenant refuses visibly rather than writing an unusable batch', () => {
        const src = strip(read(CALC));
        expect(src).toMatch(/if \(!ownerBusinessId\)/);
        expect(src).toMatch(/could not be confirmed/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART J — queue-count wording.
// ═════════════════════════════════════════════════════════════════════════════
describe('the queue header names both numbers truthfully', () => {
    it('distinguishes meal types from physical labels', () => {
        const src = strip(read(PRINT_PAGE));
        expect(src).toMatch(/meal type/);
        expect(src).toMatch(/labels queued/);
        expect(src).not.toMatch(/\{batch\.items\.length\} Labels Queued/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART K — regression (items 21-25).
// ═════════════════════════════════════════════════════════════════════════════
describe('regression: OPS-5D/5E guarantees intact', () => {
    it('items 21/22: a 5x3 Serves-2 batch round-trips with 15 labels, all Serves 2', () => {
        installStorage();
        const items = ['Apple Rosemary Pork', 'Cajun Chicken Dinner', 'Chicken Fajitas', 'Chili - Paleo', 'Italian Pork Chops n Veggies']
            .map((name, i) => ({ name, id: `rec-${i}`, qty: 3, unit: 'meals', copies: 3, variantSize: 'serves_2', servingTier: 'Serves 2' }));
        expect(writePrintBatch({ name: 'b', items, businessId: TENANT_A }).ok).toBe(true);
        const back = readPrintBatch(TENANT_A);
        expect(back.ok).toBe(true);
        if (back.ok) {
            expect(back.batch.items).toHaveLength(5);
            expect(back.batch.items.reduce((s, i) => s + i.copies, 0)).toBe(15);
            expect(back.batch.items.every(i => i.servingTier === 'Serves 2')).toBe(true);
        }
    });

    it('item 23: mixed S2/S5 rows stay split through the round trip', () => {
        installStorage();
        const items = [
            { name: 'Chicken Fajitas', id: 'rec-cf', qty: 2, unit: 'meals', copies: 2, variantSize: 'serves_5', servingTier: 'Serves 5' },
            { name: 'Chicken Fajitas', id: 'rec-cf', qty: 3, unit: 'meals', copies: 3, variantSize: 'serves_2', servingTier: 'Serves 2' },
        ];
        writePrintBatch({ name: 'b', items, businessId: TENANT_A });
        const back = readPrintBatch(TENANT_A);
        expect(back.ok).toBe(true);
        if (back.ok) {
            expect(back.batch.items).toHaveLength(2);
            expect(back.batch.items.find(i => i.variantSize === 'serves_5')!.copies).toBe(2);
            expect(back.batch.items.find(i => i.variantSize === 'serves_2')!.copies).toBe(3);
        }
    });

    it('item 24: the OPS-5C Bundle loader is untouched', () => {
        expect(read('lib/bundleLoader.ts')).toMatch(/export async function loadBundles/);
        expect(strip(read(CALC))).toMatch(/loadBundles\(/);
    });

    it('item 25: the OPS-5E handoff still navigates on a successful write', () => {
        const src = strip(read(CALC));
        expect(src).toMatch(/router\.push\('\/production\/print-batch'\)/);
        // Scoped to the print handoff specifically. `if (businessId)` still
        // legitimately guards the UNRELATED per-tenant localStorage queue
        // clearing (clearQueue/clearAll) -- those namespace a key, they do not
        // gate a navigation, and OPS-5E deliberately left them alone.
        expect(src).not.toMatch(/if\s*\(\s*businessId\s*\)\s*\{[\s\S]{0,400}?router\.push\('\/production\/print-batch'\)/);
        expect(src).not.toMatch(/if\s*\(\s*!\s*businessId\s*\)\s*return;[\s\S]{0,400}?writePrintBatch\(/);
    });

    it('no supporter PII on the label path', () => {
        for (const f of [PRINT_PAGE, 'lib/printBatchStorage.ts']) {
            expect(strip(read(f))).not.toMatch(/purchaserName|supporterName|customerEmail|shipping_address/i);
        }
    });
});
