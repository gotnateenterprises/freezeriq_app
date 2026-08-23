/**
 * FR-ACCEPTANCE-2A.1 — per-inquiry human response, proven against the real route.
 *
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * FundraiserOpportunity.first_response_at is write-once by design: its writer
 * guards on `if (!current.first_response_at)` so the response-time metric stays
 * a real measurement rather than a rolling one.
 *
 * That makes answering a SECOND inquiry on the same opportunity a silent no-op.
 * `data` came out empty, the route's own early return fired, and the tenant got
 * `{ success: true }` for a write that never happened — while the CRM went on
 * showing the inquiry as unanswered.
 *
 * These tests drive the actual PATCH handler.
 */

import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';

let mock: PrismaMock = createPrismaMock();

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__ackHumanPrisma; },
}));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__ackHumanSession) }));

const TENANT = 'biz-aaaa-1111';
const OPP = 'opp-1';
const INQ_OLD = 'inq-spring';
const INQ_NEW = 'inq-autumn';

function useMock(m: PrismaMock) { mock = m; (global as any).__ackHumanPrisma = m.client; }

/** An opportunity already answered once, now holding a second unanswered inquiry. */
function answeredWithNewInquiry(extra: Record<string, any> = {}) {
    return createPrismaMock({
        results: {
            'fundraiserOpportunity.findFirst': {
                id: OPP,
                status: 'in_conversation',
                // Write-once, already set by the reply to the spring inquiry.
                first_response_at: new Date('2026-04-01T10:00:00Z'),
                preferred_delivery_date: null,
            },
            'fundraiserOpportunity.updateMany': { count: 1 },
            'fundraiserInquiry.count': 1,
            'fundraiserInquiry.updateMany': { count: 1 },
            ...extra,
        },
    });
}

