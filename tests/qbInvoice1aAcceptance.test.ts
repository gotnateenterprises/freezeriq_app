/**
 * QB-INVOICE-1A-ACCEPTANCE — the owner's acceptance questions, each answered by
 * executing the real code.
 *
 *   Part 2  encryption-key rotation: exactly what migrates and what does not
 *   Part 3  the OAuth attempt cookie, and the full callback failure/replay matrix
 *   Part 4  why an unrelated website cannot disconnect or forget a connection
 *   Part 5  no rejected authorization is ever revoked
 *   Part 6  one tenant, one active QuickBooks company; switching is explicit
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { NextRequest } from 'next/server';
import { signOAuthState, verifyOAuthState } from '@/lib/auth/oauthState';
import {
    checkQuickBooksHealth,
    disconnectQuickBooks,
    forgetQuickBooksConnection,
    getQuickBooksAccess,
    loadQuickBooksConnection,
    saveAuthorizedConnection,
} from '@/lib/quickbooks/connection';
import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import { integrationTokenKeys, openIntegrationSecret } from '@/lib/integrationTokenCrypto';
import { quickBooksCardView } from '@/lib/quickbooks/statusView';
import { QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER } from '@/lib/quickbooks/oauthAttempt';
import {
    LOCAL_REDIRECT, TEST_AUTH_SECRET, TEST_TOKEN_KEY, captureConsole, fakeIntegrationDb, fakeIntuit, sandboxConfig, sandboxEnv,
} from './helpers/quickbooksFakes';

// ── Doubles (same shape as qbInvoice1aRoutes) ───────────────────────────────
let store = fakeIntegrationDb();
jest.mock('@/lib/db', () => ({
    get prisma() { return store.db; },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

interface CookieWrite { name: string; value: string; options: any }
const jar = new Map<string, string>();
const cookieWrites: CookieWrite[] = [];
// Each request sees the cookies the browser sent at the start of the request.
jest.mock('next/headers', () => ({
    cookies: async () => {
        const sent = new Map(jar);
        return {
            get: (n: string) => (sent.has(n) ? { name: n, value: sent.get(n) } : undefined),
            set: (n: string, v: string, options: any) => {
                cookieWrites.push({ name: n, value: v, options });
                if (options?.maxAge === 0) jar.delete(n); else jar.set(n, v);
            },
            delete: (n: string) => { jar.delete(n); },
        };
    },
}));

import * as connectRoute from '@/app/api/integrations/quickbooks/connect/route';
import * as callbackRoute from '@/app/api/integrations/quickbooks/callback/route';
import * as disconnectRoute from '@/app/api/integrations/quickbooks/disconnect/route';

const ROOT = process.cwd();
/** Source text with line endings normalised, so checks behave the same on a CRLF checkout. */
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
function walk(dir: string, out: string[] = []): string[] {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) return out;
    for (const name of readdirSync(abs)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(name)) out.push(relative(ROOT, join(ROOT, rel)).replace(/\\/g, '/'));
    }
    return out;
}
const TENANT_A = 'biz-tenant-a';
const TENANT_B = 'biz-tenant-b';
const REALM_1 = '9130000000000001';
const REALM_2 = '9130000000000002';
const COOKIE = 'quickbooks_oauth_nonce';
const CALLBACK_PATH = '/api/integrations/quickbooks/callback';
const PROD_REDIRECT = 'https://www.freezeriqapp.com/api/integrations/quickbooks/callback';
const SECRET_PATTERN = /ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|TESTCLIENTSECRET|TESTTOKENKEY|TESTAUTHSECRET|AUTHCODE/;

const admin = (businessId = TENANT_A, extra: any = {}) => ({
    user: { id: `user-admin-${businessId}`, role: 'ADMIN', businessId, baseBusinessId: businessId, isViewingAsTenant: false, isSuperAdmin: false, ...extra },
});

let intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2] });
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function useEnv(overrides: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
    for (const k of ['VERCEL', 'VERCEL_ENV', 'DATABASE_URL', 'DIRECT_URL', 'QBO_PRODUCTION_ENABLED']) delete process.env[k];
    const env = sandboxEnv(overrides) as any;
    for (const [k, v] of Object.entries(env)) (process.env as any)[k] = v;
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

beforeEach(() => {
    store = fakeIntegrationDb();
    intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2] });
    (global as any).fetch = intuit.fetchImpl;
    jar.clear();
    cookieWrites.length = 0;
    mockAuth.mockReset();
    useEnv();
});

afterAll(() => {
    (global as any).fetch = ORIGINAL_FETCH;
    process.env = ORIGINAL_ENV;
});

const exchanges = () => intuit.tokenCalls('authorization_code');
const connectionRows = () => [...store.rows.values()].filter((r) => r.provider === 'quickbooks');
const attemptOpen = (businessId = TENANT_A) => store.rows.has(`${businessId}|${QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER}`);
const callbackReq = (qs: string) => new NextRequest(`http://localhost:3000${CALLBACK_PATH}?${qs}`);
const outcomeOf = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('quickbooks');

async function startConnect(session = admin()): Promise<{ state: string; nonce: string }> {
    mockAuth.mockResolvedValue(session);
    const res = await connectRoute.GET();
    expect(res.status).toBe(302);
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    const verified = await verifyOAuthState(state, TEST_AUTH_SECRET, 'quickbooks');
    return { state, nonce: verified!.nonce };
}

