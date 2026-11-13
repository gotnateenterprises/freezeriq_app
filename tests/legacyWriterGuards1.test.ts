/**
 * LEGACY-WRITER-GUARDS-1 — legacy writers may no longer damage live fundraiser truth.
 *
 * Five writers, from FREEZERIQ-SYSTEM-AUDIT-FABLE-5.2-1, each re-verified on Production 118a5e0:
 *
 *   1. PUT    /api/bundles/[id]          — the Bundles list's Active / Storefront switches send one flag,
 *                                          and the handler wrote NULL into price, cutoff and catalog.
 *   2. DELETE /api/bundles/[id]          — a bundle that orders, invoices or campaign menus point at was
 *                                          deleted, silently unlinking that history (SET NULL / CASCADE).
 *   3. DELETE /api/orders                — any order, in any state, was hard-deleted with its items.
 *   4. PUT    /api/customers/[id]        — an organization profile save pushed goal, start date, labels,
 *                                          payment text (and fill-only logistics) into a live campaign.
 *   5. PUT    /api/campaigns/[id]/bundles — the old campaign bundle editor replaced a menu on closed,
 *                                          coordinator-selected and already-ordered campaigns.
 *
 * Behavioural tests. The real handlers run against a stateful in-memory database double whose
 * $transaction rolls back on throw, so "a refused write changes nothing" is proven by comparing the
 * whole store before and after — not by asserting that some call did not happen. Fixtures are
 * fictional; nothing here touches a real database.
 */
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { buildBundleUpdateData } from '@/lib/bundleUpdate';
import { bundleDeletionRefusal } from '@/lib/bundleDeletion';
import { orderDeletionRefusal, type DeletableOrderFacts } from '@/lib/orderDeletion';
import { legacyBundleAssignmentRefusal } from '@/lib/legacyBundleAssignment';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__lwg1Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__lwg1Session) }));

const TENANT = 'biz-lwg1-a';
const OTHER = 'biz-lwg1-b';
const signIn = (businessId: string | null) => {
    (global as any).__lwg1Session = businessId
        ? { user: { businessId, role: 'ADMIN', email: 'owner@example.test' } }
        : null;
};

beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});
beforeEach(() => { signIn(TENANT); });

// ---------------------------------------------------------------------------
// Stateful database double
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
interface Store {
    bundles: Row[]; bundleContents: Row[]; catalogs: Row[];
    orders: Row[]; orderItems: Row[]; invoiceItems: Row[];
    campaigns: Row[]; campaignBundles: Row[]; customers: Row[];
}

/** Deep copy that keeps Date objects as Dates, so a rollback restores exactly what was there. */
const deepCopy = <T>(v: T): T => {
    if (v instanceof Date) return new Date(v.getTime()) as any;
    if (Array.isArray(v)) return v.map(deepCopy) as any;
    if (v && typeof v === 'object') {
        const out: any = {};
        for (const [k, x] of Object.entries(v)) out[k] = deepCopy(x);
        return out;
    }
    return v;
};
const fingerprint = (s: Store) => JSON.stringify(s);

const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && !(v instanceof Date) && Array.isArray((v as any).in)) {
            return (v as any).in.includes(row[k]);
        }
        return row[k] === v;
    });

interface Db {
    store: Store;
    client: any;
    /** Every call, in order, as `model.method` — lets a test prove a lock came first. */
    log: string[];
    /** Runs when a row lock is taken: lets a test simulate a write committed just before it. */
    onRowLock?: (sql: string, values: any[]) => void;
}

const makeDb = (seed: Partial<Store>): Db => {
    const store: Store = {
        bundles: [], bundleContents: [], catalogs: [], orders: [], orderItems: [],
        invoiceItems: [], campaigns: [], campaignBundles: [], customers: [],
        ...deepCopy(seed),
    } as Store;
    const log: string[] = [];
    const db: Db = { store, client: {}, log };

    const model = (name: string, table: () => Row[], hydrate?: (r: Row, args: any) => Row) => ({
        findUnique: async (args: any) => {
            log.push(`${name}.findUnique`);
            const r = table().find((x) => matches(x, args?.where));
            return r ? deepCopy(hydrate ? hydrate(r, args) : r) : null;
        },
        findFirst: async (args: any) => {
            log.push(`${name}.findFirst`);
            const r = table().find((x) => matches(x, args?.where));
            return r ? deepCopy(hydrate ? hydrate(r, args) : r) : null;
        },
        findMany: async (args: any) => {
            log.push(`${name}.findMany`);
            return deepCopy(table().filter((x) => matches(x, args?.where)));
        },
        count: async (args: any) => {
            log.push(`${name}.count`);
            return table().filter((x) => matches(x, args?.where)).length;
        },
        update: async (args: any) => {
            log.push(`${name}.update`);
            const r = table().find((x) => matches(x, args.where));
            if (!r) throw new Error(`${name} not found`);
            for (const [k, v] of Object.entries(args.data || {})) if (v !== undefined) r[k] = v;
            return deepCopy(r);
        },
        updateMany: async (args: any) => {
            log.push(`${name}.updateMany`);
            const rows = table().filter((x) => matches(x, args.where));
            for (const r of rows) for (const [k, v] of Object.entries(args.data || {})) if (v !== undefined) r[k] = v;
            return { count: rows.length };
        },
        delete: async (args: any) => {
            log.push(`${name}.delete`);
            const i = table().findIndex((x) => matches(x, args.where));
            if (i < 0) throw new Error(`${name} not found`);
            return table().splice(i, 1)[0];
        },
        deleteMany: async (args: any) => {
            log.push(`${name}.deleteMany`);
            const keep = table().filter((x) => !matches(x, args?.where));
            const count = table().length - keep.length;
            table().splice(0, table().length, ...keep);
            return { count };
        },
        createMany: async (args: any) => {
            log.push(`${name}.createMany`);
            for (const d of args.data) table().push({ id: `${name}-${table().length + 1}`, ...d });
            return { count: args.data.length };
        },
    });

    const c: any = db.client;
    c.bundle = model('bundle', () => store.bundles);
    c.bundleContent = model('bundleContent', () => store.bundleContents);
    c.catalog = model('catalog', () => store.catalogs);
    c.order = model('order', () => store.orders);
    c.orderItem = model('orderItem', () => store.orderItems);
    c.invoiceItem = model('invoiceItem', () => store.invoiceItems);
    c.campaignBundle = model('campaignBundle', () => store.campaignBundles);
    c.customer = model('customer', () => store.customers);
    // The campaign rows carry their organization's tenant, the shape `include: { customer }` reads.
    c.fundraiserCampaign = model('fundraiserCampaign', () => store.campaigns, (r, args) =>
        args?.include?.customer
            ? { ...r, customer: store.customers.find((x) => x.id === r.customer_id) ?? null }
            : r);
    c.$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = Array.from(strings).join('?');
        log.push(`$queryRaw:${/FOR UPDATE/.test(sql) ? 'lock' : 'read'}`);
        if (/FOR UPDATE/.test(sql)) db.onRowLock?.(sql, values);
        return [];
    });
    c.$executeRawUnsafe = jest.fn(async (sql: string) => {
        log.push(/pg_advisory_xact_lock/.test(sql) ? '$executeRawUnsafe:advisoryLock' : '$executeRawUnsafe');
        return 0;
    });
    c.$transaction = jest.fn(async (arg: any) => {
        if (typeof arg !== 'function') return Promise.all(arg);
        const snapshot = deepCopy(store);
        try {
            return await arg(c);
        } catch (e) {
            (Object.keys(store) as (keyof Store)[]).forEach((k) => { store[k] = snapshot[k] as any; });
            throw e;
        }
    });

    (global as any).__lwg1Prisma = c;
    return db;
};

