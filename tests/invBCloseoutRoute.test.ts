/**
 * INV-B — the closeout route, executed.
 *
 * These drive the real POST handler. The doubles model the two behaviours that
 * matter and cannot be faked convincingly: the campaign claim only succeeds for
 * a campaign that is still open (so two concurrent closeouts cannot both win),
 * and invoice creation raises Prisma's P2002 when a campaign already has one (so
 * idempotency is the database's guarantee, not a disabled button).
 */

const calls: Array<{ op: string; args?: any }> = [];

let campaignRow: any;
let ordersRow: any[];
let invoiceRows: any[];
let claimShouldFail = false;

const mkPrisma = () => ({
    $transaction: async (fn: any) => fn(txClient),
    fundraiserCampaign: {
        findUnique: async () => campaignRow,
    },
    invoice: {
        findFirst: async ({ where }: any) =>
            invoiceRows.find((i) => i.campaign_id === where.campaign_id) ?? null,
    },
    user: { findFirst: async ({ where }: any) => ({ id: where.id ?? 'user-admin' }) },
});

const txClient: any = {
    $executeRawUnsafe: async (sql: string, ...v: unknown[]) => {
        calls.push({ op: 'ADVISORY_LOCK', args: { sql, key: v[0] } });
        return 1;
    },
    order: {
        findMany: async () => {
            calls.push({ op: 'orders.findMany' });
            return ordersRow;
        },
        updateMany: async (a: any) => { calls.push({ op: 'orders.promote', args: a }); return { count: 1 }; },
    },
    fundraiserCampaign: {
        updateMany: async (a: any) => {
            calls.push({ op: 'campaign.claim', args: a });
            if (claimShouldFail) return { count: 0 };
            campaignRow = { ...campaignRow, ...a.data, closed_at: a.data.closed_at };
            return { count: 1 };
        },
    },
    invoice: {
        create: async (a: any) => {
            calls.push({ op: 'invoice.create', args: a });
            if (invoiceRows.some((i) => i.campaign_id === a.data.campaign_id)) {
                const err: any = new Error('Unique constraint failed');
                err.code = 'P2002';
                throw err;
            }
            const row = { id: 'inv-new', ...a.data };
            invoiceRows.push(row);
            return { id: row.id };
        },
        findFirst: async ({ where }: any) =>
            invoiceRows.find((i) => i.campaign_id === where.campaign_id) ?? null,
    },
};

jest.mock('@/lib/db', () => ({ get prisma() { return mkPrisma(); } }));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const BIZ = 'biz-a';
const CAMPAIGN = 'camp-1';

const item = (name: string, variant: string, qty: number, price: number) => ({
    bundle_id: 'b-' + name, quantity: qty, unit_price: price,
    variant_size: variant, item_name: name, bundle: { name },
});

/** Edgar, as it exists in Production: 4 products across 17 active orders. */
const edgarOrders = () => [
    { id: 'o1', total_amount: 1020, items: [item('Q2 - Comfort Foods (Serves 2)', 'serves_2', 17, 60)] },
    { id: 'o2', total_amount: 420, items: [item('Q1 - Hearty Meals (Serves 2)', 'serves_2', 7, 60)] },
    { id: 'o3', total_amount: 375, items: [item('Q1 - Hearty Meals', 'serves_5', 3, 125)] },
    { id: 'o4', total_amount: 250, items: [item('Q2 - Comfort Foods', 'serves_5', 2, 125)] },
];