async function callback(qs: string, session: any = admin()) {
    mockAuth.mockResolvedValue(session);
    return callbackRoute.GET(callbackReq(qs));
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — the OAuth attempt cookie
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE Part 3 · OAuth attempt cookie attributes', () => {
    const setCookie = () => cookieWrites.filter((c) => c.name === COOKIE && c.options?.maxAge !== 0);
    const clearCookie = () => cookieWrites.filter((c) => c.name === COOKIE && c.options?.maxAge === 0);

    it('local http development: HttpOnly, SameSite=Lax, callback-only Path, 600s Max-Age, not Secure (http cannot carry Secure)', async () => {
        const before = Math.floor(Date.now() / 1000);
        const { state, nonce } = await startConnect();
        expect(setCookie()).toHaveLength(1);
        expect(setCookie()[0]).toEqual({
            name: COOKIE,
            value: nonce,
            options: { httpOnly: true, secure: false, sameSite: 'lax', maxAge: 600, path: CALLBACK_PATH },
        });
        // State, cookie and server-side attempt all end together, ten minutes out.
        const { exp } = (await verifyOAuthState(state, TEST_AUTH_SECRET, 'quickbooks'))!;
        expect(exp - before).toBeGreaterThanOrEqual(599);
        expect(exp - before).toBeLessThanOrEqual(601);
        expect(store.rows.get(`${TENANT_A}|${QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER}`)!.expires_at!.getTime()).toBe(exp * 1000);
    });

    it('local https (localhost) development: Secure', async () => {
        useEnv({ QBO_REDIRECT_URI: 'https://localhost:3000/api/integrations/quickbooks/callback' });
        await startConnect();
        expect(setCookie()[0].options).toMatchObject({ secure: true, httpOnly: true, sameSite: 'lax', path: CALLBACK_PATH, maxAge: 600 });
    });

    it('Production (only when explicitly enabled): Secure, and the callback clears it with the same attributes', async () => {
        useEnv({
            VERCEL: '1', VERCEL_ENV: 'production', QBO_ENVIRONMENT: 'production', QBO_PRODUCTION_ENABLED: 'true',
            QBO_REDIRECT_URI: PROD_REDIRECT,
        });
        const { state } = await startConnect();
        expect(setCookie()[0].options).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: CALLBACK_PATH });

        cookieWrites.length = 0;
        const res = await callback(`state=${encodeURIComponent(state)}&code=X&realmId=abc`); // malformed on purpose
        expect(res.headers.get('location')).toBe('https://www.freezeriqapp.com/settings?quickbooks=invalid_callback');
        expect(clearCookie()).toEqual([{ name: COOKIE, value: '', options: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 0, path: CALLBACK_PATH } }]);
    });

    it('SameSite is Lax, not Strict, because Intuit returns the browser with a cross-site top-level GET', () => {
        const src = readFileSync(join(ROOT, 'app/api/integrations/quickbooks/connect/route.ts'), 'utf8');
        expect(src).toMatch(/sameSite:\s*'lax'/);
        expect(src).not.toMatch(/sameSite:\s*'(strict|none)'/);
    });

    it('Preview never sets the cookie at all', async () => {
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        mockAuth.mockResolvedValue(admin());
        expect((await connectRoute.GET()).status).toBe(503);
        expect(cookieWrites).toEqual([]);
        expect(attemptOpen()).toBe(false);
    });

    it('the cookie is cleared (Max-Age=0, same name, Path and flags) exactly when the attempt is spent or proven dead', async () => {
        const enc = encodeURIComponent;
        const proving: Array<(st: string) => string> = [
            (st) => `code=AUTHCODE-ONE&state=${enc(st)}&realmId=${REALM_1}`, // success
            (st) => `error=access_denied&state=${enc(st)}`,                   // cancelled
            (st) => `state=${enc(st)}&realmId=${REALM_1}`,                     // malformed
        ];
        for (const build of proving) {
            store = fakeIntegrationDb();
            jar.clear();
            const { state } = await startConnect();
            cookieWrites.length = 0;
            await callback(build(state));
            expect(clearCookie().map((c) => c.options)).toEqual([{ httpOnly: true, secure: false, sameSite: 'lax', maxAge: 0, path: CALLBACK_PATH }]);
            expect(jar.has(COOKIE)).toBe(false);
        }

        // An attempt already used elsewhere (e.g. its twin callback won): this cookie is dead too.
        const { state } = await startConnect();
        const nonce = jar.get(COOKIE)!;
        await callback(`code=AUTHCODE-ONE&state=${enc(state)}&realmId=${REALM_1}`);
        jar.set(COOKIE, nonce);
        cookieWrites.length = 0;
        expect(outcomeOf(await callback(`code=AUTHCODE-TWO&state=${enc(state)}&realmId=${REALM_1}`))).toBe('invalid_state');
        expect(clearCookie()).toHaveLength(1);
    });

    it('a request that cannot prove the attempt leaves the cookie alone', async () => {
        const { state } = await startConnect();
        for (const [qs, session] of [
            ['', admin()],                                                        // bare navigation to the callback URL
            ['error=access_denied', admin()],                                     // denial without state
            [`code=X&state=garbage&realmId=${REALM_1}`, admin()],               // bad state
            [`code=X&realmId=${REALM_1}`, admin()],                             // no state
            [`code=X&state=${encodeURIComponent(state)}&realmId=${REALM_1}`, admin(TENANT_A, { id: 'someone-else' })], // wrong user
        ] as Array<[string, any]>) {
            cookieWrites.length = 0;
            await callback(qs, session);
            expect({ qs, writes: cookieWrites }).toEqual({ qs, writes: [] });
        }
        expect(attemptOpen()).toBe(true);
    });

    it('a stray or hostile navigation to the callback URL in the admin’s own browser cannot break the real callback still on its way', async () => {
        const { state } = await startConnect();
        // Another tab/site navigates this same browser to the callback, several ways.
        await callback('');
        await callback(`code=EVIL&state=garbage&realmId=${REALM_2}`);
        await callback('error=access_denied');
        // No cookie re-injection: the browser keeps whatever the responses left it.
        expect(jar.has(COOKIE)).toBe(true);
        expect(outcomeOf(await callback(`code=AUTHCODE-ONE&state=${encodeURIComponent(state)}&realmId=${REALM_1}`))).toBe('connected');
    });

    it('without a FreezerIQ session the cookie is deliberately kept: nothing was attempted and the attempt stays bound to its user', async () => {
        const { state } = await startConnect();
        cookieWrites.length = 0;
        const res = await callback(`state=${encodeURIComponent(state)}&code=AUTHCODE-ONE&realmId=${REALM_1}`, null);
        expect(outcomeOf(res)).toBe('session_required');
        expect(cookieWrites).toEqual([]);
        expect(exchanges()).toHaveLength(0);
        expect(attemptOpen()).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — callback failure / replay matrix
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE Part 3 · callback failure matrix', () => {
    interface Case {
        name: string;
        build: (a: { state: string; nonce: string }) => Promise<{ qs: string; session?: any; cookie?: string | null; consent?: string }>;
        outcome: string;
        exchanges: number;
        connected: boolean;
        attemptConsumed: boolean;
    }
    // In every case the attempt cookie is cleared exactly when the attempt is consumed.
    const enc = encodeURIComponent;
    const CASES: Case[] = [
        { name: 'normal success', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}&realmId=${REALM_1}` }), outcome: 'connected', exchanges: 1, connected: true, attemptConsumed: true },
        { name: 'error=access_denied WITH state (user cancelled)', build: async ({ state }) => ({ qs: `error=access_denied&state=${enc(state)}` }), outcome: 'denied', exchanges: 0, connected: false, attemptConsumed: true },
        { name: 'error=access_denied WITHOUT state', build: async () => ({ qs: 'error=access_denied' }), outcome: 'denied', exchanges: 0, connected: false, attemptConsumed: false },
        { name: 'missing code', build: async ({ state }) => ({ qs: `state=${enc(state)}&realmId=${REALM_1}` }), outcome: 'invalid_callback', exchanges: 0, connected: false, attemptConsumed: true },
        { name: 'missing realmId', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}` }), outcome: 'invalid_callback', exchanges: 0, connected: false, attemptConsumed: true },
        { name: 'missing state', build: async () => ({ qs: `code=AUTHCODE-ONE&realmId=${REALM_1}` }), outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false },
        { name: 'invalid (malformed) state', build: async () => ({ qs: `code=AUTHCODE-ONE&state=not.a.state&realmId=${REALM_1}` }), outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false },
        {
            name: 'tampered state (tenant rewritten, signature kept)',
            build: async ({ state }) => {
                const [body, sig] = state.split('.');
                const p = JSON.parse(Buffer.from(body, 'base64url').toString());
                return { qs: `code=AUTHCODE-ONE&state=${enc(`${Buffer.from(JSON.stringify({ ...p, businessId: TENANT_B })).toString('base64url')}.${sig}`)}&realmId=${REALM_1}` };
            },
            outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false,
        },
        {
            name: 'expired state',
            build: async ({ nonce }) => ({ qs: `code=AUTHCODE-ONE&realmId=${REALM_1}&state=${enc(await signOAuthState({ provider: 'quickbooks', businessId: TENANT_A, userId: `user-admin-${TENANT_A}`, nonce, exp: Math.floor(Date.now() / 1000) - 1 }, TEST_AUTH_SECRET))}` }),
            outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false,
        },
        { name: 'wrong user (same tenant)', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}&realmId=${REALM_1}`, session: admin(TENANT_A, { id: 'another-admin' }) }), outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false },
        { name: 'wrong tenant (same user id)', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}&realmId=${REALM_1}`, session: admin(TENANT_B, { id: `user-admin-${TENANT_A}` }) }), outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false },
        { name: 'wrong nonce (cookie from a different attempt)', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}&realmId=${REALM_1}`, cookie: 'a-different-attempt-nonce' }), outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false },
        { name: 'missing cookie (different browser)', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}&realmId=${REALM_1}`, cookie: null }), outcome: 'invalid_state', exchanges: 0, connected: false, attemptConsumed: false },
        { name: 'malformed realmId', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}&realmId=12%2F34` }), outcome: 'invalid_callback', exchanges: 0, connected: false, attemptConsumed: true },
        { name: 'malformed code (whitespace)', build: async ({ state }) => ({ qs: `code=AUTH%20CODE&state=${enc(state)}&realmId=${REALM_1}` }), outcome: 'invalid_callback', exchanges: 0, connected: false, attemptConsumed: true },
        { name: 'malformed code (oversized)', build: async ({ state }) => ({ qs: `code=${'A'.repeat(1025)}&state=${enc(state)}&realmId=${REALM_1}` }), outcome: 'invalid_callback', exchanges: 0, connected: false, attemptConsumed: true },
        { name: 'forged realmId (tokens are for a different company)', build: async ({ state }) => ({ qs: `code=AUTHCODE-ONE&state=${enc(state)}&realmId=${REALM_2}`, consent: REALM_1 }), outcome: 'realm_unverified', exchanges: 1, connected: false, attemptConsumed: true },
    ];

    it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
        const attempt = await startConnect();
        cookieWrites.length = 0;
        const { qs, session = admin(), cookie, consent } = await c.build(attempt);
        if (cookie === null) jar.delete(COOKIE);
        else if (typeof cookie === 'string') jar.set(COOKIE, cookie);
        if (consent) intuit.consentTo(consent);

        const { result: res, output } = await captureConsole(() => callback(qs, session));

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(`http://localhost:3000/settings?quickbooks=${c.outcome}`);
        expect(exchanges()).toHaveLength(c.exchanges);
        expect(connectionRows()).toHaveLength(c.connected ? 1 : 0);
        expect(attemptOpen()).toBe(!c.attemptConsumed);
        expect(cookieWrites.filter((w) => w.name === COOKIE && w.options?.maxAge === 0)).toHaveLength(c.attemptConsumed ? 1 : 0);
        expect(intuit.revoked).toEqual([]);

        // Nothing sensitive reaches the browser or the logs.
        const location = res.headers.get('location')!;
        for (const secret of [attempt.state, attempt.nonce, REALM_1, REALM_2, 'AUTHCODE']) {
            expect(location).not.toContain(secret);
            expect(output).not.toContain(secret);
        }
        expect(output).not.toMatch(SECRET_PATTERN);
    });
});

