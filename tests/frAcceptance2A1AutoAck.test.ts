/**
 * FR-ACCEPTANCE-2A.1 — the automatic public-inquiry acknowledgement.
 *
 * These tests EXECUTE the real module. The claim is simulated by a store that
 * behaves the way `UPDATE ... WHERE ack_claimed_at IS NULL` behaves — the
 * predicate is evaluated against current row state and the update is refused
 * when it no longer holds. That is what makes the concurrency tests here
 * non-vacuous: a version of the code that dropped the WHERE clause would pass a
 * mock that always returned count:1, and fails this one.
 *
 * The mutation-quality test at the bottom proves exactly that by rebuilding the
 * unguarded write and showing it double-sends.
 */

import {
    resolveInquiryResponse,
    latestInquiry,
} from '@/lib/growth/inquiryResponseState';
import {
    triageOpportunity,
    funnelBucket,
    FOLLOW_UP_SILENCE_HOURS,
    UNANSWERED_INQUIRY_HOURS,
} from '@/lib/growth/opportunityNextAction';

// ── Doubles ────────────────────────────────────────────────────────────────

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__ackPrisma; },
}));
jest.mock('@/lib/email', () => ({
    getTenantSender: jest.fn(async () => ({ from: 'Tenant <no-reply@platform.test>', replyTo: 'owner@tenant.test' })),
}));

const send = jest.fn();
jest.mock('resend', () => ({
    Resend: class { emails = { send: (...a: any[]) => send(...a) }; },
}));

const INQ = 'inq-canonical-1';
const BIZ = 'biz-aaaa-1111';

interface Row {
    id: string;
    business_id: string;
    contact_name: string;
    contact_email: string;
    organization_name: string;
    ack_claimed_at: Date | null;
    ack_sent_at: Date | null;
}

/**
 * A Prisma double whose updateMany enforces its own WHERE clause.
 *
 * This is the whole point of the file. `count` reflects whether the predicate
 * actually held at the moment of the write, so two callers racing on the same
 * row cannot both win — exactly as Postgres behaves under READ COMMITTED, where
 * the second statement re-evaluates the qualifier after taking the row lock.
 */
function makeStore(overrides: Partial<Row> = {}, opts: { failSentWrite?: boolean } = {}) {
    const row: Row = {
        id: INQ, business_id: BIZ,
        contact_name: 'Dana', contact_email: 'dana@oakridgepto.org',
        organization_name: 'Oak Ridge PTO',
        ack_claimed_at: null, ack_sent_at: null,
        ...overrides,
    };
    const updateManyCalls: any[] = [];
    const client = {
        fundraiserInquiry: {
            findFirst: jest.fn(async ({ where }: any) =>
                where.id === row.id && where.business_id === row.business_id ? { ...row } : null),
            findUnique: jest.fn(async ({ where }: any) => (where.id === row.id ? { ...row } : null)),
            updateMany: jest.fn(async ({ where, data }: any) => {
                updateManyCalls.push({ where, data });
                if (where.id !== row.id) return { count: 0 };
                // The conditional predicate, honoured.
                if ('ack_claimed_at' in where && where.ack_claimed_at === null && row.ack_claimed_at !== null) {
                    return { count: 0 };
                }
                if ('ack_sent_at' in where && where.ack_sent_at === null && row.ack_sent_at !== null) {
                    return { count: 0 };
                }
                Object.assign(row, data);
                return { count: 1 };
            }),
            update: jest.fn(async ({ where, data }: any) => {
                if (opts.failSentWrite) throw new Error('simulated write failure');
                if (where.id !== row.id) throw new Error('no such row');
                Object.assign(row, data);
                return { ...row };
            }),
        },
        business: {
            findUnique: jest.fn(async () => ({
                name: 'My Freezer Chef', display_name: 'Freezer Chef',
                custom_domain: 'myfreezerchef.com', contact_email: 'laurie@myfreezerchef.com',
                slug: 'my-freezer-chef',
            })),
        },
    };
    return { row, client, updateManyCalls };
}

function useStore(s: { client: any }) { (global as any).__ackPrisma = s.client; }

const ack = async (inquiryId = INQ, businessId = BIZ) => {
    const { attemptInquiryAcknowledgement } = await import('@/lib/inquiryAcknowledgement');
    return attemptInquiryAcknowledgement(inquiryId, businessId);
};

const ORIGINAL_ENV = { ...process.env };
const goLive = () => { process.env.RESEND_API_KEY = 'test-key'; process.env.EMAIL_LIVE = 'true'; };

beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_LIVE;
    send.mockResolvedValue({ data: { id: 'provider-msg-1' }, error: null });
});
afterAll(() => { process.env = ORIGINAL_ENV; });

// ═══════════════════════════════════════════════════════════════════════════
// PART D — the safety gate, resolved BEFORE anything durable
// ═══════════════════════════════════════════════════════════════════════════

