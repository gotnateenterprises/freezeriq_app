/**
 * FR-FLOW-1 — public fundraiser inquiry persistence (Stage 1, LEAD).
 *
 * The defect: the route validated its input, ignored the tenant slug the form
 * already sent, wrote nothing, and returned success — while the storefront told
 * the submitter "Request Received!". Every inquiry was silently discarded.
 *
 * Pinned here: the lead is durable, tenant-correct, visible to the CRM the
 * tenant already uses, does NOT manufacture a campaign, survives a double
 * submit, and survives a mail outage.
 */

import {
    createPrismaMock,
    jsonRequest,
    readJson,
    type PrismaMock,
} from './helpers/routeHarness';

let mock: PrismaMock = createPrismaMock();

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__frFlow1Prisma; },
}));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));

const notify = jest.fn(async () => undefined);
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: (...args: any[]) => notify(...(args as [])),
}));

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

const VALID = {
    name: 'Jo Coordinator',
    email: 'jo@lincolnpta.org',
    phone: '555-0100',
    orgName: 'Lincoln PTA',
    deliveryLocation: 'Lincoln Elementary Gym',
    website: 'https://lincolnpta.org',
    cause: 'New playground',
    notes: 'Hoping for a spring date',
    slug: 'tenant-a',
};

function useMock(m: PrismaMock) {
    mock = m;
    (global as any).__frFlow1Prisma = m.client;
}

/** Tenant resolves; no existing customer; an admin exists to notify. */
function freshTenantMock(extra: Record<string, any> = {}) {
    return createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A },
            'customer.findFirst': null,
            $queryRaw: [],
            'user.findFirst': { email: 'owner@tenant-a.com' },
            ...extra,
        },
    });
}

const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/public/fundraiser-request/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/fundraiser-request', body)));
};

beforeEach(() => {
    jest.clearAllMocks();
    notify.mockClear();
    notify.mockImplementation(async () => undefined);
    useMock(freshTenantMock());
});

describe('1. a valid inquiry is actually persisted', () => {
    it('succeeds and reports that a lead was created', async () => {
        const { status, body } = await post(VALID);
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.created).toBe(true);
    });

    it('writes exactly one Customer row', async () => {
        await post(VALID);
        expect(mock.callsTo('customer.create')).toHaveLength(1);
    });

    it('preserves the submitted organization and contact details', async () => {
        await post(VALID);
        const data = mock.firstCall('customer.create')!.args.data;
        expect(data.name).toBe('Lincoln PTA');
        expect(data.contact_name).toBe('Jo Coordinator');
        expect(data.contact_email).toBe('jo@lincolnpta.org');
        expect(data.contact_phone).toBe('555-0100');
    });

    it('keeps the inquiry context the form collects but had no column for', async () => {
        await post(VALID);
        const notes = mock.firstCall('customer.create')!.args.data.notes as string;
        expect(notes).toContain('Lincoln Elementary Gym'); // deliveryLocation
        expect(notes).toContain('https://lincolnpta.org');  // website
        expect(notes).toContain('New playground');          // cause
        expect(notes).toContain('Hoping for a spring date'); // notes
    });

    it('marks the lead source so it is distinguishable from a hand-typed lead', async () => {
        await post(VALID);
        const data = mock.firstCall('customer.create')!.args.data;
        expect(data.source).toBe('Fundraiser Inquiry');
        expect(data.tags).toContain('fundraiser_inquiry');
    });
});

describe('2. the lead lands in the right tenant', () => {
    it('resolves the tenant from the storefront slug', async () => {
        await post(VALID);
        expect(JSON.stringify(mock.firstCall('business.findFirst')!.args)).toContain('tenant-a');
        expect(mock.firstCall('customer.create')!.args.data.business_id).toBe(TENANT_A);
    });

    it('ignores a businessId supplied by the client', async () => {
        await post({ ...VALID, businessId: TENANT_B });
        const data = mock.firstCall('customer.create')!.args.data;
        expect(data.business_id).toBe(TENANT_A);
        expect(data.business_id).not.toBe(TENANT_B);
    });

    it('rejects an unknown storefront without writing anything', async () => {
        useMock(createPrismaMock({ results: { 'business.findFirst': null } }));
        const { status } = await post(VALID);
        expect(status).toBe(404);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });

    it('rejects a missing slug rather than guessing a tenant', async () => {
        const { slug, ...noSlug } = VALID;
        const { status } = await post(noSlug);
        expect(status).toBe(400);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });
});

