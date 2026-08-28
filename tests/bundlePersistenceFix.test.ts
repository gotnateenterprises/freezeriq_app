/**
 * BUNDLE-PERSISTENCE-FIX — bundle recipe integrity, atomic writes, no silent loss.
 *
 * The defect these tests exist to prevent: create and import resolved recipes
 * inside their write loop and guarded the insert with `if (recipeId)`, so an
 * entry that could not be matched was dropped in silence while the caller was
 * told the save succeeded. Import deleted the existing contents *before* that
 * loop ran, so a five-recipe payload naming two unmatchable recipes left three
 * rows behind — the shape BUNDLE-AUDIT-1 found across seven sibling pairs in
 * Production, one of them exactly 5-versus-3.
 *
 * These are behavioral tests. The real route handlers run against a stateful
 * in-memory Prisma double that models `$transaction` with genuine rollback, so
 * "the original five survive a failed import" is proven by reading the store
 * afterwards rather than by asserting that some source string is present.
 */

const TENANT = 'biz-aaaa-1111';
const OTHER = 'biz-bbbb-2222';

// ---------------------------------------------------------------------------
// Stateful Prisma double.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

const store: {
    bundles: Row[];
    contents: Row[];
    recipes: Row[];
    catalogs: Row[];
} = { bundles: [], contents: [], recipes: [], catalogs: [] };

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Match a flat Prisma `where` against a row, supporting `{ in: [...] }` and the
 * `{ equals, mode: 'insensitive' }` form the duplicate-serves-2 route uses to
 * find a "{name} (Serves 2)" counterpart.
 */
const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object') {
            const cond = v as any;
            if (Array.isArray(cond.in)) return cond.in.includes(row[k]);
            if ('equals' in cond) {
                return cond.mode === 'insensitive'
                    ? String(row[k] ?? '').toLowerCase() === String(cond.equals ?? '').toLowerCase()
                    : row[k] === cond.equals;
            }
        }
        return row[k] === v;
    });

/** Set to make the next bundleContent.createMany throw, to test rollback. */
let failNextContentWrite = false;

/**
 * Hydrate `include: { contents: { include: { recipe } } }` the way the
 * duplicate-serves-2 route reads a source bundle.
 */
const hydrate = (row: Row | null, include: any): Row | null => {
    if (!row || !include?.contents) return row ? clone(row) : null;
    const contents = store.contents
        .filter((c) => c.bundle_id === row.id)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((c) => ({ ...c, recipe: store.recipes.find((r) => r.id === c.recipe_id) ?? null }));
    return clone({ ...row, contents });
};

const model = (table: () => Row[], prefix: string, undo?: (() => void)[]) => ({
    findFirst: async ({ where, include }: any = {}) =>
        hydrate(table().find((r) => matches(r, where)) ?? null, include),
    findUnique: async ({ where, include }: any = {}) =>
        hydrate(table().find((r) => matches(r, where)) ?? null, include),
    findMany: async ({ where }: any = {}) => table().filter((r) => matches(r, where)),
    create: async ({ data }: any) => {
        const row = { id: data.id ?? nextId(prefix), ...data };
        table().push(row);
        undo?.push(() => {
            const i = table().findIndex((r) => r.id === row.id);
            if (i >= 0) table().splice(i, 1);
        });
        return clone(row);
    },
    createMany: async ({ data }: any) => {
        if (prefix === 'bc' && failNextContentWrite) {
            failNextContentWrite = false;
            throw new Error('db exploded');
        }
        const added: string[] = [];
        for (const d of data) {
            const row = { id: nextId(prefix), ...d };
            table().push(row);
            added.push(row.id);
        }
        undo?.push(() => {
            const keep = table().filter((r) => !added.includes(r.id));
            table().length = 0;
            table().push(...keep);
        });
        return { count: data.length };
    },
    update: async ({ where, data }: any) => {
        const row = table().find((r) => matches(r, where));
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        const prev = clone(row);
        Object.assign(row, data);
        undo?.push(() => {
            const cur = table().find((r) => r.id === prev.id);
            if (cur) Object.assign(cur, prev);
        });
        return clone(row);
    },
    deleteMany: async ({ where }: any = {}) => {
        const removed = table().filter((r) => matches(r, where));
        const keep = table().filter((r) => !matches(r, where));
        table().length = 0;
        table().push(...keep);
        undo?.push(() => { table().push(...removed); });
        return { count: removed.length };
    },
});