const patch = async (body: unknown, id = OPP) => {
    const { PATCH } = await import('@/app/api/opportunities/[id]/route');
    return readJson(await PATCH(
        new Request(`http://localhost/api/opportunities/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) } as any
    ));
};

beforeEach(() => {
    jest.clearAllMocks();
    (global as any).__ackHumanSession = { user: { businessId: TENANT, email: 'owner@tenant-a.com' } };
    useMock(answeredWithNewInquiry());
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D — the reply to a second inquiry is durably recorded
// ═══════════════════════════════════════════════════════════════════════════

describe('answering a second inquiry', () => {
    it('records a human response even though first_response_at is already set', async () => {
        const res = await patch({ action: 'mark_responded' });

        expect(res.status).toBe(200);
        expect(res.body.changed).toBe(true);

        const w = mock.firstCall('fundraiserInquiry.updateMany')!.args;
        expect(w.data.human_response_at).toBeInstanceOf(Date);
        expect(w.where.opportunity_id).toBe(OPP);
    });

    it('does NOT move the opportunity first-response metric', async () => {
        await patch({ action: 'mark_responded' });
        const oppWrites = mock.callsTo('fundraiserOpportunity.updateMany');
        // Either no opportunity write at all, or one that never touches the
        // metric. Overwriting it would fix the display by destroying the number.
        for (const c of oppWrites) {
            expect(c.args.data).not.toHaveProperty('first_response_at');
        }
    });

    it('the old empty-data early return can no longer swallow the write', async () => {
        // first_response_at set AND status already in_conversation means `data`
        // is empty. That is exactly the case the early return used to answer
        // `{ success: true, changed: false }` while writing nothing.
        const res = await patch({ action: 'mark_responded' });
        expect(res.body.changed).toBe(true);
        expect(mock.callsTo('fundraiserInquiry.updateMany')).toHaveLength(1);
    });

    it('still reports no change when every inquiry is already answered', async () => {
        useMock(answeredWithNewInquiry({ 'fundraiserInquiry.count': 0 }));
        const res = await patch({ action: 'mark_responded' });
        expect(res.body.changed).toBe(false);
        expect(mock.callsTo('fundraiserInquiry.updateMany')).toHaveLength(0);
    });

    it('answers EVERY outstanding inquiry, not just the newest', async () => {
        // A reply to an organization answers the conversation, not one message
        // in it. Targeting only the newest also meant a second click would find
        // the NEXT-oldest unanswered inquiry and stamp now() onto it, inventing
        // a reply to a months-old message that nobody ever sent.
        await patch({ action: 'mark_responded' });
        const w = mock.firstCall('fundraiserInquiry.updateMany')!.args;
        expect(w.where).toEqual({
            business_id: TENANT, opportunity_id: OPP, human_response_at: null,
        });
        // No single-row targeting survives.
        expect(w.where).not.toHaveProperty('id');
    });

    it('is idempotent: a second click has nothing outstanding to stamp', async () => {
        useMock(answeredWithNewInquiry({ 'fundraiserInquiry.count': 0 }));
        const res = await patch({ action: 'mark_responded' });
        expect(res.body.changed).toBe(false);
        expect(mock.callsTo('fundraiserInquiry.updateMany')).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART E — which inquiry, and can it be steered from outside
// ═══════════════════════════════════════════════════════════════════════════

describe('the inquiry a response is applied to', () => {
    it('counts outstanding inquiries scoped to this tenant and opportunity', async () => {
        await patch({ action: 'mark_responded' });
        const q = mock.firstCall('fundraiserInquiry.count')!.args;
        expect(q.where).toEqual({ opportunity_id: OPP, business_id: TENANT, human_response_at: null });
    });

    it('is resolved on the SERVER — a client-supplied inquiry id is ignored', async () => {
        // A body-supplied id would let a tenant stamp a response onto an inquiry
        // of their choosing, including one under a different opportunity.
        await patch({ action: 'mark_responded', inquiry_id: 'inq-attacker', inquiryId: 'inq-attacker' });
        const w = mock.firstCall('fundraiserInquiry.updateMany')!.args;
        expect(JSON.stringify(w.where)).not.toContain('attacker');
        expect(w.where.opportunity_id).toBe(OPP);
    });

    it('re-asserts tenant AND opportunity scope at the point of the write', async () => {
        await patch({ action: 'mark_responded' });
        const w = mock.firstCall('fundraiserInquiry.updateMany')!.args;
        expect(w.where.business_id).toBe(TENANT);
        expect(w.where.opportunity_id).toBe(OPP);
        // Concurrency-safe: a racing second request matches zero rows rather
        // than moving a timestamp that has already passed.
        expect(w.where.human_response_at).toBeNull();
    });

    it('cannot touch another tenant\'s opportunity', async () => {
        useMock(createPrismaMock({ results: { 'fundraiserOpportunity.findFirst': null } }));
        const res = await patch({ action: 'mark_responded' });
        expect(res.status).toBe(404);
        expect(mock.callsTo('fundraiserInquiry.updateMany')).toHaveLength(0);
        expect(mock.callsTo('fundraiserInquiry.count')).toHaveLength(0);
    });

    it('rolls back the inquiry stamp if the opportunity write loses a race', async () => {
        // updateMany matching zero rows means another request made this
        // opportunity terminal, or already set the write-once metric. Recording
        // the reply anyway would leave the inquiry answered against an
        // opportunity whose own update never applied.
        useMock(answeredWithNewInquiry({
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'new', first_response_at: null, preferred_delivery_date: null,
            },
            'fundraiserOpportunity.updateMany': { count: 0 },
        }));
        const res = await patch({ action: 'mark_responded' });
        expect(res.status).toBe(404);
    });

    it('writes both facts inside ONE transaction', async () => {
        await patch({ action: 'mark_responded' });
        // A reply recorded on the opportunity but not the inquiry — or the
        // reverse — is the split-brain state this phase removes.
        expect((mock.client.$transaction as jest.Mock)).toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART L — automatic acknowledgement must never write a human response
// ═══════════════════════════════════════════════════════════════════════════

describe('the auto/human boundary', () => {
    const ackSrc = () => require('fs').readFileSync(
        require('path').join(process.cwd(), 'lib/inquiryAcknowledgement.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).filter((l: string) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

    it('the acknowledgement module writes neither human-response field', () => {
        const code = ackSrc();
        expect(code).not.toMatch(/human_response_at/);
        expect(code).not.toMatch(/first_response_at/);
        expect(code).not.toMatch(/fundraiserOpportunity/);
    });

    it('the acknowledgement module writes ONLY the two ack columns', () => {
        const code = ackSrc();
        const written = [...code.matchAll(/data:\s*\{([^}]*)\}/g)].map((m) => m[1]);
        expect(written.length).toBeGreaterThan(0);
        for (const d of written) {
            expect(d).toMatch(/ack_claimed_at|ack_sent_at/);
            expect(d).not.toMatch(/human_response_at|first_response_at|status/);
        }
    });

    it('only mark_responded writes a human response', () => {
        const route = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app/api/opportunities/[id]/route.ts'), 'utf8');
        // One write site, and it lives in the transaction the mark_responded
        // branch feeds. confirm_date must never imply a reply — FR-ACCEPTANCE-1C.
        expect((route.match(/human_response_at: new Date\(\)/g) || []).length).toBe(1);
        const confirm = route.slice(route.indexOf("case 'confirm_date'"), route.indexOf("case 'mark_lost'"));
        expect(confirm).not.toMatch(/human_response_at|respondedInquiryId =/);
    });
});
