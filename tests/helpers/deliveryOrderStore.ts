/**
 * DELIVERY-FUNDRAISER-GROUPING-1 — a small STATEFUL Order store for route tests.
 *
 * tests/helpers/routeHarness.ts records calls and returns canned results, which is
 * right for "did the handler scope its query", but it cannot answer "did a failed
 * write roll back" or "what happens when two clicks race". This holds real rows,
 * evaluates the `where` shapes the delivery routes use, and gives each
 * interactive $transaction an UNDO LOG of its own writes — so a throw inside one
 * reverts exactly what that transaction wrote, as row-level Postgres would, and a
 * concurrent writer's committed rows are never touched.
 *
 * Unknown operators THROW rather than match: a fake that silently matched an
 * unsupported filter would make every assertion built on it vacuous.
 */

export type StoreRow = Record<string, any> & { id: string };

function fieldMatches(value: any, cond: any): boolean {
    if (cond === undefined) return true; // Prisma ignores an undefined filter
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === 'object' && !Array.isArray(cond)) {
        for (const [op, arg] of Object.entries(cond)) {
            if (op === 'in') { if (!(arg as any[]).map(String).includes(String(value))) return false; }
            else if (op === 'not') {
                if (arg === null) { if (value === null || value === undefined) return false; }
                else if (typeof arg === 'object') { if (fieldMatches(value, arg)) return false; }
                else if (String(value) === String(arg)) return false;
            } else {
                throw new Error(`deliveryOrderStore: unsupported operator "${op}"`);
            }
        }
        return true;
    }
    return String(value) === String(cond);
}

export function rowMatches(row: StoreRow, where: any): boolean {
    for (const [key, cond] of Object.entries(where || {})) {
        if (key === 'NOT') { if (rowMatches(row, cond)) return false; continue; }
        if (key === 'OR') { if (!(cond as any[]).some((w) => rowMatches(row, w))) return false; continue; }
        if (key === 'AND') { if (!(cond as any[]).every((w) => rowMatches(row, w))) return false; continue; }
        if (!fieldMatches(row[key], cond)) return false;
    }
    return true;
}

function project(row: StoreRow, select: any): any {
    if (!select) return structuredClone(row);
    const out: any = {};
    for (const [k, v] of Object.entries(select)) if (v) out[k] = structuredClone(row[k]);
    return out;
}

export interface DeliveryOrderStore {
    rows: StoreRow[];
    client: any;
    /** Every updateMany actually applied (inside or outside a transaction), with its data. */
    writes: { where: any; data: any; count: number }[];
    /**
     * What happened, in order: `tx<N>:commit`, `tx<N>:rollback`, and `outside:write:<ids>` for a
     * write made outside any transaction (a concurrent writer such as the handoff).
     */
    events: string[];
    /** Throw inside the NEXT transaction once it has applied this many row updates. */
    failAfterRowUpdates: number | null;
    /** Runs (and is awaited) at the start of the NEXT interactive transaction — a writer that commits first. */
    beforeNextTransaction: (() => void | Promise<void>) | null;
    /** Fired (not awaited) right after the NEXT transaction's first read — a writer racing the commit. */
    afterFirstReadInNextTransaction: (() => void) | null;
    get(id: string): StoreRow | undefined;
}

interface TxState { id: number; done: Promise<void>; finish: () => void; readHookFired: boolean }

/**
 * ROW LOCKS. A row updated inside a transaction, or selected FOR UPDATE, is locked by
 * that transaction until it ends. A write from OUTSIDE (the simulated concurrent
 * writer) that matches a locked row waits for the lock holder to finish, then
 * re-evaluates its WHERE against what was committed — Postgres's behaviour at READ
 * COMMITTED. Without this the fake could not tell "the release waited for the
 * delivery" from "the release slipped in mid-delivery".
 */
