/**
 * FR-FUNNEL-1 — the public inquiry route as a funnel entry point.
 *
 * FR-FLOW-1 proved the lead is saved. This suite proves the lead now has
 * STRUCTURE: an immutable inquiry event, exactly one open opportunity per
 * organization, controlled attribution, and duplicate handling that needs no
 * time window. Every FR-FLOW-1 security property is re-asserted here too,
 * because this route was rewritten and those properties must not regress.
 */

import {
    createPrismaMock,
    jsonRequest,
    readJson,
    type PrismaMock,
} from './helpers/routeHarness';

let mock: PrismaMock = createPrismaMock();

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__frFunnel1Prisma; },
}));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));

const notify = jest.fn(async () => undefined);
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: (...args: any[]) => notify(...(args as [])),
}));

const TENANT_A = 'biz-aaaa-1111';
const OPP_ID = 'opp-existing-1';

const VALID = {
    name: 'Jo Coordinator',
    email: 'jo@lincolnpta.org',
    phone: '555-0100',
    orgName: 'Lincoln PTA',
    slug: 'tenant-a',
};

function useMock(m: PrismaMock) {
    mock = m;
    (global as any).__frFunnel1Prisma = m.client;
}

/** Tenant resolves; no existing customer; no open opportunity; admin to notify. */
function freshMock(extra: Record<string, any> = {}) {
    return createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A },
            'customer.findFirst': null,
            $queryRaw: [],
            'fundraiserOpportunity.findFirst': null,
            'fundraiserInquiry.findFirst': null,
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
    useMock(freshMock());
});

// ── Intake contract ──────────────────────────────────────────────────────────