const jsonReq = (url: string, method: string, body?: unknown) =>
    new Request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

// ===========================================================================
// 1. Bundle switches never erase price — PUT /api/bundles/[id]
// ===========================================================================
const BUNDLE = 'bndl-lwg1-0001';
const CATALOG = 'catl-lwg1-0001';
const pricedBundle = (over: Row = {}): Row => ({
    id: BUNDLE, business_id: TENANT, name: 'Autumn Family Bundle (fixture)', sku: 'LWG1-AUT-S5',
    description: 'Five fictional family meals', serving_tier: 'serves_5', is_active: true,
    show_on_storefront: false, price: '124.99', catalog_id: CATALOG,
    order_cutoff_date: new Date('2026-12-01T00:00:00.000Z'), image_url: 'https://img.example.test/b.png',
    family_id: 'fam-lwg1-1', stock_on_hand: '12', is_surplus: false,
    ...over,
});
const bundleSeed = (over: Row = {}): Partial<Store> => ({
    bundles: [pricedBundle(over)],
    bundleContents: [
        { id: 'bc-1', bundle_id: BUNDLE, recipe_id: 'rcp-1', position: 0, quantity: 1 },
        { id: 'bc-2', bundle_id: BUNDLE, recipe_id: 'rcp-2', position: 1, quantity: 1 },
    ],
    catalogs: [{ id: CATALOG, business_id: TENANT }, { id: 'catl-foreign', business_id: OTHER }],
});
const putBundle = async (body: unknown) => {
    const { PUT } = await import('@/app/api/bundles/[id]/route');
    return readJson(await PUT(jsonReq(`http://localhost/api/bundles/${BUNDLE}`, 'PUT', body), params(BUNDLE)) as any);
};

