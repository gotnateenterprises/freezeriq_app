/**
 * FR-COORD-SEC-1D-L-R — the two contracts an adversarial review found unguarded.
 *
 * R2 — the cookie the browser is actually sent when a coordinator logs out.
 *      `store.delete()` serialises WITHOUT Secure, and a `__Host-` prefixed
 *      cookie without Secure is rejected outright, so the deletion is discarded
 *      and the real cookie survives its full TTL. These tests drive the shipped
 *      helpers through the REAL Next cookie serialiser and assert the bytes.
 *
 * R3 — that ordinary logout revokes ONE session. The previous suite could not
 *      tell current-session revocation from campaign-wide revocation: swapping
 *      them left every test green, which would mean one coordinator signing out
 *      on their phone knocked out every other device on the campaign.
 */
import { createHash } from 'node:crypto';

// The real serialiser Next ships — not a hand-rolled stand-in.
const { ResponseCookies } = require('next/dist/compiled/@edge-runtime/cookies');

/** Order of side effects, so "revoke before clear" is observable. */
const mockCallLog: string[] = [];

const mockPrisma = {
    coordinatorSession: {
        updateMany: jest.fn(async () => { mockCallLog.push('revoke'); return { count: 1 }; }),
        // Deliberately resolvable. A campaign-wide mutation of the logout path
        // must get far enough to issue its updateMany, so the assertions below
        // catch it on its FILTER rather than on a call that never happened.
        findUnique: jest.fn(async () => ({
            id: 'session-under-test',
            campaign_id: 'campaign-under-test',
            expires_at: new Date(Date.now() + 3_600_000),
            revoked_at: null,
        })),
        create: jest.fn(async () => ({})),
        update: jest.fn(async () => ({})),
    },
};
jest.mock('@/lib/db', () => ({ prisma: mockPrisma }));

/** Incoming request cookies for the call under test. */
const mockRequestCookies = new Map<string, string>();
/** Response headers the helpers write into. */
let mockResponseHeaders: Headers;
let mockStore: any;

jest.mock('next/headers', () => ({ cookies: async () => mockStore }));

import {
    setCoordinatorSessionCookie,
    clearCoordinatorSessionCookie,
    revokeCurrentCoordinatorSession,
    coordinatorSessionCookieName,
    hashCoordinatorSessionSecret,
    COORDINATOR_SESSION_COOKIE,
    COORDINATOR_SESSION_COOKIE_DEV,
} from '@/lib/coordinatorSession';

const ORIGINAL_ENV = process.env.NODE_ENV;
const setEnv = (v: string) => { (process.env as any).NODE_ENV = v; };

beforeEach(() => {
    mockCallLog.length = 0;
    mockRequestCookies.clear();
    mockResponseHeaders = new Headers();
    const response = new ResponseCookies(mockResponseHeaders);
    mockStore = {
        get: (name: string) =>
            mockRequestCookies.has(name) ? { name, value: mockRequestCookies.get(name) } : undefined,
        set: (...args: any[]) => { mockCallLog.push('clear-or-set'); return response.set(...args); },
        delete: (...args: any[]) => { mockCallLog.push('clear-or-set'); return response.delete(...args); },
    };
    mockPrisma.coordinatorSession.updateMany.mockClear();
    mockPrisma.coordinatorSession.updateMany.mockImplementation(async () => {
        mockCallLog.push('revoke');
        return { count: 1 };
    });
});

afterEach(() => { setEnv(ORIGINAL_ENV as string); });

/** The single Set-Cookie header produced by the call under test. */
const emitted = () => {
    const all = mockResponseHeaders.getSetCookie();
    expect(all).toHaveLength(1);
    return all[0];
};
const attrs = (header: string) => {
    const parts = header.split(';').map((s) => s.trim());
    return {
        nameValue: parts[0],
        has: (a: string) => parts.some((p) => p.toLowerCase() === a.toLowerCase()),
        get: (a: string) => {
            const hit = parts.find((p) => p.toLowerCase().startsWith(`${a.toLowerCase()}=`));
            return hit ? hit.slice(a.length + 1) : null;
        },
    };
};

// ── R2: the production clear cookie ──────────────────────────────────────────

