/**
 * A small in-memory stand-in for the slice of Prisma the kitchen routes use, with the one property
 * the exact-id route's safety rests on: `$transaction` is ALL-OR-NOTHING. If the callback throws,
 * every row is restored.
 *
 * It evaluates the WHERE shapes the dashboard route and both status routes actually send (tenant,
 * ids, exact status, canceled, released, bundle membership), so a test can run the REAL handlers
 * against shared state instead of asserting on a mock's canned answers.
 */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v), (_k, val) => val);

export class FakeOrderDb {
    rows: any[];
    /** Every status write, in order — for asserting exactly which orders were touched. */
    writes: { id: string; from: string; to: string }[] = [];

    constructor(rows: any[]) { this.rows = rows.map(clone); }

    private matches(r: any, w: any): boolean {
        if (w.business_id !== undefined && r.business_id !== w.business_id) return false;
        if (w.id !== undefined) {
            if (typeof w.id === 'string' ? r.id !== w.id : Array.isArray(w.id?.in) && !w.id.in.includes(r.id)) return false;
        }
        if (w.canceled_at === null && r.canceled_at !== null) return false;
        if (w.released_to_delivery_at === null && r.released_to_delivery_at !== null) return false;
        if (typeof w.status === 'string' && r.status !== w.status) return false;
        if (Array.isArray(w.status?.in) && !w.status.in.includes(r.status)) return false;
        if (typeof w.NOT?.status === 'string' && r.status === w.NOT.status) return false;
        if (w.campaign_id?.not === null && r.campaign_id === null) return false;
        if (w.items?.some?.bundle_id !== undefined && !r.items.some((i: any) => i.bundle_id === w.items.some.bundle_id)) return false;
        // The New Orders lane's compound exclusions.
        if (Array.isArray(w.AND)) {
            for (const clause of w.AND) {
                if (typeof clause?.NOT?.status === 'string' && r.status === clause.NOT.status) return false;
                if (clause?.NOT?.source === 'storefront' && r.source === 'storefront' && r.status === 'pending') return false;
            }
        }
        return true;
    }

    private shape(r: any, args: any) {
        if (!args?.select) return clone(r); // `include` ships every scalar plus the named relations
        const out: any = {};
        for (const [k, v] of Object.entries(args.select)) if (v) out[k] = clone(r[k]);
        return out;
    }

    order = {
        findMany: async (args: any) => this.rows.filter((r) => this.matches(r, args?.where || {})).map((r) => this.shape(r, args)),
        count: async (args: any) => this.rows.filter((r) => this.matches(r, args?.where || {})).length,
        updateMany: async (args: any) => {
            const hit = this.rows.filter((r) => this.matches(r, args?.where || {}));
            for (const r of hit) {
                if (args.data?.status !== undefined) this.writes.push({ id: r.id, from: r.status, to: args.data.status });
                Object.assign(r, args.data);
            }
            return { count: hit.length };
        },
    };

    $transaction = async (fn: (tx: any) => Promise<any>) => {
        const snapshot = this.rows.map(clone);
        const writes = this.writes.length;
        try {
            return await fn(this);
        } catch (e) {
            this.rows = snapshot;               // all-or-nothing
            this.writes.length = writes;
            throw e;
        }
    };

    /** The current status of each order id (for assertions). */
    statusOf(ids: string[]): Record<string, string> {
        return Object.fromEntries(ids.map((id) => [id, this.rows.find((r) => r.id === id)?.status]));
    }
}