export function createDeliveryOrderStore(seed: StoreRow[]): DeliveryOrderStore {
    const store: DeliveryOrderStore = {
        rows: seed.map((r) => structuredClone(r)),
        client: null,
        writes: [],
        events: [],
        failAfterRowUpdates: null,
        beforeNextTransaction: null,
        afterFirstReadInNextTransaction: null,
        get: (id) => store.rows.find((r) => r.id === id),
    };
    const locks = new Map<string, TxState>();
    let txSeq = 0;
    let pendingAfterReadHook: (() => void) | null = null;

    type Ctx = { tx: TxState; undo: { row: StoreRow; prev: Record<string, any> }[]; counter: { n: number } } | null;

    const apply = (ctx: Ctx, args: any) => {
        let count = 0;
        const ids: string[] = [];
        for (const row of store.rows) {
            if (!rowMatches(row, args.where)) continue;
            if (ctx && store.failAfterRowUpdates !== null && ctx.counter.n >= store.failAfterRowUpdates) {
                store.failAfterRowUpdates = null;
                throw new Error('injected mid-transaction failure');
            }
            const prev: Record<string, any> = {};
            for (const k of Object.keys(args.data)) prev[k] = row[k];
            if (ctx) { ctx.undo.push({ row, prev }); locks.set(row.id, ctx.tx); ctx.counter.n++; }
            Object.assign(row, structuredClone(args.data));
            ids.push(row.id);
            count++;
        }
        store.writes.push({ where: args.where, data: args.data, count });
        if (!ctx && count > 0) store.events.push(`outside:write:${ids.join(',')}`);
        return { count };
    };

    const makeOrderDelegate = (ctx: Ctx) => ({
        findMany: async (args: any = {}) => {
            const rows = store.rows.filter((r) => rowMatches(r, args.where)).sort((a, b) => a.id.localeCompare(b.id));
            const out = rows.map((r) => project(r, args.select));
            if (ctx && !ctx.tx.readHookFired) {
                ctx.tx.readHookFired = true;
                const hook = pendingAfterReadHook;
                pendingAfterReadHook = null;
                if (hook) hook();
            }
            return out;
        },
        count: async (args: any = {}) => store.rows.filter((r) => rowMatches(r, args.where)).length,
        updateMany: async (args: any) => {
            if (!ctx) {
                // A concurrent writer: wait out every lock held on a row it would touch.
                for (;;) {
                    const blocker = store.rows.find((r) => rowMatches(r, args.where) && locks.has(r.id));
                    if (!blocker) break;
                    await locks.get(blocker.id)!.done;
                }
            }
            return apply(ctx, args);
        },
    });

    const client: any = { order: makeOrderDelegate(null) };
    // Interactive transactions run one at a time. Two Postgres transactions that
    // update the same rows serialize on the row locks — the second waits, then
    // re-evaluates its WHERE against the committed winner. Without this the fake
    // would let one transaction see (and trip over) another's uncommitted writes,
    // a race Postgres cannot produce.
    let lane: Promise<unknown> = Promise.resolve();
    const runInteractive = async (fn: (tx: any) => Promise<any>) => {
        const hook = store.beforeNextTransaction;
        store.beforeNextTransaction = null;
        if (hook) await hook();
        pendingAfterReadHook = store.afterFirstReadInNextTransaction;
        store.afterFirstReadInNextTransaction = null;

        let finish!: () => void;
        const state: TxState = { id: ++txSeq, done: new Promise<void>((r) => { finish = r; }), finish: () => finish(), readHookFired: false };
        const ctx: Ctx = { tx: state, undo: [], counter: { n: 0 } };
        const tx: any = {
            order: makeOrderDelegate(ctx),
            // Only the one raw statement the delivery route issues: lock this tenant's campaign rows.
            $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
                const sql = strings.join('?').replace(/\s+/g, ' ').trim();
                if (sql !== 'SELECT id FROM orders WHERE business_id = ? AND campaign_id = ? ORDER BY id FOR UPDATE') {
                    throw new Error(`deliveryOrderStore: unsupported raw SQL "${sql}"`);
                }
                const [businessId, campaignId] = values;
                const rows = store.rows.filter((r) => r.business_id === businessId && r.campaign_id === campaignId).sort((a, b) => a.id.localeCompare(b.id));
                for (const r of rows) locks.set(r.id, state);
                return rows.map((r) => ({ id: r.id }));
            },
        };
        const release = (outcome: 'commit' | 'rollback') => {
            store.events.push(`tx${state.id}:${outcome}`);
            for (const [id, holder] of [...locks]) if (holder === state) locks.delete(id);
            state.finish();
        };
        try {
            const result = await fn(tx);
            release('commit');
            return result;
        } catch (e) {
            for (const { row, prev } of ctx.undo.reverse()) Object.assign(row, prev);
            release('rollback');
            throw e;
        }
    };
    client.$transaction = (arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg);
        const run = lane.then(() => runInteractive(arg));
        lane = run.catch(() => undefined);
        return run;
    };
    store.client = client;
    return store;
}
