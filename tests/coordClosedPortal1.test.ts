/**
 * COORD-CLOSED-PORTAL-1 — the coordinator portal stays open after closeout.
 *
 * THE DEFECT: the portal always mounted BundleSelectionStep and hid everything else behind its
 * `bundleSelectionDone` latch. That step calls GET /api/coordinator/bundle-selection, which
 * answers 410 for any closed campaign, so after the first real closeout (Edgar County Farm
 * Bureau) the coordinator saw only "Unable to load bundle options" and the read-only Complete
 * phase could never render.
 *
 * THE RULE NOW: closeout, invoicing, payment and delivery all keep the portal available. A closed
 * campaign skips bundle selection and opens on the Complete phase; every closed-state mutation
 * guard (add, cancel, restore, bundle selection) still holds, on the client and the server.
 *
 * Route tests run the REAL handlers against the shared recording Prisma double with a mocked
 * coordinator session cookie. Component tests render the real components to static markup.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { coordinatorPortalGate, isPortalCampaignClosed } from '@/lib/coordinatorPortalGate';
import { invoiceStatusesAfterCloseout } from '@/lib/growth/campaignLifecycle';
import { triageCampaign } from '@/lib/growth/nextAction';
import { ActionBar } from '@/components/coordinator/ActionBar';
import { RecentOrders } from '@/components/coordinator/RecentOrders';
import { WhatsNext } from '@/components/coordinator/WhatsNext';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const PORTAL = 'app/coordinator/portal/page.tsx';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ccp1Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ccp1Prisma = m.client; };

jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => ((global as any).__ccp1Authed && name === coordinatorSessionCookieNameForMock()
            ? { name, value: 'ccp1-session-secret' } : undefined),
        set: () => undefined,
        delete: () => undefined,
    }),
}));
const coordinatorSessionCookieNameForMock = () => (global as any).__ccp1CookieName as string;

const BUSINESS = 'biz-ccp1';
const CLOSED = 'camp-ccp1-closed';
const ORG = 'org-ccp1';

const sessionFor = (campaignId: string) => ({
    id: 'session-ccp1', campaign_id: campaignId, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
});

/** A campaign closed out exactly the way Edgar was: Closed, closed_at set, selection done. */
const closedCampaign = (over: Record<string, unknown> = {}) => ({
    id: CLOSED, name: 'Edgar-like Fundraiser', status: 'Closed', closed_at: new Date('2026-10-01T00:24:45Z'),
    settlement_total: '5755.00', end_date: new Date('2026-09-30T00:00:00Z'), delivery_date: new Date('2026-10-17T00:00:00Z'),
    delivery_time: '4:00 PM', pickup_location: 'Farm Bureau office', checks_payable: 'Edgar CFB', payment_instructions: 'Pay your coordinator',
    external_payment_link: null, bundle_goal: 50, total_sales: '5755.00', org_share_percent: '20.00', participant_label: 'Seller',
    bundle_selection_status: 'selected', bundle_selection_at: new Date('2026-09-10T12:00:00Z'), bundle_selection_limit: 2,
    public_token: 'public-ccp1', customer_id: ORG, tax_status: null, tax_rate_percent: null,
    customer: {
        name: 'Edgar County Farm Bureau', contact_name: 'Pat Coordinator', contact_email: 'pat@example.invalid', business_id: BUSINESS,
        business: { name: 'Freezer Chef', display_name: 'Freezer Chef', slug: 'freezer-chef', custom_domain: null, logo_url: null, plan: 'PRO', subscription_status: 'active', timezone: 'America/Chicago' },
    },
    orders: [],
    ...over,
});

