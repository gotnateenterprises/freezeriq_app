/**
 * WAVES-CLOSEOUT-1A — the legacy bundle-wide status route is retired, and stays uncalled.
 *
 * AUDIT: WAVES-CLOSEOUT-1. After PREP-WAVES-1 nothing in the application called
 * POST /api/orders/batch-update-by-bundle, but the route was still deployed and an authenticated
 * request could still advance every order that matched
 *
 *     business_id + currentStatus + (any line holding bundleId)
 *
 * — every fundraiser that shared the meal, plus ordinary orders, as whole orders. The existing tests
 * proved PrepList no longer called it; none stopped a future caller anywhere else.
 *
 * WHAT THIS SUITE PINS
 *   1. Anonymous callers still get 401 — and nothing is read, written or parsed.
 *   2. An authenticated caller gets 410 LEGACY_BATCH_ROUTE_DISABLED — and nothing is read, written or
 *      parsed, whatever the body says (the old payload, a ready_to_ship attempt, garbage, nothing).
 *   3. NO executable application code may reference the route (a repository-wide scan).
 *   4. The removed orphan component stays removed, and two corrected claims stay corrected.
 *
 * The route file is deliberately NOT deleted: a stale browser tab or an unknown caller should get an
 * explicit 410, not a route that vanished.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

// ── doubles: any touch of the database, or of the request body, is recorded ──────────────────
jest.mock('@/auth', () => ({ auth: jest.fn() }));

const mockDbTouches: string[] = [];
jest.mock('@/lib/db', () => {
    const touch = (path: string): any => new Proxy(function () { /* callable */ }, {
        get: (_target, prop) => {
            if (prop === 'then') return undefined;
            const next = `${path}.${String(prop)}`;
            mockDbTouches.push(next);
            return touch(next);
        },
        apply: () => {
            mockDbTouches.push(`${path}()`);
            return Promise.resolve([]);
        },
    });
    return { prisma: touch('prisma') };
});

import { auth } from '@/auth';
import { POST } from '@/app/api/orders/batch-update-by-bundle/route';

const mockAuth = auth as unknown as jest.Mock;
const ROOT = process.cwd();
const ROUTE_FILE = 'app/api/orders/batch-update-by-bundle/route.ts';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Comments off, so a test about code is not satisfied (or failed) by prose. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The handler takes no arguments on purpose; tests hand it a request anyway, to prove it is ignored. */
const call = (req?: unknown): Promise<Response> => (POST as unknown as (r?: unknown) => Promise<Response>)(req);

const TENANT_SESSION = { user: { id: 'u-1', businessId: 'biz-fixture' } };

/** The payload the retired route used to act on. */
const OLD_PAYLOAD = { bundleId: 'b-fixture', currentStatus: 'production_ready', newStatus: 'in_production' };

/** A request-shaped object whose every body accessor is a tripwire. */
function spyRequest() {
    const read: string[] = [];
    const trap = (name: string) => () => { read.push(name); throw new Error(`the request body must not be read (${name})`); };
    const req: any = {
        method: 'POST',
        url: 'http://localhost/api/orders/batch-update-by-bundle',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: trap('json'), text: trap('text'), formData: trap('formData'),
        arrayBuffer: trap('arrayBuffer'), blob: trap('blob'), clone: trap('clone'),
    };
    Object.defineProperty(req, 'body', { get() { read.push('body'); throw new Error('the request body must not be read (body)'); } });
    return { req, read };
}

