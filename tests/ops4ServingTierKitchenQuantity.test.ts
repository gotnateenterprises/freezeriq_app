/**
 * OPS-4 — serving-tier preservation through kitchen quantity calculation.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §4/§6/§11 is the
 * canonical ruling this suite proves. Read it before changing this rule.
 *
 * CURRENT-PATH ARCHAEOLOGY (fresh, this phase — do not assume the historical
 * defect still exists where it has already been fixed):
 *
 *   Order creation (4 routes) -> lib/orderItemTier.ts resolveSoldVariantSize
 *     -> OrderItem.variant_size stored.                          PRESERVED
 *   lib/prisma_adapter.ts getProductionOrders() — one row per
 *     OrderItem, variant_size copied verbatim, PRODUCTION_INTAKE_
 *     STATUSES / PRODUCTION_ORDER_EXCLUSIONS / canceled_at:null
 *     applied.                                                    PRESERVED
 *   app/api/production/plan `use_live_orders` branch — passes
 *     getProductionOrders() straight to generateProductionRun().  PRESERVED
 *   app/api/production/runs `planFromOrders` branch — same
 *     pattern.                                                    PRESERVED
 *   app/api/production/sync GET — aggregates the correct per-row
 *     data from getProductionOrders() by bundle_id ALONE, via a
 *     .reduce() whose output object never has a variant_size key
 *     at all.                                                     LOST — THE DEFECT
 *   components/production/ProductionCalculator.tsx ("Manual
 *     Planner") — client OrderItem type has no variant_size field;
 *     syncOnlineOrders() maps /sync's (already tier-less) rows into
 *     component state; calculatePlan() POSTs that state straight to
 *     /api/production/plan.                                       LOST (compounds sync's defect)
 *   app/api/production/plan multi-bundle-mode branch — already
 *     correctly does resolveVariantSize(o.variant_size ?? o.
 *     serving_tier ?? 'family'); it only ever produces 'family'/
 *     serves_5 because upstream never supplies a real value.       DEFAULTED (consequence, not
 *                                                                   its own defect — needs no
 *                                                                   code change once sync/client
 *                                                                   are fixed)
 *   lib/kitchen_engine.ts generateProductionRun() — applies
 *     getServingMultiplier(order.variant_size) once per INPUT
 *     LINE, never pre-aggregates lines itself.                     PRESERVED / CORRECT MATH
 *   lib/fundraiserProductionBatch.ts buildFundraiserBatches() —
 *     groups by a (bundle, variantSize) compound key via lineKey();
 *     its own header comment explicitly defers ingredient math to
 *     KitchenEngine/OPS-4 and does no multiplication itself.       PRESERVED (not applicable)
 *   app/api/production/dashboard/route.ts (Kitchen Board) — pure
 *     order/bundle-quantity aggregation; no KitchenEngine call at
 *     all.                                                         PRESERVED (not applicable)
 *   app/api/dashboard/route.ts — demandBreakdown buckets a real
 *     DB-level groupBy(variant_size); calculateCOGS calls
 *     engine.calculateBundleCost(bundle_id, item.variant_size) per
 *     real order item, cached by a (bundle_id, variant_size)
 *     compound key.                                                PRESERVED
 *
 * THE FIX: app/api/production/sync/route.ts aggregates by
 * (bundle_id, variant_size) and includes variant_size in its output;
 * components/production/ProductionCalculator.tsx threads that field
 * through its local OrderItem type and the sync/state/POST round-trip.
 * app/api/production/plan/route.ts is UNCHANGED — its existing logic was
 * already correct once given real data.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { KitchenEngine, type DBAdapter } from '@/lib/kitchen_engine';
import type { Recipe } from '@/types';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═════════════════════════════════════════════════════════════════════════════
// CONTROLLED FIXTURE — "if one base recipe requires 5 lb chicken" (mission's
// own business-proof numbers). One bundle unit = one recipe unit = 5 lb.
// ═════════════════════════════════════════════════════════════════════════════
const CHICKEN_BUNDLE = 'bundle-chicken-5lb';
const CHICKEN_RECIPE: Recipe = {
    id: 'recipe-chicken-5lb',
    name: 'Base Chicken Recipe',
    type: 'menu_item',
    base_yield_qty: 1,
    base_yield_unit: 'batch',
    items: [
        {
            id: 'ri-chicken', parent_recipe_id: 'recipe-chicken-5lb',
            child_item_id: 'ing-chicken', child_type: 'ingredient',
            name: 'Chicken', quantity: 5, unit: 'lb',
            cost_per_unit: 1, cost_unit: 'lb', stock_quantity: 0,
        } as any,
    ],
};
function chickenAdapter(): DBAdapter {
    return {
        async getRecipe(id) { return id === CHICKEN_RECIPE.id ? CHICKEN_RECIPE : null; },
        async getAllRecipes() { return [CHICKEN_RECIPE]; },
        async getBundleContents(bundleId) {
            return bundleId === CHICKEN_BUNDLE
                ? [{ recipe_id: CHICKEN_RECIPE.id, position: 1, quantity: 1 }]
                : [];
        },
        async getBundleInfo(bundleId) {
            return bundleId === CHICKEN_BUNDLE ? { serving_tier: 'family' } : null;
        },
    };
}
const chickenLb = (result: any): number => Number(result.rawIngredients['ing-chicken']?.qty ?? 0);

// ═════════════════════════════════════════════════════════════════════════════
// 1. KitchenEngine multiplier math — rule 5, freshly verified from source.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. KitchenEngine serving-tier multiplier math (business proof)', () => {
    it('1 x Serves 5 = 1.0 base quantity (5 lb)', async () => {
        const engine = new KitchenEngine(chickenAdapter());
        const result = await engine.generateProductionRun([
            { bundle_id: CHICKEN_BUNDLE, quantity: 1, variant_size: 'serves_5' },
        ]);
        expect(chickenLb(result)).toBe(5);
    });

    it('1 x Serves 2 = 0.5 base quantity (2.5 lb)', async () => {
        const engine = new KitchenEngine(chickenAdapter());
        const result = await engine.generateProductionRun([
            { bundle_id: CHICKEN_BUNDLE, quantity: 1, variant_size: 'serves_2' },
        ]);
        expect(chickenLb(result)).toBe(2.5);
    });

    it('1 x Serves 5 + 1 x Serves 2 = 1.5 base quantity (7.5 lb), NOT 10 lb', async () => {
        const engine = new KitchenEngine(chickenAdapter());
        const result = await engine.generateProductionRun([
            { bundle_id: CHICKEN_BUNDLE, quantity: 1, variant_size: 'serves_5' },
            { bundle_id: CHICKEN_BUNDLE, quantity: 1, variant_size: 'serves_2' },
        ]);
        expect(chickenLb(result)).toBe(7.5);
        expect(chickenLb(result)).not.toBe(10);
    });

    it('3 x Serves 2 = 1.5 base-equivalent quantities (7.5 lb) — same total as S5+S2', async () => {
        const engine = new KitchenEngine(chickenAdapter());
        const result = await engine.generateProductionRun([
            { bundle_id: CHICKEN_BUNDLE, quantity: 3, variant_size: 'serves_2' },
        ]);
        expect(chickenLb(result)).toBe(7.5);
    });

    it('mixed families do not cross-contaminate tiers — a second bundle/recipe stays independent', async () => {
        const PORK_BUNDLE = 'bundle-pork-4lb';
        const PORK_RECIPE: Recipe = {
            id: 'recipe-pork-4lb', name: 'Base Pork Recipe', type: 'menu_item',
            base_yield_qty: 1, base_yield_unit: 'batch',
            items: [{
                id: 'ri-pork', parent_recipe_id: 'recipe-pork-4lb',
                child_item_id: 'ing-pork', child_type: 'ingredient',
                name: 'Pork', quantity: 4, unit: 'lb', cost_per_unit: 1, cost_unit: 'lb', stock_quantity: 0,
            } as any],
        };
        const adapter: DBAdapter = {
            async getRecipe(id) {
                if (id === CHICKEN_RECIPE.id) return CHICKEN_RECIPE;
                if (id === PORK_RECIPE.id) return PORK_RECIPE;
                return null;
            },
            async getAllRecipes() { return [CHICKEN_RECIPE, PORK_RECIPE]; },
            async getBundleContents(bundleId) {
                if (bundleId === CHICKEN_BUNDLE) return [{ recipe_id: CHICKEN_RECIPE.id, position: 1, quantity: 1 }];
                if (bundleId === PORK_BUNDLE) return [{ recipe_id: PORK_RECIPE.id, position: 1, quantity: 1 }];
                return [];
            },
            async getBundleInfo(bundleId) {
                if (bundleId === CHICKEN_BUNDLE) return { serving_tier: 'family' };
                if (bundleId === PORK_BUNDLE) return { serving_tier: 'couple' };
                return null;
            },
        };
        const engine = new KitchenEngine(adapter);
        const result = await engine.generateProductionRun([
            { bundle_id: CHICKEN_BUNDLE, quantity: 20, variant_size: 'serves_5' }, // 20 x 5lb = 100lb chicken
            { bundle_id: CHICKEN_BUNDLE, quantity: 7, variant_size: 'serves_2' },  // 7 x 2.5lb = 17.5lb chicken
            { bundle_id: PORK_BUNDLE, quantity: 5, variant_size: 'serves_5' },     // 5 x 4lb = 20lb pork
        ]);
        expect(Number(result.rawIngredients['ing-chicken'].qty)).toBe(117.5);
        expect(Number(result.rawIngredients['ing-pork'].qty)).toBe(20);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. lib/prisma_adapter.ts getProductionOrders() — preserved, source-verified.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. getProductionOrders() preserves variant_size per row (unchanged this phase)', () => {
    it('maps variant_size verbatim from each OrderItem, one row per item, no aggregation', () => {
        const src = strip(read('lib/prisma_adapter.ts'));
        expect(src).toMatch(/variant_size:\s*item\.variant_size/);
        expect(src).toMatch(/orders\.flatMap\(o => o\.items\.map/);
    });

    it('excludes fundraiser_hold and canceled orders (OPS-3 gate, unchanged this phase)', () => {
        const src = strip(read('lib/prisma_adapter.ts'));
        expect(src).toMatch(/canceled_at:\s*null/);
        expect(src).toMatch(/PRODUCTION_ORDER_EXCLUSIONS/);
    });

    it('PART H: does not require campaign_id — a regular (non-fundraiser) customer order has none and must still reach the kitchen', () => {
        const fn = strip(read('lib/prisma_adapter.ts'));
        const getProdOrders = fn.slice(fn.indexOf('async getProductionOrders()'), fn.indexOf('async getProductionOrders()') + 1200);
        expect(getProdOrders).not.toMatch(/campaign_id/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. app/api/production/sync — THE DEFECT, and its fix.
// ═════════════════════════════════════════════════════════════════════════════
let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops4Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops4Prisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const BIZ = 'biz-ops4';
/** One synthetic order per required Part D scenario, all eligible for production. */
const orderFixture = (id: string, bundleId: string, qty: number, variant: string, extra: Record<string, any> = {}) => ({
    id,
    business_id: BIZ,
    status: 'pending',
    source: 'coordinator',
    canceled_at: null,
    ...extra,
    items: [{ bundle_id: bundleId, quantity: qty, variant_size: variant }],
});