/** A supporter's own order (linked to a per-supporter customer), held or released. */
const supporterOrder = (id: string, customerId: string, opts: { status?: string; paid?: boolean; bundleId?: string; bundleName?: string; qty?: number } = {}) => ({
    id, customer_name: `Supporter ${customerId}`, participant_name: null, total_amount: '125.00', tax_amount: '0',
    paid_at: opts.paid ? new Date('2026-09-28T15:00:00Z') : null, created_at: new Date('2026-09-20T15:00:00Z'), canceled_at: null,
    source: 'fundraiser', status: opts.status ?? 'fundraiser_hold', phone: '217-555-0100', email: null,
    customer_id: customerId, customer: { contact_email: `${customerId}@example.invalid` },
    items: [{
        quantity: opts.qty ?? 1, variant_size: 'serves_5', item_name: opts.bundleName ?? 'Keto Fall 2026 (Serves 5)',
        bundle_id: opts.bundleId ?? 'bundle-keto-5', bundle: { id: opts.bundleId ?? 'bundle-keto-5', name: opts.bundleName ?? 'Keto Fall 2026 (Serves 5)' },
    }],
});

const route = (path: string) => require(path);
const request = (url: string, init: RequestInit = {}) =>
    new Request(`http://localhost${url}`, { ...init, headers: { origin: 'http://localhost', 'content-type': 'application/json', ...(init.headers || {}) } });

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(() => {
    jest.clearAllMocks();
    (global as any).__ccp1CookieName = coordinatorSessionCookieName();
    (global as any).__ccp1Authed = true;
});