describe('ACCEPTANCE Part 3 · replay is impossible after success, failure and cancellation', () => {
    const enc = encodeURIComponent;

    /** Replays with the ORIGINAL cookie re-injected — the worst case, e.g. the clearing response never arrived. */
    async function replay(a: { state: string; nonce: string }) {
        jar.set(COOKIE, a.nonce);
        intuit.consentTo(REALM_1);
        return callback(`code=AUTHCODE-TWO&state=${enc(a.state)}&realmId=${REALM_1}`);
    }

    it('after a SUCCESSFUL callback', async () => {
        const a = await startConnect();
        expect(outcomeOf(await callback(`code=AUTHCODE-ONE&state=${enc(a.state)}&realmId=${REALM_1}`))).toBe('connected');
        const row = { ...connectionRows()[0] };
        expect(outcomeOf(await replay(a))).toBe('invalid_state');
        expect(exchanges()).toHaveLength(1);
        expect(connectionRows()).toEqual([row]);
    });

    it('after the user CANCELLED at Intuit (denial carrying state)', async () => {
        const a = await startConnect();
        expect(outcomeOf(await callback(`error=access_denied&state=${enc(a.state)}`))).toBe('denied');
        expect(outcomeOf(await replay(a))).toBe('invalid_state');
        expect(exchanges()).toHaveLength(0);
        expect(connectionRows()).toHaveLength(0);
    });

    it('after a MALFORMED callback (missing code)', async () => {
        const a = await startConnect();
        expect(outcomeOf(await callback(`state=${enc(a.state)}&realmId=${REALM_1}`))).toBe('invalid_callback');
        expect(outcomeOf(await replay(a))).toBe('invalid_state');
        expect(exchanges()).toHaveLength(0);
    });

    it('after a FORGED-realm callback', async () => {
        const a = await startConnect();
        intuit.consentTo(REALM_1);
        expect(outcomeOf(await callback(`code=AUTHCODE-ONE&state=${enc(a.state)}&realmId=${REALM_2}`))).toBe('realm_unverified');
        expect(outcomeOf(await replay(a))).toBe('invalid_state');
        expect(exchanges()).toHaveLength(1);
        expect(connectionRows()).toHaveLength(0);
    });

    it('after a failed token exchange', async () => {
        intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], exchangeError: 'invalid_grant' });
        (global as any).fetch = intuit.fetchImpl;
        const a = await startConnect();
        expect(outcomeOf(await callback(`code=AUTHCODE-ONE&state=${enc(a.state)}&realmId=${REALM_1}`))).toBe('token_exchange_failed');
        expect(outcomeOf(await replay(a))).toBe('invalid_state');
        expect(exchanges()).toHaveLength(1);
    });

    it('requests that could NOT prove the attempt (wrong user, bad state, another browser) do not burn it for its owner', async () => {
        const a = await startConnect();
        // Same browser, wrong session user, then garbage state.
        await callback(`code=AUTHCODE-X&state=${enc(a.state)}&realmId=${REALM_1}`, admin(TENANT_A, { id: 'someone-else' }));
        await callback(`code=AUTHCODE-X&state=garbage&realmId=${REALM_1}`);
        // Another browser (its own, different cookie jar) presenting the real state.
        const victimJar = new Map(jar);
        jar.clear();
        jar.set(COOKIE, 'attacker-browser-nonce');
        await callback(`code=AUTHCODE-X&state=${enc(a.state)}&realmId=${REALM_1}`);
        jar.clear();
        victimJar.forEach((v, k) => jar.set(k, v)); // back to the admin's browser, untouched by the requests above
        expect(attemptOpen()).toBe(true);
        expect(exchanges()).toHaveLength(0);

        expect(outcomeOf(await callback(`code=AUTHCODE-ONE&state=${enc(a.state)}&realmId=${REALM_1}`))).toBe('connected');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 4 — disconnect / forget cannot be forged cross-site
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE Part 4 · disconnect/forget CSRF', () => {
    async function connectA() {
        const a = await startConnect();
        await callback(`code=AUTHCODE-ONE&state=${encodeURIComponent(a.state)}&realmId=${REALM_1}`);
        expect(connectionRows()).toHaveLength(1);
    }
    const post = (body: string, headers: Record<string, string>) =>
        disconnectRoute.POST(new Request('http://localhost:3000/api/integrations/quickbooks/disconnect', { method: 'POST', headers, body }));

    it('lock 1: the FreezerIQ session cookie is SameSite=Lax and HttpOnly (Auth.js default, not overridden), so a cross-site POST carries no session', () => {
        // The repository does not override Auth.js cookie settings anywhere.
        // (middleware.ts builds a second Auth.js instance from authConfig; it re-issues the session cookie too.)
        for (const f of ['auth.ts', 'auth.config.ts', 'middleware.ts', 'proxy.ts'].filter((p) => existsSync(join(ROOT, p)))) {
            const text = src(f);
            expect({ f, override: /\bcookies\s*:|useSecureCookies|sameSite/.test(text) }).toEqual({ f, override: false });
        }
        expect(src('middleware.ts')).toMatch(/NextAuth\(authConfig\)/);
        // …and the installed Auth.js default for the session token is Lax + HttpOnly.
        const core = readFileSync(join(ROOT, 'node_modules/@auth/core/lib/utils/cookie.js'), 'utf8');
        const block = /sessionToken:\s*\{[\s\S]*?options:\s*\{([\s\S]*?)\}/.exec(core);
        expect(block).not.toBeNull();
        expect(block![1]).toMatch(/httpOnly:\s*true/);
        expect(block![1]).toMatch(/sameSite:\s*"lax"/);
    });

    it('with no session (what a cross-site POST presents) nothing happens: 401', async () => {
        await connectA();
        const before = { ...connectionRows()[0] };
        mockAuth.mockResolvedValue(null);
        for (const action of ['disconnect', 'forget']) {
            const res = await post(JSON.stringify({ action }), { 'content-type': 'application/json' });
            expect(res.status).toBe(401);
        }
        expect(connectionRows()).toEqual([before]);
        expect(intuit.revoked).toEqual([]);
    });

    it.each([
        ['text/plain (a cross-site form or no-cors fetch)', 'text/plain', '{"action":"disconnect"}'],
        ['text/plain with a JSON-looking parameter', 'text/plain; application/json', '{"action":"disconnect"}'],
        ['application/x-www-form-urlencoded (an HTML form)', 'application/x-www-form-urlencoded', 'action=disconnect'],
        ['multipart/form-data (an HTML form)', 'multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="action"\r\n\r\ndisconnect\r\n--x--'],
        ['no content type at all', '', '{"action":"forget"}'],
    ])('lock 2: a CORS-safelisted or missing content type is refused BEFORE any change, even WITH an admin session — %s', async (_label, contentType, body) => {
        await connectA();
        const before = { ...connectionRows()[0] };
        mockAuth.mockResolvedValue(admin());
        const res = await post(body, contentType ? { 'content-type': contentType } : {});
        expect(res.status).toBe(415);
        expect(connectionRows()).toEqual([before]);
        expect(intuit.revoked).toEqual([]);
    });

    it('lock 2 holds because application/json forces a CORS preflight, and nothing grants CORS', () => {
        // The route exports only POST: no OPTIONS handler that could answer a preflight with permission.
        expect(Object.keys(disconnectRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(k))).toEqual(['POST']);
        // No Access-Control-Allow-* header is configured anywhere the request could pass through.
        const files = [
            ...['app', 'lib', 'components', 'types'].flatMap((d) => walk(d)),
            ...['next.config.js', 'middleware.ts', 'proxy.ts', 'vercel.json'].filter((p) => existsSync(join(ROOT, p))),
        ];
        expect(files.length).toBeGreaterThan(200);
        expect(files.filter((p) => /Access-Control-Allow/i.test(src(p)))).toEqual([]);
        // Middleware does not run on /api at all.
        expect(readFileSync(join(ROOT, 'middleware.ts'), 'utf8')).toMatch(/\(\?!api\//);
    });

    it('a genuine same-origin JSON request from the Settings card still works', async () => {
        await connectA();
        mockAuth.mockResolvedValue(admin());
        const res = await post(JSON.stringify({ action: 'disconnect' }), { 'content-type': 'application/json' });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(await res.json()).toEqual({ outcome: 'disconnected', revoked: true });
    });

    it('the Settings card sends exactly the headers the route requires', () => {
        const card = readFileSync(join(ROOT, 'components/settings/QuickBooksConnectionCard.tsx'), 'utf8');
        expect(card).toMatch(/method:\s*'POST'[\s\S]{0,120}'Content-Type':\s*'application\/json'/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 5 — refused / abandoned grants are never revoked
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE Part 5 · no rejected authorization is revoked', () => {
    const config = sandboxConfig();
    const env = sandboxEnv();

    function setup() {
        const s = fakeIntegrationDb();
        const i = fakeIntuit({ realmIds: [REALM_1, REALM_2] });
        let clock = Date.parse('2026-09-13T12:00:00Z');
        const deps = { db: s.db, fetchImpl: i.fetchImpl, env, now: () => clock, sleep: () => new Promise<void>((r) => setImmediate(r)) };
        const save = async (businessId: string, realmId: string, consent = realmId) => {
            i.consentTo(consent);
            const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i.fetchImpl, deps.now);
            return saveAuthorizedConnection({ businessId, realmId, tokens, config, authorizedByUserId: 'u' }, deps);
        };
        return { s, i, deps, save, advance: (ms: number) => { clock += ms; } };
    }

    it('realm_mismatch (tenant already bound to a different company): not revoked', async () => {
        const t = setup();
        await t.save(TENANT_A, REALM_1);
        expect(await t.save(TENANT_A, REALM_2)).toBe('realm_mismatch');
        expect(t.i.revoked).toEqual([]);
    });

    it('realm_in_use (company belongs to another tenant): not revoked — that would disconnect the other tenant', async () => {
        const t = setup();
        await t.save(TENANT_A, REALM_1);
        expect(await t.save(TENANT_B, REALM_1)).toBe('realm_in_use');
        expect(t.i.revoked).toEqual([]);
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'connected' });
    });

    it('realm_unverified (tokens are for some other, unknown company): not revoked', async () => {
        const t = setup();
        expect(await t.save(TENANT_A, REALM_2, REALM_1)).toBe('realm_unverified');
        expect(t.i.revoked).toEqual([]);
    });

    it('verification_failed (QuickBooks unreachable): not revoked', async () => {
        const t = setup();
        const down = { ...t.deps, fetchImpl: async (url: string, init?: RequestInit) => (url.includes('/companyinfo/') ? new Response('', { status: 503 }) : t.i.fetchImpl(url, init)) };
        t.i.consentTo(REALM_1);
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', t.i.fetchImpl, t.deps.now);
        expect(await saveAuthorizedConnection({ businessId: TENANT_A, realmId: REALM_1, tokens, config, authorizedByUserId: 'u' }, down)).toBe('verification_failed');
        expect(t.i.revoked).toEqual([]);
    });

    it('reconnect_blocked (existing row unreadable, so its company is unknown): not revoked', async () => {
        const t = setup();
        await t.save(TENANT_A, REALM_1);
        const row = t.s.rows.get(`${TENANT_A}|quickbooks`)!;
        t.s.rows.set(`${TENANT_A}|quickbooks`, { ...row, access_token: 'v1.corrupted.value' });
        expect(await t.save(TENANT_A, REALM_1)).toBe('reconnect_blocked');
        expect(t.i.revoked).toEqual([]);
    });

    it('conflict (a concurrent write won): not revoked', async () => {
        const t = setup();
        t.s.failOnce('create', () => true, 'throw_before', 'P2002');
        expect(await t.save(TENANT_A, REALM_1)).toBe('conflict');
        expect(t.i.revoked).toEqual([]);
    });

    it('token exchange succeeded but the database write failed: the save throws, nothing is revoked', async () => {
        const t = setup();
        t.s.failOnce('create', () => true, 'throw_before', 'P1017');
        await expect(t.save(TENANT_A, REALM_1)).rejects.toMatchObject({ code: 'P1017' });
        expect(t.i.revoked).toEqual([]);
        expect([...t.s.rows.values()].filter((r) => r.provider === 'quickbooks')).toHaveLength(0);
    });

    it('the user cancelled: there is no grant — no exchange and no revoke', async () => {
        const a = await startConnect();
        await callback(`error=access_denied&state=${encodeURIComponent(a.state)}`);
        expect(intuit.calls.filter((c) => /tokens\/(bearer|revoke)/.test(c.url))).toEqual([]);
    });

    it('there is exactly ONE revocation call site in the whole connector: the admin disconnect', () => {
        const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        const files = [...walk('lib/quickbooks'), ...walk('app/api/integrations/quickbooks'), 'components/settings/QuickBooksConnectionCard.tsx'];
        const calls = files.flatMap((p) => (strip(src(p)).match(/\brevokeToken\(/g) ?? []).map(() => p));
        // intuitClient.ts DEFINES revokeToken; connection.ts calls it once.
        expect(calls.sort()).toEqual(['lib/quickbooks/connection.ts', 'lib/quickbooks/intuitClient.ts']);
        const connection = strip(src('lib/quickbooks/connection.ts'));
        const disconnectBody = /export async function disconnectQuickBooks[\s\S]*?\n}\n/.exec(connection)![0];
        expect(disconnectBody).toMatch(/\brevokeToken\(/);
        expect(files.filter((p) => p !== 'lib/quickbooks/config.ts' && p !== 'lib/quickbooks/intuitClient.ts' && /INTUIT_REVOKE_URL|tokens\/revoke/.test(strip(src(p))))).toEqual([]);
    });

    it('a refresh that finishes after an admin disconnect is discarded, NOT revoked', async () => {
        const t = setup();
        const { gate } = await import('./helpers/quickbooksFakes');
        const g = gate();
        const i2 = fakeIntuit({ realmIds: [REALM_1, REALM_2], refreshGates: [g.promise] });
        const deps = { ...t.deps, fetchImpl: i2.fetchImpl };
        i2.consentTo(REALM_1);
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i2.fetchImpl, t.deps.now);
        await saveAuthorizedConnection({ businessId: TENANT_A, realmId: REALM_1, tokens, config, authorizedByUserId: 'u' }, deps);
        t.advance(61 * 60 * 1000);
        const refreshing = getQuickBooksAccess({ businessId: TENANT_A, config }, deps).catch((e) => e);
        for (let n = 0; n < 2000; n++) {
            const c: any = await loadQuickBooksConnection(TENANT_A, deps);
            if (c.kind === 'connected' && c.lease) break;
            await new Promise((r) => setTimeout(r, 1));
        }
        await disconnectQuickBooks({ businessId: TENANT_A, config }, deps);
        g.release();
        expect(await refreshing).toMatchObject({ kind: 'disconnected' });
        // Only the admin disconnect's own revoke — never the late, unstored refresh result.
        expect(i2.revoked).toEqual(['REFRESHTOKEN-SECRET-1']);
    });
});

describe('ACCEPTANCE Part 5 · through the callback route, no rejected authorization is revoked', () => {
    const enc = encodeURIComponent;

    it('verification_failed (QuickBooks unreachable while verifying the company)', async () => {
        intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], companyInfoStatus: 503 });
        (global as any).fetch = intuit.fetchImpl;
        const a = await startConnect();
        expect(outcomeOf(await callback(`code=AUTHCODE-ONE&state=${enc(a.state)}&realmId=${REALM_1}`))).toBe('verification_failed');
        expect(intuit.revoked).toEqual([]);
        expect(connectionRows()).toHaveLength(0);
    });

    it('reconnect_blocked (the stored row became unreadable while the admin was at Intuit)', async () => {
        const first = await startConnect();
        await callback(`code=AUTHCODE-ONE&state=${enc(first.state)}&realmId=${REALM_1}`);
        const a = await startConnect();
        const row = store.rows.get(`${TENANT_A}|quickbooks`)!;
        store.rows.set(`${TENANT_A}|quickbooks`, { ...row, access_token: 'v1.corrupted.value' });
        expect(outcomeOf(await callback(`code=AUTHCODE-TWO&state=${enc(a.state)}&realmId=${REALM_1}`))).toBe('reconnect_blocked');
        expect(intuit.revoked).toEqual([]);
    });

    it('conflict (a concurrent write won)', async () => {
        const a = await startConnect();
        store.failOnce('create', (args: any) => args.data?.provider === 'quickbooks', 'throw_before', 'P2002');
        expect(outcomeOf(await callback(`code=AUTHCODE-ONE&state=${enc(a.state)}&realmId=${REALM_1}`))).toBe('conflict');
        expect(intuit.revoked).toEqual([]);
    });

    it('the token exchange succeeded but the database write failed', async () => {
        const a = await startConnect();
        store.failOnce('create', (args: any) => args.data?.provider === 'quickbooks', 'throw_before', 'P1017');
        const { result, output } = await captureConsole(() => callback(`code=AUTHCODE-ONE&state=${enc(a.state)}&realmId=${REALM_1}`));
        expect(outcomeOf(result)).toBe('error');
        expect(intuit.revoked).toEqual([]);
        expect(connectionRows()).toHaveLength(0);
        expect(output).not.toMatch(SECRET_PATTERN);
    });
});

