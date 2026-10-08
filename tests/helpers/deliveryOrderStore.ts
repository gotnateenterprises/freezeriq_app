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
    /** Throw inside the NEXT transaction once it has applied this many row updates. */
    failAfterRowUpdates: number | null;
    /** Runs at the start of the NEXT interactive transaction — a writer that commits first. */
    beforeNextTransaction: (() => void) | null;
    get(id: string): StoreRow | undefined;
}

export function createDeliveryOrderStore(seed: StoreRow[]): DeliveryOrderStore {
    const store: DeliveryOrderStore = {
        rows: seed.map((r) => structuredClone(r)),
        client: null,
        writes: [],
        failAfterRowUpdates: null,
        beforeNextTransaction: null,
        get: (id) => store.rows.find((r) => r.id === id),
    };

    const makeOrderDelegate = (undo: { row: StoreRow; prev: Record<string, any> }[] | null, txCounter: { n: number } | null) => ({
        findMany: async (args: any = {}) => {
            const rows = store.rows.filter((r) => rowMatches(r, args.where)).sort((a, b) => a.id.localeCompare(b.id));
            return rows.map((r) => project(r, args.select));
        },
        count: async (args: any = {}) => store.rows.filter((r) => rowMatches(r, args.where)).length,
        updateMany: async (args: any) => {
            let count = 0;
            for (const row of store.rows) {
                if (!rowMatches(row, args.where)) continue;
                if (txCounter && store.failAfterRowUpdates !== null && txCounter.n >= store.failAfterRowUpdates) {
                    store.failAfterRowUpdates = null;
                    throw new Error('injected mid-transaction failure');
                }
                const prev: Record<string, any> = {};
                for (const k of Object.keys(args.data)) prev[k] = row[k];
                if (undo) undo.push({ row, prev });
                Object.assign(row, structuredClone(args.data));
                count++;
                if (txCounter) txCounter.n++;
            }
            store.writes.push({ where: args.where, data: args.data, count });
            return { count };
        },
    });

    const client: any = { order: makeOrderDelegate(null, null) };
    // Interactive transactions run one at a time. Two Postgres transactions that
    // update the same rows serialize on the row locks — the second waits, then
    // re-evaluates its WHERE against the committed winner. Without this the fake
    // would let one transaction see (and trip over) another's uncommitted writes,
    // a race Postgres cannot produce.
    let lane: Promise<unknown> = Promise.resolve();
    const runInteractive = async (fn: (tx: any) => Promise<any>) => {
        const hook = store.beforeNextTransaction;
        store.beforeNextTransaction = null;
        if (hook) hook();
        const undo: { row: StoreRow; prev: Record<string, any> }[] = [];
        const tx = { order: makeOrderDelegate(undo, { n: 0 }) };
        try {
            return await fn(tx);
        } catch (e) {
            for (const { row, prev } of undo.reverse()) Object.assign(row, prev);
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
