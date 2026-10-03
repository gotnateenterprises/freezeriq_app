/**
 * DATA-CLEANUP-GUARDS-1 — stop creating new false starts, stale drafts and duplicate setup records.
 *
 * Every guard is proven against the REAL code: the pure rules directly, and each changed route
 * handler executed over a recording double. Where a guarantee is about concurrency, the double
 * serializes transactions the way Postgres' row and advisory locks do, and models rollback, so the
 * assertion is about the route's behaviour under that serialization — not about a mock's answer.
 *
 *   GUARD 1  zero-sale closeout freezes $0.00 and writes NO invoice; positive closeout unchanged
 *   GUARD 2  a $0.00 DRAFT can be canceled (kept, never deleted); nothing else can be
 *   GUARD 3  hard delete only for an ordinary invoice entered by mistake; history never disappears
 *   GUARD 4  canonical launch stays one-campaign-per-opportunity; the wizard never silently
 *            creates a campaign beside an OPEN planning cycle
 *   GUARD 5  a wizard retry reuses the organization it created; double-click joins, never duplicates
 *   GUARD 6  one shared setup-attempt rule; the dashboard and Organizations tab leave false starts
 *            out of Campaigns Run, Last Fundraiser, the month pattern and invoice follow-ups
 *   GUARD 7  compatibility matrix across every campaign shape that exists
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { closeoutRequiresInvoice } from '@/lib/fundraiserCloseoutMath';
import {
    assessObligation,
    classifyCampaignLifecycle,
    describeCampaignInvoice,
    hasFrozenZeroSettlement,
    invoiceStatusesAfterCloseout,
    isNothingToInvoice,
    isZeroDollarCloseoutDraft,
    type CampaignLifecycleInput,
} from '@/lib/growth/campaignLifecycle';
import { triageCampaign, type CampaignForTriage } from '@/lib/growth/nextAction';
import { detailSections } from '@/lib/growth/campaignContextUi';
import {
    evaluateDraftCancel,
    evaluateHardDelete,
    mayRemoveInvoices,
    offersDraftCancel,
    offersHardDelete,
    type DraftCancelFacts,
    type HardDeleteFacts,
} from '@/lib/invoiceRemoval';
import {
    computeOrganizationImpact,
    countsAsFundraiserHistory,
    isFundraiserSetupAttempt,
    isRealCampaign,
    type ImpactCampaignInput,
} from '@/lib/growth/impact';
import {
    buildOrganizationDashboard,
    type DashboardCampaignInput,
    type DashboardOrderInput,
    type OrganizationDashboardInput,
} from '@/lib/organizationDashboard';
import { createWizardSubmission } from '@/lib/fundraiserWizardSubmit';
import { campaignSelectionLockKey } from '@/lib/campaignSelectionLock';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
let currentDb: any = null;
jest.mock('@/lib/db', () => ({ get prisma() { return currentDb; } }));

const BIZ = 'biz-a';
const OTHER_BIZ = 'biz-b';
const session = (role: string, isSuperAdmin = false) => ({
    user: { id: 'user-admin', email: 'owner@tenant.test', businessId: BIZ, role, isSuperAdmin },
});
const asAdmin = () => mockAuth.mockResolvedValue(session('ADMIN'));

const jsonReq = (url: string, method: string, body?: unknown) =>
    new Request(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    }) as any;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;

/** A promise mutex: transactions run one at a time, as a row or advisory lock makes them. */
function serialized() {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => undefined);
        return run;
    };
}

