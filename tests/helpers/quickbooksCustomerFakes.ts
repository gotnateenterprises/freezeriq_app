/**
 * QB-INVOICE-1B — test doubles for QuickBooks customer mapping and invoice links.
 *
 * `fakeQuickBooksCustomers` plugs into fakeIntuit({ accounting }) and is as strict as
 * Intuit where mapping safety depends on it (Intuit Accounting API docs, 2026-09-13):
 *   - the query must be exactly the shape the client documents, or it is a 400 Fault;
 *   - `=` on DisplayName ignores letter case; a query returns ACTIVE customers only
 *     unless it filters `Active = false`;
 *   - DisplayName is unique across customers, vendors and employees, case-insensitive
 *     here — a clash is Fault 6240;
 *   - a nonexistent id is Fault 610 (HTTP 400);
 *   - a repeated `requestid` returns the original response and creates nothing;
 *   - injectable failures: a 200 carrying a Fault, 5xx, a lost response after the
 *     create was processed, malformed bodies.
 * It records every call, including create payloads, so tests can prove minimality.
 *
 * `fakeLinkDb` extends the 1A fakeIntegrationDb with the QB-INVOICE-1B tables and the
 * database guarantees the service relies on: every unique index (P2002) — including the
 * LIFETIME rule UNIQUE (invoice_id) — CHECK constraints (P2004), composite same-tenant
 * foreign keys (P2003), and what Forget's DELETE of the integrations row does: the
 * generation's live pair is SET NULL (the generation ends and is KEPT), customer links
 * CASCADE, invoice links are untouched. A customer link can only reference a LIVE
 * generation. `$queryRaw` FOR SHARE locks the tenant's integrations row: writes to that
 * row from elsewhere wait, and a generation, customer link or invoice-link reservation
 * written WITHOUT the lock is recorded as a violation. Updating or deleting a generation
 * or an invoice link, and any invoice write, FAILS THE TEST. Operations yield a tick so
 * racing callers interleave.
 */

import { randomUUID } from 'crypto';
import { fakeIntegrationDb, type AccountingRequest } from './quickbooksFakes';

const tick = () => new Promise<void>((r) => setImmediate(r));
const prismaError = (code: string) => Object.assign(new Error(`Fake Prisma error ${code}`), { code });

// ── Fake Intuit customers ───────────────────────────────────────────────────

export interface FakeCustomer {
    Id: string;
    DisplayName: string;
    Active: boolean;
    Job?: boolean;
    IsProject?: boolean;
    PrimaryEmailAddr?: { Address: string };
    CompanyName?: string;
    Balance?: number;
}

type Op = 'query' | 'read' | 'create';
type Failure =
    | { op: Op; kind: 'fault200'; code?: string }
    | { op: Op; kind: 'status'; status: number; code?: string }
    | { op: Op; kind: 'lost' }          // processed by "Intuit", response never arrives
    | { op: Op; kind: 'malformed' }
    | { op: Op; kind: 'gate'; wait: Promise<void> };

export interface CustomerCall { op: Op | 'other'; method: string; path: string; query?: string; body?: any; requestId?: string | null; realm: string }

