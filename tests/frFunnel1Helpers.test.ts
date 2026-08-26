/**
 * FR-FUNNEL-1 — pure helpers: source-channel control, fingerprint stability,
 * and pre-campaign triage.
 *
 * These are the pieces that must not drift, because the writer, the CRM reader
 * and future reporting all depend on them agreeing.
 */
import {
    FUNDRAISER_SOURCE_CHANNELS,
    DEFAULT_SOURCE_CHANNEL,
    SOURCE_DETAIL_MAX_LENGTH,
    OPEN_OPPORTUNITY_STATUSES,
    TERMINAL_OPPORTUNITY_STATUSES,
    isFundraiserSourceChannel,
    isOpenOpportunityStatus,
    resolveSourceChannel,
    buildInquiryFingerprint,
    cleanText,
} from '@/lib/fundraiserFunnel';
// FR-FUNNEL-1P: the advisory lock is the canonical Production implementation.
import {
    identityLockKey,
    IDENTITY_LOCK_SQL,
    IDENTITY_LOCK_NAMESPACE,
    normalizeEmailIdentity,
} from '@/lib/publicIdentity';
import {
    triageOpportunity,
    funnelBucket,
    UNANSWERED_INQUIRY_HOURS,
    STALLED_CONVERSATION_DAYS,
    FOLLOW_UP_SILENCE_HOURS,
} from '@/lib/growth/opportunityNextAction';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 36e5).toISOString();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 864e5).toISOString();

describe('source channel is a controlled vocabulary', () => {
    it('publishes exactly the twelve agreed channels', () => {
        expect([...FUNDRAISER_SOURCE_CHANNELS]).toEqual([
            'tenant_website', 'freezeriq_site', 'meta_lead', 'instagram',
            'paid_ad', 'organic_social', 'referral', 'email', 'phone',
            'manual', 'returning_org', 'other',
        ]);
    });

    it('defaults an absent channel to the public storefront', () => {
        for (const absent of [undefined, null, '']) {
            const r = resolveSourceChannel(absent);
            expect(r).toEqual({ ok: true, channel: DEFAULT_SOURCE_CHANNEL });
        }
        expect(DEFAULT_SOURCE_CHANNEL).toBe('tenant_website');
    });

    it('accepts every published channel', () => {
        for (const c of FUNDRAISER_SOURCE_CHANNELS) {
            expect(resolveSourceChannel(c)).toEqual({ ok: true, channel: c });
        }
    });

    it('REJECTS an unknown channel rather than storing it', () => {
        // A typo that reaches the column becomes its own permanent reporting
        // bucket, indistinguishable from a real channel.
        for (const bad of ['Meta_Lead', 'facebook', 'tiktok', ' referral', 42, {}]) {
            const r = resolveSourceChannel(bad as any);
            expect(r.ok).toBe(false);
        }
    });

    it('isFundraiserSourceChannel is case-sensitive and type-safe', () => {
        expect(isFundraiserSourceChannel('meta_lead')).toBe(true);
        expect(isFundraiserSourceChannel('META_LEAD')).toBe(false);
        expect(isFundraiserSourceChannel(null)).toBe(false);
    });

    it('caps source_detail at the documented boundary', () => {
        expect(SOURCE_DETAIL_MAX_LENGTH).toBe(300);
        expect(cleanText('x'.repeat(500), SOURCE_DETAIL_MAX_LENGTH)).toHaveLength(300);
    });
});

describe('open vs terminal opportunity status', () => {
    it('open statuses match the partial unique index predicate', () => {
        expect([...OPEN_OPPORTUNITY_STATUSES]).toEqual(['new', 'in_conversation', 'date_confirmed']);
    });

    it('terminal statuses free the organization for a future cycle', () => {
        expect([...TERMINAL_OPPORTUNITY_STATUSES]).toEqual(['converted', 'lost']);
        for (const t of TERMINAL_OPPORTUNITY_STATUSES) {
            expect(isOpenOpportunityStatus(t)).toBe(false);
        }
    });

    it('open and terminal are disjoint and exhaustive', () => {
        const all = [...OPEN_OPPORTUNITY_STATUSES, ...TERMINAL_OPPORTUNITY_STATUSES];
        expect(new Set(all).size).toBe(5);
    });
});

