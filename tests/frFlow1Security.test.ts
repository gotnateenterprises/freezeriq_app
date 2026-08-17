/**
 * FR-FLOW-1 — tenant-isolation and payload-privacy security matrix.
 *
 * These run the REAL route handlers against a recording Prisma double and
 * assert on the query each handler actually built. The defects being pinned
 * were all "the WHERE clause is missing" or "the secret is in the payload",
 * which is precisely what that style of assertion catches.
 *
 * Pinned here:
 *   - fundraiser CSV export: unauthenticated, unscoped, and shipping portal_token
 *   - public fundraiser payload: SELECT fc.* serialized to the browser
 *   - public fundraiser page: campaign lookup not scoped to the storefront tenant
 *   - fundraiser CSV import: tenant filter commented out
 *   - surplus waitlist: client-supplied businessId trusted as tenant authority
 */

import fs from 'fs';
import path from 'path';
import {
    createPrismaMock,
    jsonRequest,
    readJson,
    readText,
    type PrismaMock,
} from './helpers/routeHarness';
import {
    toPublicCampaign,
    PUBLIC_CAMPAIGN_FIELDS,
    FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS,
} from '@/lib/publicFundraiserPayload';

// ── Module doubles ───────────────────────────────────────────────────────────
let mock: PrismaMock = createPrismaMock();
let sessionValue: any = null;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__frFlow1Prisma; },
}));
jest.mock('@/auth', () => ({
    auth: jest.fn(async () => (global as any).__frFlow1Session),
}));
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: jest.fn(async () => undefined),
}));

function useMock(m: PrismaMock) {
    mock = m;
    (global as any).__frFlow1Prisma = m.client;
}
function useSession(s: any) {
    sessionValue = s;
    (global as any).__frFlow1Session = s;
}

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock());
    useSession(null);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('1. fundraiser CSV export — authentication', () => {
    it('rejects an unauthenticated request with 401', async () => {
        useSession(null);
        const { GET } = await import('@/app/api/csv/export/fundraisers/route');
        const res = await GET(new Request('http://localhost/api/csv/export/fundraisers') as any);
        expect(res.status).toBe(401);
    });

    it('rejects a session with no tenant context', async () => {
        useSession({ user: { email: 'x@y.com' } });
        const { GET } = await import('@/app/api/csv/export/fundraisers/route');
        const res = await GET(new Request('http://localhost/api/csv/export/fundraisers') as any);
        expect(res.status).toBe(401);
    });

    it('does not read the database at all when unauthenticated', async () => {
        useSession(null);
        const { GET } = await import('@/app/api/csv/export/fundraisers/route');
        await GET(new Request('http://localhost/api/csv/export/fundraisers') as any);
        expect(mock.callsTo('fundraiserCampaign.findMany')).toHaveLength(0);
    });
});

describe('2. fundraiser CSV export — tenant isolation', () => {
    it('scopes the query to the session tenant via the customer join', async () => {
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { GET } = await import('@/app/api/csv/export/fundraisers/route');
        await GET(new Request('http://localhost/api/csv/export/fundraisers') as any);

        const call = mock.firstCall('fundraiserCampaign.findMany');
        expect(call).toBeDefined();
        // The exact defect: this used to be findMany({ orderBy, include }) only.
        expect(call!.args.where).toBeDefined();
        expect(call!.args.where.customer.business_id).toBe(TENANT_A);
    });

    it('never scopes to a tenant the session does not own', async () => {
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { GET } = await import('@/app/api/csv/export/fundraisers/route');
        await GET(new Request('http://localhost/api/csv/export/fundraisers') as any);
        const call = mock.firstCall('fundraiserCampaign.findMany');
        expect(JSON.stringify(call!.args.where)).not.toContain(TENANT_B);
    });
});