// ═════════════════════════════════════════════════════════════════════════════
// 1–6. The gate: bundle selection is setup for a LIVE campaign only.
// ═════════════════════════════════════════════════════════════════════════════
describe('1–6. the portal gate', () => {
    it('1. an Active campaign still pending selection still requires setup', () => {
        const pending = { status: 'Active', closed_at: null, bundle_selection_status: 'pending', orderMode: { allowed: false, reasonCode: 'pending' } };
        expect(coordinatorPortalGate(pending, false)).toEqual({ isClosed: false, showBundleSelection: true, contentReady: false });
    });

    it('2. an Active selected campaign works exactly as before: content waits for the confirmed selection', () => {
        const live = { status: 'Active', closed_at: null, bundle_selection_status: 'selected', orderMode: { allowed: true, mode: 'selected' } };
        expect(coordinatorPortalGate(live, false)).toEqual({ isClosed: false, showBundleSelection: true, contentReady: false });
        expect(coordinatorPortalGate(live, true)).toEqual({ isClosed: false, showBundleSelection: true, contentReady: true });
    });

    it('3. a closed selected campaign opens the portal without waiting for bundle selection', () => {
        const closed = { status: 'Closed', closed_at: '2026-10-01T00:24:45Z', bundle_selection_status: 'selected', orderMode: { allowed: false, reasonCode: 'closed' } };
        expect(coordinatorPortalGate(closed, false)).toEqual({ isClosed: true, showBundleSelection: false, contentReady: true });
    });

    it('4. a closed legacy (not_required) campaign opens the portal too', () => {
        expect(coordinatorPortalGate({ status: 'Closed', closed_at: null, bundle_selection_status: 'not_required' }, false))
            .toEqual({ isClosed: true, showBundleSelection: false, contentReady: true });
    });

    it('the server\'s own verdict counts: any campaign the selection API refuses as closed (Archived, Completed) never shows the step', () => {
        for (const status of ['Archived', 'Completed', 'Settled']) {
            expect(isPortalCampaignClosed({ status, closed_at: null, orderMode: { reasonCode: 'closed' } })).toBe(true);
        }
        // A supporter-side deadline is not a closeout; only the shared closed rule is.
        expect(isPortalCampaignClosed({ status: 'Active', closed_at: null, orderMode: { reasonCode: 'deadline_passed' } })).toBe(false);
        expect(isPortalCampaignClosed({ status: 'Active', closed_at: null, orderMode: null })).toBe(false);
        expect(isPortalCampaignClosed(null)).toBe(false);
    });

    describe('5–6. the portal page uses the gate', () => {
        const src = read(PORTAL);

        it('5. the selection step renders only behind the gate, never unconditionally', () => {
            expect(src).toContain("import { coordinatorPortalGate } from '@/lib/coordinatorPortalGate';");
            expect(src).toMatch(/\{showBundleSelection && \(\s*<BundleSelectionStep/);
            expect(src.match(/<BundleSelectionStep\b/g)).toHaveLength(1);
        });

        it('6. phase content and the action bar wait on portalContentReady, and a closed campaign is the Complete phase', () => {
            expect(src).toContain('} = coordinatorPortalGate(campaign, bundleSelectionDone);');
            expect(src).toContain('{portalContentReady && (<>');
            expect(src).toMatch(/\{portalContentReady && \(\s*<ActionBar/);
            expect(src).not.toMatch(/\{bundleSelectionDone && \(/);
            expect(src).toContain("if (isClosed) return 'complete';");
            // The Complete phase still carries everything the coordinator needs after closeout.
            const complete = src.slice(src.indexOf("{campaignPhase === 'complete' && (<>"), src.indexOf('</main>'));
            for (const piece of ['<ProgressHero', '<WhatsNext', 'Delivery kit', '🖨️ Print pickup tracker', '📦 Pickup spreadsheet', '<RecentOrders', 'isClosed={isClosed}']) {
                expect(complete).toContain(piece);
            }
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7–10. Every closed-state mutation guard still holds.
// ═════════════════════════════════════════════════════════════════════════════
describe('7–10. closed-state guards', () => {
    const src = read(PORTAL);
    const portalMock = (campaign: Record<string, unknown>) => createPrismaMock({
        results: {
            'coordinatorSession.findUnique': sessionFor(String(campaign.id)),
            'fundraiserCampaign.findFirst': campaign,
            'order.findMany': [],
            'bundle.findMany': [],
        },
    });

    it('7. Add Order: the Complete-phase action bar offers none, and the server refuses one', async () => {
        const html = renderToStaticMarkup(createElement(ActionBar, {
            phase: 'complete', onAddOrder: () => {}, onShare: () => {}, tenantName: 'Freezer Chef', orderingAllowed: false,
        }));
        expect(html).not.toContain('Add Order');
        expect(html).toContain('Campaign closed');
        expect(src).toContain('{showOrderModal && !isClosed && bundleSelectionDone && (');

        useMock(portalMock(closedCampaign()));
        const res = await readJson(await route('@/app/api/coordinator/route').POST(request('/api/coordinator', {
            method: 'POST', body: JSON.stringify({ customerName: 'Late Order', items: [{ id: 'bundle-keto-5', quantity: 1 }] }),
        })));
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Campaign is closed/);
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });

    it('8. Cancel: a closed order list shows no cancel control, and the server refuses a cancel', async () => {
        const html = renderToStaticMarkup(createElement(RecentOrders, {
            orders: [supporterOrder('o-1', 'cust-1') as any], onCancel: () => {}, isClosed: true, limit: 5,
        }));
        expect(html).not.toContain('aria-label="Cancel order"');
        expect(src).toContain('{cancelOrderId && !isClosed && (');

        useMock(portalMock(closedCampaign()));
        const res = await readJson(await route('@/app/api/coordinator/route').DELETE(request('/api/coordinator', {
            method: 'DELETE', body: JSON.stringify({ orderId: 'o-1' }),
        })));
        expect(res.status).toBe(400);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('9. Restore: no UI path opens it, its modal is closed-guarded, and the server refuses it', async () => {
        expect(src.match(/setRestoreOrderId\(([^)]*)\)/g)!.every((call) => call === 'setRestoreOrderId(null)')).toBe(true);
        expect(src).toContain('{restoreOrderId && !isClosed && (');

        useMock(portalMock(closedCampaign()));
        const res = await readJson(await route('@/app/api/coordinator/route').PATCH(request('/api/coordinator', {
            method: 'PATCH', body: JSON.stringify({ action: 'restore', orderId: 'o-1' }),
        })));
        expect(res.status).toBe(400);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('10. bundle selection still refuses a closed campaign (410), reading and writing', async () => {
        useMock(portalMock(closedCampaign()));
        const selection = route('@/app/api/coordinator/bundle-selection/route');
        const post = await readJson(await selection.POST(request('/api/coordinator/bundle-selection', {
            method: 'POST', body: JSON.stringify({ familyIds: ['fam-1'] }),
        })));
        expect(post.status).toBe(410);
        const get = await readJson(await selection.GET(request('/api/coordinator/bundle-selection')));
        expect(get.status).toBe(410);
        expect(mock.callsTo('campaignBundle.updateMany')).toHaveLength(0);
        expect(mock.callsTo('campaignBundle.createMany')).toHaveLength(0);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('the portal GET itself still loads a closed campaign, reporting ordering as closed', async () => {
        useMock(portalMock(closedCampaign()));
        const res = await readJson(await route('@/app/api/coordinator/route').GET(request('/api/coordinator')));
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Edgar-like Fundraiser');
        expect(res.body.orderMode).toMatchObject({ allowed: false, mode: 'closed', reasonCode: 'closed' });
        expect(res.body.availableBundles).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11–15. Delivery documents after closeout, held and released.
// ═════════════════════════════════════════════════════════════════════════════
describe('11–15. delivery documents', () => {
    const docMock = (orders: any[], campaign = closedCampaign()) => createPrismaMock({
        results: {
            'coordinatorSession.findUnique': sessionFor(String(campaign.id)),
            'fundraiserCampaign.findFirst': campaign,
            'order.findMany': orders,
            'bundle.findMany': [],
        },
    });

    const pickupTracker = async () => readJson(await route('@/app/api/coordinator/pickup-tracker/route').GET(request('/api/coordinator/pickup-tracker')));

    async function pickupSheet() {
        const res: Response = await route('@/app/api/tracker/pickup-sheet/route').GET(request('/api/tracker/pickup-sheet'));
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        if (res.status === 200) await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
        const ws = wb.worksheets[0];
        const rowValues = (n: number) => (ws ? (ws.getRow(n).values as any[]).slice(1) : []);
        return { status: res.status, type: res.headers.get('content-type'), header: rowValues(4), rowValues, rowCount: ws?.rowCount ?? 0 };
    }

    it('11. the printable pickup tracker opens for a closed campaign', async () => {
        useMock(docMock([]));
        const res = await pickupTracker();
        expect(res.status).toBe(200);
        expect(res.body.campaign.name).toBe('Edgar-like Fundraiser');
    });

    it('12. the pickup spreadsheet opens for a closed campaign', async () => {
        useMock(docMock([]));
        const sheet = await pickupSheet();
        expect(sheet.status).toBe(200);
        expect(sheet.type).toContain('spreadsheetml');
    });

    // COORD-CLOSEOUT-PICKUP-1 (owner ruling, October 1, 2026) SUPERSEDED the rule this test used to
    // lock ("while the invoice is unpaid, held orders appear on neither document"). Closeout now
    // populates the pickup documents; invoice payment still releases production. The full matrix
    // lives in tests/coordCloseoutPickup1.test.ts.
    it('13. while the invoice is unpaid, a closed campaign\'s held orders appear on BOTH documents — and stay held', async () => {
        const held = [supporterOrder('o-1', 'cust-1'), supporterOrder('o-2', 'cust-2', { paid: true })];
        useMock(docMock(held));
        const tracker = await pickupTracker();
        expect(tracker.body.supporterCount).toBe(2);
        expect(tracker.body.document).toEqual({ final: true, state: 'final_pending_release' });
        const trackerWhere = mock.firstCall('order.findMany')!.args.where;
        expect(trackerWhere).toEqual({ campaign_id: CLOSED, canceled_at: null });
        expect(mock.calls.every((c) => /^(find|count|aggregate|groupBy)/.test(c.method) && !String(c.model).startsWith('$execute'))).toBe(true);

        useMock(docMock(held));
        const sheet = await pickupSheet();
        expect(mock.firstCall('order.findMany')!.args.where).toEqual({ campaign_id: CLOSED, canceled_at: null });
        expect(sheet.rowValues(5).slice(0, 2)).toEqual([1, 'Supporter cust-1']);
        expect(sheet.rowValues(6).slice(0, 2)).toEqual([2, 'Supporter cust-2']);
        expect(mock.calls.every((c) => /^(find|count|aggregate|groupBy)/.test(c.method) && !String(c.model).startsWith('$execute'))).toBe(true);
        // The old empty-list copy is gone: it named invoice payment as what fills the list.
        expect(read('app/coordinator/portal/pickup-tracker/page.tsx')).not.toContain('No released orders yet.');
    });

    it('14. once the invoice is paid and orders are released, both documents list them', async () => {
        const released = [
            supporterOrder('o-1', 'cust-1', { status: 'pending', qty: 2 }),
            supporterOrder('o-2', 'cust-2', { status: 'pending', bundleId: 'bundle-keto-2', bundleName: 'Keto Fall 2026 (Serves 2)' }),
        ];
        useMock(docMock(released));
        const tracker = await pickupTracker();
        expect(tracker.body.supporterCount).toBe(2);
        expect(tracker.body.totalBundles).toBe(3);

        useMock(docMock(released));
        const sheet = await pickupSheet();
        expect(sheet.status).toBe(200);
        // Closed campaigns are not orderable, so these columns come from the released orders themselves.
        // COORD-CLOSEOUT-PICKUP-1 appended Amount Due and Payment; every earlier column is unchanged.
        expect(sheet.header).toEqual(['#', 'Customer', 'Phone', 'Keto Fall 2026\n(Serves 2)', 'Keto Fall 2026\n(Serves 5)', 'Total\nBundles', 'Amount\nDue', 'Payment']);
        expect(sheet.rowValues(5)).toEqual([1, 'Supporter cust-1', '217-555-0100', '', 2, 2, 125, 'Payment not marked']);
        expect(sheet.rowValues(6)).toEqual([2, 'Supporter cust-2', '217-555-0100', 1, '', 1, 125, 'Payment not marked']);
        expect(sheet.rowValues(7)).toEqual(['', 'TOTALS', '', 1, 2, 3, 250, '0 of 2 marked paid']);
    });

    it('14b. an open legacy campaign\'s sheet keeps its catalog columns exactly as before', async () => {
        const live = closedCampaign({ id: 'camp-ccp1-live', status: 'Active', closed_at: null, bundle_selection_status: 'not_required' });
        const m = createPrismaMock({
            results: {
                'coordinatorSession.findUnique': sessionFor('camp-ccp1-live'),
                'fundraiserCampaign.findFirst': live,
                'order.findMany': [supporterOrder('o-1', 'cust-1', { status: 'pending' })],
                'bundle.findMany': [{ id: 'bundle-keto-5', name: 'Keto Fall 2026 (Serves 5)' }, { id: 'bundle-other', name: 'Comfort Classics (Serves 5)' }],
            },
        });
        useMock(m);
        const sheet = await pickupSheet();
        expect(sheet.header).toEqual(['#', 'Customer', 'Phone', 'Keto Fall 2026\n(Serves 5)', 'Comfort Classics\n(Serves 5)', 'Total\nBundles', 'Amount\nDue', 'Payment']);
        expect(sheet.rowValues(5)).toEqual([1, 'Supporter cust-1', '217-555-0100', 1, '', 1, 125, 'Payment not marked']);
    });

    it('15. supporter payment marks: Paid, partly marked and not marked stay correct, and marking still works after closeout', async () => {
        const released = [
            supporterOrder('o-1', 'cust-1', { status: 'pending', paid: true }),
            supporterOrder('o-2', 'cust-1', { status: 'pending', paid: true }),
            supporterOrder('o-3', 'cust-2', { status: 'pending', paid: true }),
            supporterOrder('o-4', 'cust-2', { status: 'pending' }),
            supporterOrder('o-5', 'cust-3', { status: 'pending' }),
        ];
        useMock(docMock(released));
        const tracker = await pickupTracker();
        const states = Object.fromEntries(tracker.body.groups.map((g: any) => [g.customer_name, g.payment]));
        expect(states['Supporter cust-1']).toEqual({ state: 'paid', paidCount: 2, orderCount: 2 });
        expect(states['Supporter cust-2']).toEqual({ state: 'partly_marked', paidCount: 1, orderCount: 2 });
        expect(states['Supporter cust-3']).toEqual({ state: 'not_marked', paidCount: 0, orderCount: 1 });

        // Supporters pay at pickup, after closeout: the coordinator's mark is deliberately not closed-gated.
        const m = createPrismaMock({
            results: {
                'coordinatorSession.findUnique': sessionFor(CLOSED),
                'fundraiserCampaign.findFirst': closedCampaign(),
                'order.updateMany': { count: 1 },
            },
        });
        useMock(m);
        const res = await readJson(await route('@/app/api/coordinator/route').PATCH(request('/api/coordinator', {
            method: 'PATCH', body: JSON.stringify({ action: 'mark_paid', orderId: 'o-5' }),
        })));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, changed: true });
        expect(Object.keys(mock.firstCall('order.updateMany')!.args.data).sort()).toEqual(['paid_at', 'paid_by']);
        // The closed order list keeps the mark buttons — only cancel is hidden.
        const html = renderToStaticMarkup(createElement(RecentOrders, {
            orders: [supporterOrder('o-5', 'cust-3') as any], onCancel: () => {}, onMarkPaid: () => {}, isClosed: true,
        }));
        expect(html).toMatch(/Mark paid|Mark as paid/i);
    });

    it('order tracker: a blank order-taking sheet the API refuses after closeout, so the Complete phase offers it only while ordering is open', async () => {
        useMock(docMock([]));
        const res = await readJson(await route('@/app/api/tracker/download/route').GET(request('/api/tracker/download')));
        expect(res.status).toBe(422);
        const src = read(PORTAL);
        const kit = src.slice(src.indexOf('Delivery kit'), src.indexOf('Ordering is closed — use the order list below'));
        expect(kit).toMatch(/\{campaign\.orderMode\?\.allowed === true && \(\s*<button onClick=\{handleDownloadTracker\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16. Session isolation.
// ═════════════════════════════════════════════════════════════════════════════
describe('16. tenant / campaign session isolation', () => {
    it('every document and the portal read only the session\'s own campaign', async () => {
        for (const path of ['@/app/api/coordinator/pickup-tracker/route', '@/app/api/tracker/pickup-sheet/route', '@/app/api/coordinator/route']) {
            useMock(createPrismaMock({
                results: {
                    'coordinatorSession.findUnique': sessionFor('camp-session-own'),
                    'fundraiserCampaign.findFirst': closedCampaign({ id: 'camp-session-own' }),
                    'order.findMany': [],
                    'bundle.findMany': [],
                },
            }));
            const res: Response = await route(path).GET(request('/api/x?campaignId=camp-someone-else'));
            expect(res.status).toBe(200);
            expect(mock.firstCall('fundraiserCampaign.findFirst')!.args.where).toEqual({ id: 'camp-session-own' });
            for (const c of mock.callsTo('order.findMany')) expect(c.args.where.campaign_id).toBe('camp-session-own');
        }
    });

    it('without a session, nothing is read', async () => {
        (global as any).__ccp1Authed = false;
        for (const path of ['@/app/api/coordinator/pickup-tracker/route', '@/app/api/tracker/pickup-sheet/route', '@/app/api/coordinator/route', '@/app/api/coordinator/bundle-selection/route']) {
            useMock(createPrismaMock());
            const res: Response = await route(path).GET(request('/api/x'));
            expect(res.status).toBe(401);
            expect(mock.callsTo('fundraiserCampaign.findFirst')).toHaveLength(0);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Part D. The closed copy is true under OPS-3: closeout holds orders until the invoice is paid.
// ═════════════════════════════════════════════════════════════════════════════
describe('Part D. closed-state copy', () => {
    it('the portal banner no longer says orders went to the kitchen, and does not make the coordinator the payer', () => {
        const src = read(PORTAL);
        // Rendered text only: the comment beside it quotes the old wording on purpose.
        const banner = src.slice(src.indexOf('🔒 Campaign Closed'), src.indexOf('Final campaign total:')).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
        expect(banner).not.toContain('sent to the kitchen');
        expect(banner).toContain('Ordering is closed. Orders are released for production once the fundraiser&apos;s invoice');
        expect(banner).toContain('has been paid.');
        expect(banner).not.toMatch(/your invoice|you owe|you pay/i);
    });

    it('"What happens next" says the same thing', () => {
        const html = renderToStaticMarkup(createElement(WhatsNext, { tenantName: 'Freezer Chef', isClosed: true, settlementTotal: 5755 }));
        expect(html).not.toContain('sent to the kitchen');
        expect(html).toContain('released for production once the fundraiser&#x27;s invoice has been paid');
        expect(html).toContain('Final campaign total: $5,755.00');
        expect(html).not.toMatch(/your invoice|you owe|you pay/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Part H. The Campaigns row never offers "Create invoice" for the invoice closeout just made.
// ═════════════════════════════════════════════════════════════════════════════
describe('Part H. the row after a successful closeout', () => {
    const NOW = new Date('2026-10-01T01:00:00Z');
    const beforeCloseout = {
        id: 'camp-h', name: 'Edgar-like Fundraiser', status: 'Active', closed_at: null, settlement_total: null,
        end_date: '2026-09-30', invoice_statuses: [] as string[], settled_externally: false, held_order_count: 45,
        bundle_selection_status: 'selected', customer_id: 'org-h', customer: { name: 'Org' }, business_timezone: 'America/Chicago',
    };
    const closeoutResponse = {
        success: true, status: 'Closed', closed_at: '2026-10-01T00:24:45.414Z', settlement_total: 5755,
        invoice_id: 'inv-1', invoice_status: 'DRAFT',
    };
    const patched = (response: Record<string, unknown>) => ({
        ...beforeCloseout,
        status: 'Closed', closed_at: response.closed_at as string, settlement_total: response.settlement_total as number,
        invoice_statuses: invoiceStatusesAfterCloseout(beforeCloseout.invoice_statuses, response),
    });

    it('the defect: patching only status, closed_at and settlement left the row offering "Create invoice"', () => {
        const old = { ...beforeCloseout, status: 'Closed', closed_at: closeoutResponse.closed_at, settlement_total: 5755 };
        expect(triageCampaign(old as any, NOW).action?.label).toBe('Create invoice');
    });

    it('with the response\'s own DRAFT status the row says "Review invoice"', () => {
        const row = patched(closeoutResponse);
        expect(row.invoice_statuses).toEqual(['DRAFT']);
        expect(triageCampaign(row as any, NOW).action?.label).toBe('Review invoice');
    });

    it('a concurrent closeout response that names the invoice without its status leaves it unknown — never "Create invoice"', () => {
        const row = patched({ ...closeoutResponse, invoice_status: undefined });
        expect(row.invoice_statuses).toBeNull();
        expect(triageCampaign(row as any, NOW).action?.label).not.toBe('Create invoice');
    });

    it('what the row already knew is kept, and nothing is invented when the response names no invoice', () => {
        expect(invoiceStatusesAfterCloseout(['CANCELED'], { invoice_status: 'DRAFT' })).toEqual(['CANCELED', 'DRAFT']);
        expect(invoiceStatusesAfterCloseout(['DRAFT'], { invoice_status: 'DRAFT' })).toEqual(['DRAFT']);
        expect(invoiceStatusesAfterCloseout([], {})).toEqual([]);
        expect(invoiceStatusesAfterCloseout(undefined, {})).toBeNull();
    });

    it('the closeout handler patches the row from the response, with no second invoice path', () => {
        const page = read('app/fundraisers/page.tsx');
        const handler = page.slice(page.indexOf('const handleCloseout = async'), page.indexOf('const openCloseoutModal'));
        expect(handler).toContain('invoice_statuses: invoiceStatusesAfterCloseout(f.invoice_statuses, data),');
        expect(handler.match(/fetch\(/g)).toHaveLength(1);
        expect(handler).not.toMatch(/\/invoices/);
    });
});
