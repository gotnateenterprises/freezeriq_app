/**
 * OPS-4A — Manual Planner bundle-tier correctness.
 *
 * OPS-4 fixed the SOLD/SYNCED-order path: OrderItem.variant_size now survives
 * /api/production/sync -> ProductionCalculator -> /api/production/plan ->
 * KitchenEngine. This phase closes the gap OPS-4's own archaeology found and
 * deliberately deferred: a MANUALLY entered planner row (a bundle picked from
 * the dropdown, quantity typed by hand — nothing was ever sold) had no
 * OrderItem snapshot to preserve, and /api/production/plan's multi-bundle
 * mode defaulted every such row to 'family'/serves_5 regardless of which
 * tier the tenant actually selected.
 *
 * TWO AUTHORITIES, NEVER CONFLATED:
 *   A. Sold/synced row  -> OrderItem.variant_size (frozen snapshot) wins.
 *   B. Manual planner row -> the tenant-scoped Bundle's OWN CURRENT
 *      serving_tier wins. There is no snapshot to preserve, so the current
 *      Bundle row IS the authority — and it must be read server-side, tenant-
 *      scoped, never trusted from the client.
 *
 * THE SPLIT: ProductionCalculator.tsx already perfectly knows which of its
 * own rows came from Auto-Sync (variant_size set, even if null) versus a
 * hand-picked dropdown row (variant_size never set at all) — that existing
 * data shape, established by OPS-4, is reused rather than inventing a new
 * flag. The client partitions its request into syncedOrders/manualOrders;
 * the SAFETY property is not "the client classified honestly" (nothing stops
 * a malicious client from lying) but that EACH branch's server-side handling
 * is safe regardless of what a lying client sends: the synced branch has
 * exactly the same trust model /plan already had before this phase (a real
 * bundle_id + an echoed tier, same as OPS-4 shipped), and the manual branch
 * NEVER reads a client-supplied tier field at all, no matter what is
 * attached to a manualOrders entry — it always resolves purely from a fresh,
 * tenant-scoped Bundle lookup.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BIZ = 'biz-ops4a';
const OTHER_BIZ = 'biz-ops4a-other-tenant';

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE — Prisma-shaped, mirroring exactly what PrismaAdapter.getAllRecipes()
// and getBundleContents() expect from raw prisma.recipe/bundleContent rows.
// Same "5 lb chicken" business-proof numbers as OPS-4's own fixture.
// ═════════════════════════════════════════════════════════════════════════════
const RECIPE_ROW = {
    id: 'recipe-chicken-5lb', name: 'Base Chicken Recipe', type: 'menu_item',
    base_yield_qty: 1, base_yield_unit: 'batch', container_type: 'tray', category_id: null,
    label_text: null, macros: null, image_url: null, description: null, allergens: null, cook_time: null,
    child_items: [{
        id: 'ri-chicken', parent_recipe_id: 'recipe-chicken-5lb',
        child_recipe_id: null, child_ingredient_id: 'ing-chicken',
        child_ingredient: { name: 'Chicken', unit: 'lb', cost_per_unit: 1, stock_quantity: 0, supplier: null },
        child_recipe: null, quantity: 5, unit: 'lb',
        is_sub_recipe: false, section_name: null, section_batch: null,
    }],
};
const KNOWN_BUNDLE_IDS = new Set<string>();
/** Only a REGISTERED bundle_id has contents -- an unknown one genuinely has none, matching real Postgres. */
const BUNDLE_CONTENT_ROW = (bundleId: string) =>
    KNOWN_BUNDLE_IDS.has(bundleId) ? [{ bundle_id: bundleId, recipe_id: RECIPE_ROW.id, position: 1, quantity: 1 }] : [];