const post = async (body?: any) => {
    const { POST } = await import('@/app/api/campaigns/[id]/closeout/route');
    return POST(
        new Request('http://localhost/api/campaigns/' + CAMPAIGN + '/closeout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        }) as any,
        { params: Promise.resolve({ id: CAMPAIGN }) } as any,
    );
};

beforeEach(() => {
    calls.length = 0;
    claimShouldFail = false;
    invoiceRows = [];
    ordersRow = edgarOrders();
    campaignRow = {
        id: CAMPAIGN, status: 'Active', closed_at: null, settlement_total: null,
        org_share_percent: 20, customer: { id: 'cust-1', business_id: BIZ },
        // FR-TAX-1B: the campaign's own FROZEN tax snapshot is what drives the
        // closeout's tax, never a product constant or the tenant's live default.
        tax_status: 'TAXABLE', tax_rate_percent: 1,
    };
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({
        user: { id: 'user-admin', email: 'a@t.test', businessId: BIZ, role: 'ADMIN', isSuperAdmin: false },
    });
});

describe('closeout joins the shared campaign lock', () => {
    it('acquires the advisory lock BEFORE reading any order', async () => {
        await post({ applyFoodTax: false });

        const lockAt = calls.findIndex((c) => c.op === 'ADVISORY_LOCK');
        const readAt = calls.findIndex((c) => c.op === 'orders.findMany');
        expect(lockAt).toBeGreaterThanOrEqual(0);
        expect(readAt).toBeGreaterThan(lockAt);
    });

    it('locks on THIS campaign, using the same namespaced key as the order path', async () => {
        const { campaignSelectionLockKey } = await import('@/lib/campaignSelectionLock');
        await post({ applyFoodTax: false });

        const lock = calls.find((c) => c.op === 'ADVISORY_LOCK')!;
        expect(lock.args.key).toBe(campaignSelectionLockKey(CAMPAIGN));
        expect(lock.args.sql).toContain('pg_advisory_xact_lock');
    });

    it('locks before the claim and before invoice creation', async () => {
        await post({ applyFoodTax: false });
        const order = calls.map((c) => c.op);
        expect(order.indexOf('ADVISORY_LOCK')).toBeLessThan(order.indexOf('campaign.claim'));
        expect(order.indexOf('ADVISORY_LOCK')).toBeLessThan(order.indexOf('invoice.create'));
    });
});

describe('closeout creates exactly one DRAFT invoice', () => {
    it('produces a DRAFT with aggregated bundle lines and correct money', async () => {
        const res = await post({ applyFoodTax: true });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.invoice_status).toBe('DRAFT');
        expect(body.settlement_total).toBe(2065);
        expect(body.financials).toMatchObject({
            gross_sales: 2065,
            org_share_percent: 20,
            organization_amount: 413,
            base_remit: 1652,
            tax_applied: true,
            tax_rate_percent: 1,
            // FR-TAX-1B: 1% of the NET $1,652, not of the $2,065 gross.
            tax_amount: 16.52,
            total_due: 1668.52,
        });

        const created = calls.find((c) => c.op === 'invoice.create')!.args.data;
        expect(created.status).toBe('DRAFT');
        expect(created.campaign_id).toBe(CAMPAIGN);
        expect(created.generated_at).toBeInstanceOf(Date);
        expect(Number(created.total_amount)).toBe(1668.52);
        expect(Number(created.tax_amount)).toBe(16.52);
        expect(Number(created.fundraiser_profit_amount)).toBe(413);
        expect(created.items.create).toHaveLength(4);
        // FR-TAX-1B: the tax contract is frozen ONTO the invoice, so the row is
        // self-describing and Square never has to recompute anything.
        expect(Number(created.tax_rate_percent)).toBe(1);
        expect(created.tax_status).toBe('TAXABLE');
        expect(Number(created.taxable_base_amount)).toBe(1652);
    });

    it('FR-TAX-1B: a campaign with NO tax snapshot is charged no tax', async () => {
        // The deliberate legacy rule: a campaign launched before FR-TAX-1 was
        // agreed under the superseded gross basis, so neither that basis nor a
        // rate nobody chose may be applied to it now. See resolveCloseoutTaxRate.
        campaignRow.tax_status = null;
        campaignRow.tax_rate_percent = null;
        const body = await (await post({ applyFoodTax: true })).json();
        expect(body.financials.tax_applied).toBe(false);
        expect(body.financials.tax_amount).toBe(0);
        expect(body.financials.total_due).toBe(1652);
    });

    it('FR-TAX-1B: a TAX_EXEMPT campaign is charged no tax even with the switch ON', async () => {
        campaignRow.tax_status = 'TAX_EXEMPT';
        campaignRow.tax_rate_percent = 0;
        const body = await (await post({ applyFoodTax: true })).json();
        expect(body.financials.tax_applied).toBe(false);
        expect(body.financials.tax_amount).toBe(0);
        expect(body.financials.total_due).toBe(1652);
    });

    it('the tax toggle OFF yields no tax and a total equal to the remit', async () => {
        const body = await (await post({ applyFoodTax: false })).json();
        expect(body.financials.tax_applied).toBe(false);
        expect(body.financials.tax_amount).toBe(0);
        expect(body.financials.total_due).toBe(1652);

        const created = calls.find((c) => c.op === 'invoice.create')!.args.data;
        expect(Number(created.tax_amount)).toBe(0);
        expect(Number(created.total_amount)).toBe(1652);
    });

    it('invoice lines carry variant_size so serves_5 and serves_2 stay distinguishable', async () => {
        await post({ applyFoodTax: false });
        const items = calls.find((c) => c.op === 'invoice.create')!.args.data.items.create;
        const sizes = items.map((i: any) => i.variant_size).sort();
        expect(sizes).toEqual(['serves_2', 'serves_2', 'serves_5', 'serves_5']);
        const s2 = items.find((i: any) => i.description.includes('Comfort Foods (Serves 2)'));
        expect(s2).toMatchObject({ quantity: 17, unit_price: 60, total: 1020 });
    });

    it('line totals reconcile exactly to the frozen settlement_total', async () => {
        const body = await (await post({ applyFoodTax: true })).json();
        const sum = body.lines.reduce((s: number, l: any) => s + l.total, 0);
        expect(sum).toBe(body.settlement_total);
    });

    it('does NOT create one line per supporter order', async () => {
        // Split Edgar's 17 serves_2 across 17 separate orders.
        ordersRow = Array.from({ length: 17 }, (_, i) => ({
            id: 'o' + i, total_amount: 60,
            items: [item('Q2 - Comfort Foods (Serves 2)', 'serves_2', 1, 60)],
        }));
        await post({ applyFoodTax: false });
        const items = calls.find((c) => c.op === 'invoice.create')!.args.data.items.create;
        expect(items).toHaveLength(1);
        expect(items[0].quantity).toBe(17);
    });
});