describe('1. the Bundles list switches never erase price or any unrelated field', () => {
    const SWITCHES: [string, Row][] = [
        ['Active ON', { is_active: true }],
        ['Active OFF', { is_active: false }],
        ['Storefront ON', { show_on_storefront: true }],
        ['Storefront OFF', { show_on_storefront: false }],
    ];

    it.each(SWITCHES)('%s writes only that flag', async (_label, body) => {
        const db = makeDb(bundleSeed({ is_active: !body.is_active, show_on_storefront: !body.show_on_storefront }));
        const before = deepCopy(db.store.bundles[0]);
        const res = await putBundle(body);
        expect(res.status).toBe(200);
        const after = db.store.bundles[0];
        const key = Object.keys(body)[0];
        expect(after[key]).toBe(body[key]);
        // Every other column is exactly what it was — price above all.
        expect({ ...after, [key]: before[key] }).toEqual(before);
        expect(after.price).toBe('124.99');
        // And the bundle's recipes were not touched.
        expect(db.store.bundleContents).toHaveLength(2);
    });

    it.each(['60.00', '124.99', '125', '0.50', 99.95])('a stored price of %p survives every switch exactly', async (price) => {
        const db = makeDb(bundleSeed({ price }));
        for (const [, body] of SWITCHES) {
            expect((await putBundle(body)).status).toBe(200);
            expect(db.store.bundles[0].price).toBe(price);
        }
    });

    it('a priced bundle is still orderable after any sequence of switches (the order routes refuse NULL / $0)', async () => {
        makeDb(bundleSeed());
        for (const [, body] of [...SWITCHES, ...SWITCHES]) await putBundle(body);
        const { buildBundlePriceMap } = await import('@/lib/pricing');
        const price = (await buildBundlePriceMap(TENANT, [BUNDLE])).get(BUNDLE);
        // The exact test app/api/public/order/route.ts applies before accepting a line.
        expect(!price || price <= 0).toBe(false);
        expect(price).toBe(124.99);
    });

    it('the old handler is the defect: its mapping of a one-flag body nulls price, cutoff and catalog', () => {
        // The pre-fix expression from app/api/bundles/[id]/route.ts at 118a5e0, kept as an oracle so
        // the regression is described by the code that caused it, not by a paraphrase.
        const legacy = (data: any) => ({
            order_cutoff_date: data.order_cutoff_date ? new Date(data.order_cutoff_date) : null,
            price: data.price ? Number(data.price) : null,
            catalog_id: data.catalog_id || null,
        });
        expect(legacy({ is_active: false })).toEqual({ order_cutoff_date: null, price: null, catalog_id: null });
        // The new contract writes nothing it was not sent.
        const fixed = buildBundleUpdateData({ is_active: false }, { catalog_id: CATALOG });
        expect(fixed).toEqual({ ok: true, data: { is_active: false }, catalogIdToVerify: null });
    });

    it('the full editor save still works: every field it sends is written, an explicit blank still clears', async () => {
        const db = makeDb(bundleSeed());
        const res = await putBundle({
            name: 'Autumn Family Bundle v2 (fixture)', sku: 'LWG1-AUT-S5', description: 'Updated',
            serving_tier: 'serves_5', catalog_id: CATALOG, image_url: '', price: '130.50',
            stock_on_hand: 4, is_active: true, show_on_storefront: true, order_cutoff_date: '',
        });
        expect(res.status).toBe(200);
        const b = db.store.bundles[0];
        expect(b).toMatchObject({
            name: 'Autumn Family Bundle v2 (fixture)', description: 'Updated', price: 130.5,
            show_on_storefront: true, image_url: null, order_cutoff_date: null, catalog_id: CATALOG,
        });
        // Not writable here, exactly as before.
        expect(b.stock_on_hand).toBe('12');
        expect(b.family_id).toBe('fam-lwg1-1');
    });

    it('an invalid value is refused with 400 and nothing is written', async () => {
        for (const body of [{ is_active: 'yes' }, { price: 'abc' }, { price: -1 }, { name: '' }, { order_cutoff_date: 'not a date' }]) {
            const db = makeDb(bundleSeed());
            const before = fingerprint(db.store);
            expect((await putBundle(body)).status).toBe(400);
            expect(fingerprint(db.store)).toBe(before);
        }
    });

    it("another tenant's catalog cannot be attached (400, nothing written)", async () => {
        const db = makeDb(bundleSeed());
        const before = fingerprint(db.store);
        expect((await putBundle({ catalog_id: 'catl-foreign' })).status).toBe(400);
        expect(fingerprint(db.store)).toBe(before);
    });

    it("another tenant's bundle is still refused (403), anonymous still 401", async () => {
        const db = makeDb(bundleSeed({ business_id: OTHER }));
        const before = fingerprint(db.store);
        expect((await putBundle({ is_active: false })).status).toBe(403);
        signIn(null);
        expect((await putBundle({ is_active: false })).status).toBe(401);
        expect(fingerprint(db.store)).toBe(before);
    });
});