describe('clearing the coordinator session cookie in production', () => {
    beforeEach(() => setEnv('production'));

    it('targets the __Host- prefixed production cookie with an empty value', () => {
        expect(coordinatorSessionCookieName()).toBe(COORDINATOR_SESSION_COOKIE);
        expect(COORDINATOR_SESSION_COOKIE).toBe('__Host-freezeriq_coordinator_session');
    });

    it('carries every attribute the __Host- prefix requires, or the browser rejects it', async () => {
        await clearCoordinatorSessionCookie();
        const a = attrs(emitted());

        expect(a.nameValue).toBe('__Host-freezeriq_coordinator_session=');
        // The three prefix preconditions. Missing ANY of them means the browser
        // discards the deletion and keeps the live cookie.
        expect(a.has('Secure')).toBe(true);
        expect(a.get('Path')).toBe('/');
        expect(a.get('Domain')).toBeNull();
    });

    it('keeps the rest of the scope identical to how it was set', async () => {
        await clearCoordinatorSessionCookie();
        const a = attrs(emitted());

        expect(a.has('HttpOnly')).toBe(true);
        expect(String(a.get('SameSite')).toLowerCase()).toBe('lax');
    });

    it('expires immediately, by Max-Age and by a past Expires', async () => {
        await clearCoordinatorSessionCookie();
        const a = attrs(emitted());

        expect(a.get('Max-Age')).toBe('0');
        expect(new Date(String(a.get('Expires'))).getTime()).toBe(0);
    });

    it('matches the scope the setter uses — set and clear cannot drift', async () => {
        await setCoordinatorSessionCookie('a'.repeat(43));
        const setHeader = attrs(emitted());

        mockResponseHeaders = new Headers();
        const response = new ResponseCookies(mockResponseHeaders);
        mockStore.set = (...args: any[]) => response.set(...args);
        await clearCoordinatorSessionCookie();
        const clearHeader = attrs(emitted());

        for (const attr of ['Secure', 'HttpOnly'] as const) {
            expect(clearHeader.has(attr)).toBe(setHeader.has(attr));
        }
        expect(clearHeader.get('Path')).toBe(setHeader.get('Path'));
        expect(clearHeader.get('SameSite')).toBe(setHeader.get('SameSite'));
        expect(clearHeader.get('Domain')).toBe(setHeader.get('Domain'));
    });

    it('does not leak the previous secret into the clearing header', async () => {
        const secret = 'z'.repeat(43);
        mockRequestCookies.set(COORDINATOR_SESSION_COOKIE, secret);
        await clearCoordinatorSessionCookie();

        expect(emitted()).not.toContain(secret);
    });
});

// ── R2: development keeps its own, correct contract ──────────────────────────

describe('clearing the coordinator session cookie in development', () => {
    beforeEach(() => setEnv('development'));

    it('targets the unprefixed dev cookie and omits Secure, which cannot work over http', async () => {
        expect(coordinatorSessionCookieName()).toBe(COORDINATOR_SESSION_COOKIE_DEV);

        await clearCoordinatorSessionCookie();
        const a = attrs(emitted());

        expect(a.nameValue).toBe('freezeriq_coordinator_session_dev=');
        expect(a.has('Secure')).toBe(false);
        // Everything else still matches, so the deletion is accepted locally.
        expect(a.has('HttpOnly')).toBe(true);
        expect(a.get('Path')).toBe('/');
        expect(a.get('Max-Age')).toBe('0');
    });
});

// ── R3: ordinary logout revokes exactly one session ──────────────────────────

describe('revoking the current coordinator session', () => {
    const SECRET = 'q'.repeat(43);
    beforeEach(() => {
        setEnv('production');
        mockRequestCookies.set(COORDINATOR_SESSION_COOKIE, SECRET);
    });

    it('filters on the digest of THIS session secret', async () => {
        await revokeCurrentCoordinatorSession();

        expect(mockPrisma.coordinatorSession.updateMany).toHaveBeenCalledTimes(1);
        const arg = mockPrisma.coordinatorSession.updateMany.mock.calls[0][0] as any;
        expect(arg.where.session_hash).toBe(createHash('sha256').update(SECRET, 'utf8').digest('hex'));
        expect(arg.where.session_hash).toBe(hashCoordinatorSessionSecret(SECRET));
        expect(arg.data.revoked_at).toBeInstanceOf(Date);
    });

    it('never scopes revocation by campaign — that is rotation, not logout', async () => {
        await revokeCurrentCoordinatorSession();

        const arg = mockPrisma.coordinatorSession.updateMany.mock.calls[0][0] as any;
        expect(Object.keys(arg.where)).toEqual(expect.arrayContaining(['session_hash']));
        expect(arg.where).not.toHaveProperty('campaign_id');
        expect(JSON.stringify(arg.where)).not.toContain('campaign');
    });

    it('only touches sessions that are still live', async () => {
        await revokeCurrentCoordinatorSession();

        const arg = mockPrisma.coordinatorSession.updateMany.mock.calls[0][0] as any;
        expect(arg.where.revoked_at).toBeNull();
    });

    it('revokes on the server BEFORE clearing the browser cookie', async () => {
        await revokeCurrentCoordinatorSession();

        expect(mockCallLog).toEqual(['revoke', 'clear-or-set']);
    });

    it('leaves the cookie in place when revocation fails, so a retry can still find it', async () => {
        mockPrisma.coordinatorSession.updateMany.mockImplementation(async () => {
            throw new Error('database unavailable');
        });

        await expect(revokeCurrentCoordinatorSession()).rejects.toThrow();
        expect(mockResponseHeaders.getSetCookie()).toHaveLength(0);
    });

    it('is safe with no cookie at all, and issues no revocation', async () => {
        mockRequestCookies.clear();

        await expect(revokeCurrentCoordinatorSession()).resolves.toBeUndefined();
        expect(mockPrisma.coordinatorSession.updateMany).not.toHaveBeenCalled();
        // The cookie is still cleared, so the browser ends up unauthenticated.
        expect(mockResponseHeaders.getSetCookie()).toHaveLength(1);
    });
});
