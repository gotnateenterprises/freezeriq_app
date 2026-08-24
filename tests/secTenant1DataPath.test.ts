/**
 * SEC-TENANT-1, PART D — does the forged tenant actually reach the database?
 *
 * tests/secTenant1.test.ts proves the jwt callback accepts a client-supplied
 * businessId. This file proves that is not merely a cosmetic token field: it
 * runs the REAL route handlers with the session that the REAL auth callbacks
 * produce from the forged update, and captures the WHERE clause Prisma is
 * asked for.
 *
 * Why the existing defence-in-depth does not help here. app/api/opportunities/route.ts:32
 * reasons that compound foreign keys mean "a bug in this line cannot leak
 * another tenant". That is true of a *typo*. It is not true of this attack: the
 * forged id is a real, existing tenant, so every foreign key is satisfied and
 * every row returned is internally consistent — just owned by somebody else.
 *
 * The routes are NOT individually at fault. Each one scopes correctly. They
 * share a single premise — that session.user.businessId is trustworthy — and it
 * is that premise this suite pins down.
 */

process.env.AUTH_SECRET = 'test-secret-sec-tenant-1';

const captured: Array<{ model: string; where: any }> = [];

// A findUnique that returns null makes a route short-circuit, so the deeper
// tenant-scoped queries never run and the isolation assertions pass for the
// wrong reason. `business.findUnique` in particular gates /api/dashboard, so it
// returns a row and the handler proceeds all the way through.
const record = (model: string) => ({
    findMany: jest.fn(async (args: any) => { captured.push({ model, where: args?.where }); return []; }),
    findFirst: jest.fn(async (args: any) => { captured.push({ model, where: args?.where }); return null; }),
    findUnique: jest.fn(async (args: any) => {
        captured.push({ model, where: args?.where });
        if (model === 'business') {
            // ULTIMATE so /api/dashboard passes its own DB-derived plan gate and
            // runs the full set of tenant-scoped queries rather than returning
            // the restricted payload after a single lookup.
            return { id: args?.where?.id, name: 'T', plan: 'ULTIMATE', subscription_status: 'active' };
        }
        return null;
    }),
    count: jest.fn(async (args: any) => { captured.push({ model, where: args?.where }); return 0; }),
    aggregate: jest.fn(async (args: any) => { captured.push({ model, where: args?.where }); return { _sum: {}, _count: 0 }; }),
    groupBy: jest.fn(async (args: any) => { captured.push({ model, where: args?.where }); return []; }),
});

jest.mock('@/lib/db', () => {
    const models = [
        'fundraiserOpportunity', 'fundraiserInquiry', 'fundraiserCampaign', 'customer',
        'order', 'business', 'bundle', 'recipe', 'invoice', 'user', 'fundraiserContact',
    ];
    const client: any = { $transaction: jest.fn(async (ops: any) => ops), $queryRaw: jest.fn(async () => []) };
    for (const m of models) client[m] = record(m);
    return { prisma: client };
});

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

import { authConfig } from '@/auth.config';
import { signViewAsGrant, VIEW_AS_GRANT_TTL_SECONDS } from '@/lib/auth/viewAsGrant';

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

/**
 * The full attack chain, using the real callbacks — no hand-written session.
 * A signed-in ordinary Tenant A user calls update({ businessId: TENANT_B }).
 */
async function sessionAfterForgedUpdate(forged: any, isSuperAdmin = false) {
    const token = await (authConfig.callbacks as any).jwt({
        token: {
            // ENTERPRISE so the routes' own plan gates let the request through
            // to the database layer — otherwise a 403 would mask the tenant
            // assertion and the test would pass for the wrong reason.
            sub: 'user-ordinary', role: 'ADMIN', businessId: TENANT_A,
            baseBusinessId: TENANT_A, plan: 'ENTERPRISE', isSuperAdmin, businessName: 'Tenant A',
        },
        trigger: 'update',
        session: forged,
    });
    return (authConfig.callbacks as any).session({
        session: { user: { id: 'user-ordinary', email: 'user@tenant-a.test' } },
        token,
    });
}

const tenantsTouched = () =>
    Array.from(new Set(
        captured
            .map((c) => c.where?.business_id ?? c.where?.id)
            .filter((v) => typeof v === 'string')
    ));

beforeEach(() => { captured.length = 0; mockAuth.mockReset(); });

