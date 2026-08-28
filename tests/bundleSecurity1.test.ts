/**
 * BUNDLE-SECURITY-1 — Bundle administration authentication + tenant isolation.
 *
 * The defect these tests exist to prevent, confirmed live against Production
 * during BUNDLE-AUDIT-1: `/bundles` was missing from the protected-route
 * allowlist in auth.config.ts, and app/bundles/[id]/page.tsx contained no
 * `auth()` call and no `business_id` filter on any of its three Prisma reads.
 * An anonymous `GET /bundles/new` therefore returned HTTP 200 and shipped every
 * Recipe id/name/type on the platform in the RSC payload — no UUID, no tenant
 * slug and no credential required, because lines 37-46 sat OUTSIDE the
 * `id !== 'new'` branch.
 *
 * These assertions are deliberately behavioral wherever the boundary can be
 * driven directly: the real `authorized()` callback decides the real paths, the
 * real page component runs against a mocked session and a recording Prisma
 * double, and the real POST handler is invoked with a foreign recipe id. Only
 * facts that are genuinely properties of the source text (which reads are
 * scoped, which lookups are unscoped) are asserted against the source.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

// ---------------------------------------------------------------------------
// Doubles. `@/auth` is next-auth and `@/lib/db` is a live PrismaClient, so both
// are replaced; everything else under test is the real shipped module.
// ---------------------------------------------------------------------------
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const db: any = {
    bundle: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    recipe: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
    bundleContent: { create: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(),
};
jest.mock('@/lib/db', () => ({ prisma: db }));
jest.mock('@/lib/cost_engine', () => ({ calculateRecipeCost: jest.fn() }));

const session = (businessId: string | null) =>
    businessId ? { user: { id: 'u1', businessId } } : null;

/** Walk a returned React element tree looking for visible text. */
const textOf = (node: any): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    return textOf(node?.props?.children);
};

beforeEach(() => {
    jest.clearAllMocks();
    db.bundle.findMany.mockResolvedValue([]);
    db.recipe.findMany.mockResolvedValue([]);
    // BUNDLE-PERSISTENCE-FIX made create transactional, so the double has to
    // actually run the callback rather than returning undefined.
    db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

// ===========================================================================
describe('property 1 — unauthenticated bundle administration is rejected', () => {
    // The real callback, driven with the real paths. This is the route-level
    // half of the fix; `false` is what makes next-auth redirect to /login.
    const { authConfig } = require('@/auth.config');
    const decide = (pathname: string, loggedIn: boolean) =>
        authConfig.callbacks.authorized({
            auth: loggedIn ? { user: { name: 'x' } } : null,
            request: { nextUrl: new URL(`https://www.freezeriqapp.com${pathname}`) },
        });

    it.each(['/bundles', '/bundles/new', '/bundles/some-uuid'])(
        'anonymous %s is refused by authorized()', (p) => {
            expect(decide(p, false)).toBe(false);
        });

    it('the refusal is not a blanket deny — public storefront paths still pass', () => {
        expect(decide('/shop/acme', false)).toBe(true);
        expect(decide('/login', false)).toBe(true);
    });

    it('an authenticated user is still admitted to bundle administration', () => {
        expect(decide('/bundles/new', true)).toBe(true);
    });

    it('the sibling protected routes that already worked are unchanged', () => {
        for (const p of ['/recipes', '/customers', '/orders', '/campaigns', '/settings']) {
            expect(decide(p, false)).toBe(false);
        }
    });

    it('the page itself refuses anonymously, without relying on middleware', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(null));

        const out = await page({ params: Promise.resolve({ id: 'new' }) });

        expect(textOf(out)).toContain('Unauthorized');
        // Defense in depth means nothing is read at all — this is the assertion
        // that would have caught the original anonymous recipe dump.
        expect(db.recipe.findMany).not.toHaveBeenCalled();
        expect(db.bundle.findMany).not.toHaveBeenCalled();
        expect(db.bundle.findFirst).not.toHaveBeenCalled();
    });

    it('a session without a businessId is not a valid tenant', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue({ user: { id: 'u1' } });

        expect(textOf(await page({ params: Promise.resolve({ id: 'new' }) }))).toContain('Unauthorized');
        expect(db.recipe.findMany).not.toHaveBeenCalled();
    });
});

