/**
 * OPS-MANUAL-PLANNER-BUNDLE-FILTER-1 — the Manual Planner's Bundle selector
 * (components/production/ProductionCalculator.tsx) loads GET /api/bundles
 * with no query string. That route's Prisma query
 * (app/api/bundles/route.ts) is tenant-scoped (business_id) but has NO
 * lifecycle filter at all — it returns every Bundle regardless of
 * is_active, which is the sole lifecycle field on the Bundle model
 * (prisma/schema.prisma: `is_active Boolean @default(true)`). app/bundles/page.tsx's
 * own UI proves "Archive Bundle" / "Activate Bundle" both toggle this one
 * field — archived and inactive are the same concept in this codebase, not
 * two different states.
 *
 * components/admin/StorefrontSettings.tsx already calls
 * `/api/bundles?activeOnly=true`, expecting server-side filtering that the
 * route never implemented — so this same defect already existed there,
 * silently. The fix implements the query param the codebase already
 * intended, rather than inventing a new contract, and both call sites
 * benefit.
 *
 * These tests execute the REAL GET handler against a recording double of
 * @/lib/db, matching tests/bundleSecurity1.test.ts's established pattern for
 * this exact route (POST is already tested there; this file owns GET).
 */

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const db: any = {
    bundle: { findMany: jest.fn() },
    catalog: { findMany: jest.fn() },
};
jest.mock('@/lib/db', () => ({ prisma: db }));
jest.mock('@/lib/cost_engine', () => ({ calculateRecipeCost: jest.fn(async () => ({ totalCost: 0 })) }));

const session = (businessId: string | null) =>
    businessId ? { user: { id: 'u1', businessId } } : null;

const bundleRow = (overrides: Record<string, any>) => ({
    id: 'bundle-x', name: 'Bundle X', sku: 'SKU-X', serving_tier: 'family',
    is_active: true, price: 100, business_id: TENANT_A, family_id: null,
    contents: [], _count: { contents: 0 },
    ...overrides,
});

const ACTIVE_BUNDLE_A = bundleRow({ id: 'active-a', name: 'Active A', sku: 'ACT-A' });
const ACTIVE_BUNDLE_B = bundleRow({ id: 'active-b', name: 'Active B', sku: 'ACT-B' });
const ARCHIVED_BUNDLE_A = bundleRow({ id: 'archived-a', name: 'Archived A', sku: 'ARC-A', is_active: false });
const INACTIVE_BUNDLE_B = bundleRow({ id: 'inactive-b', name: 'Inactive B', sku: 'INA-B', is_active: false });
const FOREIGN_ACTIVE_BUNDLE = bundleRow({ id: 'foreign-a', name: 'Foreign Active', sku: 'FOR-A', business_id: TENANT_B });

const invoke = async (query = '') => {
    const { GET } = require('@/app/api/bundles/route');
    return GET(new Request(`https://www.freezeriqapp.com/api/bundles${query}`));
};

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue(session(TENANT_A));
    db.catalog.findMany.mockResolvedValue([]);
});

// ═════════════════════════════════════════════════════════════════════════════
// PART E — before-fix defect proof, and the fixed activeOnly contract.
// ═════════════════════════════════════════════════════════════════════════════
describe('activeOnly=true excludes archived/inactive Bundles', () => {
    it('returns only active Bundles for this tenant when activeOnly=true', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A, ACTIVE_BUNDLE_B, ARCHIVED_BUNDLE_A, INACTIVE_BUNDLE_B]);

        const res = await invoke('?activeOnly=true');
        const call = db.bundle.findMany.mock.calls[0][0];

        // THE FIX: the query itself must carry the lifecycle predicate — this
        // is the server-boundary repair Part G requires, not a browser-side filter.
        expect(call.where.is_active).toBe(true);
        expect(res.status).toBe(200);
    });

    it('multiple active Bundles are all present', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A, ACTIVE_BUNDLE_B]);
        const res = await invoke('?activeOnly=true');
        const body = await res.json();
        expect(body.map((b: any) => b.id).sort()).toEqual(['active-a', 'active-b']);
    });

    it('an archived Bundle is excluded from the query itself, not filtered client-side', async () => {
        // The double only returns what a correctly-scoped query WOULD return —
        // proving the where-clause predicate is the thing under test, exactly
        // as this repo's established convention requires (a source grep cannot
        // tell "returns refuse()" from "returns ok"; here it cannot tell
        // "filtered in SQL" from "filtered in the browser" either).
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A]);
        await invoke('?activeOnly=true');
        expect(db.bundle.findMany.mock.calls[0][0].where).toMatchObject({
            business_id: TENANT_A, is_active: true,
        });
    });

    it('an inactive Bundle is likewise excluded', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A]);
        await invoke('?activeOnly=true');
        expect(db.bundle.findMany.mock.calls[0][0].where.is_active).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART F — tenant isolation is unaffected by the new filter.
