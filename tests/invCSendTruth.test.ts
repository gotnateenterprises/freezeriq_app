/**
 * INV-C — send truth: the DRAFT -> SENT transition.
 *
 * The rule these defend is narrow and easy to get wrong in a way nobody notices
 * until a coordinator says "I never got it": SENT must mean the provider
 * actually accepted the message. The dangerous case is not a crash — it is
 * app/api/email/send/route.ts's safety mode, which returns
 * `{ success: true, mocked: true }`. A caller that checks `res.ok` and marks
 * SENT would be wrong on a 200.
 *
 * The pure decision is tested directly; the route is EXECUTED against a mocked
 * Prisma and a mocked Resend so the provider outcome can be driven precisely.
 */

const calls: Array<{ op: string; args?: any }> = [];

let invoiceRow: any;
let updateManyResult = { count: 1 };
let resendResult: any = { data: { id: 'msg_1' }, error: null };
let resendThrows: Error | null = null;

jest.mock('@/lib/db', () => ({
    prisma: {
        invoice: {
            findFirst: async (args: any) => { calls.push({ op: 'invoice.findFirst', args }); return invoiceRow; },
            updateMany: async (args: any) => { calls.push({ op: 'invoice.updateMany', args }); return updateManyResult; },
            update: async (args: any) => { calls.push({ op: 'invoice.update', args }); return {}; },
        },
    },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

jest.mock('resend', () => ({
    Resend: class {
        emails = {
            send: async (payload: any) => {
                calls.push({ op: 'resend.send', args: payload });
                if (resendThrows) throw resendThrows;
                return resendResult;
            },
        };
    },
}));

jest.mock('@/lib/email', () => ({
    getTenantSender: async () => ({ from: 'Tenant via FreezerIQ <no-reply@platform.test>', replyTo: 'tenant@biz.test' }),
}));

import {
    decideInvoiceSendStatus,
    isLiveEmailConfigured,
    isGeneratedFundraiserInvoice,
    INV_C_WRITABLE_STATUSES,
} from '@/lib/invoiceSendTruth';

const BIZ = 'biz-a';
const INVOICE_ID = 'inv-1';
const CUSTOMER_EMAIL = 'coordinator@school.test';

const post = async (body: any = { subject: 'Fundraiser invoice', html: '<p>hi</p>', attachments: [] }) => {
    const { POST } = await import('@/app/api/tenant/invoices/[id]/send/route');
    return POST(
        new Request('http://localhost/api/tenant/invoices/' + INVOICE_ID + '/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }) as any,
        { params: Promise.resolve({ id: INVOICE_ID }) } as any,
    );
};

/** Put the environment into a real-send configuration. */
const setLive = (live: boolean) => {
    if (live) {
        process.env.RESEND_API_KEY = 'test-key';
        process.env.EMAIL_LIVE = 'true';
    } else {
        process.env.RESEND_API_KEY = 'test-key';
        process.env.EMAIL_LIVE = 'false';
    }
};

beforeEach(() => {
    calls.length = 0;
    updateManyResult = { count: 1 };
    resendResult = { data: { id: 'msg_1' }, error: null };
    resendThrows = null;
    invoiceRow = {
        id: INVOICE_ID,
        status: 'DRAFT',
        campaign_id: 'camp-1',
        total_amount: '202.5',
        customer: { name: 'The Best Brew Test 2', contact_email: CUSTOMER_EMAIL },
    };
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({
        user: { id: 'user-admin', businessId: BIZ, role: 'ADMIN', isSuperAdmin: false },
    });
    setLive(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// The pure rule
// ═══════════════════════════════════════════════════════════════════════════

describe('decideInvoiceSendStatus', () => {
    it('provider accepted -> SENT', () => {
        expect(decideInvoiceSendStatus({ ok: true, mocked: false, providerId: 'x' }))
            .toEqual({ markSent: true, status: 'SENT', reason: 'provider_accepted' });
    });

    it('safety mode returns success but is NOT a send -> stays DRAFT', () => {
        // The trap: ok is TRUE here. Only `mocked` distinguishes it.
        expect(decideInvoiceSendStatus({ ok: true, mocked: true }))
            .toEqual({ markSent: false, status: 'DRAFT', reason: 'mocked' });
    });

    it('provider failure -> stays DRAFT', () => {
        expect(decideInvoiceSendStatus({ ok: false, mocked: false, error: 'boom' }))
            .toEqual({ markSent: false, status: 'DRAFT', reason: 'provider_failed' });
    });

    it('never produces PAID, under any outcome', () => {
        for (const o of [
            { ok: true, mocked: false }, { ok: true, mocked: true }, { ok: false, mocked: false },
        ]) {
            expect(decideInvoiceSendStatus(o).status).not.toBe('PAID');
        }
        expect(INV_C_WRITABLE_STATUSES).toEqual(['SENT']);
        expect(INV_C_WRITABLE_STATUSES).not.toContain('PAID');
    });

    it('mirrors the mailer\'s own live-mode rule exactly', () => {
        expect(isLiveEmailConfigured({ RESEND_API_KEY: 'k', EMAIL_LIVE: 'true' })).toBe(true);
        expect(isLiveEmailConfigured({ RESEND_API_KEY: 'k', EMAIL_LIVE: 'false' })).toBe(false);
        expect(isLiveEmailConfigured({ RESEND_API_KEY: 'k', EMAIL_LIVE: 'TRUE' })).toBe(false);
        expect(isLiveEmailConfigured({ RESEND_API_KEY: 'k' })).toBe(false);
        expect(isLiveEmailConfigured({ EMAIL_LIVE: 'true' })).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// The route
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/tenant/invoices/[id]/send', () => {
    it('a successful provider send transitions DRAFT -> SENT', async () => {
        const res = await post();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toMatchObject({ success: true, sent: true, mocked: false, status: 'SENT' });

        const update = calls.find((c) => c.op === 'invoice.updateMany')!;
        expect(update.args.data.status).toBe('SENT');
        // Guarded so it can only advance a DRAFT, and only within this tenant.
        expect(update.args.where).toMatchObject({ id: INVOICE_ID, business_id: BIZ, status: 'DRAFT' });
    });

    it('SAFETY MODE: returns success but does NOT mark SENT', async () => {
        setLive(false);

        const res = await post();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.sent).toBe(false);
        expect(body.mocked).toBe(true);
        expect(body.status).toBe('DRAFT');
        expect(calls.some((c) => c.op === 'invoice.updateMany')).toBe(false);
        expect(calls.some((c) => c.op === 'resend.send')).toBe(false);
    });

    it('a provider ERROR response leaves the invoice DRAFT', async () => {
        resendResult = { data: null, error: { message: 'domain not verified' } };

        const res = await post();
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.sent).toBe(false);
        expect(body.status).toBe('DRAFT');
        expect(calls.some((c) => c.op === 'invoice.updateMany')).toBe(false);
    });

    it('a thrown provider exception leaves the invoice DRAFT', async () => {
        resendThrows = new Error('network down');

        const res = await post();
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.sent).toBe(false);
        expect(body.status).toBe('DRAFT');
        expect(calls.some((c) => c.op === 'invoice.updateMany')).toBe(false);
    });

    it('provider error text is never surfaced to the browser', async () => {
        resendResult = { data: null, error: { message: 'sk_live_secret rejected by upstream' } };
        const body = await (await post()).json();
        expect(JSON.stringify(body)).not.toMatch(/sk_live|upstream|domain not verified/);
    });

    it('SENT is never PAID', async () => {
        await post();
        const update = calls.find((c) => c.op === 'invoice.updateMany')!;
        expect(update.args.data.status).not.toBe('PAID');
        expect(JSON.stringify(update.args.data)).not.toMatch(/paid|settle/i);
    });
});

describe('recipient authority', () => {
    it('the recipient is resolved from the invoice customer, server-side', async () => {
        await post();
        const sent = calls.find((c) => c.op === 'resend.send')!;
        expect(sent.args.to).toEqual([CUSTOMER_EMAIL]);
    });

    it('a client-supplied `to` cannot redirect the email', async () => {
        await post({
            subject: 'x', html: '<p>y</p>', attachments: [],
            to: 'attacker@evil.test', recipient: 'attacker@evil.test',
        });
        const sent = calls.find((c) => c.op === 'resend.send')!;
        expect(sent.args.to).toEqual([CUSTOMER_EMAIL]);
        expect(JSON.stringify(sent.args.to)).not.toMatch(/attacker/);
    });

    it('the signed-in admin\'s own email is never the recipient (View As safety)', async () => {
        mockAuth.mockResolvedValue({
            user: { id: 'user-super', email: 'admin@platform.test', businessId: BIZ, isSuperAdmin: true },
        });
        await post();
        const sent = calls.find((c) => c.op === 'resend.send')!;
        expect(sent.args.to).toEqual([CUSTOMER_EMAIL]);
        expect(sent.args.to).not.toContain('admin@platform.test');
    });

    it('a customer with no email refuses to send rather than guessing one', async () => {
        invoiceRow = { ...invoiceRow, customer: { name: 'X', contact_email: null } };
        const res = await post();
        expect(res.status).toBe(400);
        expect(calls.some((c) => c.op === 'resend.send')).toBe(false);
        expect(calls.some((c) => c.op === 'invoice.updateMany')).toBe(false);
    });
});

describe('tenant isolation and access', () => {
    it('an unauthenticated caller is refused', async () => {
        mockAuth.mockResolvedValue(null);
        expect((await post()).status).toBe(401);
        expect(calls.some((c) => c.op === 'resend.send')).toBe(false);
    });

    it('a session with no business context is refused', async () => {
        mockAuth.mockResolvedValue({ user: { id: 'u', businessId: undefined } });
        expect((await post()).status).toBe(401);
    });

    it('the invoice lookup is scoped to the caller\'s effective tenant', async () => {
        await post();
        const look = calls.find((c) => c.op === 'invoice.findFirst')!;
        expect(look.args.where).toMatchObject({ id: INVOICE_ID, business_id: BIZ });
    });

    it('another tenant\'s invoice is 404, not 403 — no id probing', async () => {
        invoiceRow = null;
        const res = await post();
        expect(res.status).toBe(404);
        expect(calls.some((c) => c.op === 'resend.send')).toBe(false);
    });
});

describe('retry and re-send behaviour', () => {
    it('a failed send leaves it DRAFT so it can simply be retried', async () => {
        resendResult = { data: null, error: { message: 'temporary' } };
        expect((await post()).status).toBe(502);

        calls.length = 0;
        resendResult = { data: { id: 'msg_2' }, error: null };
        const body = await (await post()).json();
        expect(body.sent).toBe(true);
        expect(body.status).toBe('SENT');
    });

    it('re-sending an already-SENT invoice does not revert it to DRAFT', async () => {
        invoiceRow = { ...invoiceRow, status: 'SENT' };
        updateManyResult = { count: 0 };   // the DRAFT-guarded claim matches nothing

        const body = await (await post()).json();
        expect(body.sent).toBe(true);
        expect(body.status).toBe('SENT');
    });

    it('re-sending never creates a second invoice', async () => {
        await post();
        await post();
        expect(calls.filter((c) => c.op === 'invoice.update').length).toBe(0);
        for (const c of calls.filter((c) => c.op === 'invoice.updateMany')) {
            expect(c.args.where.id).toBe(INVOICE_ID);
        }
    });

    it('a subject or body missing refuses before contacting the provider', async () => {
        for (const bad of [{ html: '<p>x</p>' }, { subject: 'x' }, { subject: '   ', html: '<p>x</p>' }, {}]) {
            calls.length = 0;
            const res = await post(bad as any);
            expect(res.status).toBe(400);
            expect(calls.some((c) => c.op === 'resend.send')).toBe(false);
        }
    });
});

describe('generated-fundraiser-invoice detection', () => {
    it('recognises a campaign-linked invoice', () => {
        expect(isGeneratedFundraiserInvoice({ campaign_id: 'camp-1' })).toBe(true);
    });

    it('an ordinary manual invoice is not one', () => {
        for (const v of [null, undefined, '']) {
            expect(isGeneratedFundraiserInvoice({ campaign_id: v })).toBe(false);
        }
        expect(isGeneratedFundraiserInvoice({} as any)).toBe(false);
    });
});
