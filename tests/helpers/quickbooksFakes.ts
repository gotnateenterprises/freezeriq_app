/**
 * QB-INVOICE-1A — test doubles for the QuickBooks connector.
 *
 * `fakeIntegrationDb` is an in-memory `integrations` table with the semantics the
 * connector relies on and a mock could not honestly provide:
 *   - the composite primary key (create of a duplicate throws P2002);
 *   - `updateMany` / `deleteMany` are real compare-and-swaps: the `where` check
 *     and the write happen together, after a scheduler tick, so concurrent
 *     callers genuinely interleave and exactly one of several racing writes wins;
 *   - `$transaction` + `$executeRaw\`SELECT pg_advisory_xact_lock(key)\`` holds a
 *     lock per key until the transaction settles, like Postgres does;
 *   - one-shot failure injection for a write (thrown before or after it lands).
 *
 * `fakeIntuit` stands in for Intuit's token, revoke and Accounting endpoints and
 * is deliberately as strict as the real service where the connector's safety
 * depends on it:
 *   - an access token only reaches the company the consent was for;
 *   - a refresh that issues a new refresh token kills the old one immediately;
 *   - revoking a token kills it.
 * Every "secret" it issues is a recognisable marker string so a test can prove
 * none of them leaks into logs or plaintext storage. None of these values is a
 * real credential.
 */

import {
    INTUIT_REVOKE_URL,
    INTUIT_TOKEN_URL,
    QUICKBOOKS_API_BASE,
    resolveQuickBooksConfig,
    type QuickBooksConfig,
} from '@/lib/quickbooks/config';

export const TEST_CLIENT_ID = 'TESTCLIENTID-not-a-real-intuit-id';
export const TEST_CLIENT_SECRET = 'TESTCLIENTSECRET-not-a-real-secret';
export const TEST_TOKEN_KEY = 'TESTTOKENKEY-0123456789abcdef-0123456789abcdef';
export const TEST_AUTH_SECRET = 'TESTAUTHSECRET-for-oauth-state-signing-only';
export const LOCAL_REDIRECT = 'http://localhost:3000/api/integrations/quickbooks/callback';

/** A local-development environment with sandbox keys. No real values. */
export function sandboxEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        QBO_ENVIRONMENT: 'sandbox',
        QBO_CLIENT_ID: TEST_CLIENT_ID,
        QBO_CLIENT_SECRET: TEST_CLIENT_SECRET,
        QBO_REDIRECT_URI: LOCAL_REDIRECT,
        INTEGRATION_TOKEN_KEY: TEST_TOKEN_KEY,
        AUTH_SECRET: TEST_AUTH_SECRET,
        ...overrides,
    };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env as unknown as NodeJS.ProcessEnv;
}

export function sandboxConfig(overrides: Record<string, string | undefined> = {}): QuickBooksConfig {
    const r = resolveQuickBooksConfig(sandboxEnv(overrides));
    if (!r.enabled) throw new Error(`test config disabled: ${r.reason}`);
    return r.config;
}

/** A promise a test releases by hand, to force an interleaving instead of racing a timer. */
export function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    return { promise, release };
}

// ── In-memory integrations table ────────────────────────────────────────────

