/**
 * SEC-INTUIT-ATTEST-1 — the three findings that had to close before the owner could
 * sign Intuit's Production App Assessment security attestation.
 *
 * The read-only audit that preceded this patch returned DO NOT ANSWER YES YET. Three
 * things were wrong, and this suite is what stops each from coming back:
 *
 *   GAP 1  Every /api response carried Next.js's default `public, max-age=0,
 *          must-revalidate`. The `public` token invites a SHARED cache to store an
 *          authenticated response — invoices, customers, branding. Intuit's app-server
 *          requirement is no-cache/no-store on responses carrying sensitive data.
 *          11 of 223 route files set `no-store` themselves; the other 212 did not.
 *
 *   GAP 2  app/api/tenant/invoices/route.ts logged the ENTIRE request body on POST and
 *          on PUT — line descriptions, quantities, unit prices, totals, customer_id —
 *          into the runtime log. Pre-existing debug logging, nothing read it.
 *
 *   FINDING 3  GET /api/documents and GET /api/documents/templates gated on
 *          `!session?.user` but then filtered by `session.user.businessId`.
 *          `users.business_id` is NULLABLE and Prisma STRIPS an undefined value from a
 *          where clause, so for a user with no business the filter collapsed: documents
 *          fell back to `{ customer_id }` alone, and the templates OR branch collapsed
 *          to `{}`, which matches every row. Latent, not reached — a read-only
 *          Production count taken during the audit found 0 users with a null
 *          business_id and 0 rows in both tables — but the control was missing.
 *
 * HOW THE CACHE POLICY WAS PROVEN. Section A asserts the config that the Next.js
 * routing layer consumes. That the config actually WINS against a route handler's own
 * header was not assumed; it was measured on Next.js 16.1.1 with a real `next build`
 * followed by `next start`, probing raw response headers (duplicates preserved):
 *
 *   401 /api/tenant/invoices                        cache-control: no-store, no-cache, must-revalidate
 *   401 /api/integrations/quickbooks/status         cache-control: no-store, no-cache, must-revalidate
 *   410 /api/auth/qbo                               cache-control: no-store, no-cache, must-revalidate
 *   200 /login                    cache-control: private, no-cache, no-store, max-age=0, must-revalidate
 *   200 /legal/disconnect                           cache-control: s-maxage=31536000
 *
 * Exactly ONE Cache-Control header per response, never two; `Pragma: no-cache` on every
 * /api/* response; no `public` token anywhere under /api; and pages and static assets
 * untouched. Section B keeps the route-level `no-store` constants in place anyway, as
 * defence in depth for the day someone edits next.config.js.
 *
 * Sections E–G execute the REAL handlers, following the precedent set by
 * tests/secPublicRoute1.test.ts: a status assertion alone cannot tell a guard placed
 * BEFORE the query from one placed after it, so every refusal is also required to reach
 * ZERO database calls.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Comments must not satisfy a source assertion — this file's own prose describes the defect. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__intuitAttestPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__intuitAttestPrisma = m.client; };

// jest.mock factories are hoisted per MODULE PATH, so auth is mocked once here and
// driven per test through mockAuth.
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

// ═════════════════════════════════════════════════════════════════════════════
// A. GAP 1 — the global /api cache policy
// ═════════════════════════════════════════════════════════════════════════════
describe('A. next.config.js pins every /api response to no-store', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require(join(ROOT, 'next.config.js'));

    const entries = async () => (await config.headers()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    const valueOf = (e: { headers: Array<{ key: string; value: string }> } | undefined, key: string) =>
        e?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

    it('declares an /api/:path* entry', async () => {
        const api = (await entries()).find((e) => e.source === '/api/:path*');
        expect(api).toBeDefined();
    });

    it('sets Cache-Control with all three required directives', async () => {
        const api = (await entries()).find((e) => e.source === '/api/:path*');
        const cc = valueOf(api, 'Cache-Control');
        expect(cc).toBeDefined();
        for (const directive of ['no-store', 'no-cache', 'must-revalidate']) {
            expect(cc!.toLowerCase()).toContain(directive);
        }
    });

    it('never marks an /api response public', async () => {
        for (const e of await entries()) {
            const cc = valueOf(e, 'Cache-Control');
            if (cc) expect(cc.toLowerCase()).not.toMatch(/\bpublic\b/);
        }
    });

    it('sets Pragma: no-cache alongside it', async () => {
        const api = (await entries()).find((e) => e.source === '/api/:path*');
        expect(valueOf(api, 'Pragma')?.toLowerCase()).toBe('no-cache');
    });

    it('is the ONLY config entry that sets Cache-Control, so there is one policy source', async () => {
        const setters = (await entries()).filter((e) => e.headers.some((h) => h.key.toLowerCase() === 'cache-control'));
        expect(setters.map((e) => e.source)).toEqual(['/api/:path*']);
    });

    it('leaves pages and static assets alone: the cache entry is scoped to /api', async () => {
        const setters = (await entries()).filter((e) => e.headers.some((h) => h.key.toLowerCase() === 'cache-control'));
        for (const e of setters) expect(e.source.startsWith('/api/')).toBe(true);
    });

    it('keeps the pre-existing site-wide security headers on /(.*)', async () => {
        const all = (await entries()).find((e) => e.source === '/(.*)');
        expect(valueOf(all, 'X-Frame-Options')).toBe('DENY');
        expect(valueOf(all, 'X-Content-Type-Options')).toBe('nosniff');
        expect(valueOf(all, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    it('covers the routes the attestation names', async () => {
        // The pattern's real matching was measured against a running production build
        // (see this file's header). Here we assert only that each named route lives
        // under the prefix the entry is scoped to.
        const named = [
            '/api/tenant/invoices',
            '/api/tenant/branding',
            '/api/integrations/quickbooks/status',
            '/api/integrations/quickbooks/invoice-settings',
            '/api/auth/qbo',
            '/api/documents',
            '/api/documents/templates',
        ];
        const api = (await entries()).find((e) => e.source === '/api/:path*')!;
        const prefix = api.source.replace(/:path\*$/, '');
        for (const p of named) expect(p.startsWith(prefix)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. The QuickBooks routes keep their own no-store — defence in depth
// ═════════════════════════════════════════════════════════════════════════════
describe('B. QuickBooks routes still set no-store themselves', () => {
    const QB_ROUTES = [
        'app/api/integrations/quickbooks/callback/route.ts',
        'app/api/integrations/quickbooks/connect/route.ts',
        'app/api/integrations/quickbooks/customers/[customerId]/route.ts',
        'app/api/integrations/quickbooks/disconnect/route.ts',
        'app/api/integrations/quickbooks/invoice-settings/route.ts',
        'app/api/integrations/quickbooks/invoices/[invoiceId]/route.ts',
        'app/api/integrations/quickbooks/status/route.ts',
    ];

    it.each(QB_ROUTES)('%s sets Cache-Control: no-store in its own source', (path) => {
        const src = strip(read(path));
        expect(src).toMatch(/'Cache-Control':\s*'no-store'/);
    });

    it('the OAuth callback still pins no-store on the redirect it returns', () => {
        const src = strip(read('app/api/integrations/quickbooks/callback/route.ts'));
        expect(src).toMatch(/res\.headers\.set\('Cache-Control',\s*'no-store'\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. GAP 2 — no request body is written to a log, anywhere under app/api
// ═════════════════════════════════════════════════════════════════════════════
describe('C. no API route logs a request body', () => {
    /** Every tracked route.ts under app/api, as repo-relative POSIX paths. */
    const routeFiles = (): string[] =>
        execFileSync('git', ['ls-files', 'app/api/**/route.ts'], { cwd: ROOT, encoding: 'utf8' })
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);

    it('finds the API surface to sweep', () => {
        expect(routeFiles().length).toBeGreaterThan(100);
    });

    it('the invoice route no longer logs POST or PUT bodies', () => {
        const src = strip(read('app/api/tenant/invoices/route.ts'));
        expect(src).not.toMatch(/console\.\w+\([^)]*Invoice Body/i);
        expect(src).not.toMatch(/JSON\.stringify\(\s*body/);
    });

    it('no route anywhere serialises a request body into a log call', () => {
        const offenders: string[] = [];
        for (const file of routeFiles()) {
            for (const line of strip(read(file)).split('\n')) {
                if (/console\.(log|info|warn|error|debug)\s*\([^)]*JSON\.stringify\s*\(\s*(body|payload|data|req|request)\b/.test(line)) {
                    offenders.push(`${file}: ${line.trim()}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the invoice route logs no customer_id or money field', () => {
        const src = strip(read('app/api/tenant/invoices/route.ts'));
        const logs = src.match(/console\.\w+\([^;]*/g) ?? [];
        for (const call of logs) {
            expect(call).not.toMatch(/customer_id|tax_amount|total|unit_price|quantity|description|fundraiser_profit/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. The invoice route changed by exactly two deletions and nothing else
// ═════════════════════════════════════════════════════════════════════════════
describe('D. invoice behaviour is otherwise unchanged', () => {
    /** The commit released to Production before this remediation. */
    const BASELINE = '4a0dee920ed580068d2348ad6f853b645cb713c8';
    const FILE = 'app/api/tenant/invoices/route.ts';

    /**
     * Line endings are normalised on both sides. The working tree carries CRLF and
     * `git show` hands back LF, so a raw comparison would report every line as changed
     * and this assertion would be about newlines instead of about the patch.
     */
    const lines = (s: string) => s.replace(/\r\n/g, '\n').split('\n');
    const baselineSource = (): string =>
        execFileSync('git', ['show', `${BASELINE}:${FILE}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

    it('the released baseline is reachable (this assertion is not allowed to skip)', () => {
        expect(baselineSource().length).toBeGreaterThan(1000);
    });

    it('differs from the released baseline ONLY by the two removed body-log lines', () => {
        const before = lines(baselineSource());
        const after = lines(read(FILE));

        const removed = before.filter((l) => !after.includes(l) || before.filter((x) => x === l).length > after.filter((x) => x === l).length);
        const added = after.filter((l) => !before.includes(l) || after.filter((x) => x === l).length > before.filter((x) => x === l).length);

        expect(added).toEqual([]);
        expect(removed.map((l) => l.trim())).toEqual([
            "console.log('[API] POST Invoice Body:', JSON.stringify(body, null, 2));",
            "console.log('[API] PUT Invoice Body:', JSON.stringify(body, null, 2));",
        ]);
    });

    it('every handler still refuses a caller with no tenant, as many as before', () => {
        // The route's four handlers each derive businessId from the session and return
        // 401 on a falsy value. Counted against the baseline rather than hard-coded, so
        // this asserts "the patch removed no guard" rather than a number I typed.
        const guards = (s: string) => (s.match(/if\s*\(!businessId\)\s*\{[\s\S]{0,120}?status:\s*401/g) ?? []).length;
        const now = guards(strip(read(FILE)));
        expect(now).toBe(guards(strip(baselineSource())));
        expect(now).toBeGreaterThanOrEqual(2);
    });

    it('POST and PUT still read the same request fields', () => {
        const src = strip(read(FILE));
        for (const field of ['customer_id', 'items', 'tax_amount', 'due_date', 'payment_method', 'status', 'fundraiser_profit_percent', 'fundraiser_profit_amount']) {
            expect(src).toContain(field);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// E–G. FINDING 3 — the documents routes fail closed without tenant identity
// ═════════════════════════════════════════════════════════════════════════════
const TENANT = 'biz-attest-1';
const CUSTOMER = 'cust-attest-1';

/** Sessions that must all be refused, named by the shape they represent. */
const NO_TENANT: Array<[string, any]> = [
    ['no session at all', null],
    ['a session with no user', {}],
    ['an authenticated user with no businessId at all', { user: { id: 'u1' } }],
    ['an authenticated user whose businessId is undefined', { user: { id: 'u1', businessId: undefined } }],
    ['an authenticated user whose businessId is null', { user: { id: 'u1', businessId: null } }],
    ['an authenticated user whose businessId is the empty string', { user: { id: 'u1', businessId: '' } }],
];

describe('E. GET /api/documents', () => {
    const call = async (url = `http://localhost/api/documents?customerId=${CUSTOMER}`) => {
        const { GET } = await import('@/app/api/documents/route');
        const res = await GET(new Request(url) as any);
        return { status: res.status, body: await res.json() };
    };

    beforeEach(() => {
        jest.clearAllMocks();
        useMock(createPrismaMock({ results: { 'document.findMany': [] } }));
    });

    it.each(NO_TENANT)('refuses %s with 401', async (_label, session) => {
        mockAuth.mockResolvedValue(session);
        const { status, body } = await call();
        expect(status).toBe(401);
        expect(body.error).toBe('Unauthorized');
    });

    // G — the refusal must happen BEFORE any query. A guard after the findMany would
    // satisfy the status assertion above and still have read another tenant's rows.
    it.each(NO_TENANT)('reaches ZERO database calls for %s', async (_label, session) => {
        mockAuth.mockResolvedValue(session);
        await call();
        expect(mock.calls).toEqual([]);
    });

    it('still serves a legitimate tenant', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
        const { status } = await call();
        expect(status).toBe(200);
    });

    it('scopes the query to a CONCRETE business_id, never undefined', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
        await call();
        const where = mock.firstCall('document.findMany')?.args?.where;
        expect(where.business_id).toBe(TENANT);
        expect(typeof where.business_id).toBe('string');
        expect(Object.prototype.hasOwnProperty.call(where, 'business_id')).toBe(true);
        expect(where.customer_id).toBe(CUSTOMER);
    });

    it('still rejects a missing customerId with 400 and no query', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
        const { status } = await call('http://localhost/api/documents');
        expect(status).toBe(400);
        expect(mock.calls).toEqual([]);
    });

    it('guards on the businessId itself, not merely on the user', () => {
        const src = strip(read('app/api/documents/route.ts'));
        expect(src).toMatch(/if\s*\(!session\?\.user\?\.businessId\)/);
        expect(src).not.toMatch(/if\s*\(!session\?\.user\)\s*return/);
    });
});

describe('F. GET /api/documents/templates', () => {
    const call = async () => {
        const { GET } = await import('@/app/api/documents/templates/route');
        const res = await GET(new Request('http://localhost/api/documents/templates') as any);
        return { status: res.status, body: await res.json() };
    };

    beforeEach(() => {
        jest.clearAllMocks();
        useMock(createPrismaMock({ results: { 'documentTemplate.findMany': [{ id: 't1', name: 'Tenant template', business_id: TENANT }] } }));
    });

    it.each(NO_TENANT)('refuses %s with 401', async (_label, session) => {
        mockAuth.mockResolvedValue(session);
        const { status, body } = await call();
        expect(status).toBe(401);
        expect(body.error).toBe('Unauthorized');
    });

    it.each(NO_TENANT)('reaches ZERO database calls for %s', async (_label, session) => {
        mockAuth.mockResolvedValue(session);
        await call();
        expect(mock.calls).toEqual([]);
    });

    it('still serves a legitimate tenant', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
        const { status } = await call();
        expect(status).toBe(200);
    });

    it('scopes the OR branch to a CONCRETE business_id, so it cannot collapse to {}', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
        await call();
        const where = mock.firstCall('documentTemplate.findMany')?.args?.where;
        const tenantBranch = where.OR.find((b: any) => 'business_id' in b);
        expect(tenantBranch.business_id).toBe(TENANT);
        expect(typeof tenantBranch.business_id).toBe('string');
        // The global branch is the only unscoped one, and it is explicit about why.
        expect(where.OR.find((b: any) => 'isGlobal' in b).isGlobal).toBe(true);
    });

    it('guards on the businessId itself, not merely on the user', () => {
        const src = strip(read('app/api/documents/templates/route.ts'));
        expect(src).toMatch(/if\s*\(!session\?\.user\?\.businessId\)/);
        expect(src).not.toMatch(/if\s*\(!session\?\.user\)\s*return/);
    });
});
