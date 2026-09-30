/**
 * STOREFRONT-CUSTOMER-EXPERIENCE-1A — bundle price integrity.
 *
 * The defect these tests exist to prevent: PUT /api/bundles/[id] wrote every
 * column on every call, so the Bundles list's one-flag switches
 * ({ is_active } / { show_on_storefront }) silently set price,
 * order_cutoff_date and catalog_id to NULL. A NULL price then reached
 * storefront checkout as $0 (buildBundlePriceMap reads it as Number(null)),
 * and the storefront showed a stored 'serves_2' bundle the $125 family
 * fallback.
 *
 * Behavioral tests: the real route handlers run against one stateful in-memory
 * Prisma double with transaction rollback, so "unchanged" is proven by reading
 * the stored row back rather than by asserting a source string.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TENANT = 'biz-sf1a-aaaa';
const OTHER = 'biz-sf1a-bbbb';
const SLUG = 'sf1a-kitchen';
const OTHER_SLUG = 'sf1a-other';

// ---------------------------------------------------------------------------
// Stateful Prisma double.
// ---------------------------------------------------------------------------
type Row = Record<string, any>;

const store: Record<'businesses' | 'bundles' | 'contents' | 'recipes' | 'catalogs' | 'orders', Row[]> = {
    businesses: [], bundles: [], contents: [], recipes: [], catalogs: [], orders: [],
};

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;
/** JSON round-trip: Dates become ISO strings, so before/after rows compare structurally. */
const snap = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Every `data` object the bundle table was updated with, in order. */
let bundleUpdates: Row[] = [];

const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && !(v instanceof Date) && Array.isArray((v as any).in)) {
            return (v as any).in.includes(row[k]);
        }
        return row[k] === v;
    });

/** `include: { contents: { include: { recipe } } }`, as the public storefront reads bundles. */
const hydrate = (row: Row, include: any): Row => {
    const out = { ...row };
    if (include?.contents) {
        out.contents = store.contents
            .filter((c) => c.bundle_id === row.id)
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            .map((c) => ({
                ...c,
                recipe: { categories: [], child_items: [], ...(store.recipes.find((r) => r.id === c.recipe_id) ?? {}) },
            }));
    }
    return out;
};

const model = (table: keyof typeof store, prefix: string, undo?: (() => void)[]) => ({
    findFirst: async ({ where, include }: any = {}) => {
        const row = store[table].find((r) => matches(r, where));
        return row ? hydrate(row, include) : null;
    },
    findUnique: async ({ where, include }: any = {}) => {
        const row = store[table].find((r) => matches(r, where));
        return row ? hydrate(row, include) : null;
    },
    findMany: async ({ where, include }: any = {}) =>
        store[table].filter((r) => matches(r, where)).map((r) => hydrate(r, include)),
    create: async ({ data }: any) => {
        const { items, ...rest } = data ?? {};
        const row: Row = { id: rest.id ?? nextId(prefix), ...rest };
        if (items?.create) row.items = items.create;
        store[table].push(row);
        undo?.push(() => {
            const i = store[table].findIndex((r) => r.id === row.id);
            if (i >= 0) store[table].splice(i, 1);
        });
        return { ...row };
    },
    createMany: async ({ data }: any) => {
        const added: string[] = [];
        for (const d of data) {
            const row = { id: nextId(prefix), ...d };
            store[table].push(row);
            added.push(row.id);
        }
        undo?.push(() => {
            store[table] = store[table].filter((r) => !added.includes(r.id));
        });
        return { count: data.length };
    },
    update: async ({ where, data }: any) => {
        const row = store[table].find((r) => matches(r, where));
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        if (table === 'bundles') bundleUpdates.push({ ...data });
        const prev = { ...row };
        // Prisma skips an `undefined` value rather than writing it.
        for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
        undo?.push(() => {
            const cur = store[table].find((r) => r.id === prev.id);
            if (cur) {
                for (const k of Object.keys(cur)) delete cur[k];
                Object.assign(cur, prev);
            }
        });
        return { ...row };
    },
    deleteMany: async ({ where }: any = {}) => {
        const removed = store[table].filter((r) => matches(r, where));
        store[table] = store[table].filter((r) => !matches(r, where));
        undo?.push(() => { store[table].push(...removed); });
        return { count: removed.length };
    },
});

