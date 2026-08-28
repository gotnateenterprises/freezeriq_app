/**
 * RECIPE-DELETE-GUARD-1 — recipe deletion must not silently damage bundles.
 *
 * The defect these tests exist to prevent: DELETE /api/recipes/[id] ran
 * `bundleContent.deleteMany({ where: { recipe_id: id } })` and then deleted the
 * recipe, so an ordinary "delete recipe" click silently removed that meal from
 * every bundle using it — no warning, no count, no confirmation.
 * BUNDLE-DATA-RECONCILIATION-1 traced 21 lost bundle rows to exactly this,
 * proving it against February/March backups in which every affected Q1 bundle
 * still held five meals; 19 of the 20 missing recipe ids no longer exist.
 *
 * The database already disagreed with that code: bundle_contents.recipe_id is
 * ON DELETE RESTRICT, so Postgres would have refused the delete. The manual
 * deleteMany is what defeated it.
 *
 * These are behavioral tests. The real handler runs against a stateful Prisma
 * double, so "the bundle rows are still there after a refused delete" is proven
 * by reading the store rather than by matching source text.
 */

const TENANT = 'biz-aaaa-1111';
const OTHER = 'biz-bbbb-2222';

type Row = Record<string, any>;

const store: { recipes: Row[]; bundles: Row[]; contents: Row[]; items: Row[] } =
    { recipes: [], bundles: [], contents: [], items: [] };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
let seq = 0;
let failNextRecipeDelete = false;

/**
 * Supports the flat scalars the handler uses plus the two relation filters it
 * relies on for tenant scoping: `bundle: { business_id }` on BundleContent and
 * `parent_recipe: { business_id }` on RecipeItem.
 */
const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
        if (k === 'bundle' && v && typeof v === 'object') {
            const b = store.bundles.find((x) => x.id === row.bundle_id);
            return !!b && matches(b, v as Row);
        }
        if (k === 'parent_recipe' && v && typeof v === 'object') {
            const r = store.recipes.find((x) => x.id === row.parent_recipe_id);
            return !!r && matches(r, v as Row);
        }
        if (v && typeof v === 'object' && Array.isArray((v as any).in)) return (v as any).in.includes(row[k]);
        return row[k] === v;
    });

/** Attach `bundle` / `parent_recipe` when the handler selects them. */
const project = (row: Row, select: any): Row => {
    if (!select) return clone(row);
    const out: Row = {};
    for (const k of Object.keys(select)) {
        if (!select[k]) continue;
        if (k === 'bundle') {
            const b = store.bundles.find((x) => x.id === row.bundle_id);
            out.bundle = b ? { id: b.id, name: b.name } : null;
        } else if (k === 'parent_recipe') {
            const r = store.recipes.find((x) => x.id === row.parent_recipe_id);
            out.parent_recipe = r ? { id: r.id, name: r.name } : null;
        } else out[k] = row[k];
    }
    return out;
};

const model = (table: () => Row[], prefix: string, undo?: (() => void)[]) => ({
    findUnique: async ({ where, select }: any = {}) => {
        const r = table().find((x) => matches(x, where));
        return r ? project(r, select) : null;
    },
    findFirst: async ({ where, select }: any = {}) => {
        const r = table().find((x) => matches(x, where));
        return r ? project(r, select) : null;
    },
    findMany: async ({ where, select }: any = {}) =>
        table().filter((x) => matches(x, where)).map((x) => project(x, select)),
    count: async ({ where }: any = {}) => table().filter((x) => matches(x, where)).length,
    create: async ({ data }: any) => {
        const row = { id: data.id ?? `${prefix}-${++seq}`, ...data };
        table().push(row);
        return clone(row);
    },
    delete: async ({ where }: any) => {
        if (prefix === 'r' && failNextRecipeDelete) {
            failNextRecipeDelete = false;
            throw new Error('db exploded');
        }
        const i = table().findIndex((x) => matches(x, where));
        if (i < 0) throw Object.assign(new Error('Not found'), { code: 'P2025' });
        const [row] = table().splice(i, 1);
        undo?.push(() => table().push(row));
        return clone(row);
    },
    deleteMany: async ({ where }: any = {}) => {
        const removed = table().filter((x) => matches(x, where));
        const keep = table().filter((x) => !matches(x, where));
        table().length = 0; table().push(...keep);
        undo?.push(() => { table().push(...removed); });
        return { count: removed.length };
    },
});

