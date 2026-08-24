/**
 * SEC-TENANT-1, PART C — the two routes that changed because the destructive
 * View-As write had been load-bearing.
 *
 * Removing `users.business_id = <viewed tenant>` was correct: it destroyed the
 * super admin's durable home tenant and silently resumed the impersonation after
 * a logout. But two places had come to depend on it, and neither dependency was
 * obvious until View As stopped moving the row:
 *
 *   campaign closeout   resolved the acting user with
 *                       { id: sessionUserId, business_id: effectiveTenant }.
 *                       A platform super admin is not a member of the tenant they
 *                       are inspecting, so closeout began returning 403.
 *
 *   tenant branding     read the DURABLE users.business_id row. Its own comment
 *                       says a super admin viewing Tenant B "should update Tenant
 *                       B's branding" — which held only while the write moved the
 *                       row. Afterwards it read, and at the business.update call
 *                       WROTE, the admin's HOME tenant while the whole UI said
 *                       Tenant B.
 *
 * These tests execute the real handlers. Each route is asserted twice: an
 * ordinary user must stay inside their own tenant, and an authorised super admin
 * in View As must act on the EFFECTIVE tenant.
 */

process.env.AUTH_SECRET = 'test-secret-sec-tenant-1';

const TENANT_A = 'biz-aaaa-1111';   // the super admin's real home tenant
const TENANT_B = 'biz-bbbb-2222';   // the tenant being viewed

const calls: Array<{ model: string; op: string; args: any }> = [];
const rec = (model: string, op: string, ret: any) =>
    jest.fn(async (args: any) => { calls.push({ model, op, args }); return typeof ret === 'function' ? ret(args) : ret; });