const makeClient = (undo?: (() => void)[]) => ({
    business: model('businesses', 'biz', undo),
    bundle: model('bundles', 'b', undo),
    bundleContent: model('contents', 'bc', undo),
    recipe: model('recipes', 'r', undo),
    catalog: model('catalogs', 'cat', undo),
    order: model('orders', 'o', undo),
});

const prismaDouble: any = {
    ...makeClient(),
    // Checkout reads these; neither is configured for the fixture tenant.
    storefrontConfig: { findUnique: async () => null },
    integration: { findUnique: async () => null },
    // The public storefront's raw reads (fundraisers, branding, storefront config): nothing configured.
    $queryRaw: async () => [],
    $transaction: async (fn: any) => {
        const undo: (() => void)[] = [];
        try {
            return await fn(makeClient(undo));
        } catch (err) {
            for (const step of undo.reverse()) step();
            throw err;
        }
    },
};

const mockAuth = jest.fn();
const mockGetPaymentProvider = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/db', () => ({ prisma: prismaDouble }));
jest.mock('@/lib/stripe', () => ({ stripe: {} }));
jest.mock('@/lib/customerAuth', () => ({ getCustomerSession: async () => null }));
jest.mock('@/lib/payments', () => ({ getPaymentProvider: (...args: any[]) => mockGetPaymentProvider(...args) }));
jest.mock('@/lib/delivery/zones', () => ({ geocodeAddress: jest.fn(), resolveDeliveryZone: jest.fn() }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A storefront bundle with every protected column set, so any stray write is visible. */
const KETO = {
    id: 'b-keto-5',
    business_id: TENANT,
    name: 'Keto Fall 2026',
    sku: 'KETO-F26-5',
    description: 'Five keto dinners.',
    serving_tier: 'serves_5',
    is_active: true,
    show_on_storefront: true,
    price: '125.00',
    order_cutoff_date: new Date('2026-10-15T00:00:00.000Z'),
    catalog_id: 'cat-fall',
    image_url: 'https://img.example/keto.jpg',
    family_id: 'fam-keto',
    stock_on_hand: 4,
};

function seed() {
    seq = 0;
    bundleUpdates = [];
    store.businesses = [
        { id: TENANT, name: 'SF1A Kitchen', display_name: null, slug: SLUG, logo_url: null, timezone: 'America/Chicago' },
        { id: OTHER, name: 'Other Kitchen', display_name: null, slug: OTHER_SLUG, logo_url: null, timezone: 'America/Chicago' },
    ];
    store.catalogs = [
        { id: 'cat-fall', name: 'Fall', business_id: TENANT },
        { id: 'cat-winter', name: 'Winter', business_id: TENANT },
        { id: 'cat-foreign', name: 'Foreign', business_id: OTHER },
    ];
    store.recipes = [
        { id: 'r1', name: 'Taco Casserole', sku: 'R-1', business_id: TENANT },
        { id: 'r2', name: 'Chicken Pot Pie', sku: 'R-2', business_id: TENANT },
    ];
    store.bundles = [
        { ...KETO },
        {
            id: 'b-foreign', business_id: OTHER, name: 'Foreign Bundle', sku: 'FOR-1', description: null,
            serving_tier: 'serves_5', is_active: true, show_on_storefront: true, price: '99.00',
            order_cutoff_date: null, catalog_id: 'cat-foreign', image_url: null, family_id: null, stock_on_hand: 0,
        },
    ];
    store.contents = [
        { id: 'bc-1', bundle_id: KETO.id, recipe_id: 'r1', position: 0, quantity: 1 },
        { id: 'bc-2', bundle_id: KETO.id, recipe_id: 'r2', position: 1, quantity: 1 },
    ];
    store.orders = [];
}

const row = (id: string) => store.bundles.find((b) => b.id === id)!;
const contentsOf = (id: string) => store.contents.filter((c) => c.bundle_id === id);

const put = async (id: string, body: unknown) => {
    const { PUT } = require('@/app/api/bundles/[id]/route');
    const res: Response = await PUT(new Request(`https://x/api/bundles/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() };
};

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

beforeEach(() => {
    seed();
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { businessId: TENANT } });
    mockGetPaymentProvider.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// A. The Storefront switch changes one flag and nothing else.
// ═════════════════════════════════════════════════════════════════════════════
describe('A. storefront toggle leaves price, cutoff and catalog unchanged', () => {
    it('{ show_on_storefront: false } changes only show_on_storefront', async () => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { show_on_storefront: false });
        expect(res.status).toBe(200);
        expect(snap(row(KETO.id))).toEqual({ ...before, show_on_storefront: false });
        expect(row(KETO.id).price).toBe('125.00');
        expect(snap(row(KETO.id).order_cutoff_date)).toBe('2026-10-15T00:00:00.000Z');
        expect(row(KETO.id).catalog_id).toBe('cat-fall');
    });

    it('the write carries exactly the one key that was sent, never the rest of the body', async () => {
        await put(KETO.id, { show_on_storefront: false });
        expect(bundleUpdates).toEqual([{ show_on_storefront: false }]);
    });

    it('switching it back on restores the flag and still leaves every other column alone', async () => {
        await put(KETO.id, { show_on_storefront: false });
        const before = snap(row(KETO.id));
        await put(KETO.id, { show_on_storefront: true });
        expect(snap(row(KETO.id))).toEqual({ ...before, show_on_storefront: true });
    });

    it('the bundle keeps its contents', async () => {
        await put(KETO.id, { show_on_storefront: false });
        expect(contentsOf(KETO.id).map((c) => c.recipe_id)).toEqual(['r1', 'r2']);
    });

    it('the Bundles list really does send the one flag alone (the caller this contract serves)', () => {
        const src = read('app/bundles/page.tsx');
        expect(src).toMatch(/body: JSON\.stringify\(\{ show_on_storefront: newStatus \}\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. The Active switch, same invariant.
// ═════════════════════════════════════════════════════════════════════════════
describe('B. active toggle leaves price, cutoff and catalog unchanged', () => {
    it('{ is_active: false } changes only is_active', async () => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { is_active: false });
        expect(res.status).toBe(200);
        expect(snap(row(KETO.id))).toEqual({ ...before, is_active: false });
        expect(bundleUpdates).toEqual([{ is_active: false }]);
    });

    it('reactivating changes only is_active', async () => {
        await put(KETO.id, { is_active: false });
        const before = snap(row(KETO.id));
        await put(KETO.id, { is_active: true });
        expect(snap(row(KETO.id))).toEqual({ ...before, is_active: true });
    });

    it('the Bundles list really does send the one flag alone', () => {
        const src = read('app/bundles/page.tsx');
        expect(src).toMatch(/body: JSON\.stringify\(\{ is_active: newStatus \}\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. An explicit value is validated, then written.
// ═════════════════════════════════════════════════════════════════════════════
describe('C. an explicit price update applies', () => {
    it('a new price is written and nothing else moves', async () => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { price: '89.50' });
        expect(res.status).toBe(200);
        expect(snap(row(KETO.id))).toEqual({ ...before, price: 89.5 });
    });

    it('a numeric price is accepted too', async () => {
        await put(KETO.id, { price: 130 });
        expect(row(KETO.id).price).toBe(130);
    });

    it('a stored $0.00 remains expressible (the editor may still save it)', async () => {
        await put(KETO.id, { price: '0' });
        expect(row(KETO.id).price).toBe(0);
    });

    it('the full Bundle Editor save still writes every field it sends', async () => {
        const res = await put(KETO.id, {
            name: 'Keto Winter 2026',
            sku: 'KETO-W26-5',
            description: 'Five warming keto dinners.',
            serving_tier: 'family',
            catalog_id: 'cat-winter',
            image_url: 'https://img.example/keto-winter.jpg',
            price: '129.00',
            stock_on_hand: '9',
            order_cutoff_date: '2026-12-01',
            is_active: true,
            show_on_storefront: false,
            contents: [{ recipe_id: 'r2', quantity: 2 }],
        });
        expect(res.status).toBe(200);
        const r = snap(row(KETO.id));
        expect(r).toMatchObject({
            name: 'Keto Winter 2026',
            sku: 'KETO-W26-5',
            description: 'Five warming keto dinners.',
            serving_tier: 'family',
            catalog_id: 'cat-winter',
            image_url: 'https://img.example/keto-winter.jpg',
            price: 129,
            order_cutoff_date: '2026-12-01T00:00:00.000Z',
            is_active: true,
            show_on_storefront: false,
        });
        // Columns this route has never written stay exactly as they were.
        expect(r.family_id).toBe('fam-keto');
        expect(r.stock_on_hand).toBe(4);
        expect(contentsOf(KETO.id).map((c) => [c.recipe_id, c.quantity])).toEqual([['r2', 2]]);
    });

    it.each([
        ['a negative price', { price: -1 }],
        ['a word', { price: 'abc' }],
        ['a currency-formatted string', { price: '$125' }],
        ['a boolean', { price: true }],
        ['an object', { price: { amount: 5 } }],
        ['an amount beyond DECIMAL(10,2)', { price: 1e9 }],
    ])('%s is refused with 400 and the row is untouched', async (_label, body) => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Price must be an amount of $0.00 or more.');
        expect(snap(row(KETO.id))).toEqual(before);
        expect(bundleUpdates).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. An explicit clear only clears what may be NULL.
// ═════════════════════════════════════════════════════════════════════════════
describe('D. an explicit clear only clears nullable fields', () => {
    it.each([
        ['price', '', null],
        ['price', null, null],
        ['order_cutoff_date', '', null],
        ['catalog_id', '', null],
        ['image_url', '', null],
        ['description', null, null],
    ])('%s sent as %p clears to NULL and nothing else moves', async (field, sent, stored) => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { [field]: sent });
        expect(res.status).toBe(200);
        expect(snap(row(KETO.id))).toEqual({ ...before, [field]: stored });
    });

    it.each([
        ['name', null, 'Bundle name is required.'],
        ['name', '   ', 'Bundle name is required.'],
        ['sku', '', 'Bundle SKU is required.'],
        ['serving_tier', null, 'Serving size is required.'],
        ['is_active', null, 'is_active must be true or false.'],
        ['is_active', 'false', 'is_active must be true or false.'],
        ['show_on_storefront', null, 'show_on_storefront must be true or false.'],
        ['order_cutoff_date', 'not-a-date', 'Order cutoff date is not a valid date.'],
        ['catalog_id', 42, 'catalog_id must be a catalog id.'],
    ])('%s sent as %p is refused with 400 and nothing is written', async (field, sent, message) => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { [field]: sent });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(message);
        expect(snap(row(KETO.id))).toEqual(before);
        expect(bundleUpdates).toEqual([]);
    });

    it('a bad field refuses the whole request, even alongside valid ones', async () => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { show_on_storefront: false, name: '' });
        expect(res.status).toBe(400);
        expect(snap(row(KETO.id))).toEqual(before);
    });

    it('family_id is not writable through this route, even as an explicit null', async () => {
        const res = await put(KETO.id, { family_id: null, business_id: OTHER, id: 'hijack' });
        expect(res.status).toBe(200);
        expect(row(KETO.id).family_id).toBe('fam-keto');
        expect(row(KETO.id).business_id).toBe(TENANT);
        expect(bundleUpdates).toEqual([{}]);
    });

    it('a body that is not an object is refused', async () => {
        const res = await put(KETO.id, [{ price: null }]);
        expect(res.status).toBe(400);
        expect(row(KETO.id).price).toBe('125.00');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. An omitted price never becomes NULL.
// ═════════════════════════════════════════════════════════════════════════════
describe('E. an omitted price never becomes null', () => {
    it('renaming leaves price, cutoff and catalog as they were', async () => {
        const before = snap(row(KETO.id));
        await put(KETO.id, { name: 'Keto Fall 2026 (Renamed)' });
        expect(snap(row(KETO.id))).toEqual({ ...before, name: 'Keto Fall 2026 (Renamed)' });
    });

    it('a contents-only save leaves every column alone', async () => {
        const before = snap(row(KETO.id));
        await put(KETO.id, { contents: [{ recipe_id: 'r1', quantity: 1 }] });
        expect(snap(row(KETO.id))).toEqual(before);
        expect(contentsOf(KETO.id).map((c) => c.recipe_id)).toEqual(['r1']);
    });

    it('an empty body changes nothing', async () => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, {});
        expect(res.status).toBe(200);
        expect(snap(row(KETO.id))).toEqual(before);
    });

    it('a refused contents save writes no column either', async () => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { show_on_storefront: false, contents: [{ recipe_id: 'no-such-recipe' }] });
        expect(res.status).toBe(403);
        expect(snap(row(KETO.id))).toEqual(before);
        expect(contentsOf(KETO.id)).toHaveLength(2);
    });

    it('the route builds its own update object and never passes client fields through', () => {
        const src = strip(read('app/api/bundles/[id]/route.ts'));
        expect(src).toMatch(/data: update\.data/);
        expect(src).not.toMatch(/data\.price|data\.order_cutoff_date|data\.catalog_id|data\.is_active|data\.show_on_storefront/);
        expect(src).not.toMatch(/\.\.\.data\b/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. A NULL price refuses the purchase; it never becomes $0.
// ═════════════════════════════════════════════════════════════════════════════
describe('F. a NULL price refuses the purchase and never becomes $0', () => {
    const createCheckout = jest.fn(async () => ({ squareConfig: { applicationId: 'sandbox-app' } }));

    const checkout = async (items: any[], slug = SLUG) => {
        const { POST } = require('@/app/api/checkout/session/route');
        const res: Response = await POST(new Request('https://shop.example/api/checkout/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                slug, items, fulfillmentType: 'pickup',
                customerName: 'Test Buyer', customerEmail: 'buyer@example.test',
            }),
        }));
        return { status: res.status, body: await res.json() };
    };

    const line = (bundleId: string, quantity = 1) => ({
        bundleId, quantity, name: 'client-sent name', price: 60, serving_tier: 'serves_2',
    });

    beforeEach(() => {
        createCheckout.mockClear();
        mockGetPaymentProvider.mockResolvedValue({ type: 'square', provider: { createCheckout } });
        store.bundles.push(
            { ...KETO, id: 'b-unpriced', name: 'Keto Fall 2026 Serves 2', sku: 'KETO-F26-2', serving_tier: 'serves_2', price: null },
            { ...KETO, id: 'b-zero', name: 'Zero Dollar Bundle', sku: 'ZERO-1', price: '0.00' },
        );
    });

    it('an unpriced bundle is refused with a customer-safe message', async () => {
        const res = await checkout([line('b-unpriced')]);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(
            'Keto Fall 2026 Serves 2 is not available to order online right now. Please remove it from your bag.');
    });

    it('the refusal happens before any order row or payment session exists', async () => {
        await checkout([line('b-unpriced')]);
        expect(store.orders).toEqual([]);
        expect(mockGetPaymentProvider).not.toHaveBeenCalled();
        expect(createCheckout).not.toHaveBeenCalled();
    });

    it('a stored $0.00 is refused too — the storefront never charges $0', async () => {
        const res = await checkout([line('b-zero')]);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/^Zero Dollar Bundle is not available to order online right now\./);
        expect(store.orders).toEqual([]);
    });

    it('a mixed bag is refused as a whole and names only the unpriced line', async () => {
        const res = await checkout([line(KETO.id), line('b-unpriced')]);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/^Keto Fall 2026 Serves 2 is not available/);
        expect(res.body.error).not.toMatch(/^Keto Fall 2026 is/);
        expect(store.orders).toEqual([]);
    });

    it('a priced bundle still checks out at the stored price, not the client price', async () => {
        const res = await checkout([line(KETO.id, 2)]);
        expect(res.status).toBe(200);
        expect(store.orders).toHaveLength(1);
        expect(store.orders[0].total_amount).toBe(250);
        expect(store.orders[0].items).toEqual([expect.objectContaining({ bundle_id: KETO.id, quantity: 2, unit_price: 125 })]);
        expect(createCheckout).toHaveBeenCalledTimes(1);
    });

    it('the stored NULL is left exactly as it was (no data repair, no default written)', async () => {
        await checkout([line('b-unpriced')]);
        expect(row('b-unpriced').price).toBeNull();
    });

    it('the shared price authority is unchanged; the refusal lives in the storefront checkout route', () => {
        expect(strip(read('lib/pricing.ts'))).toMatch(/dbBundles\.map\(\(b: any\) => \[b\.id, Number\(b\.price\)\]\)/);
        // The fundraiser order paths already refuse a NULL (read as 0) with their own message.
        expect(read('app/api/public/order/route.ts')).toMatch(/has no valid price/);
        expect(read('app/api/coordinator/route.ts')).toMatch(/has no valid price/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. The serves_2 display fallback.
// ═════════════════════════════════════════════════════════════════════════════
describe('G. the storefront display fallback reads serving size from the shared authority', () => {
    const storefront = async (slug = SLUG) => {
        const { GET } = require('@/app/api/public/tenant/[slug]/route');
        const res: Response = await GET(new Request(`https://x/api/public/tenant/${slug}`), {
            params: Promise.resolve({ slug }),
        });
        return { status: res.status, body: await res.json() };
    };

    const listed = (id: string, serving_tier: string, price: string | null) => ({
        id, business_id: TENANT, name: `Bundle ${id}`, sku: `SKU-${id}`, description: null, serving_tier,
        is_active: true, show_on_storefront: true, price, order_cutoff_date: null, catalog_id: null,
        image_url: null, family_id: null, stock_on_hand: 0,
    });

    beforeEach(() => {
        store.bundles = [
            listed('s2-null', 'serves_2', null),
            listed('s5-null', 'serves_5', null),
            listed('couple-null', 'couple', null),
            listed('label-null', 'Serves 2', null),
            listed('family-null', 'family', null),
            listed('s2-priced', 'serves_2', '72.00'),
            listed('s5-priced', 'serves_5', '119.00'),
        ];
        store.contents = [];
    });

    const priceOf = (body: any, id: string) => body.bundles.find((b: any) => b.id === id)?.price;

    it("a NULL-priced 'serves_2' bundle shows the Serves 2 fallback, not the family one", async () => {
        const { status, body } = await storefront();
        expect(status).toBe(200);
        expect(priceOf(body, 's2-null')).toBe(60);
    });

    it('the tiers the old check already recognised keep their fallback', async () => {
        const { body } = await storefront();
        expect(priceOf(body, 'couple-null')).toBe(60);
        expect(priceOf(body, 'label-null')).toBe(60);
        expect(priceOf(body, 's5-null')).toBe(125);
        expect(priceOf(body, 'family-null')).toBe(125);
    });

    it('a stored price always wins over any fallback', async () => {
        const { body } = await storefront();
        expect(priceOf(body, 's2-priced')).toBe(72);
        expect(priceOf(body, 's5-priced')).toBe(119);
    });

    it('the route uses the shared tier authority, not its own list', () => {
        const src = strip(read('app/api/public/tenant/[slug]/route.ts'));
        expect(src).toMatch(/from '@\/lib\/serving_multipliers'/);
        expect(src).toMatch(/normalizeStrictServingTier\(b\.serving_tier\) === 'serves_2'/);
        expect(src).not.toMatch(/includes\('couple'\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// H. Tenant isolation.
// ═════════════════════════════════════════════════════════════════════════════
describe('H. tenant isolation', () => {
    it("another tenant's bundle cannot be edited, and is left exactly as it was", async () => {
        const before = snap(row('b-foreign'));
        const res = await put('b-foreign', { show_on_storefront: false, price: '' });
        expect(res.status).toBe(403);
        expect(snap(row('b-foreign'))).toEqual(before);
        expect(bundleUpdates).toEqual([]);
    });

    it("a bundle cannot be filed under another tenant's catalog", async () => {
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { catalog_id: 'cat-foreign' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Catalog not found');
        expect(snap(row(KETO.id))).toEqual(before);
    });

    it("moving a bundle between the tenant's own catalogs works", async () => {
        const res = await put(KETO.id, { catalog_id: 'cat-winter' });
        expect(res.status).toBe(200);
        expect(row(KETO.id).catalog_id).toBe('cat-winter');
    });

    it('an unauthenticated caller writes nothing', async () => {
        mockAuth.mockResolvedValue(null);
        const before = snap(row(KETO.id));
        const res = await put(KETO.id, { price: '' });
        expect(res.status).toBe(401);
        expect(snap(row(KETO.id))).toEqual(before);
    });

    it("checkout never names another tenant's bundle and resolves prices only inside the slug's tenant", async () => {
        store.bundles.push(
            { ...KETO, id: 'b-unpriced', name: 'Keto Fall 2026 Serves 2', sku: 'KETO-F26-2', price: null },
            {
                id: 'b-foreign-unpriced', business_id: OTHER, name: 'Other Tenant Secret Bundle', sku: 'OTH-2',
                serving_tier: 'serves_2', is_active: true, show_on_storefront: true, price: null,
            },
        );
        const findMany = jest.spyOn(prismaDouble.bundle, 'findMany');
        const { POST } = require('@/app/api/checkout/session/route');
        const res: Response = await POST(new Request('https://shop.example/api/checkout/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                slug: SLUG, fulfillmentType: 'pickup', customerName: 'Test Buyer',
                items: [
                    { bundleId: 'b-unpriced', quantity: 1, price: 60 },
                    { bundleId: 'b-foreign-unpriced', quantity: 1, price: 60 },
                ],
            }),
        }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toMatch(/^Keto Fall 2026 Serves 2 is not available/);
        expect(body.error).not.toMatch(/Other Tenant Secret Bundle/);
        expect(store.orders).toEqual([]);
        for (const call of findMany.mock.calls) {
            expect((call[0] as any)?.where?.business_id).toBe(TENANT);
        }
        findMany.mockRestore();
    });

    it("the storefront lists only the slug's own bundles", async () => {
        const { GET } = require('@/app/api/public/tenant/[slug]/route');
        const res: Response = await GET(new Request(`https://x/api/public/tenant/${SLUG}`), {
            params: Promise.resolve({ slug: SLUG }),
        });
        const body = await res.json();
        expect(body.bundles.map((b: any) => b.id)).toEqual([KETO.id]);
    });
});