// ===========================================================================
// 1A. Intentional clearing still works through the real route (LEGACY-WRITER-GUARDS-1A)
// ===========================================================================
// Callers traced on 64707f9:
//   * components/BundleEditor.tsx PUTs its whole react-hook-form state. An emptied Selling Price
//     input sends price: '' ; an emptied cutoff date input sends order_cutoff_date: '' ; the
//     "-- No Catalog --" option sends catalog_id: '' ; "Remove image" sends image_url: ''. Typed
//     numbers arrive as strings ("0", "130.50"). The two flags arrive as real booleans.
//   * app/bundles/page.tsx (Bundles list switches) PUTs exactly one boolean flag.
//   * No screen sends null or a numeric price. Both are still part of the API contract
//     (lib/bundleUpdate.ts) and are pinned here so a future caller gets the same answer.
describe('1A. the real route still clears what a caller deliberately clears, and nothing else', () => {
    /** Run one PUT and return the bundle row before and after. */
    const putAndDiff = async (body: unknown, seedOver: Row = {}) => {
        const db = makeDb(bundleSeed(seedOver));
        const before = deepCopy(db.store.bundles[0]);
        const res = await putBundle(body);
        return { db, res, before, after: db.store.bundles[0] };
    };
    /** Every column except `changed` is exactly what it was. */
    const onlyChanged = (before: Row, after: Row, changed: string[]) => {
        const restored = { ...after };
        for (const k of changed) restored[k] = before[k];
        expect(restored).toEqual(before);
    };

    // -- the editor's own blank values (the real UI path) ----------------------------------
    it.each([
        ['price', 'emptied Selling Price input'],
        ['order_cutoff_date', 'emptied cutoff date input'],
        ['catalog_id', '"-- No Catalog --" option'],
        ['image_url', 'Remove image'],
    ])("the editor's blank %s ('' from the %s) clears that column to NULL and touches nothing else", async (key) => {
        const { res, before, after, db } = await putAndDiff({ [key]: '' });
        expect(res.status).toBe(200);
        expect(after[key]).toBeNull();
        onlyChanged(before, after, [key]);
        expect(db.store.bundleContents).toHaveLength(2);
    });

    it('clearing the catalog needs no catalog lookup (nothing to verify), so it cannot be refused as foreign', async () => {
        const { res, after, db } = await putAndDiff({ catalog_id: '' });
        expect(res.status).toBe(200);
        expect(after.catalog_id).toBeNull();
        expect(db.log).not.toContain('catalog.findFirst');
    });

    it('a full editor save that clears price, cutoff and catalog at once writes all three as NULL and keeps the rest', async () => {
        const { res, before, after } = await putAndDiff({
            name: before0().name, sku: before0().sku, description: before0().description,
            serving_tier: 'serves_5', catalog_id: '', image_url: before0().image_url, price: '',
            stock_on_hand: 12, is_active: true, show_on_storefront: false, order_cutoff_date: '',
        });
        expect(res.status).toBe(200);
        expect(after).toMatchObject({ price: null, order_cutoff_date: null, catalog_id: null });
        onlyChanged(before, after, ['price', 'order_cutoff_date', 'catalog_id']);
    });

    // -- explicit null (API contract; no screen sends it) -------------------------------------
    it.each(['price', 'order_cutoff_date', 'catalog_id', 'image_url', 'description'])(
        'explicit null for the nullable %s clears it to NULL and touches nothing else', async (key) => {
            const { res, before, after } = await putAndDiff({ [key]: null });
            expect(res.status).toBe(200);
            expect(after[key]).toBeNull();
            onlyChanged(before, after, [key]);
        });

    it.each(['name', 'sku', 'serving_tier', 'is_active', 'show_on_storefront'])(
        'explicit null for the required %s is refused with 400 and nothing is written', async (key) => {
            const db = makeDb(bundleSeed());
            const before = fingerprint(db.store);
            expect((await putBundle({ [key]: null })).status).toBe(400);
            expect(fingerprint(db.store)).toBe(before);
        });

    it('whitespace-only is blank for price, cutoff and catalog (cleared), exactly like the empty string', async () => {
        const { res, before, after } = await putAndDiff({ price: '  ', order_cutoff_date: ' ', catalog_id: '   ' });
        expect(res.status).toBe(200);
        expect(after).toMatchObject({ price: null, order_cutoff_date: null, catalog_id: null });
        onlyChanged(before, after, ['price', 'order_cutoff_date', 'catalog_id']);
    });

    it("an empty description is stored as empty text, not NULL — unchanged from 118a5e0's data.description", async () => {
        const { res, before, after } = await putAndDiff({ description: '' });
        expect(res.status).toBe(200);
        expect(after.description).toBe('');
        onlyChanged(before, after, ['description']);
    });

    // -- explicit false -----------------------------------------------------------------------
    it('explicit false is written as false, never treated as "omitted" — both flags at once, inside a full editor body', async () => {
        const { res, before, after } = await putAndDiff({
            name: before0().name, sku: before0().sku, serving_tier: 'serves_5', catalog_id: CATALOG,
            image_url: before0().image_url, price: '124.99', is_active: false, show_on_storefront: false,
            order_cutoff_date: '2026-12-01',
        }, { is_active: true, show_on_storefront: true });
        expect(res.status).toBe(200);
        expect(after.is_active).toBe(false);
        expect(after.show_on_storefront).toBe(false);
        // The editor re-sends the price it loaded; the column type rounds it, so compare as numbers.
        expect(Number(after.price)).toBe(124.99);
        expect(after.catalog_id).toBe(CATALOG);
        expect(after.order_cutoff_date).toEqual(new Date('2026-12-01'));
        expect(after.description).toBe(before.description); // omitted by this body → untouched
    });

    // -- explicit 0 ---------------------------------------------------------------------------
    it.each([['"0" (what the editor sends for a typed 0)', '0'], ['"0.00"', '0.00'], ['numeric 0 (API only)', 0]])(
        'price %s is stored as 0, not NULL — and the order routes still refuse it as unpriced', async (_l, price) => {
            const { res, before, after } = await putAndDiff({ price });
            expect(res.status).toBe(200);
            expect(after.price).toBe(0);
            onlyChanged(before, after, ['price']);
            const { buildBundlePriceMap } = await import('@/lib/pricing');
            const p = (await buildBundlePriceMap(TENANT, [BUNDLE])).get(BUNDLE);
            // The exact test app/api/public/order/route.ts applies before accepting a line.
            expect(!p || p <= 0).toBe(true);
        });

    // -- omission -------------------------------------------------------------------------------
    it('a body naming one field changes that field only; every omitted column keeps its value', async () => {
        const { res, before, after } = await putAndDiff({ name: 'Renamed Family Bundle (fixture)' });
        expect(res.status).toBe(200);
        expect(after.name).toBe('Renamed Family Bundle (fixture)');
        onlyChanged(before, after, ['name']);
        expect(after.price).toBe('124.99');
        expect(after.order_cutoff_date).toEqual(new Date('2026-12-01T00:00:00.000Z'));
        expect(after.catalog_id).toBe(CATALOG);
    });

    it('an empty body is a no-op: 200, and the whole store is byte-identical', async () => {
        const db = makeDb(bundleSeed());
        const before = fingerprint(db.store);
        expect((await putBundle({})).status).toBe(200);
        expect(fingerprint(db.store)).toBe(before);
    });

    it('omitting contents leaves the recipes alone; an explicit empty list still removes them (unchanged contract)', async () => {
        const kept = await putAndDiff({ is_active: false });
        expect(kept.db.store.bundleContents).toHaveLength(2);
        const cleared = await putAndDiff({ contents: [] });
        expect(cleared.res.status).toBe(200);
        expect(cleared.db.store.bundleContents).toHaveLength(0);
        onlyChanged(cleared.before, cleared.after, []);
    });
});
const before0 = () => pricedBundle();

// ===========================================================================
// 2. A bundle that history points at is never hard-deleted — DELETE /api/bundles/[id]
// ===========================================================================
const deleteBundle = async () => {
    const { DELETE } = await import('@/app/api/bundles/[id]/route');
    return readJson(await DELETE(jsonReq(`http://localhost/api/bundles/${BUNDLE}`, 'DELETE'), params(BUNDLE)) as any);
};

