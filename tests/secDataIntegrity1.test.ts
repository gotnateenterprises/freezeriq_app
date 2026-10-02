/**
 * SEC-DATA-INTEGRITY-1 — tenant isolation of customer/order linking, and import
 * matching that only ever uses identifiers a row actually carries.
 *
 * These tests run the REAL route handlers against a small in-memory database
 * that evaluates where-clauses the way Prisma 5.22 does — MEASURED on Postgres
 * for this phase: `undefined` is dropped, so at the TOP level `{ x: undefined }`
 * is `{}` and matches every row, while an empty branch INSIDE an OR is ignored
 * (`OR [x, {}]` is just `OR [x]`, and `OR [{}]` / `OR []` match nothing).
 * findFirst returns the first matching row in insertion order (the database's
 * "whichever came back first"), which is how an OR over two identifiers that
 * name two different customers overwrote one of them arbitrarily. external_id is
 * unique across the WHOLE customers and orders tables, as it is in Postgres.
 */

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__secDb.client; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__secSession) }));
// The status route's workflow helpers are not under test here — only the
// order-linking step that runs before them.
jest.mock('@/lib/statusWorkflow', () => ({
    setStatus: jest.fn(async () => ({ success: true })),
    progressStatus: jest.fn(async () => ({ success: true })),
    archiveCustomer: jest.fn(async () => ({ success: true })),
    unarchiveCustomer: jest.fn(async () => ({ success: true })),
}));

type Row = Record<string, any>;

// ─────────────────────────────────────────────────────────────────────────────
// A Prisma-faithful where-evaluator (the subset these handlers use)
// ─────────────────────────────────────────────────────────────────────────────

const isNullish = (v: unknown) => v === null || v === undefined;

function fieldMatches(value: any, cond: any): boolean {
    if (cond === null) return isNullish(value);
    if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
    const insensitive = cond.mode === 'insensitive';
    const norm = (x: any) => (insensitive && typeof x === 'string' ? x.toLowerCase() : x);
    for (const [op, arg] of Object.entries(cond)) {
        if (arg === undefined || op === 'mode') continue; // Prisma drops undefined
        if (op === 'equals') {
            if (arg === null ? !isNullish(value) : norm(value) !== norm(arg)) return false;
        } else if (op === 'not') {
            if (arg === null ? isNullish(value) : norm(value) === norm(arg)) return false;
        } else if (op === 'in') {
            if (!(arg as any[]).map(norm).includes(norm(value))) return false;
        } else {
            throw new Error(`memory db: unsupported filter operator "${op}"`);
        }
    }
    return true;
}

/** A where-object with at least one defined condition (Prisma drops undefined values). */
const hasCondition = (w: any) => !isNullish(w) && Object.values(w).some((v) => v !== undefined);

function matches(row: Row, where: any): boolean {
    if (isNullish(where)) return true;
    for (const [key, cond] of Object.entries(where)) {
        if (cond === undefined) continue; // Prisma drops undefined — a top-level `{ x: undefined }` is `{}`
        if (key === 'OR') {
            // Measured (Prisma 5.22, Postgres): an empty branch inside OR is ignored, and an OR with no
            // non-empty branch — `OR []`, `OR [{}]` — matches nothing.
            if (!Array.isArray(cond) || !cond.some((c) => hasCondition(c) && matches(row, c))) return false;
        } else if (key === 'AND') {
            if (!(Array.isArray(cond) ? cond : [cond]).every((c) => matches(row, c))) return false;
        } else if (key === 'NOT') {
            if ((Array.isArray(cond) ? cond : [cond]).some((c) => matches(row, c))) return false;
        } else if (!fieldMatches(row[key], cond)) {
            return false;
        }
    }
    return true;
}