const realRequest = (body: BodyInit | undefined) =>
    new Request('http://localhost/api/orders/batch-update-by-bundle', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

beforeEach(() => {
    jest.clearAllMocks();
    mockDbTouches.length = 0;
    mockAuth.mockReset();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. UNAUTHENTICATED
// ═════════════════════════════════════════════════════════════════════════════
describe('1. an unauthenticated request is still refused, and nothing happens', () => {
    it.each([
        ['no session', null],
        ['a session with no user', {}],
        ['a user with no tenant', { user: { id: 'u-1' } }],
        ['a user with an empty tenant', { user: { id: 'u-1', businessId: '' } }],
    ])('1a. %s -> 401, no database access, no body read', async (_label, session) => {
        mockAuth.mockResolvedValue(session);
        const req = realRequest(JSON.stringify(OLD_PAYLOAD));
        const res = await call(req);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'Unauthorized' });
        expect(mockDbTouches).toEqual([]);
        expect(req.bodyUsed).toBe(false);
    });

    it('1b. the route authenticates before it does anything else (it asks for the session exactly once)', async () => {
        mockAuth.mockResolvedValue(null);
        await call(realRequest(JSON.stringify(OLD_PAYLOAD)));
        expect(mockAuth).toHaveBeenCalledTimes(1);
    });

    it('1c. the 401 never reveals the retirement (an anonymous caller learns nothing about the route)', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await call(realRequest(JSON.stringify(OLD_PAYLOAD)));
        expect(JSON.stringify(await res.json())).not.toMatch(/LEGACY|410|retired|no longer/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. AUTHENTICATED
// ═════════════════════════════════════════════════════════════════════════════
describe('2. an authenticated request is refused with 410, whatever it says', () => {
    beforeEach(() => mockAuth.mockResolvedValue(TENANT_SESSION));

    it('2a. a valid tenant session gets 410 with a stable machine-readable code', async () => {
        const res = await call(realRequest(JSON.stringify(OLD_PAYLOAD)));
        expect(res.status).toBe(410);
        expect(await res.json()).toEqual({
            error: 'This legacy kitchen batch route is no longer supported',
            code: 'LEGACY_BATCH_ROUTE_DISABLED',
        });
        expect(mockDbTouches).toEqual([]);
    });

    it('2b. the full old payload (production_ready -> in_production): 410, zero reads, zero writes, body never consumed', async () => {
        const req = realRequest(JSON.stringify(OLD_PAYLOAD));
        const res = await call(req);
        expect(res.status).toBe(410);
        expect(mockDbTouches).toEqual([]);
        expect(req.bodyUsed).toBe(false);
    });

    it('2c. the ready_to_ship attempt (in_production -> ready_to_ship): the same', async () => {
        const req = realRequest(JSON.stringify({ bundleId: 'b-fixture', currentStatus: 'in_production', newStatus: 'ready_to_ship' }));
        const res = await call(req);
        expect(res.status).toBe(410);
        expect((await res.json()).code).toBe('LEGACY_BATCH_ROUTE_DISABLED');
        expect(mockDbTouches).toEqual([]);
        expect(req.bodyUsed).toBe(false);
    });

    it.each([
        ['invalid JSON', '{not json'],
        ['an empty body', ''],
        ['no body at all', undefined],
        ['a JSON array', '[1, 2, 3]'],
        ['JSON null', 'null'],
        ['an unrelated object', JSON.stringify({ hello: 'world' })],
        ['exact order ids (the shape of the live route)', JSON.stringify({ orderIds: ['o-1'], status: 'in_production' })],
        ['an alias target the old route refused', JSON.stringify({ ...OLD_PAYLOAD, newStatus: 'READY_TO_SHIP' })],
        ['a held order status', JSON.stringify({ ...OLD_PAYLOAD, currentStatus: 'fundraiser_hold' })],
    ])('2d. %s -> still 410, without needing the old payload', async (_label, body) => {
        const req = realRequest(body as BodyInit | undefined);
        const res = await call(req);
        expect(res.status).toBe(410);
        expect((await res.json()).code).toBe('LEGACY_BATCH_ROUTE_DISABLED');
        expect(mockDbTouches).toEqual([]);
        expect(req.bodyUsed).toBe(false);
    });

    it('2e. no body accessor of the request is ever touched — the payload is not parsed or acted on', async () => {
        const { req, read: touched } = spyRequest();
        const res = await call(req);
        expect(res.status).toBe(410);
        expect(touched).toEqual([]);
        expect(mockDbTouches).toEqual([]);
    });

    it('2f. the handler needs no request at all', async () => {
        const res = await call();
        expect(res.status).toBe(410);
    });

    it('2g. it is not a redirect and does not translate the request into another route', async () => {
        const res = await call(realRequest(JSON.stringify(OLD_PAYLOAD)));
        expect([301, 302, 303, 307, 308]).not.toContain(res.status);
        expect(res.headers.get('location')).toBeNull();
        expect(res.redirected).toBe(false);
        expect(mockDbTouches).toEqual([]);
    });

    it('2h. a session is all it takes to learn the route is retired, and a second call gives the same answer', async () => {
        const a = await call(realRequest(JSON.stringify(OLD_PAYLOAD)));
        const b = await call(realRequest(JSON.stringify(OLD_PAYLOAD)));
        expect([a.status, b.status]).toEqual([410, 410]);
        expect(mockDbTouches).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2z. THE FILE ITSELF
// ═════════════════════════════════════════════════════════════════════════════
describe('2z. the route file cannot reach an order even by accident', () => {
    const src = strip(read(ROUTE_FILE));

    it('imports exactly next/server and the session helper — no Prisma, no db module, no status helpers', () => {
        const imports = [...src.matchAll(/(?:^|\n)\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
        expect(imports).toEqual(['@/auth', 'next/server']);
        expect(src).not.toMatch(/\brequire\(|\bimport\(/);
        expect(src).not.toMatch(/prisma|@\/lib\/db|orderStatus/i);
    });

    it('contains no query, write, transaction or raw-SQL call, and the handler is not even given the request', () => {
        expect(src).not.toMatch(/\.(findMany|findFirst|findUnique|count|update|updateMany|create|createMany|upsert|delete|deleteMany|groupBy|aggregate|\$transaction|\$queryRaw|\$executeRaw)\b/);
        // No parameter, so there is no body to parse; and none of the old payload's names is mentioned.
        expect(src).toMatch(/export\s+async\s+function\s+POST\s*\(\s*\)/);
        expect(src).not.toMatch(/\b(req|request)\b/);
        expect(src).not.toMatch(/bundleId|currentStatus|newStatus|bundle_id/);
    });

    it('exports POST only (every other verb is the framework\'s 405)', () => {
        const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+(\w+)/g)].map((m) => m[1]);
        expect(exported).toEqual(['POST']);
    });

    it('the route is still present: guarded, not deleted', () => {
        expect(existsSync(join(ROOT, ROUTE_FILE))).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE REPOSITORY-WIDE NO-CALLER TRIPWIRE
//    Invariant: NO executable FreezerIQ code may call the legacy bundle-wide status endpoint.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Whether a text names the retired route's segment. Resistant to formatting:
 *   quotes of any kind, template literals, "a" + "b" splits (also across lines), spacing,
 *   case, and kebab / snake / camel spellings — `batch-update-by-bundle`, `batch_update_by_bundle`,
 *   `batchUpdateByBundle`, `BATCH-UPDATE-BY-BUNDLE`.
 * It matches the SEGMENT, not the whole path, so `/api/orders/${segment}` and
 * `['api','orders','batch-update-by-bundle'].join('/')` are caught as well.
 */
function mentionsLegacyBatchRoute(text: string): boolean {
    const squeezed = text.toLowerCase().replace(/['"`+\s\\]/g, '');
    return /batch[-_]?update[-_]?by[-_]?bundle/.test(squeezed);
}

/** Directories never scanned at the TOP level: tests (which describe the route on purpose) and documentation. */
const TOP_LEVEL_EXCLUDED = new Set(['tests', 'docs', 'coverage', '.vercel', '.claude']);
/** Directories never scanned at any depth. */
const ANY_DEPTH_EXCLUDED = new Set(['node_modules', '.next', '.git']);
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.yml', '.yaml', '.sh', '.ps1', '.bat']);
const SKIPPED_FILES = new Set(['package-lock.json']);
/** The ONE file allowed to name the route: its own definition. */
const EXEMPT_FILES = [ROUTE_FILE];

function extensionOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function collectExecutableFiles(dir = ROOT, depth = 0): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = relative(ROOT, full).split(sep).join('/');
        let info;
        try { info = statSync(full); } catch { continue; }
        if (info.isDirectory()) {
            if (ANY_DEPTH_EXCLUDED.has(name)) continue;
            if (depth === 0 && TOP_LEVEL_EXCLUDED.has(name)) continue;
            out.push(...collectExecutableFiles(full, depth + 1));
        } else if (info.isFile()) {
            if (SKIPPED_FILES.has(name)) continue;
            if (!SCANNED_EXTENSIONS.has(extensionOf(name))) continue;
            out.push(rel);
        }
    }
    return out;
}

describe('3. no executable application code references the legacy bundle-wide route', () => {
    const files = collectExecutableFiles();

    it('3a. nothing outside the route\'s own definition names it (app, components, lib and everything else executable)', () => {
        const offenders = files
            .filter((f) => !EXEMPT_FILES.includes(f))
            .filter((f) => {
                try { return mentionsLegacyBatchRoute(readFileSync(join(ROOT, f), 'utf8')); } catch { return false; }
            });
        expect(offenders).toEqual([]);
    });

    it('3b. the scan really covers the application (so a silent empty scan cannot pass)', () => {
        expect(files.length).toBeGreaterThan(400);
        for (const must of [
            'components/production/PrepList.tsx',
            'components/production/PrepWavePanel.tsx',
            'components/production/DeliveryQueue.tsx',
            'lib/prepWaves.ts',
            'lib/packedReadyWaves.ts',
            'app/api/orders/bulk-status/route.ts',
            'app/api/orders/route.ts',
            'app/production/page.tsx',
            'middleware.ts',
            'next.config.js',
            'package.json',
        ]) expect(files).toContain(must);
        for (const top of ['app', 'components', 'lib']) expect(files.some((f) => f.startsWith(`${top}/`))).toBe(true);
    });

    it('3c. the exemptions are exactly the route\'s own file, and tests / docs are the only skipped trees', () => {
        expect(EXEMPT_FILES).toEqual([ROUTE_FILE]);
        expect(files).toContain(ROUTE_FILE);                       // it is scanned, then exempted — not invisible
        expect([...TOP_LEVEL_EXCLUDED].sort()).toEqual(['.claude', '.vercel', 'coverage', 'docs', 'tests']);
        expect([...ANY_DEPTH_EXCLUDED].sort()).toEqual(['.git', '.next', 'node_modules']);
        // A new top-level source directory is scanned automatically, because the scan starts at the root.
        const top = readdirSync(ROOT).filter((n) => { try { return statSync(join(ROOT, n)).isDirectory(); } catch { return false; } });
        for (const dir of top) {
            if (TOP_LEVEL_EXCLUDED.has(dir) || ANY_DEPTH_EXCLUDED.has(dir)) continue;
            // (a directory with no scannable file may legitimately contribute none)
            const hasScannable = collectExecutableFiles(join(ROOT, dir), 1).length > 0;
            if (hasScannable) expect(files.some((f) => f.startsWith(`${dir}/`))).toBe(true);
        }
    });

    it('3d. the only live caller of the exact-id route and of nothing else is the Prep UI', () => {
        // The positive half of the story: the Prep UI reaches the status route that takes ORDER IDS.
        expect(strip(read('components/production/PrepList.tsx'))).toMatch(/'\/api\/orders\/bulk-status'/);
        expect(mentionsLegacyBatchRoute(read('components/production/PrepList.tsx'))).toBe(false);
    });

    describe('the matcher itself (a tripwire that cannot bite is worse than none)', () => {
        it.each([
            ["fetch('/api/orders/batch-update-by-bundle', { method: 'POST' })"],
            ['fetch("/api/orders/batch-update-by-bundle")'],
            ['fetch(`/api/orders/batch-update-by-bundle`)'],
            ['fetch( "/api/orders/batch-update-by-bundle" , { method : "POST" } )'],
            ["const url = `/api/orders/${'batch-update-by-bundle'}`;"],
            ["const seg = 'batch-update-by-bundle'; fetch(`/api/orders/${seg}`)"],
            ["fetch('/api/orders/' + 'batch-update-' + 'by-bundle')"],
            ["fetch('/api/orders/batch-update-' +\n    'by-bundle')"],
            ["fetch('/api/orders/batch-update-\\\n by-bundle')"],
            ["['api', 'orders', 'batch-update-by-bundle'].join('/')"],
            ["new URL('/api/orders/batch-update-by-bundle?x=1', origin)"],
            ["fetch('/API/ORDERS/BATCH-UPDATE-BY-BUNDLE')"],
            ['const path = "/api/orders/batch_update_by_bundle";'],
            ['await batchUpdateByBundle({ bundleId, currentStatus, newStatus });'],
            ['import { BatchUpdateByBundle } from "./x";'],
            ['{ "crons": [{ "path": "/api/orders/batch-update-by-bundle", "schedule": "0 * * * *" }] }'],
            ['curl -X POST https://example.test/api/orders/batch-update-by-bundle'],
        ])('3e. flags: %s', (text) => {
            expect(mentionsLegacyBatchRoute(text)).toBe(true);
        });

        it.each([
            ["fetch('/api/orders/bulk-status', { method: 'POST' })"],
            ["fetch('/api/orders/batch-status')"],
            ["fetch('/api/orders')"],
            ['const batchUpdate = () => {}; const byBundle = 1;'],
            ['batchUpdate(byBundle)'],
            ['a bundle update in a batch, by hand'],
            [''],
        ])('3f. does not flag: %s', (text) => {
            expect(mentionsLegacyBatchRoute(text)).toBe(false);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. CLEANUP THAT MUST STAY DONE
// ═════════════════════════════════════════════════════════════════════════════
describe('4. the removed orphan stays removed, and two corrected claims stay corrected', () => {
    it('4a. InProductionArea.tsx is gone and nothing imports it', () => {
        expect(existsSync(join(ROOT, 'components/production/InProductionArea.tsx'))).toBe(false);
        const offenders = collectExecutableFiles().filter((f) => {
            const text = readFileSync(join(ROOT, f), 'utf8');
            return /from\s+['"][^'"]*InProductionArea['"]|require\(\s*['"][^'"]*InProductionArea['"]|import\(\s*['"][^'"]*InProductionArea['"]/.test(text);
        });
        expect(offenders).toEqual([]);
    });

    it('4b. the closeout route header no longer claims closeout releases held orders (OPS-3 moved release to invoice settlement)', () => {
        const header = read('app/api/campaigns/[id]/closeout/route.ts').split('\n').slice(0, 60).join('\n');
        expect(header).not.toMatch(/Batch-promotes fundraiser_hold orders/i);
        expect(header).not.toMatch(/releases held orders/i);
        expect(header).toMatch(/does NOT release/i);
    });

    it('4c. the handoff documentation no longer tells a developer to preserve or reuse the bundle-wide route', () => {
        const doc = read('docs/ai/KITCHEN_DELIVERY_HANDOFF.md');
        expect(doc).not.toMatch(/PRESERVE and reuse verbatim:[^\n]*batch-update-by-bundle/);
        expect(doc).not.toMatch(/`onPacked` → existing `batch-update-by-bundle`/);
        expect(doc).toMatch(/\/api\/orders\/bulk-status/);
        expect(doc).toMatch(/FundraiserCampaign\.id/);
    });
});