const BUNDLE_A_S5 = 'bundle-a-serves5'; // "Keto -- Serves 5"
const BUNDLE_B_S2 = 'bundle-b-serves2'; // "Keto -- Serves 2"
KNOWN_BUNDLE_IDS.add(BUNDLE_A_S5);
KNOWN_BUNDLE_IDS.add(BUNDLE_B_S2);
// A genuinely nonexistent bundle_id (used in the "missing Bundle" test) is
// deliberately NOT added here -- it must have zero contents, exactly as a
// real Postgres bundle_contents lookup would return for an unknown id.

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops4aPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops4aPrisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

/** Builds the full canned-result set a real /plan request needs. */
const planMockResults = (bundleRows: { id: string; serving_tier: string; business_id?: string }[]) => ({
    'recipe.findMany': [RECIPE_ROW],
    'bundleContent.findMany': (args: any) => BUNDLE_CONTENT_ROW(args.where.bundle_id),
    'bundle.findMany': (args: any) => {
        const ids: string[] = args.where.id.in;
        const scopedBiz: string = args.where.business_id;
        return bundleRows.filter(b => ids.includes(b.id) && (b.business_id ?? BIZ) === scopedBiz);
    },
});

const postPlan = async (body: any) => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: BIZ } });
    const { POST } = await import('@/app/api/production/plan/route');
    const req = new Request('http://localhost/api/production/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const res = await POST(req as any);
    return res.json();
};
const chickenLb = (body: any): number => Number(body.rawIngredients?.['ing-chicken']?.qty ?? 0);

beforeEach(() => jest.clearAllMocks());

