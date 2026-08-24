/**
 * SEC-TENANT-1, PARTS F / G / O — the tenant-switch endpoint, EXECUTED.
 *
 * The point of this file is that it runs the real handler. An earlier draft
 * asserted these properties by grepping the route's source text, which is the
 * weakest possible evidence: it passes for code that never runs, and it fails
 * for correct code that was merely reworded. Everything here calls POST/GET and
 * inspects the response and the Prisma calls actually issued.
 *
 * The single most important assertion in this file is the negative one:
 * prisma.user.update is NEVER called. That write used to permanently reassign
 * the super admin's own users.business_id to whichever tenant they inspected,
 * which both destroyed their home assignment and — because sign-in reads
 * business_id from the database — silently resumed the impersonation on the
 * next login.
 */

process.env.AUTH_SECRET = 'test-secret-sec-tenant-1';

const userUpdate = jest.fn();
const userFindUnique = jest.fn();
const businessFindUnique = jest.fn();

jest.mock('@/lib/db', () => ({
    prisma: {
        user: {
            update: (...a: any[]) => userUpdate(...a),
            findUnique: (...a: any[]) => userFindUnique(...a),
        },
        business: {
            findUnique: (...a: any[]) => businessFindUnique(...a),
            findMany: jest.fn(async () => [{ id: 'biz-b', name: 'Tenant B', slug: 'tenant-b' }]),
        },
    },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

const superAdmin = { user: { id: 'user-super', businessId: TENANT_A, isSuperAdmin: true } };
const ordinary = { user: { id: 'user-ordinary', businessId: TENANT_A, isSuperAdmin: false } };

const post = async (body: any) => {
    const { POST } = await import('@/app/api/admin/switch-tenant/route');
    return POST(new Request('http://localhost/api/admin/switch-tenant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }));
};

beforeEach(() => {
    userUpdate.mockReset();
    userFindUnique.mockReset();
    businessFindUnique.mockReset();
    mockAuth.mockReset();
    // By default the database agrees with the token: the caller really is a
    // super admin. Individual tests override this to simulate a demotion.
    userFindUnique.mockResolvedValue({ is_super_admin: true });
});

describe('POST /api/admin/switch-tenant — authorisation', () => {
    it('rejects an unauthenticated caller', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await post({ businessId: TENANT_B });
        expect(res.status).toBe(401);
        expect(userUpdate).not.toHaveBeenCalled();
    });

    it('rejects an ordinary authenticated user — the unauthorized target case', async () => {
        mockAuth.mockResolvedValue(ordinary);
        const res = await post({ businessId: TENANT_B });
        expect(res.status).toBe(401);
        expect(businessFindUnique).not.toHaveBeenCalled();
        expect(userUpdate).not.toHaveBeenCalled();
    });

    it('rejects a nonexistent target business with 404', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue(null);
        const res = await post({ businessId: 'does-not-exist' });
        expect(res.status).toBe(404);
        expect(userUpdate).not.toHaveBeenCalled();
    });

    it('rejects a malformed body safely', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        for (const bad of [{}, { businessId: null }, { businessId: 42 }, { businessId: { id: TENANT_B } }]) {
            const res = await post(bad);
            expect(res.status).toBe(400);
        }
        expect(userUpdate).not.toHaveBeenCalled();
    });
});

/**
 * GATE 3 — a stale token may not mint NEW cross-tenant authority.
 *
 * token.isSuperAdmin lives in a JWE cookie that is re-issued with a fresh expiry
 * on every session call, so demoting an administrator in the database does not
 * invalidate their claim. Continuing to act on a stale claim is accepted debt
 * (AUTH-SESSION-REVOCATION-1); ISSUING a new view-as grant on one is not, because
 * a grant is a signed, portable capability to enter another tenant.
 */
describe('POST /api/admin/switch-tenant — CURRENT super-admin required to issue a grant', () => {
    it('a DEMOTED admin whose token still says isSuperAdmin gets 401 and no grant', async () => {
        mockAuth.mockResolvedValue(superAdmin);          // stale token: still true
        userFindUnique.mockResolvedValue({ is_super_admin: false }); // database: revoked

        const res = await post({ businessId: TENANT_B });

        expect(res.status).toBe(401);
        expect((await res.json()).grant).toBeUndefined();
        // It refused BEFORE looking up or disclosing anything about the target.
        expect(businessFindUnique).not.toHaveBeenCalled();
        expect(userUpdate).not.toHaveBeenCalled();
    });

    it('a deleted user row gets 401 and no grant', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        userFindUnique.mockResolvedValue(null);

        const res = await post({ businessId: TENANT_B });

        expect(res.status).toBe(401);
        expect((await res.json()).grant).toBeUndefined();
        expect(businessFindUnique).not.toHaveBeenCalled();
    });

    it('the check reads the row by the SESSION user id, not anything from the body', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE', subscription_status: 'active',
        });

        await post({ businessId: TENANT_B, userId: 'attacker-supplied', id: 'attacker-supplied' });

        expect(userFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'user-super' } })
        );
    });

    it('a still-valid super admin is issued a grant as normal', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        userFindUnique.mockResolvedValue({ is_super_admin: true });
        businessFindUnique.mockResolvedValue({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE', subscription_status: 'active',
        });

        const res = await post({ businessId: TENANT_B });
        expect(res.status).toBe(200);
        expect(typeof (await res.json()).grant).toBe('string');
    });
});

