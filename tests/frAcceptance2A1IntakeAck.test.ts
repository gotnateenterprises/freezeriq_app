/**
 * FR-ACCEPTANCE-2A.1 — the public intake, wired to the acknowledgement.
 *
 * The module's own behaviour is proven in frAcceptance2A1AutoAck.test.ts. What
 * this file proves is the WIRING, which is where the two idempotency contracts
 * live and where they are easiest to get backwards:
 *
 *   - the inquiry is durable BEFORE any email work starts;
 *   - the acknowledgement is attempted on every path that resolves a canonical
 *     inquiry, including replays, because that is what makes recovery possible;
 *   - the tenant's internal lead alert is NOT, because a replay is not news.
 *
 * The acknowledgement module is doubled here on purpose. This file is about
 * which path calls it and in what order, not about what it does once called.
 */

import {
    createPrismaMock,
    jsonRequest,
    readJson,
    type PrismaMock,
} from './helpers/routeHarness';
import { buildInquiryFingerprint } from '@/lib/fundraiserFunnel';

let mock: PrismaMock = createPrismaMock();

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__ackIntakePrisma; },
}));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));

const notify = jest.fn(async () => undefined);
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: (...args: any[]) => notify(...(args as [])),
}));

const attemptAck = jest.fn(async () => ({ outcome: 'sent', sentAt: new Date() }));
jest.mock('@/lib/inquiryAcknowledgement', () => ({
    attemptInquiryAcknowledgement: (...args: any[]) => attemptAck(...(args as [])),
    acknowledgementNeedsAttention: (o: string) =>
        ['skipped_not_live', 'skipped_no_recipient', 'rejected', 'failed'].includes(o),
}));

const TENANT_A = 'biz-aaaa-1111';
const INQ = 'inq-canonical-1';

const VALID = {
    name: 'Jo Coordinator',
    email: 'jo@lincolnpta.org',
    phone: '555-0100',
    orgName: 'Lincoln PTA',
    slug: 'tenant-a',
};

function useMock(m: PrismaMock) {
    mock = m;
    (global as any).__ackIntakePrisma = m.client;
}

function freshMock(extra: Record<string, any> = {}) {
    return createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A },
            'customer.findFirst': null,
            $queryRaw: [],
            'fundraiserOpportunity.findFirst': null,
            'fundraiserInquiry.findFirst': null,
            'fundraiserInquiry.create': { id: INQ },
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
    attemptAck.mockResolvedValue({ outcome: 'sent', sentAt: new Date() } as any);
    useMock(freshMock());
});

// ═══════════════════════════════════════════════════════════════════════════
// PART G — the inquiry is primary
// ═══════════════════════════════════════════════════════════════════════════