// ===========================================================================
describe('properties 2 & 4 — tenant A cannot view tenant B\'s bundle by ID', () => {
    it('the lookup is scoped, so a foreign id resolves to nothing', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(TENANT_A));
        db.bundle.findFirst.mockResolvedValue(null); // scoped query finds nothing

        const out = await page({ params: Promise.resolve({ id: 'bundle-owned-by-B' }) });

        expect(db.bundle.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'bundle-owned-by-B', business_id: TENANT_A },
            })
        );
        expect(textOf(out)).toContain('Bundle Not Found');
    });

    it('ownership is proven by the query, never by a post-hoc comparison', () => {
        const src = read('app/bundles/[id]/page.tsx');
        // findUnique({ where: { id } }) is the exact shape that leaked.
        expect(src).not.toMatch(/findUnique\(\s*\{\s*where:\s*\{\s*id\s*[,}]/);
        expect(src).toContain('business_id: businessId');
    });

    it('a foreign id does NOT silently fall through to a blank create form', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(TENANT_A));
        db.bundle.findFirst.mockResolvedValue(null);

        const out = await page({ params: Promise.resolve({ id: 'bundle-owned-by-B' }) });
        // Rendering the editor with initialData=null would present tenant B's
        // URL as a usable "new bundle" page instead of denying it.
        expect(textOf(out)).not.toContain('Add Item');
        expect(db.recipe.findMany).not.toHaveBeenCalled();
    });
});

// ===========================================================================
describe('property 3 — the editor never receives another tenant\'s recipes', () => {
    it('the recipe picker query is scoped to the authenticated business', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(TENANT_A));

        await page({ params: Promise.resolve({ id: 'new' }) });

        expect(db.recipe.findMany).toHaveBeenCalledTimes(1);
        expect(db.recipe.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { business_id: TENANT_A } })
        );
    });

    it('the serving-tier vocabulary is scoped too', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(TENANT_A));

        await page({ params: Promise.resolve({ id: 'new' }) });

        expect(db.bundle.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { business_id: TENANT_A } })
        );
    });

    it('unowned legacy rows are not shared globally as a compatibility shim', () => {
        const src = read('app/bundles/[id]/page.tsx');
        // `business_id: null` or an OR that re-admits unowned recipes would
        // reintroduce the cross-tenant attach this phase closed.
        expect(src).not.toMatch(/business_id:\s*null/);
        expect(src).not.toMatch(/\bOR\b|\bin:\s*\[businessId,\s*null\]/);
    });

    it('every Prisma read on the page carries a business_id filter', () => {
        const src = read('app/bundles/[id]/page.tsx');
        const reads = src.match(/prisma\.\w+\.find\w+\(/g) ?? [];
        expect(reads.length).toBe(3); // bundle.findFirst, recipe.findMany, bundle.findMany
        expect((src.match(/business_id: businessId/g) ?? []).length).toBe(3);
    });
});