export function fakeQuickBooksCustomers() {
    const customers = new Map<string, Map<string, FakeCustomer>>(); // realm -> id -> customer
    const otherNames = new Map<string, Set<string>>();               // realm -> vendor/employee names (lowercased)
    const replay = new Map<string, { status: number; body: any }>(); // realm|requestid -> original response
    const calls: CustomerCall[] = [];
    const failures: Failure[] = [];
    let seq = 100;

    const realmStore = (realm: string) => {
        if (!customers.has(realm)) customers.set(realm, new Map());
        return customers.get(realm)!;
    };
    const takeFailure = (op: Op) => {
        const i = failures.findIndex((f) => f.op === op);
        return i === -1 ? null : failures.splice(i, 1)[0];
    };
    const fault = (json: AccountingRequest['json'], status: number, code: string, type = 'ValidationFault') =>
        json(status, { Fault: { Error: [{ Message: 'fault', Detail: `code ${code}`, code }], type }, time: 'now' });

    const QUERY = /^select \* from Customer where DisplayName = '((?:\\'|[^'\\])*)'( and Active = false)? maxresults 20$/;

    async function accounting(req: AccountingRequest): Promise<Response | undefined> {
        const { json, realm } = req;
        const store = realmStore(realm);
        if (req.url.searchParams.get('minorversion') !== '75') return fault(json, 400, '4000');

        if (req.method === 'GET' && req.path === '/query') {
            const q = req.url.searchParams.get('query') ?? '';
            calls.push({ op: 'query', method: req.method, path: req.path, query: q, realm });
            const f = takeFailure('query');
            if (f?.kind === 'gate') await f.wait;
            if (f?.kind === 'status') return fault(json, f.status, f.code ?? '10000', 'SystemFault');
            if (f?.kind === 'fault200') return fault(json, 200, f.code ?? '10000', 'SystemFault');
            if (f?.kind === 'malformed') return json(200, { QueryResponse: { Customer: [{ Id: 'x' }] } });
            if (f?.kind === 'lost') throw new TypeError('fetch failed');
            const m = QUERY.exec(q);
            if (!m) return fault(json, 400, '4000');
            const name = m[1].replace(/\\'/g, "'");
            const wantInactive = !!m[2];
            const rows = [...store.values()].filter((c) => c.DisplayName.toLowerCase() === name.toLowerCase() && c.Active === !wantInactive);
            return json(200, { QueryResponse: rows.length ? { Customer: rows.map((c) => ({ ...c })), startPosition: 1, maxResults: rows.length } : {}, time: 'now' });
        }

        const read = /^\/customer\/(\d+)$/.exec(req.path);
        if (req.method === 'GET' && read) {
            calls.push({ op: 'read', method: req.method, path: req.path, realm });
            const f = takeFailure('read');
            if (f?.kind === 'gate') await f.wait;
            if (f?.kind === 'status') return fault(json, f.status, f.code ?? '10000', 'SystemFault');
            if (f?.kind === 'fault200') return fault(json, 200, f.code ?? '10000', 'SystemFault');
            if (f?.kind === 'malformed') return json(200, { Customer: { Id: read[1] } });
            const c = store.get(read[1]);
            if (!c) return fault(json, 400, '610');
            return json(200, { Customer: { ...c }, time: 'now' });
        }

        if (req.method === 'POST' && req.path === '/customer') {
            const requestId = req.url.searchParams.get('requestid');
            let body: any = null;
            try { body = JSON.parse(req.body); } catch { /* recorded as null */ }
            calls.push({ op: 'create', method: req.method, path: req.path, body, requestId, realm });
            const key = `${realm}|${requestId}`;
            if (requestId && replay.has(key)) {
                const r = replay.get(key)!;
                return json(r.status, r.body);
            }
            const f = takeFailure('create');
            if (f?.kind === 'gate') await f.wait;
            if (f?.kind === 'status') return fault(json, f.status, f.code ?? '10000', 'SystemFault');
            if (f?.kind === 'fault200') return fault(json, 200, f.code ?? '10000', 'SystemFault');
            const name = body?.DisplayName;
            let status = 200;
            let responseBody: any;
            if (typeof name !== 'string' || !name || /[:\t\n]/.test(name)) {
                status = 400;
                responseBody = { Fault: { Error: [{ code: '2020' }], type: 'ValidationFault' } };
            } else if ([...store.values()].some((c) => c.DisplayName.toLowerCase() === name.toLowerCase())
                || otherNames.get(realm)?.has(name.toLowerCase())) {
                status = 400;
                responseBody = { Fault: { Error: [{ Message: 'Duplicate Name Exists Error', code: '6240' }], type: 'ValidationFault' } };
            } else {
                const c: FakeCustomer = { Id: String(++seq), DisplayName: name, Active: true, Job: false, IsProject: false };
                store.set(c.Id, c);
                responseBody = { Customer: { ...c, SyncToken: '0' }, time: 'now' };
            }
            if (requestId) replay.set(key, { status, body: responseBody });
            if (f?.kind === 'lost') throw new TypeError('fetch failed: response lost after the server processed the request');
            if (f?.kind === 'malformed') return json(200, { Customer: { Id: 'not-a-number' } });
            return json(status, responseBody);
        }

        calls.push({ op: 'other', method: req.method, path: req.path, realm });
        return undefined;
    }

    return {
        accounting,
        calls,
        seed(realm: string, c: Partial<FakeCustomer> & { DisplayName: string }) {
            const row: FakeCustomer = { Id: String(++seq), Active: true, Job: false, IsProject: false, ...c };
            realmStore(realm).set(row.Id, row);
            return row;
        },
        seedOtherName(realm: string, name: string) {
            if (!otherNames.has(realm)) otherNames.set(realm, new Set());
            otherNames.get(realm)!.add(name.toLowerCase());
        },
        get: (realm: string, id: string) => realmStore(realm).get(id),
        all: (realm: string) => [...realmStore(realm).values()],
        setActive: (realm: string, id: string, active: boolean) => { realmStore(realm).get(id)!.Active = active; },
        /** What "Make inactive" did in the Intuit sandbox (observed 2026-09-14): deactivated AND renamed "<name> (deleted)". */
        makeInactiveLikeQuickBooks: (realm: string, id: string) => {
            const c = realmStore(realm).get(id)!;
            c.Active = false;
            c.DisplayName = `${c.DisplayName} (deleted)`;
        },
        remove: (realm: string, id: string) => { realmStore(realm).delete(id); },
        failNext: (f: Failure) => { failures.push(f); },
        creates: () => calls.filter((c) => c.op === 'create'),
    };
}

// ── Fake database ───────────────────────────────────────────────────────────

export interface GenerationRow {
    id: string; business_id: string; live_business_id: string | null; live_provider: string | null;
    environment: string; company_name: string | null; authorized_by: string | null; authorized_at: Date | null; created_at: Date;
}
export interface LinkRow {
    id: string; business_id: string; customer_id: string; connection_id: string; provider: string;
    qbo_customer_id: string; source: 'existing' | 'created'; linked_by: string | null; linked_at: Date;
}
export interface InvoiceLinkRow {
    id: string; business_id: string; invoice_id: string; connection_id: string; request_id: string;
    qbo_invoice_id: string | null; qbo_linked_at: Date | null; created_by: string | null; created_at: Date;
}
export interface InvoiceRow { id: string; business_id: string; status: string; total_amount: string; paid_at: Date | null; campaign_id: string | null }

const pick = (row: any, select?: Record<string, any>) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, row[k]])) : { ...row };