describe('3. an inquiry is NOT a fundraiser', () => {
    it('never creates a FundraiserCampaign', async () => {
        await post(VALID);
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('creates no campaign even on a repeat submission', async () => {
        await post(VALID);
        useMock(freshTenantMock({
            'customer.findFirst': { id: 'cust-1', business_id: TENANT_A, contact_name: 'Jo', contact_phone: '555-0100', notes: 'x', tags: ['fundraiser_inquiry'] },
            $queryRaw: [{ id: 'cust-1', business_id: TENANT_A, contact_name: 'Jo', contact_phone: '555-0100', notes: 'x', tags: ['fundraiser_inquiry'] }],
        }));
        await post(VALID);
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });
});

describe('4. the lead is visible in the existing Fundraiser CRM', () => {
    // The CRM organization list is
    //   customer.findMany({ where: { business_id, type: { in: ['fundraiser_org','organization'] } } })
    // so the row must carry that type (and LEAD status) to appear there.
    it('writes the type the Fundraiser CRM query filters on', async () => {
        await post(VALID);
        expect(mock.firstCall('customer.create')!.args.data.type).toBe('fundraiser_org');
    });

    it('writes LEAD status so it reads as a lead, not an active org', async () => {
        await post(VALID);
        expect(mock.firstCall('customer.create')!.args.data.status).toBe('LEAD');
    });
});

describe('5. duplicate submissions are safe', () => {
    it('does not create a second organization for a repeat submit', async () => {
        useMock(freshTenantMock({
            'customer.findFirst': {
                id: 'cust-1', business_id: TENANT_A,
                contact_name: 'Jo Coordinator', contact_phone: '555-0100',
                notes: 'earlier note', tags: ['fundraiser_inquiry'],
            },
            $queryRaw: [{
                id: 'cust-1', business_id: TENANT_A,
                contact_name: 'Jo Coordinator', contact_phone: '555-0100',
                notes: 'earlier note', tags: ['fundraiser_inquiry'],
            }],
        }));
        const { status, body } = await post(VALID);
        expect(status).toBe(200);
        expect(body.created).toBe(false);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });

    it('matches the existing organization within the tenant, by email', async () => {
        useMock(freshTenantMock({
            'customer.findFirst': { id: 'cust-1', business_id: TENANT_A, tags: [] },
            $queryRaw: [{ id: 'cust-1', business_id: TENANT_A, tags: [] }],
        }));
        await post(VALID);
        // FR-PUBLIC-IDENTITY-1: the match now runs through a parameterized
        // candidate query instead of an ILIKE `customer.findFirst`. The
        // protection asserted here is unchanged — tenant scope plus this email.
        const lookup = mock.firstCall('$queryRaw.raw')!;
        expect(lookup.args.values).toEqual([TENANT_A, 'jo@lincolnpta.org']);
        expect(lookup.args.sql).toContain('business_id');
        expect(lookup.args.sql).not.toMatch(/ILIKE/i);
    });

    it('enriches only blank fields — it never overwrites tenant corrections', async () => {
        useMock(freshTenantMock({
            'customer.findFirst': {
                id: 'cust-1', business_id: TENANT_A,
                contact_name: 'Corrected By Tenant',
                contact_phone: '555-9999',
                notes: 'tenant wrote this',
                tags: ['fundraiser_inquiry'],
            },
            $queryRaw: [{
                id: 'cust-1', business_id: TENANT_A,
                contact_name: 'Corrected By Tenant',
                contact_phone: '555-9999',
                notes: 'tenant wrote this',
                tags: ['fundraiser_inquiry'],
            }],
        }));
        await post(VALID);
        const updates = mock.callsTo('customer.update');
        for (const u of updates) {
            expect(u.args.data.contact_name).toBeUndefined();
            expect(u.args.data.contact_phone).toBeUndefined();
            expect(u.args.data.notes).toBeUndefined();
        }
    });

    it('fills in fields that are genuinely blank', async () => {
        useMock(freshTenantMock({
            'customer.findFirst': { id: 'cust-1', business_id: TENANT_A, contact_name: null, contact_phone: null, notes: null, tags: [] },
            $queryRaw: [{ id: 'cust-1', business_id: TENANT_A, contact_name: null, contact_phone: null, notes: null, tags: [] }],
        }));
        await post(VALID);
        const data = mock.firstCall('customer.update')!.args.data;
        expect(data.contact_name).toBe('Jo Coordinator');
        expect(data.contact_phone).toBe('555-0100');
        expect(data.tags).toContain('fundraiser_inquiry');
    });
});

describe('6. input validation is truthful', () => {
    it('rejects a missing required field', async () => {
        const { status } = await post({ ...VALID, orgName: '' });
        expect(status).toBe(400);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });

    it('rejects an unusable email address', async () => {
        for (const bad of ['not-an-email', 'a@b', 'x y@z.com']) {
            useMock(freshTenantMock());
            const { status } = await post({ ...VALID, email: bad });
            expect(status).toBe(400);
            expect(mock.callsTo('customer.create')).toHaveLength(0);
        }
    });

    it('rejects whitespace-only input that would otherwise look present', async () => {
        const { status } = await post({ ...VALID, name: '    ' });
        expect(status).toBe(400);
    });

    it('caps oversized free text rather than storing it unbounded', async () => {
        useMock(freshTenantMock());
        await post({ ...VALID, notes: 'x'.repeat(9000) });
        const notes = mock.firstCall('customer.create')!.args.data.notes as string;
        expect(notes.length).toBeLessThan(4000);
    });
});

describe('7. notification never costs us the lead', () => {
    it('notifies the tenant, using the tenant sender', async () => {
        await post(VALID);
        expect(notify).toHaveBeenCalledTimes(1);
        const [to, lead, businessId] = notify.mock.calls[0] as any[];
        expect(to).toBe('owner@tenant-a.com');
        expect(lead.source).toBe('Fundraiser Inquiry');
        expect(businessId).toBe(TENANT_A); // tenant sender, not platform FROM_EMAIL
    });

    it('still returns success and keeps the lead when notification throws', async () => {
        notify.mockImplementation(async () => { throw new Error('resend is down'); });
        const { status, body } = await post(VALID);
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        // The write happened BEFORE the notification and is not rolled back.
        expect(mock.callsTo('customer.create')).toHaveLength(1);
    });

    it('still succeeds when the tenant has no user to notify', async () => {
        useMock(freshTenantMock({ 'user.findFirst': null }));
        const { status } = await post(VALID);
        expect(status).toBe(200);
        expect(notify).not.toHaveBeenCalled();
        expect(mock.callsTo('customer.create')).toHaveLength(1);
    });
});