describe('intake friction', () => {
    it('accepts an inquiry WITHOUT a delivery location', async () => {
        const res = await post(VALID);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(1);
    });

    it('still requires organization, name, email and phone', async () => {
        for (const missing of ['name', 'email', 'phone', 'orgName']) {
            useMock(freshMock());
            const body: any = { ...VALID };
            delete body[missing];
            const res = await post(body);
            expect(res.status).toBe(400);
            expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(0);
        }
    });

    it('rejects an implausible email before writing anything', async () => {
        const res = await post({ ...VALID, email: 'not-an-email' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });

    it('preserves optional context as readable notes without inventing schema', async () => {
        await post({ ...VALID, deliveryLocation: 'Gym', website: 'https://x.org', cause: 'Band', notes: 'after 5' });
        const created = mock.firstCall('fundraiserInquiry.create')!.args.data;
        expect(created.context).toContain('Delivery/pickup area: Gym');
        expect(created.context).toContain('Cause: Band');
    });
});

// ── Tenant resolution ────────────────────────────────────────────────────────

describe('tenant resolution stays server-trusted', () => {
    it('resolves the tenant from the slug, never from a client businessId', async () => {
        await post({ ...VALID, businessId: 'attacker-tenant' });
        const inquiry = mock.firstCall('fundraiserInquiry.create')!.args.data;
        expect(inquiry.business_id).toBe(TENANT_A);
    });

    it('404s an unknown storefront without writing', async () => {
        useMock(freshMock({ 'business.findFirst': null }));
        const res = await post(VALID);
        expect(res.status).toBe(404);
        expect(mock.callsTo('fundraiserOpportunity.create')).toHaveLength(0);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(0);
    });

    it('scopes the customer lookup to the resolved tenant', async () => {
        await post(VALID);
        // FR-FUNNEL-1P: candidates come from the parameterized identity query.
        expect(mock.firstCall('$queryRaw.raw')!.args.values[0]).toBe(TENANT_A);
    });
});

// ── Source attribution ───────────────────────────────────────────────────────

describe('source attribution', () => {
    it('defaults a storefront inquiry to tenant_website', async () => {
        await post(VALID);
        expect(mock.firstCall('fundraiserInquiry.create')!.args.data.source_channel).toBe('tenant_website');
    });

    it('accepts a recognised channel and its detail', async () => {
        await post({ ...VALID, sourceChannel: 'meta_lead', sourceDetail: 'Fall 2026 ad set B' });
        const d = mock.firstCall('fundraiserInquiry.create')!.args.data;
        expect(d.source_channel).toBe('meta_lead');
        expect(d.source_detail).toBe('Fall 2026 ad set B');
    });

    it('REJECTS an unknown channel instead of storing it', async () => {
        const res = await post({ ...VALID, sourceChannel: 'tiktok' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(0);
    });

    it('caps source_detail at 300 characters', async () => {
        await post({ ...VALID, sourceChannel: 'paid_ad', sourceDetail: 'y'.repeat(900) });
        expect(mock.firstCall('fundraiserInquiry.create')!.args.data.source_detail).toHaveLength(300);
    });
});

// ── Customer identity safety (FR-FLOW-1 properties, re-asserted) ─────────────

describe('customer identity is never damaged', () => {
    it('creates a brand-new organization as fundraiser_org / LEAD with the tag', async () => {
        await post(VALID);
        const d = mock.firstCall('customer.create')!.args.data;
        expect(d.type).toBe('fundraiser_org');
        expect(d.status).toBe('LEAD');
        expect(d.source).toBe('Fundraiser Inquiry');
        expect(d.tags).toContain('fundraiser_inquiry');
    });

    it('NEVER rewrites an existing direct_customer\'s type or source', async () => {
        useMock(freshMock({
            'customer.findFirst': {
                id: 'cust-retail', type: 'direct_customer', source: 'storefront',
                contact_name: 'Jo', contact_phone: '555', notes: 'existing', tags: [],
            },
            $queryRaw: [{
                id: 'cust-retail', type: 'direct_customer', source: 'storefront',
                contact_name: 'Jo', contact_phone: '555', notes: 'existing', tags: [],
            }],
        }));
        await post(VALID);
        const patch = mock.firstCall('customer.update')!.args.data;
        expect(patch).not.toHaveProperty('type');
        expect(patch).not.toHaveProperty('source');
        expect(patch).not.toHaveProperty('status');
        expect(patch.tags).toContain('fundraiser_inquiry');
    });

    it('NEVER rewrites a storefront/waitlist signup\'s type or source', async () => {
        useMock(freshMock({
            'customer.findFirst': {
                id: 'cust-waitlist', type: 'direct_customer', source: 'Surplus Waitlist',
                contact_name: 'Jo', contact_phone: '555', notes: 'n', tags: ['surplus_waitlist'],
            },
            $queryRaw: [{
                id: 'cust-waitlist', type: 'direct_customer', source: 'Surplus Waitlist',
                contact_name: 'Jo', contact_phone: '555', notes: 'n', tags: ['surplus_waitlist'],
            }],
        }));
        await post(VALID);
        const patch = mock.firstCall('customer.update')!.args.data;
        expect(patch).not.toHaveProperty('source');
        expect(patch.tags).toEqual(['surplus_waitlist', 'fundraiser_inquiry']);
    });

    it('enriches only BLANK fields on an existing organization', async () => {
        useMock(freshMock({
            'customer.findFirst': {
                id: 'cust-known', type: 'fundraiser_org', source: 'Manual', name: 'Lincoln PTA',
                contact_name: 'Tenant Corrected Name', contact_phone: null, notes: 'tenant note',
                tags: ['fundraiser_inquiry'],
            },
            $queryRaw: [{
                id: 'cust-known', type: 'fundraiser_org', source: 'Manual', name: 'Lincoln PTA',
                contact_name: 'Tenant Corrected Name', contact_phone: null, notes: 'tenant note',
                tags: ['fundraiser_inquiry'],
            }],
        }));
        await post(VALID);
        const patch = mock.firstCall('customer.update')!.args.data;
        expect(patch).not.toHaveProperty('contact_name'); // already set — untouched
        expect(patch).not.toHaveProperty('notes');        // already set — untouched
        expect(patch.contact_phone).toBe('555-0100');     // was blank — filled
    });
});

// ── The funnel structure itself ──────────────────────────────────────────────

describe('inquiry and opportunity structure', () => {
    it('creates an opportunity in status new when none is open', async () => {
        await post(VALID);
        const opp = mock.firstCall('fundraiserOpportunity.create')!.args.data;
        expect(opp.status).toBe('new');
        expect(opp.business_id).toBe(TENANT_A);
    });

    it('ALWAYS attaches the inquiry to an opportunity (never an orphan)', async () => {
        await post(VALID);
        const inquiry = mock.firstCall('fundraiserInquiry.create')!.args.data;
        expect(inquiry.opportunity_id).toBeTruthy();
    });

    it('looks for the open opportunity using exactly the indexed statuses', async () => {
        await post(VALID);
        const where = mock.firstCall('fundraiserOpportunity.findFirst')!.args.where;
        expect(where.business_id).toBe(TENANT_A);
        expect(where.status.in).toEqual(['new', 'in_conversation', 'date_confirmed']);
    });

    it('REUSES an open opportunity instead of creating a second one', async () => {
        useMock(freshMock({
            'customer.findFirst': { id: 'cust-known', type: 'fundraiser_org', source: 'Manual', tags: ['fundraiser_inquiry'], contact_name: 'x', contact_phone: 'y', notes: 'z' },
            $queryRaw: [{ id: 'cust-known', type: 'fundraiser_org', source: 'Manual', tags: ['fundraiser_inquiry'], contact_name: 'x', contact_phone: 'y', notes: 'z' }],
            'fundraiserOpportunity.findFirst': { id: OPP_ID },
        }));
        await post(VALID);
        expect(mock.callsTo('fundraiserOpportunity.create')).toHaveLength(0);
        expect(mock.firstCall('fundraiserInquiry.create')!.args.data.opportunity_id).toBe(OPP_ID);
    });

    it('a repeat genuine inquiry still APPENDS an auditable event', async () => {
        useMock(freshMock({
            'customer.findFirst': { id: 'cust-known', type: 'fundraiser_org', source: 'Manual', tags: ['fundraiser_inquiry'], contact_name: 'x', contact_phone: 'y', notes: 'z' },
            $queryRaw: [{ id: 'cust-known', type: 'fundraiser_org', source: 'Manual', tags: ['fundraiser_inquiry'], contact_name: 'x', contact_phone: 'y', notes: 'z' }],
            'fundraiserOpportunity.findFirst': { id: OPP_ID },
        }));
        await post(VALID);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(1);
    });

    it('a terminal (converted/lost) prior opportunity starts a NEW cycle', async () => {
        // findFirst is scoped to open statuses, so a converted/lost row is
        // invisible to it — the route creates a fresh opportunity.
        useMock(freshMock({
            'customer.findFirst': { id: 'cust-known', type: 'fundraiser_org', source: 'Manual', tags: ['fundraiser_inquiry'], contact_name: 'x', contact_phone: 'y', notes: 'z' },
            $queryRaw: [{ id: 'cust-known', type: 'fundraiser_org', source: 'Manual', tags: ['fundraiser_inquiry'], contact_name: 'x', contact_phone: 'y', notes: 'z' }],
            'fundraiserOpportunity.findFirst': null,
        }));
        await post(VALID);
        expect(mock.callsTo('fundraiserOpportunity.create')).toHaveLength(1);
    });

    it('NEVER creates a FundraiserCampaign', async () => {
        await post(VALID);
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
        expect(mock.calls.filter((c) => c.model === 'fundraiserCampaign')).toHaveLength(0);
    });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('submission-key idempotency', () => {
    const KEY = 'b3f1c2d4-1111-2222-3333-444455556666';

    it('records the key and fingerprint when one is supplied', async () => {
        await post({ ...VALID, submissionKey: KEY });
        const d = mock.firstCall('fundraiserInquiry.create')!.args.data;
        expect(d.submission_key).toBe(KEY);
        expect(d.submission_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the ORIGINAL inquiry when the same key and payload replay', async () => {
        const { buildInquiryFingerprint } = await import('@/lib/fundraiserFunnel');
        const fp = buildInquiryFingerprint({
            slug: VALID.slug, organizationName: VALID.orgName,
            contactEmail: VALID.email, contactName: VALID.name, contactPhone: VALID.phone,
        });
        useMock(freshMock({
            'fundraiserInquiry.findFirst': {
                id: 'inq-original', customer_id: 'cust-1', opportunity_id: OPP_ID, submission_fingerprint: fp,
            },
        }));
        const res = await post({ ...VALID, submissionKey: KEY });
        expect(res.status).toBe(200);
        expect(res.body.duplicate).toBe(true);
        expect(res.body.inquiryId).toBe('inq-original');
        // Nothing new was written.
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(0);
        expect(mock.callsTo('fundraiserOpportunity.create')).toHaveLength(0);
    });

    it('CONFLICTS when the same key replays with a different payload', async () => {
        useMock(freshMock({
            'fundraiserInquiry.findFirst': {
                id: 'inq-original', customer_id: 'cust-1', opportunity_id: OPP_ID,
                submission_fingerprint: 'a-different-digest',
            },
        }));
        const res = await post({ ...VALID, submissionKey: KEY });
        expect(res.status).toBe(409);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(0);
    });

    it('scopes the replay lookup to the tenant (no cross-tenant key collision)', async () => {
        await post({ ...VALID, submissionKey: KEY });
        const where = mock.firstCall('fundraiserInquiry.findFirst')!.args.where;
        expect(where.business_id).toBe(TENANT_A);
        expect(where.submission_key).toBe(KEY);
    });

    it('rejects a malformed key rather than silently dropping protection', async () => {
        const res = await post({ ...VALID, submissionKey: 'short' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(0);
    });

    it('still accepts a submission with NO key (phased rollout)', async () => {
        const res = await post(VALID);
        expect(res.status).toBe(200);
        expect(mock.firstCall('fundraiserInquiry.create')!.args.data.submission_key).toBeNull();
        expect(mock.firstCall('fundraiserInquiry.create')!.args.data.submission_fingerprint).toBeNull();
    });
});

// ── Durability ───────────────────────────────────────────────────────────────

// ── FR-FUNNEL-1R: customer-resolution serialization ──────────────────────────

describe('customer-resolution serialization', () => {
    const indexOf = (pred: (c: any) => boolean) => mock.calls.findIndex(pred);
    const lockCall = () => mock.calls.find(
        (c) => c.model === '$executeRawUnsafe' && /pg_advisory_xact_lock/.test(String(c.args?.sql)));

    it('takes a transaction-scoped advisory lock', async () => {
        await post(VALID);
        expect(lockCall()).toBeDefined();
        expect(String(lockCall()!.args.sql)).toContain('pg_advisory_xact_lock');
    });

    it('locks on the tenant + normalized email identity', async () => {
        const { identityLockKey } = await import('@/lib/publicIdentity');
        await post({ ...VALID, email: '  JO@LincolnPTA.org ' });
        expect(lockCall()!.args.values[0]).toBe(identityLockKey(TENANT_A, 'jo@lincolnpta.org'));
    });

    it('RE-QUERIES the customer AFTER the lock, never before', async () => {
        await post(VALID);
        const lockIdx = indexOf((c) => c.model === '$executeRawUnsafe' && /pg_advisory_xact_lock/.test(String(c.args?.sql)));
        const lookupIdx = indexOf((c) => c.model === '$queryRaw');
        expect(lockIdx).toBeGreaterThanOrEqual(0);
        expect(lookupIdx).toBeGreaterThan(lockIdx);
    });

    it('creates the customer only AFTER the post-lock lookup', async () => {
        await post(VALID);
        const lookupIdx = indexOf((c) => c.model === '$queryRaw');
        const createIdx = indexOf((c) => c.model === 'customer' && c.method === 'create');
        expect(lookupIdx).toBeGreaterThanOrEqual(0);
        expect(createIdx).toBeGreaterThanOrEqual(0);
        expect(createIdx).toBeGreaterThan(lookupIdx);
    });

    it('holds the lock only inside the transaction — email is sent after', async () => {
        await post(VALID);
        const inquiryIdx = indexOf((c) => c.model === 'fundraiserInquiry' && c.method === 'create');
        expect(inquiryIdx).toBeGreaterThanOrEqual(0);
        // The notification is dispatched after the transaction callback returns.
        expect(notify).toHaveBeenCalledTimes(1);
        expect(mock.client.$transaction).toHaveBeenCalled();
    });

    it('does NOT lock when the request is rejected before the transaction', async () => {
        useMock(freshMock({ 'business.findFirst': null }));
        await post(VALID);
        expect(lockCall()).toBeUndefined();
    });

    it('does not replace submission-key idempotency — both protections run', async () => {
        await post({ ...VALID, submissionKey: 'b3f1c2d4-1111-2222-3333-444455556666' });
        expect(lockCall()).toBeDefined();
        expect(mock.firstCall('fundraiserInquiry.findFirst')).toBeDefined(); // replay pre-check
        expect(mock.firstCall('fundraiserInquiry.create')!.args.data.submission_key).toBeTruthy();
    });
});

describe('durability', () => {
    it('writes the funnel inside a transaction', async () => {
        await post(VALID);
        expect(mock.client.$transaction).toHaveBeenCalled();
    });

    it('a mail outage does NOT lose the inquiry or the opportunity', async () => {
        notify.mockRejectedValueOnce(new Error('Resend is down'));
        const res = await post(VALID);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mock.callsTo('fundraiserOpportunity.create')).toHaveLength(1);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(1);
    });

    it('notifies only AFTER the durable write', async () => {
        await post(VALID);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][2]).toBe(TENANT_A);
    });
});