const makeClient = (undo?: (() => void)[]) => ({
    recipe: model(() => store.recipes, 'r', undo),
    bundle: model(() => store.bundles, 'b', undo),
    bundleContent: model(() => store.contents, 'bc', undo),
    recipeItem: model(() => store.items, 'ri', undo),
});

/**
 * Ops issued on the default client are recorded here so the array form of
 * `$transaction` can roll them back.
 *
 * Real Prisma returns a lazy PrismaPromise from `prisma.x.deleteMany(...)` and
 * only executes the batch once `$transaction([...])` runs it, so the whole array
 * commits or rolls back together. A double cannot defer work that JavaScript has
 * already started, so instead every mutation records its undo and a failed batch
 * replays the log — which reproduces the property under test (no partial
 * cleanup survives a failed delete) rather than the mechanism.
 */
const opLog: (() => void)[] = [];

const prismaDouble: any = {
    ...makeClient(opLog),
    $transaction: async (ops: any) => {
        try {
            if (Array.isArray(ops)) return await Promise.all(ops);
            return await ops(makeClient(opLog));
        } catch (err) {
            // Array ops already ran before $transaction was called, so the whole
            // log for this request is undone, newest first.
            while (opLog.length) opLog.pop()!();
            throw err;
        }
    },
};

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/db', () => ({ prisma: prismaDouble }));

const del = async (id: string) => {
    const { DELETE } = require('@/app/api/recipes/[id]/route');
    return DELETE(new Request(`https://x/api/recipes/${id}`, { method: 'DELETE' }),
        { params: Promise.resolve({ id }) });
};

function seed() {
    store.recipes = [
        { id: 'r-used', name: 'Taco Casserole', business_id: TENANT },
        { id: 'r-free', name: 'Unused Meal', business_id: TENANT },
        { id: 'r-sub', name: 'House Sauce', business_id: TENANT },
        { id: 'r-parent', name: 'Parent Dish', business_id: TENANT },
        { id: 'r-foreign', name: 'Other Tenant Meal', business_id: OTHER },
        { id: 'r-unowned', name: 'Hawaiian Pineapple Chicken', business_id: null },
    ];
    store.bundles = [
        { id: 'b1', name: 'Q2 - Comfort Foods', business_id: TENANT },
        { id: 'b2', name: 'Q1 - Clean Eating/Paleo', business_id: TENANT },
        { id: 'b3', name: 'Secret Rival Bundle', business_id: OTHER },
    ];
    store.contents = [];
    store.items = [];
    seq = 0;
    failNextRecipeDelete = false;
    opLog.length = 0;
}

const attach = (bundle_id: string, recipe_id: string, position = 0) =>
    store.contents.push({ id: `bc-${++seq}`, bundle_id, recipe_id, position, quantity: 1 });

beforeEach(() => {
    jest.clearAllMocks();
    seed();
    mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
});