describe('ACCEPTANCE · an unreadable stored connection is never sent back to Intuit', () => {
    async function connected() {
        const a = await startConnect();
        await callback(`code=AUTHCODE-ONE&state=${encodeURIComponent(a.state)}&realmId=${REALM_1}`);
        cookieWrites.length = 0;
    }

    it('Connect refuses before Intuit when the stored row cannot be read (no attempt, no cookie, no consent screen)', async () => {
        await connected();
        const row = store.rows.get(`${TENANT_A}|quickbooks`)!;
        store.rows.set(`${TENANT_A}|quickbooks`, { ...row, access_token: 'v1.corrupted.value' });
        mockAuth.mockResolvedValue(admin());
        const res = await connectRoute.GET();
        expect(res.headers.get('location')).toBe('http://localhost:3000/settings?quickbooks=reconnect_blocked');
        expect(cookieWrites).toEqual([]);
        expect(attemptOpen()).toBe(false);
    });

    it('…also for a disconnected row whose company can no longer be read; status offers only Forget', async () => {
        await connected();
        mockAuth.mockResolvedValue(admin());
        await disconnectRoute.POST(new Request('http://localhost:3000/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
        const row = store.rows.get(`${TENANT_A}|quickbooks`)!;
        store.rows.set(`${TENANT_A}|quickbooks`, { ...row, realm_id: 'v1.corrupted.value' });

        const res = await connectRoute.GET();
        expect(res.headers.get('location')).toBe('http://localhost:3000/settings?quickbooks=reconnect_blocked');
        const { checkQuickBooksHealth: health } = await import('@/lib/quickbooks/connection');
        const h = await health({ businessId: TENANT_A, config: sandboxConfig() }, { db: store.db, env: process.env, fetchImpl: intuit.fetchImpl });
        expect(h).toEqual({ state: 'reconnect_required', environment: 'sandbox', cause: 'unreadable', canForget: true });
        expect(quickBooksCardView(h)).toMatchObject({ showConnect: false, showDisconnect: false, showForget: true });
    });

    it('a readable connected or disconnected row still goes to Intuit normally', async () => {
        await connected();
        mockAuth.mockResolvedValue(admin());
        expect(new URL((await connectRoute.GET()).headers.get('location')!).host).toBe('appcenter.intuit.com');
        await disconnectRoute.POST(new Request('http://localhost:3000/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
        expect(new URL((await connectRoute.GET()).headers.get('location')!).host).toBe('appcenter.intuit.com');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 6 — one tenant, one active QuickBooks company
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE Part 6 · V1 realm rule', () => {
    const config = sandboxConfig();
    const env = sandboxEnv();

    it('switching companies requires disconnect → forget → connect, and the tenant never holds two connections', async () => {
        const s = fakeIntegrationDb();
        const i = fakeIntuit({ realmIds: [REALM_1, REALM_2] });
        let clock = Date.parse('2026-09-13T12:00:00Z');
        const deps = { db: s.db, fetchImpl: i.fetchImpl, env, now: () => clock, sleep: () => new Promise<void>((r) => setImmediate(r)) };
        const connect = async (realm: string) => {
            i.consentTo(realm);
            const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i.fetchImpl, deps.now);
            return saveAuthorizedConnection({ businessId: TENANT_A, realmId: realm, tokens, config, authorizedByUserId: 'u' }, deps);
        };
        // Every row this tenant holds except its (separate, non-connection) attempt row.
        const rowsForTenant = () => [...s.rows.values()].filter((r) => r.business_id === TENANT_A && r.provider !== QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER);

        expect(await connect(REALM_1)).toBe('connected');
        expect(await connect(REALM_2)).toBe('realm_mismatch');                                     // no silent switch
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, deps)).toBe('still_connected'); // can't forget a live one
        expect(await disconnectQuickBooks({ businessId: TENANT_A, config }, deps)).toMatchObject({ outcome: 'disconnected' });
        expect(await connect(REALM_2)).toBe('realm_mismatch');                                     // disconnect alone isn't enough
        expect(await connect(REALM_1)).toBe('connected');                                          // …but the same company may return
        await disconnectQuickBooks({ businessId: TENANT_A, config }, deps);
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, deps)).toBe('forgotten');
        expect(await connect(REALM_2)).toBe('connected');                                          // explicit switch completed
        expect(rowsForTenant()).toHaveLength(1);
        expect(await loadQuickBooksConnection(TENANT_A, deps)).toMatchObject({ kind: 'connected', realmId: REALM_2 });
    });

    it('a connection ended by Intuit (revoked) or by expiry also needs Forget before a different company', async () => {
        const s = fakeIntegrationDb();
        const i = fakeIntuit({ realmIds: [REALM_1, REALM_2], refreshError: 'invalid_grant' });
        let clock = Date.parse('2026-09-13T12:00:00Z');
        const deps = { db: s.db, fetchImpl: i.fetchImpl, env, now: () => clock, sleep: () => new Promise<void>((r) => setImmediate(r)) };
        const connect = async (realm: string) => {
            i.consentTo(realm);
            const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i.fetchImpl, deps.now);
            return saveAuthorizedConnection({ businessId: TENANT_A, realmId: realm, tokens, config, authorizedByUserId: 'u' }, deps);
        };
        await connect(REALM_1);
        clock += 61 * 60 * 1000;
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, deps)).rejects.toMatchObject({ kind: 'reconnect_required' });
        expect(await loadQuickBooksConnection(TENANT_A, deps)).toMatchObject({ kind: 'disconnected', reason: 'revoked' });
        expect(await connect(REALM_2)).toBe('realm_mismatch');
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, deps)).toBe('forgotten');
        expect(await connect(REALM_2)).toBe('connected');
    });

    it('…and the same for a connection whose refresh token EXPIRED', async () => {
        const s = fakeIntegrationDb();
        const i = fakeIntuit({ realmIds: [REALM_1, REALM_2] });
        let clock = Date.parse('2026-09-13T12:00:00Z');
        const deps = { db: s.db, fetchImpl: i.fetchImpl, env, now: () => clock, sleep: () => new Promise<void>((r) => setImmediate(r)) };
        const connect = async (realm: string) => {
            i.consentTo(realm);
            const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i.fetchImpl, deps.now);
            return saveAuthorizedConnection({ businessId: TENANT_A, realmId: realm, tokens, config, authorizedByUserId: 'u' }, deps);
        };
        await connect(REALM_1);
        clock += 101 * 24 * 60 * 60 * 1000; // past the rolling refresh window
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, deps)).rejects.toMatchObject({ kind: 'reconnect_required' });
        expect(await loadQuickBooksConnection(TENANT_A, deps)).toMatchObject({ kind: 'disconnected', reason: 'refresh_expired' });
        expect(await connect(REALM_2)).toBe('realm_mismatch');
        expect(await connect(REALM_1)).toBe('connected'); // the same company may return
        expect([...s.rows.values()].filter((r) => r.business_id === TENANT_A && r.provider !== QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER)).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — encryption-key rotation, exactly