function createMemoryDb(seed: Partial<Record<'customer' | 'order' | 'bundle' | 'fundraiserCampaign' | 'business', Row[]>>) {
    const tables: Record<string, Row[]> = {
        customer: [], order: [], orderItem: [], bundle: [], fundraiserCampaign: [], business: [],
    };
    for (const [name, rows] of Object.entries(seed)) tables[name] = (rows ?? []).map((r) => ({ ...r }));
    const unique: Record<string, string[]> = { customer: ['id', 'external_id'], order: ['id', 'external_id'] };
    const defaults: Record<string, Row> = {
        customer: { type: 'fundraiser_org', status: 'LEAD', source: 'Manual', archived: false, tags: [],
            business_id: null, contact_email: null, external_id: null, tax_status: 'UNKNOWN' },
        order: { customer_id: null, business_id: null, campaign_id: null, external_id: null },
    };
    const writes: string[] = [];
    const queries: Array<{ model: string; method: string; where: any }> = [];
    let seq = 0;
    const defined = (data: Row) => Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => v !== undefined));
    const assertUnique = (name: string, row: Row, selfId?: string) => {
        for (const key of unique[name] ?? []) {
            if (isNullish(row[key])) continue;
            if (tables[name].some((r) => r.id !== selfId && r[key] === row[key])) {
                const e: any = new Error(`Unique constraint failed on the fields: (\`${key}\`)`);
                e.code = 'P2002';
                throw e;
            }
        }
    };
    const model = (name: string) => ({
        findFirst: async (args: any = {}) => {
            queries.push({ model: name, method: 'findFirst', where: args.where });
            const row = tables[name].find((r) => matches(r, args.where));
            return row ? { ...row } : null;
        },
        findUnique: async (args: any = {}) => {
            queries.push({ model: name, method: 'findUnique', where: args.where });
            const row = tables[name].find((r) => matches(r, args.where));
            return row ? { ...row } : null;
        },
        findMany: async (args: any = {}) => {
            queries.push({ model: name, method: 'findMany', where: args.where });
            const rows = tables[name].filter((r) => matches(r, args.where)).map((r) => ({ ...r }));
            return typeof args.take === 'number' ? rows.slice(0, args.take) : rows;
        },
        count: async (args: any = {}) => tables[name].filter((r) => matches(r, args.where)).length,
        create: async (args: any) => {
            const { items, ...data } = args.data ?? {};
            const row: Row = { ...(defaults[name] ?? {}), ...defined(data) };
            row.id = row.id ?? `${name}-new-${++seq}`;
            assertUnique(name, row);
            tables[name].push(row);
            writes.push(`${name}.create:${row.id}`);
            for (const it of items?.create ?? []) tables.orderItem.push({ id: `orderItem-new-${++seq}`, order_id: row.id, ...it });
            return { ...row };
        },
        update: async (args: any) => {
            const row = tables[name].find((r) => matches(r, args.where));
            if (!row) { const e: any = new Error('Record to update not found.'); e.code = 'P2025'; throw e; }
            const next = { ...row, ...defined(args.data) };
            assertUnique(name, next, row.id);
            Object.assign(row, next);
            writes.push(`${name}.update:${row.id}`);
            return { ...row };
        },
        updateMany: async (args: any) => {
            const rows = tables[name].filter((r) => matches(r, args.where));
            for (const r of rows) { Object.assign(r, defined(args.data)); writes.push(`${name}.updateMany:${r.id}`); }
            return { count: rows.length };
        },
        deleteMany: async (args: any) => {
            const before = tables[name].length;
            tables[name] = tables[name].filter((r) => !matches(r, args.where));
            const count = before - tables[name].length;
            if (count) writes.push(`${name}.deleteMany:${count}`);
            return { count };
        },
    });
    const client: any = { $transaction: async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg)) };
    for (const name of Object.keys(tables)) client[name] = model(name);
    const get = (name: string, id: string) => tables[name].find((r) => r.id === id);
    return { tables, client, writes, queries, get };
}

const A = 'biz-tenant-a';
const B = 'biz-tenant-b';

