/**
 * SEC-OAUTH-CALLBACK-1 — a payment integration may only ever be bound to the
 * tenant whose authorised connect attempt produced the callback.
 *
 * THE FINDING
 *
 * app/api/auth/stripe/callback/route.ts had no `auth()` call and took the target
 * tenant straight from the URL:
 *
 *     const accountId  = url.searchParams.get('account_id');
 *     const businessId = url.searchParams.get('business_id');
 *     ...
 *     await prisma.integration.upsert({
 *         where: { business_id_provider: { business_id: businessId, provider: 'stripe' } },
 *         ...  access_token: accountId
 *
 * Whoever calls that URL chooses which tenant receives which Stripe account.
 * `access_token` on a Stripe integration is the connected account id — the
 * account that receives money — so mis-binding it is payment redirection, not
 * just a data-integrity problem.
 *
 * WHY IT IS REACHABLE. The initiation route is authenticated, but it hands the
 * browser a return_url containing both parameters in plain sight, and the
 * callback re-reads them from whatever URL is actually requested. A tenant who
 * has ever connected Stripe knows a valid `acct_…` that `accounts.retrieve`
 * accepts, and can then replay the callback with someone else's business id.
 * Nothing about the request has to come from Stripe at all.
 *
 * The `!details_submitted` branch upserts too, so the attack does not even
 * require a completed onboarding.
 *
 * These tests execute the real handlers. They are written to the SECURE
 * expectation, so before the fix they fail — which is the proof.
 *
 * SQUARE is covered here too, and is deliberately asserted to be ALREADY safe:
 * it mints a server-side state, stores it in an httpOnly cookie, and refuses any
 * callback whose state does not equal the cookie. Those tests must pass both
 * before and after this phase — they are a guard against "fixing" it by
 * accident and against a future regression.
 */

process.env.AUTH_SECRET = 'test-secret-sec-oauth-1';
process.env.NEXTAUTH_URL = 'https://app.test';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
process.env.SQUARE_APP_ID = 'sq-app';
process.env.SQUARE_APP_SECRET = 'sq-secret';

const TENANT_A = 'biz-aaaa-1111';   // the attacker's own tenant
const VICTIM = 'biz-bbbb-2222';     // the tenant they try to hijack

// ── Prisma double ──────────────────────────────────────────────────────────
const writes: Array<{ model: string; op: string; args: any }> = [];
const rec = (model: string, op: string, ret: any) =>
    jest.fn(async (args: any) => {
        writes.push({ model, op, args });
        return typeof ret === 'function' ? ret(args) : ret;
    });

jest.mock('@/lib/db', () => ({
    prisma: {
        integration: { upsert: rec('integration', 'upsert', {}) },
        storefrontConfig: { upsert: rec('storefrontConfig', 'upsert', {}) },
        business: {
            // `integrations` must be present: the Stripe initiation route selects
            // it and immediately calls .find(), so omitting it makes the route
            // throw and the assertions pass for the wrong reason.
            findUnique: rec('business', 'findUnique', (a: any) => ({
                id: a?.where?.id, name: 'Biz', integrations: [],
            })),
        },
        user: {
            findUnique: rec('user', 'findUnique', () => ({
                id: 'user-attacker', business_id: TENANT_A,
                business: { id: TENANT_A, name: 'Tenant A', integrations: [] },
            })),
        },
    },
}));

// ── Stripe double ──────────────────────────────────────────────────────────
const accountsRetrieve = jest.fn();
const accountsCreate = jest.fn(async () => ({ id: 'acct_new' }));
const accountLinksCreate = jest.fn(async () => ({ url: 'https://connect.stripe.test/onboard' }));

jest.mock('@/lib/stripe', () => ({
    stripe: {
        accounts: {
            retrieve: (...a: any[]) => accountsRetrieve(...a),
            create: (...a: any[]) => accountsCreate(...(a as [])),
        },
        accountLinks: { create: (...a: any[]) => accountLinksCreate(...(a as [])) },
    },
}));