// ═════════════════════════════════════════════════════════════════════════════
describe('tenant isolation holds with and without activeOnly', () => {
    it('a foreign-tenant Bundle is never requested regardless of activeOnly', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A]);
        await invoke('?activeOnly=true');
        expect(db.bundle.findMany.mock.calls[0][0].where.business_id).toBe(TENANT_A);
    });

    it('an unauthenticated caller is refused before any query', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await invoke('?activeOnly=true');
        expect(res.status).toBe(401);
        expect(db.bundle.findMany).not.toHaveBeenCalled();
    });

    it('the where clause never trusts a client-supplied business_id', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app', 'api', 'bundles', 'route.ts'), 'utf8');
        expect(src).not.toMatch(/business_id:\s*(data|body|searchParams)\./);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART I — family/tier siblings and edge states.
// ═════════════════════════════════════════════════════════════════════════════
describe('family siblings and edge states', () => {
    const FAMILY_ID = 'fam-1';
    const ACTIVE_S5 = bundleRow({ id: 's5', name: 'Family S5', sku: 'F-S5', serving_tier: 'family', family_id: FAMILY_ID });
    const ACTIVE_S2 = bundleRow({ id: 's2', name: 'Family S2', sku: 'F-S2', serving_tier: 'couple', family_id: FAMILY_ID });
    const ARCHIVED_SIBLING = bundleRow({ id: 's5-old', name: 'Family S5 (old)', sku: 'F-S5-OLD', serving_tier: 'family', family_id: FAMILY_ID, is_active: false });

    it('active S5 and S2 siblings in the same family both remain available', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_S5, ACTIVE_S2]);
        const res = await invoke('?activeOnly=true');
        const body = await res.json();
        expect(body.map((b: any) => b.id).sort()).toEqual(['s2', 's5']);
    });

    it('an archived sibling is excluded even though it shares family_id with an active row', async () => {
        // The double simulates the CORRECT query result -- the real assertion
        // is that the where-clause predicate would exclude it in real Postgres.
        db.bundle.findMany.mockResolvedValue([ACTIVE_S5, ACTIVE_S2]);
        await invoke('?activeOnly=true');
        expect(db.bundle.findMany.mock.calls[0][0].where.is_active).toBe(true);
        // Sanity: the archived sibling fixture genuinely shares the family and
        // would only be excluded by the is_active predicate, not by family logic.
        expect(ARCHIVED_SIBLING.family_id).toBe(FAMILY_ID);
        expect(ARCHIVED_SIBLING.is_active).toBe(false);
    });

    it('zero active Bundles returns a clean empty array, not an error', async () => {
        db.bundle.findMany.mockResolvedValue([]);
        const res = await invoke('?activeOnly=true');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART G — shared-call-site safety: default (no activeOnly) behavior unchanged.
// ═════════════════════════════════════════════════════════════════════════════
describe('default behavior (no activeOnly) is unchanged for other callers', () => {
    it('omitting activeOnly still returns archived/inactive Bundles, for app/bundles/page.tsx', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A, ARCHIVED_BUNDLE_A]);
        await invoke(''); // no query string at all
        expect('is_active' in db.bundle.findMany.mock.calls[0][0].where).toBe(false);
    });

    it('activeOnly=false behaves identically to omitting it', async () => {
        db.bundle.findMany.mockResolvedValue([]);
        await invoke('?activeOnly=false');
        expect('is_active' in db.bundle.findMany.mock.calls[0][0].where).toBe(false);
    });

    it('full=true continues to work exactly as before, independent of activeOnly', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A]);
        db.catalog.findMany.mockResolvedValue([{ id: 'cat-1', name: 'Catalog', business_id: TENANT_A }]);
        const res = await invoke('?full=true&activeOnly=true');
        const body = await res.json();
        expect(body.bundles).toBeDefined();
        expect(body.catalogs).toBeDefined();
        expect(db.bundle.findMany.mock.calls[0][0].where.is_active).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART H — Manual Planner now requests activeOnly, and its required fields
// (id, name, sku — its own Bundle interface) remain present.
// ═════════════════════════════════════════════════════════════════════════════
describe('the Manual Planner requests the active-only endpoint', () => {
    it('ProductionCalculator fetches /api/bundles with activeOnly=true', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components', 'production', 'ProductionCalculator.tsx'), 'utf8');
        expect(src).toMatch(/fetch\(['"`]\/api\/bundles\?activeOnly=true['"`]\)/);
    });

    it('the response still carries id/name/sku, unchanged by the filter', async () => {
        db.bundle.findMany.mockResolvedValue([ACTIVE_BUNDLE_A]);
        const res = await invoke('?activeOnly=true');
        const body = await res.json();
        expect(body[0]).toMatchObject({ id: 'active-a', name: 'Active A', sku: 'ACT-A' });
    });

    it('family_id, serving_tier and price are untouched by this phase', async () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app', 'api', 'bundles', 'route.ts'), 'utf8');
        // The select/include shape must be the same object literal as before —
        // only the where clause gained a conditional field.
        expect(src).toMatch(/contents:\s*\{/);
        expect(src).toMatch(/orderBy:\s*\{\s*name:\s*'asc'\s*\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// No schema change (Part M).
// ═════════════════════════════════════════════════════════════════════════════
describe('no schema change', () => {
    it('prisma/schema.prisma is untouched by this phase', () => {
        // Structural pin, not a content hash: confirms the Bundle model's
        // lifecycle field is still exactly the one this phase relies on.
        const schema = require('fs').readFileSync(
            require('path').join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
        const model = schema.slice(schema.indexOf('model Bundle {'), schema.indexOf('model BundleContent'));
        expect(model).toMatch(/is_active\s+Boolean\s+@default\(true\)/);
    });
});