export interface FakeRow {
    business_id: string;
    provider: string;
    access_token: string;
    refresh_token: string | null;
    expires_at: Date | null;
    realm_id: string | null;
    updated_at: Date;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function matches(row: any, where: Record<string, any>): boolean {
    return Object.entries(where).every(([key, val]) => {
        if (key === 'NOT') return !matches(row, val);
        if (val && typeof val === 'object' && !(val instanceof Date) && 'gt' in val) {
            return row[key] instanceof Date && row[key].getTime() > (val.gt as Date).getTime();
        }
        return row[key] === val;
    });
}

type WriteKind = 'create' | 'updateMany' | 'deleteMany' | 'upsert';
interface Injection { kind: WriteKind; when: (args: any) => boolean; mode: 'throw_before' | 'throw_after'; code: string }

export function fakeIntegrationDb() {
    const rows = new Map<string, FakeRow>();
    const key = (b: string, p: string) => `${b}|${p}`;
    const ops: string[] = [];
    const injections: Injection[] = [];
    const locks = new Map<string, Promise<void>>();

    const inject = async (kind: WriteKind, args: any, write: () => any) => {
        const i = injections.findIndex((x) => x.kind === kind && x.when(args));
        if (i === -1) return write();
        const [inj] = injections.splice(i, 1);
        const transient = Object.assign(new Error(`Injected database error ${inj.code}`), { code: inj.code });
        if (inj.mode === 'throw_before') throw transient;
        write();
        throw transient;
    };

    const integration = {
        async findUnique({ where }: any) {
            await tick();
            ops.push('findUnique');
            const { business_id, provider } = where.business_id_provider;
            const r = rows.get(key(business_id, provider));
            return r ? { ...r } : null;
        },
        async findMany({ where, select }: any) {
            await tick();
            ops.push('findMany');
            return [...rows.values()]
                .filter((r) => matches(r, where))
                .map((r) => (select ? Object.fromEntries(Object.keys(select).map((s) => [s, (r as any)[s]])) : { ...r }));
        },
        async create(args: any) {
            await tick();
            ops.push('create');
            return inject('create', args, () => {
                const { data } = args;
                const k = key(data.business_id, data.provider);
                if (rows.has(k)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
                rows.set(k, { refresh_token: null, expires_at: null, realm_id: null, updated_at: new Date(), ...data });
                return { ...rows.get(k)! };
            });
        },
        async upsert(args: any) {
            await tick();
            ops.push('upsert');
            return inject('upsert', args, () => {
                const { business_id, provider } = args.where.business_id_provider;
                const k = key(business_id, provider);
                const existing = rows.get(k);
                rows.set(k, existing ? { ...existing, ...args.update } : { refresh_token: null, expires_at: null, realm_id: null, updated_at: new Date(), ...args.create });
                return { ...rows.get(k)! };
            });
        },
        async updateMany(args: any) {
            await tick();
            ops.push('updateMany');
            return inject('updateMany', args, () => {
                let count = 0;
                for (const [k, r] of rows) {
                    if (matches(r, args.where)) {
                        rows.set(k, { ...r, ...args.data });
                        count++;
                    }
                }
                return { count };
            });
        },
        async deleteMany(args: any) {
            await tick();
            ops.push('deleteMany');
            return inject('deleteMany', args, () => {
                let count = 0;
                for (const [k, r] of [...rows]) {
                    if (matches(r, args.where)) {
                        rows.delete(k);
                        count++;
                    }
                }
                return { count };
            });
        },
        // Deliberately absent: update/delete. The connector must not use
        // non-conditional writes on a connection row; calling one fails the test.
    };

    async function $transaction(fn: (tx: any) => Promise<any>, _opts?: any) {
        ops.push('$transaction');
        const held: Array<() => void> = [];
        const tx = {
            integration,
            async $executeRaw(strings: TemplateStringsArray, ...values: any[]) {
                ops.push('$executeRaw');
                if (!/pg_advisory_xact_lock/.test(strings.join('?'))) throw new Error('unexpected raw SQL in test');
                const k = String(values[0]);
                while (locks.has(k)) await locks.get(k);
                let release!: () => void;
                locks.set(k, new Promise<void>((r) => { release = r; }));
                held.push(() => { locks.delete(k); release(); });
                return 1;
            },
        };
        try {
            return await fn(tx);
        } finally {
            held.forEach((r) => r());
        }
    }

    return {
        db: { integration, $transaction } as any,
        rows,
        ops,
        /** Make the next matching write fail once (default: a transient connection error, P1017). */
        failOnce: (kind: WriteKind, when: (args: any) => boolean, mode: Injection['mode'] = 'throw_before', code = 'P1017') => {
            injections.push({ kind, when, mode, code });
        },
    };
}

// ── Fake Intuit ─────────────────────────────────────────────────────────────

export interface IntuitCall {
    url: string;
    method: string;
    headers: Headers;
    body: string;
}

export interface FakeIntuitOptions {
    /** Companies that exist in the fake. The first is the default consent. */
    realmIds?: string[];
    refreshDelayMs?: number;
    /** refreshGates[i] holds the RESPONSE of the i-th refresh call (0-based) until released. */
    refreshGates?: Array<Promise<void> | undefined>;
    refreshError?: 'invalid_grant' | 'server_error' | null;
    /** The next refresh is processed (and rotates) but the response never arrives. */
    refreshLostOnce?: boolean;
    /** Token responses omit expires_in. */
    omitExpiresIn?: boolean;
    exchangeError?: 'invalid_grant' | null;
    revokeStatus?: number;
    companyInfoStatus?: number;
    /** Intuit documents that HTTP 200 can carry a Fault body. */
    companyInfoFaultOn200?: boolean;
    /** When true, a refresh returns the SAME refresh token (Intuit's within-24h behaviour). */
    stableRefreshToken?: boolean;
}

export function fakeIntuit(opts: FakeIntuitOptions = {}) {
    const calls: IntuitCall[] = [];
    const realms = opts.realmIds ?? ['9130000000000001'];
    let consentRealm = realms[0];
    const accessRealm = new Map<string, string>();
    const refreshRealm = new Map<string, string>();
    const revoked: string[] = [];
    let seq = 0;
    let refreshCalls = 0;
    let refreshLostOnce = !!opts.refreshLostOnce;
    let hardExpiresIn = 157_680_000; // 5 years
    const expectedBasic = 'Basic ' + Buffer.from(`${TEST_CLIENT_ID}:${TEST_CLIENT_SECRET}`).toString('base64');

    const json = (status: number, body: any, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', intuit_tid: `tid-${calls.length}`, ...headers } });

    const issue = (realm: string, keepRefresh?: string, withHard = false) => {
        seq++;
        const access = `ACCESSTOKEN-SECRET-${seq}`;
        const nextRefresh = keepRefresh ?? `REFRESHTOKEN-SECRET-${seq}`;
        accessRealm.set(access, realm);
        refreshRealm.set(nextRefresh, realm);
        const body: any = { access_token: access, refresh_token: nextRefresh, token_type: 'bearer', x_refresh_token_expires_in: 8_640_000 };
        if (!opts.omitExpiresIn) body.expires_in = 3600;
        if (withHard) body.x_refresh_token_hard_expires_in = hardExpiresIn; // only when opted in
        return body;
    };

    const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const call: IntuitCall = {
            url,
            method: (init.method ?? 'GET').toUpperCase(),
            headers: new Headers(init.headers as any),
            body: typeof init.body === 'string' ? init.body : '',
        };
        calls.push(call);
        const optIn = call.headers.get('x-include-refresh-token-hard-expires-in') === 'true';

        if (url === INTUIT_TOKEN_URL) {
            if (call.headers.get('authorization') !== expectedBasic) return json(401, { error: 'invalid_client' });
            const form = new URLSearchParams(call.body);
            if (form.get('grant_type') === 'authorization_code') {
                if (opts.exchangeError) return json(400, { error: opts.exchangeError, error_description: `code AUTHCODE rejected` });
                if (form.get('redirect_uri') !== LOCAL_REDIRECT) return json(400, { error: 'invalid_request' });
                return json(200, issue(consentRealm, undefined, optIn));
            }
            if (form.get('grant_type') === 'refresh_token') {
                const index = refreshCalls++;
                // Intuit validates and issues at request time; only the RESPONSE is delayed.
                const rt = form.get('refresh_token') ?? '';
                const realm = refreshRealm.get(rt);
                let status = 200;
                let body: any;
                if (opts.refreshError === 'invalid_grant' || !realm) {
                    status = 400;
                    body = { error: 'invalid_grant', error_description: `token ${rt} is invalid` };
                } else if (opts.refreshError === 'server_error') {
                    status = 503;
                    body = { error: 'temporarily_unavailable' };
                } else {
                    body = issue(realm, opts.stableRefreshToken ? rt : undefined, optIn);
                    // A rotated refresh token is dead the moment a new one is issued.
                    if (!opts.stableRefreshToken) refreshRealm.delete(rt);
                }
                if (opts.refreshDelayMs) await new Promise((r) => setTimeout(r, opts.refreshDelayMs));
                const g = opts.refreshGates?.[index];
                if (g) await g;
                if (refreshLostOnce && status === 200) {
                    refreshLostOnce = false;
                    throw new TypeError('fetch failed: response lost after the server processed the request');
                }
                return json(status, body);
            }
            return json(400, { error: 'unsupported_grant_type' });
        }

        if (url === INTUIT_REVOKE_URL) {
            if (call.headers.get('authorization') !== expectedBasic) return json(401, { error: 'invalid_client' });
            const token = JSON.parse(call.body || '{}').token;
            revoked.push(token);
            refreshRealm.delete(token);
            return new Response('', { status: opts.revokeStatus ?? 200 });
        }

        const base = QUICKBOOKS_API_BASE.sandbox + '/v3/company/';
        if (url.startsWith(base)) {
            const token = (call.headers.get('authorization') ?? '').replace(/^Bearer /, '');
            if (opts.companyInfoStatus && opts.companyInfoStatus !== 200) return json(opts.companyInfoStatus, { Fault: {} });
            if (opts.companyInfoFaultOn200) return json(200, { Fault: { Error: [{ code: '10000' }], type: 'SystemFault' }, time: 'now' });
            const tokenRealm = accessRealm.get(token);
            if (!tokenRealm) return json(401, { Fault: { Error: [{ code: '3200' }] } });
            const m = /^\/v3\/company\/(\d+)\/companyinfo\/(\d+)\?minorversion=(\d+)$/.exec(url.slice(QUICKBOOKS_API_BASE.sandbox.length));
            // A token only reaches the company it was authorised for.
            if (!m || m[1] !== m[2] || m[1] !== tokenRealm) return json(403, { Fault: { Error: [{ code: '3100' }] } });
            return json(200, { CompanyInfo: { CompanyName: `Sandbox Company ${m[1].slice(-1)}`, Country: 'US', Email: { Address: 'test@example.invalid' } }, time: 'now' });
        }

        return json(404, {});
    };

    return {
        fetchImpl,
        calls,
        revoked,
        /** The company the next authorization-code exchange is consented for. */
        consentTo: (realm: string) => { consentRealm = realm; },
        tokenCalls: (grant: string) => calls.filter((c) => c.url === INTUIT_TOKEN_URL && new URLSearchParams(c.body).get('grant_type') === grant),
        companyInfoCalls: () => calls.filter((c) => c.url.includes('/companyinfo/')),
        expireAllAccessTokens: () => accessRealm.clear(),
        setHardExpiresIn: (s: number) => { hardExpiresIn = s; },
        invalidateRefresh: (t: string) => refreshRealm.delete(t),
    };
}

/** Captures everything written to the console during `fn`. */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
    const lines: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map((m) => console[m]);
    methods.forEach((m) => {
        (console as any)[m] = (...args: any[]) => {
            lines.push(args.map((a) => {
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})); } catch { return String(a); }
            }).join(' '));
        };
    });
    try {
        const result = await fn();
        return { result, output: lines.join('\n') };
    } finally {
        methods.forEach((m, i) => { (console as any)[m] = originals[i]; });
    }
}