// ── Square SDK double ──────────────────────────────────────────────────────
const obtainToken = jest.fn(async () => ({
    accessToken: 'sq-access', refreshToken: 'sq-refresh', expiresAt: undefined,
}));
jest.mock('square', () => ({
    SquareClient: class { oAuth = { obtainToken: (...a: any[]) => obtainToken(...(a as [])) }; },
    SquareEnvironment: { Production: 'production', Sandbox: 'sandbox' },
}));

// ── Cookie store double ────────────────────────────────────────────────────
const cookieJar = new Map<string, string>();
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
        set: (n: string, v: string) => { cookieJar.set(n, v); },
        delete: (n: string) => { cookieJar.delete(n); },
    }),
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const session = (businessId: string | undefined, extra: any = {}) => ({
    user: { id: 'user-attacker', email: 'a@t.test', businessId, isSuperAdmin: false, ...extra },
});

const integrationWrites = () => writes.filter((w) => w.model === 'integration');
const tenantsWritten = () => integrationWrites()
    .map((w) => w.args?.where?.business_id_provider?.business_id ?? w.args?.create?.business_id)
    .filter(Boolean);

beforeEach(() => {
    writes.length = 0;
    cookieJar.clear();
    mockAuth.mockReset();
    accountsRetrieve.mockReset();
    accountsRetrieve.mockResolvedValue({
        id: 'acct_attacker', details_submitted: true, metadata: { businessId: TENANT_A },
    });
    obtainToken.mockClear();
});

const stripeCallback = async (qs: string) => {
    const { GET } = await import('@/app/api/auth/stripe/callback/route');
    return GET(new Request('https://app.test/api/auth/stripe/callback?' + qs));
};

// ═══════════════════════════════════════════════════════════════════════════
// PART B — the Stripe finding
// ═══════════════════════════════════════════════════════════════════════════