beforeEach(() => {
    mockAuth.mockReset();
    asAdmin();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ═════════════════════════════════════════════════════════════════════════════
// GUARD 1 — zero-sale closeout
// ═════════════════════════════════════════════════════════════════════════════

describe('GUARD 1 · closeoutRequiresInvoice — the rule', () => {
    it('nothing sold (no active order, all money zero) needs no invoice', () => {
        expect(closeoutRequiresInvoice({ activeOrderCount: 0, grossSales: 0, taxCollected: 0, totalDue: 0 })).toBe(false);
    });

    it('ANY active order needs one — a $0.00 order is still waiting on the PAID invoice to be released', () => {
        expect(closeoutRequiresInvoice({ activeOrderCount: 1, grossSales: 0, taxCollected: 0, totalDue: 0 })).toBe(true);
    });

    it('any money keeps the invoice, defensively, even without a counted order', () => {
        expect(closeoutRequiresInvoice({ activeOrderCount: 0, grossSales: 125, taxCollected: 0, totalDue: 100 })).toBe(true);
        expect(closeoutRequiresInvoice({ activeOrderCount: 0, grossSales: 0, taxCollected: 0.01, totalDue: 0.01 })).toBe(true);
        expect(closeoutRequiresInvoice({ activeOrderCount: 0, grossSales: 0, taxCollected: 0, totalDue: 0.01 })).toBe(true);
    });

    it('sub-cent noise is zero, not money', () => {
        expect(closeoutRequiresInvoice({ activeOrderCount: 0, grossSales: 0.001, taxCollected: -0.001, totalDue: 0 })).toBe(false);
    });
});

describe('GUARD 1 · the closeout route, executed', () => {
    const CAMPAIGN = 'camp-1';
    const item = (name: string, variant: string, qty: number, price: number) => ({
        bundle_id: `b-${name}`, quantity: qty, unit_price: price, variant_size: variant, item_name: name, bundle: { name },
    });
    /** A real-shaped closeout: four products across four orders, 1% supporter tax collected. */
    const fourProductOrders = () => [
        { id: 'o1', campaign_id: CAMPAIGN, canceled_at: null, total_amount: 1020, tax_amount: 10.2, items: [item('Q2 - Comfort Foods (Serves 2)', 'serves_2', 17, 60)] },
        { id: 'o2', campaign_id: CAMPAIGN, canceled_at: null, total_amount: 420, tax_amount: 4.2, items: [item('Q1 - Hearty Meals (Serves 2)', 'serves_2', 7, 60)] },
        { id: 'o3', campaign_id: CAMPAIGN, canceled_at: null, total_amount: 375, tax_amount: 3.75, items: [item('Q1 - Hearty Meals', 'serves_5', 3, 125)] },
        { id: 'o4', campaign_id: CAMPAIGN, canceled_at: null, total_amount: 250, tax_amount: 2.5, items: [item('Q2 - Comfort Foods', 'serves_5', 2, 125)] },
    ];

    function world(opts: { orders?: any[]; invoices?: any[]; campaign?: any; claimFails?: boolean; winnerSettlement?: number | null } = {}) {
        const calls: string[] = [];
        const state = {
            campaign: {
                id: CAMPAIGN, status: 'Active', closed_at: null as any, settlement_total: null as any, closed_by: null,
                org_share_percent: 20, tax_status: 'TAXABLE', tax_rate_percent: 1,
                customer: { id: 'org-1', business_id: BIZ },
                ...(opts.campaign ?? {}),
            },
            orders: opts.orders ?? [],
            invoices: opts.invoices ?? [] as any[],
            created: [] as any[],
        };
        const tx = {
            $executeRawUnsafe: async (_sql: string, key: string) => { calls.push(`lock:${key}`); return 1; },
            order: {
                findMany: async ({ where }: any) => {
                    calls.push('orders.read');
                    return state.orders.filter((o) => o.campaign_id === where.campaign_id && (where.canceled_at === null ? !o.canceled_at : true));
                },
                updateMany: async () => { calls.push('orders.promote'); return { count: 0 }; },
            },
            fundraiserCampaign: {
                updateMany: async ({ data }: any) => {
                    calls.push('campaign.claim');
                    if (opts.claimFails || state.campaign.closed_at) return { count: 0 };
                    Object.assign(state.campaign, data);
                    return { count: 1 };
                },
            },
            invoice: {
                create: async (a: any) => {
                    calls.push('invoice.create');
                    if (state.invoices.some((i) => i.campaign_id === a.data.campaign_id)) {
                        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
                    }
                    const row = { id: 'inv-new', ...a.data };
                    state.invoices.push(row);
                    state.created.push(row);
                    return { id: row.id };
                },
                findFirst: async ({ where }: any) => state.invoices.find((i) => i.campaign_id === where.campaign_id) ?? null,
            },
        };
        let campaignReads = 0;
        currentDb = {
            $transaction: async (fn: any) => fn(tx),
            fundraiserCampaign: {
                // The first read is the route's ownership check (still open); when this request
                // LOSES the claim, the re-read afterwards sees what the winner committed.
                findUnique: async () => (opts.claimFails && campaignReads++ > 0
                    ? { ...state.campaign, status: 'Closed', closed_at: new Date(), settlement_total: opts.winnerSettlement ?? null }
                    : state.campaign),
            },
            invoice: { findFirst: async ({ where }: any) => state.invoices.find((i) => i.campaign_id === where.campaign_id) ?? null },
            user: { findFirst: async ({ where }: any) => ({ id: where.id ?? 'user-admin' }) },
        };
        return { calls, state };
    }

    const close = async (body: unknown = { applyFoodTax: true }) => {
        const { POST } = await import('@/app/api/campaigns/[id]/closeout/route');
        const res = await POST(jsonReq(`http://localhost/api/campaigns/${CAMPAIGN}/closeout`, 'POST', body), ctx(CAMPAIGN));
        return { status: res.status, body: await res.json() };
    };

    it('ZERO ORDERS: closes, freezes $0.00, writes NO invoice and says invoice_required:false', async () => {
        const w = world({ orders: [] });
        const { status, body } = await close();
        expect(status).toBe(200);
        expect(body).toMatchObject({
            success: true, idempotent: false, status: 'Closed', settlement_total: 0,
            invoice_id: null, invoice_status: null, invoice_required: false, promoted_order_count: 0,
        });
        // The campaign is frozen exactly as before.
        expect(w.state.campaign.status).toBe('Closed');
        expect(w.state.campaign.closed_at).toBeInstanceOf(Date);
        expect(w.state.campaign.closed_by).toBe('user-admin');
        expect(w.state.campaign.settlement_total).toBe(0);
        // No document of any kind.
        expect(w.calls).not.toContain('invoice.create');
        expect(w.state.invoices).toHaveLength(0);
        // The lock still comes first, before any read or the claim.
        expect(w.calls[0]).toBe(`lock:${campaignSelectionLockKey(CAMPAIGN)}`);
        expect(w.calls.indexOf('orders.read')).toBeLessThan(w.calls.indexOf('campaign.claim'));
    });

    it('CANCELED-ONLY: orders that were all canceled sold nothing — closed at $0.00, no invoice', async () => {
        const w = world({ orders: fourProductOrders().map((o) => ({ ...o, canceled_at: new Date('2026-09-01T00:00:00Z') })) });
        const { body } = await close();
        expect(body).toMatchObject({ status: 'Closed', settlement_total: 0, invoice_id: null, invoice_required: false });
        expect(w.calls).not.toContain('invoice.create');
    });

    it('POSITIVE SALES: still exactly one DRAFT, with the same money as before (tax and org share unchanged)', async () => {
        const w = world({ orders: fourProductOrders() });
        const { status, body } = await close({ applyFoodTax: true });
        expect(status).toBe(200);
        expect(body).toMatchObject({ invoice_id: 'inv-new', invoice_status: 'DRAFT', invoice_required: true, settlement_total: 2065 });
        expect(body.financials).toEqual({
            gross_sales: 2065, org_share_percent: 20, organization_amount: 413, base_remit: 1652,
            tax_applied: true, tax_rate_percent: 1, tax_amount: 20.65, total_due: 1672.65,
        });
        const created = w.state.created[0];
        expect(created.status).toBe('DRAFT');
        expect(Number(created.total_amount)).toBe(1672.65);
        expect(Number(created.tax_amount)).toBe(20.65);
        expect(Number(created.fundraiser_profit_amount)).toBe(413);
        expect(created.items.create).toHaveLength(4);
        expect(w.calls.indexOf('campaign.claim')).toBeLessThan(w.calls.indexOf('invoice.create'));
    });

    it('$0.00 WITH ACTIVITY: an active $0.00 order still gets its draft — its release depends on it', async () => {
        const w = world({ orders: [{ id: 'comp', campaign_id: CAMPAIGN, canceled_at: null, total_amount: 0, tax_amount: 0, items: [item('Comped', 'serves_5', 1, 0)] }] });
        const { body } = await close();
        expect(body).toMatchObject({ settlement_total: 0, invoice_status: 'DRAFT', invoice_required: true });
        expect(w.calls).toContain('invoice.create');
        expect(Number(w.state.created[0].total_amount)).toBe(0);
    });

    it('RETRY of a zero-sale closeout: idempotent, still no invoice, invoice_required:false', async () => {
        const w = world({ campaign: { status: 'Closed', closed_at: new Date('2026-10-01T00:00:00Z'), settlement_total: '0.00' } });
        const { body } = await close();
        expect(body).toMatchObject({ idempotent: true, invoice_id: null, invoice_status: null, invoice_required: false });
        expect(w.calls).toHaveLength(0); // the fast path never opens a transaction
    });

    it('RETRY of a positive closeout returns its own invoice, invoice_required:true', async () => {
        world({
            campaign: { status: 'Closed', closed_at: new Date('2026-10-01T00:00:00Z'), settlement_total: '5600.00' },
            invoices: [{ id: 'inv-first', campaign_id: CAMPAIGN, status: 'SENT' }],
        });
        const { body } = await close();
        expect(body).toMatchObject({ idempotent: true, invoice_id: 'inv-first', invoice_status: 'SENT', invoice_required: true });
    });

    it('a legacy closed campaign with sales and no invoice reads invoice_required:true; a NULL settlement is unknown (null)', async () => {
        world({ campaign: { status: 'Archived', closed_at: null, settlement_total: '1980.00' } });
        expect((await close()).body.invoice_required).toBe(true);
        world({ campaign: { status: 'Closed', closed_at: null, settlement_total: null } });
        expect((await close()).body.invoice_required).toBeNull();
    });

    it('the LOSING side of a concurrent zero-sale closeout answers idempotently with invoice_required:false', async () => {
        const w = world({ orders: [], claimFails: true, winnerSettlement: 0 });
        const { status, body } = await close();
        expect(status).toBe(200);
        expect(body).toMatchObject({ idempotent: true, invoice_id: null, invoice_required: false });
        expect(w.calls).not.toContain('invoice.create');
    });

    it('a zero-sale closeout of a campaign that somehow already holds an invoice reports it — never a second', async () => {
        const w = world({ orders: [], invoices: [{ id: 'inv-old', campaign_id: CAMPAIGN, status: 'CANCELED' }] });
        const { body } = await close();
        expect(body).toMatchObject({ invoice_id: 'inv-old', invoice_status: 'CANCELED', invoice_required: false });
        expect(w.calls).not.toContain('invoice.create');
    });

    it('a CHEF still cannot close out (the role gate is untouched)', async () => {
        const w = world({ orders: [] });
        mockAuth.mockResolvedValue(session('CHEF'));
        const { status } = await close();
        expect(status).toBe(403);
        expect(w.calls).toHaveLength(0);
    });
});

describe('GUARD 1 · nothing on any surface claims a zero-sale closeout needs an invoice', () => {
    const closedAt = '2026-10-01T00:00:00.000Z';
    const zeroSale: CampaignLifecycleInput & CampaignForTriage = {
        status: 'Closed', closed_at: closedAt, settlement_total: 0, invoice_statuses: [], held_order_count: 0,
    };

    it('the invoice wording says no invoice is needed, and never offers "Create invoice"', () => {
        expect(hasFrozenZeroSettlement(zeroSale)).toBe(true);
        expect(isNothingToInvoice(zeroSale)).toBe(true);
        expect(describeCampaignInvoice(zeroSale)).toEqual({
            label: 'No invoice needed — nothing was sold', canCreateInvoice: false, tone: 'neutral', known: true,
        });
        expect(classifyCampaignLifecycle(zeroSale)).toBe('completed');
        expect(triageCampaign(zeroSale, new Date('2026-10-02T00:00:00Z'))).toMatchObject({ priority: 'completed', action: null });
    });

    it('the Campaign Context drawer withdraws "Create invoice" for it — but keeps it for a running fundraiser', () => {
        expect(detailSections(zeroSale, new Date('2026-10-02T00:00:00Z')).showInvoice).toBe(false);
        const running: CampaignForTriage = { status: 'Active', end_date: '2026-12-01', invoice_statuses: [], held_order_count: 0 };
        expect(detailSections(running, new Date('2026-10-02T00:00:00Z')).showInvoice).toBe(true);
    });

    it('the closeout response patches the row without inventing an invoice status', () => {
        expect(invoiceStatusesAfterCloseout([], { invoice_id: null, invoice_status: null })).toEqual([]);
        expect(invoiceStatusesAfterCloseout([], { invoice_id: 'inv-new', invoice_status: 'DRAFT' })).toEqual(['DRAFT']);
    });

    it('a NULL (never frozen) settlement keeps the old wording — absence is not a zero', () => {
        const legacy = { status: 'Closed', closed_at: null, settlement_total: null, invoice_statuses: [], held_order_count: 0 };
        expect(hasFrozenZeroSettlement(legacy)).toBe(false);
        expect(describeCampaignInvoice(legacy).label).toBe('Not yet invoiced');
        expect(describeCampaignInvoice(legacy).canCreateInvoice).toBe(true);
    });

    it('the closeout modal states that no invoice was created, and shows no draft figures or bundle table for it', () => {
        const page = read('app/fundraisers/page.tsx');
        expect(page).toContain("const closeoutWithoutInvoice = closeoutResult?.success === true && closeoutResult.invoice_required === false;");
        expect(page).toContain('No sales were recorded, so no invoice was created. Nothing is owed and no orders are waiting.');
        expect(page).toContain('financials: data.invoice_required === false ? undefined : data.financials,');
        expect(page).toContain('const closeoutBundleSummary = closeoutResult?.success && !closeoutWithoutInvoice');
        // Archiving a fundraiser that sold nothing no longer warns about unfinished money.
        expect(page).toContain("&& assessObligation(f) !== 'none';");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// GUARD 2 — DRAFT cancellation
// ═════════════════════════════════════════════════════════════════════════════

const draftFacts = (over: Partial<DraftCancelFacts> = {}): DraftCancelFacts => ({
    status: 'DRAFT', total_amount: '0.00', tax_amount: '0.00', paid_at: null, payment_reference: null,
    hasQuickBooksLink: false, hasQuickBooksSend: false, activeCampaignOrderCount: 0, ...over,
});

describe('GUARD 2 · evaluateDraftCancel — the rule', () => {
    it('a $0.00 DRAFT nothing waits on can be canceled', () => {
        expect(evaluateDraftCancel(draftFacts())).toEqual({ ok: true, alreadyCanceled: false });
        expect(evaluateDraftCancel(draftFacts({ activeCampaignOrderCount: null }))).toEqual({ ok: true, alreadyCanceled: false });
    });

    it('a repeat is safe: an already-CANCELED invoice answers alreadyCanceled', () => {
        expect(evaluateDraftCancel(draftFacts({ status: 'CANCELED' }))).toEqual({ ok: true, alreadyCanceled: true });
    });

    it.each(['SENT', 'PAID', 'OVERDUE', 'PENDING'])('%s can never be canceled here', (status) => {
        expect(evaluateDraftCancel(draftFacts({ status }))).toMatchObject({ ok: false, code: 'not_draft', status: 409 });
    });

    it('a QuickBooks link or send lifecycle refuses it', () => {
        expect(evaluateDraftCancel(draftFacts({ hasQuickBooksLink: true }))).toMatchObject({ ok: false, code: 'quickbooks' });
        expect(evaluateDraftCancel(draftFacts({ hasQuickBooksSend: true }))).toMatchObject({ ok: false, code: 'quickbooks' });
    });

    it('a recorded payment refuses it', () => {
        expect(evaluateDraftCancel(draftFacts({ paid_at: new Date() }))).toMatchObject({ ok: false, code: 'payment_recorded' });
        expect(evaluateDraftCancel(draftFacts({ payment_reference: 'chk 101' }))).toMatchObject({ ok: false, code: 'payment_recorded' });
    });

    it('a draft that bills money — or only tax — is the record of a debt and is refused', () => {
        expect(evaluateDraftCancel(draftFacts({ total_amount: '196.00' }))).toMatchObject({ ok: false, code: 'bills_money' });
        expect(evaluateDraftCancel(draftFacts({ total_amount: '0.00', tax_amount: '0.01' }))).toMatchObject({ ok: false, code: 'bills_money' });
    });

    it('a $0.00 draft with active orders on its fundraiser is refused — those orders are released only by it', () => {
        expect(evaluateDraftCancel(draftFacts({ activeCampaignOrderCount: 2 }))).toMatchObject({ ok: false, code: 'orders_waiting' });
    });

    it('ADMIN or super-admin only', () => {
        expect(mayRemoveInvoices({ role: 'ADMIN' })).toBe(true);
        expect(mayRemoveInvoices({ role: 'CHEF', isSuperAdmin: true })).toBe(true);
        expect(mayRemoveInvoices({ role: 'CHEF' })).toBe(false);
        expect(mayRemoveInvoices({ role: 'DRIVER' })).toBe(false);
        expect(mayRemoveInvoices({ role: 'admin' })).toBe(false);
        expect(mayRemoveInvoices({ role: 'ADMIN', isSuperAdmin: 'true' })).toBe(true);
        expect(mayRemoveInvoices({ isSuperAdmin: 'true' })).toBe(false);
    });
});

describe('GUARD 2 · POST /api/tenant/invoices/[id]/cancel-draft, executed', () => {
    type Inv = {
        id: string; business_id: string; campaign_id: string | null; status: string; total_amount: string; tax_amount: string;
        paid_at: Date | null; payment_reference: string | null; quickbooks_invoice_links: { id: string }[]; quickbooks_invoice_send: { id: string } | null;
    };
    const inv = (over: Partial<Inv> = {}): Inv => ({
        id: 'inv-draft', business_id: BIZ, campaign_id: 'camp-false-start', status: 'DRAFT', total_amount: '0.00', tax_amount: '0.00',
        paid_at: null, payment_reference: null, quickbooks_invoice_links: [], quickbooks_invoice_send: null, ...over,
    });

    function world(rows: Inv[], opts: { activeOrders?: number; updateCount?: number } = {}) {
        const calls: string[] = [];
        const store = new Map(rows.map((r) => [r.id, { ...r }]));
        const run = serialized();
        const scoped = (where: any) => {
            const r = store.get(where.id);
            return r && r.business_id === where.business_id ? r : null;
        };
        const tx = {
            $executeRawUnsafe: async (_sql: string, key: string) => { calls.push(`campaign-lock:${key}`); return 1; },
            $queryRawUnsafe: async (sql: string, id: string, businessId: string) => {
                calls.push(`invoice-lock:${id}`);
                expect(sql).toContain('FOR UPDATE');
                const r = store.get(id);
                return r && r.business_id === businessId ? [{ id }] : [];
            },
            invoice: {
                findFirst: async ({ where }: any) => { calls.push('tx.read'); const r = scoped(where); return r ? { ...r } : null; },
                updateMany: async ({ where, data }: any) => {
                    calls.push('invoice.updateMany');
                    expect(where).toMatchObject({ id: expect.any(String), business_id: BIZ, status: 'DRAFT' });
                    if (opts.updateCount !== undefined) return { count: opts.updateCount };
                    const r = scoped(where);
                    if (!r || r.status !== where.status) return { count: 0 };
                    Object.assign(r, data);
                    return { count: 1 };
                },
            },
            order: { count: async ({ where }: any) => { calls.push('orders.count'); expect(where.canceled_at).toBeNull(); return opts.activeOrders ?? 0; } },
        };
        currentDb = {
            invoice: { findFirst: async ({ where }: any) => { const r = scoped(where); return r ? { id: r.id, campaign_id: r.campaign_id } : null; } },
            $transaction: (fn: any) => run(() => fn(tx)),
        };
        return { calls, store };
    }

    const cancel = async (id: string, body: unknown = { confirm: true }) => {
        const { POST } = await import('@/app/api/tenant/invoices/[id]/cancel-draft/route');
        const res = await POST(jsonReq(`http://localhost/api/tenant/invoices/${id}/cancel-draft`, 'POST', body), ctx(id));
        return { status: res.status, body: await res.json() };
    };

    it('a $0.00 closeout DRAFT is canceled — kept, not deleted — under the campaign lock, then the row lock', async () => {
        const w = world([inv()]);
        const { status, body } = await cancel('inv-draft');
        expect(status).toBe(200);
        expect(body).toEqual({ success: true, alreadyCanceled: false, invoice: { id: 'inv-draft', status: 'CANCELED' } });
        expect(w.store.get('inv-draft')!.status).toBe('CANCELED');
        expect(w.store.size).toBe(1); // the record survives
        expect(w.calls).toEqual([
            `campaign-lock:${campaignSelectionLockKey('camp-false-start')}`,
            'invoice-lock:inv-draft',
            'tx.read',
            'orders.count',
            'invoice.updateMany',
        ]);
    });

    it('a repeat is safe: the second call answers alreadyCanceled and writes nothing', async () => {
        const w = world([inv()]);
        await cancel('inv-draft');
        const writesBefore = w.calls.filter((c) => c === 'invoice.updateMany').length;
        const again = await cancel('inv-draft');
        expect(again.status).toBe(200);
        expect(again.body.alreadyCanceled).toBe(true);
        expect(w.calls.filter((c) => c === 'invoice.updateMany').length).toBe(writesBefore);
    });

    it('a double-click (two concurrent cancels) makes exactly one transition', async () => {
        const w = world([inv()]);
        const [a, b] = await Promise.all([cancel('inv-draft'), cancel('inv-draft')]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect([a.body.alreadyCanceled, b.body.alreadyCanceled].sort()).toEqual([false, true]);
        expect(w.calls.filter((c) => c === 'invoice.updateMany')).toHaveLength(1);
    });

    it.each([
        ['SENT', inv({ status: 'SENT', total_amount: '4480.00' })],
        ['PAID', inv({ status: 'PAID', total_amount: '202.50', paid_at: new Date() })],
        ['OVERDUE', inv({ status: 'OVERDUE', total_amount: '50.00', campaign_id: null })],
        ['PENDING', inv({ status: 'PENDING', total_amount: '0.00', campaign_id: null })],
    ])('%s is refused with 409 and left exactly as it was', async (_label, row) => {
        const w = world([row]);
        const before = JSON.stringify(w.store.get(row.id));
        const { status, body } = await cancel(row.id);
        expect(status).toBe(409);
        expect(body.code).toBe('not_draft');
        expect(JSON.stringify(w.store.get(row.id))).toBe(before);
        expect(w.calls).not.toContain('invoice.updateMany');
    });

    it('a SENT, QuickBooks-owned invoice is refused and untouched', async () => {
        const w = world([inv({ id: 'inv-qbo-sent', status: 'SENT', total_amount: '4480.00', quickbooks_invoice_links: [{ id: 'l' }], quickbooks_invoice_send: { id: 's' } })]);
        const { status } = await cancel('inv-qbo-sent');
        expect(status).toBe(409);
        expect(w.store.get('inv-qbo-sent')!.status).toBe('SENT');
    });

    it('a QuickBooks-owned DRAFT is refused', async () => {
        world([inv({ quickbooks_invoice_links: [{ id: 'l' }] })]);
        expect((await cancel('inv-draft')).body.code).toBe('quickbooks');
        world([inv({ quickbooks_invoice_send: { id: 's' } })]);
        expect((await cancel('inv-draft')).body.code).toBe('quickbooks');
    });

    it('a DRAFT that bills money is refused (and so stays owed)', async () => {
        const w = world([inv({ total_amount: '196.00', tax_amount: '0.00' })]);
        const { status, body } = await cancel('inv-draft');
        expect([status, body.code]).toEqual([409, 'bills_money']);
        expect(w.store.get('inv-draft')!.status).toBe('DRAFT');
    });

    it('a $0.00 DRAFT with active orders on its fundraiser is refused', async () => {
        const w = world([inv()], { activeOrders: 1 });
        expect((await cancel('inv-draft')).body.code).toBe('orders_waiting');
        expect(w.store.get('inv-draft')!.status).toBe('DRAFT');
    });

    it('cross-tenant: another tenant\'s draft is 404 and untouched', async () => {
        const w = world([inv({ business_id: OTHER_BIZ })]);
        const { status } = await cancel('inv-draft');
        expect(status).toBe(404);
        expect(w.store.get('inv-draft')!.status).toBe('DRAFT');
        expect(w.calls).toHaveLength(0);
    });

    it('unauthenticated 401; CHEF and DRIVER 403; a super-admin may', async () => {
        const w = world([inv()]);
        mockAuth.mockResolvedValue(null);
        expect((await cancel('inv-draft')).status).toBe(401);
        mockAuth.mockResolvedValue(session('CHEF'));
        expect((await cancel('inv-draft')).status).toBe(403);
        mockAuth.mockResolvedValue(session('DRIVER'));
        expect((await cancel('inv-draft')).status).toBe(403);
        expect(w.calls).toHaveLength(0);
        mockAuth.mockResolvedValue(session('CHEF', true));
        expect((await cancel('inv-draft')).status).toBe(200);
    });

    it('requires an explicit { confirm: true }', async () => {
        const w = world([inv()]);
        expect((await cancel('inv-draft', {})).status).toBe(400);
        expect((await cancel('inv-draft', { confirm: 'yes' })).status).toBe(400);
        expect(w.calls).toHaveLength(0);
    });

    it('if the invoice moved after the read (conditional write matched nothing), it answers 409, not success', async () => {
        world([inv()], { updateCount: 0 });
        const { status } = await cancel('inv-draft');
        expect(status).toBe(409);
    });

    it('the invoices page offers "Cancel $0 Draft" only for such drafts, to administrators', () => {
        expect(offersDraftCancel({ status: 'DRAFT', total_amount: 0, tax_amount: '0.00' })).toBe(true);
        expect(offersDraftCancel({ status: 'DRAFT', total_amount: 196, tax_amount: 0 })).toBe(false);
        expect(offersDraftCancel({ status: 'DRAFT', total_amount: 0, tax_amount: 0, quickbooks_invoice_send: { status: 'reserved' } })).toBe(false);
        expect(offersDraftCancel({ status: 'SENT', total_amount: 0, tax_amount: 0 })).toBe(false);
        const page = read('app/invoices/page.tsx');
        expect(page).toContain('{mayRemove && offersDraftCancel(inv) && (');
        expect(page).toContain("fetch(`/api/tenant/invoices/${invoice.id}/cancel-draft`");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// GUARD 3 — hard delete
// ═════════════════════════════════════════════════════════════════════════════

const delFacts = (over: Partial<HardDeleteFacts> = {}): HardDeleteFacts => ({
    status: 'PENDING', campaign_id: null, paid_at: null, payment_reference: null,
    hasQuickBooksLink: false, hasQuickBooksSend: false, linkedOrderStatus: 'pending', ...over,
});

describe('GUARD 3 · evaluateHardDelete — the rule', () => {
    it('an ordinary PENDING or CANCELED invoice whose kitchen order has not started may go', () => {
        expect(evaluateHardDelete(delFacts())).toEqual({ ok: true });
        expect(evaluateHardDelete(delFacts({ status: 'CANCELED' }))).toEqual({ ok: true });
        expect(evaluateHardDelete(delFacts({ linkedOrderStatus: null }))).toEqual({ ok: true });
        expect(evaluateHardDelete(delFacts({ linkedOrderStatus: 'PENDING' }))).toEqual({ ok: true });
    });

    it('a fundraiser invoice never goes, whatever its status', () => {
        for (const status of ['DRAFT', 'SENT', 'PAID', 'PENDING', 'CANCELED']) {
            expect(evaluateHardDelete(delFacts({ status, campaign_id: 'camp-1' }))).toMatchObject({ ok: false, code: 'fundraiser_invoice' });
        }
    });

    it.each(['PAID', 'SENT', 'OVERDUE', 'DRAFT'])('%s is financial history and is refused', (status) => {
        expect(evaluateHardDelete(delFacts({ status }))).toMatchObject({ ok: false, code: 'financial_history', status: 409 });
    });

    it('QuickBooks, a recorded payment, or a kitchen order already in progress refuse it', () => {
        expect(evaluateHardDelete(delFacts({ hasQuickBooksLink: true }))).toMatchObject({ code: 'quickbooks' });
        expect(evaluateHardDelete(delFacts({ hasQuickBooksSend: true }))).toMatchObject({ code: 'quickbooks' });
        expect(evaluateHardDelete(delFacts({ paid_at: new Date() }))).toMatchObject({ code: 'payment_recorded' });
        for (const s of ['production_ready', 'in_production', 'completed', 'ready_to_ship', 'delivered', 'APPROVED', 'DELIVERED', 'fundraiser_hold']) {
            expect(evaluateHardDelete(delFacts({ linkedOrderStatus: s }))).toMatchObject({ code: 'order_started' });
        }
    });

    it('the invoices page offers Delete only for an ordinary unpaid PENDING/CANCELED invoice', () => {
        expect(offersHardDelete({ status: 'PENDING' })).toBe(true);
        expect(offersHardDelete({ status: 'CANCELED', campaign_id: null })).toBe(true);
        expect(offersHardDelete({ status: 'PAID' })).toBe(false);
        expect(offersHardDelete({ status: 'DRAFT', campaign_id: 'camp-1' })).toBe(false);
        expect(offersHardDelete({ status: 'PENDING', campaign_id: 'camp-1' })).toBe(false);
        expect(offersHardDelete({ status: 'PENDING', quickbooks_invoice_send: { status: 'sent' } })).toBe(false);
        expect(read('app/invoices/page.tsx')).toContain('{mayRemove && offersHardDelete(inv) && (');
    });
});

describe('GUARD 3 · DELETE /api/tenant/invoices, executed', () => {
    type Row = {
        id: string; business_id: string; campaign_id: string | null; status: string; paid_at: Date | null; payment_reference: string | null;
        quickbooks_invoice_links: { id: string }[]; quickbooks_invoice_send: { id: string } | null; order: { id: string; status: string } | null;
    };
    const row = (over: Partial<Row> = {}): Row => ({
        id: 'inv-m', business_id: BIZ, campaign_id: null, status: 'PENDING', paid_at: null, payment_reference: null,
        quickbooks_invoice_links: [], quickbooks_invoice_send: null, order: { id: 'ord-m', status: 'pending' }, ...over,
    });

    function world(rows: Row[], opts: { atLock?: (r: Row) => void } = {}) {
        const calls: string[] = [];
        const store = new Map(rows.map((r) => [r.id, { ...r }]));
        const deleted: string[] = [];
        const scoped = (where: any) => {
            const r = store.get(where.id);
            return r && (where.business_id === undefined || r.business_id === where.business_id) ? r : null;
        };
        const tx = {
            invoice: {
                findUnique: async ({ where }: any) => { calls.push('read'); const r = scoped(where); return r ? JSON.parse(JSON.stringify(r)) : null; },
                delete: async ({ where }: any) => { calls.push('invoice.delete'); deleted.push(`invoice:${where.id}`); store.delete(where.id); return {}; },
            },
            invoiceItem: { deleteMany: async () => { calls.push('items.delete'); return { count: 1 }; } },
            order: { delete: async ({ where }: any) => { calls.push('order.delete'); deleted.push(`order:${where.id}`); return {}; } },
            orderItem: { deleteMany: async () => { calls.push('orderItems.delete'); return { count: 1 }; } },
            $queryRawUnsafe: async (sql: string, id: string, businessId?: string) => {
                expect(sql).toContain('FOR UPDATE');
                if (sql.includes('FROM invoices')) {
                    calls.push('lock:invoice');
                    const r = store.get(id);
                    if (r && opts.atLock) opts.atLock(r); // a writer that committed just before our lock
                    return r && r.business_id === businessId ? [{ id }] : [];
                }
                calls.push('lock:order');
                return [{ id }];
            },
        };
        currentDb = { $transaction: async (fn: any) => fn(tx) };
        return { calls, store, deleted };
    }

    const del = async (id: string) => {
        const { DELETE } = await import('@/app/api/tenant/invoices/route');
        const res = await DELETE(jsonReq('http://localhost/api/tenant/invoices', 'DELETE', { id }));
        return { status: res.status, body: await res.json() };
    };

    it('an ordinary PENDING invoice entered by mistake is deleted with its unstarted kitchen order, after the locks', async () => {
        const w = world([row()]);
        const { status } = await del('inv-m');
        expect(status).toBe(200);
        expect(w.deleted).toEqual(['order:ord-m', 'invoice:inv-m']);
        expect(w.calls.slice(0, 4)).toEqual(['read', 'lock:invoice', 'lock:order', 'read']);
    });

    it.each([
        ['PAID', row({ status: 'PAID', paid_at: new Date('2026-09-01T12:00:00Z'), order: { id: 'ord-m', status: 'production_ready' } }), 'financial_history'],
        ['OVERDUE', row({ status: 'OVERDUE' }), 'financial_history'],
        ['a fundraiser closeout DRAFT', row({ status: 'DRAFT', campaign_id: 'camp-1', order: null }), 'fundraiser_invoice'],
        ['a fundraiser SENT invoice', row({ status: 'SENT', campaign_id: 'camp-1', order: null }), 'fundraiser_invoice'],
        ['an invoice whose kitchen order is in production', row({ order: { id: 'ord-m', status: 'in_production' } }), 'order_started'],
    ])('%s cannot disappear: 409, nothing deleted', async (_label, r, code) => {
        const w = world([r]);
        const { status, body } = await del('inv-m');
        expect([status, body.code]).toEqual([409, code]);
        expect(w.deleted).toEqual([]);
        expect(w.store.has('inv-m')).toBe(true);
    });

    it('a payment recorded just before the delete locked the row is SEEN (fresh read after the lock) — nothing deleted', async () => {
        const w = world([row()], { atLock: (r) => { r.status = 'PAID'; r.paid_at = new Date(); } });
        const { status, body } = await del('inv-m');
        expect([status, body.code]).toEqual([409, 'financial_history']);
        expect(w.deleted).toEqual([]);
    });

    it('a QuickBooks-linked invoice keeps its existing refusal and message', async () => {
        const w = world([row({ quickbooks_invoice_links: [{ id: 'l' }] })]);
        const { status, body } = await del('inv-m');
        expect(status).toBe(409);
        expect(body.error).toMatch(/QuickBooks/);
        expect(w.deleted).toEqual([]);
    });

    it('cross-tenant: another tenant\'s invoice is 404 and nothing is deleted', async () => {
        const w = world([row({ business_id: OTHER_BIZ })]);
        const { status } = await del('inv-m');
        expect(status).toBe(404);
        expect(w.deleted).toEqual([]);
    });

    it('CHEF and DRIVER are refused 403 before anything is read', async () => {
        const w = world([row()]);
        mockAuth.mockResolvedValue(session('CHEF'));
        expect((await del('inv-m')).status).toBe(403);
        mockAuth.mockResolvedValue(session('DRIVER'));
        expect((await del('inv-m')).status).toBe(403);
        expect(w.calls).toEqual([]);
    });
});

describe('GUARD 3 · deleting a CUSTOMER can no longer cascade its invoices away', () => {
    const UUID = '11111111-2222-4333-8444-555555555555';
    function world(invoiceCount: number) {
        const deleted: string[] = [];
        currentDb = {
            customer: {
                findUnique: async () => ({ id: UUID, business_id: BIZ, orders: [] }),
                delete: async () => { deleted.push('customer'); return {}; },
            },
            fundraiserCampaign: { count: async () => 0 },
            fundraiserOrganizationContact: { count: async () => 0 },
            invoice: { count: async ({ where }: any) => { expect(where).toEqual({ customer_id: UUID }); return invoiceCount; } },
        };
        return deleted;
    }
    const del = async () => {
        const { DELETE } = await import('@/app/api/customers/[id]/route');
        const res = await DELETE(new Request(`http://localhost/api/customers/${UUID}`, { method: 'DELETE' }) as any, ctx(UUID));
        return { status: res.status, body: await res.json() };
    };

    it('a customer with invoices (a paid legacy one, say) is refused 400 and not deleted', async () => {
        const deleted = world(1);
        const { status, body } = await del();
        expect(status).toBe(400);
        expect(body.error).toMatch(/invoice/i);
        expect(deleted).toEqual([]);
    });

    it('a customer with no history is still deleted exactly as before', async () => {
        const deleted = world(0);
        expect((await del()).status).toBe(200);
        expect(deleted).toEqual(['customer']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// GUARD 4 — canonical launch idempotency, and no parallel campaign beside an open plan
// ═════════════════════════════════════════════════════════════════════════════

const FAMILY_BUNDLES = [
    { id: 'b-fam1-s5', name: 'Family A (S5)', sku: null, price: 125, serving_tier: 'serves_5', family_id: 'fam1' },
    { id: 'b-fam1-s2', name: 'Family A (S2)', sku: null, price: 70, serving_tier: 'serves_2', family_id: 'fam1' },
];

describe('GUARD 4A · POST /api/opportunities/[id]/launch — at most one campaign per opportunity', () => {
    const OPP = 'opp-1';

    /** Transactions serialize (the claim's row lock) and roll back on throw: staged writes are discarded. */
    function world() {
        const committed = { campaigns: [] as any[], opportunity: { id: OPP, business_id: BIZ, status: 'date_confirmed', customer_id: 'org-1', confirmed_delivery_date: new Date('2026-12-15T00:00:00Z'), campaign_id: null as string | null, converted_at: null as Date | null, customer: { tax_status: null } } };
        let seq = 0;
        const run = serialized();
        currentDb = {
            fundraiserOpportunity: { findFirst: async () => ({ ...committed.opportunity }) },
            bundle: { findMany: async () => FAMILY_BUNDLES },
            fundraiserOrganizationContact: { findFirst: async () => ({ id: 'oc-1', business_id: BIZ, customer_id: 'org-1', ended_at: null }) },
            business: { findUnique: async () => ({ default_food_tax_percent: 1 }) },
            fundraiserCampaign: { findUnique: async ({ where }: any) => committed.campaigns.find((c) => c.id === where.id) ?? null },
            $transaction: (fn: any) => run(async () => {
                const staged: any[] = [];
                let claim: any = null;
                const tx = {
                    fundraiserCampaign: { create: async ({ data }: any) => { const c = { id: `camp-${++seq}`, ...data }; staged.push(c); return { id: c.id }; } },
                    campaignBundle: { createMany: async ({ data }: any) => ({ count: data.length }) },
                    fundraiserCampaignCoordinator: { create: async () => ({}) },
                    fundraiserOpportunity: {
                        updateMany: async ({ where, data }: any) => {
                            const o = committed.opportunity;
                            if (o.id !== where.id || o.status !== where.status || o.campaign_id !== where.campaign_id) return { count: 0 };
                            claim = data;
                            return { count: 1 };
                        },
                    },
                };
                const result = await fn(tx); // a throw here discards `staged` and `claim`: rollback
                committed.campaigns.push(...staged);
                if (claim) Object.assign(committed.opportunity, claim);
                return result;
            }),
        };
        return committed;
    }

    const launch = async () => {
        const { POST } = await import('@/app/api/opportunities/[id]/launch/route');
        const res = await POST(jsonReq(`http://localhost/api/opportunities/${OPP}/launch`, 'POST', {
            name: 'Lincoln PTA Fall Fundraiser', endDate: '2026-12-01', orgContactId: 'oc-1', candidateFamilyIds: ['fam1'], selectionLimit: 1,
        }), ctx(OPP));
        return { status: res.status, body: await res.json() };
    };

    it('two concurrent launches (both passed the pre-check) commit exactly ONE campaign; both answer with it', async () => {
        const committed = world();
        const [a, b] = await Promise.all([launch(), launch()]);
        expect(committed.campaigns).toHaveLength(1);
        const winner = committed.campaigns[0].id;
        expect(committed.opportunity).toMatchObject({ status: 'converted', campaign_id: winner });
        expect([a.body.campaignId, b.body.campaignId]).toEqual([winner, winner]);
        expect([a.body.alreadyLaunched, b.body.alreadyLaunched].sort()).toEqual([false, true]);
        expect([a.status, b.status].sort()).toEqual([200, 201]);
    });

    it('a retry after success resumes the same campaign without creating another', async () => {
        const committed = world();
        const first = await launch();
        const again = await launch();
        expect(committed.campaigns).toHaveLength(1);
        expect(again).toEqual({ status: 200, body: { campaignId: first.body.campaignId, alreadyLaunched: true } });
    });
});

describe('GUARD 4B · POST /api/campaigns never silently creates a campaign beside an OPEN planning cycle', () => {
    function world(openOpportunity: { id: string; status: string } | null, opts: { rebooking?: boolean } = {}) {
        const calls: string[] = [];
        const created: any[] = [];
        const rebookingClaims: string[] = [];
        const db: any = {
            customer: { findFirst: async () => ({ id: 'org-1', tax_status: 'UNKNOWN' }) },
            business: { findUnique: async () => ({ default_food_tax_percent: 1 }) },
            bundle: { findMany: async () => FAMILY_BUNDLES },
            rebookingOpportunity: {
                findFirst: async () => (opts.rebooking ? { id: 'rb-1', business_id: BIZ, customer_id: 'org-1', status: 'approved', campaign_id: null } : null),
                updateMany: async () => { calls.push('rebooking.claim'); rebookingClaims.push('claimed'); return { count: 1 }; },
                update: async () => ({}),
            },
            fundraiserCampaign: {
                findFirst: async () => null,
                create: async ({ data }: any) => { calls.push('campaign.create'); const c = { id: `camp-${created.length + 1}`, ...data }; created.push(c); return c; },
            },
            campaignBundle: { createMany: async () => ({ count: 1 }) },
            fundraiserOpportunity: {
                findFirst: async ({ where }: any) => {
                    calls.push('openPlan.read');
                    expect(where).toMatchObject({ business_id: BIZ, customer_id: 'org-1', status: { in: ['new', 'in_conversation', 'date_confirmed'] } });
                    return openOpportunity;
                },
            },
            $executeRaw: async () => { calls.push('advisory-lock'); return 1; },
        };
        db.$transaction = async (fn: any) => {
            const before = created.length;
            try { return await fn(db); } catch (e) { created.length = before; rebookingClaims.length = 0; throw e; }
        };
        currentDb = db;
        return { calls, created, rebookingClaims };
    }

    const create = async (extra: Record<string, unknown> = {}) => {
        const { POST } = await import('@/app/api/campaigns/route');
        const res = await POST(jsonReq('http://localhost/api/campaigns', 'POST', {
            customerId: 'org-1', name: 'Lincoln PTA 2026 Fundraiser', deliveryDate: '2026-12-15', endDate: '2026-12-01',
            bundleSelection: { mode: 'coordinator_selects', candidateFamilyIds: ['fam1'], selectionLimit: 1 },
            ...extra,
        }));
        return { status: res.status, body: await res.json() };
    };

    it.each(['new', 'in_conversation', 'date_confirmed'])('an open %s plan refuses the wizard 409 and creates nothing', async (status) => {
        const w = world({ id: 'opp-open', status });
        const { status: code, body } = await create();
        expect(code).toBe(409);
        expect(body).toMatchObject({ refusal: 'open_opportunity', openOpportunity: { id: 'opp-open', status } });
        expect(w.created).toHaveLength(0);
        // Read inside the creation transaction, after its advisory lock.
        expect(w.calls.indexOf('advisory-lock')).toBeLessThan(w.calls.indexOf('openPlan.read'));
    });

    it('explicit resolution — naming THAT open plan as separate — creates it, and the plan is left alone', async () => {
        const w = world({ id: 'opp-open', status: 'in_conversation' });
        const { status } = await create({ separateFromOpportunityId: 'opp-open' });
        expect(status).toBe(200);
        expect(w.created).toHaveLength(1);
    });

    it('naming any OTHER id is not a resolution', async () => {
        const w = world({ id: 'opp-open', status: 'new' });
        expect((await create({ separateFromOpportunityId: 'opp-somewhere-else' })).status).toBe(409);
        expect(w.created).toHaveLength(0);
    });

    it('no open plan: created exactly as before (planning while a fundraiser RUNS is never refused)', async () => {
        const w = world(null);
        const { status, body } = await create();
        expect(status).toBe(200);
        expect(body.status).toBe('Active');
        expect(w.created).toHaveLength(1);
    });

    it('the rebooking path is held to the same rule, and its claim is rolled back with everything else', async () => {
        const w = world({ id: 'opp-open', status: 'date_confirmed' }, { rebooking: true });
        const { status } = await create({ opportunityId: 'rb-1' });
        expect(status).toBe(409);
        expect(w.created).toHaveLength(0);
        expect(w.rebookingClaims).toHaveLength(0);
    });

    it('matching is by the durable open-opportunity row only — no campaign name or fundraiser date is consulted', () => {
        const src = read('app/api/campaigns/route.ts');
        const guard = src.slice(src.indexOf('const assertNoOpenPlanningCycle'), src.indexOf('const runCreate'))
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(guard).toContain('openOpportunityWhere(businessId, customerId)');
        expect(guard).not.toMatch(/\bname\b/);
        expect(guard).not.toMatch(/deliveryDate|endDate|delivery_date|end_date|preferred_|confirmed_/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// GUARD 5 — the wizard's organization is created once per session
// ═════════════════════════════════════════════════════════════════════════════

describe('GUARD 5 · createWizardSubmission', () => {
    const ORG = { name: 'Lincoln PTA', contact_name: 'Jo Rivera', contact_email: 'jo@example.test', contact_phone: '555-0100' };
    const CAMPAIGN_BODY = { name: 'Lincoln PTA 2026 Fundraiser', deliveryDate: '2026-12-15' };

    /** A fake API: /api/customers mints ids; /api/campaigns follows a script of responses. */
    function api(script: Array<{ status: number; body: any }>, opts: { delayMs?: number } = {}) {
        const posts: Array<{ url: string; body: any }> = [];
        let orgSeq = 0;
        const fetchImpl = async (url: string, init?: any) => {
            const body = init?.body ? JSON.parse(init.body) : null;
            posts.push({ url, body });
            if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
            if (url === '/api/customers') {
                const id = `org-${++orgSeq}`;
                return { ok: true, status: 200, json: async () => ({ id, ...body }) };
            }
            const next = script.shift() ?? { status: 200, body: { id: 'camp-x', customer_id: body.customerId } };
            return { ok: next.status < 300, status: next.status, json: async () => next.body };
        };
        return { posts, fetchImpl, orgPosts: () => posts.filter((p) => p.url === '/api/customers') };
    }

    it('create org OK → campaign fails → retry: exactly ONE Customer, and the retry uses the ORIGINAL id', async () => {
        const a = api([
            { status: 400, body: { error: 'One or more selected families are no longer available.' } },
            { status: 200, body: { id: 'camp-1', customer_id: 'org-1' } },
        ]);
        const s = createWizardSubmission(a.fetchImpl as any);
        const first = await s.submit({ existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY });
        expect(first).toEqual({ kind: 'error', message: 'One or more selected families are no longer available.', customerId: 'org-1' });
        expect(s.createdOrganizationId).toBe('org-1');

        const retry = await s.submit({ existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY });
        expect(retry).toMatchObject({ kind: 'created', customerId: 'org-1' });
        expect(a.orgPosts()).toHaveLength(1);
        const campaignPosts = a.posts.filter((p) => p.url === '/api/campaigns');
        expect(campaignPosts.map((p) => p.body.customerId)).toEqual(['org-1', 'org-1']);
        expect((retry as any).campaign.customer_id).toBe('org-1');
    });

    it('a double-click (two concurrent submits) joins ONE attempt: one Customer, one campaign request', async () => {
        const a = api([{ status: 200, body: { id: 'camp-1' } }], { delayMs: 5 });
        const s = createWizardSubmission(a.fetchImpl as any);
        const input = { existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY };
        const [x, y] = await Promise.all([s.submit(input), s.submit(input)]);
        expect(x).toBe(y);
        expect(a.orgPosts()).toHaveLength(1);
        expect(a.posts.filter((p) => p.url === '/api/campaigns')).toHaveLength(1);
    });

    it('a retry clicked while the failing attempt is still in flight also joins it; the next retry reuses the org', async () => {
        const a = api([{ status: 500, body: { error: 'Internal Server Error' } }, { status: 200, body: { id: 'camp-2' } }], { delayMs: 5 });
        const s = createWizardSubmission(a.fetchImpl as any);
        const input = { existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY };
        const [x, y] = await Promise.all([s.submit(input), s.submit(input)]);
        expect(x.kind).toBe('error');
        expect(y).toBe(x);
        const z = await s.submit(input);
        expect(z.kind).toBe('created');
        expect(a.orgPosts()).toHaveLength(1);
    });

    it('an existing organization never posts a Customer', async () => {
        const a = api([{ status: 200, body: { id: 'camp-1' } }]);
        const s = createWizardSubmission(a.fetchImpl as any);
        await s.submit({ existingCustomerId: 'org-existing', organization: ORG, campaign: CAMPAIGN_BODY });
        expect(a.orgPosts()).toHaveLength(0);
        expect(a.posts[0].body.customerId).toBe('org-existing');
    });

    it('an open plan comes back as a choice, and "create separately" sends the explicit resolution — still one Customer', async () => {
        const a = api([
            { status: 409, body: { error: 'open plan', refusal: 'open_opportunity', openOpportunity: { id: 'opp-open', status: 'in_conversation' } } },
            { status: 200, body: { id: 'camp-1' } },
        ]);
        const s = createWizardSubmission(a.fetchImpl as any);
        const first = await s.submit({ existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY });
        expect(first).toEqual({ kind: 'open_opportunity', customerId: 'org-1', opportunity: { id: 'opp-open', status: 'in_conversation' }, message: 'open plan' });
        const second = await s.submit({ existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY, separateFromOpportunityId: 'opp-open' });
        expect(second.kind).toBe('created');
        expect(a.posts.filter((p) => p.url === '/api/campaigns').map((p) => p.body.separateFromOpportunityId)).toEqual([undefined, 'opp-open']);
        expect(a.orgPosts()).toHaveLength(1);
    });

    it('an organization create that failed created nothing, so a retry may (and must) create it', async () => {
        let calls = 0;
        const fetchImpl = async (url: string) => {
            if (url === '/api/customers') {
                calls += 1;
                return calls === 1
                    ? { ok: false, status: 500, json: async () => ({ error: 'Failed to create customer' }) }
                    : { ok: true, status: 200, json: async () => ({ id: 'org-9' }) };
            }
            return { ok: true, status: 200, json: async () => ({ id: 'camp-1' }) };
        };
        const s = createWizardSubmission(fetchImpl as any);
        expect((await s.submit({ existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY })).kind).toBe('error');
        expect(s.createdOrganizationId).toBeNull();
        expect(await s.submit({ existingCustomerId: null, organization: ORG, campaign: CAMPAIGN_BODY })).toMatchObject({ kind: 'created', customerId: 'org-9' });
    });

    it('the wizard routes both requests through ONE session submission and keeps the org it created', () => {
        const wiz = read('components/crm2/StartFundraiserWizard.tsx');
        expect(wiz).toContain('createWizardSubmission((url, init) => fetch(url, init))');
        expect(wiz).not.toMatch(/fetch\('\/api\/customers',\s*\{\s*method: 'POST'/);
        expect(wiz).not.toMatch(/fetch\('\/api\/campaigns',\s*\{/);
        expect(wiz).toContain('onClick={() => launch()}');
        expect(wiz).not.toContain('onClick={launch}');
        // Once the org is created, Back (which would let a second one be picked or created) is withdrawn.
        expect(wiz).toMatch(/\{createdOrgId \? <span \/> : \(\s*<button id="wiz-step2-back"/);
        expect(wiz).toContain('onClick={() => launch(openPlanConflict.opportunity.id)}');
        expect(wiz).toContain('href="/fundraisers?tab=leads"');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// GUARD 6 — the one setup-attempt rule, and every surface that counts fundraisers
// ═════════════════════════════════════════════════════════════════════════════

const D = (s: string) => new Date(s);

/** The Production false-start shape: launched, closed out at $0.00 before any order, archived. */
const falseStart = (over: Partial<ImpactCampaignInput> = {}): ImpactCampaignInput => ({
    id: 'fs', status: 'Archived', closed_at: D('2026-08-28T15:00:00Z'), created_at: D('2026-08-28T14:00:00Z'),
    settlement_total: 0, orders: [], settled_externally: false,
    invoices: [{ status: 'DRAFT', total_amount: '0.00', paid_at: null }], ...over,
});

describe('GUARD 6 · isFundraiserSetupAttempt — conservative, positive evidence only', () => {
    it('the Production false start is a setup attempt; so is the same with no invoice or a CANCELED $0.00 one', () => {
        expect(isFundraiserSetupAttempt(falseStart())).toBe(true);
        expect(isFundraiserSetupAttempt(falseStart({ invoices: [] }))).toBe(true);
        expect(isFundraiserSetupAttempt(falseStart({ invoices: [{ status: 'CANCELED', total_amount: 0, paid_at: null }] }))).toBe(true);
        expect(isFundraiserSetupAttempt(falseStart({ status: 'Closed' }))).toBe(true);
        expect(isFundraiserSetupAttempt(falseStart({ status: 'Closed', closed_at: null }))).toBe(true); // closed by status, frozen $0.00
    });

    it('an ACTIVE fundraiser with zero orders today is NEVER one', () => {
        expect(isFundraiserSetupAttempt(falseStart({ status: 'Active', closed_at: null, settlement_total: null, invoices: [] }))).toBe(false);
        expect(isFundraiserSetupAttempt(falseStart({ status: 'Active', closed_at: null, settlement_total: 0 }))).toBe(false);
    });

    it('every piece of evidence keeps a campaign counted', () => {
        // a supporter ordered (even if later canceled)
        expect(isFundraiserSetupAttempt(falseStart({ orders: [{ total_amount: 125, canceled_at: D('2026-08-29T00:00:00Z') }] }))).toBe(false);
        expect(isFundraiserSetupAttempt(falseStart({ orders: [{ total_amount: 0, canceled_at: null }] }))).toBe(false);
        // a non-zero frozen settlement
        expect(isFundraiserSetupAttempt(falseStart({ settlement_total: 245 }))).toBe(false);
        // a settlement nobody froze is unknown, not zero (legacy campaigns closed by status)
        expect(isFundraiserSetupAttempt(falseStart({ settlement_total: null }))).toBe(false);
        // real financial history
        for (const status of ['PAID', 'SENT', 'OVERDUE', 'PENDING']) {
            expect(isFundraiserSetupAttempt(falseStart({ invoices: [{ status, total_amount: '0.00', paid_at: null }] }))).toBe(false);
        }
        expect(isFundraiserSetupAttempt(falseStart({ invoices: [{ status: 'DRAFT', total_amount: '196.00', paid_at: null }] }))).toBe(false);
        expect(isFundraiserSetupAttempt(falseStart({ invoices: [{ status: 'DRAFT', total_amount: '0.00', paid_at: D('2026-09-01T00:00:00Z') }] }))).toBe(false);
        // the owner marked it settled outside FreezerIQ
        expect(isFundraiserSetupAttempt(falseStart({ settled_externally: true }))).toBe(false);
    });

    it('absence is never evidence: without orders or invoices supplied, it counts', () => {
        expect(isFundraiserSetupAttempt(falseStart({ orders: undefined }))).toBe(false);
        expect(isFundraiserSetupAttempt(falseStart({ invoices: undefined }))).toBe(false);
        expect(isFundraiserSetupAttempt(falseStart({ invoices: [{ status: 'DRAFT', total_amount: null, paid_at: null }] }))).toBe(false);
    });

    it('countsAsFundraiserHistory = a real campaign that was not a setup attempt; isRealCampaign itself is unchanged', () => {
        expect(countsAsFundraiserHistory(falseStart())).toBe(false);
        expect(countsAsFundraiserHistory(falseStart({ status: 'Lead', closed_at: null }))).toBe(false);
        expect(countsAsFundraiserHistory(falseStart({ settlement_total: 245 }))).toBe(true);
        expect(isRealCampaign({ status: 'Archived' })).toBe(true);
        expect(isRealCampaign({ status: 'Lead' })).toBe(false);
    });
});

describe('GUARD 6 · computeOrganizationImpact (Campaigns run, the Repeat badge, last campaign)', () => {
    const NOW = D('2026-10-02T12:00:00Z');
    const real = (over: Partial<ImpactCampaignInput> = {}): ImpactCampaignInput => ({
        id: 'real', status: 'Active', closed_at: null, created_at: D('2026-08-28T15:00:00Z'), settlement_total: null, name: 'Fall Fundraiser',
        orders: [{ total_amount: 125, canceled_at: null }, { total_amount: 250, canceled_at: null }], settled_externally: false, invoices: [], ...over,
    });

    it('a false start is not a fundraiser run: count, repeat badge and money', () => {
        const impact = computeOrganizationImpact({
            organizationId: 'org', organizationName: 'Maple County Farm Bureau',
            campaigns: [falseStart({ created_at: D('2026-09-09T00:00:00Z'), name: 'False start' } as any), real({ created_at: D('2026-09-11T00:00:00Z') })],
        }, NOW);
        expect(impact.campaignCount).toBe(1);
        expect(impact.isRepeatOrganization).toBe(false);
        expect(impact.settledCampaignCount).toBe(0); // its frozen $0.00 no longer counts as a settled fundraiser
        expect(impact.lifetimeFundraiserSales).toBe(375); // unchanged — the false start sold nothing
        expect(impact.lastCampaignName).toBe('Fall Fundraiser');
        expect(impact.averageCampaignSales).toBe(375);
    });

    it('an organization whose only campaign was a false start has run no fundraisers', () => {
        const impact = computeOrganizationImpact({ organizationId: 'o', organizationName: 'x', campaigns: [falseStart()] }, NOW);
        expect(impact).toMatchObject({ campaignCount: 0, lastCampaignAt: null, isRepeatOrganization: false, averageCampaignSales: null, bestCampaignSales: null });
    });

    it('a caller that supplies no invoice evidence (automation) keeps the old count — absence is not evidence', () => {
        const noEvidence = { ...falseStart(), invoices: undefined };
        expect(computeOrganizationImpact({ organizationId: 'o', organizationName: 'x', campaigns: [noEvidence] }, NOW).campaignCount).toBe(1);
    });

    it('the Organizations tab route loads the evidence and hands it to the same rule', () => {
        const src = read('app/api/growth/organizations/route.ts');
        expect(src).toContain('settled_externally: true,');
        expect(src).toContain('select: { status: true, total_amount: true, paid_at: true },');
        expect(src).toContain('settled_externally: c.settled_externally,');
        expect(src).toMatch(/invoices: c\.invoices\.map\(\(i\) => \(\{\s*status: String\(i\.status\),/);
    });
});

describe('GUARD 6 · the organization dashboard', () => {
    const ORG = 'org-maple';
    const NOW = D('2026-10-02T12:00:00Z');
    const camp = (over: Partial<DashboardCampaignInput>): DashboardCampaignInput => ({
        id: 'x', name: 'Fundraiser', status: 'Closed', closed_at: null, created_at: D('2026-03-23T00:00:00Z'),
        start_date: null, end_date: null, delivery_date: null, settlement_total: null, settled_externally: false,
        bundle_selection_status: 'selected', invoices: [], activeBundles: [], ...over,
    });
    const order = (id: string, campaign: string, amount: number, canceled = false): DashboardOrderInput => ({
        id, campaign_id: campaign, total_amount: String(amount), canceled_at: canceled ? D('2026-09-30T00:00:00Z') : null,
        items: [{ quantity: 1, item_name: 'Comfort Classics', variant_size: 'serves_5', bundle_id: null }],
    });

    /** A real-shaped organization: a sold spring, a $0.00 false start, a closed fall, and a fundraiser running with no orders yet. */
    const campaigns: DashboardCampaignInput[] = [
        camp({ id: 'spring', name: 'Spring (archived, sold, never invoiced)', status: 'Archived', delivery_date: D('2026-05-13T00:00:00Z') }),
        camp({
            id: 'falsestart', name: 'October false start', status: 'Archived', closed_at: D('2026-08-28T15:00:00Z'),
            created_at: D('2026-08-28T14:00:00Z'), delivery_date: D('2026-10-14T00:00:00Z'), settlement_total: '0.00', bundle_selection_status: 'pending',
            invoices: [{ id: 'inv-0', status: 'DRAFT', total_amount: '0.00', paid_at: null, fundraiser_profit_amount: '0', items: [] }],
        }),
        camp({
            id: 'fall', name: 'Fall (closed, SENT)', status: 'Closed', closed_at: D('2026-10-01T15:00:00Z'), created_at: D('2026-08-28T15:00:00Z'),
            delivery_date: D('2026-10-14T00:00:00Z'), settlement_total: '5600.00',
            invoices: [{ id: 'inv-qbo-sent', status: 'SENT', total_amount: '4480.00', paid_at: null, fundraiser_profit_amount: '1120.00',
                items: [{ bundle_id: null, description: 'Comfort Classics', variant_size: 'serves_5', quantity: '46', total: '5600' }] }],
        }),
        camp({ id: 'next', name: 'Spring 2027 (running, no orders yet)', status: 'Active', created_at: D('2026-10-01T00:00:00Z'), delivery_date: D('2027-04-15T00:00:00Z') }),
    ];
    const orders = [order('s1', 'spring', 1980), order('f1', 'fall', 5600), order('f2', 'fall', 125, true)];

    const input = (over: Partial<OrganizationDashboardInput> = {}): OrganizationDashboardInput => ({
        organization: { id: ORG, name: 'Maple County Farm Bureau', archived: false },
        timeZone: 'America/Chicago',
        campaigns,
        orders,
        audience: { businessId: BIZ, organizationCustomerId: ORG, priorCampaignIds: campaigns.map((c) => c.id), organizationCustomerIds: new Set([ORG]), orders: [], suppressedEmails: new Set() },
        openOpportunity: null,
        marketing: { seasonal: [], previousSupporters: [], rebookingResponses: [] },
        ...over,
    });

    it('Campaigns Run leaves the false start out; lifetime sales are unchanged', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        expect(dash.kpis.campaignsRun).toBe(3); // spring, fall, and the running one — not the false start
        expect(dash.kpis.lifetimeSales).toBe(1980 + 5600);
    });

    it('the false start is never the Last Fundraiser', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        expect(dash.intelligence.lastFundraiser?.campaignId).toBe('fall');
    });

    it('the month pattern is computed without it ("October (2 of 3)" was the false start\'s doing)', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        // Dated, run fundraisers: May (spring), October (fall), April (next) — no repeating month.
        expect(dash.intelligence.timing).toEqual({ label: 'No repeating month yet (April, May and October)', muted: false, datedCount: 3 });
        const withIt = buildOrganizationDashboard(input({ campaigns: campaigns.map((c) => (c.id === 'falsestart' ? { ...c, settlement_total: '1.00' } : c)) }), NOW);
        expect(withIt.intelligence.timing.label).toBe('October (2 of 4 fundraisers)');
    });

    it('its $0.00 draft raises no "review and send" follow-up; the real SENT invoice still does', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        expect(dash.current.invoiceFollowUps.map((f) => f.campaignId)).toEqual(['fall']);
        expect(dash.current.invoiceFollowUps[0].label).toBe('Invoice sent — awaiting payment');
    });

    it('it stays visible in history — marked as not run, never as a fundraiser', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        const fs = dash.history.find((r) => r.id === 'falsestart')!;
        expect(fs).toMatchObject({
            isSetupAttempt: true,
            metricsLabel: 'Never ran — closed before any orders · not counted as a fundraiser',
            invoiceLabel: 'Draft for $0 — nothing to collect',
            invoiceTone: 'neutral',
        });
        expect(dash.history.filter((r) => r.isSetupAttempt).map((r) => r.id)).toEqual(['falsestart']);
        expect(dash.history).toHaveLength(4);
    });

    it('a running fundraiser with zero orders today is current work, counted, and not a setup attempt', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        expect(dash.current.campaigns.map((c) => c.id)).toEqual(['next']);
        expect(dash.current.campaigns[0].figuresLine).toBe('No orders yet');
        expect(dash.history.find((r) => r.id === 'next')!.isSetupAttempt).toBe(false);
    });

    it('an archived fundraiser with historic sales counts', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        expect(dash.history.find((r) => r.id === 'spring')).toMatchObject({ isSetupAttempt: false, gross: 1980 });
    });

    it('the Organizations tab and the dashboard agree on Campaigns Run for the same rows', () => {
        const dash = buildOrganizationDashboard(input(), NOW);
        const impact = computeOrganizationImpact({
            organizationId: ORG, organizationName: 'Maple County Farm Bureau',
            campaigns: campaigns.map((c) => ({
                id: c.id, status: c.status, name: c.name, closed_at: c.closed_at, created_at: c.created_at,
                settlement_total: c.settlement_total === null ? null : Number(c.settlement_total),
                orders: orders.filter((o) => o.campaign_id === c.id).map((o) => ({ total_amount: Number(o.total_amount), canceled_at: o.canceled_at as Date | null })),
                settled_externally: c.settled_externally,
                invoices: c.invoices.map((i) => ({ status: i.status, total_amount: i.total_amount === undefined || i.total_amount === null ? null : Number(i.total_amount), paid_at: (i.paid_at as any) ?? null })),
            })),
        }, NOW);
        expect(impact.campaignCount).toBe(dash.kpis.campaignsRun);
    });

    it('the loader reads each invoice\'s amount and payment date — the evidence the rule needs', () => {
        const src = read('lib/organizationDashboardData.ts');
        expect(src).toMatch(/total_amount: true,\s*paid_at: true,/);
        expect(src).toContain("total_amount: i.total_amount === null || i.total_amount === undefined ? null : String(i.total_amount),");
    });

    it('the history list renders the "Not run" chip for a setup attempt', () => {
        expect(read('components/crm2/orgDashboard/CampaignHistoryList.tsx')).toContain('{r.isSetupAttempt && (');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// GUARD 7 — compatibility across every campaign shape
// ═════════════════════════════════════════════════════════════════════════════

describe('GUARD 7 · compatibility matrix — lifecycle, invoice wording and fundraiser counting', () => {
    const NOW = D('2026-10-02T12:00:00Z');
    type Shape = {
        name: string;
        lifecycle: CampaignLifecycleInput;
        impact: ImpactCampaignInput;
        expect: { counted: boolean; bucket: string; label: string; reviewInvoice: boolean };
    };
    const base = { id: 'c', created_at: D('2026-08-01T00:00:00Z') };
    const shapes: Shape[] = [
        {
            name: 'active campaign with zero orders',
            lifecycle: { status: 'Active', closed_at: null, invoice_statuses: [], settlement_total: null, held_order_count: 0 },
            impact: { ...base, status: 'Active', closed_at: null, settlement_total: null, orders: [], invoices: [] },
            expect: { counted: true, bucket: 'open', label: 'Not yet invoiced', reviewInvoice: false },
        },
        {
            name: 'active campaign with sales',
            lifecycle: { status: 'Active', closed_at: null, invoice_statuses: [], settlement_total: null, held_order_count: 15 },
            impact: { ...base, status: 'Active', closed_at: null, settlement_total: null, orders: [{ total_amount: 1410, canceled_at: null }], invoices: [] },
            expect: { counted: true, bucket: 'open', label: 'Not yet invoiced', reviewInvoice: false },
        },
        {
            name: 'closed with sales + DRAFT',
            lifecycle: { status: 'Archived', closed_at: '2026-09-10', invoice_statuses: ['DRAFT'], settlement_total: 245, held_order_count: 2 },
            impact: { ...base, status: 'Archived', closed_at: D('2026-09-10T00:00:00Z'), settlement_total: 245, orders: [{ total_amount: 245, canceled_at: null }], invoices: [{ status: 'DRAFT', total_amount: '196.00' }] },
            expect: { counted: true, bucket: 'closed_awaiting_payment', label: 'Draft invoice — review and send', reviewInvoice: true },
        },
        {
            name: 'closed + SENT',
            lifecycle: { status: 'Closed', closed_at: '2026-10-01', invoice_statuses: ['SENT'], settlement_total: 5600, held_order_count: 45 },
            impact: { ...base, status: 'Closed', closed_at: D('2026-10-01T00:00:00Z'), settlement_total: 5600, orders: [{ total_amount: 5600, canceled_at: null }], invoices: [{ status: 'SENT', total_amount: '4480.00' }] },
            expect: { counted: true, bucket: 'closed_awaiting_payment', label: 'Invoice sent — awaiting payment', reviewInvoice: true },
        },
        {
            name: 'closed + PAID',
            lifecycle: { status: 'Closed', closed_at: '2026-08-24', invoice_statuses: ['PAID'], settlement_total: 250, held_order_count: 2 },
            impact: { ...base, status: 'Closed', closed_at: D('2026-08-24T00:00:00Z'), settlement_total: 250, orders: [{ total_amount: 250, canceled_at: null }], invoices: [{ status: 'PAID', total_amount: '202.50', paid_at: D('2026-09-01T12:00:00Z') }] },
            expect: { counted: true, bucket: 'completed', label: 'Paid', reviewInvoice: false },
        },
        {
            name: 'archived with historic sales (no invoice, never closed out)',
            lifecycle: { status: 'Archived', closed_at: null, invoice_statuses: [], settlement_total: null, held_order_count: 17 },
            impact: { ...base, status: 'Archived', closed_at: null, settlement_total: null, orders: [{ total_amount: 1980, canceled_at: null }], invoices: [] },
            expect: { counted: true, bucket: 'closed_awaiting_payment', label: 'Not yet invoiced', reviewInvoice: true },
        },
        {
            name: 'legacy closed-by-status campaign, no data (its money may sit on a campaign-less legacy invoice)',
            lifecycle: { status: 'Closed', closed_at: null, invoice_statuses: [], settlement_total: null, held_order_count: 0 },
            impact: { ...base, status: 'Closed', closed_at: null, settlement_total: null, orders: [], invoices: [] },
            expect: { counted: true, bucket: 'completed', label: 'Not yet invoiced', reviewInvoice: false },
        },
        {
            name: 'no-sale archived false start ($0.00 draft)',
            lifecycle: { status: 'Archived', closed_at: '2026-08-28', invoice_statuses: ['DRAFT'], settlement_total: 0, held_order_count: 0 },
            impact: { ...base, status: 'Archived', closed_at: D('2026-08-28T00:00:00Z'), settlement_total: 0, orders: [], invoices: [{ status: 'DRAFT', total_amount: '0.00' }] },
            expect: { counted: false, bucket: 'completed', label: 'Draft for $0 — nothing to collect', reviewInvoice: false },
        },
        {
            name: 'closed before supporter activity under the new closeout (no invoice at all)',
            lifecycle: { status: 'Closed', closed_at: '2026-10-02', invoice_statuses: [], settlement_total: 0, held_order_count: 0 },
            impact: { ...base, status: 'Closed', closed_at: D('2026-10-02T00:00:00Z'), settlement_total: 0, orders: [], invoices: [] },
            expect: { counted: false, bucket: 'completed', label: 'No invoice needed — nothing was sold', reviewInvoice: false },
        },
        {
            name: '$0.00 draft whose fundraiser still holds a $0.00 order (still a task: it releases the order)',
            lifecycle: { status: 'Closed', closed_at: '2026-10-02', invoice_statuses: ['DRAFT'], settlement_total: 0, held_order_count: 1 },
            impact: { ...base, status: 'Closed', closed_at: D('2026-10-02T00:00:00Z'), settlement_total: 0, orders: [{ total_amount: 0, canceled_at: null }], invoices: [{ status: 'DRAFT', total_amount: '0.00' }] },
            expect: { counted: true, bucket: 'closed_awaiting_payment', label: 'Draft invoice — review and send', reviewInvoice: true },
        },
    ];

    it.each(shapes.map((s) => [s.name, s] as const))('%s', (_name, s) => {
        expect(countsAsFundraiserHistory(s.impact)).toBe(s.expect.counted);
        expect(classifyCampaignLifecycle(s.lifecycle)).toBe(s.expect.bucket);
        expect(describeCampaignInvoice(s.lifecycle).label).toBe(s.expect.label);
        const triage = triageCampaign({ ...(s.lifecycle as any), status: s.lifecycle.status === 'Archived' ? 'Closed' : s.lifecycle.status } as CampaignForTriage, NOW);
        expect(triage.action?.label === 'Review invoice' || triage.action?.label === 'Create invoice').toBe(s.expect.reviewInvoice);
    });

    it('the zero-dollar draft rule is the frozen settlement plus the live-order count, nothing weaker', () => {
        const zero = { status: 'Closed', closed_at: '2026-10-02', invoice_statuses: ['DRAFT'], settlement_total: 0, held_order_count: 0 };
        expect(isZeroDollarCloseoutDraft(zero)).toBe(true);
        expect(isZeroDollarCloseoutDraft({ ...zero, held_order_count: undefined })).toBe(false); // unknown live orders
        expect(isZeroDollarCloseoutDraft({ ...zero, settlement_total: null })).toBe(false);
        expect(isZeroDollarCloseoutDraft({ ...zero, settlement_total: 0.5 })).toBe(false);
        expect(isZeroDollarCloseoutDraft({ ...zero, invoice_statuses: ['DRAFT', 'PAID'] })).toBe(false);
        expect(isZeroDollarCloseoutDraft({ ...zero, closed_at: null, status: 'Active' })).toBe(false);
        expect(assessObligation(zero)).toBe('none');
    });
});