describe('closeout has no send or payment side effects', () => {
    it('never marks SENT or PAID and never emails', async () => {
        await post({ applyFoodTax: true });
        const created = calls.find((c) => c.op === 'invoice.create')!.args.data;
        expect(created.status).toBe('DRAFT');
        expect(created.status).not.toBe('SENT');
        expect(created.status).not.toBe('PAID');
        expect(JSON.stringify(created)).not.toMatch(/paid_at|sent_at|email/i);
        expect(calls.some((c) => /email|send/i.test(c.op))).toBe(false);
    });

    it('still promotes held fundraiser orders, after the claim', async () => {
        await post({ applyFoodTax: false });
        const ops = calls.map((c) => c.op);
        expect(ops).toContain('orders.promote');
        expect(ops.indexOf('campaign.claim')).toBeLessThan(ops.indexOf('orders.promote'));
    });
});

describe('reconciliation fails closed', () => {
    it('an order with a total but no items refuses closeout with 409', async () => {
        ordersRow = [{ id: 'order-brew-2', total_amount: 125, items: [] }];

        const res = await post({ applyFoodTax: false });
        expect(res.status).toBe(409);

        const body = await res.json();
        expect(body.reconciliation.bundle_line_total).toBe(0);
        expect(body.reconciliation.order_gross_total).toBe(125);
        expect(body.reconciliation.detail).toContain('order-brew-2');
        expect(calls.some((c) => c.op === 'invoice.create')).toBe(false);
    });

    it('a partial mismatch also refuses, and writes no invoice', async () => {
        ordersRow = [
            ...edgarOrders(),
            { id: 'bad', total_amount: 99, items: [] },
        ];
        const res = await post({ applyFoodTax: false });
        expect(res.status).toBe(409);
        expect(calls.some((c) => c.op === 'invoice.create')).toBe(false);
    });
});

describe('idempotency is enforced by the database', () => {
    it('a unique-violation on the campaign invoice reuses the existing one', async () => {
        invoiceRows.push({ id: 'inv-existing', campaign_id: CAMPAIGN });

        const body = await (await post({ applyFoodTax: false })).json();
        expect(body.invoice_id).toBe('inv-existing');
        // It attempted the insert and recovered — it did not pre-check and skip.
        expect(calls.some((c) => c.op === 'invoice.create')).toBe(true);
        expect(invoiceRows).toHaveLength(1);
    });

    it('a losing concurrent closeout returns the winner\'s invoice, not a new one', async () => {
        claimShouldFail = true;
        invoiceRows.push({ id: 'inv-winner', campaign_id: CAMPAIGN });

        const body = await (await post({ applyFoodTax: false })).json();
        expect(body.idempotent).toBe(true);
        expect(body.invoice_id).toBe('inv-winner');
        expect(invoiceRows).toHaveLength(1);
    });

    it('a retry after a successful closeout returns the same invoice', async () => {
        campaignRow = { ...campaignRow, status: 'Closed', closed_at: new Date(), settlement_total: 2065 };
        invoiceRows.push({ id: 'inv-first', campaign_id: CAMPAIGN, status: 'DRAFT' });

        const body = await (await post({ applyFoodTax: false })).json();
        expect(body.idempotent).toBe(true);
        expect(body.invoice_id).toBe('inv-first');
        expect(body.invoice_status).toBe('DRAFT');
        expect(calls.some((c) => c.op === 'invoice.create')).toBe(false);
        expect(calls.some((c) => c.op === 'orders.promote')).toBe(false);
    });
});

describe('order inclusion rule', () => {
    it('reads only non-cancelled orders for this campaign', async () => {
        await post({ applyFoodTax: false });
        // The route's own where-clause is the contract; assert it directly.
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app/api/campaigns/[id]/closeout/route.ts'), 'utf8');
        expect(src).toMatch(/campaign_id: campaignId,\s*\n\s*canceled_at: null/);
        // Payment status must NOT be a filter.
        expect(src).not.toMatch(/where:\s*\{[^}]*payment_processor/);
    });

    it('offline/unpaid submitted orders still count toward gross', async () => {
        ordersRow = [
            { id: 'card', total_amount: 125, items: [item('Q1 - Hearty Meals', 'serves_5', 1, 125)] },
            { id: 'check', total_amount: 125, items: [item('Q1 - Hearty Meals', 'serves_5', 1, 125)] },
        ];
        const body = await (await post({ applyFoodTax: false })).json();
        expect(body.settlement_total).toBe(250);
        expect(body.financials.organization_amount).toBe(50);
    });
});