describe('inquiry fingerprint', () => {
    const base = {
        slug: 'my-freezer-chef',
        organizationName: 'Lincoln PTA',
        contactEmail: 'amy@lincolnpta.org',
        contactName: 'Amy Smith',
        contactPhone: '555-0100',
    };

    it('is stable across repeated calls', () => {
        expect(buildInquiryFingerprint(base)).toBe(buildInquiryFingerprint(base));
    });

    it('is a sha256 hex digest and never contains the input', () => {
        const fp = buildInquiryFingerprint(base);
        expect(fp).toMatch(/^[0-9a-f]{64}$/);
        expect(fp).not.toContain('amy');
        expect(fp).not.toContain('Lincoln');
    });

    it('ignores slug and email casing, and surrounding whitespace', () => {
        expect(buildInquiryFingerprint({
            ...base, slug: 'MY-FREEZER-CHEF', contactEmail: '  AMY@LincolnPTA.org  ',
        })).toBe(buildInquiryFingerprint(base));
    });

    it('changes when the identity of the inquiry changes', () => {
        const fp = buildInquiryFingerprint(base);
        expect(buildInquiryFingerprint({ ...base, organizationName: 'Lincoln PTO' })).not.toBe(fp);
        expect(buildInquiryFingerprint({ ...base, contactEmail: 'bob@x.org' })).not.toBe(fp);
        expect(buildInquiryFingerprint({ ...base, contactPhone: '555-0199' })).not.toBe(fp);
        expect(buildInquiryFingerprint({ ...base, slug: 'other-tenant' })).not.toBe(fp);
    });

    it('does NOT change when free text is reworded', () => {
        // A corrected typo in the notes must not turn a retry into a hard
        // conflict — only identity fields are fingerprinted.
        const withText: any = { ...base, cause: 'Band trip', notes: 'call after 5' };
        expect(buildInquiryFingerprint(withText)).toBe(buildInquiryFingerprint(base));
    });
});

