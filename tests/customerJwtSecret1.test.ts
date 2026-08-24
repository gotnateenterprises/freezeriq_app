/**
 * CUSTOMER-JWT-SECRET-1 — the storefront customer session signing key.
 *
 * THE FINDING
 *
 * lib/customerAuth.ts derived its signing key like this:
 *
 *     const SECRET_KEY = new TextEncoder().encode(
 *         process.env.JWT_SECRET || 'fallback_secret_for_development_only'
 *     );
 *
 * Three facts turn that `||` into a live vulnerability rather than a dev convenience:
 *
 *   1. JWT_SECRET is set in NO Vercel environment — production, preview or
 *      development (verified with `vercel env ls`, 0 matches in each).
 *   2. The GitHub repository is public, so the literal is readable by anyone.
 *   3. The key is read once at MODULE LOAD, so the deployed process signs and
 *      verifies every `freezeriq_customer_session` with that public string.
 *
 * Anyone could therefore mint a session for an arbitrary customerId.
 *
 * These tests execute the real module. The first one reconstructs the historical
 * behaviour and shows the forged token being accepted — kept permanently so the
 * regression is documented rather than remembered. The rest are written to the
 * secure expectation and fail against the vulnerable version.
 *
 * No real Production session is forged anywhere here; every token in this file is
 * minted locally against a local secret.
 */

import { SignJWT } from 'jose';

const PUBLIC_FALLBACK = 'fallback_secret_for_development_only';
const REAL_SECRET = 'test-customer-secret-not-a-real-one-0123456789';

// ── cookie jar double ──────────────────────────────────────────────────────
const jar = new Map<string, string>();
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined),
        set: (n: string, v: string) => { jar.set(n, v); },
        delete: (n: string) => { jar.delete(n); },
    }),
}));

const COOKIE = 'freezeriq_customer_session';

/** Sign a customer token with an arbitrary key, the way an attacker would. */
async function mint(secret: string, payload: any, opts: any = {}) {
    let t = new SignJWT(payload)
        .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
        .setIssuedAt();
    t = opts.exp ? t.setExpirationTime(opts.exp) : t.setExpirationTime('30d');
    return t.sign(new TextEncoder().encode(secret));
}

/**
 * Load lib/customerAuth.ts fresh under a given env. The module captures the key
 * at import time, so every case must re-import rather than reuse a cached copy.
 */