describe('the forged tenant must never reach a database query', () => {
    it('GET /api/opportunities queries only Tenant A', async () => {
        const s = await sessionAfterForgedUpdate({ businessId: TENANT_B });
        mockAuth.mockResolvedValue(s);

        const { GET } = await import('@/app/api/opportunities/route');
        await GET(new Request('http://localhost/api/opportunities'));

        expect(captured.length).toBeGreaterThan(0);          // the route really ran
        expect(tenantsTouched()).not.toContain(TENANT_B);
        expect(tenantsTouched()).toEqual([TENANT_A]);
    });

    it('GET /api/customers queries only Tenant A', async () => {
        const s = await sessionAfterForgedUpdate({ businessId: TENANT_B });
        mockAuth.mockResolvedValue(s);

        const { GET } = await import('@/app/api/customers/route');
        await GET(new Request('http://localhost/api/customers'));

        expect(captured.length).toBeGreaterThan(0);
        expect(tenantsTouched()).not.toContain(TENANT_B);
    });

    it('GET /api/dashboard queries only Tenant A', async () => {
        const s = await sessionAfterForgedUpdate({ businessId: TENANT_B });
        mockAuth.mockResolvedValue(s);

        const { GET } = await import('@/app/api/dashboard/route');
        await GET(new Request('http://localhost/api/dashboard'));

        // More than the single gating business lookup, so the isolation
        // assertion is about real tenant-scoped queries.
        expect(captured.length).toBeGreaterThan(3);
        expect(tenantsTouched()).not.toContain(TENANT_B);
        expect(tenantsTouched()).toEqual([TENANT_A]);
    });

    it('GET /api/orders queries only Tenant A', async () => {
        const s = await sessionAfterForgedUpdate({ businessId: TENANT_B });
        mockAuth.mockResolvedValue(s);

        const { GET } = await import('@/app/api/orders/route');
        await GET(new Request('http://localhost/api/orders'));

        expect(captured.length).toBeGreaterThan(0);
        expect(tenantsTouched()).not.toContain(TENANT_B);
    });
});

/**
 * The attacker who has READ the fix. Once `viewAsBusinessId` exists, the
 * interesting exploit is no longer the old `businessId` string — it is an
 * ordinary user sending the NEW field name. This is the shape that must stay
 * dead, and it is guarded by token.isSuperAdmin rather than by the field name.
 */
describe('an ordinary user sending the view-as field reaches no other tenant', () => {
    const ROUTES: Array<[string, string]> = [
        ['@/app/api/opportunities/route', 'http://localhost/api/opportunities'],
        ['@/app/api/customers/route', 'http://localhost/api/customers'],
        ['@/app/api/dashboard/route', 'http://localhost/api/dashboard'],
        ['@/app/api/orders/route', 'http://localhost/api/orders'],
    ];

    it.each(ROUTES)('%s queries only Tenant A', async (mod, url) => {
        const s = await sessionAfterForgedUpdate({
            viewAsBusinessId: TENANT_B, viewAsBusinessName: 'Tenant B',
        });
        mockAuth.mockResolvedValue(s);

        const { GET } = await import(mod);
        await GET(new Request(url));

        expect(captured.length).toBeGreaterThan(0);
        expect(tenantsTouched()).not.toContain(TENANT_B);
        expect(tenantsTouched()).toEqual([TENANT_A]);
    });

    it('and cannot combine both field names to slip through', async () => {
        const s = await sessionAfterForgedUpdate({
            businessId: TENANT_B, viewAsBusinessId: TENANT_B, isSuperAdmin: true,
        });
        mockAuth.mockResolvedValue(s);

        const { GET } = await import('@/app/api/opportunities/route');
        await GET(new Request('http://localhost/api/opportunities'));

        expect(captured.length).toBeGreaterThan(0);
        expect(tenantsTouched()).toEqual([TENANT_A]);
    });
});

describe('a legitimate super-admin View As still reaches the target tenant', () => {
    it('GET /api/opportunities queries Tenant B when the server authorised it', async () => {
        const grant = await signViewAsGrant({
            sub: 'user-super', bid: TENANT_B, name: 'Tenant B', plan: 'ENTERPRISE',
            status: 'active', exp: Math.floor(Date.now() / 1000) + VIEW_AS_GRANT_TTL_SECONDS,
        }, process.env.AUTH_SECRET as string);

        const token = await (authConfig.callbacks as any).jwt({
            token: {
                sub: 'user-super', role: 'ADMIN', businessId: TENANT_A, baseBusinessId: TENANT_A,
                plan: 'ULTIMATE', isSuperAdmin: true, businessName: 'Tenant A',
            },
            trigger: 'update',
            session: { viewAsGrant: grant },
        });
        const s = await (authConfig.callbacks as any).session({
            session: { user: { id: 'user-super', email: 'admin@platform.test' } }, token,
        });
        mockAuth.mockResolvedValue(s);

        const { GET } = await import('@/app/api/opportunities/route');
        await GET(new Request('http://localhost/api/opportunities'));

        expect(tenantsTouched()).toContain(TENANT_B);
    });
});
