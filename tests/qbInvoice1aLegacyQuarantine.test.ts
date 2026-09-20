/**
 * QB-INVOICE-1A — the legacy QuickBooks integration is quarantined (Parts 4–6).
 *
 * What was retired, and why each check exists:
 *
 *   - lib/ingestion/qbo_poller.ts turned the 50 newest QuickBooks invoices —
 *     paid or not ("DEMO MODE") — into production_ready kitchen Orders on every
 *     Sync Orders click. That violates HARD RULE 1 of the Fundraiser Fulfillment
 *     Contract, and would have re-imported FreezerIQ's own future QuickBooks
 *     invoices as kitchen work.
 *   - /api/auth/qbo (+ /callback): fixed state 'intuit-test', hardcoded localhost
 *     callback, code exchanged before auth, realmId from the query, plaintext
 *     tokens. Retired to 410 — NOT deleted, because app/api/auth/[...nextauth]
 *     would otherwise answer those paths.
 *   - /api/integrations/auth/qbo/{login,callback}, /api/integrations/sync/qbo and
 *     lib/qbo.ts: dead duplicates. Deleted; no catch-all covers those paths.
 *   - intuit-oauth and node-quickbooks (which pinned request@2.88.0): removed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();
const R = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** A code-only view: comments removed so documentation cannot satisfy or fail a check. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) out.push(relative(ROOT, p).replace(/\\/g, '/'));
    }
    return out;
}

const SOURCE = ['app', 'lib', 'components', 'types'].flatMap((d) => walk(join(ROOT, d)));

// ── Doubles for the executed handlers ──────────────────────────────────────
const prismaTouches: string[] = [];
const deleteMany = jest.fn(async () => ({ count: 1 }));
const findMany = jest.fn(async () => [
    { provider: 'square' }, { provider: 'qbo' }, { provider: 'quickbooks' }, { provider: 'quickbooks_oauth_attempt' }, { provider: 'stripe' },
]);
let prismaMode: 'throw' | 'integration' = 'throw';
jest.mock('@/lib/db', () => ({
    get prisma() {
        return new Proxy({}, {
            get(_t, prop) {
                prismaTouches.push(String(prop));
                if (prismaMode === 'integration' && prop === 'integration') return { deleteMany, findMany };
                if (prismaMode === 'integration' && prop === 'storefrontConfig') return { updateMany: jest.fn() };
                throw new Error(`CONTAINMENT BREACH: touched prisma.${String(prop)}`);
            },
        });
    },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const squareSync = jest.fn(async () => undefined);
const squareCtor = jest.fn();
jest.mock('@/lib/ingestion/square_handler', () => ({
    SquareOrderHandler: class {
        constructor(...args: any[]) { squareCtor(...args); }
        syncOrders() { return squareSync(); }
    },
}));
jest.mock('@/lib/ingestion_db', () => ({ IngestionDBAdapter: class { constructor(public businessId: string) {} } }));

const fetchCalls: string[] = [];
const ORIGINAL_FETCH = global.fetch;
beforeEach(() => {
    prismaTouches.length = 0;
    prismaMode = 'throw';
    mockAuth.mockReset();
    squareSync.mockClear();
    squareCtor.mockClear();
    deleteMany.mockClear();
    fetchCalls.length = 0;
    (global as any).fetch = async (url: string) => {
        fetchCalls.push(String(url));
        throw new Error(`unexpected network call to ${url}`);
    };
});
afterAll(() => { (global as any).fetch = ORIGINAL_FETCH; });

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · Sync Orders no longer touches QuickBooks (Part 4)', () => {
    it('POST runs Square only, calls no Intuit endpoint, and reports no QuickBooks step', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: 'biz-1' } });
        const { POST } = await import('@/app/api/sync/orders/route');
        const res = await POST();
        const body = await res.json();

        expect(squareCtor).toHaveBeenCalledTimes(1);
        expect(squareCtor.mock.calls[0][1]).toBe('biz-1');
        expect(squareSync).toHaveBeenCalledTimes(1);
        expect(body).toEqual({ success: true, results: { square: 'success', errors: [] } });
        expect(JSON.stringify(body)).not.toMatch(/qbo|quickbooks/i);
        expect(fetchCalls.filter((u) => /intuit/i.test(u))).toEqual([]);
    });

    it('a Square failure is still reported exactly as before', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: 'biz-1' } });
        squareSync.mockRejectedValueOnce(new Error('token expired'));
        const { POST } = await import('@/app/api/sync/orders/route');
        const body = await (await POST()).json();
        expect(body).toEqual({ success: false, results: { square: 'failed', errors: ['Square: token expired'] } });
    });

    it('still refuses an unauthenticated caller', async () => {
        mockAuth.mockResolvedValue(null);
        const { POST } = await import('@/app/api/sync/orders/route');
        expect((await POST()).status).toBe(401);
        expect(squareSync).not.toHaveBeenCalled();
    });

    it('the route source imports no QuickBooks code', () => {
        const code = strip(R('app/api/sync/orders/route.ts'));
        expect(code).not.toMatch(/qbo|quickbooks|intuit/i);
    });

    it('the Sync buttons no longer mention QuickBooks', () => {
        expect(strip(R('components/SyncOrdersButton.tsx'))).not.toMatch(/quickbooks/i);
    });

    it('no scheduled job runs a sync (no vercel.json crons, no cron route)', () => {
        const crons = existsSync(join(ROOT, 'vercel.json')) ? (JSON.parse(R('vercel.json')).crons ?? []) : [];
        expect(crons).toEqual([]);
        expect(existsSync(join(ROOT, 'app/api/cron'))).toBe(false);
    });
});

describe('QB-INVOICE-1A · no QuickBooks invoice can become a FreezerIQ Order', () => {
    it('the importer and its client are gone', () => {
        for (const p of ['lib/ingestion/qbo_poller.ts', 'lib/ingestion/clients/qbo_client.ts', 'lib/qbo.ts']) {
            expect(existsSync(join(ROOT, p))).toBe(false);
        }
    });

    it('no source file writes an Order with source "qbo" or a QBO- external id', () => {
        const offenders = SOURCE.filter((f) => {
            const code = strip(R(f));
            return /source\s*:\s*['"]qbo['"]/.test(code) || /['"`]QBO-/.test(code) || /\bQBOPoller\b|\bfindInvoices\b|\bQBOWrapper\b/.test(code);
        });
        expect(offenders).toEqual([]);
    });

    it('the new connector cannot write orders, customers, invoices or campaigns — and never touches a QuickBooks invoice or payment', () => {
        // QB-INVOICE-1B narrowed this from "no access at all": customer mapping READS the
        // organization (id and name) and the invoice-link foundation READS an invoice's
        // id for ownership. Writing any of these FreezerIQ records stays forbidden.
        // QB-INVOICE-1C narrowed it once more, exactly (owner brief "QuickBooks Invoice Create +
        // Verify + Send"): "Send via QuickBooks" READS the invoice it sends and makes ONE write —
        // status DRAFT → SENT, conditional on DRAFT, inside the verified lifecycle transaction —
        // and ONLY the Intuit client builds QuickBooks invoice requests. Payments, bills,
        // estimates, sales receipts, credit memos and refund receipts stay untouched everywhere.
        const connector = SOURCE.filter((p) => p.startsWith('lib/quickbooks/') || p.startsWith('app/api/integrations/quickbooks/'));
        const reads: string[] = [];
        for (const f of connector) {
            const code = strip(R(f));
            const writes = [...code.matchAll(/\.(order|orderItem|customer|invoice|invoiceItem|fundraiserCampaign)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g)].map((m) => `${m[1]}.${m[2]}`);
            const qboMoney = /\/v3\/company\/[^'"`]*\/(payment|bill|estimate|salesreceipt|creditmemo|refundreceipt)/i.test(code)
                || /['"`]\/(payment|bill|estimate|salesreceipt|creditmemo|refundreceipt)\b/i.test(code);
            const qboInvoice = /\/v3\/company\/[^'"`]*\/invoice/i.test(code) || /['"`]\/invoice\b/i.test(code);
            expect({ f, writes, qboMoney, qboInvoice }).toEqual({
                f,
                writes: f === 'lib/quickbooks/invoiceSend.ts' ? ['invoice.updateMany'] : [],
                qboMoney: false,
                qboInvoice: f === 'lib/quickbooks/intuitClient.ts',
            });
            for (const m of code.matchAll(/\.(order|orderItem|customer|invoice|invoiceItem|fundraiserCampaign)\s*\.\s*(\w+)/g)) reads.push(`${f}: ${m[1]}.${m[2]}`);
        }
        expect(reads.sort()).toEqual([
            'lib/quickbooks/customerLinks.ts: customer.findFirst',
            'lib/quickbooks/invoiceLinks.ts: invoice.findFirst',
            'lib/quickbooks/invoiceSend.ts: invoice.findFirst',
            'lib/quickbooks/invoiceSend.ts: invoice.findFirst',
            'lib/quickbooks/invoiceSend.ts: invoice.findFirst',
            'lib/quickbooks/invoiceSend.ts: invoice.updateMany',
        ]);
        // The one write, exactly: DRAFT → SENT, and nothing else on the row.
        expect(strip(R('lib/quickbooks/invoiceSend.ts'))).toMatch(/tx\.invoice\.updateMany\(\{\s*where: \{ id: s\.invoiceId, business_id: s\.businessId, status: 'DRAFT' \},\s*data: \{ status: 'SENT' \},\s*\}\)/);
    });

    it('the Accounting API surface is exactly CompanyInfo + Customer query/read/create (QB-INVOICE-1B) + the QB-INVOICE-1C invoice and setup calls', () => {
        const client = strip(R('lib/quickbooks/intuitClient.ts'));
        const paths = client.match(/\/v3\/company\/[^`'"]+/g) ?? [];
        expect(paths).toEqual([
            '/v3/company/${realm}/companyinfo/${realm}?minorversion=${QUICKBOOKS_MINOR_VERSION}',
            '/v3/company/${encodeURIComponent(realmId)}${pathAndQuery}',
        ]);
        // Every path handed to the shared Accounting request builders (1B accountingRequest, 1C accountingJson):
        const entityPaths = [...client.matchAll(/(?:accountingRequest|accountingJson)\(config, accessToken, realmId,\s*`([^`]+)`/g)].map((m) => m[1].split('?')[0]);
        expect(entityPaths.sort()).toEqual([
            '/${entityPath}/${id}', '/customer', '/customer/${customerId}', '/invoice', '/invoice', '/invoice/${qboInvoiceId}/send', '/item', '/preferences', '/query', '/query',
        ].sort());
        // By-id reads: the three setup objects, and an invoice (by the id FreezerIQ's own create returned).
        expect([...client.matchAll(/readEntity\(config, accessToken, realmId, '(\w+)'/g)].map((m) => m[1]).sort()).toEqual(['account', 'invoice', 'item', 'term']);
        // The only queries: customers by name (1B) and the three setup lists (1C) — never an invoice or payment search.
        expect(client.match(/select \* from (\w+)/g)).toEqual(['select * from Customer', 'select * from Account', 'select * from Item', 'select * from Term']);
        // token, revoke, customer create (1B); item create, invoice create, invoice update, invoice send (1C)
        expect(client.match(/method:\s*'(POST|PUT|PATCH|DELETE)'/g)).toEqual(Array(7).fill("method: 'POST'"));
        expect(client).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/);
        // The one sparse update is the recipients-and-payment-options update; nothing is ever voided or deleted.
        expect(client.match(/sparse/g)).toEqual(['sparse']);
        expect(client).not.toMatch(/operation=(update|delete)|\/void\b|\/delete\b/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · legacy routes are quarantined deliberately (Part 5)', () => {
    it.each([
        'app/api/auth/qbo/route.ts',
        'app/api/auth/qbo/callback/route.ts',
    ])('%s answers 410, reads nothing, touches nothing', async (file) => {
        const mod = await import(`@/${file.replace(/\.ts$/, '')}`);
        expect(Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(['GET']);
        expect(mod.GET.length).toBe(0); // no request parameter to read
        const res = await mod.GET();
        expect(res.status).toBe(410);
        expect(res.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
        expect(await res.json()).toEqual({ error: 'This endpoint is no longer available.' });
        expect(prismaTouches).toEqual([]);
        expect(mockAuth).not.toHaveBeenCalled();
        expect(fetchCalls).toEqual([]);
        expect(strip(R(file))).not.toMatch(/intuit-oauth|OAuthClient|TokenManager|auth\(|prisma|searchParams|realmId/);
    });

    it('the /api/auth/qbo paths stay owned by their own files, so the NextAuth catch-all cannot serve them', () => {
        expect(existsSync(join(ROOT, 'app/api/auth/[...nextauth]/route.ts'))).toBe(true);
        expect(existsSync(join(ROOT, 'app/api/auth/qbo/route.ts'))).toBe(true);
        expect(existsSync(join(ROOT, 'app/api/auth/qbo/callback/route.ts'))).toBe(true);
    });

    it('the deleted duplicates are gone, and no catch-all segment could answer their paths instead', () => {
        for (const p of [
            'app/api/integrations/auth/qbo/login/route.ts',
            'app/api/integrations/auth/qbo/callback/route.ts',
            'app/api/integrations/sync/qbo/route.ts',
        ]) {
            expect(existsSync(join(ROOT, p))).toBe(false);
        }
        // Any [...x] or [[...x]] directory on the way to those paths would capture them.
        const catchAll = (dir: string): string[] => {
            if (!existsSync(join(ROOT, dir))) return [];
            return readdirSync(join(ROOT, dir)).filter((n) => /^\[\[?\.\.\./.test(n)).map((n) => `${dir}/${n}`);
        };
        expect([...catchAll('app/api'), ...catchAll('app/api/integrations'), ...catchAll('app/api/integrations/auth'), ...catchAll('app/api/integrations/sync')]).toEqual([]);
        expect(existsSync(join(ROOT, 'app/[...slug]'))).toBe(false);
    });

    it('the Settings page no longer links to a retired route or reads a "qbo" status', () => {
        const page = strip(R('app/settings/page.tsx'));
        expect(page).not.toMatch(/\/api\/auth\/qbo|integrationStatus\.qbo|'qbo'/);
        expect(page).toContain('QuickBooksConnectionCard');
        expect(page).toMatch(/session\?\.user\?\.role === 'ADMIN'[\s\S]{0,120}QuickBooksConnectionCard/);
    });

    it('the only QuickBooks connect link anywhere is the new ADMIN-gated route', () => {
        const links = SOURCE.flatMap((f) => (strip(R(f)).match(/['"`]\/api\/[^'"`]*(qbo|quickbooks)[^'"`]*['"`]/gi) ?? []).map((m) => `${f}: ${m}`));
        // QB-INVOICE-1B adds the ADMIN-gated organization mapping route (customers), not a connect link.
        // QB-INVOICE-1C adds the ADMIN-gated invoice settings and "Send via QuickBooks" routes.
        expect(links.filter((l) => !/\/api\/integrations\/quickbooks\/(connect|callback|disconnect|status|customers|invoice-settings|invoices)/.test(l))).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · shared integration surfaces cannot reach the new provider', () => {
    it('the generic disconnect route refuses "qbo", "quickbooks" and the attempt key (which would skip revocation)', async () => {
        prismaMode = 'integration';
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: 'biz-1' } });
        const { POST } = await import('@/app/api/integrations/disconnect/route');
        for (const provider of ['qbo', 'quickbooks', 'QuickBooks', 'quickbooks_oauth_attempt']) {
            const res = await POST(new Request('http://x/api/integrations/disconnect', { method: 'POST', body: JSON.stringify({ provider }) }));
            expect(res.status).toBe(400);
        }
        expect(deleteMany).not.toHaveBeenCalled();
        // Square/Meta/Stripe still work exactly as before.
        const ok = await POST(new Request('http://x/api/integrations/disconnect', { method: 'POST', body: JSON.stringify({ provider: 'square' }) }));
        expect(ok.status).toBe(200);
        expect(deleteMany).toHaveBeenCalledWith({ where: { provider: 'square', business_id: 'biz-1' } });
    });

    it('the generic status route exposes no "qbo", "quickbooks" or attempt flag', async () => {
        prismaMode = 'integration';
        mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: 'biz-1' } });
        const { GET } = await import('@/app/api/integrations/status/route');
        const body = await (await GET()).json();
        expect(body).toEqual({ square: true, meta: false, instagram: false, stripe: true });
    });

    it('TokenManager (plaintext storage) can no longer be constructed for QuickBooks', () => {
        const src = strip(R('lib/auth/token_manager.ts'));
        expect(src).toMatch(/constructor\(provider: 'square' \| 'meta' \| 'instagram'/);
        expect(src).not.toMatch(/'qbo'|'quickbooks'/);
    });

    it('no source file references the legacy provider key "qbo" as an integration provider', () => {
        const offenders = SOURCE.filter((f) => /provider\s*[:=]{1,3}\s*['"]qbo['"]|new TokenManager\(\s*['"]qbo['"]/.test(strip(R(f))));
        expect(offenders).toEqual([]);
    });
});

describe('QB-INVOICE-1A · dependency cleanup (Part 6)', () => {
    const pkg = JSON.parse(R('package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    it('intuit-oauth and node-quickbooks are no longer dependencies, and nothing imports them', () => {
        expect(deps['intuit-oauth']).toBeUndefined();
        expect(deps['node-quickbooks']).toBeUndefined();
        const importers = SOURCE.filter((f) => /['"](intuit-oauth|node-quickbooks|request)['"]/.test(strip(R(f))));
        expect(importers).toEqual([]);
        for (const p of ['types/intuit-oauth.d.ts', 'types/node-quickbooks.d.ts', 'simulate_qbo.bat', 'test_qbo_import.js']) {
            expect(existsSync(join(ROOT, p))).toBe(false);
        }
    });

    it('the lockfile no longer carries them or request@2.88.0', () => {
        const lock = JSON.parse(R('package-lock.json'));
        for (const k of ['node_modules/intuit-oauth', 'node_modules/node-quickbooks', 'node_modules/request']) {
            expect(lock.packages[k]).toBeUndefined();
        }
    });

    it('date-fns — previously present only as a node-quickbooks transitive — is now declared, because the app imports it', () => {
        const importers = SOURCE.filter((f) => /from\s+['"]date-fns['"]/.test(R(f)));
        expect(importers.length).toBeGreaterThan(0);
        expect(pkg.dependencies['date-fns']).toBeDefined();
        const lock = JSON.parse(R('package-lock.json'));
        expect(lock.packages['node_modules/date-fns'].version).toBe('2.30.0');
    });

    it('the QuickBooks QBO types that only the importer used are gone; Square types remain', () => {
        const types = strip(R('types/integrations.ts'));
        expect(types).not.toMatch(/QBO/);
        expect(types).toMatch(/interface SquareOrderPayload/);
        expect(strip(R('lib/mock_data.ts'))).not.toMatch(/QBO/);
    });
});