const whereMatches = (row: any, where: Record<string, any> = {}): boolean =>
    Object.entries(where).every(([k, v]) => (k === 'NOT' ? !whereMatches(row, v) : row[k] === v));

/** A model whose every method outside `impl` records a violation and throws (e.g. an update of history). */
function guarded(name: string, violations: string[], impl: Record<string, (...args: any[]) => any>) {
    return new Proxy(impl, {
        get(target, method: string) {
            if (method in target) return target[method];
            return async () => { violations.push(`${name}.${method}`); throw new Error(`${name}.${method} must never be called`); };
        },
    });
}

export function fakeLinkDb(base = fakeIntegrationDb()) {
    const connections = new Map<string, GenerationRow>();
    const links = new Map<string, LinkRow>();
    const invoiceLinks = new Map<string, InvoiceLinkRow>();
    const customers = new Map<string, { id: string; business_id: string; name: string }>();
    const invoices = new Map<string, InvoiceRow>();
    const violations: string[] = [];
    /** Every FOR SHARE lock taken, as "business|provider". */
    const lockLog: string[] = [];
    /**
     * Every write this "database" refused with a constraint error, as "table:code". A service
     * that refuses BEFORE writing never adds one, so tests can tell the service's own check
     * from the database backstop.
     */
    const rejectedWrites: string[] = [];
    const refuse = (table: string, code: string) => { rejectedWrites.push(`${table}:${code}`); return prismaError(code); };
    const integrationExists = (business: string, provider: string) => base.rows.has(`${business}|${provider}`);

    /**
     * What Postgres does inside the DELETE of an integrations row (Forget):
     *   quickbooks_connections   live pair SET NULL — the generation ENDS and is kept;
     *   quickbooks_customer_links CASCADE.
     * Invoice links are untouched.
     */
    const cascade = () => {
        for (const g of connections.values()) {
            if (g.live_business_id !== null && !integrationExists(g.live_business_id, g.live_provider!)) {
                g.live_business_id = null;
                g.live_provider = null;
            }
        }
        for (const l of [...links.values()]) if (!integrationExists(l.business_id, l.provider)) links.delete(l.id);
    };

    // ── FOR SHARE on integrations rows: writes to a row wait while ANOTHER transaction holds it.
    const shareLocks = new Map<string, Set<number>>();
    let waiters: Array<() => void> = [];
    let txSeq = 0;
    const heldByOthers = (k: string, txId?: number) => [...(shareLocks.get(k) ?? [])].some((id) => id !== txId);
    const holds = (k: string, txId?: number) => txId !== undefined && !!shareLocks.get(k)?.has(txId);
    const waitForRow = async (where: any, txId?: number) => {
        if (!where?.business_id || !where?.provider) return;
        const k = `${where.business_id}|${where.provider}`;
        while (heldByOthers(k, txId)) await new Promise<void>((r) => waiters.push(r));
    };
    const releaseLocks = (txId: number) => {
        for (const set of shareLocks.values()) set.delete(txId);
        const w = waiters; waiters = []; w.forEach((r) => r());
    };
    /** Rows bound to a generation may only be created by a transaction holding the tenant's lock. */
    const requireLock = (txId: number | undefined, businessId: string, what: string) => {
        if (!holds(`${businessId}|quickbooks`, txId)) violations.push(`${what} without the generation lock`);
    };

    const integrationFor = (txId?: number) => ({
        ...base.db.integration,
        async updateMany(args: any) { await waitForRow(args.where, txId); return base.db.integration.updateMany(args); },
        async upsert(args: any) { await waitForRow(args.where?.business_id_provider, txId); return base.db.integration.upsert(args); },
        // Postgres applies the ON DELETE actions inside the DELETE itself, so the fake must too:
        // a reconnect that recreates the row must not revive the old generation's links.
        async deleteMany(args: any) {
            await waitForRow(args.where, txId);
            const res = await base.db.integration.deleteMany(args);
            cascade();
            return res;
        },
    });

    const generationModel = (txId?: number) => guarded('quickBooksConnection', violations, {
        async findFirst({ where, select }: any) {
            await tick(); cascade();
            const r = [...connections.values()].find((g) => whereMatches(g, where));
            return r ? pick(r, select) : null;
        },
        async findMany({ where, select }: any) {
            await tick(); cascade();
            return [...connections.values()].filter((g) => whereMatches(g, where))
                .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).map((g) => pick(g, select));
        },
        async create({ data, select }: any) {
            await tick(); cascade();
            requireLock(txId, data.business_id, 'quickBooksConnection.create');
            const row: GenerationRow = {
                id: randomUUID(), live_business_id: null, live_provider: null, company_name: null,
                authorized_by: null, authorized_at: null, created_at: new Date(), ...data,
            };
            // CHECK constraints
            const liveOk = (row.live_business_id === null && row.live_provider === null)
                || (row.live_business_id === row.business_id && row.live_provider === 'quickbooks');
            if (!liveOk || !['sandbox', 'production'].includes(row.environment)) throw refuse('quickbooks_connections', 'P2004');
            // UNIQUE (live_business_id, live_provider)
            if (row.live_business_id !== null && [...connections.values()].some((g) => g.live_business_id === row.live_business_id && g.live_provider === row.live_provider)) {
                throw refuse('quickbooks_connections', 'P2002');
            }
            // FK (live_business_id, live_provider) -> integrations
            if (row.live_business_id !== null && !integrationExists(row.live_business_id, row.live_provider!)) throw refuse('quickbooks_connections', 'P2003');
            connections.set(row.id, row);
            return pick(row, select);
        },
    });

    const checkLinkConstraints = (row: LinkRow, ignoreId?: string) => {
        if (row.provider !== 'quickbooks' || row.qbo_customer_id === '') throw refuse('quickbooks_customer_links', 'P2004');
        for (const l of links.values()) {
            if (l.id === ignoreId) continue;
            if (l.business_id === row.business_id && l.customer_id === row.customer_id) throw refuse('quickbooks_customer_links', 'P2002');
            if (l.connection_id === row.connection_id && l.qbo_customer_id === row.qbo_customer_id) throw refuse('quickbooks_customer_links', 'P2002');
        }
        const org = customers.get(row.customer_id);
        if (!org || org.business_id !== row.business_id) throw refuse('quickbooks_customer_links', 'P2003');
        if (!integrationExists(row.business_id, row.provider)) throw refuse('quickbooks_customer_links', 'P2003');
        // (business_id, provider, connection_id) -> the generation's (live_business_id, live_provider, id)
        const g = connections.get(row.connection_id);
        if (!g || g.live_business_id !== row.business_id || g.live_provider !== row.provider) throw refuse('quickbooks_customer_links', 'P2003');
    };

    const customerLinkModel = (txId?: number) => guarded('quickBooksCustomerLink', violations, {
        async findUnique({ where, select }: any) {
            await tick(); cascade();
            const { business_id, customer_id } = where.business_id_customer_id;
            const r = [...links.values()].find((l) => l.business_id === business_id && l.customer_id === customer_id);
            return r ? pick(r, select) : null;
        },
        async findFirst({ where, select }: any) {
            await tick(); cascade();
            const r = [...links.values()].find((l) => whereMatches(l, where));
            return r ? pick(r, select) : null;
        },
        async create({ data }: any) {
            await tick(); cascade();
            requireLock(txId, data.business_id, 'quickBooksCustomerLink.create');
            const row: LinkRow = { id: randomUUID(), provider: 'quickbooks', linked_by: null, linked_at: new Date(), ...data };
            checkLinkConstraints(row);
            links.set(row.id, row);
            return { ...row };
        },
        async updateMany({ where, data }: any) {
            await tick(); cascade();
            requireLock(txId, where.business_id, 'quickBooksCustomerLink.updateMany');
            let count = 0;
            for (const l of [...links.values()]) {
                if (whereMatches(l, where)) {
                    const next = { ...l, ...data };
                    checkLinkConstraints(next, l.id);
                    links.set(l.id, next);
                    count++;
                }
            }
            return { count };
        },
    });

    const customer = {
        async findFirst({ where, select }: any) {
            await tick();
            // Prisma semantics: an omitted key is no filter at all (so a missing tenant filter is caught).
            const r = customers.get(where.id);
            return r && (where.business_id === undefined || r.business_id === where.business_id) ? pick(r, select) : null;
        },
    };

    // Any invoice write, or a read that selects more than the id, is a test failure.
    const invoice = new Proxy({}, {
        get(_t, method: string) {
            if (method === 'findFirst') {
                return async ({ where, select }: any) => {
                    await tick();
                    if (!select || Object.keys(select).some((k) => k !== 'id')) violations.push(`invoice.findFirst selected ${JSON.stringify(select)}`);
                    const r = invoices.get(where.id);
                    return r && (where.business_id === undefined || r.business_id === where.business_id) ? pick(r, select) : null;
                };
            }
            return async () => { violations.push(`invoice.${method}`); throw new Error(`invoice.${method} must never be called by QuickBooks links`); };
        },
    });

    const checkInvoiceLink = (row: InvoiceLinkRow, ignoreId?: string) => {
        const confirmed = (row.qbo_invoice_id === null && row.qbo_linked_at === null)
            || (row.qbo_invoice_id !== null && row.qbo_invoice_id !== '' && row.qbo_linked_at !== null);
        if (row.request_id === '' || !confirmed) throw refuse('quickbooks_invoice_links', 'P2004'); // CHECK constraints
        for (const l of invoiceLinks.values()) {
            if (l.id === ignoreId) continue;
            if (l.invoice_id === row.invoice_id) throw refuse('quickbooks_invoice_links', 'P2002'); // LIFETIME: UNIQUE (invoice_id)
            if (l.request_id === row.request_id) throw refuse('quickbooks_invoice_links', 'P2002');
            if (row.qbo_invoice_id !== null && l.connection_id === row.connection_id && l.qbo_invoice_id === row.qbo_invoice_id) throw refuse('quickbooks_invoice_links', 'P2002');
        }
        const inv = invoices.get(row.invoice_id);
        if (!inv || inv.business_id !== row.business_id) throw refuse('quickbooks_invoice_links', 'P2003');
        // (business_id, connection_id) -> the generation's (business_id, id): live or ended
        const g = connections.get(row.connection_id);
        if (!g || g.business_id !== row.business_id) throw refuse('quickbooks_invoice_links', 'P2003');
    };

    const projectInvoiceLink = (l: InvoiceLinkRow, select?: Record<string, any>) => {
        const out: any = pick(l, select);
        if (select?.connection) out.connection = pick(connections.get(l.connection_id), select.connection.select);
        return out;
    };

    const invoiceLinkModel = (txId?: number) => guarded('quickBooksInvoiceLink', violations, {
        async findFirst({ where, select }: any) {
            await tick();
            const r = [...invoiceLinks.values()].find((l) => whereMatches(l, where));
            return r ? projectInvoiceLink(r, select) : null;
        },
        async create({ data, select }: any) {
            await tick();
            requireLock(txId, data.business_id, 'quickBooksInvoiceLink.create');
            const row: InvoiceLinkRow = { id: randomUUID(), qbo_invoice_id: null, qbo_linked_at: null, created_by: null, created_at: new Date(), ...data };
            checkInvoiceLink(row);
            invoiceLinks.set(row.id, row);
            return projectInvoiceLink(row, select);
        },
        async updateMany({ where, data }: any) {
            await tick();
            // History: the only change ever made to a link is recording its QuickBooks invoice.
            if (Object.keys(data).some((k) => k !== 'qbo_invoice_id' && k !== 'qbo_linked_at')) violations.push(`quickBooksInvoiceLink.updateMany changed ${Object.keys(data).join(',')}`);
            let count = 0;
            for (const l of [...invoiceLinks.values()]) {
                if (whereMatches(l, where)) {
                    const next = { ...l, ...data };
                    checkInvoiceLink(next, l.id);
                    invoiceLinks.set(l.id, next);
                    count++;
                }
            }
            return { count };
        },
    });

    const modelsFor = (txId?: number) => ({
        integration: integrationFor(txId),
        quickBooksConnection: generationModel(txId),
        quickBooksCustomerLink: customerLinkModel(txId),
        quickBooksInvoiceLink: invoiceLinkModel(txId),
        customer,
        invoice,
    });

    async function $transaction(fn: (tx: any) => Promise<any>, opts?: any) {
        const txId = ++txSeq;
        try {
            return await base.db.$transaction(async (baseTx: any) => fn({
                ...modelsFor(txId),
                $executeRaw: baseTx.$executeRaw,
                async $queryRaw(strings: TemplateStringsArray, ...values: any[]) {
                    const sql = strings.join('?');
                    if (sql !== 'SELECT 1 FROM "integrations" WHERE "business_id" = ? AND "provider" = ? FOR SHARE') throw new Error(`unexpected raw SQL in test: ${sql}`);
                    await tick();
                    const k = `${values[0]}|${values[1]}`;
                    lockLog.push(k);
                    if (!base.rows.has(k)) return [];
                    if (!shareLocks.has(k)) shareLocks.set(k, new Set());
                    shareLocks.get(k)!.add(txId);
                    return [{ '?column?': 1 }];
                },
            }), opts);
        } finally {
            // Nothing a transaction here writes needs rolling back: every write is its last statement,
            // and a write that fails a constraint never lands.
            releaseLocks(txId);
        }
    }

    return {
        db: { ...base.db, ...modelsFor(undefined), $transaction } as any,
        base,
        connections,
        links,
        invoiceLinks,
        customers,
        invoices,
        violations,
        lockLog,
        rejectedWrites,
        seedOrganization(business_id: string, name: string, id: string = randomUUID()) {
            customers.set(id, { id, business_id, name });
            return id;
        },
        renameOrganization(id: string, name: string) { customers.get(id)!.name = name; },
        seedInvoice(business_id: string, id: string = randomUUID()): InvoiceRow {
            const row: InvoiceRow = { id, business_id, status: 'DRAFT', total_amount: '1234.56', paid_at: null, campaign_id: null };
            invoices.set(id, row);
            return row;
        },
        /** What Forget does to the database: delete the integrations row (ON DELETE actions apply). */
        forget(businessId: string) { base.rows.delete(`${businessId}|quickbooks`); cascade(); },
        /** A copy of the tenant's live generation, if any. */
        liveGeneration(businessId: string) {
            const g = [...connections.values()].find((x) => x.live_business_id === businessId);
            return g ? { ...g } : undefined;
        },
        /** Copies of every generation the tenant ever had, oldest first — live and ended. */
        generations: (businessId: string) => [...connections.values()].filter((g) => g.business_id === businessId)
            .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()).map((g) => ({ ...g })),
        /** Holds FOR SHARE on the tenant's integrations row as if another transaction did, until released. */
        holdRowLock(businessId: string) {
            const txId = ++txSeq;
            const k = `${businessId}|quickbooks`;
            if (!shareLocks.has(k)) shareLocks.set(k, new Set());
            shareLocks.get(k)!.add(txId);
            return () => releaseLocks(txId);
        },
    };
}