// ===========================================================================
describe('property 5 — client-supplied ids are never proof of ownership', () => {
    const invoke = async (body: any) => {
        const { POST } = require('@/app/api/bundles/route');
        return POST(new Request('https://www.freezeriqapp.com/api/bundles', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }));
    };

    it('creating a bundle with a foreign recipe_id is refused with 403', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        // Tenant A owns neither id, so the ownership query returns fewer rows.
        db.recipe.findMany.mockResolvedValue([{ id: 'recipe-A' }]);

        const res = await invoke({
            name: 'Mixed', sku: 'MIX-1',
            contents: [{ recipe_id: 'recipe-A' }, { recipe_id: 'recipe-owned-by-B' }],
        });

        expect(res.status).toBe(403);
        expect(db.recipe.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ['recipe-A', 'recipe-owned-by-B'] }, business_id: TENANT_A },
            })
        );
        // The refusal must precede the write, or the bundle exists anyway.
        expect(db.bundle.create).not.toHaveBeenCalled();
        expect(db.bundleContent.create).not.toHaveBeenCalled();
    });

    it('an unauthenticated create is refused before any read or write', async () => {
        mockAuth.mockResolvedValue(session(null));
        const res = await invoke({ name: 'X', sku: 'X-1', contents: [{ recipe_id: 'r' }] });

        expect(res.status).toBe(401);
        expect(db.recipe.findMany).not.toHaveBeenCalled();
        expect(db.bundle.create).not.toHaveBeenCalled();
    });

    it('duplicate ids cannot inflate the count into a false match', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        // Two owned rows returned, but three submitted entries collapsing to two
        // distinct ids — the Set dedupe must make this compare correctly.
        db.recipe.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
        db.bundle.create.mockResolvedValue({ id: 'new-bundle' });
        db.bundleContent.create.mockResolvedValue({});

        const res = await invoke({
            name: 'Dup', sku: 'DUP-1',
            contents: [{ recipe_id: 'r1' }, { recipe_id: 'r2' }, { recipe_id: 'r1' }],
        });

        expect(res.status).not.toBe(403);
        expect(db.recipe.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: { in: ['r1', 'r2'] }, business_id: TENANT_A } })
        );
    });

    it('a foreign recipe cannot be smuggled in by SKU instead of id', () => {
        // BUNDLE-PERSISTENCE-FIX moved recipe resolution out of the route bodies
        // and into one shared authority, so the scoping now lives there. The
        // property is unchanged; only its home moved.
        const src = read('lib/bundleContents.ts');
        expect(src).not.toMatch(/findFirst\(\{\s*where:\s*\{\s*sku:\s*ref\.sku\s*\}/);
        expect(src).toMatch(/sku: ref\.sku,\s*business_id: businessId/);
        // No route may resolve a recipe by SKU on its own any more.
        for (const p of ['app/api/bundles/route.ts', 'app/api/bundles/import/route.ts']) {
            expect(read(p)).not.toMatch(/recipe\.find\w+\(\{\s*where:\s*\{\s*sku/);
        }
    });

    it('the import path resolves recipes AND bundles within the business only', () => {
        const src = read('app/api/bundles/import/route.ts');
        expect(src).not.toContain('findUnique({ where: { sku: content.recipe.sku } })');
        // Bundle.sku is globally unique too: an unscoped bundle lookup let an
        // import target — and wipe — another tenant's bundle.
        expect(src).not.toMatch(/bundle\.findUnique\(\{\s*where:\s*\{\s*sku/);
        expect(src).toMatch(/sku: bundle\.sku,\s*business_id: businessId/);
    });

    it('no bundle write path trusts a client-supplied business_id', () => {
        for (const p of ['app/api/bundles/route.ts', 'app/api/bundles/[id]/route.ts',
            'app/api/bundles/import/route.ts']) {
            const src = read(p);
            expect(src).not.toMatch(/business_id:\s*(data|body|item|content|req)\./);
        }
    });
});

// ===========================================================================
describe('property 6 — the owning tenant still works', () => {
    it('the owner receives the editor with their bundle and their recipes', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(TENANT_A));
        db.bundle.findFirst.mockResolvedValue({
            id: 'b1', name: 'Q2 - Comfort Foods', price: 120, stock_on_hand: 0,
            contents: [{ recipe_id: 'r1', quantity: 1, recipe: { id: 'r1', name: 'BBQ Chicken', base_yield_qty: 4 } }],
        });
        db.recipe.findMany.mockResolvedValue([{ id: 'r1', name: 'BBQ Chicken', type: 'menu_item' }]);
        db.bundle.findMany.mockResolvedValue([{ serving_tier: 'family' }]);

        const out: any = await page({ params: Promise.resolve({ id: 'b1' }) });

        expect(textOf(out)).not.toContain('Unauthorized');
        expect(textOf(out)).not.toContain('Bundle Not Found');
        expect(out.props.initialData.name).toBe('Q2 - Comfort Foods');
        expect(out.props.allRecipes).toEqual([{ id: 'r1', name: 'BBQ Chicken', type: 'menu_item' }]);
        expect(out.props.knownTiers).toEqual(['family']);
    });

    it('Decimal serialization for the client component is preserved', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(TENANT_A));
        db.bundle.findFirst.mockResolvedValue({
            id: 'b1', name: 'B', price: '120.50', stock_on_hand: '7',
            contents: [{ recipe_id: 'r1', quantity: 1, recipe: { id: 'r1', name: 'R', base_yield_qty: '4.5' } }],
        });

        const out: any = await page({ params: Promise.resolve({ id: 'b1' }) });

        expect(out.props.initialData.price).toBe(120.5);
        expect(out.props.initialData.stock_on_hand).toBe(7);
        expect(out.props.initialData.contents[0].recipe.base_yield_qty).toBe(4.5);
    });

    it('a create-mode load still works for the owner', async () => {
        const page = require('@/app/bundles/[id]/page').default;
        mockAuth.mockResolvedValue(session(TENANT_A));
        db.recipe.findMany.mockResolvedValue([{ id: 'r1', name: 'R', type: 'menu_item' }]);

        const out: any = await page({ params: Promise.resolve({ id: 'new' }) });

        expect(out.props.initialData).toBeNull();
        expect(out.props.allRecipes).toHaveLength(1);
        expect(db.bundle.findFirst).not.toHaveBeenCalled();
    });

    it('creating a bundle from wholly-owned recipes still succeeds', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        db.recipe.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
        db.bundle.create.mockResolvedValue({ id: 'nb', name: 'Owned' });
        db.bundleContent.create.mockResolvedValue({});

        const { POST } = require('@/app/api/bundles/route');
        const res = await POST(new Request('https://www.freezeriqapp.com/api/bundles', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Owned', sku: 'OWN-1', contents: [{ recipe_id: 'r1' }, { recipe_id: 'r2' }] }),
        }));

        expect(res.status).toBe(200);
        expect(db.bundle.create).toHaveBeenCalled();
        expect(db.bundle.create.mock.calls[0][0].data.business_id).toBe(TENANT_A);
        // BUNDLE-PERSISTENCE-FIX writes the whole validated set in one
        // createMany inside the transaction, rather than a per-row loop.
        expect(db.bundleContent.createMany).toHaveBeenCalledTimes(1);
        expect(db.bundleContent.createMany.mock.calls[0][0].data).toHaveLength(2);
    });

    it('a bundle with no contents is unaffected by the new ownership gate', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        db.bundle.create.mockResolvedValue({ id: 'nb' });

        const { POST } = require('@/app/api/bundles/route');
        const res = await POST(new Request('https://www.freezeriqapp.com/api/bundles', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Empty', sku: 'EMP-1' }),
        }));

        expect(res.status).toBe(200);
        expect(db.recipe.findMany).not.toHaveBeenCalled();
    });
});