const makeTx = (undo?: (() => void)[]) => ({
    bundle: model(() => store.bundles, 'b', undo),
    bundleContent: model(() => store.contents, 'bc', undo),
    recipe: model(() => store.recipes, 'r', undo),
    catalog: model(() => store.catalogs, 'cat', undo),
});

/**
 * Rollback is modelled with an undo log recorded by the TRANSACTION CLIENT only.
 *
 * This distinction matters and a whole-store snapshot gets it wrong: in a real
 * database a `prisma.*` call made inside the callback runs OUTSIDE the
 * transaction and is durable, so a delete issued that way survives the
 * rollback. Snapshotting everything would silently "fix" that bug and let a
 * delete-outside-the-transaction mutant pass.
 */
const prismaDouble: any = {
    ...makeTx(),
    $transaction: async (fn: any) => {
        const undo: (() => void)[] = [];
        try {
            return await fn(makeTx(undo));
        } catch (err) {
            for (const step of undo.reverse()) step();
            throw err;
        }
    },
};

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/db', () => ({ prisma: prismaDouble }));
jest.mock('@/lib/cost_engine', () => ({ calculateRecipeCost: jest.fn().mockResolvedValue({ totalCost: 0 }) }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const MEALS = ['BBQ Chicken', 'Chicken Pot Pie', 'Creamy Italian Chicken', 'Parmesan Honey Pork', 'Taco Casserole'];

function seed() {
    store.bundles = [];
    store.contents = [];
    store.recipes = [];
    store.catalogs = [];
    seq = 0;
    failNextContentWrite = false;
    MEALS.forEach((name, i) =>
        store.recipes.push({ id: `r${i + 1}`, name, sku: `SKU-${i + 1}`, business_id: TENANT }));
    store.recipes.push({ id: 'foreign1', name: 'Foreign Meal', sku: 'SKU-F', business_id: OTHER });
    store.recipes.push({ id: 'unowned1', name: 'Unowned Meal', sku: 'SKU-U', business_id: null });
}

const contentsOf = (bundleId: string) => store.contents.filter((c) => c.bundle_id === bundleId);

const post = async (body: any) => {
    const { POST } = require('@/app/api/bundles/route');
    return POST(new Request('https://x/api/bundles', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
};

const put = async (id: string, body: any) => {
    const { PUT } = require('@/app/api/bundles/[id]/route');
    return PUT(new Request(`https://x/api/bundles/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });
};

const importPayload = async (body: any) => {
    const { POST } = require('@/app/api/bundles/import/route');
    return POST(new Request('https://x/api/bundles/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
};

/** A bundle already holding all five meals, as the owner would have built it. */
async function seedFiveRecipeBundle(name = 'Q2 - Comfort Foods', sku = 'Q2-CF') {
    const res = await post({ name, sku, contents: MEALS.map((_, i) => ({ recipe_id: `r${i + 1}` })) });
    expect(res.status).toBe(200);
    const bundle = await res.json();
    expect(contentsOf(bundle.id)).toHaveLength(5);
    return bundle;
}

beforeEach(() => {
    jest.clearAllMocks();
    seed();
    mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
});

// ===========================================================================
describe('CREATE', () => {
    it('1-3. five valid recipes persist as exactly five, with deterministic positions', async () => {
        const bundle = await seedFiveRecipeBundle();

        const rows = contentsOf(bundle.id);
        expect(rows).toHaveLength(5);
        expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
        expect(rows.map((r) => r.recipe_id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
        // Every row carries a position — the audit found 14 NULL-position rows
        // in Production written by the old create/import loops.
        expect(rows.every((r) => typeof r.position === 'number')).toBe(true);
    });

    it('4-5. one unresolvable recipe among five fails the WHOLE create, leaving nothing', async () => {
        const res = await post({
            name: 'Partial', sku: 'P-1',
            contents: [
                { recipe_id: 'r1' }, { recipe_id: 'r2' },
                { recipe: { name: 'A Meal That Does Not Exist' } },
                { recipe_id: 'r4' }, { recipe_id: 'r5' },
            ],
        });

        expect(res.status).toBe(422);
        expect((await res.json()).error).toMatch(/could not match/i);
        // This is the five-to-three shape: previously the bundle was created
        // and held four rows while the caller was told it succeeded.
        expect(store.bundles).toHaveLength(0);
        expect(store.contents).toHaveLength(0);
    });

    it('5b. a failure part-way through the write leaves no partial composition', async () => {
        // The database rejects the content insert after the bundle row exists —
        // previously the bundle survived with zero contents and a 200 response.
        failNextContentWrite = true;

        const res = await post({ name: 'Boom', sku: 'B-1', contents: [{ recipe_id: 'r1' }] });

        expect(res.status).toBe(500);
        expect(store.bundles).toHaveLength(0); // rolled back together with the contents
        expect(store.contents).toHaveLength(0);
    });

    it('6. a foreign-tenant recipe is rejected and nothing is written', async () => {
        const res = await post({ name: 'Mixed', sku: 'M-1', contents: [{ recipe_id: 'r1' }, { recipe_id: 'foreign1' }] });

        expect(res.status).toBe(403);
        expect(store.bundles).toHaveLength(0);
        expect(store.contents).toHaveLength(0);
    });

    it('6b. an unowned (business_id = NULL) legacy recipe is rejected too', async () => {
        const res = await post({ name: 'Legacy', sku: 'L-1', contents: [{ recipe_id: 'unowned1' }] });

        expect(res.status).toBe(403);
        expect(store.bundles).toHaveLength(0);
    });

    it('7. duplicates collapse to one row with summed quantity (PART D contract)', async () => {
        const res = await post({
            name: 'Dupes', sku: 'D-1',
            contents: [{ recipe_id: 'r1', quantity: 1 }, { recipe_id: 'r2' }, { recipe_id: 'r1', quantity: 2 }],
        });

        expect(res.status).toBe(200);
        const rows = contentsOf((await res.json()).id);
        // Two distinct relationships, not three rows; the picker allows adding
        // the same meal twice and each row carries a quantity, so that means
        // "three of it", never a duplicate relationship.
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.recipe_id === 'r1').quantity).toBe(3);
        expect(rows.find((r) => r.recipe_id === 'r2').quantity).toBe(1);
        expect(rows.map((r) => r.position)).toEqual([0, 1]);
    });

    it('a bundle created with no contents key is still valid', async () => {
        const res = await post({ name: 'Empty', sku: 'E-1' });
        expect(res.status).toBe(200);
        expect(contentsOf((await res.json()).id)).toHaveLength(0);
    });

    it('resolution by SKU works and stays inside the business', async () => {
        const ok = await post({ name: 'BySku', sku: 'S-1', contents: [{ child_recipe: { sku: 'SKU-1' } }] });
        expect(ok.status).toBe(200);
        expect(contentsOf((await ok.json()).id)[0].recipe_id).toBe('r1');

        // Another tenant's SKU must not resolve, even though Recipe.sku is globally unique.
        const bad = await post({ name: 'Foreign', sku: 'S-2', contents: [{ child_recipe: { sku: 'SKU-F' } }] });
        expect(bad.status).toBe(422);
    });
});

// ===========================================================================
describe('EDIT', () => {
    it('8-10. renaming through the real editor payload keeps all five recipes', async () => {
        const bundle = await seedFiveRecipeBundle();

        // The editor submits the WHOLE form, contents included, on every save.
        const res = await put(bundle.id, {
            name: 'Q2 - Comfort Foods (renamed)', sku: 'Q2-CF',
            contents: MEALS.map((_, i) => ({ recipe_id: `r${i + 1}`, quantity: 1 })),
        });

        expect(res.status).toBe(200);
        expect(contentsOf(bundle.id)).toHaveLength(5);
        expect(store.bundles[0].name).toBe('Q2 - Comfort Foods (renamed)');
    });

    it('11. intentionally removing one yields exactly four', async () => {
        const bundle = await seedFiveRecipeBundle();

        const res = await put(bundle.id, {
            name: 'Q2', sku: 'Q2-CF',
            contents: [1, 2, 3, 4].map((i) => ({ recipe_id: `r${i}` })),
        });

        expect(res.status).toBe(200);
        const rows = contentsOf(bundle.id);
        expect(rows).toHaveLength(4);
        expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    });

    it('12. adding one back yields the correct count', async () => {
        const bundle = await seedFiveRecipeBundle();
        await put(bundle.id, { name: 'Q2', sku: 'Q2-CF', contents: [{ recipe_id: 'r1' }] });
        expect(contentsOf(bundle.id)).toHaveLength(1);

        const res = await put(bundle.id, {
            name: 'Q2', sku: 'Q2-CF',
            contents: [{ recipe_id: 'r1' }, { recipe_id: 'r2' }, { recipe_id: 'r3' }],
        });

        expect(res.status).toBe(200);
        expect(contentsOf(bundle.id)).toHaveLength(3);
    });

    it('13. an invalid recipe during replacement leaves the original five intact', async () => {
        const bundle = await seedFiveRecipeBundle();
        const before = clone(contentsOf(bundle.id));

        const res = await put(bundle.id, {
            name: 'Q2', sku: 'Q2-CF',
            contents: [{ recipe_id: 'r1' }, { recipe: { name: 'Nope' } }, { recipe_id: 'r3' }],
        });

        expect(res.status).toBe(422);
        // The destructive deleteMany must never have run.
        expect(contentsOf(bundle.id)).toHaveLength(5);
        expect(contentsOf(bundle.id)).toEqual(before);
    });

    it('13b. a foreign recipe during replacement leaves the original five intact', async () => {
        const bundle = await seedFiveRecipeBundle();

        const res = await put(bundle.id, {
            name: 'Q2', sku: 'Q2-CF',
            contents: [{ recipe_id: 'r1' }, { recipe_id: 'foreign1' }],
        });

        expect(res.status).toBe(403);
        expect(contentsOf(bundle.id)).toHaveLength(5);
    });

    it('13c. a null recipe_id fails cleanly instead of exploding inside the transaction', async () => {
        const bundle = await seedFiveRecipeBundle();

        const res = await put(bundle.id, {
            name: 'Q2', sku: 'Q2-CF',
            contents: [{ recipe_id: 'r1' }, { recipe_id: null }],
        });

        // Previously `.filter(Boolean)` hid this from validation and it surfaced
        // as an opaque 500 from inside the transaction.
        expect(res.status).toBe(422);
        expect(contentsOf(bundle.id)).toHaveLength(5);
    });

    it('14. saving repeatedly does not lose contents', async () => {
        const bundle = await seedFiveRecipeBundle();
        const payload = { name: 'Q2', sku: 'Q2-CF', contents: MEALS.map((_, i) => ({ recipe_id: `r${i + 1}` })) };

        for (let i = 0; i < 5; i++) {
            const res = await put(bundle.id, payload);
            expect(res.status).toBe(200);
            expect(contentsOf(bundle.id)).toHaveLength(5);
        }
        expect(contentsOf(bundle.id).map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
    });

    it('edit writes the VALIDATED set, not the raw payload — duplicates merge here too', async () => {
        const bundle = await seedFiveRecipeBundle();

        const res = await put(bundle.id, {
            name: 'Q2', sku: 'Q2-CF',
            contents: [
                { recipe_id: 'r1', quantity: 1 },
                { recipe_id: 'r2', quantity: 1 },
                { recipe_id: 'r1', quantity: 2 },
            ],
        });

        expect(res.status).toBe(200);
        const rows = contentsOf(bundle.id);
        // The old code mapped data.contents straight into createMany, which
        // would write three rows and leave two relationships for r1.
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.recipe_id === 'r1').quantity).toBe(3);
        expect(rows.map((r) => r.position)).toEqual([0, 1]);
    });

    it('edit normalizes a nonsensical quantity rather than storing it', async () => {
        const bundle = await seedFiveRecipeBundle();

        const res = await put(bundle.id, {
            name: 'Q2', sku: 'Q2-CF',
            contents: [{ recipe_id: 'r1', quantity: -4 }, { recipe_id: 'r2', quantity: 'abc' }],
        });

        expect(res.status).toBe(200);
        expect(contentsOf(bundle.id).map((r) => r.quantity)).toEqual([1, 1]);
    });

    it('omitting the contents key preserves contents; an empty array clears them', async () => {
        const bundle = await seedFiveRecipeBundle();

        await put(bundle.id, { name: 'Q2', sku: 'Q2-CF' });
        expect(contentsOf(bundle.id)).toHaveLength(5);

        await put(bundle.id, { name: 'Q2', sku: 'Q2-CF', contents: [] });
        expect(contentsOf(bundle.id)).toHaveLength(0);
    });

    it('editing another tenant\'s bundle is still forbidden (BUNDLE-SECURITY-1 intact)', async () => {
        const bundle = await seedFiveRecipeBundle();
        store.bundles[0].business_id = OTHER;

        const res = await put(bundle.id, { name: 'Hijack', sku: 'Q2-CF', contents: [] });
        expect(res.status).toBe(403);
        expect(contentsOf(bundle.id)).toHaveLength(5);
    });
});

// ===========================================================================
describe('IMPORT — the highest-risk path', () => {
    const exportOf = (name: string, sku: string, mealIndexes: number[]) => ({
        bundles: [{
            name, sku, description: 'd', price: 100, serving_tier: 'family', is_active: true,
            contents: mealIndexes.map((i) => ({ recipe: { sku: `SKU-${i}`, name: MEALS[i - 1] }, quantity: 1 })),
        }],
    });

    it('15-16. replacing five valid recipes yields exactly five', async () => {
        const bundle = await seedFiveRecipeBundle('Fall Keto', 'FK-1');

        const res = await importPayload(exportOf('Fall Keto', 'FK-1', [1, 2, 3, 4, 5]));

        expect(res.status).toBe(200);
        expect(contentsOf(bundle.id)).toHaveLength(5);
        expect(contentsOf(bundle.id).map((r) => r.position)).toEqual([0, 1, 2, 3, 4]);
    });

    it('17-19. two unresolved among five fails, the original five survive, no 3-row result', async () => {
        const bundle = await seedFiveRecipeBundle('Fall Keto', 'FK-1');
        const before = clone(contentsOf(bundle.id));

        const res = await importPayload({
            bundles: [{
                name: 'Fall Keto', sku: 'FK-1', price: 100, serving_tier: 'family', is_active: true,
                contents: [
                    { recipe: { sku: 'SKU-1' } },
                    { recipe: { sku: 'SKU-MISSING-A', name: 'Gone A' } },
                    { recipe: { sku: 'SKU-3' } },
                    { recipe: { sku: 'SKU-MISSING-B', name: 'Gone B' } },
                    { recipe: { sku: 'SKU-5' } },
                ],
            }],
        });

        expect(res.status).toBe(422);
        // This is the exact historical failure: five in, three resolvable,
        // three rows left behind, success returned.
        expect(contentsOf(bundle.id)).toHaveLength(5);
        expect(contentsOf(bundle.id)).toEqual(before);
        expect(contentsOf(bundle.id)).not.toHaveLength(3);
    });

    it('20. a foreign-tenant recipe reference fails without mutating anything', async () => {
        const bundle = await seedFiveRecipeBundle('Fall Keto', 'FK-1');

        const res = await importPayload({
            bundles: [{
                name: 'Fall Keto', sku: 'FK-1', price: 100, serving_tier: 'family', is_active: true,
                contents: [{ recipe: { sku: 'SKU-1' } }, { recipe: { sku: 'SKU-F', name: 'Foreign Meal' } }],
            }],
        });

        expect(res.status).toBe(422);
        expect(contentsOf(bundle.id)).toHaveLength(5);
    });

    it('a failure in the SECOND bundle rolls the FIRST one back too', async () => {
        const a = await seedFiveRecipeBundle('Bundle A', 'A-1');
        const b = await seedFiveRecipeBundle('Bundle B', 'B-1');

        const res = await importPayload({
            bundles: [
                { name: 'Bundle A', sku: 'A-1', price: 1, serving_tier: 'family', is_active: true,
                    contents: [{ recipe: { sku: 'SKU-1' } }] },
                { name: 'Bundle B', sku: 'B-1', price: 1, serving_tier: 'family', is_active: true,
                    contents: [{ recipe: { sku: 'SKU-NOPE', name: 'Nope' } }] },
            ],
        });

        expect(res.status).toBe(422);
        // Neither bundle may be left half-imported.
        expect(contentsOf(a.id)).toHaveLength(5);
        expect(contentsOf(b.id)).toHaveLength(5);
    });

    it('an import naming another tenant\'s bundle SKU cannot wipe that bundle', async () => {
        const victim = await seedFiveRecipeBundle('Victim', 'VICTIM-SKU');
        store.bundles.find((x) => x.id === victim.id).business_id = OTHER;

        const res = await importPayload({
            bundles: [{
                name: 'Something Else', sku: 'VICTIM-SKU', price: 1, serving_tier: 'family', is_active: true,
                contents: [{ recipe: { sku: 'SKU-1' } }],
            }],
        });

        expect(res.status).toBe(200);
        // The victim keeps its contents; a NEW bundle was created for this tenant.
        expect(contentsOf(victim.id)).toHaveLength(5);
        expect(store.bundles.filter((x) => x.business_id === TENANT)).toHaveLength(1);
    });

    it('a database failure MID-transaction restores the previous contents', async () => {
        const bundle = await seedFiveRecipeBundle('Fall Keto', 'FK-1');
        // Everything resolves, so planning succeeds and the transaction opens —
        // then the content insert fails. The wipe must be undone with it.
        failNextContentWrite = true;

        const res = await importPayload(exportOf('Fall Keto', 'FK-1', [1, 2, 3]));

        expect(res.status).toBe(500);
        // If the deleteMany ran outside the transaction it would be durable and
        // this bundle would now hold nothing at all.
        expect(contentsOf(bundle.id)).toHaveLength(5);
    });

    it('importing a brand-new bundle still works end to end', async () => {
        const res = await importPayload(exportOf('Brand New', 'BN-1', [1, 2, 3]));

        expect(res.status).toBe(200);
        const created = store.bundles.find((x) => x.name === 'Brand New');
        expect(created).toBeTruthy();
        expect(contentsOf(created.id)).toHaveLength(3);
    });
});

// ===========================================================================
describe('SERVES-2 / VARIANT — count preservation must remain', () => {
    const duplicate = async (id: string) => {
        const { POST } = require('@/app/api/bundles/[id]/duplicate-serves-2/route');
        return POST(new Request(`https://x/api/bundles/${id}/duplicate-serves-2`, { method: 'POST' }),
            { params: Promise.resolve({ id }) });
    };

    it('21. duplicating preserves the recipe count when counterparts exist', async () => {
        MEALS.forEach((name, i) =>
            store.recipes.push({ id: `s${i + 1}`, name: `${name} (Serves 2)`, sku: `SKU-S${i + 1}`, business_id: TENANT }));
        const bundle = await seedFiveRecipeBundle('Hearty Meals', 'HM-1');

        const res = await duplicate(bundle.id);
        expect(res.status).toBe(200);

        const cloneId = (await res.json()).id;
        expect(contentsOf(cloneId)).toHaveLength(5);
        expect(contentsOf(cloneId).map((r) => r.recipe_id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    });

    it('22. a MISSING Serves-2 counterpart falls back without reducing the count', async () => {
        // Only three of the five meals have a Serves-2 variant.
        [1, 2, 3].forEach((i) =>
            store.recipes.push({ id: `s${i}`, name: `${MEALS[i - 1]} (Serves 2)`, sku: `SKU-S${i}`, business_id: TENANT }));
        const bundle = await seedFiveRecipeBundle('Hearty Meals', 'HM-1');

        const res = await duplicate(bundle.id);
        expect(res.status).toBe(200);

        const cloneId = (await res.json()).id;
        // Still FIVE. The two without a counterpart fall back to the original
        // recipe rather than being dropped — this is the behavior the audit
        // cleared, and it must not regress into a five-to-three.
        expect(contentsOf(cloneId)).toHaveLength(5);
        expect(contentsOf(cloneId).map((r) => r.recipe_id)).toEqual(['s1', 's2', 's3', 'r4', 'r5']);
    });
});

// ===========================================================================
describe('no-drift — this phase repaired integrity only', () => {
    it('no schema change and no migration accompany this phase', () => {
        const { execSync } = require('child_process');
        const changed = execSync('git status --porcelain prisma/', { cwd: process.cwd(), encoding: 'utf8' });
        expect(changed).not.toContain('migrations/');
    });

    it('image_url persistence was deferred at the time this phase ran, and later implemented deliberately', () => {
        // BUNDLE-MEDIA-1 added it on purpose; tests/bundleMedia1.test.ts owns
        // that contract now. This phase's own guarantee — recipe resolution
        // stays fully validated and atomic — is unaffected by that field.
        const { readFileSync } = require('fs');
        const src = readFileSync('app/api/bundles/route.ts', 'utf8');
        expect(src).toContain('resolveBundleContents(');
    });
});