// ===========================================================================
describe('1-4, 10. a recipe used by bundles cannot be deleted, and nothing changes', () => {
    it('1. used by ONE bundle -> 409 RECIPE_IN_USE', async () => {
        attach('b1', 'r-used');

        const res = await del('r-used');
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.code).toBe('RECIPE_IN_USE');
        expect(body.bundleCount).toBe(1);
        expect(body.bundles.map((b: any) => b.name)).toEqual(['Q2 - Comfort Foods']);
    });

    it('2. used by MULTIPLE bundles -> reports every one', async () => {
        attach('b1', 'r-used');
        attach('b2', 'r-used');

        const body = await (await del('r-used')).json();

        expect(body.bundleCount).toBe(2);
        expect(body.bundles.map((b: any) => b.name).sort())
            .toEqual(['Q1 - Clean Eating/Paleo', 'Q2 - Comfort Foods']);
    });

    it('3. the recipe still exists after a refused delete', async () => {
        attach('b1', 'r-used');
        await del('r-used');

        expect(store.recipes.find((r) => r.id === 'r-used')).toBeTruthy();
    });

    it('4 & 10. EVERY bundle_content row survives — the whole point of the phase', async () => {
        attach('b1', 'r-used');
        attach('b2', 'r-used');
        attach('b1', 'r-free');
        const before = clone(store.contents);

        await del('r-used');

        expect(store.contents).toHaveLength(3);
        expect(store.contents).toEqual(before);
    });

    it('the refusal writes NOTHING at all', async () => {
        attach('b1', 'r-used');
        const snapshot = clone(store);

        await del('r-used');

        expect(store).toEqual(snapshot);
    });

    it('the error message stands alone, for clients that show only `error`', async () => {
        attach('b1', 'r-used');
        const body = await (await del('r-used')).json();

        // components/RecipeEditor.tsx discards the body and shows a generic
        // string, so the message itself must name the blocker and the next step.
        expect(body.error).toMatch(/Can't delete this recipe yet/i);
        expect(body.error).toContain('Q2 - Comfort Foods');
        expect(body.error).toMatch(/Remove or replace it there first/i);
    });
});

// ===========================================================================
describe('5-7. tenant isolation', () => {
    it('5. the impact count covers only THIS tenant\'s bundles', async () => {
        attach('b1', 'r-used');   // tenant A
        attach('b3', 'r-used');   // tenant B — must not be counted or named

        const body = await (await del('r-used')).json();

        expect(body.bundleCount).toBe(1);
        expect(body.bundles.map((b: any) => b.name)).toEqual(['Q2 - Comfort Foods']);
    });

    it('6. no other tenant\'s bundle name or id ever appears in the response', async () => {
        attach('b3', 'r-used');   // ONLY a foreign reference

        const res = await del('r-used');
        const raw = JSON.stringify(await res.json());

        // Still refused, because destroying a foreign row silently is the exact
        // behaviour being removed — but the foreign bundle is never disclosed.
        expect(res.status).toBe(409);
        expect(raw).not.toContain('Secret Rival Bundle');
        expect(raw).not.toContain('b3');
        expect(raw).toMatch(/currently in use/i);
    });

    it('6b. a foreign-only reference still prevents the row being destroyed', async () => {
        attach('b3', 'r-used');
        await del('r-used');

        expect(store.contents).toHaveLength(1);
        expect(store.recipes.find((r) => r.id === 'r-used')).toBeTruthy();
    });

    it('7. deleting another tenant\'s recipe is forbidden, before any counting', async () => {
        const res = await del('r-foreign');

        expect(res.status).toBe(403);
        expect(store.recipes.find((r) => r.id === 'r-foreign')).toBeTruthy();
    });

    it('7b. an unauthenticated caller is rejected', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await del('r-free');

        expect(res.status).toBe(401);
        expect(store.recipes).toHaveLength(6);
    });

    it('7c. a legacy unowned (business_id = NULL) recipe is refused, not exposed', async () => {
        attach('b1', 'r-unowned');
        const res = await del('r-unowned');

        // Ownership is checked first, so it never reaches the impact query.
        expect(res.status).toBe(403);
        expect(store.recipes.find((r) => r.id === 'r-unowned')).toBeTruthy();
        expect(store.contents).toHaveLength(1);
    });

    it('a missing recipe is a 404', async () => {
        expect((await del('nope')).status).toBe(404);
    });
});