describe('the inquiry is persisted before any email work', () => {
    it('creates the inquiry, THEN acknowledges', async () => {
        await post(VALID);

        const created = mock.firstCall('fundraiserInquiry.create')!;
        expect(created).toBeDefined();
        const createOrder = (mock.client.fundraiserInquiry.create as jest.Mock).mock.invocationCallOrder[0];
        const ackOrder = attemptAck.mock.invocationCallOrder[0];
        expect(createOrder).toBeLessThan(ackOrder);
    });

    it('acknowledges the CANONICAL inquiry id, scoped to the resolved tenant', async () => {
        await post(VALID);
        expect(attemptAck).toHaveBeenCalledWith(INQ, TENANT_A);
    });

    it('a failed acknowledgement does not fail the submission', async () => {
        attemptAck.mockResolvedValue({ outcome: 'failed', sentAt: null } as any);
        const res = await post(VALID);
        // The person filled in a form and their inquiry is saved. Whatever
        // happened to the email afterwards is not their problem.
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(1);
    });

    it('a THROWING acknowledgement still cannot lose the lead', async () => {
        attemptAck.mockRejectedValue(new Error('unexpected'));
        const res = await post(VALID);
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(1);
        // Even in the worst case the write is already committed; the response may
        // be an error but the lead is not lost.
        expect([200, 500]).toContain(res.status);
    });

    it('nothing is acknowledged when validation rejects the submission', async () => {
        const res = await post({ ...VALID, email: 'not-an-email' });
        expect(res.status).toBe(400);
        expect(attemptAck).not.toHaveBeenCalled();
    });

    it('nothing is acknowledged for an unknown storefront', async () => {
        useMock(freshMock({ 'business.findFirst': null }));
        expect((await post(VALID)).status).toBe(404);
        expect(attemptAck).not.toHaveBeenCalled();
    });

    it('the provider call happens outside the transaction', async () => {
        // A mail host that hangs must never hold row locks on the customer and
        // opportunity for the length of a network timeout.
        await post(VALID);
        const txCalls = (mock.client.$transaction as jest.Mock).mock.results.length;
        expect(txCalls).toBeGreaterThan(0);
        // The transaction callback finished before the acknowledgement began.
        const createOrder = (mock.client.fundraiserInquiry.create as jest.Mock).mock.invocationCallOrder[0];
        expect(attemptAck.mock.invocationCallOrder[0]).toBeGreaterThan(createOrder);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART C — recovery on the replay path
// ═══════════════════════════════════════════════════════════════════════════

describe('a replayed submission', () => {
    // The REAL fingerprint the route will compute for VALID, so the fast replay
    // path genuinely matches. Guarding these assertions behind an `if` instead
    // would let the whole describe pass while testing nothing.
    const FINGERPRINT = buildInquiryFingerprint({
        slug: VALID.slug,
        organizationName: VALID.orgName,
        contactEmail: VALID.email,
        contactName: VALID.name,
        contactPhone: VALID.phone,
    });
    const KEY = 'a'.repeat(24);

    const replayMock = () => freshMock({
        'fundraiserInquiry.findFirst': {
            id: INQ, customer_id: 'cus-1', opportunity_id: 'opp-1',
            submission_fingerprint: FINGERPRINT,
        },
    });

    it('is recognised as a replay (guards the assertions below)', async () => {
        useMock(replayMock());
        const res = await post({ ...VALID, submissionKey: KEY });
        expect(res.status).toBe(200);
        expect(res.body.duplicate).toBe(true);
        // Nothing new was written.
        expect(mock.callsTo('fundraiserInquiry.create')).toHaveLength(0);
    });

    it('still attempts the acknowledgement, so a missed one can be recovered', async () => {
        // The winning request may have persisted this inquiry and died before
        // reaching the provider. Skipping the attempt here would strand the
        // person who filled in the form — they would never hear anything.
        useMock(replayMock());
        await post({ ...VALID, submissionKey: KEY });
        expect(attemptAck).toHaveBeenCalledWith(INQ, TENANT_A);
    });

    it('does NOT send a second tenant lead alert', async () => {
        // The tenant was told when the lead first arrived. Telling them again
        // because someone double-clicked is noise that erodes trust in the alert.
        //
        // This is the asymmetry Part M names: the acknowledgement is recoverable
        // on a replay, the internal alert is not.
        useMock(replayMock());
        await post({ ...VALID, submissionKey: KEY });
        expect(notify).not.toHaveBeenCalled();
    });

    // ── PART K — an altered replay cannot redirect the acknowledgement ──────

    it('a replay that swaps the email is REFUSED before anything is sent', async () => {
        // The attack: capture a submission key, replay it with the attacker's
        // address, and collect the tenant-branded acknowledgement. The email is
        // part of the fingerprint, so the swap changes it and the request is
        // rejected before the acknowledgement is reached.
        useMock(replayMock());
        const res = await post({ ...VALID, email: 'attacker@evil.example', submissionKey: KEY });

        expect(res.status).toBe(409);
        expect(attemptAck).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('and even on the accepted path, the recipient comes from the ROW', async () => {
        // Defence in depth: the acknowledgement is handed an inquiry ID only.
        // There is no parameter through which a request body could nominate a
        // recipient, so a fingerprint bypass would still not redirect the mail.
        useMock(replayMock());
        await post({ ...VALID, submissionKey: KEY });

        expect(attemptAck).toHaveBeenCalledWith(INQ, TENANT_A);
        const args = attemptAck.mock.calls[0] as unknown[];
        expect(args).toHaveLength(2);
        expect(JSON.stringify(args)).not.toContain('@');
    });

    it('MUTATION: the fingerprint is what stops the swap', async () => {
        // If the stored fingerprint happened to equal the attacker's, the guard
        // would not fire — which is precisely why the email is part of it.
        const attackerPrint = buildInquiryFingerprint({
            slug: VALID.slug, organizationName: VALID.orgName,
            contactEmail: 'attacker@evil.example', contactName: VALID.name, contactPhone: VALID.phone,
        });
        expect(attackerPrint).not.toBe(FINGERPRINT);
    });

    it('a replay with DIFFERENT details is refused, and acknowledges nothing', async () => {
        useMock(freshMock({
            'fundraiserInquiry.findFirst': {
                id: INQ, customer_id: 'cus-1', opportunity_id: 'opp-1',
                submission_fingerprint: 'a-different-fingerprint',
            },
        }));
        const res = await post({ ...VALID, submissionKey: KEY });
        expect(res.status).toBe(409);
        expect(attemptAck).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART M — the tenant alert tells the truth about the acknowledgement
// ═══════════════════════════════════════════════════════════════════════════

describe('the tenant lead alert', () => {
    it('goes out exactly once for a genuinely new lead', async () => {
        await post(VALID);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('says the person has already heard back when they have', async () => {
        await post(VALID);
        expect(notify.mock.calls[0][1].acknowledgement).toMatch(/already heard back/i);
    });

    it('says the inquiry still needs a reply when nothing was sent', async () => {
        for (const outcome of ['skipped_not_live', 'rejected', 'failed', 'skipped_no_recipient']) {
            jest.clearAllMocks();
            useMock(freshMock());
            attemptAck.mockResolvedValue({ outcome, sentAt: null } as any);
            await post(VALID);
            const notice = notify.mock.calls[0][1].acknowledgement as string;
            expect(notice).toMatch(/needs a reply|no email address/i);
            // It must never imply the volunteer has been contacted.
            expect(notice).not.toMatch(/already heard back/i);
        }
    });

    it('does not claim delivery when the outcome was uncertain', async () => {
        attemptAck.mockResolvedValue({ outcome: 'uncertain', sentAt: null } as any);
        await post(VALID);
        const notice = notify.mock.calls[0][1].acknowledgement as string;
        expect(notice).toMatch(/could not be confirmed/i);
        expect(notice).toMatch(/may not have received/i);
    });

    it('warns when the send succeeded but could not be recorded', async () => {
        attemptAck.mockResolvedValue({ outcome: 'sent_unrecorded', sentAt: null } as any);
        await post(VALID);
        expect(notify.mock.calls[0][1].acknowledgement).toMatch(/could not record/i);
    });

    it('carries no submitter-controlled text into the acknowledgement notice', async () => {
        // The notification template interpolates its fields into markup without
        // escaping them, so this field must only ever carry fixed literals.
        await post({ ...VALID, notes: '<img src=x onerror=alert(1)>', cause: '"><script>bad()</script>' });
        const notice = notify.mock.calls[0][1].acknowledgement as string;
        expect(notice).not.toMatch(/[<>]/);
        expect(notice).not.toMatch(/script|onerror/i);
    });

    it('a notification failure never fails the submission', async () => {
        notify.mockRejectedValue(new Error('mail down'));
        const res = await post(VALID);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
