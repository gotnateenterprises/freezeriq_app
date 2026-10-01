/**
 * COORD-CLOSEOUT-PICKUP-1 — closeout populates the coordinator's pickup documents;
 * invoice payment still releases production.
 *
 * Owner ruling (October 1, 2026): the real workflow is close → the final order list is locked →
 * the coordinator reconciles the pickup sheet → the organization pays its invoice → only then is
 * the food released. Both pickup documents (the printable tracker and the XLSX sheet) used to be
 * released-only, so a closed fundraiser whose invoice was still unpaid printed an empty list on
 * exactly the day the coordinator needed it.
 *
 * The rule now (lib/coordinatorSupporterOrders.ts, contract §9.1):
 *   closed campaign  every non-canceled order — closeout's own inclusion rule — held or released
 *   open campaign    unchanged: released work only, and the document says it is not final
 *
 * Numbered tests map 1:1 to the phase's required list. Route tests run the REAL handlers against
 * the shared recording Prisma double; every database call they make is recorded, so "zero writes"
 * is asserted on what the handler actually did.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    isPickupDocumentOrder,
    isPickupEligibleOrder,
    pickupDocumentOrderWhere,
    pickupDocumentState,
    PICKUP_DOCUMENT_STATUS_COPY,
} from '@/lib/coordinatorSupporterOrders';
import { isProductionEligibleOrder, PRODUCTION_ORDER_EXCLUSIONS } from '@/lib/productionIntake';
import { supporterAmountDue } from '@/lib/fundraiserTax';
import { PAYMENT_NOT_MARKED_LABEL, PAYMENT_PAID_LABEL } from '@/lib/supporterPayment';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Executable code only. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ccpuPrisma; } }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => ((global as any).__ccpuAuthed && name === (global as any).__ccpuCookieName
            ? { name, value: 'ccpu-session-secret' } : undefined),
        set: () => undefined,
        delete: () => undefined,
    }),
}));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ccpuPrisma = m.client; };

const CLOSED = 'camp-ccpu-closed';
const OPEN = 'camp-ccpu-open';
const ORG = 'org-ccpu';

const campaign = (over: Record<string, unknown> = {}) => ({
    id: CLOSED, name: 'Example County Fundraiser', status: 'Closed', closed_at: new Date('2026-10-01T00:24:45Z'),
    customer_id: ORG, bundle_selection_status: 'selected', bundle_selection_limit: 2, end_date: new Date('2026-09-30T00:00:00Z'),
    delivery_date: new Date('2026-10-17T00:00:00Z'), delivery_time: '4:00 PM', pickup_location: 'Farm Bureau office',
    payment_instructions: 'Pay your coordinator',
    customer: { name: 'Example County Farm Bureau', contact_name: 'Pat', business_id: 'biz-ccpu', business: { name: 'Freezer Chef', display_name: 'Freezer Chef', plan: 'PRO' } },
    ...over,
});
const openCampaign = (over: Record<string, unknown> = {}) =>
    campaign({ id: OPEN, status: 'Active', closed_at: null, bundle_selection_status: 'not_required', ...over });

interface OrderOpts {
    customerId?: string; name?: string; status?: string; canceled?: boolean; paid?: boolean;
    total?: number; tax?: number; bundle?: string; size?: 'serves_5' | 'serves_2'; qty?: number;
}
const order = (id: string, o: OrderOpts = {}) => {
    const bundleId = o.bundle ?? 'bundle-ff-5';
    const bundleName = bundleId.includes('keto') ? 'Keto Bundle - Fall 2026' : 'Family Friendly - Fall 2026';
    return {
        id, customer_name: o.name ?? `Supporter ${id}`, participant_name: null,
        total_amount: (o.total ?? 125).toFixed(2), tax_amount: (o.tax ?? 0).toFixed(2),
        paid_at: o.paid ? new Date('2026-10-01T15:00:00Z') : null, created_at: new Date('2026-09-20T15:00:00Z'),
        canceled_at: o.canceled ? new Date('2026-09-25T15:00:00Z') : null,
        source: 'fundraiser', status: o.status ?? 'fundraiser_hold', phone: '217-555-0100', email: null,
        customer_id: o.customerId ?? `cust-${id}`, customer: { contact_email: `${id}@example.invalid` },
        items: [{
            quantity: o.qty ?? 1, variant_size: o.size ?? 'serves_5', item_name: bundleName, bundle_id: bundleId,
            bundle: { id: bundleId, name: bundleName },
        }],
    };
};

const sessionFor = (campaignId: string) => ({
    id: 'session-ccpu', campaign_id: campaignId, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
});
const docMock = (orders: any[], c = campaign()) => createPrismaMock({
    results: {
        'coordinatorSession.findUnique': sessionFor(String(c.id)),
        'fundraiserCampaign.findFirst': c,
        'order.findMany': orders,
        'bundle.findMany': [],
    },
});

const request = (url: string) => new Request(`http://localhost${url}`, { headers: { origin: 'http://localhost' } });
const tracker = async () => readJson(await require('@/app/api/coordinator/pickup-tracker/route').GET(request('/api/coordinator/pickup-tracker')));
async function sheet() {
    const res: Response = await require('@/app/api/tracker/pickup-sheet/route').GET(request('/api/tracker/pickup-sheet'));
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
    const ws = wb.worksheets[0];
    const row = (n: number) => (ws.getRow(n).values as any[]).slice(1);
    const dataRows: any[][] = [];
    for (let r = 5; r <= ws.rowCount; r++) {
        const v = row(r);
        if (v[1] === 'TOTALS') break;
        dataRows.push(v);
    }
    return {
        status: res.status, status3: String(ws.getCell('A3').value ?? ''), header: row(4), dataRows,
        totals: row(5 + dataRows.length), amountFormat: ws.getRow(5).getCell(row(4).indexOf('Amount\nDue') + 1).numFmt,
        allText: JSON.stringify(ws.getSheetValues()),
    };
}

/** Every recorded database call is a read, and no transaction was opened. */
const READ = /^(findFirst|findUnique|findMany|count|aggregate|groupBy|findFirstOrThrow|findUniqueOrThrow)$/;
function expectZeroWrites(m: PrismaMock) {
    expect(m.calls.length).toBeGreaterThan(0);
    for (const c of m.calls) {
        expect({ call: `${c.model}.${c.method}`, read: READ.test(c.method) && !String(c.model).startsWith('$') })
            .toEqual({ call: `${c.model}.${c.method}`, read: true });
    }
    expect(((m.client as any).$transaction as jest.Mock).mock.calls).toHaveLength(0);
}

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
beforeEach(() => {
    jest.clearAllMocks();
    (global as any).__ccpuCookieName = coordinatorSessionCookieName();
    (global as any).__ccpuAuthed = true;
});

