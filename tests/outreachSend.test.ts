process.env.TZ = 'America/Chicago';
/**
 * FR-RETENTION-3 — send engine, provider abstraction and message tests.
 *
 * These cover the properties that would cause real harm if wrong: sending
 * twice, sending to someone who opted out, claiming delivery we cannot prove,
 * and leaking provider internals to tenants.
 */

import {
    buildIdempotencyKey,
    checkSuppressionAtSend,
    runSend,
    type SendableRecipient,
} from '@/lib/outreachSend';
import {
    RecordingOutreachProvider,
    classifyProviderError,
} from '@/lib/outreachProvider';
import { renderSeasonalUpdate, resolveRebookingCta, checkSenderReadiness } from '@/lib/outreachMessage';

const NOW = new Date('2026-08-08T00:00:00.000Z');

// ── In-memory Prisma double ──────────────────────────────────────────────────
// Models only what the engine touches, including the unique-key rejection that
// makes double-send impossible.
function makePrisma(prefs: any[] = []) {
    const attempts = new Map<string, any>();
    const byKey = new Set<string>();
    let seq = 0;
    return {
        _attempts: attempts,
        marketingPreference: {
            findMany: async ({ where }: any) => prefs.filter((p) => {
                const or = where.OR ?? [];
                return or.some((c: any) =>
                    (c.scope === 'contact' && c.contact_id?.in?.includes(p.contact_id) && p.scope === 'contact') ||
                    (c.scope === 'email_address' && c.normalized_email === p.normalized_email && p.scope === 'email_address'));
            }),
        },
        emailDeliveryAttempt: {
            create: async ({ data }: any) => {
                if (byKey.has(data.idempotency_key)) {
                    // Mirrors the unique index rejecting the second claim.
                    throw new Error('Unique constraint failed on idempotency_key');
                }
                byKey.add(data.idempotency_key);
                const id = `att-${++seq}`;
                attempts.set(id, { id, ...data });
                return { id };
            },
            update: async ({ where, data }: any) => {
                const a = attempts.get(where.id);
                Object.assign(a, data);
                return a;
            },
        },
    } as any;
}

function recipient(over: Partial<SendableRecipient> & { recipientId: string }): SendableRecipient {
    return {
        normalizedEmail: `${over.recipientId}@example.org`,
        displayName: over.recipientId,
        contactIds: [`c-${over.recipientId}`],
        organizationNames: ['Org'],
        ...over,
    };
}

const RENDER = () => ({ subject: 's', html: '<p>h</p>', text: 't' });

async function send(prisma: any, provider: RecordingOutreachProvider, recipients: SendableRecipient[], generation = 1) {
    return runSend({
        prisma, provider, businessId: 'biz', batchId: 'batch', messageId: 'msg',
        generation, recipients, render: RENDER, from: 'a@b.co', now: NOW,
    });
}

describe('idempotency key', () => {
    it('is deterministic for the same recipient and message', () => {
        expect(buildIdempotencyKey('m', 'r', 1)).toBe(buildIdempotencyKey('m', 'r', 1));
    });
    it('differs per recipient and per generation', () => {
        expect(buildIdempotencyKey('m', 'r1', 1)).not.toBe(buildIdempotencyKey('m', 'r2', 1));
        expect(buildIdempotencyKey('m', 'r', 1)).not.toBe(buildIdempotencyKey('m', 'r', 2));
    });
});

describe('6 + 9. one provider call per eligible recipient', () => {
    it('sends exactly once each', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider();
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1' }), recipient({ recipientId: 'r2' })]);
        expect(provider.calls).toHaveLength(2);
        expect(s.accepted).toBe(2);
        expect(s.batchStatus).toBe('completed');
    });
});

describe('6. double-click send idempotency', () => {
    it('the second run sends nothing', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider();
        const rs = [recipient({ recipientId: 'r1' }), recipient({ recipientId: 'r2' })];
        const first = await send(prisma, provider, rs);
        const second = await send(prisma, provider, rs);
        expect(first.accepted).toBe(2);
        expect(second.accepted).toBe(0);
        expect(second.alreadyAttempted).toBe(2);
        expect(provider.calls).toHaveLength(2);   // still 2, not 4
    });
});

describe('7. triple-click send idempotency', () => {
    it('still exactly one provider call per recipient', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider();
        const rs = [recipient({ recipientId: 'r1' })];
        await send(prisma, provider, rs);
        await send(prisma, provider, rs);
        await send(prisma, provider, rs);
        expect(provider.calls).toHaveLength(1);
    });
});

describe('8. concurrent duplicate requests', () => {
    it('two simultaneous sends still produce one email each', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider();
        const rs = [recipient({ recipientId: 'r1' }), recipient({ recipientId: 'r2' })];
        const [a, b] = await Promise.all([send(prisma, provider, rs), send(prisma, provider, rs)]);
        expect(provider.calls).toHaveLength(2);
        expect(a.accepted + b.accepted).toBe(2);
        expect(a.alreadyAttempted + b.alreadyAttempted).toBe(2);
    });
});