describe('2. bundle delete is refused while order, invoice or campaign history uses the bundle', () => {
    const REFERENCES: [string, Partial<Store>][] = [
        ['a held fundraiser order line', { orderItems: [{ id: 'oi-1', order_id: 'ord-1', bundle_id: BUNDLE, quantity: 2, unit_price: '124.99' }] }],
        ['a canceled order line (still history)', { orderItems: [{ id: 'oi-2', order_id: 'ord-canceled', bundle_id: BUNDLE, quantity: 1, unit_price: '124.99' }] }],
        ['an invoice line', { invoiceItems: [{ id: 'ii-1', invoice_id: 'inv-1', bundle_id: BUNDLE, quantity: 3 }] }],
        ["a campaign's candidate menu", { campaignBundles: [{ id: 'cb-1', campaign_id: 'cmp-1', bundle_id: BUNDLE, state: 'candidate' }] }],
        ["a campaign's active menu", { campaignBundles: [{ id: 'cb-2', campaign_id: 'cmp-1', bundle_id: BUNDLE, state: 'active' }] }],
    ];

    it.each(REFERENCES)('referenced by %s → 409, and every row survives exactly', async (_label, refs) => {
        const db = makeDb({ ...bundleSeed(), ...refs });
        const before = fingerprint(db.store);
        const res = await deleteBundle();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('BUNDLE_IN_USE');
        expect(res.body.error).toMatch(/can't be deleted/);
        expect(res.body.error).toMatch(/Turn off "Active"/);
        expect(fingerprint(db.store)).toBe(before);
    });

    it('a genuinely unused bundle is still deleted, with its contents and nothing else', async () => {
        const db = makeDb({
            ...bundleSeed(),
            bundles: [pricedBundle(), pricedBundle({ id: 'bndl-keep', sku: 'LWG1-KEEP' })],
            bundleContents: [
                { id: 'bc-1', bundle_id: BUNDLE, recipe_id: 'rcp-1', position: 0 },
                { id: 'bc-k', bundle_id: 'bndl-keep', recipe_id: 'rcp-1', position: 0 },
            ],
            orderItems: [{ id: 'oi-k', order_id: 'ord-k', bundle_id: 'bndl-keep', quantity: 1 }],
        });
        const res = await deleteBundle();
        expect(res.status).toBe(200);
        expect(db.store.bundles.map((b) => b.id)).toEqual(['bndl-keep']);
        expect(db.store.bundleContents.map((c) => c.id)).toEqual(['bc-k']);
        expect(db.store.orderItems).toHaveLength(1);
    });

    it('the row lock is taken before the reference count, and the count before any delete', async () => {
        const db = makeDb(bundleSeed());
        await deleteBundle();
        const lock = db.log.indexOf('$queryRaw:lock');
        expect(lock).toBeGreaterThan(-1);
        expect(lock).toBeLessThan(db.log.indexOf('orderItem.count'));
        expect(db.log.indexOf('orderItem.count')).toBeLessThan(db.log.indexOf('bundleContent.deleteMany'));
        expect(db.log.indexOf('campaignBundle.count')).toBeLessThan(db.log.indexOf('bundle.delete'));
    });

    it('an order line that lands while the lock is being taken still blocks the delete', async () => {
        const db = makeDb(bundleSeed());
        db.onRowLock = () => {
            db.store.orderItems.push({ id: 'oi-late', order_id: 'ord-late', bundle_id: BUNDLE, quantity: 1 });
        };
        expect((await deleteBundle()).status).toBe(409);
        expect(db.store.bundles).toHaveLength(1);
        expect(db.store.bundleContents).toHaveLength(2);
    });

    it("another tenant's bundle is still refused (403), anonymous still 401", async () => {
        const db = makeDb({ ...bundleSeed({ business_id: OTHER }) });
        const before = fingerprint(db.store);
        expect((await deleteBundle()).status).toBe(403);
        signIn(null);
        expect((await deleteBundle()).status).toBe(401);
        expect(fingerprint(db.store)).toBe(before);
    });

    it('the refusal names what uses the bundle, in words a tenant can act on', () => {
        expect(bundleDeletionRefusal({ orderItems: 0, invoiceItems: 0, campaignBundles: 0 })).toBeNull();
        expect(bundleDeletionRefusal({ orderItems: 1, invoiceItems: 0, campaignBundles: 0 }))
            .toBe('This bundle can\'t be deleted because it is used by 1 order line. Turn off "Active" to retire it instead.');
        expect(bundleDeletionRefusal({ orderItems: 3, invoiceItems: 1, campaignBundles: 2 }))
            .toMatch(/3 order lines, 1 invoice line and 2 fundraiser menus/);
    });
});

// ===========================================================================
// 3. Order hard-delete only for a pending, non-fundraiser order with no history — DELETE /api/orders
// ===========================================================================
const ORDER = 'ord-lwg1-0001';
const pendingManual = (over: Row = {}): Row => ({
    id: ORDER, external_id: 'manual-lwg1-1', business_id: TENANT, source: 'manual', status: 'pending',
    campaign_id: null, customer_id: null, customer_name: 'Test Duplicate (fixture)', total_amount: '60.00',
    tax_amount: '0', paid_at: null, paid_by: null, invoice_id: null, payment_processor: null,
    processor_payment_id: null, released_to_delivery_at: null, canceled_at: null,
    ...over,
});
const orderSeed = (over: Row = {}): Partial<Store> => ({
    orders: [pendingManual(over)],
    orderItems: [
        { id: 'oi-a', order_id: ORDER, bundle_id: BUNDLE, quantity: 1, unit_price: '60.00' },
        { id: 'oi-b', order_id: ORDER, bundle_id: BUNDLE, quantity: 2, unit_price: '60.00' },
    ],
});
const deleteOrder = async (id = ORDER) => {
    const { DELETE } = await import('@/app/api/orders/route');
    return readJson(await DELETE(jsonReq(`http://localhost/api/orders?id=${encodeURIComponent(id)}`, 'DELETE') as any) as any);
};

describe('3. order hard-delete is refused for anything that is business history', () => {
    const REFUSED: [string, Row, string][] = [
        ['a held fundraiser supporter order', { source: 'fundraiser', status: 'fundraiser_hold', campaign_id: 'cmp-1' }, 'ORDER_IS_FUNDRAISER'],
        ['a delivered order on a closed, invoiced fundraiser', { source: 'fundraiser', status: 'delivered', campaign_id: 'cmp-closed' }, 'ORDER_IS_FUNDRAISER'],
        ['a canceled fundraiser order', { source: 'fundraiser', status: 'fundraiser_hold', campaign_id: 'cmp-1', canceled_at: new Date('2026-11-01T12:00:00Z') }, 'ORDER_IS_FUNDRAISER'],
        ['a legacy fundraiser order with no campaign link', { source: 'fundraiser', status: 'pending' }, 'ORDER_IS_FUNDRAISER'],
        ['a pending order marked paid', { paid_at: new Date('2026-11-02T12:00:00Z'), paid_by: 'coordinator' }, 'ORDER_HAS_PAYMENT'],
        ['a pending order with a processor payment', { payment_processor: 'square', processor_payment_id: 'sq_fixture_1' }, 'ORDER_HAS_PAYMENT'],
        ['a pending order on an invoice', { invoice_id: 'inv-lwg1-1' }, 'ORDER_IS_INVOICED'],
        ['an order sent to delivery', { status: 'ready_to_ship', released_to_delivery_at: new Date('2026-11-03T12:00:00Z') }, 'ORDER_RELEASED_TO_DELIVERY'],
        ['a production-ready order', { status: 'production_ready' }, 'ORDER_NOT_PENDING'],
        ['an in-production order', { status: 'in_production' }, 'ORDER_NOT_PENDING'],
        ['a ready-to-ship order', { status: 'ready_to_ship' }, 'ORDER_NOT_PENDING'],
        ['a completed order', { status: 'completed' }, 'ORDER_NOT_PENDING'],
        ['a delivered order', { status: 'delivered' }, 'ORDER_NOT_PENDING'],
        ['a legacy APPROVED order', { status: 'APPROVED' }, 'ORDER_NOT_PENDING'],
        ['a status this code cannot read', { status: 'mystery' }, 'ORDER_NOT_PENDING'],
    ];

    it.each(REFUSED)('%s → 409, the order and its items survive exactly', async (_label, over, code) => {
        const db = makeDb(orderSeed(over));
        const before = fingerprint(db.store);
        const res = await deleteOrder();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe(code);
        expect(res.body.error).toMatch(/can't be deleted/);
        expect(fingerprint(db.store)).toBe(before);
    });

    it.each([['pending'], ['PENDING']])('a %s, non-fundraiser order with no history is still deleted with its items', async (status) => {
        const db = makeDb({ ...orderSeed({ status }), orders: [pendingManual({ status }), pendingManual({ id: 'ord-keep', external_id: 'manual-keep' })] });
        db.store.orderItems.push({ id: 'oi-keep', order_id: 'ord-keep', bundle_id: BUNDLE, quantity: 1 });
        const res = await deleteOrder();
        expect(res.status).toBe(200);
        expect(db.store.orders.map((o) => o.id)).toEqual(['ord-keep']);
        expect(db.store.orderItems.map((i) => i.id)).toEqual(['oi-keep']);
    });

    it('the Orders table passes the external id — that lookup still works, and is still guarded', async () => {
        let db = makeDb(orderSeed());
        expect((await deleteOrder('manual-lwg1-1')).status).toBe(200);
        expect(db.store.orders).toHaveLength(0);

        db = makeDb(orderSeed({ status: 'delivered' }));
        expect((await deleteOrder('manual-lwg1-1')).status).toBe(409);
        expect(db.store.orders).toHaveLength(1);
    });

    it('the order is judged as it is AFTER the row lock: a release committed a moment earlier wins', async () => {
        const db = makeDb(orderSeed());
        db.onRowLock = () => { db.store.orders[0].status = 'production_ready'; };
        const res = await deleteOrder();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ORDER_NOT_PENDING');
        expect(db.store.orders).toHaveLength(1);
        expect(db.store.orderItems).toHaveLength(2);
        // The lock precedes the deciding read, and nothing was deleted.
        const lock = db.log.indexOf('$queryRaw:lock');
        expect(lock).toBeGreaterThan(-1);
        expect(db.log.slice(lock + 1)).toContain('order.findUnique');
        expect(db.log).not.toContain('orderItem.deleteMany');
    });

    it("another tenant's order is still never deleted, and anonymous is still 401", async () => {
        const db = makeDb(orderSeed({ business_id: OTHER }));
        const before = fingerprint(db.store);
        expect((await deleteOrder()).status).toBe(500); // unchanged: "not found or unauthorized"
        signIn(null);
        expect((await deleteOrder()).status).toBe(401);
        expect(fingerprint(db.store)).toBe(before);
    });

    it('the rule itself: precedence and the one allowed shape', () => {
        const ok: DeletableOrderFacts = {
            status: 'pending', source: 'manual', campaign_id: null, paid_at: null, invoice_id: null,
            payment_processor: null, processor_payment_id: null, released_to_delivery_at: null,
        };
        expect(orderDeletionRefusal(ok)).toBeNull();
        expect(orderDeletionRefusal({ ...ok, status: null })!.code).toBe('ORDER_NOT_PENDING');
        // Fundraiser outranks every other reason, so the tenant is told the real one.
        expect(orderDeletionRefusal({ ...ok, campaign_id: 'c', paid_at: new Date(), status: 'delivered' })!.code)
            .toBe('ORDER_IS_FUNDRAISER');
    });
});

// ===========================================================================
// 4. An organization profile save never writes a campaign — PUT /api/customers/[id]
// ===========================================================================
const ORG = 'aaaa5555-0000-4000-8000-0000000000c1';
let cmock: PrismaMock;
const putOrg = async (id: string, body: unknown) => {
    const { PUT } = await import('@/app/api/customers/[id]/route');
    return readJson(await PUT(jsonReq(`http://localhost/api/customers/${id}`, 'PUT', body), params(id)) as any);
};
// The org form's real payload shape (components/crm/FundraiserSetup.tsx), with its own defaults:
// goal 20, time "4:45 PM", the organization's name as payee.
const ORG_FORM_INFO = {
    deadline: '2026-07-20', deadline_time: '4:00 PM', delivery_date: '2026-08-01', delivery_time: '4:45 PM',
    pickup_location: 'Old church hall', checks_payable_to: 'Maple Ridge Robotics (fixture)',
    participant_label: 'Member', bundle_goal: 20, start_date: '2026-06-01',
    about_text: 'Org about text', mission_text: 'Org mission text',
    payment_instructions: 'Org-level payment note', external_payment_link: 'https://pay.example.test/org',
};

describe('4. saving an organization profile cannot change any existing campaign', () => {
    const useCustomerMock = (results: Record<string, any> = {}) => {
        cmock = createPrismaMock({
            results: {
                'customer.findUnique': { business_id: TENANT },
                // Were the route ever to look for a campaign again, it would find a live one to damage.
                'fundraiserCampaign.findFirst': {
                    id: 'cmp-live', closed_at: null, status: 'Active', bundle_goal: 35,
                    delivery_date: null, delivery_time: null, end_date: null, pickup_location: null, checks_payable: null,
                },
                ...results,
            },
        });
        (global as any).__lwg1Prisma = cmock.client;
    };
    const campaignCalls = () => cmock.calls.filter((c) => c.model === 'fundraiserCampaign');

    it('the full org-form payload (goal 20, start date, labels, text, payment, logistics) reaches no campaign', async () => {
        useCustomerMock();
        const res = await putOrg(ORG, { name: 'Maple Ridge Robotics (fixture)', fundraiser_info: ORG_FORM_INFO });
        expect(res.status).toBe(200);
        expect(campaignCalls()).toEqual([]);
        // The organization itself is still saved, blob included.
        expect(cmock.firstCall('customer.update')!.args.data.fundraiser_info).toEqual(ORG_FORM_INFO);
    });

    it("a campaign's blank time / place / payee are not filled from the org form's defaults any more", async () => {
        useCustomerMock();
        await putOrg(ORG, { name: 'x', fundraiser_info: { delivery_time: '4:45 PM', checks_payable_to: 'x', pickup_location: 'Gym' } });
        expect(campaignCalls()).toEqual([]);
    });

    it('the promote-a-name path (non-UUID id) writes no campaign either', async () => {
        useCustomerMock({ 'customer.findFirst': null });
        const res = await putOrg(encodeURIComponent('Walk-in Group (fixture)'), { name: 'Walk-in Group (fixture)', fundraiser_info: ORG_FORM_INFO });
        expect(res.status).toBe(200);
        expect(campaignCalls()).toEqual([]);
    });

    it('an invalid payment value is still refused before anything is written', async () => {
        useCustomerMock();
        const res = await putOrg(ORG, { name: 'x', fundraiser_info: { external_payment_link: 'javascript:alert(1)' } });
        expect(res.status).toBe(400);
        expect(cmock.callsTo('customer.update')).toHaveLength(0);
        expect(campaignCalls()).toEqual([]);
    });

    it("another tenant's organization is still refused (403) with nothing written", async () => {
        useCustomerMock({ 'customer.findUnique': { business_id: OTHER } });
        expect((await putOrg(ORG, { name: 'x', fundraiser_info: ORG_FORM_INFO })).status).toBe(403);
        expect(cmock.callsTo('customer.update')).toHaveLength(0);
        expect(campaignCalls()).toEqual([]);
    });
});

// 4A. LEGACY-WRITER-GUARDS-1A — the form that feeds that route tells the truth about what it saves.
// No DOM environment in this repo, so the copy is pinned at source (the repo's convention).
describe('4A. the organization notes form never claims to have changed a campaign', () => {
    const fsx = require('fs');
    const pathx = require('path');
    const src = (rel: string) => fsx.readFileSync(pathx.join(__dirname, '..', rel), 'utf8') as string;
    const FORM = src('components/crm/FundraiserSetup.tsx');
    const OVERVIEW = src('components/crm/CustomerOverview.tsx');

    it('the success message says organization notes were saved and that no fundraiser changed', () => {
        expect(FORM).not.toMatch(/Campaign details saved/i);
        expect(FORM).toContain(
            `alert("Organization notes saved. These fill in your documents only; no fundraiser's details were changed.")`);
    });

    it('the heading and subtitle describe organization notes for documents, and say campaigns are edited elsewhere', () => {
        expect(FORM).not.toMatch(/>\s*Campaign Details\s*</);
        expect(FORM).toContain('>Organization Notes for Documents<');
        expect(FORM).toContain("Saving here does not change a fundraiser&apos;s own details");
        expect(FORM).toContain('use Edit details on the Fundraisers page');
        // The legacy organization page wraps the form; its own heading no longer says Campaign Details.
        expect(OVERVIEW).not.toMatch(/>\s*Campaign Details\s*</);
        expect(OVERVIEW).toContain('>Organization Notes</h4>');
    });

    it('there is no Participant Label control, and the stored value is carried through unchanged on save', () => {
        expect(FORM).not.toMatch(/Participant Label/); // the visible label; code comments say "participant label"
        expect(FORM).not.toMatch(/participant_label:\s*e\.target\.value/);
        expect(FORM).not.toMatch(/value=\{fundraiserInfo\.participant_label/);
        // Still in the saved state, initialised from what the organization already has.
        expect(FORM).toMatch(/participant_label: customer\.fundraiser_info\?\.participant_label \|\| ''/);
    });

    it('the goal field is labelled as the goal printed on documents, not as a campaign goal', () => {
        expect(FORM).not.toMatch(/>\s*Bundle Goal\s*</);
        expect(FORM).not.toMatch(/Used in progress tracking/);
        expect(FORM).toContain('>Goal Shown on Documents<');
        expect(FORM).toContain("It does not change a fundraiser&apos;s goal.");
        // It still feeds the document placeholder that reads it.
        expect(src('components/DocumentCenter.tsx')).toMatch(/\{\{GoalAmount\}\}\/g, fundraiserInfo\.bundle_goal/);
    });

    it('the form still saves only the organization (no new write path): its sole outlet is onSave', () => {
        // It reads recipes and bundles for the pickers, but never writes to a campaign or customer itself.
        expect(FORM).not.toMatch(/fetch\(\s*[`'"]\/api\/(campaigns|customers)/);
        expect(FORM.match(/await onSave\(/g) ?? []).toHaveLength(1);
    });
});

// ===========================================================================
// 5. The legacy campaign bundle editor — PUT /api/campaigns/[id]/bundles
// ===========================================================================
const CMP = 'cmp-lwg1-0001';
const ORG_ROW = { id: 'org-lwg1', business_id: TENANT, name: 'Cedar Valley Scouts (fixture)' };
const campaign = (over: Row = {}): Row => ({
    id: CMP, customer_id: ORG_ROW.id, name: 'Cedar Valley Fall (fixture)', status: 'Active', closed_at: null,
    bundle_selection_status: 'not_required', ...over,
});
const assignSeed = (over: Row = {}, extra: Partial<Store> = {}): Partial<Store> => ({
    customers: [ORG_ROW, { id: 'org-foreign', business_id: OTHER }],
    campaigns: [campaign(over)],
    bundles: [
        pricedBundle({ id: 'b-old', sku: 'OLD' }), pricedBundle({ id: 'b-new1', sku: 'N1' }),
        pricedBundle({ id: 'b-new2', sku: 'N2' }), pricedBundle({ id: 'b-foreign', sku: 'FX', business_id: OTHER }),
    ],
    campaignBundles: [
        { id: 'cb-active', campaign_id: CMP, bundle_id: 'b-old', state: 'active', position: 0 },
        { id: 'cb-cand', campaign_id: CMP, bundle_id: 'b-new1', state: 'candidate', position: 0 },
    ],
    ...extra,
});
const putAssign = async (bundleIds: unknown) => {
    const { PUT } = await import('@/app/api/campaigns/[id]/bundles/route');
    return readJson(await PUT(jsonReq(`http://localhost/api/campaigns/${CMP}/bundles`, 'PUT', { bundleIds }), params(CMP)) as any);
};

describe('5. the legacy campaign bundle editor only acts where it cannot corrupt truth', () => {
    it('a not_required, open campaign with no orders can still have its menu replaced (workflow kept)', async () => {
        const db = makeDb(assignSeed());
        const res = await putAssign(['b-new1', 'b-new2']);
        expect(res.status).toBe(200);
        const active = db.store.campaignBundles.filter((r) => r.state === 'active').map((r) => r.bundle_id);
        expect(active).toEqual(['b-new1', 'b-new2']);
        // The candidate pool is untouched, exactly as FR-FLOW-2B requires.
        expect(db.store.campaignBundles.filter((r) => r.state === 'candidate')).toHaveLength(1);
    });

    const REFUSED: [string, Row, Partial<Store>, string][] = [
        ['closed (closed_at set)', { closed_at: new Date('2026-11-01T00:00:00Z') }, {}, 'CAMPAIGN_CLOSED'],
        ...(['Closed', 'Settled', 'Completed', 'Archived'].map((status) => [`closed (status ${status})`, { status }, {}, 'CAMPAIGN_CLOSED']) as any),
        ['awaiting coordinator selection (pending)', { bundle_selection_status: 'pending' }, {}, 'COORDINATOR_SELECTION'],
        ['coordinator-selected', { bundle_selection_status: 'selected' }, {}, 'COORDINATOR_SELECTION'],
        ['with a live order', {}, { orders: [{ id: 'o1', campaign_id: CMP, status: 'fundraiser_hold', canceled_at: null }] }, 'CAMPAIGN_HAS_ORDERS'],
        ['with only a canceled order', {}, { orders: [{ id: 'o2', campaign_id: CMP, status: 'fundraiser_hold', canceled_at: new Date() }] }, 'CAMPAIGN_HAS_ORDERS'],
    ];

    it.each(REFUSED)('%s → 409, the menu and the candidate pool survive exactly', async (_label, over, extra, code) => {
        const db = makeDb(assignSeed(over, extra));
        const before = fingerprint(db.store);
        const res = await putAssign(['b-new1', 'b-new2']);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe(code);
        expect(fingerprint(db.store)).toBe(before);
    });

    it('clearing the whole menu is refused the same way (an empty list is still a replacement)', async () => {
        const db = makeDb(assignSeed({ bundle_selection_status: 'selected' }));
        const before = fingerprint(db.store);
        expect((await putAssign([])).status).toBe(409);
        expect(fingerprint(db.store)).toBe(before);
    });

    it('the campaign selection lock is the first statement of the transaction, before the order count', async () => {
        const db = makeDb(assignSeed());
        await putAssign(['b-new1']);
        const lock = db.log.indexOf('$executeRawUnsafe:advisoryLock');
        expect(lock).toBeGreaterThan(-1);
        expect(lock).toBeLessThan(db.log.indexOf('order.count'));
        expect(db.log.indexOf('order.count')).toBeLessThan(db.log.indexOf('campaignBundle.deleteMany'));
    });

    it('existing guards are unchanged: another tenant 403, anonymous 401, a foreign bundle 400', async () => {
        let db = makeDb(assignSeed({ customer_id: 'org-foreign' }));
        let before = fingerprint(db.store);
        expect((await putAssign(['b-new1'])).status).toBe(403);
        expect(fingerprint(db.store)).toBe(before);

        db = makeDb(assignSeed());
        before = fingerprint(db.store);
        expect((await putAssign(['b-foreign'])).status).toBe(400);
        signIn(null);
        expect((await putAssign(['b-new1'])).status).toBe(401);
        expect(fingerprint(db.store)).toBe(before);
    });

    it('the rule itself: closed outranks the selection flow, which outranks orders', () => {
        const open = { closed_at: null, status: 'Active', bundle_selection_status: 'not_required' };
        expect(legacyBundleAssignmentRefusal(open, 0)).toBeNull();
        expect(legacyBundleAssignmentRefusal({ ...open, status: 'Closed', bundle_selection_status: 'selected' }, 5)!.code).toBe('CAMPAIGN_CLOSED');
        expect(legacyBundleAssignmentRefusal({ ...open, bundle_selection_status: 'selected' }, 5)!.code).toBe('COORDINATOR_SELECTION');
        expect(legacyBundleAssignmentRefusal(open, 1)!.code).toBe('CAMPAIGN_HAS_ORDERS');
        // A NULL selection status (should not exist, default is not_required) is treated as legacy.
        expect(legacyBundleAssignmentRefusal({ ...open, bundle_selection_status: null }, 0)).toBeNull();
    });
});
