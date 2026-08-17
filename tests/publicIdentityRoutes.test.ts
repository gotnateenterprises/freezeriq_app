/**
 * FR-PUBLIC-IDENTITY-1 — the repaired public routes.
 *
 * Asserts on the QUERY each handler builds, so a regression back to
 * `mode: 'insensitive'` is visible to a test rather than only to an attacker.
 */

import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';

let mock: PrismaMock = createPrismaMock();

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__publicIdentityPrisma; },
}));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));

const notify = jest.fn(async () => undefined);
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: (...a: any[]) => notify(...(a as [])),
    sendWaitlistNotificationEmail: (...a: any[]) => notify(...(a as [])),
}));

const TENANT_A = 'biz-aaaa-1111';

function useMock(m: PrismaMock) {
    mock = m;
    (global as any).__publicIdentityPrisma = m.client;
}

const INQUIRY = {
    name: 'Jo Coordinator', email: 'jo@lincolnpta.org', phone: '555-0100',
    orgName: 'Lincoln PTA', deliveryLocation: 'Gym', slug: 'tenant-a',
};

function baseMock(extra: Record<string, any> = {}) {
    return createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A },
            'user.findFirst': { email: 'owner@tenant-a.com' },
            $queryRaw: [],
            ...extra,
        },
    });
}

const postInquiry = async (body: unknown) => {
    const { POST } = await import('@/app/api/public/fundraiser-request/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/fundraiser-request', body)));
};

beforeEach(() => {
    jest.clearAllMocks();
    useMock(baseMock());
});

describe('fundraiser-request — tenant resolution', () => {
    it('queries the slug with plain equality, never ILIKE', async () => {
        await postInquiry(INQUIRY);
        const where = mock.firstCall('business.findFirst')!.args.where;
        expect(where).toEqual({ slug: 'tenant-a' });
        expect(JSON.stringify(where)).not.toContain('insensitive');
    });

    it('a wildcard slug never reaches the database at all', async () => {
        for (const slug of ['%', '_enant-a', 'tenant-%']) {
            useMock(baseMock());
            const res = await postInquiry({ ...INQUIRY, slug });
            expect(res.status).toBe(404);
            expect(mock.callsTo('business.findFirst')).toHaveLength(0);
            expect(mock.callsTo('customer.create')).toHaveLength(0);
        }
    });

    it('still accepts a valid slug in any case', async () => {
        const res = await postInquiry({ ...INQUIRY, slug: '  TENANT-A ' });
        expect(res.status).toBe(200);
    });
});

describe('fundraiser-request — customer identity', () => {
    it('matches the email through parameterized SQL, not a Prisma ILIKE', async () => {
        await postInquiry(INQUIRY);
        expect(mock.rawQueries.join(' ')).toContain('lower(btrim(contact_email))');
        // The old ILIKE path is gone: no customer.findFirst on contact_email.
        const emailFinds = mock.callsTo('customer.findFirst')
            .filter((c) => JSON.stringify(c.args).includes('contact_email'));
        expect(emailFinds).toHaveLength(0);
    });

    it('creates a new organization when nothing matches', async () => {
        const res = await postInquiry(INQUIRY);
        expect(res.status).toBe(200);
        const created = mock.firstCall('customer.create')!.args.data;
        expect(created.type).toBe('fundraiser_org');
        expect(created.status).toBe('LEAD');
        expect(created.tags).toEqual(['fundraiser_inquiry']);
    });

    it('reuses a sole match WITHOUT changing its type or source', async () => {
        useMock(baseMock({
            $queryRaw: [{
                id: 'cust-retail', type: 'direct_customer', status: 'ACTIVE', source: 'storefront',
                name: 'Jo Smith', contact_name: 'Jo', contact_phone: null, notes: 'existing', tags: [],
            }],
        }));
        await postInquiry(INQUIRY);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
        const patch = mock.firstCall('customer.update')!.args.data;
        expect(patch).not.toHaveProperty('type');
        expect(patch).not.toHaveProperty('source');
        expect(patch).not.toHaveProperty('status');
        expect(patch).not.toHaveProperty('contact_name'); // already set — preserved
        expect(patch.contact_phone).toBe('555-0100');     // was blank — filled
        expect(patch.tags).toContain('fundraiser_inquiry');
    });

    it('picks the organization whose NAME matches when several share the email', async () => {
        useMock(baseMock({
            $queryRaw: [
                { id: 'alpha', type: 'organization', status: 'LEAD', source: 'Manual', name: 'Alpha PTA', contact_name: 'A', contact_phone: 'p', notes: 'n', tags: [] },
                { id: 'lincoln', type: 'organization', status: 'LEAD', source: 'Manual', name: 'Lincoln PTA', contact_name: 'B', contact_phone: 'p', notes: 'n', tags: [] },
            ],
        }));
        const res = await postInquiry(INQUIRY);
        expect(res.status).toBe(200);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
        // Only the correctly-named organization may be touched.
        const updated = mock.callsTo('customer.update');
        for (const u of updated) expect(u.args.where.id).toBe('lincoln');
    });

    it('AMBIGUOUS duplicates: saves the lead as a new org and flags it', async () => {
        const twin = (id: string) => ({
            id, type: 'organization', status: 'LEAD', source: 'Manual', name: 'Lincoln PTA',
            contact_name: 'x', contact_phone: 'y', notes: 'z', tags: [],
        });
        useMock(baseMock({ $queryRaw: [twin('t1'), twin('t2')] }));
        const res = await postInquiry(INQUIRY);
        expect(res.status).toBe(200);
        // Nothing existing was touched...
        expect(mock.callsTo('customer.update')).toHaveLength(0);
        // ...and the lead survives, flagged for a human.
        const created = mock.firstCall('customer.create')!.args.data;
        expect(created.tags).toContain('identity_review_needed');
        expect(created.notes).toContain('IDENTITY REVIEW');
    });

    it('never creates a FundraiserCampaign', async () => {
        await postInquiry(INQUIRY);
        expect(mock.calls.filter((c) => c.model === 'fundraiserCampaign' && c.method === 'create')).toHaveLength(0);
    });

    it('a mail outage still cannot lose the lead', async () => {
        notify.mockRejectedValueOnce(new Error('Resend down'));
        const res = await postInquiry(INQUIRY);
        expect(res.status).toBe(200);
        expect(mock.callsTo('customer.create')).toHaveLength(1);
    });
});