describe('POST /api/admin/switch-tenant — success path', () => {
    it('validates the target and returns its REAL server-side values', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE', subscription_status: 'active',
        });

        const res = await post({ businessId: TENANT_B });
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body.business).toEqual({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE', subscriptionStatus: 'active',
        });
        expect(businessFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: TENANT_B } })
        );
    });

    it('issues a signed grant bound to THIS admin and THIS target', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE', subscription_status: 'active',
        });

        const body = await (await post({ businessId: TENANT_B })).json();
        expect(typeof body.grant).toBe('string');

        const { verifyViewAsGrant } = await import('@/lib/auth/viewAsGrant');
        const verified = await verifyViewAsGrant(body.grant, process.env.AUTH_SECRET as string);
        expect(verified).not.toBeNull();
        expect(verified!.sub).toBe('user-super');
        expect(verified!.bid).toBe(TENANT_B);
        expect(verified!.plan).toBe('ULTIMATE');
        // The grant carries the DATABASE values, not anything the caller sent.
        expect(verified!.name).toBe('Tenant B');
    });

    it('the grant is short-lived', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE', subscription_status: 'active',
        });
        const body = await (await post({ businessId: TENANT_B })).json();
        const { verifyViewAsGrant, VIEW_AS_GRANT_TTL_SECONDS } = await import('@/lib/auth/viewAsGrant');
        const verified = await verifyViewAsGrant(body.grant, process.env.AUTH_SECRET as string);
        const ttl = verified!.exp - Math.floor(Date.now() / 1000);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(VIEW_AS_GRANT_TTL_SECONDS);
    });

    it('a rejected target yields NO grant', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue(null);
        const res = await post({ businessId: 'ghost' });
        expect(res.status).toBe(404);
        expect((await res.json()).grant).toBeUndefined();
    });

    it('an ordinary user gets NO grant', async () => {
        mockAuth.mockResolvedValue(ordinary);
        const res = await post({ businessId: TENANT_B });
        expect(res.status).toBe(401);
        expect((await res.json()).grant).toBeUndefined();
    });

    it('NEVER writes users.business_id — View As is not an identity rewrite', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE',
            subscription_status: 'active', logo_url: null,
        });

        await post({ businessId: TENANT_B });

        expect(userUpdate).not.toHaveBeenCalled();
    });
});

describe('GET /api/admin/switch-tenant', () => {
    it('is super-admin only', async () => {
        mockAuth.mockResolvedValue(ordinary);
        const { GET } = await import('@/app/api/admin/switch-tenant/route');
        expect((await GET()).status).toBe(401);
    });

    it('lists businesses for a super admin', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        const { GET } = await import('@/app/api/admin/switch-tenant/route');
        const res = await GET();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([{ id: 'biz-b', name: 'Tenant B', slug: 'tenant-b' }]);
    });
});

/**
 * PART J / K — where the view-as state lives determines what logout does.
 *
 * Because the effective tenant now lives ONLY in the signed JWT and nowhere in
 * the database, destroying the session cookie necessarily destroys the view-as
 * context. There is no durable row left behind to resume from. That is the
 * property this asserts — structurally, rather than by simulating a logout.
 */
describe('view-as context is session-only', () => {
    it('no durable store is consulted or written to establish it', async () => {
        mockAuth.mockResolvedValue(superAdmin);
        businessFindUnique.mockResolvedValue({
            id: TENANT_B, name: 'Tenant B', plan: 'ULTIMATE',
            subscription_status: 'active', logo_url: null,
        });
        await post({ businessId: TENANT_B });

        // The ONLY database contact is the read that validates the target.
        expect(businessFindUnique).toHaveBeenCalledTimes(1);
        expect(userUpdate).not.toHaveBeenCalled();
    });
});