describe('Stripe callback: a URL parameter may not choose the tenant', () => {
    it('an UNAUTHENTICATED caller cannot bind an account to an arbitrary tenant', async () => {
        mockAuth.mockResolvedValue(null);

        await stripeCallback(`account_id=acct_attacker&business_id=${VICTIM}`);

        expect(tenantsWritten()).not.toContain(VICTIM);
        expect(integrationWrites()).toHaveLength(0);
    });

    it('a signed-in Tenant A user cannot redirect the binding to the victim tenant', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));

        await stripeCallback(`account_id=acct_attacker&business_id=${VICTIM}`);

        expect(tenantsWritten()).not.toContain(VICTIM);
    });

    it('the incomplete-onboarding branch is not a bypass', async () => {
        // details_submitted:false still upserted, so the attack never needed a
        // finished onboarding.
        accountsRetrieve.mockResolvedValue({
            id: 'acct_attacker', details_submitted: false, metadata: { businessId: TENANT_A },
        });
        mockAuth.mockResolvedValue(null);

        await stripeCallback(`account_id=acct_attacker&business_id=${VICTIM}`);

        expect(integrationWrites()).toHaveLength(0);
    });

    it('no state at all is rejected outright', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        const res = await stripeCallback(`account_id=acct_attacker&business_id=${TENANT_A}`);

        expect(integrationWrites()).toHaveLength(0);
        expect(res.status).toBeGreaterThanOrEqual(300);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTS G / H / J / L — the signed state is the only tenant authority
// ═══════════════════════════════════════════════════════════════════════════

describe('Stripe callback: state binding', () => {
    const SECRET = process.env.AUTH_SECRET as string;

    const mkState = async (over: any = {}) => {
        const { signOAuthState, OAUTH_STATE_TTL_SECONDS } = await import('@/lib/auth/oauthState');
        return signOAuthState({
            provider: over.provider ?? 'stripe',
            businessId: over.businessId ?? TENANT_A,
            userId: over.userId ?? 'user-attacker',
            accountId: over.accountId ?? 'acct_attacker',
            nonce: 'n1',
            exp: over.exp ?? Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
        }, over.secret ?? SECRET);
    };

    it('a valid authorised flow binds to the tenant inside the state', async () => {
        const st = await mkState({ businessId: TENANT_A });
        await stripeCallback('state=' + encodeURIComponent(st));

        expect(tenantsWritten()).toEqual([TENANT_A]);
    });

    it('a query business_id cannot override the state — the original exploit', async () => {
        const st = await mkState({ businessId: TENANT_A });
        await stripeCallback(
            'state=' + encodeURIComponent(st) + `&business_id=${VICTIM}&account_id=acct_evil`,
        );

        expect(tenantsWritten()).toEqual([TENANT_A]);
        expect(tenantsWritten()).not.toContain(VICTIM);
        // The account written is the one the STATE pinned, not the query's.
        expect(integrationWrites()[0].args.create.access_token).toBe('acct_attacker');
    });

    // NOTE ON ISOLATION. These three negative tests deliberately keep
    // businessId === TENANT_A, matching the account metadata the default mock
    // returns. Earlier drafts used VICTIM, which the metadata corroboration
    // rejected on its own — so deleting the signature check or the provider
    // binding changed nothing and both mutants survived. A negative test has to
    // be built so that ONLY the property under test can cause the rejection,
    // otherwise defence-in-depth layers mask each other.
    it('a state signed with the wrong secret is rejected', async () => {
        const st = await mkState({ secret: 'attacker-secret', businessId: TENANT_A });
        await stripeCallback('state=' + encodeURIComponent(st));
        expect(integrationWrites()).toHaveLength(0);
    });

    it('a tampered state body is rejected', async () => {
        // Tamper the ACCOUNT, keeping the tenant identical, so the metadata
        // check cannot be what rejects this.
        const st = await mkState({ businessId: TENANT_A, accountId: 'acct_attacker' });
        const [body, sig] = st.split('.');
        const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
        decoded.accountId = 'acct_evil';
        const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + sig;

        await stripeCallback('state=' + encodeURIComponent(forged));
        expect(integrationWrites()).toHaveLength(0);
    });

    it('an expired state is rejected', async () => {
        const st = await mkState({ exp: Math.floor(Date.now() / 1000) - 1 });
        await stripeCallback('state=' + encodeURIComponent(st));
        expect(integrationWrites()).toHaveLength(0);
    });

    it('a SQUARE state presented at the Stripe callback is rejected', async () => {
        // Same tenant as the account metadata, so only the provider binding can
        // be what refuses it.
        const st = await mkState({ provider: 'square', businessId: TENANT_A });
        await stripeCallback('state=' + encodeURIComponent(st));
        expect(integrationWrites()).toHaveLength(0);
    });

    it('malformed states are rejected without writing', async () => {
        for (const bad of ['', '.', 'a.', '.b', 'no-dot', 'a.b.c', 'x'.repeat(5000)]) {
            await stripeCallback('state=' + encodeURIComponent(bad));
        }
        expect(integrationWrites()).toHaveLength(0);
    });

    it('a state whose cookie is present but different is rejected', async () => {
        const st = await mkState({ businessId: TENANT_A });
        cookieJar.set('stripe_oauth_state', await mkState({ businessId: VICTIM }));

        await stripeCallback('state=' + encodeURIComponent(st));
        expect(integrationWrites()).toHaveLength(0);
    });

    it('a matching cookie is accepted and then consumed', async () => {
        const st = await mkState({ businessId: TENANT_A });
        cookieJar.set('stripe_oauth_state', st);

        await stripeCallback('state=' + encodeURIComponent(st));

        expect(tenantsWritten()).toEqual([TENANT_A]);
        expect(cookieJar.has('stripe_oauth_state')).toBe(false);
    });

    it('Stripe refuses an account whose metadata names a DIFFERENT tenant', async () => {
        // Server-to-server corroboration: Stripe itself says this account was
        // created for another business.
        accountsRetrieve.mockResolvedValue({
            id: 'acct_attacker', details_submitted: true, metadata: { businessId: VICTIM },
        });
        const st = await mkState({ businessId: TENANT_A });

        await stripeCallback('state=' + encodeURIComponent(st));
        expect(integrationWrites()).toHaveLength(0);
    });

    it('an account with NO metadata still works, covered by the signed state', async () => {
        // Accounts created before the metadata stamp existed must stay connectable.
        accountsRetrieve.mockResolvedValue({ id: 'acct_legacy', details_submitted: true, metadata: {} });
        const st = await mkState({ businessId: TENANT_A, accountId: 'acct_legacy' });

        await stripeCallback('state=' + encodeURIComponent(st));
        expect(tenantsWritten()).toEqual([TENANT_A]);
    });

    it('PART H — replay is idempotent, so no single-use nonce is required', async () => {
        const st = await mkState({ businessId: TENANT_A, accountId: 'acct_attacker' });

        await stripeCallback('state=' + encodeURIComponent(st));
        await stripeCallback('state=' + encodeURIComponent(st));
        await stripeCallback('state=' + encodeURIComponent(st));

        // Every replay re-asserts the SAME account against the SAME tenant.
        const rows = integrationWrites();
        expect(rows.length).toBe(3);
        for (const r of rows) {
            expect(r.args.where.business_id_provider.business_id).toBe(TENANT_A);
            expect(r.args.update.access_token).toBe('acct_attacker');
        }
        expect(tenantsWritten()).not.toContain(VICTIM);
    });

    it('a provider error is not leaked to the browser', async () => {
        accountsRetrieve.mockRejectedValue(new Error('sk_live_secret leaked in message'));
        const st = await mkState({ businessId: TENANT_A });

        const res = await stripeCallback('state=' + encodeURIComponent(st));

        expect(res.headers.get('location')).not.toMatch(/sk_live|leaked/);
        expect(integrationWrites()).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PARTS F / K — initiation authority
// ═══════════════════════════════════════════════════════════════════════════

describe('Stripe initiation resolves the tenant from trusted authority', () => {
    const initiate = async (qs = '') => {
        const { GET } = await import('@/app/api/auth/stripe/route');
        return GET(new Request('https://app.test/api/auth/stripe' + qs));
    };
    const stateFromLink = async () => {
        const arg = accountLinksCreate.mock.calls[0][0] as any;
        const raw = new URL(arg.return_url).searchParams.get('state');
        const { verifyOAuthState } = await import('@/lib/auth/oauthState');
        return verifyOAuthState(raw, process.env.AUTH_SECRET as string, 'stripe');
    };

    beforeEach(() => { accountLinksCreate.mockClear(); accountsCreate.mockClear(); });

    it('refuses an unauthenticated caller', async () => {
        mockAuth.mockResolvedValue(null);
        expect((await initiate()).status).toBe(401);
        expect(accountLinksCreate).not.toHaveBeenCalled();
    });

    it('ignores a businessId supplied on the request', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        await initiate('?business_id=' + VICTIM + '&businessId=' + VICTIM);

        const st = await stateFromLink();
        expect(st!.businessId).toBe(TENANT_A);
        expect(st!.businessId).not.toBe(VICTIM);
    });

    it('the return_url no longer carries business_id or account_id', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        await initiate();

        const returnUrl = (accountLinksCreate.mock.calls[0][0] as any).return_url as string;
        const params = new URL(returnUrl).searchParams;
        expect(params.get('business_id')).toBeNull();
        expect(params.get('account_id')).toBeNull();
        expect(params.get('state')).toBeTruthy();
    });

    it('a super admin viewing Tenant B connects TENANT B, not their home tenant', async () => {
        // SEC-TENANT-1 effective tenant authority. This route used to read the
        // durable users.business_id row, which no longer follows View As.
        mockAuth.mockResolvedValue(session(VICTIM, { isSuperAdmin: true }));
        await initiate();

        const st = await stateFromLink();
        expect(st!.businessId).toBe(VICTIM);
    });

    it('it does NOT resolve the tenant from the durable users row', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        await initiate();
        expect(writes.filter((w) => w.model === 'user')).toHaveLength(0);
    });

    it('a session with no effective tenant is refused', async () => {
        mockAuth.mockResolvedValue(session(undefined));
        expect((await initiate()).status).toBe(400);
        expect(accountLinksCreate).not.toHaveBeenCalled();
    });

    it('the new account is stamped with the tenant for later corroboration', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        await initiate();
        expect((accountsCreate.mock.calls[0][0] as any).metadata).toEqual({ businessId: TENANT_A });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART C — Square is already safe; these must pass BEFORE and AFTER
// ═══════════════════════════════════════════════════════════════════════════

describe('Square callback is already bound by server state + httpOnly cookie', () => {
    const squareCallback = async (qs: string) => {
        const { GET } = await import('@/app/api/auth/square/callback/route');
        return GET(new Request('https://app.test/api/auth/square/callback?' + qs));
    };
    const stateFor = (businessId: string) =>
        Buffer.from(JSON.stringify({ businessId, nonce: 'n1' })).toString('base64url');

    it('a forged state with the victim tenant is rejected when no cookie matches', async () => {
        const res = await squareCallback('code=abc&state=' + stateFor(VICTIM));

        expect(res.status).toBe(400);
        expect(integrationWrites()).toHaveLength(0);
        expect(obtainToken).not.toHaveBeenCalled();
    });

    it('a state that does not equal the stored cookie is rejected', async () => {
        cookieJar.set('square_oauth_state', stateFor(TENANT_A));

        const res = await squareCallback('code=abc&state=' + stateFor(VICTIM));

        expect(res.status).toBe(400);
        expect(integrationWrites()).toHaveLength(0);
    });

    it('the authorised flow binds to the tenant inside the SERVER-issued state', async () => {
        const st = stateFor(TENANT_A);
        cookieJar.set('square_oauth_state', st);

        await squareCallback('code=abc&state=' + st);

        expect(obtainToken).toHaveBeenCalled();
        expect(tenantsWritten()).toContain(TENANT_A);
        expect(tenantsWritten()).not.toContain(VICTIM);
    });

    it('a missing code or state writes nothing', async () => {
        expect((await squareCallback('state=' + stateFor(TENANT_A))).status).toBe(400);
        expect((await squareCallback('code=abc')).status).toBe(400);
        expect(integrationWrites()).toHaveLength(0);
    });

    it('the state cookie is consumed, so it cannot be replayed', async () => {
        const st = stateFor(TENANT_A);
        cookieJar.set('square_oauth_state', st);
        await squareCallback('code=abc&state=' + st);
        expect(cookieJar.has('square_oauth_state')).toBe(false);

        writes.length = 0;
        const res = await squareCallback('code=abc&state=' + st);
        expect(res.status).toBe(400);
        expect(integrationWrites()).toHaveLength(0);
    });

    it('Square initiation takes the tenant from the session, never from the request', async () => {
        mockAuth.mockResolvedValue(session(TENANT_A));
        const { GET } = await import('@/app/api/auth/square/route');
        const res = await GET(new Request('https://app.test/api/auth/square?businessId=' + VICTIM));

        const location = res.headers.get('location') || '';
        const state = new URL(location).searchParams.get('state') || '';
        const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());

        expect(decoded.businessId).toBe(TENANT_A);
        expect(decoded.businessId).not.toBe(VICTIM);
    });

    it('Square initiation refuses an unauthenticated caller', async () => {
        mockAuth.mockResolvedValue(null);
        const { GET } = await import('@/app/api/auth/square/route');
        const res = await GET(new Request('https://app.test/api/auth/square'));
        expect(res.status).toBe(401);
    });
});