describe('triageOpportunity — pre-campaign next actions', () => {
    it('a brand-new unanswered inquiry asks for a reply', () => {
        const t = triageOpportunity({ status: 'new', received_at: hoursAgo(2), first_response_at: null }, NOW);
        expect(t.action?.kind).toBe('respond_to_inquiry');
        expect(t.priority).toBe('worth_a_look');
    });

    it('escalates once it has waited past the threshold', () => {
        const t = triageOpportunity(
            { status: 'new', received_at: hoursAgo(UNANSWERED_INQUIRY_HOURS + 1), first_response_at: null }, NOW);
        expect(t.priority).toBe('needs_attention');
        expect(t.action?.reason).toMatch(/hours/);
    });

    it('waits on the organization once we have replied', () => {
        const t = triageOpportunity(
            { status: 'in_conversation', received_at: hoursAgo(30), first_response_at: hoursAgo(29) }, NOW);
        expect(t.action?.kind).toBe('await_preferred_dates');
        expect(t.priority).toBe('on_pace');
    });

    // ── FR-ACCEPTANCE-2A.1 — the 48-hour follow-up signal ────────────────────
    //
    // What this closes: answering an inquiry used to remove it from the CRM's
    // attention PERMANENTLY. `on_pace` / "Waiting for preferred dates" was
    // terminal in practice — nothing escalated it, ever.

    it('stays on_pace while the follow-up window is still open', () => {
        const t = triageOpportunity({
            status: 'in_conversation',
            received_at: hoursAgo(FOLLOW_UP_SILENCE_HOURS + 5),
            first_response_at: hoursAgo(FOLLOW_UP_SILENCE_HOURS - 1),
        }, NOW);
        expect(t.action?.kind).toBe('await_preferred_dates');
        expect(t.priority).toBe('on_pace');
    });

    it('asks for a follow-up once the organization has been quiet past the window', () => {
        const t = triageOpportunity({
            status: 'in_conversation',
            received_at: daysAgo(6),
            first_response_at: hoursAgo(FOLLOW_UP_SILENCE_HOURS + 1),
        }, NOW);
        expect(t.action?.kind).toBe('send_follow_up');
        expect(t.priority).toBe('worth_a_look');
    });

    // The anchor is load-bearing. `updated_at` would let a tenant silence a cold
    // lead just by opening the drawer and typing a note.
    it('measures silence from OUR reply, not from the last record edit', () => {
        const t = triageOpportunity({
            status: 'in_conversation',
            received_at: daysAgo(30),
            first_response_at: daysAgo(9),
            updated_at: hoursAgo(1),
        }, NOW);
        expect(t.action?.kind).toBe('send_follow_up');
    });

    it('an unanswered inquiry is a first-response job, NOT a follow-up', () => {
        // received_at alone must never start the follow-up clock. If nobody has
        // answered, the faster UNANSWERED_INQUIRY_HOURS clock owns the lead —
        // routing it to the 48-hour signal would let the slower threshold hide a
        // person who has been waiting since the day they asked.
        const t = triageOpportunity({
            status: 'in_conversation', received_at: daysAgo(5), first_response_at: null,
        }, NOW);
        expect(t.action?.kind).toBe('respond_to_inquiry');
        expect(t.priority).toBe('needs_attention');
    });

    it('never accuses the organization of failing to reply', () => {
        // Inbound mail lands in the tenant's own inbox and is invisible here, so
        // the copy must prompt, not assert.
        const reason = triageOpportunity({
            status: 'in_conversation', first_response_at: daysAgo(4),
        }, NOW).action!.reason;
        expect(reason).toMatch(/since you replied/);
        expect(reason).not.toMatch(/not (yet )?(replied|responded|answered)|no reply|has not/i);
    });

    it('files the follow-up under the bucket that matches its action', () => {
        // A drawer saying "Send a follow-up" while the list files it under
        // "Waiting on Date" is the drift this guards.
        const quiet = {
            status: 'in_conversation', received_at: daysAgo(6),
            first_response_at: hoursAgo(FOLLOW_UP_SILENCE_HOURS + 1),
        };
        expect(triageOpportunity(quiet, NOW).action?.kind).toBe('send_follow_up');
        expect(funnelBucket(quiet, NOW)).toBe('needs_follow_up');

        const fresh = { status: 'in_conversation', first_response_at: hoursAgo(2) };
        expect(funnelBucket(fresh, NOW)).toBe('waiting_on_date');
    });

    it('a proposed date outranks silence — the tenant owes the next move', () => {
        // Once a date is on the table the ball is ours, so the availability
        // check must win even though our reply is long past the window.
        const t = triageOpportunity({
            status: 'in_conversation', first_response_at: daysAgo(10),
            preferred_delivery_date: '2026-10-17', updated_at: hoursAgo(2),
        }, NOW);
        expect(t.action?.kind).toBe('check_date_availability');
    });

    it('asks the tenant to check availability once a date is proposed', () => {
        const t = triageOpportunity({
            status: 'in_conversation', first_response_at: hoursAgo(20),
            preferred_delivery_date: '2026-10-17', updated_at: hoursAgo(2),
        }, NOW);
        expect(t.action?.kind).toBe('check_date_availability');
    });

    it('escalates a stalled date discussion', () => {
        const t = triageOpportunity({
            status: 'in_conversation', first_response_at: daysAgo(20),
            preferred_delivery_date: '2026-10-17', updated_at: daysAgo(STALLED_CONVERSATION_DAYS + 1),
        }, NOW);
        expect(t.action?.kind).toBe('confirm_delivery_date');
        expect(t.priority).toBe('needs_attention');
    });

    it('a confirmed date is ready to become a campaign', () => {
        const t = triageOpportunity({ status: 'date_confirmed', confirmed_delivery_date: '2026-10-17' }, NOW);
        expect(t.action?.kind).toBe('create_campaign');
        expect(t.priority).toBe('upcoming');
    });

    it('terminal opportunities carry NO next action', () => {
        for (const status of ['converted', 'lost']) {
            const t = triageOpportunity({ status }, NOW);
            expect(t.action).toBeNull();
            expect(t.priority).toBe('completed');
        }
    });

    it('is pure — same input, same output', () => {
        const o = { status: 'new', received_at: hoursAgo(3), first_response_at: null };
        expect(triageOpportunity(o, NOW)).toEqual(triageOpportunity(o, NOW));
    });

    it('degrades safely when optional fields are missing', () => {
        expect(() => triageOpportunity({ status: 'new' }, NOW)).not.toThrow();
        // FR-REBOOK-1: a payload with NO inquiry now asks for the date rather than
        // for a reply. This assertion previously expected 'respond_to_inquiry',
        // which was the old output for an empty object — and which became a real
        // untruth once the tenant could open an opportunity themselves. There is
        // no inquiry on such a row and nobody is waiting for an answer.
        expect(triageOpportunity({ status: 'new' }, NOW).action?.kind).toBe('await_preferred_dates');
    });

    it('an opportunity WITH an unanswered inquiry still asks for a reply', () => {
        // The public-inquiry path is unchanged — this is the case
        // 'respond_to_inquiry' exists for.
        const o = {
            status: 'new',
            received_at: hoursAgo(3),
            first_response_at: null,
            inquiries: [{ received_at: hoursAgo(3), ack_sent_at: null, ack_claimed_at: null, human_response_at: null }],
        };
        expect(triageOpportunity(o, NOW).action?.kind).toBe('respond_to_inquiry');
    });
});