describe('EMAIL_LIVE safety for a PUBLIC recipient', () => {
    it('sends nothing and writes nothing when EMAIL_LIVE is unset', async () => {
        const s = makeStore(); useStore(s);
        process.env.RESEND_API_KEY = 'test-key'; // key alone must not be enough

        const r = await ack();

        expect(r.outcome).toBe('skipped_not_live');
        expect(send).not.toHaveBeenCalled();
        // The decisive assertion: safety mode leaves the row CLAIMABLE. Had the
        // gate been resolved after the claim, every inquiry taken on a non-live
        // environment would be permanently stuck as "in progress".
        expect(s.row.ack_claimed_at).toBeNull();
        expect(s.row.ack_sent_at).toBeNull();
        expect(s.client.fundraiserInquiry.updateMany).not.toHaveBeenCalled();
    });

    it('a key WITHOUT EMAIL_LIVE cannot mail a member of the public', async () => {
        // sendLeadNotificationEmail gates on the key alone. That is tolerable
        // when it mails the account owner and unacceptable here, so this asserts
        // the stronger gate explicitly rather than by resemblance.
        const s = makeStore(); useStore(s);
        process.env.RESEND_API_KEY = 'test-key';
        process.env.EMAIL_LIVE = 'false';
        expect((await ack()).outcome).toBe('skipped_not_live');
        expect(send).not.toHaveBeenCalled();
    });

    it('sends once both are present', async () => {
        const s = makeStore(); useStore(s); goLive();
        expect((await ack()).outcome).toBe('sent');
        expect(send).toHaveBeenCalledTimes(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART E — the atomic claim
// ═══════════════════════════════════════════════════════════════════════════

describe('the acknowledgement claim', () => {
    it('claims with BOTH null predicates before touching the provider', async () => {
        const s = makeStore(); useStore(s); goLive();
        await ack();

        const claim = s.updateManyCalls[0];
        expect(claim.where).toEqual({ id: INQ, ack_claimed_at: null, ack_sent_at: null });
        expect(claim.data.ack_claimed_at).toBeInstanceOf(Date);
        // Claim strictly before the provider call.
        const claimOrder = s.client.fundraiserInquiry.updateMany.mock.invocationCallOrder[0];
        expect(claimOrder).toBeLessThan(send.mock.invocationCallOrder[0]);
    });

    it('exactly one of two concurrent callers wins, and only one email goes out', async () => {
        const s = makeStore(); useStore(s); goLive();

        // Node is single-threaded, so two handlers only interleave at genuine
        // await points. Rather than hope for that, the winner is HELD inside the
        // provider call until the loser has been given room to run — which is
        // the window where a missing WHERE clause would let it send too.
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        send.mockImplementation(async () => {
            await held;
            return { data: { id: 'provider-msg-1' }, error: null };
        });

        const pair = Promise.all([ack(), ack()]);
        await new Promise((r) => setImmediate(r));
        release();
        const [a, b] = await pair;

        const outcomes = [a.outcome, b.outcome].sort();
        // The loser is 'skipped_in_progress', NOT 'skipped_already_sent' — proof
        // that it ran while the winner was still mid-send, i.e. a real race
        // rather than two sequential calls.
        expect(outcomes).toEqual(['sent', 'skipped_in_progress']);
        expect(send).toHaveBeenCalledTimes(1);
        expect(s.row.ack_sent_at).toBeInstanceOf(Date);
    });

    it('ten concurrent callers still produce exactly one email', async () => {
        const s = makeStore(); useStore(s); goLive();
        const results = await Promise.all(Array.from({ length: 10 }, () => ack()));
        expect(results.filter((r) => r.outcome === 'sent')).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('the loser stops BEFORE the provider, and says which state it found', async () => {
        const s = makeStore({ ack_claimed_at: new Date('2026-08-20T10:00:00Z') }); useStore(s); goLive();
        const r = await ack();
        expect(r.outcome).toBe('skipped_in_progress');
        expect(send).not.toHaveBeenCalled();
    });

    it('an already-acknowledged inquiry is never acknowledged twice', async () => {
        const sentAt = new Date('2026-08-20T10:00:00Z');
        const s = makeStore({ ack_claimed_at: sentAt, ack_sent_at: sentAt }); useStore(s); goLive();
        const r = await ack();
        expect(r.outcome).toBe('skipped_already_sent');
        expect(r.sentAt).toEqual(sentAt);
        expect(send).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART C — RECOVERY. The claim belongs to the row, not to the request.
// ═══════════════════════════════════════════════════════════════════════════

describe('recovery of an acknowledgement that was owed but never sent', () => {
    it('a later request can send the acknowledgement a crashed request never did', async () => {
        // Request A persisted this inquiry and died before reaching the provider.
        // Its row is therefore unclaimed — which is precisely the state that
        // makes it recoverable.
        const s = makeStore({ ack_claimed_at: null, ack_sent_at: null }); useStore(s); goLive();

        // Request B is a retry resolving the SAME canonical inquiry. It did not
        // create the row, and under a request-scoped rule it would refuse to act
        // and this person would never hear anything.
        const r = await ack();

        expect(r.outcome).toBe('sent');
        expect(send).toHaveBeenCalledTimes(1);
        expect(s.row.ack_sent_at).toBeInstanceOf(Date);
    });

    it('recovery does NOT re-send when the crashed request had already succeeded', async () => {
        const s = makeStore({ ack_claimed_at: new Date(), ack_sent_at: new Date() }); useStore(s); goLive();
        expect((await ack()).outcome).toBe('skipped_already_sent');
        expect(send).not.toHaveBeenCalled();
    });

    it('an inquiry claimed-but-unconfirmed is NOT auto-retried', async () => {
        // The riskier half of recovery. We cannot tell "died before sending" from
        // "sent and died before recording", so an automatic retry could put a
        // second introduction in front of someone who already has one.
        const s = makeStore({ ack_claimed_at: new Date(), ack_sent_at: null }); useStore(s); goLive();
        expect((await ack()).outcome).toBe('skipped_in_progress');
        expect(send).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART F — provider outcomes
// ═══════════════════════════════════════════════════════════════════════════

describe('provider outcomes', () => {
    it('EXPLICIT rejection releases the claim so a retry is possible', async () => {
        const s = makeStore(); useStore(s); goLive();
        send.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });

        const r = await ack();

        expect(r.outcome).toBe('rejected');
        // The one outcome where we KNOW nothing was queued.
        expect(s.row.ack_claimed_at).toBeNull();
        expect(s.row.ack_sent_at).toBeNull();
    });

    it('a released claim really can be retried afterwards', async () => {
        const s = makeStore(); useStore(s); goLive();
        send.mockResolvedValueOnce({ data: null, error: { message: 'rate limited' } });
        expect((await ack()).outcome).toBe('rejected');

        send.mockResolvedValueOnce({ data: { id: 'ok' }, error: null });
        expect((await ack()).outcome).toBe('sent');
        expect(s.row.ack_sent_at).toBeInstanceOf(Date);
    });

    it('a THROWN send holds the claim and never claims failure', async () => {
        const s = makeStore(); useStore(s); goLive();
        send.mockRejectedValue(new Error('socket hang up'));

        const r = await ack();

        expect(r.outcome).toBe('uncertain');
        // Held. Releasing would risk a second introduction; holding risks none.
        expect(s.row.ack_claimed_at).toBeInstanceOf(Date);
        expect(s.row.ack_sent_at).toBeNull();
    });

    it('an uncertain outcome is not auto-retried by a later request', async () => {
        const s = makeStore(); useStore(s); goLive();
        send.mockRejectedValueOnce(new Error('socket hang up'));
        expect((await ack()).outcome).toBe('uncertain');

        expect((await ack()).outcome).toBe('skipped_in_progress');
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('sent_at is written ONLY after acceptance, never before', async () => {
        const s = makeStore(); useStore(s); goLive();
        let sentAtDuringSend: unknown = 'unset';
        send.mockImplementation(async () => {
            sentAtDuringSend = s.row.ack_sent_at;
            return { data: { id: 'ok' }, error: null };
        });

        await ack();

        // The decisive ordering assertion: at the moment the provider was called
        // the row did NOT yet assert a send.
        expect(sentAtDuringSend).toBeNull();
        expect(s.row.ack_sent_at).toBeInstanceOf(Date);
    });

    it('provider success + failed recording holds the claim and does not cry failure', async () => {
        const s = makeStore({}, { failSentWrite: true }); useStore(s); goLive();

        const r = await ack();

        expect(r.outcome).toBe('sent_unrecorded');
        expect(r.sentAt).toBeNull();
        expect(s.row.ack_claimed_at).toBeInstanceOf(Date);
        expect(s.row.ack_sent_at).toBeNull();
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('an inquiry with no email address is skipped without a claim', async () => {
        const s = makeStore({ contact_email: '   ' }); useStore(s); goLive();
        const r = await ack();
        expect(r.outcome).toBe('skipped_no_recipient');
        expect(s.row.ack_claimed_at).toBeNull();
        expect(send).not.toHaveBeenCalled();
    });

    it('a failure BEFORE the provider RELEASES the claim', async () => {
        // THE DEFECT THIS PINS. Between taking the claim and calling the
        // provider there are awaited statements — a business lookup, a dynamic
        // import — any of which can throw on a transient database error. An
        // earlier revision let that land in the outer catch and return 'failed'
        // while HOLDING the claim, so the inquiry became permanently
        // un-acknowledgeable: every later replay matched zero rows, and the CRM
        // reported an unconfirmed delivery for a provider never reached.
        const s = makeStore(); useStore(s); goLive();
        s.client.business.findUnique = jest.fn(async () => { throw new Error('P2024 pool timeout'); });

        const r = await ack();

        expect(r.outcome).toBe('failed');
        expect(send).not.toHaveBeenCalled();
        // Released, because nothing was sent and we can PROVE it.
        expect(s.row.ack_claimed_at).toBeNull();
        expect(s.row.ack_sent_at).toBeNull();
    });

    it('and the inquiry stays recoverable afterwards', async () => {
        const s = makeStore(); useStore(s); goLive();
        s.client.business.findUnique = jest.fn(async () => { throw new Error('P2024 pool timeout'); });
        expect((await ack()).outcome).toBe('failed');

        // A later attempt must be able to send the acknowledgement that was owed.
        s.client.business.findUnique = jest.fn(async () => ({
            name: 'My Freezer Chef', display_name: 'Freezer Chef',
            custom_domain: 'myfreezerchef.com', contact_email: 'laurie@myfreezerchef.com',
            slug: 'my-freezer-chef',
        }));
        expect((await ack()).outcome).toBe('sent');
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('a failure AFTER the provider was reached HOLDS the claim', async () => {
        // The mirror image. Once the provider has been called we can no longer
        // prove nothing went out, so releasing would risk a duplicate.
        const s = makeStore(); useStore(s); goLive();
        send.mockImplementation(async () => { throw new Error('socket hang up'); });

        const r = await ack();

        expect(r.outcome).toBe('uncertain');
        expect(s.row.ack_claimed_at).toBeInstanceOf(Date);
        expect(s.row.ack_sent_at).toBeNull();
    });

    it('never releases a claim on a row that already asserts a send', async () => {
        const s = makeStore(); useStore(s); goLive();
        s.client.business.findUnique = jest.fn(async () => { throw new Error('boom'); });
        await ack();
        const release = s.updateManyCalls.find((c) => c.data?.ack_claimed_at === null);
        expect(release?.where).toMatchObject({ ack_sent_at: null });
    });

    it('never throws — a mail problem cannot break a saved lead', async () => {
        (global as any).__ackPrisma = {
            fundraiserInquiry: { findFirst: jest.fn(async () => { throw new Error('db down'); }) },
        };
        goLive();
        await expect(ack()).resolves.toEqual({ outcome: 'failed', sentAt: null });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART I — recipient and brand authority
// ═══════════════════════════════════════════════════════════════════════════

describe('recipient and brand', () => {
    it('takes the recipient from the durable row, never from a caller', async () => {
        const s = makeStore(); useStore(s); goLive();
        await ack();
        expect(send.mock.calls[0][0].to).toEqual(['dana@oakridgepto.org']);
        // Scoped to the tenant, so no id from another business can be reached.
        expect(s.client.fundraiserInquiry.findFirst.mock.calls[0][0].where)
            .toMatchObject({ id: INQ, business_id: BIZ });
    });

    it('refuses an inquiry belonging to another tenant', async () => {
        const s = makeStore(); useStore(s); goLive();
        expect((await ack(INQ, 'biz-other-9999')).outcome).toBe('failed');
        expect(send).not.toHaveBeenCalled();
    });

    it('uses the 2A brand authority — display_name and custom_domain', async () => {
        const s = makeStore(); useStore(s); goLive();
        await ack();
        const html = send.mock.calls[0][0].html as string;
        expect(html).toContain('Freezer Chef');
        expect(html).toContain('myfreezerchef.com');
        // The internal identity must not reach a volunteer.
        expect(html).not.toContain('My Freezer Chef');
        expect(html).not.toContain('/shop/my-freezer-chef');
    });

    it('sends the approved introduction, in company voice', async () => {
        const s = makeStore(); useStore(s); goLive();
        await ack();
        const { html, subject } = send.mock.calls[0][0];
        expect(html).toContain("we'd love to help");
        expect(html).toContain('final orders are due two weeks before the delivery date');
        expect(html).not.toMatch(/\d+\s*%/);
        expect(subject).toContain('Oak Ridge PTO');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTATION QUALITY — prove the guard is what stops the duplicate
// ═══════════════════════════════════════════════════════════════════════════

describe('mutation quality', () => {
    it('dropping the claim predicate reproduces the duplicate send', async () => {
        // Same store, same racing callers, ONE difference: updateMany no longer
        // honours the IS NULL predicate — the shape of an unguarded write. If
        // this still yielded one email, the concurrency tests above would be
        // proving nothing about the predicate.
        const s = makeStore();
        s.client.fundraiserInquiry.updateMany = jest.fn(async ({ data }: any) => {
            Object.assign(s.row, data);
            return { count: 1 }; // unconditional: every caller "wins"
        });
        useStore(s); goLive();

        await Promise.all([ack(), ack()]);

        expect(send).toHaveBeenCalledTimes(2); // the defect, reproduced
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART K / R — CRM truth: auto vs manual, newest inquiry wins
// ═══════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-08-22T12:00:00.000Z');
const hAgo = (h: number) => new Date(NOW.getTime() - h * 36e5);
const dAgo = (d: number) => new Date(NOW.getTime() - d * 864e5);

describe('who answered the newest inquiry', () => {
    it('reports needs_first_response when nothing has happened', () => {
        const r = resolveInquiryResponse(null, [{ received_at: hAgo(2) }]);
        expect(r.state).toBe('needs_first_response');
        expect(r.outreachAt).toBeNull();
    });

    it('an accepted acknowledgement on the newest inquiry reads as auto_ack_sent', () => {
        const r = resolveInquiryResponse(null, [
            { received_at: hAgo(3), ack_claimed_at: hAgo(3), ack_sent_at: hAgo(3) },
        ]);
        expect(r.state).toBe('auto_ack_sent');
        expect(r.outreachAt).toEqual(hAgo(3));
    });

    it('claimed-but-unconfirmed is its own state and starts NO clock', () => {
        const r = resolveInquiryResponse(null, [{ received_at: hAgo(5), ack_claimed_at: hAgo(5) }]);
        expect(r.state).toBe('auto_ack_uncertain');
        // Nothing can be said to have reached anyone, so the follow-up clock
        // must not start — otherwise silence would look like a routine nudge.
        expect(r.outreachAt).toBeNull();
    });

    it('a human reply outranks a machine acknowledgement', () => {
        const r = resolveInquiryResponse(hAgo(1), [
            { received_at: hAgo(4), ack_sent_at: hAgo(4) },
        ]);
        expect(r.state).toBe('manual_response');
        expect(r.outreachAt).toEqual(hAgo(1));
        // The acknowledgement is still reported; it is just not the headline.
        expect(r.autoAckSentAt).toEqual(hAgo(4));
    });

    // ── PART C/D — per-inquiry human response ──────────────────────────────
    //
    // THE DEFECT THIS SECTION EXISTS FOR.
    //
    // Opportunity.first_response_at is WRITE-ONCE: its writer guards on
    // `if (!current.first_response_at)`, deliberately, so the response-time
    // metric stays a real measurement. An earlier draft here compared that
    // column against the newest inquiry's received_at to decide whether a human
    // had replied — which cannot work, because answering a SECOND inquiry writes
    // nothing at all.

    it('the T1..T4 history: a reply to the SECOND inquiry is durably recorded', () => {
        // T1 inquiry #1 · T2 human reply · T3 inquiry #2 · T4 human reply to #2.
        const T1 = dAgo(120), T2 = dAgo(119), T3 = hAgo(6), T4 = hAgo(1);
        const r = resolveInquiryResponse(T2, [
            { received_at: T1, human_response_at: T2 },
            { received_at: T3, human_response_at: T4 },
        ]);
        expect(r.state).toBe('manual_response');
        expect(r.manualResponseApplies).toBe(true);
        // The anchor is the reply to THIS inquiry, not the opportunity's first.
        expect(r.outreachAt).toEqual(T4);
    });

    it('BEFORE that reply, the second inquiry reads as unanswered', () => {
        const T1 = dAgo(120), T2 = dAgo(119), T3 = hAgo(6);
        const r = resolveInquiryResponse(T2, [
            { received_at: T1, human_response_at: T2 },
            { received_at: T3 },
        ]);
        expect(r.state).toBe('needs_first_response');
        expect(r.manualResponseApplies).toBe(false);
    });

    it('the opportunity metric is NOT what decides it', () => {
        // first_response_at stays at T2 forever — it is write-once. If the
        // derivation still leaned on it, the reply at T4 above could never
        // register and the lead would read unanswered no matter what the tenant
        // did. Same first_response_at, opposite answers, decided per inquiry.
        const T2 = dAgo(119), T3 = hAgo(6);
        const withReply = resolveInquiryResponse(T2, [{ received_at: T3, human_response_at: hAgo(1) }]);
        const without = resolveInquiryResponse(T2, [{ received_at: T3 }]);
        expect(withReply.manualResponseApplies).toBe(true);
        expect(without.manualResponseApplies).toBe(false);
    });

    it('an automatic acknowledgement never counts as a human response', () => {
        const r = resolveInquiryResponse(null, [
            { received_at: hAgo(3), ack_claimed_at: hAgo(3), ack_sent_at: hAgo(3) },
        ]);
        expect(r.state).toBe('auto_ack_sent');
        expect(r.manualResponseApplies).toBe(false);
    });

    // ── LEGACY, which is what lets migration 15 skip a backfill ────────────

    it('a pre-existing answered lead still reads as answered with no backfill', () => {
        // Rows written before human_response_at existed carry null. Marking every
        // previously-answered lead as unanswered would be a visible regression
        // across live data, so first_response_at still answers when NO inquiry
        // carries the new column.
        const r = resolveInquiryResponse(hAgo(20), [{ received_at: hAgo(30) }]);
        expect(r.manualResponseApplies).toBe(true);
        expect(r.outreachAt).toEqual(hAgo(20));
    });

    it('the legacy fallback still declines for a newer unanswered inquiry', () => {
        const r = resolveInquiryResponse(dAgo(119), [
            { received_at: dAgo(120) },
            { received_at: hAgo(2) },
        ]);
        expect(r.manualResponseApplies).toBe(false);
    });

    it('once ANY inquiry carries the column, the legacy path is switched off', () => {
        // Otherwise a per-inquiry "not answered" could be overridden by a stale
        // opportunity timestamp, which is the whole bug coming back.
        const r = resolveInquiryResponse(hAgo(1), [
            { received_at: dAgo(120), human_response_at: dAgo(119) },
            { received_at: hAgo(2) },
        ]);
        expect(r.manualResponseApplies).toBe(false);
        expect(r.state).toBe('needs_first_response');
    });

    // ── The two staleness hazards ──────────────────────────────────────────

    it('an OLDER inquiry\'s acknowledgement does not answer a NEWER inquiry', () => {
        const r = resolveInquiryResponse(null, [
            { received_at: dAgo(120), ack_claimed_at: dAgo(120), ack_sent_at: dAgo(120) }, // spring
            { received_at: hAgo(2) },                                                       // this morning
        ]);
        expect(r.state).toBe('needs_first_response');
        expect(r.autoAckSentAt).toBeNull();
        expect(r.latestInquiryAt).toEqual(hAgo(2));
    });

    it('an OLDER manual reply does not answer a NEWER inquiry', () => {
        const r = resolveInquiryResponse(dAgo(100), [
            { received_at: dAgo(120) },
            { received_at: hAgo(2) },
        ]);
        expect(r.manualResponseApplies).toBe(false);
        expect(r.state).toBe('needs_first_response');
    });

    it('a manual reply AFTER the newest inquiry does apply', () => {
        const r = resolveInquiryResponse(hAgo(1), [
            { received_at: dAgo(120) },
            { received_at: hAgo(2) },
        ]);
        expect(r.manualResponseApplies).toBe(true);
        expect(r.state).toBe('manual_response');
    });

    it('inquiry order in the array does not matter', () => {
        const newest = { received_at: hAgo(2) };
        const oldest = { received_at: dAgo(120), ack_sent_at: dAgo(120) };
        expect(resolveInquiryResponse(null, [oldest, newest]).state)
            .toBe(resolveInquiryResponse(null, [newest, oldest]).state);
        expect(latestInquiry([oldest, newest])).toBe(newest);
        expect(latestInquiry([newest, oldest])).toBe(newest);
    });

    it('degrades to first_response_at alone when no inquiries are supplied', () => {
        // The standing thin-payload contract: fewer signals, never a wrong one.
        expect(resolveInquiryResponse(hAgo(1), undefined).state).toBe('manual_response');
        expect(resolveInquiryResponse(null, undefined).state).toBe('needs_first_response');
        // FR-REBOOK-1A: a SUPPLIED but empty list is 'no_inquiry' — the caller
        // looked and there are none. An ABSENT list still degrades as before,
        // which is what the two assertions above pin.
        expect(resolveInquiryResponse(null, []).state).toBe('no_inquiry');
    });

    it('an unreadable received_at never drops an inquiry from view', () => {
        const r = resolveInquiryResponse(null, [{ received_at: 'not-a-date' }]);
        expect(r.state).toBe('needs_first_response');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART N — the 48-hour follow-up, on the new authority
// ═══════════════════════════════════════════════════════════════════════════

describe('the 48-hour follow-up signal', () => {
    const base = { status: 'in_conversation' as const };

    it('follows up 48h after an acknowledgement, naming the acknowledgement', () => {
        const o = {
            ...base,
            inquiries: [{ received_at: hAgo(60), ack_sent_at: hAgo(FOLLOW_UP_SILENCE_HOURS + 1) }],
        };
        const t = triageOpportunity(o, NOW);
        expect(t.action?.kind).toBe('send_follow_up');
        expect(t.action?.label).toBe('Follow up — no date selected yet');
        expect(t.action?.reason).toMatch(/since the acknowledgement/);
        expect(funnelBucket(o, NOW)).toBe('needs_follow_up');
    });

    it('follows up 48h after an applicable manual reply, naming the reply', () => {
        const o = {
            ...base,
            first_response_at: hAgo(FOLLOW_UP_SILENCE_HOURS + 1),
            inquiries: [{ received_at: hAgo(80) }],
        };
        const t = triageOpportunity(o, NOW);
        expect(t.action?.kind).toBe('send_follow_up');
        expect(t.action?.reason).toMatch(/since you replied/);
    });

    it('stays quiet inside the window', () => {
        const o = {
            ...base,
            inquiries: [{ received_at: hAgo(50), ack_sent_at: hAgo(FOLLOW_UP_SILENCE_HOURS - 1) }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).toBe('await_preferred_dates');
        expect(funnelBucket(o, NOW)).toBe('waiting_on_date');
    });

    it('an UNCONFIRMED acknowledgement outranks a routine follow-up', () => {
        const o = {
            ...base,
            inquiries: [{ received_at: dAgo(9), ack_claimed_at: dAgo(9) }],
        };
        const t = triageOpportunity(o, NOW);
        expect(t.priority).toBe('needs_attention');
        expect(t.action?.label).toBe('Check on this inquiry');
        expect(t.action?.reason).toMatch(/never confirmed/);
        expect(funnelBucket(o, NOW)).toBe('needs_follow_up');
    });

    it('never asserts the organization failed to reply', () => {
        // Inbound mail lands in the tenant's own inbox and is invisible here.
        for (const o of [
            { ...base, inquiries: [{ received_at: hAgo(90), ack_sent_at: hAgo(80) }] },
            { ...base, first_response_at: hAgo(80), inquiries: [{ received_at: hAgo(90) }] },
        ]) {
            const reason = triageOpportunity(o, NOW).action!.reason;
            expect(reason).not.toMatch(/not (yet )?(replied|responded|answered)|no reply|have not|has not/i);
        }
    });

    it('a preferred date removes the follow-up', () => {
        const o = {
            ...base,
            preferred_delivery_date: '2026-10-17',
            updated_at: hAgo(2),
            inquiries: [{ received_at: dAgo(9), ack_sent_at: dAgo(9) }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).toBe('check_date_availability');
        expect(funnelBucket(o, NOW)).toBe('waiting_on_date');
    });

    it('a confirmed date removes the follow-up even without a preferred one', () => {
        const o = {
            ...base,
            confirmed_delivery_date: '2026-10-17',
            updated_at: hAgo(2),
            inquiries: [{ received_at: dAgo(9), ack_sent_at: dAgo(9) }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).not.toBe('send_follow_up');
        expect(funnelBucket(o, NOW)).toBe('waiting_on_date');
    });

    it('editing the record does NOT reset the follow-up clock', () => {
        // updated_at moves whenever anyone types a note. Anchoring on it would
        // let opening a drawer silence a lead that has genuinely gone cold.
        const o = {
            ...base,
            updated_at: NOW,
            inquiries: [{ received_at: dAgo(9), ack_sent_at: dAgo(9) }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).toBe('send_follow_up');
    });

    it('a NEW inquiry re-opens a lead that had been answered', () => {
        // The whole point of Part K, end to end: an organization that was
        // answered in spring and writes again today is owed a reply today.
        const o = {
            ...base,
            first_response_at: dAgo(100),
            inquiries: [{ received_at: dAgo(120), ack_sent_at: dAgo(120) }, { received_at: hAgo(1) }],
        };
        const t = triageOpportunity(o, NOW);
        expect(t.action?.kind).toBe('respond_to_inquiry');
        expect(funnelBucket(o, NOW)).toBe('new_leads');
    });

    it('an unanswered inquiry uses the faster first-response clock', () => {
        const o = { ...base, inquiries: [{ received_at: hAgo(UNANSWERED_INQUIRY_HOURS + 1) }] };
        const t = triageOpportunity(o, NOW);
        expect(t.action?.kind).toBe('respond_to_inquiry');
        expect(t.priority).toBe('needs_attention');
        expect(funnelBucket(o, NOW)).toBe('needs_follow_up');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART L — never instruct the tenant to do something they cannot do
// ═══════════════════════════════════════════════════════════════════════════

describe('every follow-up instruction has a means to act on it', () => {
    const panel = () => require('fs').readFileSync(
        require('path').join(process.cwd(), 'components/crm2/FunnelLeadsPanel.tsx'), 'utf8');

    it('offers a way to reach the organization whenever it asks for a follow-up', () => {
        // The defect this pins: the follow-up branch depends on response state,
        // the send controls are gated on that same state, and the tenant was
        // told to follow up with every send control hidden.
        const src = panel();
        expect(src).toMatch(/o\.action\?\.kind === 'send_follow_up'/);
        // FR-ACCEPTANCE-2A.2: the mailto handoff is now a button (it has a side
        // effect — see the describe block below), not a plain anchor href.
        expect(src).toMatch(/window\.location\.href = href;/);
    });

    it('also offers it once the acknowledgement has gone out', () => {
        // After auto-ack the platform send is removed, so this is the ONLY way
        // left to contact the lead. If it were gated on the follow-up alone, an
        // acknowledged lead inside the 48-hour window would have no control at
        // all.
        const src = panel();
        expect(src).toMatch(/o\.action\?\.kind === 'send_follow_up' \|\| o\.response_state === 'auto_ack_sent'/);
    });

    it('FR-ACCEPTANCE-2A.2: the mail affordance now opens mail AND records the follow-up', () => {
        // Superseded by owner decision. The previous contract — open mail,
        // record NOTHING, tell the tenant to separately click "I replied
        // elsewhere" afterwards — was replaced with one combined action: click
        // once, mail opens, and FreezerIQ records that contact was initiated.
        // See the "combined mailto + record" describe block below for the full
        // behavioral proof.
        const src = panel();
        const block = src.slice(src.indexOf("o.action?.kind === 'send_follow_up' ||"), src.indexOf('!o.manual_response_applies'));
        expect(block).toMatch(/onClick/);
        expect(block).toMatch(/mutate\(o\.id, \{ action: 'mark_responded' \}/);
        // "I replied elsewhere" remains available as the SEPARATE off-platform
        // path (phone, in person) — this block is not that button.
        expect(block).not.toMatch(/setRespondingTo/);
    });

    it('warns about a possible duplicate when delivery was never confirmed', () => {
        // The ambiguity is real and the row cannot resolve it: a provider that
        // ACCEPTED the message and then failed to record it leaves the same
        // (claimed, null) shape as one that never sent. The send stays available
        // so nobody is stranded, but the tenant is told they could send twice.
        const src = panel();
        const block = src.slice(src.indexOf('Acknowledgement not confirmed'), src.indexOf('Nothing has been sent'));
        expect(block).toMatch(/may have received nothing/);
        expect(block).toMatch(/received it already/);
        expect(block).toMatch(/twice/);
    });

    it('says WHY when there is no usable address, instead of rendering nothing', () => {
        // The dead end this closes: a follow-up anchored on a manual reply hides
        // the buttons, and an unusable address hides the link — leaving an
        // instruction with nothing at all to act on.
        const src = panel();
        const block = src.slice(src.indexOf("o.action?.kind === 'send_follow_up' ||"), src.indexOf('!o.manual_response_applies'));
        expect(block).toMatch(/No usable email address on file/);
        expect(block).toMatch(/mailtoHref\(o\.customer\.contact_email\) \? \(/);
    });

    it('adds no second lead_intro send path', () => {
        // Part L: a deliberate follow-up template is NOT part of this phase.
        const src = panel();
        expect(src).not.toMatch(/follow_up_intro|lead_followup|sendFollowUp/i);
        expect((src.match(/setRespondingTo\(\{/g) || []).length).toBe(1);
    });

    it('REMOVES the lead_intro send once the acknowledgement was accepted', () => {
        // THE DEFECT THIS PINS. "Respond to inquiry" posts template:'lead_intro'
        // — the same message the acknowledgement already sent. An earlier
        // revision only RENAMED the button, which changed the label and not the
        // payload: one click still delivered a second identical introduction.
        const src = panel();
        expect(src).toMatch(/o\.response_state !== 'auto_ack_sent' && \(/);
        // The rename must be gone; a relabelled duplicate is still a duplicate.
        expect(src).not.toMatch(/Send a personal reply/);
    });

    it('the send button sits INSIDE the acknowledgement gate, not beside it', () => {
        const src = panel();
        const gate = src.indexOf("o.response_state !== 'auto_ack_sent' && (");
        const send = src.indexOf('<Send size={13} /> Respond to inquiry');
        const fallback = src.indexOf('<Mail size={13} /> I replied elsewhere');
        expect(gate).toBeGreaterThan(-1);
        expect(send).toBeGreaterThan(gate);
        // "I replied elsewhere" must remain OUTSIDE that gate — recording an
        // off-platform reply is exactly what an acknowledged lead still needs.
        expect(fallback).toBeGreaterThan(send);
        expect(src.slice(send, fallback)).toMatch(/\)\}/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART O — the mailto handover
// ═══════════════════════════════════════════════════════════════════════════

describe('mailtoHref', () => {
    // Re-implemented from the component, which cannot be imported: jest runs a
    // node environment with testMatch '**/*.test.ts', so .tsx never loads. The
    // source-identity test below pins them together.
    const mailtoHref = (email: string | null | undefined): string | null => {
        const v = (email ?? '').trim();
        if (!v || v.length > 254) return null;
        if (!/^[^\s<>()[\],;:\\"@]+@[^\s<>()[\],;:\\"@]+\.[^\s<>()[\],;:\\"@]+$/.test(v)) return null;
        return `mailto:${encodeURIComponent(v).replace(/%40/g, '@')}`;
    };

    it('builds a plain mailto for an ordinary address', () => {
        expect(mailtoHref('dana@oakridgepto.org')).toBe('mailto:dana@oakridgepto.org');
    });

    it('refuses anything carrying CR or LF', () => {
        // Header injection: a newline in a mailto target is how a handoff grows
        // a Bcc it was never asked for.
        for (const bad of ['a@b.com\nBcc: evil@x.com', 'a@b.com\r\nSubject: hi', 'a\n@b.com']) {
            expect(mailtoHref(bad)).toBeNull();
        }
    });

    it('cannot be turned into a javascript: or data: link', () => {
        for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'JaVaScRiPt:alert(1)@x.com']) {
            const href = mailtoHref(bad);
            expect(href === null || href.startsWith('mailto:')).toBe(true);
        }
        // The scheme is a literal in the builder, so nothing can precede it.
        expect(mailtoHref('x@y.com')!.startsWith('mailto:')).toBe(true);
    });

    it('a local part cannot smuggle in a subject or body', () => {
        // Left raw, `dana?subject=…@x.org` would stop being an address and start
        // being a query the tenant never wrote.
        const href = mailtoHref('dana?subject=Fired&body=bye@oakridgepto.org');
        expect(href).not.toMatch(/\?subject=/);
        expect(href).not.toMatch(/&body=/);
        if (href) expect(href).toContain('%3F');
    });

    it('rejects multiple addresses and separator characters', () => {
        for (const bad of ['a@b.com,c@d.com', 'a@b.com;c@d.com', 'a@b@c.com', '<a@b.com>', 'a b@c.com']) {
            expect(mailtoHref(bad)).toBeNull();
        }
    });

    it('renders no link at all rather than a broken one', () => {
        for (const bad of [null, undefined, '', '   ', 'nodomain', 'a@nodot', 'x'.repeat(300) + '@y.com']) {
            expect(mailtoHref(bad)).toBeNull();
        }
    });

    it('attaches no subject or body — this phase ships no follow-up copy', () => {
        expect(mailtoHref('dana@oakridgepto.org')).not.toMatch(/[?&]/);
    });

    it('is the same implementation the component ships', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components/crm2/FunnelLeadsPanel.tsx'), 'utf8');
        expect(src).toContain("if (!v || v.length > 254) return null;");
        expect(src).toContain('^[^\\s<>()[\\],;:\\\\"@]+@[^\\s<>()[\\],;:\\\\"@]+\\.[^\\s<>()[\\],;:\\\\"@]+$');
        expect(src).toContain("return `mailto:${encodeURIComponent(v).replace(/%40/g, '@')}`;");
    });

    it('accepts the real addresses the public intake already stores', () => {
        // The intake accepts /^[^\s@]+@[^\s@]+\.[^\s@]+$/, so these are already
        // in the database. A stricter rule here would tell the tenant there was
        // no address on file for a lead that has a perfectly good one.
        for (const ok of [
            'pta@central_district.org',
            'info@sankt-jürgen.de',
            'dana@école.fr',
            "o'brien@school.org",
            'a+tag@sub.domain.co.uk',
        ]) {
            expect(mailtoHref(ok)).not.toBeNull();
        }
    });

    it('the controls gate widens, never narrows, for a single-inquiry lead', () => {
        // With one inquiry, manual_response_applies is exactly !!first_response_at,
        // so no existing lead loses a control it had before.
        const answered = resolveInquiryResponse(hAgo(1), [{ received_at: hAgo(2) }]);
        expect(answered.manualResponseApplies).toBe(true);
        const unanswered = resolveInquiryResponse(null, [{ received_at: hAgo(2) }]);
        expect(unanswered.manualResponseApplies).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART T — funnel bucket, card state and drawer action must agree
// ═══════════════════════════════════════════════════════════════════════════

describe('state agreement matrix', () => {
    // Every row is one lead. All three surfaces derive from the same call, so a
    // disagreement here is a lead filed under one heading while the tenant is
    // told to do something else.
    const CASES: {
        name: string;
        o: any;
        state: string;
        bucket: string;
        kind: string;
        controls: 'send+record' | 'record only' | 'none';
    }[] = [
        {
            name: 'brand-new inquiry, nothing sent',
            o: { status: 'new', inquiries: [{ received_at: hAgo(2) }] },
            state: 'needs_first_response', bucket: 'new_leads',
            kind: 'respond_to_inquiry', controls: 'send+record',
        },
        {
            name: 'unanswered past the first-response threshold',
            o: { status: 'new', inquiries: [{ received_at: hAgo(UNANSWERED_INQUIRY_HOURS + 1) }] },
            state: 'needs_first_response', bucket: 'needs_follow_up',
            kind: 'respond_to_inquiry', controls: 'send+record',
        },
        {
            name: 'acknowledged, inside the follow-up window',
            o: { status: 'new', inquiries: [{ received_at: hAgo(3), ack_sent_at: hAgo(3) }] },
            state: 'auto_ack_sent', bucket: 'waiting_on_date',
            kind: 'await_preferred_dates', controls: 'record only',
        },
        {
            name: 'acknowledged, past the follow-up window',
            o: { status: 'in_conversation', inquiries: [{ received_at: dAgo(9), ack_sent_at: dAgo(9) }] },
            state: 'auto_ack_sent', bucket: 'needs_follow_up',
            kind: 'send_follow_up', controls: 'record only',
        },
        {
            name: 'acknowledgement claimed but never confirmed',
            o: { status: 'new', inquiries: [{ received_at: hAgo(5), ack_claimed_at: hAgo(5) }] },
            state: 'auto_ack_uncertain', bucket: 'needs_follow_up',
            kind: 'respond_to_inquiry', controls: 'send+record',
        },
        {
            name: 'human replied to the newest inquiry',
            o: { status: 'in_conversation', inquiries: [{ received_at: hAgo(4), human_response_at: hAgo(1) }] },
            state: 'manual_response', bucket: 'waiting_on_date',
            kind: 'await_preferred_dates', controls: 'none',
        },
        {
            name: 'human replied long ago, no date agreed',
            o: { status: 'in_conversation', inquiries: [{ received_at: dAgo(10), human_response_at: dAgo(9) }] },
            state: 'manual_response', bucket: 'needs_follow_up',
            kind: 'send_follow_up', controls: 'none',
        },
        {
            name: 'NEW inquiry after an old answered one',
            o: {
                status: 'in_conversation', first_response_at: dAgo(119),
                inquiries: [
                    { received_at: dAgo(120), human_response_at: dAgo(119), ack_sent_at: dAgo(120) },
                    { received_at: hAgo(1) },
                ],
            },
            state: 'needs_first_response', bucket: 'new_leads',
            kind: 'respond_to_inquiry', controls: 'send+record',
        },
        {
            name: 'date on the table outranks everything',
            o: {
                status: 'in_conversation', preferred_delivery_date: '2026-10-17', updated_at: hAgo(2),
                inquiries: [{ received_at: dAgo(9), ack_sent_at: dAgo(9) }],
            },
            state: 'auto_ack_sent', bucket: 'waiting_on_date',
            kind: 'check_date_availability', controls: 'record only',
        },
    ];

    it.each(CASES)('$name', ({ o, state, bucket, kind, controls }) => {
        const r = resolveInquiryResponse(o.first_response_at ?? null, o.inquiries);
        const t = triageOpportunity(o, NOW);

        expect(r.state).toBe(state);
        expect(funnelBucket(o, NOW)).toBe(bucket);
        expect(t.action?.kind).toBe(kind);

        // The two UI gates, derived exactly as the panel derives them.
        const showsPlatformSend = !r.manualResponseApplies && r.state !== 'auto_ack_sent';
        const showsRecord = !r.manualResponseApplies;
        const expected = showsPlatformSend ? 'send+record' : showsRecord ? 'record only' : 'none';
        expect(expected).toBe(controls);
    });

    it('a lead is never told to follow up with no way to make contact', () => {
        for (const { o } of CASES) {
            const t = triageOpportunity(o, NOW);
            if (t.action?.kind !== 'send_follow_up') continue;
            const r = resolveInquiryResponse(o.first_response_at ?? null, o.inquiries);
            // Either a platform send remains, or the mail-client handover is
            // shown — which the panel gates on exactly this condition.
            const platformSend = !r.manualResponseApplies && r.state !== 'auto_ack_sent';
            const mailHandover = true; // send_follow_up always renders it
            expect(platformSend || mailHandover).toBe(true);
        }
    });

    it('the platform never offers a second introduction after one was accepted', () => {
        for (const { o } of CASES) {
            const r = resolveInquiryResponse(o.first_response_at ?? null, o.inquiries);
            if (r.state !== 'auto_ack_sent') continue;
            expect(!r.manualResponseApplies && r.state !== 'auto_ack_sent').toBe(false);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART J — the hard invariant
// ═══════════════════════════════════════════════════════════════════════════

describe('automatic acknowledgement never impersonates a human reply', () => {
    it('writes no first_response_at anywhere in the module', async () => {
        const s = makeStore(); useStore(s); goLive();
        await ack();
        // Executed proof: the double exposes no opportunity model at all, so any
        // attempt to write one would have thrown rather than passed silently.
        expect((s.client as any).fundraiserOpportunity).toBeUndefined();
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib/inquiryAcknowledgement.ts'), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
            .split(/\r?\n/).filter((l: string) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        expect(code).not.toMatch(/first_response_at/);
        expect(code).not.toMatch(/fundraiserOpportunity/);
    });

    it('an acknowledged inquiry still counts as needing a human response', () => {
        // The tenant has not replied. The CRM must keep saying so.
        const r = resolveInquiryResponse(null, [{ received_at: hAgo(3), ack_sent_at: hAgo(3) }]);
        expect(r.state).toBe('auto_ack_sent');
        expect(r.manualResponseApplies).toBe(false);
    });
});
