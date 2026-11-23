/**
 * TWILIO-SMS-ROUTE-RETIRE-1 — the legacy SMS relay at /api/public/send-text is a fixed, inert 410.
 *
 * TWILIO-SMS-ROUTE-AUDIT-1 found it sent any message to any numbers from the platform's Twilio
 * number for any signed-in staff account, with no tenant scope, consent, suppression or STOP
 * handling, and no callers. These tests run the REAL route with `twilio` and `@/auth` replaced by
 * recorders, so any attempt to load Twilio, read a session or send anything is visible.
 * Fictional numbers only; the repository is public.
 */
import fs from 'fs';
import path from 'path';

jest.mock('twilio', () => {
    const g = global as any;
    g.__twilioModuleLoads = (g.__twilioModuleLoads ?? 0) + 1;
    const create = jest.fn(async () => ({ sid: 'SM_fixture_should_never_appear' }));
    g.__twilioCreate = create;
    const factory = jest.fn(() => ({ messages: { create } }));
    g.__twilioFactory = factory;
    return { __esModule: true, default: factory };
});
jest.mock('@/auth', () => ({
    auth: jest.fn(async () => (global as any).__srSession ?? null),
}));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const ROUTE_FILE = 'app/api/public/send-text/route.ts';
const RETIRED = { error: 'This SMS endpoint is no longer available.' };
const FAKE_SECRETS = { TWILIO_ACCOUNT_SID: 'ACfixture0000000000000000000000000', TWILIO_AUTH_TOKEN: 'fixture-auth-token-NOT-REAL-9f2c', TWILIO_PHONE_NUMBER: '+13095550199' };

const savedEnv: Record<string, string | undefined> = {};
const logs: string[] = [];
beforeAll(() => {
    for (const k of Object.keys(FAKE_SECRETS)) savedEnv[k] = process.env[k];
    // 7 · Twilio "configured": the route must still not come alive.
    Object.assign(process.env, FAKE_SECRETS);
    for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        jest.spyOn(console, k).mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
    }
});
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { logs.length = 0; (global as any).__srSession = null; });

