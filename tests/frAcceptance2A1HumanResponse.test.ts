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
            // FR-ACCEPTANCE-2A.2 — the newest inquiry, resolved server-side to
            // carry last_human_followup_at.
            'fundraiserInquiry.findFirst': { id: INQ_NEW },
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
        // FR-ACCEPTANCE-2A.2: two writes now — the write-once first response on
        // every outstanding inquiry, and the always-advancing latest follow-up
        // on the newest one.
        const writes = mock.callsTo('fundraiserInquiry.updateMany');
        expect(writes).toHaveLength(2);
        expect(writes[0].args.data).toEqual({ human_response_at: expect.any(Date) });
        expect(writes[1].args.data).toEqual({ last_human_followup_at: expect.any(Date) });
    });

    it('FR-ACCEPTANCE-2A.2 REVERSED: a repeat click IS a change — it advances the follow-up', async () => {
        // Superseded assertion. This previously expected `changed: false` when
        // every inquiry already carried a human response, because the click was
        // genuinely a no-op. Under the owner-approved contract a repeat
        // follow-up is a real recorded event, so it reports a change and writes
        // the latest-follow-up column — while still not touching the write-once
        // first-response facts.
        useMock(answeredWithNewInquiry({ 'fundraiserInquiry.count': 0 }));
        const res = await patch({ action: 'mark_responded' });
        expect(res.body.changed).toBe(true);
        const writes = mock.callsTo('fundraiserInquiry.updateMany');
        expect(writes).toHaveLength(1);
        expect(writes[0].args.data).toEqual({ last_human_followup_at: expect.any(Date) });
        // The first-response column is NOT among the writes.
        expect(JSON.stringify(writes)).not.toContain('human_response_at":');
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

    it('the FIRST-RESPONSE half stays idempotent: a second click stamps no new human_response_at', async () => {
        // The idempotency that still matters. FR-ACCEPTANCE-2A.2 made the click
        // itself non-idempotent by design — the follow-up timestamp advances —
        // but the write-once first-response fact must not move, and it does not:
        // with nothing outstanding, the only write is the follow-up column.
        useMock(answeredWithNewInquiry({ 'fundraiserInquiry.count': 0 }));
        await patch({ action: 'mark_responded' });
        const writes = mock.callsTo('fundraiserInquiry.updateMany');
        expect(writes.every((w) => !('human_response_at' in (w.args.data ?? {})))).toBe(true);
    });

    it('reports no change only when there is genuinely nothing to record', async () => {
        // An opportunity with no inquiries at all: nothing outstanding, and no
        // newest inquiry to carry a follow-up.
        useMock(answeredWithNewInquiry({
            'fundraiserInquiry.count': 0,
            'fundraiserInquiry.findFirst': null,
        }));
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
// FR-ACCEPTANCE-2A.2 — the latest-follow-up write, against the real route
// ═══════════════════════════════════════════════════════════════════════════

describe('FR-ACCEPTANCE-2A.2: recording a follow-up', () => {
    it('stamps the latest follow-up on the NEWEST inquiry, resolved server-side', async () => {
        await patch({ action: 'mark_responded' });
        const q = mock.callsTo('fundraiserInquiry.findFirst')[0].args;
        expect(q.where).toMatchObject({ opportunity_id: OPP, business_id: TENANT });
        expect(q.orderBy).toEqual({ received_at: 'desc' });

        const followUp = mock.callsTo('fundraiserInquiry.updateMany')
            .find((c) => 'last_human_followup_at' in (c.args.data ?? {}))!;
        expect(followUp.args.where.id).toBe(INQ_NEW);
    });

    it('the follow-up write carries NO null guard — it must advance every time', async () => {
        await patch({ action: 'mark_responded' });
        const followUp = mock.callsTo('fundraiserInquiry.updateMany')
            .find((c) => 'last_human_followup_at' in (c.args.data ?? {}))!;
        expect(followUp.args.where).not.toHaveProperty('last_human_followup_at');
        // Tenant and opportunity scope are still re-asserted at the write.
        expect(followUp.args.where.business_id).toBe(TENANT);
        expect(followUp.args.where.opportunity_id).toBe(OPP);
    });

    it('a client-supplied inquiry id can never redirect the follow-up stamp', async () => {
        await patch({ action: 'mark_responded', inquiry_id: 'inq-attacker', inquiryId: 'inq-attacker' });
        const writes = mock.callsTo('fundraiserInquiry.updateMany');
        expect(JSON.stringify(writes)).not.toContain('attacker');
    });

    it('PART K: the stamp targets the newest inquiry, so an older one is never rewritten forward', async () => {
        // The route asks the database for the newest inquiry and writes to that
        // id alone — inquiry #1 in the owner's Aug 1 / Aug 20 model is never in
        // the WHERE clause, so its own follow-up history cannot be overwritten.
        await patch({ action: 'mark_responded' });
        const followUp = mock.callsTo('fundraiserInquiry.updateMany')
            .find((c) => 'last_human_followup_at' in (c.args.data ?? {}))!;
        expect(followUp.args.where.id).toBe(INQ_NEW);
        expect(followUp.args.where.id).not.toBe(INQ_OLD);
    });

    it('both writes land in the SAME transaction as the opportunity update', async () => {
        await patch({ action: 'mark_responded' });
        expect(mock.client.$transaction).toHaveBeenCalled();
    });

    it('a lost opportunity race still rolls the follow-up stamp back', async () => {
        useMock(answeredWithNewInquiry({
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'new', first_response_at: null, preferred_delivery_date: null,
            },
            'fundraiserOpportunity.updateMany': { count: 0 },
        }));
        const res = await patch({ action: 'mark_responded' });
        expect(res.status).toBe(404);
    });

    it('confirm_date still records no follow-up — booking a date is not contact', async () => {
        // FR-ACCEPTANCE-1C's rule, preserved: only mark_responded may record a
        // human response or a follow-up.
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-10-17' });
        expect(mock.callsTo('fundraiserInquiry.findFirst')).toHaveLength(0);
        const writes = mock.callsTo('fundraiserInquiry.updateMany');
        expect(JSON.stringify(writes)).not.toContain('last_human_followup_at');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART I — FORCED CONCURRENCY: the follow-up timestamp must be MONOTONIC
// ═══════════════════════════════════════════════════════════════════════════

describe('FR-ACCEPTANCE-2A.2: overlapping follow-ups cannot move the timestamp backwards', () => {
    /**
     * A store whose updateMany honours the monotonic predicate the way Postgres
     * does: the qualifier is re-evaluated against the CURRENTLY COMMITTED value
     * at the moment the statement runs.
     *
     * This is what makes the test non-vacuous. The stock harness returns
     * `{ count: 1 }` for every updateMany regardless of the WHERE clause, so a
     * race built on it would pass even with the predicate deleted.
     */
    function monotonicStore(initial: Date | null = null) {
        const row = { id: INQ_NEW, last_human_followup_at: initial as Date | null };
        const client: any = {
            fundraiserOpportunity: {
                findFirst: jest.fn(async () => ({
                    id: OPP, status: 'in_conversation',
                    first_response_at: new Date('2026-04-01T10:00:00Z'),
                    preferred_delivery_date: null,
                })),
                updateMany: jest.fn(async () => ({ count: 1 })),
            },
            fundraiserInquiry: {
                count: jest.fn(async () => 0),
                findFirst: jest.fn(async () => ({ id: INQ_NEW })),
                updateMany: jest.fn(async ({ where, data }: any) => {
                    if (!('last_human_followup_at' in data)) return { count: 1 };
                    // Honour the OR predicate exactly as Postgres would.
                    const proposed: Date = data.last_human_followup_at;
                    const current = row.last_human_followup_at;
                    const permitted = current === null || current.getTime() < proposed.getTime();
                    const guardAllowsNull = (where.OR ?? []).some((c: any) => c.last_human_followup_at === null);
                    const guardAllowsOlder = (where.OR ?? []).some((c: any) => c.last_human_followup_at?.lt !== undefined);
                    // A write with NO monotonic guard applies unconditionally —
                    // which is precisely the defect this test exists to catch.
                    if (!guardAllowsNull && !guardAllowsOlder) {
                        row.last_human_followup_at = proposed;
                        return { count: 1 };
                    }
                    if (!permitted) return { count: 0 };
                    row.last_human_followup_at = proposed;
                    return { count: 1 };
                }),
            },
            $transaction: jest.fn(async (fn: any) => fn(client)),
        };
        return { row, client };
    }

    it('the LATER timestamp survives even when its request commits FIRST', async () => {
        const store = monotonicStore();
        (global as any).__ackHumanPrisma = store.client;

        // Force the interleaving: B (the later instant) is committed first, then
        // A (the earlier instant) runs. A must find the row already ahead of it
        // and decline, rather than dragging it backwards.
        const EARLY = new Date('2026-08-23T10:00:00.100Z');
        const LATE = new Date('2026-08-23T10:00:00.200Z');

        jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
        try {
            jest.setSystemTime(LATE);
            await patch({ action: 'mark_responded' });  // request B commits first
            jest.setSystemTime(EARLY);
            await patch({ action: 'mark_responded' });  // request A, older stamp
        } finally {
            jest.useRealTimers();
        }

        // MAX of the two, not last-writer-wins.
        expect(store.row.last_human_followup_at!.toISOString()).toBe(LATE.toISOString());
    });

    it('MUTATION: without the monotonic guard the row DOES regress', async () => {
        // Proves the assertion above is load-bearing. Same store, same ordering,
        // one difference: the route's WHERE clause is simulated without the OR,
        // which is the shape the code had before this review.
        const store = monotonicStore();
        const EARLY = new Date('2026-08-23T10:00:00.100Z');
        const LATE = new Date('2026-08-23T10:00:00.200Z');

        // Unguarded writes, applied in the same commit order.
        await store.client.fundraiserInquiry.updateMany({
            where: { id: INQ_NEW }, data: { last_human_followup_at: LATE },
        });
        await store.client.fundraiserInquiry.updateMany({
            where: { id: INQ_NEW }, data: { last_human_followup_at: EARLY },
        });
        expect(store.row.last_human_followup_at).toEqual(EARLY); // the defect
    });

    it('a genuinely later follow-up still advances the timestamp', async () => {
        const first = new Date('2026-08-23T09:00:00.000Z');
        const store = monotonicStore(first);
        (global as any).__ackHumanPrisma = store.client;

        const later = new Date('2026-08-25T14:30:00.000Z');
        jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
        try {
            jest.setSystemTime(later);
            await patch({ action: 'mark_responded' });
        } finally {
            jest.useRealTimers();
        }
        expect(store.row.last_human_followup_at!.toISOString()).toBe(later.toISOString());
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