describe('FR-FUNNEL-1R — customer-resolution lock identity', () => {
    const BIZ = 'biz-aaaa-1111';

    it('normalizes exactly the way the Customer lookup matches', () => {
        // The route matches on contact_email with mode: 'insensitive', so the
        // lock must collapse case and surrounding whitespace and nothing else.
        expect(normalizeEmailIdentity('  Amy@LincolnPTA.org  ')).toBe('amy@lincolnpta.org');
        expect(normalizeEmailIdentity('AMY@LINCOLNPTA.ORG')).toBe('amy@lincolnpta.org');
    });

    it('gives two requests the application considers the same organization ONE key', () => {
        const a = identityLockKey(BIZ, '  Amy@LincolnPTA.org ');
        const b = identityLockKey(BIZ, 'amy@lincolnpta.org');
        expect(a).toBe(b);
    });

    it('namespaces the lock so unrelated advisory locks cannot share semantics', () => {
        expect(IDENTITY_LOCK_NAMESPACE).toBe('freezeriq:fundraiser-inquiry-customer');
        expect(identityLockKey(BIZ, 'a@b.com'))
            .toBe(`freezeriq:fundraiser-inquiry-customer:${BIZ}:a@b.com`);
    });

    it('separates tenants — the same email in two tenants never contends', () => {
        expect(identityLockKey('biz-A', 'a@b.com'))
            .not.toBe(identityLockKey('biz-B', 'a@b.com'));
    });

    it('separates identities inside one tenant', () => {
        expect(identityLockKey(BIZ, 'a@b.com'))
            .not.toBe(identityLockKey(BIZ, 'c@d.com'));
    });

    it('is deterministic — the same inputs always produce the same key', () => {
        for (let i = 0; i < 50; i++) {
            expect(identityLockKey(BIZ, 'Amy@Lincoln.org'))
                .toBe(identityLockKey(BIZ, 'amy@lincoln.org'));
        }
    });

    it('hashes to the advisory-lock domain in POSTGRES, never in JavaScript', () => {
        // V8 string hashing is unspecified; two runtimes could disagree and let
        // same-identity requests take different locks.
        expect(IDENTITY_LOCK_SQL).toContain('pg_advisory_xact_lock');
        expect(IDENTITY_LOCK_SQL).toContain('md5($1)');
        expect(IDENTITY_LOCK_SQL).toContain('bit(64)');
    });

    it('uses the TRANSACTION-scoped variant, so no unlock can be leaked', () => {
        expect(IDENTITY_LOCK_SQL).toContain('_xact_');
        expect(IDENTITY_LOCK_SQL).not.toContain('pg_advisory_unlock');
        expect(IDENTITY_LOCK_SQL).not.toMatch(/pg_try_advisory/);
    });
});

describe('funnelBucket — derived CRM buckets', () => {
    it('separates fresh leads from ones that have been dropped', () => {
        expect(funnelBucket({ status: 'new', received_at: hoursAgo(1), first_response_at: null }, NOW)).toBe('new_leads');
        expect(funnelBucket({ status: 'new', received_at: hoursAgo(48), first_response_at: null }, NOW)).toBe('needs_follow_up');
    });

    it('maps conversation and confirmation to their own buckets', () => {
        expect(funnelBucket({ status: 'in_conversation', first_response_at: hoursAgo(2) }, NOW)).toBe('waiting_on_date');
        expect(funnelBucket({ status: 'date_confirmed' }, NOW)).toBe('ready_to_create_campaign');
    });

    it('closes terminal opportunities out of the working list', () => {
        expect(funnelBucket({ status: 'converted' }, NOW)).toBe('closed');
        expect(funnelBucket({ status: 'lost' }, NOW)).toBe('closed');
    });
});
