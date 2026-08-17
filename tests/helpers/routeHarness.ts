/**
 * FR-FLOW-1 — minimal route-handler test harness.
 *
 * The repo had no way to exercise an API route handler, so the tenant-isolation
 * and auth behaviour of these routes was untestable and untested. This is the
 * smallest thing that fixes that: it runs the REAL handler function and records
 * the arguments the handler passes to Prisma.
 *
 * That distinction matters. These tests do not re-implement the handler's rules
 * and assert on a mock's return value — they assert on the query the handler
 * actually built. A missing `where: { business_id }` is therefore visible to a
 * test, which is exactly the class of defect FR-FLOW-1 exists to fix.
 *
 * Deliberately NOT a database. No container, no migrations, no fixtures. Real
 * cross-database behaviour is proven separately against Postgres.
 */

/** One recorded Prisma call. */
export interface PrismaCall {
    model: string;
    method: string;
    args: any;
}

export interface PrismaMockConfig {
    /**
     * Canned results keyed by `${model}.${method}`. A function receives the call
     * args, so a test can vary the answer (e.g. return a foreign-tenant row only
     * when the query is unscoped).
     */
    results?: Record<string, any | ((args: any) => any)>;
}

export interface PrismaMock {
    calls: PrismaCall[];
    /** Every call for one `model.method`. */
    callsTo(key: string): PrismaCall[];
    /** The first call for one `model.method`, or undefined. */
    firstCall(key: string): PrismaCall | undefined;
    /** Raw SQL strings passed to $queryRaw, joined per invocation. */
    rawQueries: string[];
    client: any;
}

const MODELS = [
    'business', 'customer', 'user', 'fundraiserCampaign', 'campaignBundle',
    'order', 'orderItem', 'bundle', 'businessLead', 'document',
    // FR-PUBLIC-IDENTITY-1: duplicate-organization disambiguation reads these.
    'fundraiserOrganizationContact',
];

const METHODS = [
    'findFirst', 'findUnique', 'findMany', 'create', 'update', 'updateMany',
    'upsert', 'count', 'delete', 'deleteMany',
];

/**
 * Build a recording Prisma double.
 *
 * Unconfigured reads resolve to `null` (findFirst/findUnique), `[]` (findMany)
 * or `0` (count) — a handler that forgot to configure something fails loudly
 * rather than silently passing on a truthy mock.
 */
export function createPrismaMock(config: PrismaMockConfig = {}): PrismaMock {
    const calls: PrismaCall[] = [];
    const rawQueries: string[] = [];
    const results = config.results || {};

    const resolve = (key: string, args: any, fallback: any) => {
        if (!(key in results)) return fallback;
        const r = results[key];
        return typeof r === 'function' ? r(args) : r;
    };

    const client: any = {};
    for (const model of MODELS) {
        client[model] = {};
        for (const method of METHODS) {
            client[model][method] = jest.fn(async (args: any) => {
                calls.push({ model, method, args });
                const key = `${model}.${method}`;
                const fallback =
                    method === 'findMany' ? []
                        : method === 'count' ? 0
                            : method === 'create' || method === 'update' || method === 'upsert'
                                ? { id: `${model}-generated-id`, ...(args?.data || {}) }
                                : null;
                return resolve(key, args, fallback);
            });
        }
    }

    // Tagged-template $queryRaw: record the literal SQL so a test can assert a
    // predicate is present (e.g. that the campaign query is tenant-scoped).
    client.$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        rawQueries.push(sql);
        calls.push({ model: '$queryRaw', method: 'raw', args: { sql, values } });
        return resolve('$queryRaw', { sql, values }, []);
    });
    client.$executeRawUnsafe = jest.fn(async () => 0);
    client.$queryRawUnsafe = jest.fn(async () => []);
    client.$transaction = jest.fn(async (arg: any) =>
        typeof arg === 'function' ? arg(client) : Promise.all(arg)
    );

    return {
        calls,
        callsTo: (key: string) => calls.filter((c) => `${c.model}.${c.method}` === key),
        firstCall: (key: string) => calls.find((c) => `${c.model}.${c.method}` === key),
        rawQueries,
        client,
    };
}

/** Build a JSON POST Request for a route handler. */
export function jsonRequest(url: string, body: unknown): Request {
    return new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** Read a handler's Response as parsed JSON plus its status. */
export async function readJson(res: Response): Promise<{ status: number; body: any }> {
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
}

/** Read a handler's Response as text plus its status (for CSV). */
export async function readText(res: Response): Promise<{ status: number; text: string }> {
    return { status: res.status, text: await res.text() };
}