describe('3. fundraiser CSV export — portal_token is gone', () => {
    const row = {
        name: 'Spring Drive', start_date: null, end_date: null, goal_amount: 100,
        total_sales: 0, status: 'Active',
        portal_token: 'SUPER-SECRET-COORDINATOR-TOKEN',
        customer: {
            name: 'Lincoln PTA', contact_name: 'Jo', contact_email: 'jo@pta.org',
            contact_phone: '555', business_id: TENANT_A,
        },
    };

    it('omits the Portal Token column from the header', async () => {
        useMock(createPrismaMock({ results: { 'fundraiserCampaign.findMany': [row] } }));
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { GET } = await import('@/app/api/csv/export/fundraisers/route');
        const { text } = await readText(await GET(new Request('http://localhost/x') as any) as any);
        expect(text).not.toMatch(/Portal Token/i);
    });

    it('never emits the token value anywhere in the CSV body', async () => {
        useMock(createPrismaMock({ results: { 'fundraiserCampaign.findMany': [row] } }));
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { GET } = await import('@/app/api/csv/export/fundraisers/route');
        const { text, status } = await readText(await GET(new Request('http://localhost/x') as any) as any);
        expect(status).toBe(200);
        expect(text).not.toContain('SUPER-SECRET-COORDINATOR-TOKEN');
        // Legitimate business data still exports.
        expect(text).toContain('Spring Drive');
        expect(text).toContain('Lincoln PTA');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('4. public fundraiser payload — allowlist', () => {
    const leakyRow = {
        id: 'camp-1', name: 'Spring Drive', about_text: 'about',
        participant_label: 'Seller', end_date: '2026-09-01', delivery_date: null,
        pickup_location: 'Gym', payment_instructions: 'Cash', external_payment_link: null,
        organization_name: 'Lincoln PTA',
        customer_fundraiser_info: {
            delivery_time: '4:45 PM', pickup_location: 'Gym',
            checks_payable_to: 'Lincoln PTA LLC', bundle_goal: 120,
        },
        // Everything below must not survive the projection.
        portal_token: 'SECRET-TOKEN', public_token: 'PUB-TOKEN',
        settlement_total: '9999.00', settlement_notes: 'internal',
        closed_by: 'user-1', closed_at: null, org_share_percent: '25.00',
        checks_payable: 'Lincoln PTA LLC', goal_amount: '5000', customer_id: 'cust-1',
        status: 'Active', bundle_selection_status: 'selected',
        bundle_selection_limit: 2, bundle_selection_at: null, checklist: {},
        coordinator_email: 'jo@pta.org', created_at: 'x', updated_at: 'y',
    };

    it('drops portal_token — the coordinator credential', () => {
        const out = toPublicCampaign(leakyRow) as any;
        expect(out.portal_token).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain('SECRET-TOKEN');
    });

    it('drops every field on the forbidden list', () => {
        const out = toPublicCampaign(leakyRow) as any;
        for (const field of FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS) {
            expect(out[field]).toBeUndefined();
        }
    });

    it('drops internal financial values even by string search', () => {
        const serialized = JSON.stringify(toPublicCampaign(leakyRow));
        for (const secret of ['SECRET-TOKEN', 'PUB-TOKEN', '9999.00', 'internal', '25.00']) {
            expect(serialized).not.toContain(secret);
        }
    });

    it('keeps exactly the public fields the supporter page renders', () => {
        const out = toPublicCampaign(leakyRow) as any;
        expect(Object.keys(out).sort()).toEqual([...PUBLIC_CAMPAIGN_FIELDS].sort());
        expect(out.name).toBe('Spring Drive');
        expect(out.organization_name).toBe('Lincoln PTA');
        expect(out.pickup_location).toBe('Gym');
    });

    it('narrows the org fundraiser_info blob to three public keys', () => {
        const out = toPublicCampaign(leakyRow) as any;
        expect(Object.keys(out.customer_fundraiser_info).sort())
            .toEqual(['delivery_date', 'delivery_time', 'pickup_location']);
        expect(out.customer_fundraiser_info.delivery_time).toBe('4:45 PM');
        // checks_payable_to lives in that blob and must not ride along.
        expect(JSON.stringify(out)).not.toContain('Lincoln PTA LLC');
    });

    it('is an include-list: a newly added column cannot leak', () => {
        const out = toPublicCampaign({ ...leakyRow, some_future_secret: 'NOPE' }) as any;
        expect(out.some_future_secret).toBeUndefined();
        expect(JSON.stringify(out)).not.toContain('NOPE');
    });

    it('returns null for a missing campaign rather than an empty shell', () => {
        expect(toPublicCampaign(null)).toBeNull();
        expect(toPublicCampaign(undefined)).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('5. public fundraiser page — campaign lookup is tenant-scoped', () => {
    // Structural guard. getData() is module-private inside a Server Component,
    // so the query text is asserted directly: the predicate must be present and
    // the wildcard select must be gone.
    const pageSrc = fs.readFileSync(
        path.join(__dirname, '..', 'app', 'shop', '[slug]', 'fundraiser', '[fundraiserId]', 'page.tsx'),
        'utf8'
    );
    // Assert on CODE, not prose — the comments above the query legitimately
    // quote the old wildcard while explaining why it was removed.
    const pageCode = pageSrc
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');

    it('joins customers and filters on the slug-resolved business', () => {
        expect(pageCode).toMatch(/WHERE fc\.id = \$\{fundraiserId\} AND c\.business_id = \$\{business\.id\}/);
    });

    it('no longer selects the campaign with a wildcard', () => {
        expect(pageCode).not.toContain('SELECT fc.*');
        expect(pageCode).toContain('SELECT fc.id, fc.name');
    });

    it('does not hand the raw row to the client component', () => {
        expect(pageCode).toContain('toPublicCampaign(campaign)');
        expect(pageCode).toContain('campaign: publicCampaign');
    });

    it('no longer selects the organization contact email onto the public page', () => {
        expect(pageCode).not.toContain('coordinator_email');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('6. fundraiser CSV import — tenant isolation', () => {
    const csv = 'Organization,Campaign,Contact,Email,Phone\nLincoln PTA,Spring,Jo,jo@pta.org,555\n';

    function formRequest(body: string): any {
        const fd = new FormData();
        fd.append('file', new File([body], 'f.csv', { type: 'text/csv' }));
        return new Request('http://localhost/api/fundraisers/upload', { method: 'POST', body: fd });
    }

    it('scopes the organization lookup to the session tenant', async () => {
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { POST } = await import('@/app/api/fundraisers/upload/route');
        await POST(formRequest(csv) as any);

        const call = mock.firstCall('customer.findFirst');
        expect(call).toBeDefined();
        // The exact defect: `business_id` was commented out of this where.
        expect(call!.args.where.business_id).toBe(TENANT_A);
    });

    it('cannot match or update another tenant customer', async () => {
        // The double returns a foreign row ONLY if the query is unscoped.
        useMock(createPrismaMock({
            results: {
                'customer.findFirst': (args: any) =>
                    args?.where?.business_id === TENANT_A
                        ? null
                        : { id: 'foreign-cust', business_id: TENANT_B, contact_email: null },
            },
        }));
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { POST } = await import('@/app/api/fundraisers/upload/route');
        await POST(formRequest(csv) as any);

        const updates = mock.callsTo('customer.update');
        expect(updates.every((u) => u.args.where.id !== 'foreign-cust')).toBe(true);
    });

    it('creates any new campaign under a customer it created in this tenant', async () => {
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { POST } = await import('@/app/api/fundraisers/upload/route');
        await POST(formRequest(csv) as any);

        const created = mock.firstCall('customer.create');
        expect(created!.args.data.business_id).toBe(TENANT_A);
        const camp = mock.firstCall('fundraiserCampaign.create');
        if (camp) expect(camp.args.data.customer_id).not.toBe('foreign-cust');
    });

    it('refuses an import with no tenant context instead of writing orphans', async () => {
        useSession({ user: { email: 'super@admin.com' } }); // no businessId
        const { POST } = await import('@/app/api/fundraisers/upload/route');
        const { status } = await readJson(await POST(formRequest(csv) as any) as any);
        expect(status).toBe(403);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('7. surplus waitlist — tenant comes from the slug, not the body', () => {
    it('ignores a spoofed businessId and uses the slug-resolved tenant', async () => {
        useMock(createPrismaMock({
            results: { 'business.findFirst': { id: TENANT_A } },
        }));
        const { POST } = await import('@/app/api/public/waitlist/route');
        await POST(jsonRequest('http://localhost/api/public/waitlist', {
            name: 'Mallory', email: 'm@evil.com',
            businessId: TENANT_B,       // spoofed
            slug: 'tenant-a',
        }));

        // Tenant was resolved from the slug...
        const resolved = mock.firstCall('business.findFirst');
        expect(JSON.stringify(resolved!.args)).toContain('tenant-a');

        // ...and every write landed in that tenant, not the spoofed one.
        const created = mock.firstCall('customer.create');
        expect(created!.args.data.business_id).toBe(TENANT_A);
        expect(created!.args.data.business_id).not.toBe(TENANT_B);

        const dupCheck = mock.firstCall('customer.findFirst');
        expect(dupCheck!.args.where.business_id).toBe(TENANT_A);
    });

    it('rejects a request with no slug rather than trusting businessId', async () => {
        const { POST } = await import('@/app/api/public/waitlist/route');
        const { status } = await readJson(await POST(jsonRequest(
            'http://localhost/api/public/waitlist',
            { email: 'm@evil.com', businessId: TENANT_B }
        )));
        expect(status).toBe(400);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });

    it('404s an unknown storefront without writing', async () => {
        useMock(createPrismaMock({ results: { 'business.findFirst': null } }));
        const { POST } = await import('@/app/api/public/waitlist/route');
        const { status } = await readJson(await POST(jsonRequest(
            'http://localhost/api/public/waitlist',
            { email: 'a@b.com', slug: 'does-not-exist' }
        )));
        expect(status).toBe(404);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });

    it('a legitimate waitlist signup still succeeds', async () => {
        useMock(createPrismaMock({ results: { 'business.findFirst': { id: TENANT_A } } }));
        const { POST } = await import('@/app/api/public/waitlist/route');
        const { status, body } = await readJson(await POST(jsonRequest(
            'http://localhost/api/public/waitlist',
            { name: 'Real Person', email: 'real@person.com', slug: 'tenant-a' }
        )));
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(mock.firstCall('customer.create')!.args.data.contact_email).toBe('real@person.com');
    });
});