// ═════════════════════════════════════════════════════════════════════════════
// The shared rule
// ═════════════════════════════════════════════════════════════════════════════
describe('the shared pickup-document rule (lib/coordinatorSupporterOrders.ts)', () => {
    const held = { status: 'fundraiser_hold', source: 'fundraiser', canceled_at: null };
    const released = { status: 'production_ready', source: 'fundraiser', canceled_at: null };
    const canceled = { ...held, canceled_at: new Date() };

    it('closed: every non-canceled order, held or released; open: released only; canceled: never', () => {
        expect(isPickupDocumentOrder(held, { closed: true })).toBe(true);
        expect(isPickupDocumentOrder(released, { closed: true })).toBe(true);
        expect(isPickupDocumentOrder(canceled, { closed: true })).toBe(false);
        expect(isPickupDocumentOrder(held, { closed: false })).toBe(false);
        expect(isPickupDocumentOrder(released, { closed: false })).toBe(true);
        expect(isPickupDocumentOrder({ ...released, canceled_at: new Date() }, { closed: false })).toBe(false);
        expect(isPickupDocumentOrder(null, { closed: true })).toBe(false);
    });

    it('one where-clause for both documents: closeout\'s own inclusion rule when closed, the production exclusions when open', () => {
        expect(pickupDocumentOrderWhere('c1', { closed: true })).toEqual({ campaign_id: 'c1', canceled_at: null });
        expect(pickupDocumentOrderWhere('c1', { closed: false })).toEqual({ campaign_id: 'c1', canceled_at: null, AND: [...PRODUCTION_ORDER_EXCLUSIONS] });
        // The closeout route counts exactly this set into the invoice.
        expect(strip(read('app/api/campaigns/[id]/closeout/route.ts'))).toMatch(/campaign_id: campaignId,\s*canceled_at: null/);
    });

    it('the document states its own condition from order statuses — never from an invoice', () => {
        expect(pickupDocumentState({ closed: false }, [held])).toBe('not_final');
        expect(pickupDocumentState({ closed: true }, [held, released])).toBe('final_pending_release');
        expect(pickupDocumentState({ closed: true }, [released])).toBe('final_released');
        expect(pickupDocumentState({ closed: true }, [])).toBe('final_empty');
        // No invoice claim: some closed campaigns' held orders have no invoice, or a canceled one.
        expect(PICKUP_DOCUMENT_STATUS_COPY.final_pending_release).toBe(
            'Fundraiser closed — final orders are shown below. Food has not yet been released to production; it is released when the organization’s invoice is paid.',
        );
        for (const copy of Object.values(PICKUP_DOCUMENT_STATUS_COPY)) expect(copy).not.toMatch(/\bunpaid\b|pending payment/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1–3. Closed + unpaid + held: both documents list the final set; canceled never.
// ═════════════════════════════════════════════════════════════════════════════
describe('1–3. a closed campaign whose invoice is unpaid (a full-size fixture: 45 held, 4 canceled)', () => {
    const fullSizeClosed = () => [
        ...Array.from({ length: 45 }, (_, i) => order(`h${String(i + 1).padStart(2, '0')}`, {
            bundle: i % 2 ? 'bundle-keto-2' : 'bundle-ff-5', size: i % 2 ? 'serves_2' : 'serves_5',
            total: i % 2 ? 60 : 125, paid: true,
        })),
        ...Array.from({ length: 4 }, (_, i) => order(`x${i + 1}`, { name: `Canceled Supporter ${i + 1}`, canceled: true })),
    ];

    it('1. the printable tracker lists every held order — the final list — while each stays fundraiser_hold', async () => {
        const rows = fullSizeClosed();
        useMock(docMock(rows));
        const res = await tracker();
        expect(res.status).toBe(200);
        expect(res.body.supporterCount).toBe(45);
        expect(res.body.totalBundles).toBe(45);
        expect(res.body.document).toEqual({ final: true, state: 'final_pending_release' });
        expect(mock.firstCall('order.findMany')!.args.where).toEqual({ campaign_id: CLOSED, canceled_at: null });
        expect(rows.filter((r) => !r.canceled_at).every((r) => r.status === 'fundraiser_hold')).toBe(true);
    });

    it('2. the XLSX lists every held order, one row per order, under a "final, not yet released" status line', async () => {
        useMock(docMock(fullSizeClosed()));
        const s = await sheet();
        expect(s.status).toBe(200);
        expect(s.dataRows).toHaveLength(45);
        expect(s.status3).toBe(PICKUP_DOCUMENT_STATUS_COPY.final_pending_release);
        expect(mock.firstCall('order.findMany')!.args.where).toEqual({ campaign_id: CLOSED, canceled_at: null });
    });

    it('3. a canceled order appears on neither document — even if the query ever returned one', async () => {
        // The double ignores `where`, so this proves the in-memory second line of defence too.
        useMock(docMock(fullSizeClosed()));
        const t = await tracker();
        expect(JSON.stringify(t.body)).not.toContain('Canceled Supporter');
        useMock(docMock(fullSizeClosed()));
        const s = await sheet();
        expect(s.allText).not.toContain('Canceled Supporter');
        expect(s.totals[1]).toBe('TOTALS');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4–5. Open campaigns, and released campaigns.
// ═════════════════════════════════════════════════════════════════════════════
describe('4–5. before closeout, and after release', () => {
    it('4. an OPEN campaign keeps the released-only rule and says the list is not final', async () => {
        const rows = [order('h1', { name: 'Held Helen' }), order('r1', { name: 'Released Rae', status: 'production_ready' })];
        useMock(docMock(rows, openCampaign()));
        const t = await tracker();
        expect(t.body.document).toEqual({ final: false, state: 'not_final' });
        expect(t.body.groups.map((g: any) => g.customer_name)).toEqual(['Released Rae']);
        expect(JSON.stringify(mock.firstCall('order.findMany')!.args.where.AND)).toContain('fundraiser_hold');

        useMock(docMock(rows, openCampaign()));
        const s = await sheet();
        expect(s.dataRows.map((r) => r[1])).toEqual(['Released Rae']);
        expect(s.status3).toBe(PICKUP_DOCUMENT_STATUS_COPY.not_final);

        // Documented on the page: the empty list explains that closeout fills it.
        const page = read('app/coordinator/portal/pickup-tracker/page.tsx');
        expect(page).toContain('Your final pickup list fills in with every order as soon as this fundraiser closes.');
        expect(page).toContain("'Not final — ordering is still open.'");
    });

    it('4b. the open-campaign copy never calls a live list final', () => {
        expect(PICKUP_DOCUMENT_STATUS_COPY.not_final).toMatch(/not the final pickup list/);
    });

    it('5. a paid/released campaign shows the same rows as before, now marked released', async () => {
        const rows = [order('r1', { name: 'Released One', status: 'production_ready' }), order('r2', { name: 'Released Two', status: 'production_ready' })];
        useMock(docMock(rows));
        const t = await tracker();
        expect(t.body.groups.map((g: any) => g.customer_name)).toEqual(['Released One', 'Released Two']);
        expect(t.body.document).toEqual({ final: true, state: 'final_released' });
        useMock(docMock(rows));
        const s = await sheet();
        expect(s.dataRows.map((r) => r[1])).toEqual(['Released One', 'Released Two']);
        expect(s.status3).toBe(PICKUP_DOCUMENT_STATUS_COPY.final_released);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6–7. Read-only.
// ═════════════════════════════════════════════════════════════════════════════
describe('6–7. opening and downloading write nothing', () => {
    it('6. opening the tracker performs zero writes', async () => {
        useMock(docMock([order('h1'), order('h2', { paid: true })]));
        expect((await tracker()).status).toBe(200);
        expectZeroWrites(mock);
    });

    it('7. downloading the spreadsheet performs zero writes', async () => {
        useMock(docMock([order('h1'), order('h2', { paid: true })]));
        expect((await sheet()).status).toBe(200);
        expectZeroWrites(mock);
    });

    it('6–7. neither route nor the page contains a write, a release, an invoice, QuickBooks or email path', () => {
        for (const f of ['app/api/coordinator/pickup-tracker/route.ts', 'app/api/tracker/pickup-sheet/route.ts', 'app/coordinator/portal/pickup-tracker/page.tsx']) {
            const code = strip(read(f));
            expect({ f, hit: /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$transaction/.test(code) }).toEqual({ f, hit: false });
            expect({ f, hit: /production_ready|settleInvoice|\/settle|quickbooks|sendEmail|resend|method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(code) }).toEqual({ f, hit: false });
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8–12. Money and payment marks.
// ═════════════════════════════════════════════════════════════════════════════
describe('8–12. amount due and payment marks', () => {
    it('8. the printable tracker\'s total is the authoritative amount due (pre-tax total + persisted tax)', async () => {
        useMock(docMock([order('t1', { total: 100, tax: 0.99 })]));
        const t = await tracker();
        expect(t.body.groups[0].total).toBe(100.99);
        expect(t.body.groups[0].total).toBe(supporterAmountDue({ total_amount: '100.00', tax_amount: '0.99' }));
    });

    it('9. the spreadsheet\'s Amount Due is the same authority — the persisted tax, never a recomputed rate', async () => {
        useMock(docMock([order('t1', { total: 100, tax: 0.99 }), order('t2', { total: 60, tax: 0 })]));
        const s = await sheet();
        const amount = s.header.indexOf('Amount\nDue');
        expect(s.header.slice(-2)).toEqual(['Amount\nDue', 'Payment']);
        expect(s.dataRows.map((r) => r[amount])).toEqual([100.99, 60]);
        expect(s.totals[amount]).toBe(160.99);
        expect(s.amountFormat).toBe('$#,##0.00');
        const code = strip(read('app/api/tracker/pickup-sheet/route.ts'));
        expect(code).toContain('supporterAmountDue(order as any)');
        expect(code).not.toMatch(/tax_rate|taxRate|\*\s*0\.01|resolveCloseoutTaxRate/);
    });

    it('10. a coordinator paid mark renders as Paid on both documents', async () => {
        useMock(docMock([order('p1', { paid: true })]));
        const t = await tracker();
        expect(t.body.groups[0].payment).toEqual({ state: 'paid', paidCount: 1, orderCount: 1 });
        useMock(docMock([order('p1', { paid: true })]));
        const s = await sheet();
        expect(s.dataRows[0][s.header.indexOf('Payment')]).toBe(PAYMENT_PAID_LABEL);
        expect(s.totals[s.header.indexOf('Payment')]).toBe('1 of 1 marked paid');
    });

    it('11. no paid mark renders "Payment not marked" — never "Unpaid"', async () => {
        useMock(docMock([order('n1')]));
        const s = await sheet();
        expect(s.dataRows[0][s.header.indexOf('Payment')]).toBe(PAYMENT_NOT_MARKED_LABEL);
        expect(PAYMENT_NOT_MARKED_LABEL).toBe('Payment not marked');
        expect(s.allText).not.toMatch(/\bunpaid\b/i);
        useMock(docMock([order('n1')]));
        const t = await tracker();
        expect(t.body.groups[0].payment.state).toBe('not_marked');
        expect(JSON.stringify(t.body)).not.toMatch(/\bunpaid\b/i);
    });

    it('12. one supporter with two orders: the tracker groups them truthfully ("1 of 2"), the XLSX keeps one row — and one payment state — per order', async () => {
        const rows = [
            order('m1', { customerId: 'cust-same', name: 'Sam Same', paid: true, bundle: 'bundle-ff-5' }),
            order('m2', { customerId: 'cust-same', name: 'Sam Same', bundle: 'bundle-keto-2', size: 'serves_2', total: 60 }),
        ];
        useMock(docMock(rows));
        const t = await tracker();
        expect(t.body.groups).toHaveLength(1);
        expect(t.body.groups[0].payment).toEqual({ state: 'partly_marked', paidCount: 1, orderCount: 2 });
        expect(t.body.groups[0].items).toHaveLength(2);
        expect(t.body.groups[0].total).toBe(185);

        useMock(docMock(rows));
        const s = await sheet();
        const pay = s.header.indexOf('Payment');
        expect(s.dataRows.map((r) => [r[1], r[pay]])).toEqual([['Sam Same', PAYMENT_PAID_LABEL], ['Sam Same', PAYMENT_NOT_MARKED_LABEL]]);
        expect(s.totals[pay]).toBe('1 of 2 marked paid');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13–14. Production is untouched.
// ═════════════════════════════════════════════════════════════════════════════
describe('13–14. the production gate is unchanged', () => {
    it('13. production intake and the Kitchen Board still exclude fundraiser_hold — listing an order does not make it cookable', () => {
        const held = { status: 'fundraiser_hold', source: 'fundraiser', canceled_at: null };
        expect(isPickupDocumentOrder(held, { closed: true })).toBe(true);
        expect(isProductionEligibleOrder(held)).toBe(false);
        expect(isPickupEligibleOrder(held)).toBe(false);
        expect(PRODUCTION_ORDER_EXCLUSIONS).toContainEqual({ NOT: { status: 'fundraiser_hold' } });
        expect(strip(read('lib/prisma_adapter.ts'))).toMatch(/AND: \[\.\.\.PRODUCTION_ORDER_EXCLUSIONS\]/);
        expect(strip(read('app/api/production/dashboard/route.ts'))).toContain('fundraiser_hold');
    });

    it('14. invoice PAID is still the only release: exactly one file anywhere moves fundraiser_hold to production_ready', () => {
        const walk = (dir: string, out: string[] = []): string[] => {
            if (!existsSync(join(ROOT, dir))) return out;
            for (const name of readdirSync(join(ROOT, dir))) {
                if (name === 'node_modules' || name.startsWith('.')) continue;
                const rel = `${dir}/${name}`;
                if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
                else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
            }
            return out;
        };
        const RELEASE = /updateMany\(\{\s*where:\s*\{[^}]*status:\s*'fundraiser_hold'[^}]*\},\s*data:\s*\{\s*status:\s*'production_ready'/;
        const writers = ['app', 'lib', 'components'].flatMap((d) => walk(d)).filter((f) => RELEASE.test(strip(read(f))));
        expect(writers).toEqual(['lib/invoiceSettlementTransition.ts']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// The printable page's status line and contract registration.
// ═════════════════════════════════════════════════════════════════════════════
describe('the printable tracker states which list it is', () => {
    const page = read('app/coordinator/portal/pickup-tracker/page.tsx');

    it('a screen-only callout carries the full status; one compact line prints', () => {
        expect(page).toMatch(/className=\{`no-print mb-4 rounded-xl border/);
        expect(page).toContain('{PICKUP_DOCUMENT_STATUS_COPY[documentState]}');
        expect(page).toContain('{PRINTED_STATUS[documentState]}');
        expect(page).toContain("final_pending_release: 'Final order list — food not yet released to production.'");
    });

    it('the old released-only empty state is gone', () => {
        expect(page).not.toContain('No released orders yet.');
        expect(page).not.toMatch(/once this fundraiser&apos;s invoice\s+has been recorded as paid/);
    });

    it('the fulfillment contract records the ruling (§9.1) and its authority (§11)', () => {
        const contract = read('docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md');
        expect(contract).toContain('## 9.1 Pickup documents — COORD-CLOSEOUT-PICKUP-1 amendment');
        expect(contract).toContain('**Closeout populates the pickup documents; invoice payment releases\n  production.**'.replace(/\n/g, contract.includes('\r\n') ? '\r\n' : '\n'));
        expect(contract).toContain('| Which orders does a coordinator pickup document list? | `lib/coordinatorSupporterOrders.ts` — `isPickupDocumentOrder`, `pickupDocumentOrderWhere` (§9.1) |');
    });
});