function useDb(seed: Parameters<typeof createMemoryDb>[0]) {
    const db = createMemoryDb(seed);
    (global as any).__secDb = db;
    return db;
}
function useSession(session: any) { (global as any).__secSession = session; }
const tenantA = () => useSession({ user: { businessId: A, email: 'owner@tenant-a.test' } });

function csvRequest(url: string, csv: string): any {
    const fd = new FormData();
    fd.append('file', new File([csv], 'import.csv', { type: 'text/csv' }));
    return new Request(url, { method: 'POST', body: fd });
}
const jsonReq = (url: string, method: string, body: unknown): any =>
    new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Every lookup the handler ran: none may carry an empty or undefined match branch. */
function assertNoWildcardBranches(queries: Array<{ where: any }>) {
    for (const q of queries) {
        const or = q.where?.OR;
        if (!Array.isArray(or)) continue;
        for (const branch of or) {
            const keys = Object.entries(branch ?? {}).filter(([, v]) => v !== undefined);
            expect(keys.length).toBeGreaterThan(0);
        }
    }
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

// ═════════════════════════════════════════════════════════════════════════════
// A. CUSTOMER ORDER LINKING — TENANT BOUNDARY
// ═════════════════════════════════════════════════════════════════════════════

function linkingSeed() {
    return {
        order: [
            { id: 'ord-a-same', business_id: A, customer_name: 'Same Name', customer_id: null },
            { id: 'ord-b-same', business_id: B, customer_name: 'Same Name', customer_id: null },
            { id: 'ord-b-linked', business_id: B, customer_name: 'Same Name', customer_id: 'cust-b-existing' },
            { id: 'ord-a-other', business_id: A, customer_name: 'Different Name', customer_id: null },
            { id: 'ord-null-biz', business_id: null, customer_name: 'Same Name', customer_id: null },
        ],
        customer: [
            { id: 'cust-b-existing', business_id: B, name: 'Same Name', type: 'organization' },
        ],
    };
}

describe('A. PUT /api/customers/[name] — promoting a name links only THIS tenant\'s orders', () => {
    async function promote(name: string) {
        const { PUT } = require('@/app/api/customers/[id]/route');
        return PUT(
            jsonReq(`http://localhost/api/customers/${encodeURIComponent(name)}`, 'PUT', { name, type: 'Organization', status: 'Lead' }),
            { params: Promise.resolve({ id: encodeURIComponent(name) }) },
        );
    }

    it('links tenant A\'s unlinked same-name order and leaves tenant B\'s untouched', async () => {
        const db = useDb(linkingSeed());
        tenantA();
        const res = await promote('Same Name');
        const body = await res.json();
        expect(res.status).toBe(200);

        const org = db.get('customer', body.newId)!;
        expect(org.business_id).toBe(A);
        expect(db.get('order', 'ord-a-same')!.customer_id).toBe(org.id);
        expect(db.get('order', 'ord-b-same')!.customer_id).toBeNull();
    });

    it('never changes another tenant\'s already-linked order', async () => {
        const db = useDb(linkingSeed());
        tenantA();
        await promote('Same Name');
        expect(db.get('order', 'ord-b-linked')!.customer_id).toBe('cust-b-existing');
    });

    it('never changes a same-tenant order with a different name', async () => {
        const db = useDb(linkingSeed());
        tenantA();
        await promote('Same Name');
        expect(db.get('order', 'ord-a-other')!.customer_id).toBeNull();
    });

    it('never claims an order whose business_id is NULL (ownership not provable)', async () => {
        const db = useDb(linkingSeed());
        tenantA();
        await promote('Same Name');
        expect(db.get('order', 'ord-null-biz')!.customer_id).toBeNull();
    });

    it('the order mutation itself carries the session tenant', async () => {
        const db = useDb(linkingSeed());
        tenantA();
        await promote('Same Name');
        const linked = db.writes.filter((w) => w.startsWith('order.updateMany:'));
        expect(linked).toEqual(['order.updateMany:ord-a-same']);
    });

    it('an unauthorized request mutates nothing', async () => {
        const db = useDb(linkingSeed());
        useSession(null);
        const res = await promote('Same Name');
        expect(res.status).toBe(401);
        expect(db.writes).toEqual([]);
    });

    it('a session without a business mutates nothing', async () => {
        const db = useDb(linkingSeed());
        useSession({ user: { email: 'nobody@test' } });
        const res = await promote('Same Name');
        expect(res.status).toBe(401);
        expect(db.writes).toEqual([]);
    });
});

describe('A (sibling, already scoped). PATCH /api/customers/[name]/status links only THIS tenant\'s orders', () => {
    it('materializing a name never claims another tenant\'s or an unowned order', async () => {
        const db = useDb(linkingSeed());
        tenantA();
        const { PATCH } = require('@/app/api/customers/[id]/status/route');
        const res = await PATCH(
            jsonReq('http://localhost/api/customers/Same%20Name/status', 'PATCH', { action: 'set', status: 'LEAD' }),
            { params: Promise.resolve({ id: encodeURIComponent('Same Name') }) },
        );
        expect(res.status).toBe(200);
        expect(db.writes.filter((w) => w.startsWith('order.updateMany:'))).toEqual(['order.updateMany:ord-a-same']);
        expect(db.get('order', 'ord-b-same')!.customer_id).toBeNull();
        expect(db.get('order', 'ord-null-biz')!.customer_id).toBeNull();
    });
});

describe('A (sibling). POST /api/orders — a requested customer_id must belong to this tenant', () => {
    const seed = () => ({
        bundle: [{ id: 'bundle-a', business_id: A, price: 25, serving_tier: 'family' }],
        customer: [
            { id: 'cust-a', business_id: A, name: 'A Customer', delivery_address: '1 Tenant A Street' },
            { id: 'cust-b', business_id: B, name: 'B Customer', delivery_address: '9 Secret B Avenue' },
        ],
    });
    const post = (body: any) => require('@/app/api/orders/route').POST(jsonReq('http://localhost/api/orders', 'POST', body));
    const items = [{ bundle_id: 'bundle-a', quantity: 1 }];

    it('refuses another tenant\'s customer and leaks nothing about it', async () => {
        const db = useDb(seed());
        tenantA();
        const res = await post({ customer_name: 'Walk In', customer_id: 'cust-b', items });
        const text = await res.text();
        expect(res.status).toBe(404);
        expect(text).not.toContain('Secret B');
        expect(db.tables.order).toHaveLength(0);
    });

    it('refuses a filter object in place of an id', async () => {
        const db = useDb(seed());
        tenantA();
        const res = await post({ customer_name: 'Walk In', customer_id: { not: '' }, items });
        expect(res.status).toBe(400);
        expect(db.tables.order).toHaveLength(0);
    });

    it('still links its own customer and copies that customer\'s address (unchanged behaviour)', async () => {
        const db = useDb(seed());
        tenantA();
        const res = await post({ customer_name: 'A Customer', customer_id: 'cust-a', items });
        expect(res.status).toBe(200);
        expect(db.tables.order).toHaveLength(1);
        expect(db.tables.order[0]).toMatchObject({ business_id: A, customer_id: 'cust-a', delivery_address: '1 Tenant A Street' });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. CUSTOMER CSV IMPORT MATCHING
// ═════════════════════════════════════════════════════════════════════════════

describe('B. POST /api/customers/upload — only identifiers a row carries can match', () => {
    const HEADER = 'First Name,Last Name,Email Address,Phone Number,Square Customer ID';
    const seed = () => ({
        customer: [
            { id: 'a-first', business_id: A, name: 'Alice First', contact_name: 'Alice First', contact_email: 'alice@a.test', external_id: 'SQ-ALICE', type: 'direct_customer' },
            { id: 'a-dup-1', business_id: A, name: 'Dup One', contact_email: 'dup@a.test', type: 'direct_customer' },
            { id: 'a-dup-2', business_id: A, name: 'Dup Two', contact_email: 'dup@a.test', type: 'direct_customer' },
            // Seeded BEFORE the external-id holder, so an OR over both identifiers returns it first.
            { id: 'a-email-holder', business_id: A, name: 'Email Holder', contact_email: 'holder@a.test', type: 'direct_customer' },
            { id: 'a-ext-holder', business_id: A, name: 'External Id Holder', contact_email: 'other@a.test', external_id: 'SQ-HOLDER', type: 'direct_customer' },
            { id: 'b-carol', business_id: B, name: 'Carol B', contact_email: 'carol@b.test', external_id: 'SQ-CAROL', type: 'direct_customer' },
            { id: 'b-shared', business_id: B, name: 'Shared B', contact_email: 'shared@x.test', type: 'direct_customer' },
        ],
    });
    const run = async (rows: string[]) => {
        const { POST } = require('@/app/api/customers/upload/route');
        const res = await POST(csvRequest('http://localhost/api/customers/upload', [HEADER, ...rows].join('\n')));
        return { status: res.status, body: await res.json() };
    };
    const snapshot = (db: ReturnType<typeof createMemoryDb>, ids: string[]) => ids.map((id) => JSON.stringify(db.get('customer', id)));
    const ALL_SEEDED = ['a-first', 'a-dup-1', 'a-dup-2', 'a-email-holder', 'a-ext-holder', 'b-carol', 'b-shared'];

    it('external id + email: a genuinely new row creates, nothing existing changes', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        const { status } = await run(['New,One,new1@a.test,555,SQ-NEW-1']);
        expect(status).toBe(200);
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer.find((c) => c.external_id === 'SQ-NEW-1')).toMatchObject({ business_id: A, contact_email: 'new1@a.test' });
    });

    it('external id names one customer and the email another: updates the external-id customer only', async () => {
        const db = useDb(seed()); tenantA();
        const emailHolderBefore = JSON.stringify(db.get('customer', 'a-email-holder'));
        const { status } = await run(['Holder,Row,holder@a.test,555,SQ-HOLDER']);
        expect(status).toBe(200);
        // The old single OR returned whichever matching row came back first — here the email holder.
        expect(JSON.stringify(db.get('customer', 'a-email-holder'))).toBe(emailHolderBefore);
        expect(db.get('customer', 'a-ext-holder')).toMatchObject({ name: 'Holder Row', external_id: 'SQ-HOLDER' });
        expect(db.tables.customer).toHaveLength(7);
    });

    it('external id only (blank email): looked up by the external id alone, created new, no empty branch sent', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        const { status } = await run(['New,Two,,555,SQ-NEW-2']);
        expect(status).toBe(200);
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer.find((c) => c.external_id === 'SQ-NEW-2')).toMatchObject({ business_id: A, name: 'New Two' });
        assertNoWildcardBranches(db.queries);
    });

    it('external id only, with the email column absent entirely: same — no empty branch, nothing existing changes', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        const { POST } = require('@/app/api/customers/upload/route');
        const res = await POST(csvRequest('http://localhost/api/customers/upload',
            'First Name,Last Name,Phone Number,Square Customer ID\nNo,Email,555,SQ-NO-EMAIL'));
        expect(res.status).toBe(200);
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer.find((c) => c.external_id === 'SQ-NO-EMAIL')).toBeTruthy();
        assertNoWildcardBranches(db.queries);
    });

    it('whitespace-only email is treated as no email (quoted cell of spaces)', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        await run(['Space,Mail,"   ",555,SQ-NEW-WS']);
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer.find((c) => c.external_id === 'SQ-NEW-WS')).toBeTruthy();
        assertNoWildcardBranches(db.queries);
    });

    it('email only: matches the one customer with that email in THIS tenant (unchanged upsert)', async () => {
        const db = useDb(seed()); tenantA();
        await run(['Alice,Renamed,alice@a.test,555,']);
        expect(db.get('customer', 'a-first')).toMatchObject({ name: 'Alice Renamed', source: 'Square CSV' });
        expect(db.tables.customer).toHaveLength(7);
    });

    it('neither identifier: always a new customer, and no lookup is run at all', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        await run(['Nobody,Known,,555,']);
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer).toHaveLength(8);
        expect(db.queries.filter((q) => q.model === 'customer')).toEqual([]);
    });

    it('an existing external id still updates exactly that customer (legitimate path preserved)', async () => {
        const db = useDb(seed()); tenantA();
        await run(['Alice,Updated,,555,SQ-ALICE']);
        expect(db.get('customer', 'a-first')).toMatchObject({ name: 'Alice Updated', external_id: 'SQ-ALICE' });
        expect(db.tables.customer).toHaveLength(7);
    });

    it('duplicate email within the tenant: skipped and reported, neither duplicate changes', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        const { body } = await run(['Dup,Row,dup@a.test,555,SQ-NEW-DUP']);
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer).toHaveLength(7);
        expect(body.message).toContain('Skipped 1');
        expect(body.logs.join(' ')).toContain('more than one existing customer has that email address');
    });

    it('same email in another tenant: creates in this tenant, the other tenant\'s customer is untouched', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        await run(['Shared,A,shared@x.test,555,SQ-NEW-SH']);
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer.find((c) => c.external_id === 'SQ-NEW-SH')).toMatchObject({ business_id: A });
    });

    it('same external id in another tenant: never matches or changes that customer', async () => {
        const db = useDb(seed()); tenantA();
        const before = snapshot(db, ALL_SEEDED);
        await run(['Carol,A,carol-a@a.test,555,SQ-CAROL']);
        // The database refuses a second row with that external id (pre-existing
        // behaviour); what matters here is that tenant B's row is never matched.
        expect(snapshot(db, ALL_SEEDED)).toEqual(before);
        expect(db.tables.customer.filter((c) => c.business_id === A && c.external_id === 'SQ-CAROL')).toEqual([]);
        expect(db.queries.filter((q) => q.model === 'customer').every((q) => q.where.business_id === A)).toBe(true);
    });

    it('an unauthorized request imports nothing', async () => {
        const db = useDb(seed());
        useSession(null);
        const { status } = await run(['New,One,new1@a.test,555,SQ-NEW-1']);
        expect(status).toBe(401);
        expect(db.writes).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. FUNDRAISER CSV IMPORT MATCHING
// ═════════════════════════════════════════════════════════════════════════════

describe('C. POST /api/fundraisers/upload — a fundraiser attaches only to the organization the row names', () => {
    const HEADER = 'Organization,Campaign,Contact,Email,Phone';
    const seed = () => ({
        business: [{ id: A, default_food_tax_percent: 1 }],
        customer: [
            // First row in the table: what findFirst over several matches hands back first.
            { id: 'org-alpha', business_id: A, name: 'Alpha Org', contact_email: 'alpha@org.test', type: 'fundraiser_org' },
            { id: 'org-twin-1', business_id: A, name: 'Twin Org', contact_email: 'twin1@org.test', type: 'fundraiser_org' },
            { id: 'org-twin-2', business_id: A, name: 'Twin Org', contact_email: 'twin2@org.test', type: 'fundraiser_org' },
            { id: 'org-owner', business_id: A, name: 'Email Owner Org', contact_email: 'owner@org.test', type: 'fundraiser_org' },
            { id: 'org-beta', business_id: B, name: 'Beta Org', contact_email: 'beta@org.test', type: 'fundraiser_org' },
        ],
    });
    const run = async (rows: string[], session: any = { user: { businessId: A, email: 'owner@tenant-a.test' } }) => {
        useSession(session);
        const { POST } = require('@/app/api/fundraisers/upload/route');
        const res = await POST(csvRequest('http://localhost/api/fundraisers/upload', [HEADER, ...rows].join('\n')));
        return { status: res.status, body: await res.json() };
    };
    const campaignsOf = (db: ReturnType<typeof createMemoryDb>, orgId: string) => db.tables.fundraiserCampaign.filter((c) => c.customer_id === orgId);

    it('new organization with a blank email: a NEW organization gets the fundraiser, no empty branch sent', async () => {
        const db = useDb(seed());
        const { status } = await run(['Brand New PTA,Spring,Jo,,555']);
        expect(status).toBe(200);
        const created = db.tables.customer.find((c) => c.name === 'Brand New PTA');
        expect(created).toMatchObject({ business_id: A, type: 'fundraiser_org' });
        expect(campaignsOf(db, created!.id)).toHaveLength(1);
        expect(campaignsOf(db, 'org-alpha')).toHaveLength(0);
        assertNoWildcardBranches(db.queries);
    });

    it('whitespace-only email: same as blank', async () => {
        const db = useDb(seed());
        await run(['Spacey PTA,Spring,Jo,"   ",555']);
        expect(campaignsOf(db, 'org-alpha')).toHaveLength(0);
        expect(db.tables.customer.find((c) => c.name === 'Spacey PTA')).toBeTruthy();
        assertNoWildcardBranches(db.queries);
    });

    it('existing organization by name (blank email): reuses it (legitimate path preserved)', async () => {
        const db = useDb(seed());
        await run(['alpha org,Fall,Jo,,555']);
        expect(campaignsOf(db, 'org-alpha')).toHaveLength(1);
        expect(db.tables.customer).toHaveLength(5);
    });

    it('existing organization by email only: reuses the one organization with that email', async () => {
        const db = useDb(seed());
        await run(['Renamed Owner,Fall,Jo,owner@org.test,555']);
        expect(campaignsOf(db, 'org-owner')).toHaveLength(1);
        expect(db.tables.customer).toHaveLength(5);
    });

    it('name and email pointing at two different organizations: skipped and reported, nothing attached', async () => {
        const db = useDb(seed());
        const { body } = await run(['Alpha Org,Fall,Jo,owner@org.test,555']);
        expect(db.tables.fundraiserCampaign).toHaveLength(0);
        expect(body.message).toContain('Skipped 1');
        expect(body.logs.join(' ')).toContain('more than one existing organization matches');
    });

    it('duplicate organization names in the tenant: skipped and reported, nothing attached', async () => {
        const db = useDb(seed());
        await run(['Twin Org,Fall,Jo,,555']);
        expect(campaignsOf(db, 'org-twin-1')).toHaveLength(0);
        expect(campaignsOf(db, 'org-twin-2')).toHaveLength(0);
        expect(db.tables.customer).toHaveLength(5);
    });

    it('a name that exists only in another tenant: creates in this tenant, never selects the foreign organization', async () => {
        const db = useDb(seed());
        await run(['Beta Org,Fall,Jo,,555']);
        expect(campaignsOf(db, 'org-beta')).toHaveLength(0);
        const mine = db.tables.customer.find((c) => c.name === 'Beta Org' && c.business_id === A);
        expect(campaignsOf(db, mine!.id)).toHaveLength(1);
        expect(db.queries.filter((q) => q.model === 'customer').every((q) => q.where.business_id === A)).toBe(true);
    });

    it('an email that exists only in another tenant: creates in this tenant', async () => {
        const db = useDb(seed());
        await run(['Gamma PTA,Fall,Jo,beta@org.test,555']);
        expect(campaignsOf(db, 'org-beta')).toHaveLength(0);
        expect(db.get('customer', 'org-beta')!.contact_email).toBe('beta@org.test');
        expect(db.tables.customer.find((c) => c.name === 'Gamma PTA')).toMatchObject({ business_id: A });
    });

    it('an unauthorized request imports nothing; a session without a business is refused', async () => {
        const db = useDb(seed());
        expect((await run(['X,Y,Z,,1'], null)).status).toBe(401);
        expect((await run(['X,Y,Z,,1'], { user: { email: 'no-business@test' } })).status).toBe(403);
        expect(db.writes).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SIBLING: the order-sync adapter (People → Sync, Square orders)
// ═════════════════════════════════════════════════════════════════════════════

describe('Sibling. lib/ingestion_db — a synced order links only to a matching customer of this tenant', () => {
    const seed = () => ({
        customer: [
            { id: 'a-first', business_id: A, name: 'Alice First', contact_email: 'alice@a.test', type: 'direct_customer' },
            { id: 'b-cust', business_id: B, name: 'Walk In Person', contact_email: 'b@b.test', type: 'direct_customer' },
        ],
        order: [
            { id: 'ord-a', business_id: A, external_id: 'SQ-ORDER-A', customer_id: 'a-first', customer_name: 'Alice First', status: 'pending', total_amount: 10 },
            { id: 'ord-b', business_id: B, external_id: 'SQ-ORDER-B', customer_id: 'b-cust', customer_name: 'Walk In Person', status: 'pending', total_amount: 99 },
            { id: 'ord-unowned', business_id: null, external_id: 'SQ-ORDER-NULL', customer_id: null, customer_name: 'Old', status: 'pending', total_amount: 5 },
        ],
    });
    const adapter = () => { const { IngestionDBAdapter } = require('@/lib/ingestion_db'); return new IngestionDBAdapter(A); };

    it('an order with no email address is matched by name alone — no empty branch is sent', async () => {
        const db = useDb(seed());
        const found = await adapter().createOrg('Someone New', '');
        expect(found.id).not.toBe('a-first');
        expect(db.get('customer', found.id)).toMatchObject({ business_id: A, name: 'Someone New' });
        assertNoWildcardBranches(db.queries);
    });

    it('a matching name in this tenant still links (legitimate path preserved)', async () => {
        useDb(seed());
        expect((await adapter().createOrg('alice first', '')).id).toBe('a-first');
    });

    it('a name that exists only in another tenant is never selected', async () => {
        useDb(seed());
        expect((await adapter().createOrg('Walk In Person', '')).id).not.toBe('b-cust');
    });

    it('re-syncing another tenant\'s order id is refused and changes nothing about that order', async () => {
        const db = useDb(seed());
        const before = JSON.stringify(db.get('order', 'ord-b'));
        await expect(adapter().createOrder({ external_id: 'SQ-ORDER-B', organization_id: 'a-first', status: 'production_ready', customer_name: 'X', total_amount: 1 }))
            .rejects.toThrow('already exists outside this business');
        expect(JSON.stringify(db.get('order', 'ord-b'))).toBe(before);
        expect(db.writes).toEqual([]);
    });

    it('an order with no business is never adopted', async () => {
        const db = useDb(seed());
        await expect(adapter().createOrder({ external_id: 'SQ-ORDER-NULL', organization_id: 'a-first', status: 'production_ready', customer_name: 'X', total_amount: 1 }))
            .rejects.toThrow('already exists outside this business');
        expect(db.get('order', 'ord-unowned')!.customer_id).toBeNull();
    });

    it('re-syncing this tenant\'s own order still updates it (idempotent upsert preserved)', async () => {
        const db = useDb(seed());
        const id = await adapter().createOrder({ external_id: 'SQ-ORDER-A', organization_id: 'a-first', status: 'production_ready', customer_name: 'Alice First', total_amount: 12 });
        expect(id).toBe('ord-a');
        expect(db.get('order', 'ord-a')).toMatchObject({ status: 'production_ready', total_amount: 12 });
    });
});