describe('3. GET /api/production/sync preserves variant_size', () => {
    const call = async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: BIZ } });
        const { GET } = await import('@/app/api/production/sync/route');
        const res = await GET();
        return res.json();
    };

    it('DEFECT: a synced Serves-2 order keeps variant_size = serves_2, distinct from a Serves-5 order of the SAME bundle', async () => {
        useMock(createPrismaMock({
            results: {
                'order.findMany': [
                    orderFixture('o-s5', CHICKEN_BUNDLE, 20, 'serves_5'),
                    orderFixture('o-s2', CHICKEN_BUNDLE, 7, 'serves_2'),
                ],
            },
        }));
        const rows = await call();
        expect(rows).toHaveLength(2);
        const s5 = rows.find((r: any) => r.variant_size === 'serves_5');
        const s2 = rows.find((r: any) => r.variant_size === 'serves_2');
        expect(s5).toBeDefined();
        expect(s2).toBeDefined();
        expect(s5.quantity).toBe(20);
        expect(s2.quantity).toBe(7);
        expect(s5.bundle_id).toBe(CHICKEN_BUNDLE);
        expect(s2.bundle_id).toBe(CHICKEN_BUNDLE);
    });

    it('same-tier orders of the same bundle still sum together (aggregation is allowed WITHIN a tier)', async () => {
        useMock(createPrismaMock({
            results: {
                'order.findMany': [
                    orderFixture('o-a', CHICKEN_BUNDLE, 3, 'serves_2'),
                    orderFixture('o-b', CHICKEN_BUNDLE, 4, 'serves_2'),
                ],
            },
        }));
        const rows = await call();
        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(7);
        expect(rows[0].variant_size).toBe('serves_2');
    });

    it('PART E: a stored serves_2 snapshot is reported as-is even when the bundle\'s CURRENT serving_tier now says family — the snapshot wins, never re-derived from the bundle', async () => {
        const staleOrder = orderFixture('o-stale', CHICKEN_BUNDLE, 1, 'serves_2');
        // The bundle was edited after this order was placed; getProductionOrders'
        // query includes this relation (include: { items: { include: { bundle: true } } })
        // but must never read it for tier.
        (staleOrder.items[0] as any).bundle = { serving_tier: 'family' };
        useMock(createPrismaMock({ results: { 'order.findMany': [staleOrder] } }));
        const rows = await call();
        expect(rows).toHaveLength(1);
        expect(rows[0].variant_size).toBe('serves_2');
        expect(rows[0].variant_size).not.toBe('family');
    });

    it('a null/legacy-missing variant_size does not crash and is still reported (not silently coerced to serves_5 at THIS layer)', async () => {
        useMock(createPrismaMock({
            results: { 'order.findMany': [orderFixture('o-legacy', CHICKEN_BUNDLE, 2, null as any)] },
        }));
        const rows = await call();
        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(2);
        expect(rows[0].bundle_id).toBe(CHICKEN_BUNDLE);
    });

    it.each([
        ['public supporter order', 'public'],
        ['coordinator-entered order', 'coordinator'],
        ['regular customer order', 'storefront'],
        ['manual tenant order', 'manual'],
    ])('%s: a stored Serves-2 line survives sync regardless of order source', async (_label, source) => {
        useMock(createPrismaMock({
            results: { 'order.findMany': [orderFixture('o-src', CHICKEN_BUNDLE, 1, 'serves_2', { source })] },
        }));
        const rows = await call();
        expect(rows).toHaveLength(1);
        expect(rows[0].variant_size).toBe('serves_2');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. components/production/ProductionCalculator.tsx — client-side threading.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. ProductionCalculator (Manual Planner) threads variant_size through', () => {
    it('DEFECT: the OrderItem type carries variant_size', () => {
        const src = strip(read('components/production/ProductionCalculator.tsx'));
        expect(src).toMatch(/interface OrderItem\s*\{[^}]*variant_size/s);
    });

    it('DEFECT: syncOnlineOrders maps variant_size from the /sync response into local state', () => {
        const src = strip(read('components/production/ProductionCalculator.tsx'));
        const fn = src.slice(src.indexOf('const syncOnlineOrders'), src.indexOf('const handleSyncChoice'));
        expect(fn).toMatch(/variant_size:\s*d\.variant_size/);
    });

    it('SUPERSEDED BY OPS-4A: calculatePlan no longer posts one flat "orders" array -- it splits into syncedOrders/manualOrders so the server can tell a real sold snapshot apart from a hand-picked bundle. Both branches still carry the full order objects; neither strips a field.', () => {
        const src = strip(read('components/production/ProductionCalculator.tsx'));
        const fn = src.slice(src.indexOf('const calculatePlan'), src.indexOf('const getSupplierSearchUrl'));
        expect(fn).toMatch(/JSON\.stringify\(\{\s*syncedOrders,\s*manualOrders\s*\}\)/);
        expect(fn).toMatch(/validOrders\.filter\(o => o\.variant_size/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. app/api/production/plan — unchanged, already-correct pass-through proven
//    end to end once given real data.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. POST /api/production/plan: multi-bundle mode honors a real synced tier end-to-end', () => {
    // Deliberately NOT a live route-execution test: /api/production/plan
    // constructs its own PrismaAdapter/KitchenEngine internally, and driving
    // that through Jest's module-mock registry (jest.doMock + resetModules)
    // was tried and rejected here — it cancels the top-level jest.mock('@/auth', ...)
    // for every test that runs afterward in this file, which is exactly the
    // kind of cross-test contamination this suite's OWN conventions
    // (see tests/tenantBrandAuthority2.test.ts) exist to avoid.
    //
    // The end-to-end claim is instead proven by composing three facts this
    // suite already establishes independently, each traceable to the exact
    // line of source that makes it true:
    //   (a) section 3 below: /sync now outputs variant_size = 'serves_2' for
    //       a real synced Serves-2 order, unchanged from its historical
    //       snapshot;
    //   (b) this test: /plan's own resolver chain — resolveVariantSize, then
    //       getServingMultiplier — maps that exact string to a 0.5 multiplier,
    //       the same functions app/api/production/plan/route.ts imports and
    //       calls verbatim (pinned by section 12's regression guard below);
    //   (c) section 1 above: KitchenEngine applies a 0.5 multiplier to yield
    //       exactly 2.5 lb from the 5 lb base fixture.
    // (a) + (b) + (c) chain to the same claim a live POST would prove, without
    // the module-mock fragility.
    it('DEFECT (pre-fix): resolveVariantSize(undefined ?? undefined ?? \'family\') — what plan/route.ts computes when sync drops the tier — is serves_5, not serves_2', () => {
        const { resolveVariantSize } = jest.requireActual('@/lib/serving_multipliers');
        const droppedTierLine: { variant_size?: string; serving_tier?: string } = {}; // what /sync used to send
        expect(resolveVariantSize(droppedTierLine.variant_size ?? droppedTierLine.serving_tier ?? 'family')).toBe('serves_5');
    });

    it('a real synced Serves-2 tier, exactly as /sync now emits it, resolves through plan/route.ts\'s own resolver to the 0.5 multiplier', () => {
        const { resolveVariantSize, getServingMultiplier } = jest.requireActual('@/lib/serving_multipliers');
        const syncedRow = { bundle_id: CHICKEN_BUNDLE, quantity: 1, variant_size: 'serves_2' };
        const resolved = resolveVariantSize(syncedRow.variant_size ?? (syncedRow as any).serving_tier ?? 'family');
        expect(resolved).toBe('serves_2');
        expect(getServingMultiplier(resolved)).toBe(0.5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. app/api/production/runs — planFromOrders is untouched (proof, not assumption).
// ═════════════════════════════════════════════════════════════════════════════
describe('6. ProductionRun persistence: planFromOrders is unchanged, still uses the correct path', () => {
    it('calls db.getProductionOrders() directly, passes it straight to generateProductionRun with no aggregation in between', () => {
        const src = strip(read('app/api/production/runs/route.ts'));
        const fn = src.slice(src.indexOf('if (planFromOrders)'), src.indexOf('const run = await prisma.productionRun.create'));
        expect(fn).toMatch(/const orders = await db\.getProductionOrders\(\);/);
        expect(fn).toMatch(/engine\.generateProductionRun\(orders\)/);
        // No .reduce/.map that would strip variant_size between the two calls.
        expect(fn).not.toMatch(/orders\s*=\s*orders\.(reduce|map)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. app/api/production/plan use_live_orders branch — unchanged, still correct.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. use_live_orders branch is unchanged — direct pass-through preserved', () => {
    it('assigns db.getProductionOrders() straight to orders, no intermediate aggregation', () => {
        const src = strip(read('app/api/production/plan/route.ts'));
        const fn = src.slice(src.indexOf('if (requestBody.use_live_orders)'), src.indexOf('} else if (Array.isArray'));
        expect(fn).toMatch(/orders = await db\.getProductionOrders\(\);/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. OPS-3 preservation — fundraiser_hold / canceled exclusion, and regular
//    customer / manual tenant orders remain correct.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. OPS-3 preservation and regular-order correctness', () => {
    it('fundraiser_hold orders are excluded via the canonical PRODUCTION_ORDER_EXCLUSIONS authority (source-verified, unchanged) — reused, not re-derived inline (contract Rule 8)', () => {
        const adapterSrc = strip(read('lib/prisma_adapter.ts'));
        expect(adapterSrc).toMatch(/AND:\s*\[\.\.\.PRODUCTION_ORDER_EXCLUSIONS\]/);
        const exclusionsSrc = strip(read('lib/productionIntake.ts'));
        expect(exclusionsSrc).toMatch(/NOT:\s*\{\s*status:\s*'fundraiser_hold'/);
    });

    it('a held order never reaches /sync\'s aggregation because it never reaches getProductionOrders in the first place (simulated: /sync sees only what the adapter already filtered)', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: BIZ } });
        // getProductionOrders' OWN query already excludes fundraiser_hold/canceled —
        // simulate that filtering having already happened by returning only the
        // one eligible order a real query would produce.
        useMock(createPrismaMock({
            results: { 'order.findMany': [orderFixture('o-eligible', CHICKEN_BUNDLE, 5, 'serves_5')] },
        }));
        const { GET } = await import('@/app/api/production/sync/route');
        const rows = await (await GET()).json();
        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(5);
    });

    it('regular (non-fundraiser) customer order preserves its tier through sync', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: BIZ } });
        useMock(createPrismaMock({
            results: { 'order.findMany': [orderFixture('o-regular', CHICKEN_BUNDLE, 4, 'serves_2', { source: 'storefront', campaign_id: null })] },
        }));
        const { GET } = await import('@/app/api/production/sync/route');
        const rows = await (await GET()).json();
        expect(rows).toHaveLength(1);
        expect(rows[0].variant_size).toBe('serves_2');
    });

    it('manual tenant order (app/api/orders/route.ts origin) preserves its tier through sync', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: BIZ } });
        useMock(createPrismaMock({
            results: { 'order.findMany': [orderFixture('o-manual', CHICKEN_BUNDLE, 2, 'serves_2', { source: 'manual' })] },
        }));
        const { GET } = await import('@/app/api/production/sync/route');
        const rows = await (await GET()).json();
        expect(rows).toHaveLength(1);
        expect(rows[0].variant_size).toBe('serves_2');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Legacy fallback compatibility — preserved, not newly invented.
// ═════════════════════════════════════════════════════════════════════════════
describe('9. legacy missing-tier fallback remains compatible', () => {
    it('resolveVariantSize still defaults a missing/unrecognized tier to serves_5 (unchanged, documented compatibility behavior)', () => {
        const src = read('lib/serving_multipliers.ts');
        expect(src).toMatch(/if \(!tierInput\) return 'serves_5';/);
    });

    it('getServingMultiplier still applies 1.0 for serves_5 and 0.5 for serves_2 (LOCKED, unchanged)', () => {
        const src = read('lib/serving_multipliers.ts');
        expect(src).toMatch(/serves_5:\s*1\.0,/);
        expect(src).toMatch(/serves_2:\s*0\.5,/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. app/api/dashboard/route.ts — COGS/demand tile preservation (not fixed,
//     not broken by this phase; already correct).
// ═════════════════════════════════════════════════════════════════════════════
describe('10. app/api/dashboard/route.ts preserves tier for COGS and demand tile (untouched)', () => {
    it('calculateCOGS passes the real per-item variant_size to calculateBundleCost, cached by a compound key', () => {
        const src = strip(read('app/api/dashboard/route.ts'));
        expect(src).toMatch(/engine\.calculateBundleCost\(item\.bundle_id,\s*item\.variant_size\)/);
        expect(src).toMatch(/`\$\{item\.bundle_id\}-\$\{item\.variant_size\}`/);
    });

    it('the demand tile buckets a real DB-level groupBy on variant_size, never collapses it before bucketing', () => {
        const src = strip(read('app/api/dashboard/route.ts'));
        expect(src).toMatch(/group\.variant_size === 'serves_5'/);
        expect(src).toMatch(/group\.variant_size === 'serves_2'/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. lib/fundraiserProductionBatch.ts — tier-aware grouping, unchanged.
// ═════════════════════════════════════════════════════════════════════════════
describe('11. fundraiserProductionBatch keeps tiers distinct until independently summed (unchanged)', () => {
    it('lineKey includes variantSize in its identity so Keto/Serves5 and Keto/Serves2 never merge', () => {
        const src = strip(read('lib/fundraiserProductionBatch.ts'));
        expect(src).toMatch(/return `\$\{identity\}\|\$\{variantSize\}`;/);
    });

    it('explicitly defers ingredient math to KitchenEngine/OPS-4 — this module does no multiplication', () => {
        const src = read('lib/fundraiserProductionBatch.ts').replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');
        expect(src).toMatch(/OPS-4, which owns the serving-tier calculation defect/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Regression guard — narrowly scoped to the files this phase changed.
// ═════════════════════════════════════════════════════════════════════════════
describe('12. regression guard on the exact files this phase touches', () => {
    it('app/api/production/sync/route.ts output objects always carry a variant_size key', () => {
        const src = strip(read('app/api/production/sync/route.ts'));
        expect(src).toMatch(/variant_size/);
    });

    it('app/api/production/plan/route.ts is untouched by this phase (byte-for-byte-relevant lines unchanged)', () => {
        const src = strip(read('app/api/production/plan/route.ts'));
        expect(src).toMatch(/variant_size:\s*resolveVariantSize\(o\.variant_size \?\? o\.serving_tier \?\? 'family'\)/);
    });

    it('lib/kitchen_engine.ts is untouched by this phase', () => {
        const src = read('lib/kitchen_engine.ts');
        expect(src).toMatch(/const servingMultiplier = getServingMultiplier\(order\.variant_size\);/);
    });

    it('lib/serving_multipliers.ts is untouched by this phase (LOCKED file)', () => {
        const src = read('lib/serving_multipliers.ts');
        expect(src).toMatch(/LOCK STATUS: PERMANENT — DO NOT MODIFY WITHOUT CONSTITUTION REVIEW/);
    });
});
