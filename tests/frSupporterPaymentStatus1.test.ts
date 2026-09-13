/**
 * FR-SUPPORTER-PAYMENT-STATUS-1 — coordinator Mark Paid / Undo paid.
 *
 * WHICH PAYMENT: supporter -> fundraiser coordinator. NOT the organization's
 * invoice to My Freezer Chef. The two must never touch.
 *
 * The central behavioural section runs the REAL PATCH handler against the
 * recording Prisma double in tests/helpers/routeHarness.ts, and asserts on the
 * query the handler actually built and the response a coordinator actually
 * gets — not on what the source text looks like.
 *
 * Existing orders carry no evidence that a supporter paid OR did not pay, so the
 * wording rule is tested as hard as the write: an unmarked order is
 * "Payment not marked", never "Unpaid".
 */
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    SUPPORTER_PAYMENT_ACTIONS,
    SUPPORTER_PAYMENT_EVENT_TYPES,
    PAYMENT_NOT_MARKED_LABEL,
    PAYMENT_PAID_LABEL,
    coordinatorPaymentActor,
    explainNoopPaymentTransition,
    formatPaidDate,
    isSupporterPaymentAction,
    paymentOwnershipWhere,
    paymentTransitionData,
    paymentTransitionWhere,
    summarizeGroupPayment,
    supporterPaymentState,
} from '@/lib/supporterPayment';
import {
    SUPPORTER_ORDER_SELECT,
    groupSupporterRows,
    toSupporterOrder,
} from '@/lib/coordinatorSupporterOrders';
import { computeCloseoutFinancials } from '@/lib/fundraiserCloseoutMath';
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const readCode = (...p: string[]) => strip(read(...p));

const CAMPAIGN_A = 'campaign-sps1-a';
const CAMPAIGN_B = 'campaign-sps1-b';
const SESSION_ID = 'session-sps1';
const ORDER_1 = 'order-sps1-1';

// ── Harness wiring (mirrors tests/coordFulfillment1.test.ts) ─────────────────
let mock: PrismaMock;
jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__sps1Prisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__sps1CookieName && (global as any).__sps1Authed
                ? { name, value: 'sps1-test-secret' }
                : undefined,
    }),
}));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__sps1Prisma = m.client; };
const setAuthenticated = (authenticated: boolean) => {
    (global as any).__sps1CookieName = coordinatorSessionCookieName();
    (global as any).__sps1Authed = authenticated;
};
const sessionFor = (campaignId: string) => ({
    id: SESSION_ID,
    campaign_id: campaignId,
    expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: null,
});
const assignment = (name: string) => ({
    org_contact: { ended_at: null, contact: { display_name: name, contact_points: [{ value: 'kristi@example.org' }] } },
});

const patchRequest = (body: unknown, origin = 'http://localhost') =>
    new Request('http://localhost/api/coordinator', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', origin },
        body: JSON.stringify(body),
    }) as any;

async function callPatch(body: unknown, origin?: string) {
    const { PATCH } = await import('@/app/api/coordinator/route');
    const res = await PATCH(patchRequest(body, origin));
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
}

const FORBIDDEN_WRITE_KEYS = [
    'total_amount', 'tax_amount', 'status', 'items', 'invoice_id', 'campaign_id',
    'customer_id', 'source', 'canceled_at', 'delivery_fee', 'released_to_delivery_at',
];