describe('waitlist — tenant resolution', () => {
    const post = async (body: unknown) => {
        const { POST } = await import('@/app/api/public/waitlist/route');
        return readJson(await POST(jsonRequest('http://localhost/api/public/waitlist', body)));
    };

    it('uses plain equality for the slug', async () => {
        useMock(baseMock());
        await post({ name: 'A', email: 'a@b.com', slug: 'tenant-a' });
        expect(mock.firstCall('business.findFirst')!.args.where).toEqual({ slug: 'tenant-a' });
    });

    it('rejects a wildcard slug without querying', async () => {
        useMock(baseMock());
        const res = await post({ name: 'A', email: 'a@b.com', slug: '%' });
        expect(res.status).toBe(404);
        expect(mock.callsTo('business.findFirst')).toHaveLength(0);
    });

    it('still ignores a client-supplied businessId', async () => {
        useMock(baseMock());
        await post({ name: 'A', email: 'a@b.com', slug: 'tenant-a', businessId: 'attacker' });
        const created = mock.firstCall('customer.create');
        if (created) expect(created.args.data.business_id).toBe(TENANT_A);
    });
});

/**
 * FR-PUBLIC-IDENTITY-1R — the legacy loyalty surface is REMOVED, not patched.
 *
 * `/api/loyalty/balance` was an unauthenticated read returning a customer's id,
 * name and balance. `/api/loyalty/redeem` was an unauthenticated POST that
 * DECREMENTED a customer's points and minted an active DiscountCode in a
 * client-supplied business — with no tenant scoping on the customer lookup at
 * all. The only caller of either was `components/shop/LoyaltyWidget`, which was
 * mounted nowhere. Exact matching would have closed the wildcard while leaving a
 * public read feeding a public spend, so all three were deleted.
 *
 * These tests exist so the surface cannot be reintroduced silently — through a
 * revert, a merge, or by re-mounting the dead widget.
 */
describe('legacy loyalty surface stays removed', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = path.join(__dirname, '..');

    it('the unauthenticated balance endpoint no longer exists', () => {
        expect(fs.existsSync(path.join(root, 'app/api/loyalty/balance/route.ts'))).toBe(false);
    });

    it('the unauthenticated points-spend endpoint no longer exists', () => {
        expect(fs.existsSync(path.join(root, 'app/api/loyalty/redeem/route.ts'))).toBe(false);
    });

    it('the unmounted widget that called them no longer exists', () => {
        expect(fs.existsSync(path.join(root, 'components/shop/LoyaltyWidget.tsx'))).toBe(false);
    });

    it('no runtime source references the removed routes', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!/\.(ts|tsx)$/.test(entry.name)) continue;
                const src = fs.readFileSync(p, 'utf8');
                if (/api\/loyalty\/(balance|redeem)|LoyaltyWidget/.test(src)) {
                    offenders.push(path.relative(root, p));
                }
            }
        };
        for (const d of ['app', 'components', 'lib']) walk(path.join(root, d));
        expect(offenders).toEqual([]);
    });

    it('the ONLY surviving points mutation paths increment, never decrement', () => {
        // The removed redeem route was the sole spend path. Everything that
        // remains adds points and sits behind an authenticated surface.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!/\.(ts|tsx)$/.test(entry.name)) continue;
                const src = fs.readFileSync(p, 'utf8');
                if (/loyalty_balance:\s*\{\s*decrement/.test(src)) offenders.push(path.relative(root, p));
            }
        };
        for (const d of ['app', 'lib']) walk(path.join(root, d));
        expect(offenders).toEqual([]);
    });

    it('the maintained customer-facing loyalty route is untouched', () => {
        const p = path.join(root, 'app/api/public/customer/loyalty/route.ts');
        expect(fs.existsSync(p)).toBe(true);
        const src = fs.readFileSync(p, 'utf8');
        // It resolves the slug exactly and never used the ILIKE pattern.
        expect(src).not.toContain("mode: 'insensitive'");
        // It discloses no customer id and mutates nothing.
        expect(src).not.toMatch(/loyalty_balance:\s*\{/);
    });
});