jest.mock('@/lib/db', () => ({
    prisma: {
        user: {
            findFirst: rec('user', 'findFirst', (a: any) => ({ id: a?.where?.id ?? 'user-x' })),
            findUnique: rec('user', 'findUnique', { is_super_admin: true, business_id: TENANT_A }),
            update: rec('user', 'update', {}),
        },
        business: {
            findUnique: rec('business', 'findUnique', (a: any) => ({
                id: a?.where?.id, slug: 's', name: 'N', contact_email: 'e@t.test', plan: 'ULTIMATE',
            })),
            update: rec('business', 'update', {}),
        },
        tenantBranding: {
            findFirst: rec('tenantBranding', 'findFirst', null),
            create: rec('tenantBranding', 'create', {}),
            update: rec('tenantBranding', 'update', {}),
            upsert: rec('tenantBranding', 'upsert', {}),
        },
        fundraiserCampaign: {
            findFirst: rec('fundraiserCampaign', 'findFirst', null),
            findUnique: rec('fundraiserCampaign', 'findUnique', null),
            update: rec('fundraiserCampaign', 'update', {}),
        },
        $transaction: jest.fn(async (fn: any) => (typeof fn === 'function' ? fn({}) : fn)),
    },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const ordinarySession = {
    user: { id: 'user-ordinary', email: 'u@a.test', businessId: TENANT_A, isSuperAdmin: false, role: 'ADMIN' },
};
/** A super admin whose EFFECTIVE tenant is B while their base identity is A. */
const viewingSession = {
    user: { id: 'user-super', email: 'admin@platform.test', businessId: TENANT_B, isSuperAdmin: true, role: 'ADMIN' },
};

const tenantsIn = (model: string) => calls
    .filter((c) => c.model === model)
    .map((c) => c.args?.where?.business_id ?? c.args?.where?.id ?? c.args?.where?.user?.business_id)
    .filter((v) => typeof v === 'string');

beforeEach(() => { calls.length = 0; mockAuth.mockReset(); });

// ═══════════════════════════════════════════════════════════════════════════
// TENANT BRANDING
// ═══════════════════════════════════════════════════════════════════════════

describe('tenant branding follows the EFFECTIVE tenant', () => {
    it('GET: an ordinary user only ever touches their own tenant', async () => {
        mockAuth.mockResolvedValue(ordinarySession);
        const { GET } = await import('@/app/api/tenant/branding/route');
        await GET({} as any);

        expect(calls.length).toBeGreaterThan(0);
        const touched = [...tenantsIn('business'), ...tenantsIn('tenantBranding')];
        expect(touched).toContain(TENANT_A);
        expect(touched).not.toContain(TENANT_B);
    });

    it('GET: a super admin viewing Tenant B reads TENANT B, not their home tenant', async () => {
        mockAuth.mockResolvedValue(viewingSession);
        const { GET } = await import('@/app/api/tenant/branding/route');
        await GET({} as any);

        const touched = [...tenantsIn('business'), ...tenantsIn('tenantBranding')];
        expect(touched).toContain(TENANT_B);
        expect(touched).not.toContain(TENANT_A);
    });

    it('GET: it does NOT resolve the tenant from the durable users row', async () => {
        // The regression was reading prisma.user.findUnique().business_id, which
        // no longer moves with View As.
        mockAuth.mockResolvedValue(viewingSession);
        const { GET } = await import('@/app/api/tenant/branding/route');
        await GET({} as any);

        expect(calls.filter((c) => c.model === 'user' && c.op === 'findUnique')).toHaveLength(0);
    });

    it('POST: a super admin viewing Tenant B WRITES to Tenant B, not their home tenant', async () => {
        // The write path is where getting this wrong does real damage: the admin
        // believes they are editing Tenant B while silently overwriting Tenant A.
        mockAuth.mockResolvedValue(viewingSession);
        const form = new FormData();
        form.append('contact_email', 'new@tenant-b.test');

        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(new Request('http://localhost/api/tenant/branding', {
            method: 'POST', body: form,
        }) as any);

        const written = calls
            .filter((c) => c.op === 'update' || c.op === 'create')
            .map((c) => c.args?.where?.id ?? c.args?.where?.user?.business_id ?? c.args?.data?.business_id)
            .filter((v) => typeof v === 'string');

        expect(written.length).toBeGreaterThan(0);
        expect(written).toContain(TENANT_B);
        expect(written).not.toContain(TENANT_A);
    });

    it('POST: an ordinary user writes only inside their own tenant', async () => {
        mockAuth.mockResolvedValue(ordinarySession);
        const form = new FormData();
        form.append('contact_email', 'new@tenant-a.test');

        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(new Request('http://localhost/api/tenant/branding', {
            method: 'POST', body: form,
        }) as any);

        const touched = [...tenantsIn('business'), ...tenantsIn('tenantBranding')];
        expect(touched).not.toContain(TENANT_B);
    });

    it('POST: it does NOT resolve the tenant from the durable users row', async () => {
        mockAuth.mockResolvedValue(viewingSession);
        const form = new FormData();
        form.append('contact_email', 'x@t.test');

        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(new Request('http://localhost/api/tenant/branding', {
            method: 'POST', body: form,
        }) as any);

        expect(calls.filter((c) => c.model === 'user' && c.op === 'findUnique')).toHaveLength(0);
    });

    it('GET: no tenant context fails closed rather than querying unscoped', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u', businessId: undefined, isSuperAdmin: false } });
        const { GET } = await import('@/app/api/tenant/branding/route');
        const res = await GET({} as any);

        expect(res.status).toBe(400);
        expect(calls.filter((c) => c.model !== 'user')).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// CAMPAIGN CLOSEOUT
// ═══════════════════════════════════════════════════════════════════════════

describe('campaign closeout actor resolution', () => {
    const callCloseout = async (session: any) => {
        mockAuth.mockResolvedValue(session);
        const { POST } = await import('@/app/api/campaigns/[id]/closeout/route');
        return POST(
            new Request('http://localhost/api/campaigns/c1/closeout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }) as any,
            { params: Promise.resolve({ id: 'campaign-1' }) } as any,
        );
    };

    it('an ordinary user is still required to be a MEMBER of the tenant', async () => {
        await callCloseout(ordinarySession);

        const actorLookups = calls.filter((c) => c.model === 'user' && c.op === 'findFirst');
        for (const l of actorLookups) {
            // The membership clause must still be present for non-super-admins.
            expect(l.args.where).toHaveProperty('business_id');
            expect(l.args.where.business_id).toBe(TENANT_A);
        }
    });

    it('a super admin in View As is NOT required to be a member of Tenant B', async () => {
        // This is the regression: a platform admin is never a member of the tenant
        // they are inspecting, so a membership clause made closeout impossible.
        await callCloseout(viewingSession);

        const actorLookups = calls.filter((c) => c.model === 'user' && c.op === 'findFirst');
        expect(actorLookups.length).toBeGreaterThan(0);
        for (const l of actorLookups) {
            expect(l.args.where).not.toHaveProperty('business_id');
            expect(l.args.where.id).toBe('user-super');
        }
    });

    it('the super-admin path never widens the CAMPAIGN scope', async () => {
        // Relaxing the ACTOR lookup must not relax the tenant scope of the
        // campaign being closed out.
        await callCloseout(viewingSession);

        const campaignScopes = calls
            .filter((c) => c.model === 'fundraiserCampaign')
            .map((c) => c.args?.where?.business_id)
            .filter(Boolean);
        for (const s of campaignScopes) expect(s).toBe(TENANT_B);
        expect(campaignScopes).not.toContain(TENANT_A);
    });
});