// ===========================================================================
describe('no-drift — this phase changed only the security boundary', () => {
    it('the silent-skip that this suite once pinned is now gone (BUNDLE-PERSISTENCE-FIX)', () => {
        const create = read('app/api/bundles/route.ts');
        const imp = read('app/api/bundles/import/route.ts');
        // This assertion previously pinned `if (recipeId) {` in place to prove
        // the security release had not drifted into persistence work. That work
        // is now done deliberately in its own phase, so the pin is inverted:
        // no bundle write path may silently skip an unresolvable recipe again.
        expect(create).not.toContain('if (recipeId) {');
        expect(imp).not.toContain('if (recipeId) {');
        // image_url persistence was deferred at the time this suite was
        // written and was implemented deliberately by BUNDLE-MEDIA-1 —
        // tests/bundleMedia1.test.ts now owns that contract.
    });

    // The "no migration is present" assertion that used to live here was a
    // one-time pre-commit scope-pin for THIS phase (BUNDLE-SECURITY-1) only,
    // checked once against the working tree right before that phase's own
    // commit. A live `git status` check has no way to distinguish "this
    // phase's migration" from "some later, unrelated phase's migration", so it
    // cannot remain a permanent regression test — FR-GOAL-CONFIG-1 legitimately
    // adds prisma/migrations/20260828000000_fr_goal_config_1_bundle_goal_default,
    // an intentional, reviewed schema change unrelated to this suite's own
    // security-boundary concern. Retired rather than left as a tripwire that
    // can never pass again once any later phase touches the schema.
});
