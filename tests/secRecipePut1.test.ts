/**
 * SEC-RECIPE-PUT-1 — handler-boundary tests for PUT /api/recipes/[id].
 *
 * CONSTITUTION-LOCK-1's finding E-7, reconfirmed by direct source read at
 * SEC-RECIPE-PUT-1 time: the GET and DELETE handlers in this same file both
 * compare `recipe.business_id` to `session.user.businessId` before doing
 * anything; PUT authenticated the caller and then went straight into
 * `tx.recipe.update({ where: { id } })` — no ownership check anywhere. Any
 * authenticated user of ANY tenant could overwrite another tenant's recipe by
 * UUID, wipe its RecipeItem list, and replace it with items referencing their
 * OWN tenant's ingredients (the item-matching lookups were already correctly
 * scoped, which makes the graft cross-tenant in both directions at once).
 *
 * These tests execute the real handler against a recording Prisma double,
 * per this repo's established standard that source greps cannot distinguish
 * "returns refuse()" from "returns ok" (tests/outreachConsent1.test.ts:646-652).
 * Run against the pre-fix source, every test under section 3 fails — that is
 * the Part C proof. Run against the fixed source, all pass.
 */

import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__secPrisma; },
}));
jest.mock('@/auth', () => ({
    auth: jest.fn(async () => (global as any).__secSession),
}));

let mock: PrismaMock;
const useMock = (m: PrismaMock) => { mock = m; (global as any).__secPrisma = m.client; };
const useSession = (s: any) => { (global as any).__secSession = s; };

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';
const sessionFor = (businessId: string) => ({ user: { id: 'u1', businessId } });

const RECIPE_ID = 'recipe-1';

const params = () => ({ params: Promise.resolve({ id: RECIPE_ID }) } as any);