beforeEach(() => {
    jest.clearAllMocks();
    setAuthenticated(true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE PURE RULE
// ═════════════════════════════════════════════════════════════════════════════
describe('1. the rule in lib/supporterPayment.ts', () => {
    it('recognises exactly two actions', () => {
        expect([...SUPPORTER_PAYMENT_ACTIONS]).toEqual(['mark_paid', 'mark_unpaid']);
        for (const a of SUPPORTER_PAYMENT_ACTIONS) expect(isSupporterPaymentAction(a)).toBe(true);
        for (const a of ['restore', 'paid', 'MARK_PAID', '', null, undefined, 1, {}]) {
            expect(isSupporterPaymentAction(a)).toBe(false);
        }
    });

    it('the WHERE scopes by order, campaign, fundraiser source, not-canceled and current state', () => {
        const scope = { orderId: ORDER_1, campaignId: CAMPAIGN_A };
        expect(paymentTransitionWhere('mark_paid', scope)).toEqual({
            id: ORDER_1, campaign_id: CAMPAIGN_A, source: 'fundraiser', canceled_at: null, paid_at: null,
        });
        expect(paymentTransitionWhere('mark_unpaid', scope)).toEqual({
            id: ORDER_1, campaign_id: CAMPAIGN_A, source: 'fundraiser', canceled_at: null, NOT: { paid_at: null },
        });
    });

    it('the data written is EXACTLY paid_at and paid_by — nothing else is reachable', () => {
        const now = new Date('2026-09-12T15:00:00Z');
        const paid = paymentTransitionData('mark_paid', { now, actor: 'coordinator:s' });
        const undo = paymentTransitionData('mark_unpaid', { now, actor: 'coordinator:s' });
        expect(Object.keys(paid).sort()).toEqual(['paid_at', 'paid_by']);
        expect(Object.keys(undo).sort()).toEqual(['paid_at', 'paid_by']);
        expect(paid).toEqual({ paid_at: now, paid_by: 'coordinator:s' });
        expect(undo).toEqual({ paid_at: null, paid_by: null });
        for (const k of FORBIDDEN_WRITE_KEYS) {
            expect(paid).not.toHaveProperty(k);
            expect(undo).not.toHaveProperty(k);
        }
    });

    it('the ownership lookup never widens the scope', () => {
        expect(paymentOwnershipWhere({ orderId: ORDER_1, campaignId: CAMPAIGN_A })).toEqual({
            id: ORDER_1, campaign_id: CAMPAIGN_A, source: 'fundraiser', canceled_at: null,
        });
    });

    it('paid_by names the actor class and the session, falling back to the class alone', () => {
        expect(coordinatorPaymentActor('abc-123')).toBe('coordinator:abc-123');
        expect(coordinatorPaymentActor('  ')).toBe('coordinator');
        expect(coordinatorPaymentActor(null)).toBe('coordinator');
        expect(coordinatorPaymentActor('abc').startsWith('coordinator')).toBe(true);
    });

    it('a zero-row transition is explained honestly: not_found / already_in_state / conflict', () => {
        const paidRow = { paid_at: new Date() };
        const unmarkedRow = { paid_at: null };
        expect(explainNoopPaymentTransition('mark_paid', null)).toBe('not_found');
        expect(explainNoopPaymentTransition('mark_unpaid', undefined)).toBe('not_found');
        expect(explainNoopPaymentTransition('mark_paid', paidRow)).toBe('already_in_state');
        expect(explainNoopPaymentTransition('mark_unpaid', unmarkedRow)).toBe('already_in_state');
        // Owned and active but NOT in the target state: a concurrent change.
        // Claiming success here would be a false statement about money.
        expect(explainNoopPaymentTransition('mark_paid', unmarkedRow)).toBe('conflict');
        expect(explainNoopPaymentTransition('mark_unpaid', paidRow)).toBe('conflict');
    });

    it('audit event types are stable and distinct', () => {
        expect(SUPPORTER_PAYMENT_EVENT_TYPES).toEqual({
            mark_paid: 'order_marked_paid',
            mark_unpaid: 'order_marked_unpaid',
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. WORDING — NULL is "Payment not marked", never "Unpaid"
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the wording decision', () => {
    it('an unmarked order reads "Payment not marked"; a marked one reads "Paid"', () => {
        expect(PAYMENT_NOT_MARKED_LABEL).toBe('Payment not marked');
        expect(PAYMENT_PAID_LABEL).toBe('Paid');
        expect(supporterPaymentState({ paid_at: null })).toBe('not_marked');
        expect(supporterPaymentState({})).toBe('not_marked');
        expect(supporterPaymentState(null)).toBe('not_marked');
        expect(supporterPaymentState({ paid_at: '2026-09-12T15:00:00Z' })).toBe('paid');
    });

    it('no coordinator payment surface renders the word "Unpaid"', () => {
        for (const f of [
            ['lib', 'supporterPayment.ts'],
            ['components', 'coordinator', 'RecentOrders.tsx'],
            ['app', 'coordinator', 'portal', 'pickup-tracker', 'page.tsx'],
        ]) {
            // Comments stripped: the explanation of the rule legitimately names it.
            expect(readCode(...f)).not.toMatch(/['"`>][^'"`<]*\bUnpaid\b/i);
        }
    });

    it('a supporter with several orders is paid only when EVERY order is', () => {
        expect(summarizeGroupPayment([{ paid_at: 'x' }, { paid_at: 'y' }])).toEqual({ state: 'paid', paidCount: 2, orderCount: 2 });
        expect(summarizeGroupPayment([{ paid_at: 'x' }, { paid_at: null }])).toEqual({ state: 'partly_marked', paidCount: 1, orderCount: 2 });
        expect(summarizeGroupPayment([{ paid_at: null }])).toEqual({ state: 'not_marked', paidCount: 0, orderCount: 1 });
        expect(summarizeGroupPayment([])).toEqual({ state: 'not_marked', paidCount: 0, orderCount: 0 });
        expect(summarizeGroupPayment(null)).toEqual({ state: 'not_marked', paidCount: 0, orderCount: 0 });
    });

    it('paid_at is an INSTANT: formatted in local time, NOT through the date-only formatter', () => {
        // 9:30 PM Central on Sep 12 is 02:30 UTC on Sep 13. A coordinator who
        // marks a payment at the end of pickup day must see "Sep 12".
        const lateEvening = '2026-09-13T02:30:00.000Z';
        expect(formatPaidDate(lateEvening, { timeZone: 'America/Chicago' })).toBe('Sep 12');
        expect(formatPaidDate(lateEvening, { timeZone: 'UTC' })).toBe('Sep 13');
        expect(formatPaidDate(null)).toBeNull();
        expect(formatPaidDate('not-a-date')).toBeNull();
        // And the module does not route it through lib/calendarDate.ts, which
        // reads UTC fields and would move that mark onto Sep 13.
        expect(readCode('lib', 'supporterPayment.ts')).not.toMatch(/calendarDate/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE REAL PATCH HANDLER
// ═════════════════════════════════════════════════════════════════════════════
describe('3. PATCH /api/coordinator — mark_paid / mark_unpaid, behaviourally', () => {
    const base = (overrides: Record<string, any> = {}) => createPrismaMock({
        results: {
            'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
            'fundraiserCampaignCoordinator.findUnique': assignment('Kristi Shirley'),
            ...overrides,
        },
    });

    it('unauthenticated -> 401, and the order is never touched', async () => {
        useMock(base());
        setAuthenticated(false);
        const { status } = await callPatch({ action: 'mark_paid', orderId: ORDER_1 });
        expect(status).toBe(401);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
        expect(mock.callsTo('coordinatorActionEvent.create')).toHaveLength(0);
    });

    it('cross-origin -> 401, and the order is never touched', async () => {
        useMock(base());
        const { status } = await callPatch({ action: 'mark_paid', orderId: ORDER_1 }, 'https://evil.example');
        expect(status).toBe(401);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('mark_paid writes ONLY paid_at/paid_by, scoped to the SESSION campaign, and logs one event', async () => {
        useMock(base());
        const before = Date.now();
        const { status, body } = await callPatch({ action: 'mark_paid', orderId: ORDER_1 });
        expect(status).toBe(200);
        expect(body).toMatchObject({ success: true, changed: true });
        expect(typeof body.paid_at).toBe('string');

        const updates = mock.callsTo('order.updateMany');
        expect(updates).toHaveLength(1);
        expect(updates[0].args.where).toEqual({
            id: ORDER_1, campaign_id: CAMPAIGN_A, source: 'fundraiser', canceled_at: null, paid_at: null,
        });
        expect(Object.keys(updates[0].args.data).sort()).toEqual(['paid_at', 'paid_by']);
        expect(updates[0].args.data.paid_by).toBe(`coordinator:${SESSION_ID}`);
        expect(updates[0].args.data.paid_at).toBeInstanceOf(Date);
        expect(updates[0].args.data.paid_at.getTime()).toBeGreaterThanOrEqual(before);

        const events = mock.callsTo('coordinatorActionEvent.create');
        expect(events).toHaveLength(1);
        expect(events[0].args.data).toMatchObject({
            campaign_id: CAMPAIGN_A,
            action_type: 'order_marked_paid',
            metadata: {
                actorType: 'coordinator',
                sessionId: SESSION_ID,
                channel: 'coordinator_portal',
                orderId: ORDER_1,
                assignedCoordinatorName: 'Kristi Shirley',
            },
        });
        // The update and its event are one transaction.
        expect(mock.client.$transaction).toHaveBeenCalledTimes(1);
    });

    it('a campaignId in the request body is IGNORED — the session decides', async () => {
        useMock(base());
        await callPatch({ action: 'mark_paid', orderId: ORDER_1, campaignId: CAMPAIGN_B, campaign_id: CAMPAIGN_B });
        const where = mock.firstCall('order.updateMany')!.args.where;
        expect(where.campaign_id).toBe(CAMPAIGN_A);
        expect(JSON.stringify(mock.calls)).not.toContain(CAMPAIGN_B);
    });

    it('an order in ANOTHER campaign -> 404, nothing written, no event', async () => {
        useMock(base({
            'order.updateMany': { count: 0 },
            // The ownership-scoped lookup finds nothing, exactly as for a
            // non-existent id — the response cannot confirm the order exists.
            'order.findFirst': null,
        }));
        const { status } = await callPatch({ action: 'mark_paid', orderId: 'someone-elses-order' });
        expect(status).toBe(404);
        expect(mock.callsTo('coordinatorActionEvent.create')).toHaveLength(0);
        const lookup = mock.firstCall('order.findFirst')!.args.where;
        expect(lookup.campaign_id).toBe(CAMPAIGN_A);
    });

    it('a repeat tap on an already-paid order -> 200 unchanged, the ORIGINAL timestamp stands, no second event', async () => {
        const original = new Date('2026-09-12T14:00:00Z');
        useMock(base({ 'order.updateMany': { count: 0 }, 'order.findFirst': { paid_at: original } }));
        const { status, body } = await callPatch({ action: 'mark_paid', orderId: ORDER_1 });
        expect(status).toBe(200);
        expect(body).toMatchObject({ success: true, changed: false });
        expect(new Date(body.paid_at).getTime()).toBe(original.getTime());
        expect(mock.callsTo('coordinatorActionEvent.create')).toHaveLength(0);
    });

    it('a concurrent change -> 409, never a false success', async () => {
        useMock(base({ 'order.updateMany': { count: 0 }, 'order.findFirst': { paid_at: null } }));
        const { status, body } = await callPatch({ action: 'mark_paid', orderId: ORDER_1 });
        expect(status).toBe(409);
        expect(body.error).toMatch(/Refresh/);
        expect(mock.callsTo('coordinatorActionEvent.create')).toHaveLength(0);
    });

    it('mark_unpaid clears both fields and logs its own event', async () => {
        useMock(base());
        const { status, body } = await callPatch({ action: 'mark_unpaid', orderId: ORDER_1 });
        expect(status).toBe(200);
        expect(body).toMatchObject({ success: true, changed: true, paid_at: null });
        const u = mock.firstCall('order.updateMany')!.args;
        expect(u.where).toEqual({
            id: ORDER_1, campaign_id: CAMPAIGN_A, source: 'fundraiser', canceled_at: null, NOT: { paid_at: null },
        });
        expect(u.data).toEqual({ paid_at: null, paid_by: null });
        const events = mock.callsTo('coordinatorActionEvent.create');
        expect(events).toHaveLength(1);
        expect(events[0].args.data.action_type).toBe('order_marked_unpaid');
        expect(events[0].args.data.metadata).not.toHaveProperty('paidAt');
    });

    it('a missing or blank orderId -> 400, nothing written', async () => {
        for (const orderId of [undefined, '', '   ', 42, null]) {
            useMock(base());
            const { status } = await callPatch({ action: 'mark_paid', orderId });
            expect(status).toBe(400);
            expect(mock.callsTo('order.updateMany')).toHaveLength(0);
        }
    });

    it('a CLOSED campaign still allows marking — pickup happens after closeout', async () => {
        useMock(base({
            'fundraiserCampaign.findFirst': { id: CAMPAIGN_A, closed_at: new Date('2026-10-08T00:00:00Z'), status: 'Closed' },
        }));
        const { status, body } = await callPatch({ action: 'mark_paid', orderId: ORDER_1 });
        expect(status).toBe(200);
        expect(body.changed).toBe(true);
        // The payment path never consults the campaign's closed state at all.
        expect(mock.callsTo('fundraiserCampaign.findFirst')).toHaveLength(0);
    });

    it('a failed coordinator-context lookup never blocks the mark', async () => {
        useMock(base({
            'fundraiserCampaignCoordinator.findUnique': () => { throw new Error('lookup exploded'); },
        }));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const { status } = await callPatch({ action: 'mark_paid', orderId: ORDER_1 });
        spy.mockRestore();
        expect(status).toBe(200);
        expect(mock.callsTo('coordinatorActionEvent.create')[0].args.data.metadata.assignedCoordinatorName).toBeNull();
    });

    it('the payment path never writes to an invoice, the campaign, or any other order field', async () => {
        useMock(base());
        await callPatch({ action: 'mark_paid', orderId: ORDER_1 });
        await callPatch({ action: 'mark_unpaid', orderId: ORDER_1 });
        const writes = mock.calls.filter((c) => /^(create|update|updateMany|upsert|delete|deleteMany|createMany)$/.test(c.method));
        const touched = [...new Set(writes.map((c) => c.model))].sort();
        expect(touched).toEqual(['coordinatorActionEvent', 'order']);
        for (const w of mock.callsTo('order.updateMany')) {
            for (const k of FORBIDDEN_WRITE_KEYS) expect(w.args.data).not.toHaveProperty(k);
        }
    });

    it('REGRESSION: restore is unchanged, and STILL blocked on a closed campaign', async () => {
        useMock(base({
            'fundraiserCampaign.findFirst': { id: CAMPAIGN_A, closed_at: new Date(), status: 'Closed' },
        }));
        const { status } = await callPatch({ action: 'restore', orderId: ORDER_1 });
        expect(status).toBe(400);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('REGRESSION: an unknown action is still rejected', async () => {
        useMock(base());
        const { status } = await callPatch({ action: 'mark_refunded', orderId: ORDER_1 });
        expect(status).toBe(400);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PROJECTION — paid_at reaches coordinator surfaces, paid_by never does
// ═════════════════════════════════════════════════════════════════════════════
describe('4. the shared supporter-order projection', () => {
    const row = (id: string, customerId: string, paidAt: string | null) => ({
        id, customer_id: customerId, customer_name: 'Jennifer Hampton', total_amount: 120, tax_amount: 1.2,
        paid_at: paidAt, paid_by: 'coordinator:secret-session', created_at: '2026-09-11T21:42:25Z',
        source: 'fundraiser', status: 'fundraiser_hold', items: [{ quantity: 1, item_name: 'Keto', variant_size: 'serves_2' }],
    });

    it('selects paid_at and NOT paid_by', () => {
        expect((SUPPORTER_ORDER_SELECT as any).paid_at).toBe(true);
        expect(SUPPORTER_ORDER_SELECT).not.toHaveProperty('paid_by');
    });

    it('projects paid_at, and never passes paid_by to a client even if a row carries it', () => {
        const dto = toSupporterOrder(row('o1', 'cust-1', '2026-09-12T15:00:00Z') as any, 'org-1');
        expect(dto.paid_at).toBe('2026-09-12T15:00:00Z');
        expect(dto).not.toHaveProperty('paid_by');
        expect(JSON.stringify(dto)).not.toContain('secret-session');
        // The amount due is still the tax-inclusive collection figure.
        expect(dto.amount_due).toBe(121.2);
    });

    it('an unmarked order projects paid_at: null', () => {
        expect(toSupporterOrder(row('o1', 'cust-1', null) as any, 'org-1').paid_at).toBeNull();
    });

    it('groups summarize payment across a supporter\'s orders', () => {
        const groups = groupSupporterRows([
            row('o1', 'cust-1', '2026-09-12T15:00:00Z'),
            row('o2', 'cust-1', null),
            row('o3', 'cust-2', '2026-09-12T15:00:00Z'),
        ] as any, 'org-1');
        const byKey = Object.fromEntries(groups.map((g) => [g.key, g.payment]));
        expect(byKey['customer:cust-1']).toEqual({ state: 'partly_marked', paidCount: 1, orderCount: 2 });
        expect(byKey['customer:cust-2']).toEqual({ state: 'paid', paidCount: 1, orderCount: 1 });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. INDEPENDENCE — tax, sales, closeout, org share and invoices are untouched
// ═════════════════════════════════════════════════════════════════════════════
describe('5. supporter payment stays operational metadata', () => {
    it('closeout and its math read no payment field', () => {
        for (const f of [
            ['app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts'],
            ['lib', 'fundraiserCloseoutMath.ts'],
            ['lib', 'fundraiserTax.ts'],
        ]) {
            expect(readCode(...f)).not.toMatch(/paid_at|paid_by|supporterPayment/);
        }
        // Its own documented inclusion rule is still in place.
        expect(read('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts'))
            .toMatch(/Payment status is deliberately NOT a filter/);
    });

    it('closeout financials are identical whether supporters are marked paid or not', () => {
        const input = { grossSales: 1000, orgSharePercent: 20, applyFoodTax: true, taxCollected: 10, taxRatePercent: 1 };
        // The math takes no payment input at all — so paid state cannot move it.
        const f = computeCloseoutFinancials(input);
        expect(f.organizationAmount).toBe(200);
        expect(f.totalDue).toBe(810);
        expect(computeCloseoutFinancials({ ...input, ...( { paid_at: new Date() } as any) })).toEqual(f);
    });

    it('the organization-invoice routes never read or write Order.paid_at', () => {
        for (const f of [
            ['app', 'api', 'tenant', 'invoices', '[id]', 'settle', 'route.ts'],
            ['app', 'api', 'tenant', 'invoices', 'route.ts'],
            ['app', 'api', 'tenant', 'invoices', '[id]', 'send', 'route.ts'],
        ]) {
            const code = readCode(...f);
            // Invoice.paid_at legitimately exists; ORDER writes must not carry it.
            expect(code).not.toMatch(/order\.(update|updateMany)\([\s\S]{0,300}paid_at/);
            expect(code).not.toMatch(/supporterPayment|mark_paid|order_marked_paid/);
        }
    });

    it('supporters cannot mark themselves paid — the public order route never writes it', () => {
        const code = readCode('app', 'api', 'public', 'order', 'route.ts');
        expect(code).not.toMatch(/paid_at|paid_by|mark_paid/);
    });

    it('exactly ONE route writes supporter payment state', () => {
        const { execSync } = require('child_process');
        // `:(glob)` is required. Without it git pathspecs use fnmatch, where
        // "lib/**/*.ts" demands a subdirectory and silently skips every file
        // directly under lib/ — which is exactly where this rule lives. A census
        // that cannot see lib/supporterPayment.ts is not a census.
        const out = execSync(
            'git grep -l --untracked -E "paymentTransitionData|paid_by:" -- ":(glob)app/**/*.ts" ":(glob)app/**/*.tsx" ":(glob)lib/**/*.ts" || true',
            { cwd: process.cwd(), encoding: 'utf8' },
        ) as string;
        const files = out.split('\n').filter(Boolean).sort();
        expect(files).toEqual(['app/api/coordinator/route.ts', 'lib/supporterPayment.ts']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE COORDINATOR SURFACES
// ═════════════════════════════════════════════════════════════════════════════
describe('6. Recent Orders and the pickup tracker', () => {
    const recent = readCode('components', 'coordinator', 'RecentOrders.tsx');
    const portal = readCode('app', 'coordinator', 'portal', 'page.tsx');
    const pickup = readCode('app', 'coordinator', 'portal', 'pickup-tracker', 'page.tsx');

    it('Recent Orders shows the recorded state using the shared labels', () => {
        expect(recent).toMatch(/PAYMENT_NOT_MARKED_LABEL/);
        expect(recent).toMatch(/PAYMENT_PAID_LABEL/);
        expect(recent).toMatch(/formatPaidDate\(o\.paid_at\)/);
        expect(recent).toMatch(/'Mark paid'/);
    });

    it('reversal takes a second tap, inline — no modal', () => {
        expect(recent).toMatch(/'Tap again to undo'/);
        expect(recent).toMatch(/'Undo paid'/);
        expect(recent).toMatch(/setConfirmUndoId\(o\.id\)/);
        expect(recent).not.toMatch(/window\.confirm|confirm\(/);
    });

    it('payment actions are NOT hidden on a closed campaign (unlike cancel)', () => {
        // The cancel button is still gated...
        expect(recent).toMatch(/\{!isClosed && \(\s*<button onClick=\{\(\) => onCancel\(o\.id\)\}/);
        // ...and the payment buttons are gated only on their handlers.
        expect(recent).toMatch(/\{!paid && onMarkPaid && \(/);
        expect(recent).toMatch(/\{paid && onMarkUnpaid && \(/);
        expect(recent).not.toMatch(/isClosed[^\n]*onMarkPaid|onMarkPaid[^\n]*isClosed/);
    });

    it('the portal wires the handler into all three Recent Orders mounts', () => {
        expect((portal.match(/onMarkPaid=\{\(id\) => handleSupporterPayment\(id, 'mark_paid'\)\}/g) || [])).toHaveLength(3);
        expect((portal.match(/onMarkUnpaid=\{\(id\) => handleSupporterPayment\(id, 'mark_unpaid'\)\}/g) || [])).toHaveLength(3);
        expect(portal).toMatch(/body: JSON\.stringify\(\{ action, orderId \}\)/);
        // The client sends no campaign id — the session decides.
        const handler = portal.slice(portal.indexOf('const handleSupporterPayment'), portal.indexOf('const fetchCampaign'));
        expect(handler).not.toMatch(/campaignId|campaign_id/);
    });

    it('the pickup tracker prints the recorded state, with a hand-tickable box when unmarked', () => {
        expect(pickup).toMatch(/g\.payment\?\.state === 'paid'/);
        expect(pickup).toMatch(/g\.payment\?\.state === 'partly_marked'/);
        expect(pickup).toMatch(/Paid \{g\.payment\.paidCount\} of \{g\.payment\.orderCount\}/);
        expect(pickup).toMatch(/data-payment-state="not_marked"/);
        expect(read('app', 'coordinator', 'portal', 'pickup-tracker', 'page.tsx'))
            .toMatch(/An empty box\s+means payment has not been marked yet/);
    });

    it('the pickup tracker is read-only for payment — marking happens in the order list', () => {
        expect(pickup).not.toMatch(/mark_paid|mark_unpaid|method: 'PATCH'/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. SCHEMA, MIGRATION AND THE XLSX
// ═════════════════════════════════════════════════════════════════════════════
describe('7. schema, migration and printable XLSX', () => {
    const MIGRATION = ['prisma', 'migrations', '20260912000000_fr_supporter_payment_status_1_order_paid', 'migration.sql'];

    it('the schema adds two nullable columns with NO default', () => {
        const order = read('prisma', 'schema.prisma').match(/model Order \{[\s\S]*?\n\}/)![0];
        expect(order).toMatch(/\n\s+paid_at\s+DateTime\?\s*\n/);
        expect(order).toMatch(/\n\s+paid_by\s+String\?\s*\n/);
        expect(order).not.toMatch(/paid_at[^\n]*@default|paid_by[^\n]*@default/);
    });

    it('the migration is additive only — no default, no backfill, no other table', () => {
        const sql = strip(read(...MIGRATION)).replace(/^\s*--.*$/gm, '').trim();
        const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
        expect(statements).toEqual([
            'ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3)',
            'ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paid_by" TEXT',
        ]);
        // No existing order may be silently marked paid.
        expect(sql).not.toMatch(/\bUPDATE\b|\bDEFAULT\b|\bINSERT\b/i);
    });

    it('the printable XLSX is a blank form with no order rows — its paper Paid column already serves it', async () => {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path.join(process.cwd(), 'templates', 'tracking_sheet.xlsx'));
        const ws = wb.worksheets[0];
        expect(ws.getCell('J9').value).toBe('Paid (Y/N)');
        expect(ws.getCell('L9').value).toBe('Paid Date');
        // The populator writes campaign-level cells only — never an order row,
        // so there is no per-order payment to put on it. Asserted on what it can
        // RECEIVE and READ, not on the word "orders" (cell B4's instruction copy,
        // "All orders and money must be submitted…", legitimately contains it).
        const code = readCode('lib', 'coordinatorOrderTracker.ts');
        const sig = code.match(/export function populateTrackerWorksheet\(([\s\S]*?)\):/)![1];
        expect(sig).not.toMatch(/order/i);
        expect(code).not.toMatch(/paid_at|paid_by|\border\.[a-z_]+|\borders\.(map|forEach|length|filter)|prisma/);
    });
});