describe('10. contact unsubscribes after audience review', () => {
    it('is skipped, not sent', async () => {
        const prisma = makePrisma([{ scope: 'contact', contact_id: 'c-r1', status: 'unsubscribed', effective_until: null }]);
        const provider = new RecordingOutreachProvider();
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1' })]);
        expect(provider.calls).toHaveLength(0);
        expect(s.skipped).toBe(1);
        expect(s.outcomes[0].result).toBe('skipped_suppressed');
        expect(s.outcomes[0].failureDetail).toMatch(/unsubscribed after the audience was reviewed/i);
    });
});

describe('11. shared address suppressed after review', () => {
    it('skips the whole inbox', async () => {
        const prisma = makePrisma([{ scope: 'email_address', normalized_email: 'r1@example.org', status: 'unsubscribed', effective_until: null }]);
        const provider = new RecordingOutreachProvider();
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1', contactIds: ['c-a', 'c-b'] })]);
        expect(provider.calls).toHaveLength(0);
        expect(s.outcomes[0].failureDetail).toMatch(/someone at this address/i);
    });

    it('an elapsed pause does NOT suppress', async () => {
        const prisma = makePrisma([{ scope: 'contact', contact_id: 'c-r1', status: 'paused', effective_until: new Date('2026-01-01') }]);
        const provider = new RecordingOutreachProvider();
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1' })]);
        expect(s.accepted).toBe(1);
    });

    it('an active pause DOES suppress', async () => {
        const prisma = makePrisma([{ scope: 'contact', contact_id: 'c-r1', status: 'paused', effective_until: new Date('2027-01-01') }]);
        const provider = new RecordingOutreachProvider();
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1' })]);
        expect(s.skipped).toBe(1);
    });
});

describe('12. the reviewed audience is the upper bound', () => {
    it('sends only to the recipients handed in — never widens', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider();
        await send(prisma, provider, [recipient({ recipientId: 'r1' })]);
        expect(provider.calls.map((c) => c.to)).toEqual(['r1@example.org']);
    });

    it('a recipient with no address is skipped rather than guessed at', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider();
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1', normalizedEmail: null })]);
        expect(provider.calls).toHaveLength(0);
        expect(s.skipped).toBe(1);
    });
});

describe('13 + 14 + 15. provider outcomes and partial failure', () => {
    it('records acceptance honestly, never delivery', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider(() => ({ outcome: 'accepted', providerMessageId: 'pm-1' }));
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1' })]);
        expect(s.outcomes[0].result).toBe('accepted');
        expect(s.outcomes[0].providerMessageId).toBe('pm-1');
        expect(JSON.stringify(s)).not.toMatch(/delivered/i);
    });

    it('one failure does not undo the accepted ones', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider((_i, idx) =>
            idx === 1 ? { outcome: 'failed', category: 'provider_rejected_recipient', detail: 'refused' }
                : { outcome: 'accepted', providerMessageId: 'ok' });
        const s = await send(prisma, provider, [
            recipient({ recipientId: 'r1' }), recipient({ recipientId: 'r2' }), recipient({ recipientId: 'r3' }),
        ]);
        expect(s.accepted).toBe(2);
        expect(s.failed).toBe(1);
        expect(s.batchStatus).toBe('completed_with_issues');
    });

    it('re-running after a partial failure does not re-send the successes', async () => {
        const prisma = makePrisma();
        const failing = new RecordingOutreachProvider((_i, idx) =>
            idx === 0 ? { outcome: 'failed', category: 'transient_transport', detail: 'x' }
                : { outcome: 'accepted', providerMessageId: 'ok' });
        const rs = [recipient({ recipientId: 'r1' }), recipient({ recipientId: 'r2' })];
        await send(prisma, failing, rs);
        const retry = new RecordingOutreachProvider();
        const second = await send(prisma, retry, rs);
        expect(retry.calls).toHaveLength(0);          // nothing re-sent
        expect(second.alreadyAttempted).toBe(2);
    });

    it('a total failure reports failed_before_send', async () => {
        const prisma = makePrisma();
        const provider = new RecordingOutreachProvider(() => ({ outcome: 'failed', category: 'provider_auth', detail: 'no key' }));
        const s = await send(prisma, provider, [recipient({ recipientId: 'r1' })]);
        expect(s.batchStatus).toBe('failed_before_send');
    });
});

describe('provider error classification', () => {
    it('maps errors to tenant-safe wording without leaking internals', () => {
        const cases: [string, string][] = [
            ['Invalid email address', 'invalid_address'],
            ['Unauthorized: bad API key', 'provider_auth'],
            ['429 rate limit exceeded', 'transient_transport'],
            ['recipient blocked', 'provider_rejected_recipient'],
            ['something odd', 'unknown'],
        ];
        for (const [raw, expected] of cases) {
            const r = classifyProviderError(new Error(raw));
            expect(r.category).toBe(expected);
            expect(r.detail).not.toMatch(/smtp|api key|429|stack|resend/i);
        }
    });
});