async function call(method: 'POST' | 'GET', body?: string) {
    const route = await import('@/app/api/public/send-text/route');
    const req = new Request('https://www.freezeriqapp.com/api/public/send-text', {
        method, ...(body !== undefined ? { body, headers: { 'Content-Type': 'application/json' } } : {}),
    });
    const res = await (route as any)[method](req);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text), cache: res.headers.get('cache-control') };
}
const send = (to: unknown, message: unknown) => call('POST', JSON.stringify({ to, message }));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('every request gets the same fixed 410, and nothing is sent', () => {
    it('1 · signed out → 410 with the fixed message', async () => {
        const r = await send(['(309) 555-0101'], 'Hello from nobody');
        expect(r.status).toBe(410);
        expect(r.json).toEqual(RETIRED);
        expect(r.cache).toMatch(/no-store/);
    });

    it('2 · 5 · signed in, as any tenant (or the platform admin) → exactly the same response', async () => {
        const baseline = await send(['(309) 555-0101'], 'Hi');
        for (const session of [
            { user: { id: 'user-a', businessId: 'biz-a', role: 'ADMIN' } },
            { user: { id: 'user-b', businessId: 'biz-b', role: 'CHEF' } },
            { user: { id: 'super', businessId: null, isSuperAdmin: true } },
        ]) {
            (global as any).__srSession = session;
            const r = await send(['(309) 555-0101'], 'Hi');
            expect([r.status, r.text]).toEqual([baseline.status, baseline.text]);
        }
        // The session is never even read: the route has no tenant-dependent branch at all.
        expect(require('@/auth').auth).not.toHaveBeenCalled();
    });

    it('3 · 4 · 8 · arbitrary or malformed destinations and arbitrary messages change nothing', async () => {
        const cases: Array<[unknown, unknown]> = [
            [['+44 20 7946 0958', '+1 309 555 0102'], 'Arbitrary international relay'],
            [Array.from({ length: 5000 }, (_, i) => `309555${String(i).padStart(4, '0')}`), 'x'.repeat(20000)],
            [['not-a-number', '', null, 42], 'malformed'],
            ['309-555-0103', { not: 'a string' }],
            [undefined, undefined],
        ];
        for (const [to, message] of cases) {
            const r = await send(to, message);
            expect([r.status, r.json]).toEqual([410, RETIRED]);
        }
        // Not even a body the route could parse is needed: the request body is never read.
        const raw = await call('POST', '{"to": [ this is not json');
        expect([raw.status, raw.json]).toEqual([410, RETIRED]);
        const empty = await call('POST');
        expect([empty.status, empty.json]).toEqual([410, RETIRED]);
    });

    it('GET → the same 410', async () => {
        const r = await call('GET');
        expect([r.status, r.json]).toEqual([410, RETIRED]);
    });

    it('6 · 7 · Twilio is never loaded, constructed or called — even with Twilio credentials present', async () => {
        for (let i = 0; i < 3; i++) await send(['3095550104'], 'try again');
        const g = global as any;
        expect(g.__twilioModuleLoads).toBeUndefined();
        expect(g.__twilioFactory).toBeUndefined();
        expect(g.__twilioCreate).toBeUndefined();
    });

    it('9 · no secret, Twilio error, account information or message id ever appears in a response', async () => {
        (global as any).__srSession = { user: { id: 'user-a', businessId: 'biz-a' } };
        const bodies = [
            (await send(['3095550105'], 'probe')).text,
            (await call('POST', 'garbage')).text,
            (await call('GET')).text,
        ].join('\n');
        for (const s of [...Object.values(FAKE_SECRETS), 'SM_fixture', 'twilio', 'Twilio', 'sid', 'AC', 'credential', 'configured', 'results', 'details']) {
            expect(bodies).not.toContain(s);
        }
    });

    it('10 · nothing is logged — so no phone number can reach the logs', async () => {
        await send(['(309) 555-0106', '+13095550107'], 'log me');
        await call('POST', 'garbage');
        expect(logs).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('the route reads nothing, and nothing calls it', () => {
    it('6 · the route source has no Twilio import, no env read, no body or session read, no logging', () => {
        const src = code(R(ROUTE_FILE));
        expect(src).not.toMatch(/twilio/i);
        expect(src).not.toMatch(/process\.env/);
        expect(src).not.toMatch(/\.json\(\s*\)|\.text\(\s*\)|formData\(/); // never reads the request
        expect(src).not.toMatch(/\bauth\(|@\/auth|@\/lib\/db|prisma/);
        expect(src).not.toMatch(/console\./);
        expect(src).toMatch(/export async function POST\(\)/); // takes no request at all
        expect(src).toMatch(/export async function GET\(\)/);
        expect(src).toContain("{ error: 'This SMS endpoint is no longer available.' }");
        expect(src).toContain('status: 410');
    });

    const files = (dir: string): string[] => fs.existsSync(path.join(ROOT, dir))
        ? fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
            e.isDirectory() ? (e.name === 'node_modules' || e.name === '.next' ? [] : files(path.join(dir, e.name)))
                : /\.(ts|tsx|js|cjs|mjs)$/.test(e.name) ? [path.join(dir, e.name).replace(/\\/g, '/')] : [])
        : [];
    const appCode = () => [...files('app'), ...files('components'), ...files('lib'), ...files('hooks'), ...files('scripts')];

    it('11 · no app, component, library or script calls /api/public/send-text', () => {
        const callers = appCode().filter((f) => f !== ROUTE_FILE && /public\/send-text|['"`]\/api\/public\/send/.test(code(R(f))));
        expect(callers).toEqual([]);
    });

    it('no app code imports Twilio any more (the dependency stays in package.json for now)', () => {
        const importers = appCode().filter((f) => /from ['"]twilio['"]|require\(['"]twilio['"]\)/.test(code(R(f))));
        expect(importers).toEqual([]);
        expect(JSON.parse(R('package.json')).dependencies.twilio).toBeDefined();
    });

    it('12 · the public-route security sweep classifies both verbs as deliberately retired', () => {
        const sweep = R('tests/secPublicRoute1Sweep.test.ts');
        expect(sweep).toContain("'POST app/api/public/send-text/route.ts': 'deliberately retired to 410; legacy SMS relay, reads nothing',");
        expect(sweep).toContain("'GET app/api/public/send-text/route.ts': 'deliberately retired to 410; legacy SMS relay, reads nothing',");
    });
});