async function loadAuth(env: { JWT_SECRET?: string; NODE_ENV?: string }) {
    const prevSecret = process.env.JWT_SECRET;
    const prevNode = process.env.NODE_ENV;
    if (env.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = env.JWT_SECRET;
    if (env.NODE_ENV !== undefined) {
        Object.defineProperty(process.env, 'NODE_ENV', { value: env.NODE_ENV, configurable: true });
    }

    let mod: any;
    let loadError: any = null;
    jest.resetModules();
    try {
        mod = await import('@/lib/customerAuth');
    } catch (e) {
        loadError = e;
    }

    const restore = () => {
        if (prevSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = prevSecret;
        Object.defineProperty(process.env, 'NODE_ENV', { value: prevNode, configurable: true });
    };
    return { mod, loadError, restore };
}

beforeEach(() => { jar.clear(); });

// ═══════════════════════════════════════════════════════════════════════════
// PART B — reproduce, then close
// ═══════════════════════════════════════════════════════════════════════════

describe('PART B — the public fallback key', () => {
    it('the HISTORICAL implementation accepts a token signed with the public literal', async () => {
        // Reconstructed verbatim: the exact key derivation the deployed code used.
        const { jwtVerify } = await import('jose');
        const historicalKey = new TextEncoder().encode(
            process.env.JWT_SECRET || PUBLIC_FALLBACK,
        );

        const forged = await mint(PUBLIC_FALLBACK, {
            customerId: 'victim-customer', email: 'victim@example.com', businessId: 'biz-a',
        });

        const { payload } = await jwtVerify(forged, historicalKey);
        expect(payload.customerId).toBe('victim-customer');   // <- the vulnerability
    });

    it('the fixed module REJECTS that same forged token', async () => {
        const forged = await mint(PUBLIC_FALLBACK, {
            customerId: 'victim-customer', email: 'victim@example.com', businessId: 'biz-a',
        });
        jar.set(COOKIE, forged);

        const { mod, restore } = await loadAuth({ JWT_SECRET: REAL_SECRET });
        try {
            expect(await mod.getCustomerSession()).toBeNull();
        } finally { restore(); }
    });

    it('the literal appears nowhere in executable code', async () => {
        // The header comment documents the removed fallback on purpose, so the
        // property being asserted is that it is not CODE — not that the string
        // never occurs in the file.
        const src: string = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib/customerAuth.ts'), 'utf8',
        );
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split(/\r?\n/)
            .filter((l) => !/^\s*(\/\/|\*)/.test(l))
            .join('\n');

        expect(code).not.toContain(PUBLIC_FALLBACK);
        expect(code).not.toMatch(/process\.env\.JWT_SECRET\s*\|\|/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D / E — fail closed when the secret is absent
// ═══════════════════════════════════════════════════════════════════════════

describe('PART D — a missing JWT_SECRET fails closed', () => {
    it('signing refuses when JWT_SECRET is unset in production', async () => {
        const { mod, loadError, restore } = await loadAuth({ JWT_SECRET: undefined, NODE_ENV: 'production' });
        try {
            if (loadError) {
                expect(String(loadError)).toMatch(/JWT_SECRET/);
                return;
            }
            await expect(mod.createCustomerSession({
                customerId: 'c1', email: 'e@t.test', businessId: 'b1',
            })).rejects.toThrow(/JWT_SECRET/);
        } finally { restore(); }
    });

    it('verification refuses when JWT_SECRET is unset in production', async () => {
        jar.set(COOKIE, await mint(PUBLIC_FALLBACK, { customerId: 'x', email: 'e', businessId: 'b' }));

        const { mod, loadError, restore } = await loadAuth({ JWT_SECRET: undefined, NODE_ENV: 'production' });
        try {
            if (loadError) {
                expect(String(loadError)).toMatch(/JWT_SECRET/);
                return;
            }
            expect(await mod.getCustomerSession()).toBeNull();
        } finally { restore(); }
    });

    it('it does NOT invent a random per-process key, which would break multi-instance sessions', async () => {
        // Two independent loads with the SAME configured secret must interoperate.
        const a = await loadAuth({ JWT_SECRET: REAL_SECRET });
        await a.mod.createCustomerSession({ customerId: 'c9', email: 'e@t.test', businessId: 'b1' });
        const token = jar.get(COOKIE)!;
        a.restore();

        const b = await loadAuth({ JWT_SECRET: REAL_SECRET });
        try {
            jar.set(COOKIE, token);
            const s = await b.mod.getCustomerSession();
            expect(s?.customerId).toBe('c9');
        } finally { b.restore(); }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART F — token validation contract
// ═══════════════════════════════════════════════════════════════════════════

describe('PART F — verification contract', () => {
    const withAuth = async (fn: (mod: any) => Promise<void>) => {
        const { mod, restore } = await loadAuth({ JWT_SECRET: REAL_SECRET });
        try { await fn(mod); } finally { restore(); }
    };

    it('a valid token signed with the configured secret works', async () => {
        await withAuth(async (mod) => {
            await mod.createCustomerSession({ customerId: 'c1', email: 'a@t.test', businessId: 'b1' });
            const s = await mod.getCustomerSession();
            expect(s).toMatchObject({ customerId: 'c1', email: 'a@t.test', businessId: 'b1' });
        });
    });

    it('a token signed with the WRONG secret is rejected', async () => {
        jar.set(COOKIE, await mint('some-other-secret', { customerId: 'c1', email: 'a', businessId: 'b' }));
        await withAuth(async (mod) => expect(await mod.getCustomerSession()).toBeNull());
    });

    it('a tampered token is rejected', async () => {
        await withAuth(async (mod) => {
            await mod.createCustomerSession({ customerId: 'c1', email: 'a@t.test', businessId: 'b1' });
            const [h, p, s] = jar.get(COOKIE)!.split('.');
            const body = JSON.parse(Buffer.from(p, 'base64url').toString());
            body.customerId = 'someone-else';
            jar.set(COOKIE, h + '.' + Buffer.from(JSON.stringify(body)).toString('base64url') + '.' + s);

            expect(await mod.getCustomerSession()).toBeNull();
        });
    });

    it('customer A cannot become customer B by editing the payload', async () => {
        // The same claim as above, stated as the attack it actually is.
        await withAuth(async (mod) => {
            await mod.createCustomerSession({ customerId: 'customer-A', email: 'a@t.test', businessId: 'b1' });
            const [h, p, s] = jar.get(COOKIE)!.split('.');
            const body = JSON.parse(Buffer.from(p, 'base64url').toString());
            body.customerId = 'customer-B';
            jar.set(COOKIE, h + '.' + Buffer.from(JSON.stringify(body)).toString('base64url') + '.' + s);

            const forgedSession = await mod.getCustomerSession();
            expect(forgedSession).toBeNull();
            expect(forgedSession?.customerId).not.toBe('customer-B');
        });
    });

    it('an expired token is rejected', async () => {
        jar.set(COOKIE, await mint(REAL_SECRET,
            { customerId: 'c1', email: 'a', businessId: 'b' }, { exp: '-1h' }));
        await withAuth(async (mod) => expect(await mod.getCustomerSession()).toBeNull());
    });

    it('a DIFFERENT HMAC variant signed with the same secret is rejected', async () => {
        // This is what the explicit `algorithms: ['HS256']` option actually buys.
        // jose already refuses `alg: none` and rejects key-type confusion on its
        // own, so those cases pass with or without the option — but a symmetric
        // key is valid for HS256/384/512 alike, so without pinning an HS384 token
        // minted with the same secret would verify. The system issues exactly one
        // algorithm and should accept exactly that one.
        jar.set(COOKIE, await mint(REAL_SECRET,
            { customerId: 'c1', email: 'a@t.test', businessId: 'b1' }, { alg: 'HS384' }));

        await withAuth(async (mod) => expect(await mod.getCustomerSession()).toBeNull());
    });

    it('an unsigned "alg: none" token is rejected', async () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const body = Buffer.from(JSON.stringify({
            customerId: 'victim', email: 'v@t.test', businessId: 'b1',
            exp: Math.floor(Date.now() / 1000) + 3600,
        })).toString('base64url');
        jar.set(COOKIE, header + '.' + body + '.');

        await withAuth(async (mod) => expect(await mod.getCustomerSession()).toBeNull());
    });

    it('malformed tokens are rejected without throwing', async () => {
        await withAuth(async (mod) => {
            for (const bad of ['', 'x', 'a.b', 'a.b.c', '...', 'x'.repeat(5000)]) {
                jar.set(COOKIE, bad);
                expect(await mod.getCustomerSession()).toBeNull();
            }
        });
    });

    it('a token with a valid signature but a malformed payload shape is rejected', async () => {
        // The verifier used to cast the payload straight to CustomerSessionPayload,
        // so a correctly-signed token with no customerId became a session object
        // whose customerId was undefined.
        for (const claims of [{}, { customerId: 123 }, { customerId: '' }, { customerId: { id: 'x' } }, { email: 'a@t.test' }]) {
            jar.set(COOKIE, await mint(REAL_SECRET, claims));
            await withAuth(async (mod) => expect(await mod.getCustomerSession()).toBeNull());
        }
    });

    it('no session cookie means no session', async () => {
        await withAuth(async (mod) => expect(await mod.getCustomerSession()).toBeNull());
    });

    it('logout clears the cookie', async () => {
        await withAuth(async (mod) => {
            await mod.createCustomerSession({ customerId: 'c1', email: 'a@t.test', businessId: 'b1' });
            expect(jar.has(COOKIE)).toBe(true);
            await mod.destroyCustomerSession();
            expect(jar.has(COOKIE)).toBe(false);
            expect(await mod.getCustomerSession()).toBeNull();
        });
    });
});