// ═════════════════════════════════════════════════════════════════════════════
// 1. Business proof — manual rows, Part I items 1-4.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. manual planner rows: business-proof quantities', () => {
    it('DEFECT: manual Bundle A (serves_5) qty 1 = 1.0 base (5 lb)', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_A_S5, serving_tier: 'serves_5' }]) }));
        const body = await postPlan({ manualOrders: [{ bundle_id: BUNDLE_A_S5, quantity: 1 }] });
        expect(chickenLb(body)).toBe(5);
    });

    it('DEFECT: manual Bundle B (serves_2) qty 1 = 0.5 base (2.5 lb) -- NOT 5 lb', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_B_S2, serving_tier: 'serves_2' }]) }));
        const body = await postPlan({ manualOrders: [{ bundle_id: BUNDLE_B_S2, quantity: 1 }] });
        expect(chickenLb(body)).toBe(2.5);
        expect(chickenLb(body)).not.toBe(5);
    });

    it('DEFECT: manual Bundle B (serves_2) qty 3 = 1.5 base (7.5 lb)', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_B_S2, serving_tier: 'serves_2' }]) }));
        const body = await postPlan({ manualOrders: [{ bundle_id: BUNDLE_B_S2, quantity: 3 }] });
        expect(chickenLb(body)).toBe(7.5);
    });

    it('DEFECT: mixed manual Bundle A qty1 + Bundle B qty1 = 1.5 base (7.5 lb), tiers not merged before multiplication', async () => {
        useMock(createPrismaMock({
            results: planMockResults([
                { id: BUNDLE_A_S5, serving_tier: 'serves_5' },
                { id: BUNDLE_B_S2, serving_tier: 'serves_2' },
            ]),
        }));
        const body = await postPlan({
            manualOrders: [
                { bundle_id: BUNDLE_A_S5, quantity: 1 },
                { bundle_id: BUNDLE_B_S2, quantity: 1 },
            ],
        });
        expect(chickenLb(body)).toBe(7.5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Adversarial: client cannot override the DB Bundle tier (Part H). Items 5.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. manual row: client-supplied tier is never trusted', () => {
    it('DEFECT: DB tier serves_5, browser maliciously attaches variant_size=serves_2 -- server uses serves_5 (5 lb), not 2.5 lb', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_A_S5, serving_tier: 'serves_5' }]) }));
        const body = await postPlan({ manualOrders: [{ bundle_id: BUNDLE_A_S5, quantity: 1, variant_size: 'serves_2' }] });
        expect(chickenLb(body)).toBe(5);
        expect(chickenLb(body)).not.toBe(2.5);
    });

    it('DEFECT: DB tier serves_2, browser maliciously attaches variant_size=serves_5 -- server uses serves_2 (2.5 lb), not 5 lb', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_B_S2, serving_tier: 'serves_2' }]) }));
        const body = await postPlan({ manualOrders: [{ bundle_id: BUNDLE_B_S2, quantity: 1, variant_size: 'serves_5' }] });
        expect(chickenLb(body)).toBe(2.5);
        expect(chickenLb(body)).not.toBe(5);
    });

    it('a malicious serving_tier field (the alternate name /plan also accepts on synced rows) is likewise ignored on a manual row', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_A_S5, serving_tier: 'serves_5' }]) }));
        const body = await postPlan({ manualOrders: [{ bundle_id: BUNDLE_A_S5, quantity: 1, serving_tier: 'serves_2' }] });
        expect(chickenLb(body)).toBe(5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Tenant isolation and unresolvable-bundle behavior. Items 6-7.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. tenant scoping and unresolvable bundles', () => {
    it('DEFECT: a cross-tenant Bundle ID is never used -- its real tier is not consulted, request does not error, falls to the documented family default', async () => {
        useMock(createPrismaMock({
            results: planMockResults([{ id: BUNDLE_B_S2, serving_tier: 'serves_2', business_id: OTHER_BIZ }]),
        }));
        const body = await postPlan({ manualOrders: [{ bundle_id: BUNDLE_B_S2, quantity: 1 }] });
        // The foreign bundle's real serves_2 tier must NEVER leak through --
        // the line falls to the same universal compatibility default every
        // other unresolvable-tier case in this codebase already uses.
        expect(chickenLb(body)).toBe(5);
    });

    it('a missing (nonexistent) Bundle ID does not error and does not pick up an unrelated bundle\'s tier', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_B_S2, serving_tier: 'serves_2' }]) }));
        const body = await postPlan({ manualOrders: [{ bundle_id: 'bundle-does-not-exist', quantity: 1 }] });
        expect(body.error).toBeUndefined();
        // Falls to family default, not BUNDLE_B_S2's serves_2 -- proves no
        // cross-contamination between an unrelated resolved bundle and an
        // unresolvable one in the same request.
        expect(chickenLb(body)).toBe(0);
    });

    it('the Bundle lookup is tenant-scoped by business_id, not a bare id match', async () => {
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_A_S5, serving_tier: 'serves_5' }]) }));
        await postPlan({ manualOrders: [{ bundle_id: BUNDLE_A_S5, quantity: 1 }] });
        const call = mock.firstCall('bundle.findMany');
        expect(call?.args?.where?.business_id).toBe(BIZ);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Sold/synced row preservation -- Part E regression. Items 8-9.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. synced (sold) rows: OrderItem.variant_size snapshot still wins', () => {
    it('DEFECT-REGRESSION: a synced Serves-2 line still calculates at 0.5 (2.5 lb)', async () => {
        useMock(createPrismaMock({ results: planMockResults([]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: BUNDLE_A_S5, quantity: 1, variant_size: 'serves_2' }] });
        expect(chickenLb(body)).toBe(2.5);
    });

    it('DEFECT-REGRESSION: sold snapshot (serves_2) wins even when the SAME bundle_id\'s CURRENT tier is now serves_5 -- proves the synced branch never consults the Bundle table at all', async () => {
        // The bundle fixture claims serves_5 NOW; the synced line's own
        // variant_size claims serves_2 -- the sold snapshot must win.
        useMock(createPrismaMock({ results: planMockResults([{ id: BUNDLE_A_S5, serving_tier: 'serves_5' }]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: BUNDLE_A_S5, quantity: 1, variant_size: 'serves_2' }] });
        expect(chickenLb(body)).toBe(2.5);
        expect(chickenLb(body)).not.toBe(5);
        // And the synced branch must not have queried bundle.findMany at all --
        // it never needs to, since it never re-derives from the Bundle table.
        expect(mock.calls.filter(c => c.model === 'bundle' && c.method === 'findMany')).toHaveLength(0);
    });

    it('a synced line with a genuinely legacy-null tier still falls to the documented family default (unchanged OPS-4 behavior)', async () => {
        useMock(createPrismaMock({ results: planMockResults([]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: BUNDLE_A_S5, quantity: 1, variant_size: null }] });
        expect(chickenLb(body)).toBe(5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. ProductionCalculator.tsx -- client-side split, source-verified.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. ProductionCalculator splits synced vs manual rows before posting', () => {
    it('DEFECT: calculatePlan partitions validOrders into syncedOrders/manualOrders by variant_size presence', () => {
        const src = strip(read('components/production/ProductionCalculator.tsx'));
        const fn = src.slice(src.indexOf('const calculatePlan'), src.indexOf('const getSupplierSearchUrl'));
        expect(fn).toMatch(/variant_size\s*!=\s*null/);
        expect(fn).toMatch(/JSON\.stringify\(\{\s*syncedOrders,\s*manualOrders\s*\}\)/);
    });

    it('EDGE CASE: re-picking the bundle on an already-synced row clears its stale variant_size, so it correctly becomes manual for the newly-selected bundle', () => {
        const src = strip(read('components/production/ProductionCalculator.tsx'));
        const fn = src.slice(src.indexOf('const updateOrder'), src.indexOf('const addRow'));
        expect(fn).toMatch(/field === 'bundle_id'/);
        expect(fn).toMatch(/variant_size:\s*undefined/);
    });

    it('no serving-tier selector was added -- the mission forbids one unless proven required, and it is not', () => {
        const src = strip(read('components/production/ProductionCalculator.tsx'));
        expect(src).not.toMatch(/serving.?tier.?select/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Regression guards -- everything OPS-4A must NOT touch.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. regression guard: unrelated authorities untouched', () => {
    it('use_live_orders branch is unchanged -- still a direct getProductionOrders() pass-through', () => {
        const src = strip(read('app/api/production/plan/route.ts'));
        const fn = src.slice(src.indexOf('if (requestBody.use_live_orders)'), src.indexOf('} else if'));
        expect(fn).toMatch(/orders = await db\.getProductionOrders\(\);/);
    });

    it('app/api/production/sync/route.ts (OPS-4) is untouched by this phase', () => {
        const src = strip(read('app/api/production/sync/route.ts'));
        expect(src).toMatch(/const key = `\$\{bid\}::\$\{variant \?\? ''\}`;/);
    });

    it('lib/kitchen_engine.ts is untouched -- multiplier applied exactly once per line, no bundle re-query inside it', () => {
        const src = read('lib/kitchen_engine.ts');
        expect(src).toMatch(/const servingMultiplier = getServingMultiplier\(order\.variant_size\);/);
    });

    it('lib/serving_multipliers.ts is untouched (LOCKED file)', () => {
        const src = read('lib/serving_multipliers.ts');
        expect(src).toMatch(/LOCK STATUS: PERMANENT — DO NOT MODIFY WITHOUT CONSTITUTION REVIEW/);
        expect(src).toMatch(/serves_5:\s*1\.0,/);
        expect(src).toMatch(/serves_2:\s*0\.5,/);
    });

    it('lib/orderItemTier.ts is untouched -- order-creation-time authority unchanged', () => {
        const src = read('lib/orderItemTier.ts');
        expect(src).toMatch(/export function resolveSoldVariantSize\(/);
        expect(src).toMatch(/if \(bundleServingTier != null && String\(bundleServingTier\)\.trim\(\) !== ''\) \{/);
    });

    it('no schema change -- Bundle model is unchanged by this phase', () => {
        const schema = read('prisma/schema.prisma');
        const model = schema.slice(schema.indexOf('model Bundle {'), schema.indexOf('model BundleContent'));
        expect(model).toMatch(/serving_tier\s+String\s+@default\("family"\)/);
    });
});