describe('5. real send is CTA-gated until CP4', () => {
    it('reports not-ready with plain language and no invented URL', () => {
        const cta = resolveRebookingCta('batch');
        expect(cta.ready).toBe(false);
        expect(cta.url).toBeNull();
        expect(cta.blockedReason).toMatch(/rebooking link needs to be ready/i);
    });
});

describe('message rendering', () => {
    const base = {
        tenantName: 'Frozen Harvest', organizationNames: ['Pine Valley PTO'],
        lineupName: 'Fall 2026',
        lineupStartsAt: new Date('2026-09-01'), lineupEndsAt: new Date('2026-11-30'),
        hasPreviousFundraiser: true, previousCampaignName: 'Fall 2025',
        cta: resolveRebookingCta('b'),
    };

    it('states no money figure at all', () => {
        const m = renderSeasonalUpdate(base);
        expect(m.html).not.toMatch(/\$\s?\d/);
        expect(m.text).not.toMatch(/\$\s?\d/);
        expect(m.text).not.toMatch(/raised|kept|earned|profit/i);
    });

    it('shows the internal CTA placeholder while CP4 is missing', () => {
        const m = renderSeasonalUpdate(base);
        expect(m.text).toMatch(/rebooking link will be added before sending/i);
        expect(m.html).not.toMatch(/href="(#|null|undefined|about:blank)"/);
    });

    it('marks a test message visibly in subject and body', () => {
        const m = renderSeasonalUpdate({ ...base, isTest: true });
        expect(m.subject).toMatch(/^\[TEST\]/);
        expect(m.html).toMatch(/This is a TEST email/i);
    });

    it('escapes organization names', () => {
        const m = renderSeasonalUpdate({ ...base, organizationNames: ['<script>alert(1)</script>'] });
        expect(m.html).not.toMatch(/<script>/);
        expect(m.html).toMatch(/&lt;script&gt;/);
    });

    it('names every organization a shared inbox represents', () => {
        const m = renderSeasonalUpdate({ ...base, organizationNames: ['A', 'B', 'C'] });
        expect(m.subject).toMatch(/A, B & C/);
    });
});

// ── FR-RETENTION-3C corrections ──────────────────────────────────────────────

describe('3C — sender readiness gate', () => {
    it('missing sender refuses a real send', () => {
        for (const v of [undefined, null, '', '   ']) {
            const r = checkSenderReadiness(v as string | undefined);
            expect(r.ready).toBe(false);
            expect(r.blockedReason).toMatch(/email sending needs to be configured/i);
        }
    });

    it('the provider development fallback refuses a real send', () => {
        for (const v of [
            'onboarding@resend.dev',
            'FreezerIQ <onboarding@resend.dev>',
            'ONBOARDING@RESEND.DEV',
        ]) {
            expect(checkSenderReadiness(v).ready).toBe(false);
        }
    });

    it('a configured non-fallback sender passes the sender check', () => {
        expect(checkSenderReadiness('FreezerIQ <notifications@freezeriq.com>').ready).toBe(true);
        expect(checkSenderReadiness('notifications@freezeriq.com').ready).toBe(true);
    });

    it('never leaks the env var, the provider name, or the fallback address', () => {
        const r = checkSenderReadiness(undefined);
        expect(r.blockedReason).not.toMatch(/EMAIL_FROM|resend|onboarding@/i);
    });

    it('a configured sender still leaves the CP4 CTA gate blocking today', () => {
        expect(checkSenderReadiness('notifications@freezeriq.com').ready).toBe(true);
        expect(resolveRebookingCta('batch').ready).toBe(false);
    });

    it('both gates are independent — neither alone permits a real send', () => {
        const senderOk = checkSenderReadiness('notifications@freezeriq.com').ready;
        const ctaOk = resolveRebookingCta('b').ready;
        expect(senderOk && ctaOk).toBe(false);
    });
});

describe('3C — calendar dates in the rendered message', () => {
    it('renders Sep 1 – Nov 30 without shifting a day', () => {
        const m = renderSeasonalUpdate({
            tenantName: 'T', organizationNames: ['O'], lineupName: 'Fall 2026',
            lineupStartsAt: new Date('2026-09-01T00:00:00.000Z'),
            lineupEndsAt: new Date('2026-11-30T00:00:00.000Z'),
            hasPreviousFundraiser: true, previousCampaignName: null,
            cta: resolveRebookingCta('b'),
        });
        expect(m.text).toContain('September 1 – November 30');
        expect(m.text).not.toContain('August 31');
        expect(m.text).not.toContain('November 29');
    });
});