// ===========================================================================
describe('sub-recipe protection — the same silent-damage class', () => {
    it('a recipe used INSIDE another recipe is refused and named', async () => {
        store.items.push({ id: 'ri1', parent_recipe_id: 'r-parent', child_recipe_id: 'r-sub' });

        const res = await del('r-sub');
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.recipeCount).toBe(1);
        expect(body.recipes.map((r: any) => r.name)).toEqual(['Parent Dish']);
        expect(store.items).toHaveLength(1);
        expect(store.recipes.find((r) => r.id === 'r-sub')).toBeTruthy();
    });

    it('a parent recipe belonging to another tenant is not named', async () => {
        store.recipes.push({ id: 'r-foreign-parent', name: 'Rival Dish', business_id: OTHER });
        store.items.push({ id: 'ri1', parent_recipe_id: 'r-foreign-parent', child_recipe_id: 'r-sub' });

        const raw = JSON.stringify(await (await del('r-sub')).json());
        expect(raw).not.toContain('Rival Dish');
    });
});

// ===========================================================================
describe('8-9, 11. deletion still works when nothing depends on the recipe', () => {
    it('8. a recipe with zero references is deleted', async () => {
        const res = await del('r-free');

        expect(res.status).toBe(200);
        expect(store.recipes.find((r) => r.id === 'r-free')).toBeUndefined();
    });

    it('8b. its OWN ingredient list is cleaned up with it', async () => {
        store.items.push({ id: 'ri1', parent_recipe_id: 'r-free', child_ingredient_id: 'ing1' });

        const res = await del('r-free');

        expect(res.status).toBe(200);
        expect(store.items).toHaveLength(0);
    });

    it('8c. deleting an unused recipe never touches another bundle', async () => {
        attach('b1', 'r-used');
        await del('r-free');

        expect(store.contents).toHaveLength(1);
        expect(store.contents[0].recipe_id).toBe('r-used');
    });

    it('9. a failure mid-delete rolls the ingredient cleanup back', async () => {
        store.items.push({ id: 'ri1', parent_recipe_id: 'r-free', child_ingredient_id: 'ing1' });
        failNextRecipeDelete = true;

        const res = await del('r-free');

        expect(res.status).toBe(500);
        expect(store.recipes.find((r) => r.id === 'r-free')).toBeTruthy();
        expect(store.items).toHaveLength(1); // cleanup undone
    });

    it('11. the historical silent unlink is unreachable — no bundle rows are ever deleted by recipe id', async () => {
        attach('b1', 'r-used');
        attach('b2', 'r-used');

        await del('r-used');            // refused
        await del('r-free');            // allowed

        // Neither path may remove a bundle_content row.
        expect(store.contents).toHaveLength(2);
    });

    /**
     * Source-level on purpose. jest runs with testEnvironment 'node' and this
     * phase may not add tooling, so there is no DOM to render RecipeBrowser in.
     * The API behaviour above is proven behaviourally; this pins the one branch
     * that turns that response into something the user can act on.
     */
    it('the browser UI renders the in-use impact instead of a generic failure', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components/RecipeBrowser.tsx'), 'utf8');
        const handler = src.slice(src.indexOf('const handleDeleteRecipe'), src.indexOf('const handleDragStart'));

        expect(handler).toContain("res.status === 409 && data.code === 'RECIPE_IN_USE'");
        // It must name the bundles, not just count them.
        expect(handler).toMatch(/data\.bundles\s*\?\?\s*\[\]/);
        expect(handler).toMatch(/b\.name/);
        expect(handler).toMatch(/Remove or replace it there first/);
        // ...and must return before reaching the generic toast.
        const branch = handler.indexOf("RECIPE_IN_USE");
        const generic = handler.indexOf("data.error || 'Failed to delete recipe'");
        expect(branch).toBeGreaterThan(-1);
        expect(generic).toBeGreaterThan(branch);
        expect(handler.slice(branch, generic)).toContain('return;');
    });

    it('11b. the source no longer contains a recipe-id bundle wipe', () => {
        const raw = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app/api/recipes/[id]/route.ts'), 'utf8');
        // Strip comments — the guard's own explanation names the removed call.
        const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(src).not.toMatch(/bundleContent\.deleteMany/);
        expect(src).not.toMatch(/deleteMany\(\{\s*where:\s*\{\s*child_recipe_id/);
    });
});