// ═══════════════════════════════════════════════════════════════════════════
describe('ACCEPTANCE Part 2 · encryption-key rotation', () => {
    const config = sandboxConfig();
    const OLD = sandboxEnv({ INTEGRATION_TOKEN_KEY: TEST_TOKEN_KEY });
    const NEW_ONLY = sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48) });
    const TRANSITION = sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48), INTEGRATION_TOKEN_KEY_PREVIOUS: TEST_TOKEN_KEY });

    function setup() {
        const s = fakeIntegrationDb();
        const i = fakeIntuit({ realmIds: [REALM_1] });
        let clock = Date.parse('2026-09-13T12:00:00Z');
        const deps = (env: NodeJS.ProcessEnv) => ({ db: s.db, fetchImpl: i.fetchImpl, env, now: () => clock, sleep: () => new Promise<void>((r) => setImmediate(r)) });
        const connect = async () => {
            const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i.fetchImpl, () => clock);
            return saveAuthorizedConnection({ businessId: TENANT_A, realmId: REALM_1, tokens, config, authorizedByUserId: 'u' }, deps(OLD));
        };
        return { s, i, deps, connect, advance: (ms: number) => { clock += ms; } };
    }

    it('replacing the key WITHOUT keeping the old one makes every stored connection unreadable (fails closed: reconnect required)', async () => {
        const t = setup();
        await t.connect();
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(NEW_ONLY))).toMatchObject({ kind: 'unreadable' });
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps(NEW_ONLY))).toMatchObject({ state: 'reconnect_required', cause: 'unreadable' });
        expect(t.i.tokenCalls('refresh_token')).toHaveLength(0);
    });

    it('with the old key in INTEGRATION_TOKEN_KEY_PREVIOUS, old ciphertext is still read and refreshed', async () => {
        const t = setup();
        await t.connect();
        t.advance(61 * 60 * 1000);
        expect((await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps(TRANSITION))).accessToken).toBe('ACCESSTOKEN-SECRET-2');
    });

    it('a SUCCESSFUL refresh re-seals the whole row (tokens and realm) under the new key', async () => {
        const t = setup();
        await t.connect();
        t.advance(61 * 60 * 1000);
        await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps(TRANSITION));
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(NEW_ONLY))).toMatchObject({ kind: 'connected', realmId: REALM_1 });
    });

    it('an IDLE connection (no refresh) is NOT migrated: it still needs the old key', async () => {
        const t = setup();
        await t.connect();
        // The token is still fresh, so a read under the transition keys writes nothing.
        await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps(TRANSITION));
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(NEW_ONLY))).toMatchObject({ kind: 'unreadable' });
    });

    it('a DISCONNECTED row written before the rotation is NOT migrated: it still needs the old key', async () => {
        const t = setup();
        await t.connect();
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps(OLD));
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(TRANSITION))).toMatchObject({ kind: 'disconnected' });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(NEW_ONLY))).toMatchObject({ kind: 'unreadable' });
    });

    it('a refresh that FAILS transiently restores the exact stored refresh ciphertext and does not migrate the row', async () => {
        const t = setup();
        const failing = { ...t.deps(TRANSITION), fetchImpl: async (url: string, init?: RequestInit) => (url.includes('/tokens/bearer') ? new Response('{"error":"temporarily_unavailable"}', { status: 503 }) : t.i.fetchImpl(url, init)) };
        await t.connect();
        const before = { ...t.s.rows.get(`${TENANT_A}|quickbooks`)! };
        t.advance(61 * 60 * 1000);
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, failing)).rejects.toMatchObject({ kind: 'refresh_failed' });
        const after = t.s.rows.get(`${TENANT_A}|quickbooks`)!;
        expect(after.refresh_token).toBe(before.refresh_token);
        expect(after.access_token).toBe(before.access_token);
        expect(after.realm_id).toBe(before.realm_id);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(TRANSITION))).toMatchObject({ kind: 'connected', lease: null, ambiguousSince: null });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(NEW_ONLY))).toMatchObject({ kind: 'unreadable' });
    });

    it('an AMBIGUOUS refresh failure (lost response) re-seals only refresh_token under the new key, leaving a mixed row', async () => {
        const s = fakeIntegrationDb();
        const i = fakeIntuit({ realmIds: [REALM_1], refreshLostOnce: true });
        let clock = Date.parse('2026-09-13T12:00:00Z');
        const deps = (env: NodeJS.ProcessEnv) => ({ db: s.db, fetchImpl: i.fetchImpl, env, now: () => clock, sleep: () => new Promise<void>((r) => setImmediate(r)) });
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i.fetchImpl, () => clock);
        await saveAuthorizedConnection({ businessId: TENANT_A, realmId: REALM_1, tokens, config, authorizedByUserId: 'u' }, deps(OLD));
        clock += 61 * 60 * 1000;
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, deps(TRANSITION))).rejects.toMatchObject({ kind: 'refresh_failed' });
        const row = s.rows.get(`${TENANT_A}|quickbooks`)!;
        const ctxFor = (field: 'access_token' | 'refresh_token' | 'realm_id') => ({ provider: 'quickbooks', businessId: TENANT_A, field });
        expect(await openIntegrationSecret(row.refresh_token, ctxFor('refresh_token'), NEW_ONLY)).not.toBeNull();
        expect(await openIntegrationSecret(row.access_token, ctxFor('access_token'), NEW_ONLY)).toBeNull();
        expect(await openIntegrationSecret(row.realm_id, ctxFor('realm_id'), NEW_ONLY)).toBeNull();
    });

    it('a tombstone written DURING the transition (Intuit refused the refresh) is fully under the new key', async () => {
        const s = fakeIntegrationDb();
        const i = fakeIntuit({ realmIds: [REALM_1], refreshError: 'invalid_grant' });
        let clock = Date.parse('2026-09-13T12:00:00Z');
        const deps = (env: NodeJS.ProcessEnv) => ({ db: s.db, fetchImpl: i.fetchImpl, env, now: () => clock, sleep: () => new Promise<void>((r) => setImmediate(r)) });
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', i.fetchImpl, () => clock);
        await saveAuthorizedConnection({ businessId: TENANT_A, realmId: REALM_1, tokens, config, authorizedByUserId: 'u' }, deps(OLD));
        clock += 61 * 60 * 1000;
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, deps(TRANSITION))).rejects.toMatchObject({ kind: 'reconnect_required' });
        expect(await loadQuickBooksConnection(TENANT_A, deps(NEW_ONLY))).toMatchObject({ kind: 'disconnected', reason: 'revoked', realmId: REALM_1 });
    });

    it('a same-company RECONNECT during the transition moves the row to the new key', async () => {
        const t = setup();
        await t.connect();
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-2', t.i.fetchImpl);
        expect(await saveAuthorizedConnection({ businessId: TENANT_A, realmId: REALM_1, tokens, config, authorizedByUserId: 'u' }, t.deps(TRANSITION))).toBe('connected');
        expect(await loadQuickBooksConnection(TENANT_A, t.deps(NEW_ONLY))).toMatchObject({ kind: 'connected', realmId: REALM_1 });
    });

    it('key format: a current key containing a comma or newline is refused (it could never be listed in _PREVIOUS); at most 4 previous keys are read', () => {
        const long = (c: string) => c.repeat(20);
        expect(integrationTokenKeys(sandboxEnv({ INTEGRATION_TOKEN_KEY: `${long('a')},${long('b')}` }))).toEqual([]);
        expect(integrationTokenKeys(sandboxEnv({ INTEGRATION_TOKEN_KEY: `${long('a')}\n${long('b')}` }))).toEqual([]);
        const { resolveQuickBooksConfig } = require('@/lib/quickbooks/config');
        expect(resolveQuickBooksConfig(sandboxEnv({ INTEGRATION_TOKEN_KEY: `${long('a')},${long('b')}` }))).toEqual({ enabled: false, reason: 'encryption_key_missing' });
        const previous = ['p', 'q', 'r', 's', 't'].map((c) => c.repeat(40)).join(',');
        expect(integrationTokenKeys(sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48), INTEGRATION_TOKEN_KEY_PREVIOUS: previous }))).toHaveLength(5);
    });

    it('the stored ciphertext carries no key identifier ("v1." is the format version), so migration can only be confirmed by opening with the new key alone', async () => {
        const t = setup();
        await t.connect();
        const row = t.s.rows.get(`${TENANT_A}|quickbooks`)!;
        for (const col of [row.access_token, row.refresh_token, row.realm_id]) expect(col!.split('.')).toHaveLength(3);
    });
});