const putRequest = (body: any) =>
    new Request(`http://localhost/api/recipes/${RECIPE_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as any;

/** A recipe row as tx.recipe.findUnique would return it, owned by TENANT_A. */
const ownRecipeRow = { id: RECIPE_ID, business_id: TENANT_A };
const foreignRecipeRow = { id: RECIPE_ID, business_id: TENANT_B };

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock());
    useSession(null);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Anonymous refusal.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. an anonymous PUT is refused', () => {
    it('returns 401 with no session', async () => {
        useSession(null);
        const { PUT } = await import('@/app/api/recipes/[id]/route');
        const res = await PUT(putRequest({ name: 'Hack' }), params());
        expect(res.status).toBe(401);
    });

    it('reaches no database call at all when anonymous', async () => {
        useSession(null);
        const { PUT } = await import('@/app/api/recipes/[id]/route');
        await PUT(putRequest({ name: 'Hack' }), params());
        expect(mock.calls).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Same-tenant success.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. an authenticated tenant can update its own Recipe', () => {
    it('succeeds and updates the recipe', async () => {
        useMock(createPrismaMock({
            results: { 'recipe.findUnique': ownRecipeRow },
        }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        const res = await PUT(putRequest({ name: 'My Updated Recipe' }), params());

        expect(res.status).toBe(200);
        const update = mock.firstCall('recipe.update');
        expect(update).toBeDefined();
        expect(update!.args.where.id).toBe(RECIPE_ID);
        expect(update!.args.data.name).toBe('My Updated Recipe');
    });

    it('can still replace its own RecipeItems', async () => {
        useMock(createPrismaMock({
            results: {
                'recipe.findUnique': ownRecipeRow,
                'ingredient.findMany': [],
                'recipe.findMany': [],
                'ingredient.create': (args: any) => ({ id: 'new-ing-1', ...args.data }),
            },
        }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        const res = await PUT(putRequest({
            name: 'Chili',
            items: [{ name: 'Ground Beef', qty: 2, unit: 'lb' }],
        }), params());

        expect(res.status).toBe(200);
        expect(mock.callsTo('recipeItem.deleteMany')).toHaveLength(1);
        expect(mock.callsTo('recipeItem.deleteMany')[0].args.where.parent_recipe_id).toBe(RECIPE_ID);
        const createMany = mock.firstCall('recipeItem.createMany');
        expect(createMany).toBeDefined();
        expect(createMany!.args.data[0].parent_recipe_id).toBe(RECIPE_ID);
        expect(createMany!.args.data[0].child_ingredient_id).toBe('new-ing-1');
    });

    it('ingredient/sub-recipe name matching stays scoped to the session tenant', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': ownRecipeRow } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        await PUT(putRequest({ name: 'Chili', items: [{ name: 'Beef', qty: 1, unit: 'lb' }] }), params());

        for (const call of mock.callsTo('ingredient.findMany')) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
        for (const call of mock.callsTo('recipe.findMany')) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Cross-tenant refusal — the core defect this phase closes.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. an authenticated tenant CANNOT update another tenant Recipe', () => {
    it('returns 403 (non-leaking) for a Recipe owned by a different tenant', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        const res = await PUT(putRequest({ name: 'Hijacked' }), params());

        expect(res.status).toBe(403);
    });

    it('returns 404 for a Recipe id that does not exist at all', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': null } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        const res = await PUT(putRequest({ name: 'Ghost' }), params());

        expect(res.status).toBe(404);
    });

    it('a foreign Recipe causes ZERO recipe.update calls', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        await PUT(putRequest({ name: 'Hijacked' }), params());

        expect(mock.callsTo('recipe.update')).toHaveLength(0);
    });

    it('a foreign Recipe causes ZERO RecipeItem deletion', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        await PUT(putRequest({
            name: 'Hijacked',
            items: [{ name: 'Anything', qty: 1, unit: 'lb' }],
        }), params());

        expect(mock.callsTo('recipeItem.deleteMany')).toHaveLength(0);
    });

    it('a foreign Recipe causes ZERO replacement-item creation', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        await PUT(putRequest({
            name: 'Hijacked',
            items: [{ name: 'Anything', qty: 1, unit: 'lb' }],
        }), params());

        expect(mock.callsTo('recipeItem.createMany')).toHaveLength(0);
        // And no new ingredient is fabricated on the attacker's behalf either.
        expect(mock.callsTo('ingredient.create')).toHaveLength(0);
    });

    it('the ownership check happens before ANY write in transaction order', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        await PUT(putRequest({ name: 'Hijacked', items: [{ name: 'X', qty: 1, unit: 'lb' }] }), params());

        // The only Prisma call made at all is the ownership read itself.
        expect(mock.calls).toHaveLength(1);
        expect(mock.calls[0].model).toBe('recipe');
        expect(mock.calls[0].method).toBe('findUnique');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. A body-supplied business_id cannot override the session tenant.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. a request-body business_id cannot override the session tenant', () => {
    it('a spoofed business_id in the body has no effect on which recipe is writable', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));

        const { PUT } = await import('@/app/api/recipes/[id]/route');
        const res = await PUT(putRequest({ name: 'Hijacked', business_id: TENANT_B, businessId: TENANT_B }), params());

        // Still refused: business_id is never read from the body by this route.
        expect(res.status).toBe(403);
        expect(mock.callsTo('recipe.update')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. GET and DELETE tenant isolation remains intact (unchanged by this phase).
// ═════════════════════════════════════════════════════════════════════════════
describe('5. GET and DELETE tenant isolation is unaffected', () => {
    it('GET still 403s a foreign recipe', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));
        const { GET } = await import('@/app/api/recipes/[id]/route');
        const res = await GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`) as any, params());
        expect(res.status).toBe(403);
    });

    it('GET still 200s an owned recipe', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': ownRecipeRow } }));
        useSession(sessionFor(TENANT_A));
        const { GET } = await import('@/app/api/recipes/[id]/route');
        const res = await GET(new Request(`http://localhost/api/recipes/${RECIPE_ID}`) as any, params());
        expect(res.status).toBe(200);
    });

    it('DELETE still refuses a foreign recipe with no destructive write', async () => {
        useMock(createPrismaMock({ results: { 'recipe.findUnique': foreignRecipeRow } }));
        useSession(sessionFor(TENANT_A));
        const { DELETE } = await import('@/app/api/recipes/[id]/route');
        const res = await DELETE(new Request(`http://localhost/api/recipes/${RECIPE_ID}`, { method: 'DELETE' }) as any, params());
        expect(res.status).toBe(403);
        expect(mock.callsTo('recipe.delete')).toHaveLength(0);
        expect(mock.callsTo('recipeItem.deleteMany')).toHaveLength(0);
    });
});
