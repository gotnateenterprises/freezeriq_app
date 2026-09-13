/**
 * QB-INVOICE-1A — the four QuickBooks routes, executed for real.
 *
 * connect → Intuit (faked) → callback → stored connection → status → disconnect,
 * with the session, cookies, database and Intuit replaced by doubles that behave
 * like the real things. Every rejection test also proves the negative that
 * matters: no authorization code was exchanged and nothing was written.
 */

import { NextRequest } from 'next/server';
import { signOAuthState, verifyOAuthState } from '@/lib/auth/oauthState';
import { loadQuickBooksConnection } from '@/lib/quickbooks/connection';
import { QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER } from '@/lib/quickbooks/oauthAttempt';
import {
    LOCAL_REDIRECT, TEST_AUTH_SECRET, captureConsole, fakeIntegrationDb, fakeIntuit, sandboxEnv,
} from './helpers/quickbooksFakes';

// ── Doubles ────────────────────────────────────────────────────────────────
let store = fakeIntegrationDb();
jest.mock('@/lib/db', () => ({
    get prisma() { return store.db; },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

interface CookieWrite { name: string; value: string; options: any }
const jar = new Map<string, string>();
const cookieWrites: CookieWrite[] = [];
// Each request sees the cookies the browser SENT (a snapshot at the start of the
// request); a Set-Cookie only changes what later requests send. Two simultaneous
// requests therefore both carry the attempt cookie, as they would in a browser.
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

import { GET as connectGET } from '@/app/api/integrations/quickbooks/connect/route';
import { GET as callbackGET } from '@/app/api/integrations/quickbooks/callback/route';
import { POST as disconnectPOST } from '@/app/api/integrations/quickbooks/disconnect/route';
import { GET as statusGET } from '@/app/api/integrations/quickbooks/status/route';

const TENANT_A = 'biz-tenant-a';
const TENANT_B = 'biz-tenant-b';
const REALM_1 = '9130000000000001';
const REALM_2 = '9130000000000002';
const COOKIE = 'quickbooks_oauth_nonce';
const SECRET_PATTERN = /ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|TESTCLIENTSECRET|TESTTOKENKEY|TESTAUTHSECRET/;

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
const callbackReq = (qs: string, host = 'localhost:3000') =>
    new NextRequest(`http://${host}/api/integrations/quickbooks/callback?${qs}`, { headers: { host } });

/** Runs connect as the given session and returns the state it minted. */
async function startConnect(session = admin()): Promise<string> {
    mockAuth.mockResolvedValue(session);
    const res = await connectGET();
    expect(res.status).toBe(302);
    return new URL(res.headers.get('location')!).searchParams.get('state')!;
}

/** A genuine consent to `realmId` (unless `consentedRealm` says otherwise), then Intuit's redirect. */
async function completeCallback(state: string, realmId = REALM_1, session = admin(), extra = '', consentedRealm = realmId) {
    intuit.consentTo(consentedRealm);
    mockAuth.mockResolvedValue(session);
    return callbackGET(callbackReq(`code=AUTHCODE-ONE&state=${encodeURIComponent(state)}&realmId=${realmId}${extra}`));
}

/** Connection rows only (attempt rows are separate and expected). */
const connectionRows = () => [...store.rows.values()].filter((r) => r.provider === 'quickbooks');

const outcomeOf = (res: Response) => new URL(res.headers.get('location')!).searchParams.get('quickbooks');

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · connect route', () => {
    it('unauthenticated → 401, no cookie, no redirect to Intuit', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await connectGET();
        expect(res.status).toBe(401);
        expect(res.headers.get('location')).toBeNull();
        expect(cookieWrites).toHaveLength(0);
    });

    it.each(['CHEF', 'DRIVER', 'admin'])('role %s → 403', async (role) => {
        mockAuth.mockResolvedValue(admin(TENANT_A, { role }));
        const res = await connectGET();
        expect(res.status).toBe(403);
        expect(cookieWrites).toHaveLength(0);
    });

    it('a super admin viewing as a tenant → 403', async () => {
        mockAuth.mockResolvedValue(admin(TENANT_B, { baseBusinessId: TENANT_A, isViewingAsTenant: true, isSuperAdmin: true }));
        expect((await connectGET()).status).toBe(403);
    });

    it('Preview → 503 before any state, cookie or Intuit URL exists', async () => {
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        mockAuth.mockResolvedValue(admin());
        const res = await connectGET();
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ reason: 'preview_deployment' });
        expect(cookieWrites).toHaveLength(0);
    });

    it('Production (not enabled in this phase) → 503', async () => {
        useEnv({
            VERCEL: '1', VERCEL_ENV: 'production', QBO_ENVIRONMENT: 'production',
            QBO_REDIRECT_URI: 'https://www.freezeriqapp.com/api/integrations/quickbooks/callback',
        });
        mockAuth.mockResolvedValue(admin());
        const res = await connectGET();
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ reason: 'production_not_enabled' });
    });

    it('local development with Production credentials declared → 503', async () => {
        useEnv({ QBO_ENVIRONMENT: 'production' });
        mockAuth.mockResolvedValue(admin());
        expect((await connectGET()).status).toBe(503);
    });

    it('ADMIN → 302 to Intuit with ONLY the accounting scope and the configured callback', async () => {
        mockAuth.mockResolvedValue(admin());
        const res = await connectGET();
        expect(res.status).toBe(302);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const loc = new URL(res.headers.get('location')!);
        expect(`${loc.origin}${loc.pathname}`).toBe('https://appcenter.intuit.com/connect/oauth2');
        expect(loc.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
        expect(loc.searchParams.get('redirect_uri')).toBe(LOCAL_REDIRECT);
        expect(loc.toString()).not.toMatch(/payment|openid|TESTCLIENTSECRET/);
    });

    it('takes no request argument, so the Host header cannot influence the callback', () => {
        expect(connectGET.length).toBe(0);
    });

    it('the state is signed, 10-minute, bound to tenant + user, and its nonce is an httpOnly callback-scoped cookie', async () => {
        const before = Math.floor(Date.now() / 1000);
        const state = await startConnect();
        const verified = await verifyOAuthState(state, TEST_AUTH_SECRET, 'quickbooks');
        expect(verified).toMatchObject({ provider: 'quickbooks', businessId: TENANT_A, userId: `user-admin-${TENANT_A}` });
        expect(verified!.exp - before).toBeGreaterThanOrEqual(599);
        expect(verified!.exp - before).toBeLessThanOrEqual(601);

        const cookie = cookieWrites.find((c) => c.name === COOKIE)!;
        expect(cookie.value).toBe(verified!.nonce);
        expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/integrations/quickbooks/callback', maxAge: 600 });

        // The attempt is recorded server-side as a digest of the nonce — never the nonce itself.
        const attempt = store.rows.get(`${TENANT_A}|${QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER}`)!;
        expect(attempt.access_token).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(JSON.stringify(attempt)).not.toContain(verified!.nonce);
        expect(attempt.expires_at!.getTime()).toBe(verified!.exp * 1000);
    });

    it('a new connect supersedes the previous attempt', async () => {
        const first = await startConnect();
        await startConnect();
        // Even with the first attempt's cookie restored, the first state no longer completes.
        jar.set(COOKIE, (await verifyOAuthState(first, TEST_AUTH_SECRET, 'quickbooks'))!.nonce);
        expect(outcomeOf(await completeCallback(first))).toBe('invalid_state');
        expect(exchanges()).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · callback route — the happy path', () => {
    it('binds the connection to the session tenant with the realm Intuit returned, encrypted', async () => {
        const state = await startConnect();
        const res = await completeCallback(state);

        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('http://localhost:3000/settings?quickbooks=connected');
        expect(exchanges()).toHaveLength(1);
        const form = new URLSearchParams(exchanges()[0].body);
        expect(form.get('code')).toBe('AUTHCODE-ONE');
        expect(form.get('redirect_uri')).toBe(LOCAL_REDIRECT);

        expect([...store.rows.keys()]).toEqual([`${TENANT_A}|quickbooks`]);
        const row = store.rows.get(`${TENANT_A}|quickbooks`)!;
        expect(JSON.stringify(row)).not.toMatch(SECRET_PATTERN);
        expect(row.realm_id).not.toContain(REALM_1);
        const conn = await loadQuickBooksConnection(TENANT_A, { db: store.db, env: process.env });
        expect(conn).toMatchObject({ kind: 'connected', realmId: REALM_1, audit: { by: `user-admin-${TENANT_A}` } });

        expect(jar.has(COOKIE)).toBe(false); // cookie cleared
        expect(store.rows.has(`${TENANT_A}|${QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER}`)).toBe(false); // attempt consumed
    });

    it('the stored realm was verified with the new tokens before binding', async () => {
        await completeCallback(await startConnect());
        const check = intuit.companyInfoCalls()[0];
        expect(check.url).toContain(`/v3/company/${REALM_1}/companyinfo/${REALM_1}`);
        expect(check.headers.get('authorization')).toBe(`Bearer ${JSON.parse('"ACCESSTOKEN-SECRET-1"')}`);
    });

    it('a hostile Host header does not change where the browser is sent', async () => {
        const state = await startConnect();
        mockAuth.mockResolvedValue(admin());
        const res = await callbackGET(callbackReq(`code=AUTHCODE-ONE&state=${encodeURIComponent(state)}&realmId=${REALM_1}`, 'evil.example'));
        expect(res.headers.get('location')).toBe('http://localhost:3000/settings?quickbooks=connected');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · callback route — every rejection exchanges nothing and writes nothing', () => {
    const expectNothing = () => {
        expect(exchanges()).toHaveLength(0);
        expect(connectionRows()).toHaveLength(0);
    };

    it('missing state', async () => {
        await startConnect();
        mockAuth.mockResolvedValue(admin());
        const res = await callbackGET(callbackReq(`code=AUTHCODE-ONE&realmId=${REALM_1}`));
        expect(outcomeOf(res)).toBe('invalid_state');
        expectNothing();
    });

    it('malformed state', async () => {
        await startConnect();
        const res = await completeCallback('not-a-state');
        expect(outcomeOf(res)).toBe('invalid_state');
        expectNothing();
    });

    it('tampered state (tenant rewritten, signature kept)', async () => {
        const state = await startConnect();
        const [body, sig] = state.split('.');
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        const forged = `${Buffer.from(JSON.stringify({ ...payload, businessId: TENANT_B })).toString('base64url')}.${sig}`;
        const res = await completeCallback(forged, REALM_1, admin(TENANT_B, { id: payload.userId }));
        expect(outcomeOf(res)).toBe('invalid_state');
        expectNothing();
    });

    it('expired state', async () => {
        await startConnect();
        const nonce = jar.get(COOKIE)!;
        const expired = await signOAuthState({
            provider: 'quickbooks', businessId: TENANT_A, userId: `user-admin-${TENANT_A}`, nonce, exp: Math.floor(Date.now() / 1000) - 5,
        }, TEST_AUTH_SECRET);
        const res = await completeCallback(expired);
        expect(outcomeOf(res)).toBe('invalid_state');
        expectNothing();
    });

    it('a state minted for another provider (Stripe)', async () => {
        await startConnect();
        const nonce = jar.get(COOKIE)!;
        const stripe = await signOAuthState({
            provider: 'stripe', businessId: TENANT_A, userId: `user-admin-${TENANT_A}`, nonce, exp: Math.floor(Date.now() / 1000) + 600,
        }, TEST_AUTH_SECRET);
        expect(outcomeOf(await completeCallback(stripe))).toBe('invalid_state');
        expectNothing();
    });

    it('WRONG TENANT: tenant A’s state completed by tenant B’s admin', async () => {
        const state = await startConnect(admin(TENANT_A));
        const res = await completeCallback(state, REALM_1, admin(TENANT_B));
        expect(outcomeOf(res)).toBe('invalid_state');
        expectNothing();
    });

    it('WRONG TENANT for the SAME user id (the user’s tenant changed between connect and callback)', async () => {
        const userId = 'user-moved-between-tenants';
        const state = await startConnect(admin(TENANT_A, { id: userId }));
        const res = await completeCallback(state, REALM_1, admin(TENANT_B, { id: userId }));
        expect(outcomeOf(res)).toBe('invalid_state');
        expectNothing();
    });

    it('query parameters cannot name the tenant', async () => {
        const state = await startConnect(admin(TENANT_A));
        mockAuth.mockResolvedValue(admin(TENANT_A));
        const res = await callbackGET(callbackReq(
            `code=AUTHCODE-ONE&state=${encodeURIComponent(state)}&realmId=${REALM_1}&businessId=${TENANT_B}&business_id=${TENANT_B}&b=${TENANT_B}&tenant=${TENANT_B}`,
        ));
        expect(outcomeOf(res)).toBe('connected');
        expect([...store.rows.keys()]).toEqual([`${TENANT_A}|quickbooks`]);
    });

    it('the attempt cookie is expired (maxAge 0, callback path) once the attempt is spent — and left alone by a request that cannot prove it', async () => {
        const state = await startConnect();
        cookieWrites.length = 0;
        await completeCallback('not-a-state');
        expect(cookieWrites).toEqual([]);
        await completeCallback(state);
        expect(cookieWrites).toEqual([expect.objectContaining({
            name: COOKIE, value: '', options: expect.objectContaining({ maxAge: 0, path: '/api/integrations/quickbooks/callback', httpOnly: true }),
        })]);
    });

    it('WRONG USER: same tenant, a different admin’s session', async () => {
        const state = await startConnect(admin(TENANT_A));
        const res = await completeCallback(state, REALM_1, admin(TENANT_A, { id: 'user-other-admin' }));
        expect(outcomeOf(res)).toBe('invalid_state');
        expectNothing();
    });

    it('no attempt cookie (a different browser presents the URL)', async () => {
        const state = await startConnect();
        jar.clear();
        expect(outcomeOf(await completeCallback(state))).toBe('invalid_state');
        expectNothing();
    });

    it('a cookie from a different attempt', async () => {
        const state = await startConnect();
        jar.set(COOKIE, 'some-other-nonce-value');
        expect(outcomeOf(await completeCallback(state))).toBe('invalid_state');
        expectNothing();
    });

    it('REPLAY: the same callback URL a second time is refused; only one code exchange ever happens', async () => {
        const state = await startConnect();
        expect(outcomeOf(await completeCallback(state))).toBe('connected');
        const rowAfterFirst = { ...store.rows.get(`${TENANT_A}|quickbooks`)! };

        const replay = await completeCallback(state);
        expect(outcomeOf(replay)).toBe('invalid_state');
        expect(exchanges()).toHaveLength(1);
        expect(store.rows.get(`${TENANT_A}|quickbooks`)).toEqual(rowAfterFirst);
    });

    it('REPLAY with the cookie re-injected is still refused: the attempt is consumed once, so the code is never exchanged twice', async () => {
        const state = await startConnect();
        const nonce = jar.get(COOKIE)!;
        expect(outcomeOf(await completeCallback(state))).toBe('connected');
        jar.set(COOKIE, nonce);
        expect(outcomeOf(await completeCallback(state))).toBe('invalid_state');
        // Intuit may revoke the first grant if a code is exchanged twice.
        expect(exchanges()).toHaveLength(1);
    });

    it('a doubled browser redirect (two simultaneous callbacks, both carrying the cookie) exchanges once', async () => {
        const state = await startConnect();
        mockAuth.mockResolvedValue(admin());
        const qs = `code=AUTHCODE-ONE&state=${encodeURIComponent(state)}&realmId=${REALM_1}`;
        const results = await Promise.all([callbackGET(callbackReq(qs)), callbackGET(callbackReq(qs))]);
        expect(results.map(outcomeOf).sort()).toEqual(['connected', 'invalid_state']);
        expect(exchanges()).toHaveLength(1);
    });

    it('…and the same holds when the two callbacks land on DIFFERENT server instances', async () => {
        const state = await startConnect();
        mockAuth.mockResolvedValue(admin());
        const qs = `code=AUTHCODE-ONE&state=${encodeURIComponent(state)}&realmId=${REALM_1}`;
        const instances = await Promise.all([0, 1].map(() => new Promise<any>((resolve) =>
            jest.isolateModules(() => resolve(require('@/app/api/integrations/quickbooks/callback/route'))))));
        const results = await Promise.all(instances.map((m) => m.GET(callbackReq(qs))));
        expect(results.map(outcomeOf).sort()).toEqual(['connected', 'invalid_state']);
        expect(exchanges()).toHaveLength(1);
    });

    it('a realmId altered on the redirect (tokens are for a different company) is refused: nothing stored, nothing revoked', async () => {
        const state = await startConnect(admin(TENANT_B));
        const res = await completeCallback(state, REALM_2, admin(TENANT_B), '', REALM_1);
        expect(outcomeOf(res)).toBe('realm_unverified');
        expect(connectionRows()).toHaveLength(0);
        expect(intuit.revoked).toEqual([]);
    });

    it('a non-admin at the callback (role changed mid-flow)', async () => {
        const state = await startConnect();
        const res = await completeCallback(state, REALM_1, admin(TENANT_A, { role: 'CHEF' }));
        expect(outcomeOf(res)).toBe('forbidden');
        expectNothing();
    });

    it('unauthenticated at the callback', async () => {
        const state = await startConnect();
        mockAuth.mockResolvedValue(null);
        const res = await callbackGET(callbackReq(`code=AUTHCODE-ONE&state=${encodeURIComponent(state)}&realmId=${REALM_1}`));
        expect(outcomeOf(res)).toBe('session_required');
        expectNothing();
    });

    it('a callback on Preview is refused even with a valid state and cookie', async () => {
        const state = await startConnect();
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        const res = await completeCallback(state);
        expect(res.status).toBe(503);
        expectNothing();
    });

    it('a denial without any state is still just "denied" and does nothing', async () => {
        await startConnect();
        mockAuth.mockResolvedValue(admin());
        const res = await callbackGET(callbackReq('error=access_denied'));
        expect(outcomeOf(res)).toBe('denied');
        expectNothing();
    });

    it('the admin declined at Intuit', async () => {
        const state = await startConnect();
        mockAuth.mockResolvedValue(admin());
        const res = await callbackGET(callbackReq(`error=access_denied&state=${encodeURIComponent(state)}`));
        expect(outcomeOf(res)).toBe('denied');
        expectNothing();
    });

    it.each([
        ['non-numeric realm', 'code=AUTHCODE-ONE&realmId=abc'],
        ['path-like realm', 'code=AUTHCODE-ONE&realmId=1%2Fcompanyinfo%2F2'],
        ['missing realm', 'code=AUTHCODE-ONE'],
        ['missing code', `realmId=${REALM_1}`],
    ])('%s', async (_label, qs) => {
        const state = await startConnect();
        mockAuth.mockResolvedValue(admin());
        const res = await callbackGET(callbackReq(`${qs}&state=${encodeURIComponent(state)}`));
        expect(outcomeOf(res)).toBe('invalid_callback');
        expectNothing();
    });

    it('a failed code exchange stores nothing and logs no secret', async () => {
        intuit = fakeIntuit({ exchangeError: 'invalid_grant' });
        (global as any).fetch = intuit.fetchImpl;
        const state = await startConnect();
        const { result, output } = await captureConsole(() => completeCallback(state));
        expect(outcomeOf(result)).toBe('token_exchange_failed');
        expect(connectionRows()).toHaveLength(0);
        expect(output).not.toMatch(SECRET_PATTERN);
        expect(output).not.toContain('AUTHCODE');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · callback route — realm and tenant isolation', () => {
    it('a different company for an already-connected tenant is refused — and not revoked (revocation would cut that company off for everyone)', async () => {
        await completeCallback(await startConnect());
        const before = { ...store.rows.get(`${TENANT_A}|quickbooks`)! };

        const res = await completeCallback(await startConnect(), REALM_2);
        expect(outcomeOf(res)).toBe('realm_mismatch');
        expect(store.rows.get(`${TENANT_A}|quickbooks`)).toEqual(before);
        expect(intuit.revoked).toEqual([]);
    });

    it('tenant B cannot connect the company tenant A holds', async () => {
        await completeCallback(await startConnect(admin(TENANT_A)), REALM_1, admin(TENANT_A));
        const res = await completeCallback(await startConnect(admin(TENANT_B)), REALM_1, admin(TENANT_B));
        expect(outcomeOf(res)).toBe('realm_in_use');
        expect(store.rows.has(`${TENANT_B}|quickbooks`)).toBe(false);
        expect(intuit.revoked).toEqual([]); // revoking would disconnect tenant A
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · status route', () => {
    const statusAs = async (session: any) => {
        mockAuth.mockResolvedValue(session);
        const res = await statusGET();
        return { res, body: await res.json() };
    };

    it('401 unauthenticated, 403 non-admin', async () => {
        expect((await statusAs(null)).res.status).toBe(401);
        expect((await statusAs(admin(TENANT_A, { role: 'CHEF' }))).res.status).toBe(403);
    });

    it('disabled on Preview — and reveals nothing about a stored row', async () => {
        await completeCallback(await startConnect());
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        const before = intuit.companyInfoCalls().length;
        const { body } = await statusAs(admin());
        expect(body).toEqual({ state: 'disabled', reason: 'preview_deployment' });
        expect(intuit.companyInfoCalls()).toHaveLength(before);
    });

    it('not connected → connected (after a live CompanyInfo read) → tenant B still not connected', async () => {
        expect((await statusAs(admin())).body).toEqual({ state: 'not_connected', environment: 'sandbox' });
        await completeCallback(await startConnect());
        const before = intuit.companyInfoCalls().length;

        const { res, body } = await statusAs(admin());
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(body).toMatchObject({ state: 'connected', environment: 'sandbox', companyName: 'Sandbox Company 1' });
        expect(intuit.companyInfoCalls().slice(before).filter((c) => c.url.includes(`/v3/company/${REALM_1}/companyinfo/${REALM_1}`))).toHaveLength(1);

        const text = JSON.stringify(body);
        expect(text).not.toContain(REALM_1);
        expect(text).not.toMatch(/ACCESSTOKEN|REFRESHTOKEN|TESTCLIENTID|business|integration|realm/i);

        expect((await statusAs(admin(TENANT_B))).body).toEqual({ state: 'not_connected', environment: 'sandbox' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · disconnect route', () => {
    const post = async (session: any, body: any, contentType = 'application/json') => {
        mockAuth.mockResolvedValue(session);
        return disconnectPOST(new Request('http://localhost:3000/api/integrations/quickbooks/disconnect', {
            method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
        }));
    };

    it('401 / 403 / 415 / 400', async () => {
        expect((await post(null, {})).status).toBe(401);
        expect((await post(admin(TENANT_A, { role: 'DRIVER' }), {})).status).toBe(403);
        expect((await post(admin(), 'action=disconnect', 'application/x-www-form-urlencoded')).status).toBe(415);
        expect((await post(admin(), { action: 'delete_everything' })).status).toBe(400);
    });

    it('Preview → 503, the stored connection untouched', async () => {
        await completeCallback(await startConnect());
        const before = { ...store.rows.get(`${TENANT_A}|quickbooks`)! };
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        expect((await post(admin(), {})).status).toBe(503);
        expect(store.rows.get(`${TENANT_A}|quickbooks`)).toEqual(before);
        expect(intuit.revoked).toHaveLength(0);
    });

    it('ADMIN disconnect revokes and tombstones; status then says disconnected', async () => {
        await completeCallback(await startConnect());
        const res = await post(admin(), {});
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ outcome: 'disconnected', revoked: true });
        expect(intuit.revoked).toEqual(['REFRESHTOKEN-SECRET-1']);
        mockAuth.mockResolvedValue(admin());
        expect(await (await statusGET()).json()).toMatchObject({ state: 'disconnected', canForget: true });
    });

    it('the body cannot choose a tenant: a "victim" business id in the body is ignored', async () => {
        await completeCallback(await startConnect(admin(TENANT_B)), REALM_2, admin(TENANT_B));
        const victimBefore = { ...store.rows.get(`${TENANT_B}|quickbooks`)! };

        const res = await post(admin(TENANT_A), { action: 'disconnect', businessId: TENANT_B, business_id: TENANT_B, realmId: REALM_2 });
        expect(await res.json()).toEqual({ outcome: 'not_connected', revoked: null });
        expect(store.rows.get(`${TENANT_B}|quickbooks`)).toEqual(victimBefore);
        expect(intuit.revoked).toHaveLength(0);
    });

    it('forget is refused while connected and allowed after disconnect', async () => {
        await completeCallback(await startConnect());
        expect((await post(admin(), { action: 'forget' })).status).toBe(409);
        await post(admin(), {});
        const res = await post(admin(), { action: 'forget' });
        expect(await res.json()).toEqual({ outcome: 'forgotten' });
        expect(connectionRows()).toHaveLength(0);
    });

    it('full sandbox cycle through the routes: connect → disconnect → reconnect, one row, fresh tokens', async () => {
        await completeCallback(await startConnect());
        await post(admin(), {});
        expect(outcomeOf(await completeCallback(await startConnect()))).toBe('connected');
        expect(connectionRows()).toHaveLength(1);
        expect(store.rows.size).toBe(1); // no attempt rows left behind
        mockAuth.mockResolvedValue(admin());
        const before = intuit.companyInfoCalls().length;
        expect(await (await statusGET()).json()).toMatchObject({ state: 'connected' });
        const bearers = intuit.companyInfoCalls().slice(before).map((c) => c.headers.get('authorization'));
        expect(bearers).toEqual(['Bearer ACCESSTOKEN-SECRET-2']);
    });
});

describe('QB-INVOICE-1A · the whole route surface logs no secret', () => {
    it('connect, callback (good and bad), status, disconnect', async () => {
        const { output } = await captureConsole(async () => {
            const s = await startConnect();
            await completeCallback(s);
            await completeCallback(s); // replay
            await completeCallback(await startConnect(), REALM_2); // mismatch
            mockAuth.mockResolvedValue(admin());
            await statusGET();
            await disconnectPOST(new Request('http://localhost:3000/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
        });
        expect(output).not.toMatch(SECRET_PATTERN);
        expect(output).not.toContain('AUTHCODE');
        expect(output).not.toContain(REALM_1);
    });
});
