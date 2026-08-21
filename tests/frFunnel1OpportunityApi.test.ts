/**
 * FR-FUNNEL-1 — the opportunity mutation surface.
 *
 * Small on purpose: record that we replied, record the dates, confirm the
 * delivery day, mark it lost. Everything asserted here is either a tenant-safety
 * property or a lifecycle rule the CRM depends on.
 */

import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';

let mock: PrismaMock = createPrismaMock();
let session: any = { user: { businessId: 'biz-aaaa-1111', email: 'owner@tenant-a.com' } };

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__frFunnel1OppPrisma; },
}));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__frFunnel1Session) }));

const TENANT_A = 'biz-aaaa-1111';
const OPP = 'opp-1';

function useMock(m: PrismaMock) {
    mock = m;
    (global as any).__frFunnel1OppPrisma = m.client;
}
function useSession(s: any) {
    session = s;
    (global as any).__frFunnel1Session = s;
}

function openOpportunity(extra: Record<string, any> = {}) {
    return createPrismaMock({
        results: {
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'new', first_response_at: null, preferred_delivery_date: null,
            },
            'fundraiserOpportunity.updateMany': { count: 1 },
            ...extra,
        },
    });
}

const patch = async (body: unknown, id = OPP) => {
    const { PATCH } = await import('@/app/api/opportunities/[id]/route');
    const req = new Request(`http://localhost/api/opportunities/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJson(await PATCH(req, { params: Promise.resolve({ id }) }));
};

beforeEach(() => {
    jest.clearAllMocks();
    useSession({ user: { businessId: TENANT_A, email: 'owner@tenant-a.com' } });
    useMock(openOpportunity());
});

describe('tenant authentication and isolation', () => {
    it('401s an unauthenticated caller before touching the database', async () => {
        useSession(null);
        const res = await patch({ action: 'mark_responded' });
        expect(res.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });

    it('401s a session with no businessId', async () => {
        useSession({ user: { email: 'x@y.com' } });
        const res = await patch({ action: 'mark_responded' });
        expect(res.status).toBe(401);
    });

    it('scopes the lookup to the caller\'s tenant', async () => {
        await patch({ action: 'mark_responded' });
        expect(mock.firstCall('fundraiserOpportunity.findFirst')!.args.where).toEqual({
            id: OPP, business_id: TENANT_A,
        });
    });

    it('404s (not 403) another tenant\'s opportunity, so ids cannot be probed', async () => {
        useMock(createPrismaMock({ results: { 'fundraiserOpportunity.findFirst': null } }));
        const res = await patch({ action: 'mark_responded' }, 'opp-of-tenant-b');
        expect(res.status).toBe(404);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });

    it('re-applies the tenant scope on the write itself', async () => {
        await patch({ action: 'mark_responded' });
        expect(mock.firstCall('fundraiserOpportunity.updateMany')!.args.where).toEqual({
            id: OPP, business_id: TENANT_A,
        });
    });
});

describe('mark_responded', () => {
    it('stamps first_response_at and moves new -> in_conversation', async () => {
        const res = await patch({ action: 'mark_responded' });
        expect(res.status).toBe(200);
        const d = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(d.first_response_at).toBeInstanceOf(Date);
        expect(d.status).toBe('in_conversation');
    });

    it('is idempotent — a second click does NOT move the response clock', async () => {
        useMock(openOpportunity({
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'in_conversation',
                first_response_at: new Date('2026-08-18T10:00:00Z'), preferred_delivery_date: null,
            },
        }));
        const res = await patch({ action: 'mark_responded' });
        expect(res.status).toBe(200);
        expect(res.body.changed).toBe(false);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });
});

describe('date workflow', () => {
    it('stores a preferred delivery date and enters conversation', async () => {
        await patch({ action: 'set_dates', preferred_delivery_date: '2026-10-17' });
        const d = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(d.preferred_delivery_date.toISOString()).toBe('2026-10-17T00:00:00.000Z');
        expect(d.status).toBe('in_conversation');
    });

    it('stores an alternate delivery date', async () => {
        await patch({ action: 'set_dates', alternate_delivery_date: '2026-10-24' });
        expect(mock.firstCall('fundraiserOpportunity.updateMany')!.args.data
            .alternate_delivery_date.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    });

    it('allows explicitly clearing a date with null', async () => {
        await patch({ action: 'set_dates', preferred_delivery_date: null });
        expect(mock.firstCall('fundraiserOpportunity.updateMany')!.args.data.preferred_delivery_date).toBeNull();
    });

    it('ignores a malformed date instead of storing garbage', async () => {
        const res = await patch({ action: 'set_dates', preferred_delivery_date: '17/10/2026' });
        expect(res.status).toBe(400);
    });

    it('confirming a date sets confirmed_delivery_date and status date_confirmed', async () => {
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-10-17' });
        const d = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(d.confirmed_delivery_date.toISOString()).toBe('2026-10-17T00:00:00.000Z');
        expect(d.status).toBe('date_confirmed');
    });

    // FR-ACCEPTANCE-1C. This test used to assert the opposite — that confirming a
    // date backfilled first_response_at — on the theory that you cannot agree a
    // date without having spoken. But a tenant can confirm a date they were given
    // across a table at a school fair, and stamping it here wrote "we replied at
    // 12:20" into permanent CRM history for a reply that never happened. The
    // response-time figure derived from it was fiction too.
    it('confirming a date does NOT fabricate a first reply', async () => {
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-10-17' });
        const data = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(data.first_response_at).toBeUndefined();
        // The things confirming a date IS allowed to do must still happen —
        // date_confirmed is the sole launch gate.
        expect(data.status).toBe('date_confirmed');
        expect(data.confirmed_delivery_date).toBeInstanceOf(Date);
    });

    it('confirming a date leaves an EXISTING first reply alone', async () => {
        useMock(openOpportunity({
            'fundraiserOpportunity.findFirst': {
                id: OPP,
                status: 'in_conversation',
                first_response_at: new Date('2026-10-01T15:00:00.000Z'),
                preferred_delivery_date: null,
            },
        }));
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-10-17' });
        const data = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(data.first_response_at).toBeUndefined();
        expect(data.status).toBe('date_confirmed');
    });

    it('an explicit "I replied elsewhere" is STILL the way a reply gets recorded', async () => {
        await patch({ action: 'mark_responded' });
        expect(mock.firstCall('fundraiserOpportunity.updateMany')!.args.data.first_response_at)
            .toBeInstanceOf(Date);
    });

    it('requires a date to confirm', async () => {
        const res = await patch({ action: 'confirm_date' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });
});

describe('lost disposition', () => {
    it('records the reason and timestamp without deleting anything', async () => {
        const res = await patch({ action: 'mark_lost', lost_reason: 'date_unavailable' });
        expect(res.status).toBe(200);
        const d = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(d.status).toBe('lost');
        expect(d.lost_reason).toBe('date_unavailable');
        expect(d.lost_at).toBeInstanceOf(Date);
        expect(mock.callsTo('fundraiserOpportunity.delete')).toHaveLength(0);
        expect(mock.callsTo('customer.delete')).toHaveLength(0);
    });

    it('accepts every published reason', async () => {
        for (const reason of ['no_response', 'date_unavailable', 'not_interested', 'postponed',
            'duplicate', 'not_a_fit', 'chose_other_fundraiser', 'other']) {
            useMock(openOpportunity());
            const res = await patch({ action: 'mark_lost', lost_reason: reason });
            expect(res.status).toBe(200);
        }
    });

    it('rejects an unpublished reason', async () => {
        const res = await patch({ action: 'mark_lost', lost_reason: 'ghosted_us' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });

    it('requires a reason', async () => {
        const res = await patch({ action: 'mark_lost' });
        expect(res.status).toBe(400);
    });
});

describe('terminal opportunities are closed to edits', () => {
    for (const status of ['converted', 'lost']) {
        it(`409s a ${status} opportunity`, async () => {
            useMock(openOpportunity({
                'fundraiserOpportunity.findFirst': { id: OPP, status, first_response_at: null, preferred_delivery_date: null },
            }));
            const res = await patch({ action: 'mark_responded' });
            expect(res.status).toBe(409);
            expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
        });
    }
});

describe('the route cannot exceed its remit', () => {
    it('rejects an unknown action', async () => {
        const res = await patch({ action: 'convert_to_campaign' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });

    it('never creates a FundraiserCampaign', async () => {
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-10-17' });
        expect(mock.calls.filter((c) => c.model === 'fundraiserCampaign')).toHaveLength(0);
    });

    it('never sets status to converted', async () => {
        for (const action of ['mark_responded', 'confirm_date', 'mark_lost']) {
            useMock(openOpportunity());
            await patch({ action, confirmed_delivery_date: '2026-10-17', lost_reason: 'other' });
            const call = mock.firstCall('fundraiserOpportunity.updateMany');
            if (call) expect(call.args.data.status).not.toBe('converted');
        }
    });

    it('never touches Customer.type or Customer.source', async () => {
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-10-17' });
        expect(mock.calls.filter((c) => c.model === 'customer')).toHaveLength(0);
    });
});
