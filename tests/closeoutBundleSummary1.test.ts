/**
 * CLOSEOUT-BUNDLE-SUMMARY-1 — "what bundles and sizes did this fundraiser actually order?"
 *
 * Three surfaces, one presentation helper (lib/bundleSummary.ts), no new calculation:
 *   · the closeout modal renders the closeout response's own `lines`;
 *   · the invoices page renders a fundraiser invoice's frozen items, read-only;
 *   · the coordinator portal totals the FULL order list above Recent orders.
 *
 * The closeout path is executed through the REAL POST handler against a database double that
 * honours the route's own `canceled_at: null` filter, so "quantities match the authoritative
 * lines", "sales reconcile to settlement gross" and "canceled orders are not reintroduced" are
 * proven against what the route actually returns and actually freezes onto the invoice.
 * Components are rendered to static markup.
 *
 * The fixture is the owner's worked acceptance example (45 supporter orders, 71 physical
 * bundles, $5,755), with neutral organization names.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { roundCents, sumLineTotals, type AggregatedLine } from '@/lib/fundraiserCloseoutMath';
import {
    bundleDisplayName,
    bundleSizeLabel,
    bundleSummaryFromCloseoutLines,
    bundleSummaryFromInvoiceItems,
    bundleSummaryFromSupporterOrders,
    bundleSummaryShowsCents,
    formatDollars,
    formatSummaryMoney,
    summarizeBundleLines,
    type BundleSummary,
} from '@/lib/bundleSummary';
import { BundleSummaryTable } from '@/components/invoices/BundleSummaryTable';
import { InvoiceBundleSummaryDialog } from '@/components/invoices/InvoiceBundleSummaryDialog';
import { BundleTotalsCard } from '@/components/coordinator/BundleTotalsCard';
import { RecentOrders } from '@/components/coordinator/RecentOrders';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Executable code only: block comments and whole-line comments removed. */
const code = (p: string) => read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
const lf = (s: string) => s.replace(/\r\n/g, '\n');

/** Production baseline before this phase (COORD-CLOSED-PORTAL-1). */
const BASELINE = 'bbe820a1558e91be9544712c9a343c039419a1b1';
const PAGE = 'app/fundraisers/page.tsx';
const INVOICES = 'app/invoices/page.tsx';
const PORTAL = 'app/coordinator/portal/page.tsx';

// ─── Fixture: the acceptance example ──────────────────────────────────────────

const BUNDLES = {
    ff5: { id: 'bundle-ff-5', name: 'Family Friendly - Fall 2026', size: 'serves_5', price: 125 },
    ff2: { id: 'bundle-ff-2', name: 'Family Friendly (Serves 2) - Fall 2026', size: 'serves_2', price: 60 },
    k5: { id: 'bundle-keto-5', name: 'Keto Bundle - Fall 2026', size: 'serves_5', price: 125 },
    k2: { id: 'bundle-keto-2', name: 'Keto Bundle (Serves 2) - Fall 2026', size: 'serves_2', price: 60 },
    special: { id: 'bundle-special-5', name: 'Seasonal Special - Fall 2026', size: 'serves_5', price: 125 },
} as const;
type BundleKey = keyof typeof BUNDLES;

const routeItem = (b: BundleKey, qty: number) => ({
    bundle_id: BUNDLES[b].id, quantity: qty, unit_price: BUNDLES[b].price, variant_size: BUNDLES[b].size,
    item_name: BUNDLES[b].name, bundle: { name: BUNDLES[b].name },
});

interface RouteOrder {
    id: string;
    total_amount: number;
    tax_amount: number;
    canceled_at: Date | null;
    items: ReturnType<typeof routeItem>[];
}

const routeOrder = (id: string, items: ReturnType<typeof routeItem>[], canceledAt: Date | null = null): RouteOrder => ({
    id, total_amount: items.reduce((s, it) => s + it.quantity * it.unit_price, 0), tax_amount: 0, canceled_at: canceledAt, items,
});

/**
 * 45 active orders: 14 × Family S5, 9 × Keto S5, and 22 mixed Serves-2 orders (four of them with a
 * second Keto) — 14 / 22 / 9 / 26 physical bundles, $5,755. Plus two CANCELED orders, one of them
 * the only order for a bundle nobody else bought.
 */
const acceptanceOrders = (): RouteOrder[] => {
    const out: RouteOrder[] = [];
    for (let i = 0; i < 14; i++) out.push(routeOrder(`ff5-${i}`, [routeItem('ff5', 1)]));
    for (let i = 0; i < 9; i++) out.push(routeOrder(`k5-${i}`, [routeItem('k5', 1)]));
    for (let i = 0; i < 22; i++) out.push(routeOrder(`mix-${i}`, [routeItem('ff2', 1), routeItem('k2', i < 4 ? 2 : 1)]));
    const canceled = new Date('2026-09-25T15:00:00Z');
    out.push(routeOrder('canceled-keto', [routeItem('k5', 3)], canceled));
    out.push(routeOrder('canceled-special', [routeItem('special', 2)], canceled));
    return out;
};

/** The same orders as the coordinator payload carries them (toSupporterOrder's shape). */
const coordinatorOrders = (orders: RouteOrder[] = acceptanceOrders()) => orders.map((o, i) => ({
    id: o.id,
    customer_name: `Supporter ${i + 1}`,
    participant_name: null,
    total_amount: String(o.total_amount),
    amount_due: o.total_amount,
    paid_at: null,
    created_at: '2026-09-20T15:00:00.000Z',
    canceled_at: o.canceled_at ? o.canceled_at.toISOString() : null,
    items: o.items.map((it) => ({
        quantity: it.quantity, variant_size: it.variant_size, item_name: it.item_name, bundle_id: it.bundle_id,
    })),
}));

const EXPECTED_ROWS = [
    ['Family Friendly - Fall 2026', 'Serves 5', 14, 1750],
    ['Family Friendly - Fall 2026', 'Serves 2', 22, 1320],
    ['Keto Bundle - Fall 2026', 'Serves 5', 9, 1125],
    ['Keto Bundle - Fall 2026', 'Serves 2', 26, 1560],
] as const;

const rowsOf = (s: BundleSummary) => s.rows.map((r) => [r.bundleName, r.sizeLabel, r.quantity, r.sales]);

// ─── Markup helpers ───────────────────────────────────────────────────────────

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const text = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const cellsOf = (rowHtml: string) => [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => text(m[1]));
const section = (markup: string, tag: 'thead' | 'tbody' | 'tfoot') =>
    (markup.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '')
        .split('</tr>').filter((r) => r.includes('<t')).map(cellsOf);

// ─── The real closeout route, against a database double ───────────────────────

const calls: Array<{ op: string; args?: any }> = [];
let campaignRow: any;
let ordersInDb: RouteOrder[];
let invoiceRows: any[];

const txClient: any = {
    $executeRawUnsafe: async () => 1,
    order: {
        // Honours the route's own filter, as Postgres would.
        findMany: async (args: any) => {
            calls.push({ op: 'order.findMany', args });
            return ordersInDb.filter((o) => (args?.where?.canceled_at === null ? o.canceled_at === null : true));
        },
        updateMany: async () => ({ count: 0 }),
    },
    fundraiserCampaign: {
        updateMany: async (a: any) => {
            calls.push({ op: 'campaign.claim', args: a });
            campaignRow = { ...campaignRow, ...a.data };
            return { count: 1 };
        },
    },
    invoice: {
        create: async (a: any) => {
            calls.push({ op: 'invoice.create', args: a });
            const row = { id: 'inv-acceptance-0001', ...a.data };
            invoiceRows.push(row);
            return { id: row.id };
        },
        findFirst: async ({ where }: any) => invoiceRows.find((i) => i.campaign_id === where.campaign_id) ?? null,
    },
};

jest.mock('@/lib/db', () => ({
    get prisma() {
        return {
            $transaction: async (fn: any) => fn(txClient),
            fundraiserCampaign: { findUnique: async () => campaignRow },
            invoice: { findFirst: async ({ where }: any) => invoiceRows.find((i) => i.campaign_id === where.campaign_id) ?? null },
            user: { findFirst: async ({ where }: any) => ({ id: where.id ?? 'user-admin' }) },
        };
    },
}));
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const CAMPAIGN = 'camp-cbs1';
const closeout = async () => {
    const { POST } = await import('@/app/api/campaigns/[id]/closeout/route');
    const res = await POST(
        new Request(`http://localhost/api/campaigns/${CAMPAIGN}/closeout`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ applyFoodTax: true }),
        }) as any,
        { params: Promise.resolve({ id: CAMPAIGN }) } as any,
    );
    return { status: res.status, body: await res.json() };
};

/** The invoice items closeout froze, as GET /api/tenant/invoices returns them (Decimals as strings). */
const frozenInvoiceItems = () => {
    const created = calls.find((c) => c.op === 'invoice.create');
    if (!created) throw new Error('closeout did not create an invoice');
    return (created.args.data.items.create as any[]).map((it) => ({
        ...it,
        quantity: String(it.quantity),
        unit_price: Number(it.unit_price).toFixed(2),
        total: Number(it.total).toFixed(2),
    }));
};

beforeEach(() => {
    calls.length = 0;
    invoiceRows = [];
    ordersInDb = acceptanceOrders();
    campaignRow = {
        id: CAMPAIGN, status: 'Active', closed_at: null, settlement_total: null, org_share_percent: 20,
        customer: { id: 'org-cbs1', business_id: 'biz-cbs1' }, tax_status: null, tax_rate_percent: null,
    };
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'user-admin', email: 'admin@example.invalid', businessId: 'biz-cbs1', role: 'ADMIN', isSuperAdmin: false } });
});

// ═════════════════════════════════════════════════════════════════════════════
// A. The presentation helper
// ═════════════════════════════════════════════════════════════════════════════
describe('A. lib/bundleSummary — presentation over existing authorities', () => {
    it('sizes come from the existing serving-tier utilities: family/serves_5 → "Serves 5", serves_2 → "Serves 2", unknown → none', () => {
        expect(bundleSizeLabel('serves_5')).toBe('Serves 5');
        expect(bundleSizeLabel('family')).toBe('Serves 5');
        expect(bundleSizeLabel('serves_2')).toBe('Serves 2');
        expect(bundleSizeLabel(null)).toBeNull();
        expect(bundleSizeLabel('mystery')).toBeNull();
        const helper = code('lib/bundleSummary.ts');
        expect(helper).toMatch(/servingTierLabel\(normalizeStrictServingTier\(variantSize\)\)/);
    });

    it('the bundle column drops a "(Serves N)" marker only when it repeats the Size column', () => {
        expect(bundleDisplayName('Family Friendly (Serves 2) - Fall 2026', 'Serves 2')).toBe('Family Friendly - Fall 2026');
        expect(bundleDisplayName('Fall 2026 - Keto (serves 2)', 'Serves 2')).toBe('Fall 2026 - Keto');
        // A marker that contradicts the recorded size is evidence, not noise — it stays.
        expect(bundleDisplayName('Keto (Serves 2)', 'Serves 5')).toBe('Keto (Serves 2)');
        expect(bundleDisplayName('Keto Bundle - Fall 2026', 'Serves 5')).toBe('Keto Bundle - Fall 2026');
        expect(bundleDisplayName('Keto (Serves 2)', null)).toBe('Keto (Serves 2)');
        expect(bundleDisplayName('', 'Serves 5')).toBe('Unnamed bundle');
    });

    it('one row per bundle + serving size: Serves 5 and Serves 2 stay separate, the same bundle and size merge', () => {
        const s = summarizeBundleLines([
            { bundleId: 'b5', description: 'Keto', variantSize: 'serves_5', quantity: 2, total: 250 },
            { bundleId: 'b2', description: 'Keto (Serves 2)', variantSize: 'serves_2', quantity: 3, total: 180 },
            { bundleId: 'b5', description: 'Keto', variantSize: 'serves_5', quantity: 1, total: 125 },
        ]);
        expect(rowsOf(s)).toEqual([['Keto', 'Serves 5', 3, 375], ['Keto', 'Serves 2', 3, 180]]);
        expect(s.totalQuantity).toBe(6);
        expect(s.totalSales).toBe(555);
    });

    it('two price points of one bundle and size become ONE row whose sales are the sum of the frozen line totals — no averaged price', () => {
        // aggregateBundleLines keeps these apart on purpose; the summary shows no unit price, so it
        // may join them, and its sales are exactly the two totals added.
        const s = summarizeBundleLines([
            { bundleId: 'b5', description: 'Keto', variantSize: 'serves_5', quantity: 2, total: 250 },
            { bundleId: 'b5', description: 'Keto', variantSize: 'serves_5', quantity: 1, total: 110 },
        ]);
        expect(rowsOf(s)).toEqual([['Keto', 'Serves 5', 3, 360]]);
    });

    it('sales are summed as handed in, never re-derived from a price', () => {
        const helper = code('lib/bundleSummary.ts');
        expect(helper).not.toMatch(/unitPrice\s*\*|\*\s*unitPrice|unit_price\s*\*|\*\s*unit_price|price\s*\*\s*qty/);
        expect(helper).toMatch(/row\.sales = roundCents\(row\.sales \+ total\)/);
    });

    it('no weighted-goal arithmetic and no data access live in the helper', () => {
        const helper = code('lib/bundleSummary.ts');
        expect(helper).not.toMatch(/getBundleUnitWeight|computeBundleUnitsFromItems|fundraiserMetrics|0\.5/);
        expect(helper).not.toMatch(/@\/lib\/db|prisma|fetch\(/);
        expect(helper.match(/^import .*$/gm)).toEqual([
            "import { aggregateBundleLines, roundCents, type AggregatedLine } from '@/lib/fundraiserCloseoutMath';",
            "import { servingTierLabel } from '@/lib/mealLabel';",
            "import { normalizeStrictServingTier } from '@/lib/serving_multipliers';",
        ]);
    });

    it('money is whole dollars when every figure is whole, and cents for every figure otherwise', () => {
        const whole = summarizeBundleLines([{ bundleId: 'a', description: 'A', variantSize: 'serves_5', quantity: 14, total: 1750 }]);
        expect(bundleSummaryShowsCents(whole)).toBe(false);
        expect(formatSummaryMoney(1750, false)).toBe('$1,750');
        const mixed = summarizeBundleLines([
            { bundleId: 'a', description: 'A', variantSize: 'serves_5', quantity: 14, total: 1750 },
            { bundleId: 'b', description: 'B', variantSize: 'serves_2', quantity: 2, total: 121.2 },
        ]);
        expect(bundleSummaryShowsCents(mixed)).toBe(true);
        expect(formatSummaryMoney(1750, true)).toBe('$1,750.00');
        // The $121 vs $121.20 trap: a real cent is never rounded away.
        expect(formatDollars(121.2)).toBe('$121.20');
        expect(formatDollars(5755)).toBe('$5,755');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. The closeout path, executed through the real route
// ═════════════════════════════════════════════════════════════════════════════
describe('B. closeout response lines → Bundle Summary (real POST handler)', () => {
    it('the acceptance example: four rows, 71 physical bundles, $5,755 — equal to the settlement gross', async () => {
        const { status, body } = await closeout();
        expect(status).toBe(200);
        const summary = bundleSummaryFromCloseoutLines(body.lines)!;
        expect(rowsOf(summary)).toEqual(EXPECTED_ROWS.map((r) => [...r]));
        expect(summary.totalQuantity).toBe(71);
        expect(summary.totalSales).toBe(5755);
        expect(summary.totalSales).toBe(body.settlement_total);
        expect(summary.totalSales).toBe(body.financials.gross_sales);
        expect(summary.totalSales).toBe(sumLineTotals(body.lines));
    });

    it('quantities match the authoritative lines, and each row\'s sales = quantity × the frozen unit price', async () => {
        const { body } = await closeout();
        const lines = body.lines as AggregatedLine[];
        const summary = bundleSummaryFromCloseoutLines(lines)!;
        expect(summary.rows).toHaveLength(lines.length);
        for (const line of lines) {
            const row = summary.rows.find((r) => r.key === `bundle:${line.bundleId}|${line.variantSize}`)!;
            expect(row).toBeDefined();
            expect(row.quantity).toBe(line.quantity);
            expect(row.sales).toBe(line.total);
            expect(row.sales).toBe(roundCents(line.quantity * line.unitPrice));
        }
    });

    it('canceled orders are not reintroduced: the route reads canceled_at: null and the summary reads only its lines', async () => {
        const { body } = await closeout();
        const orderRead = calls.find((c) => c.op === 'order.findMany')!;
        expect(orderRead.args.where).toEqual({ campaign_id: CAMPAIGN, canceled_at: null });
        const summary = bundleSummaryFromCloseoutLines(body.lines)!;
        expect(summary.rows.map((r) => r.bundleName)).not.toContain('Seasonal Special - Fall 2026');
        expect(summary.rows.find((r) => r.bundleName === 'Keto Bundle - Fall 2026' && r.sizeLabel === 'Serves 5')!.quantity).toBe(9);
        expect(summary.totalQuantity).toBe(71);
    });

    it('the persistent view agrees: the invoice\'s frozen items give the identical summary', async () => {
        const { body } = await closeout();
        expect(bundleSummaryFromInvoiceItems(frozenInvoiceItems())).toEqual(bundleSummaryFromCloseoutLines(body.lines));
    });

    it('frozen means frozen: canceling an order AFTER closeout does not change the invoice view', async () => {
        await closeout();
        const items = frozenInvoiceItems();
        const before = bundleSummaryFromInvoiceItems(items);
        ordersInDb = ordersInDb.map((o) => (o.id === 'ff5-0' ? { ...o, canceled_at: new Date('2026-10-02T12:00:00Z') } : o));
        expect(bundleSummaryFromInvoiceItems(items)).toEqual(before);
        expect(before.totalQuantity).toBe(71);
    });

    it('an idempotent retry returns no lines, and the summary is then omitted rather than rebuilt', async () => {
        await closeout();
        const retry = await closeout();
        expect(retry.body.idempotent).toBe(true);
        expect(retry.body.lines).toBeUndefined();
        expect(bundleSummaryFromCloseoutLines(retry.body.lines)).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. The closeout modal
// ═════════════════════════════════════════════════════════════════════════════
describe('C. closeout modal wiring (app/fundraisers/page.tsx)', () => {
    const src = read(PAGE);

    it('stores the response\'s own lines and builds the summary from them alone', () => {
        expect(src).toContain('lines: Array.isArray(data.lines) ? data.lines : undefined,');
        expect(src).toMatch(/bundleSummaryFromCloseoutLines\(closeoutResult\.lines\)/);
        expect(src).toMatch(/\{closeoutBundleSummary && \(\s*<BundleSummaryTable summary=\{closeoutBundleSummary\}/);
    });

    it('does not requery orders: the closeout handler still makes exactly one request', () => {
        const handler = src.slice(src.indexOf('const handleCloseout'), src.indexOf('const openCloseoutModal'));
        expect(handler.match(/fetch\(/g)).toHaveLength(1);
        expect(handler).toContain('/closeout`');
    });

    it('renders below the financial summary, outside it', () => {
        const draftNote = src.indexOf('Draft invoice created. Nothing has been sent or marked paid.');
        const table = src.indexOf('<BundleSummaryTable');
        const errorState = src.indexOf('{/* Result state — error */}');
        expect(draftNote).toBeGreaterThan(-1);
        expect(table).toBeGreaterThan(draftNote);
        expect(table).toBeLessThan(errorState);
        // The success box (role="status") is closed before the summary starts.
        const between = src.slice(draftNote, table);
        expect((between.match(/<\/div>/g) || []).length).toBeGreaterThanOrEqual(2);
    });

    it('the existing closeout financial section is byte-for-byte unchanged from the Production baseline', () => {
        const baseline = lf(execSync(`git show ${BASELINE}:${PAGE}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
        const now = lf(src);
        const start = '{/* Result state — success */}';
        const was = baseline.slice(baseline.indexOf(start), baseline.indexOf('{/* Result state — error */}')).trim();
        const is = now.slice(now.indexOf(start), now.indexOf('{/* CLOSEOUT-BUNDLE-SUMMARY-1')).trim();
        expect(was.length).toBeGreaterThan(1000);
        expect(is).toBe(was);
    });

    it('the dialog scrolls on a short phone screen now that it can be taller', () => {
        expect(src).toContain('w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto p-8');
    });

    it('no supporter-order or weighted-goal figure is borrowed from the (possibly stale) campaign row', () => {
        const block = src.slice(src.indexOf('{/* CLOSEOUT-BUNDLE-SUMMARY-1'), src.indexOf('{/* Result state — error */}'));
        expect(block).not.toMatch(/held_order_count|weighted_bundles_sold|progress_percent/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. The tenant table, rendered
// ═════════════════════════════════════════════════════════════════════════════
describe('D. BundleSummaryTable, rendered', () => {
    const summary = () => bundleSummaryFromInvoiceItems(
        EXPECTED_ROWS.map(([name, size, qty, total], i) => ({
            bundle_id: `b-${i}`, description: size === 'Serves 2' ? name.replace(' - ', ' (Serves 2) - ') : name,
            variant_size: size === 'Serves 2' ? 'serves_2' : 'serves_5', quantity: String(qty), total: total.toFixed(2),
        })),
    );

    it('Bundle | Size | Qty | Sales, one row each, a Total row, and the physical-bundle footer', () => {
        const m = html(createElement(BundleSummaryTable, { summary: summary() }));
        expect(text(m)).toContain('Bundle Summary');
        expect(section(m, 'thead')).toEqual([['Bundle', 'Size', 'Qty', 'Sales']]);
        expect(section(m, 'tbody')).toEqual([
            ['Family Friendly - Fall 2026', 'Serves 5', '14', '$1,750'],
            ['Family Friendly - Fall 2026', 'Serves 2', '22', '$1,320'],
            ['Keto Bundle - Fall 2026', 'Serves 5', '9', '$1,125'],
            ['Keto Bundle - Fall 2026', 'Serves 2', '26', '$1,560'],
        ]);
        expect(section(m, 'tfoot')).toEqual([['Total', '', '71', '$5,755']]);
        expect(text(m)).toContain('71 physical bundles');
        // Omitted, not estimated: neither figure is authoritative here.
        expect(text(m)).not.toMatch(/supporter order|weighted/i);
    });

    it('lays out for desktop and phone: full width, the name wraps, sizes and money never break', () => {
        const m = html(createElement(BundleSummaryTable, { summary: summary() }));
        expect(m).toMatch(/<table class="w-full /);
        const firstRow = m.match(/<tbody\b[^>]*>\s*<tr>([\s\S]*?)<\/tr>/)![1];
        const tds = [...firstRow.matchAll(/<td class="([^"]*)"/g)].map((x) => x[1]);
        expect(tds[0]).toContain('[overflow-wrap:anywhere]');
        expect(tds[1]).toContain('whitespace-nowrap');
        expect(tds[2]).toMatch(/text-right tabular-nums/);
        expect(tds[3]).toMatch(/whitespace-nowrap/);
        // No fixed widths that could push a 375px phone into horizontal scroll.
        expect(m).not.toMatch(/\b(min-)?w-\[\d+px\]|\bw-(64|72|80|96)\b/);
    });

    it('an empty summary says so instead of rendering an empty table', () => {
        const m = html(createElement(BundleSummaryTable, { summary: summarizeBundleLines([]) }));
        expect(text(m)).toContain('No bundles were sold.');
        expect(m).not.toContain('<table');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. Persistent access — the invoices page
// ═════════════════════════════════════════════════════════════════════════════
describe('E. invoices page — read-only Bundle Summary from the frozen invoice items', () => {
    const src = read(INVOICES);

    it('fundraiser invoices only, and always visible — not inside the hover-only action group', () => {
        const row = src.slice(src.indexOf('filteredInvoices.map((inv) => ('));
        const button = row.indexOf('onClick={() => setBundleSummaryInvoice(inv)}');
        const hoverGroup = row.indexOf('opacity-0 group-hover:opacity-100');
        expect(button).toBeGreaterThan(-1);
        expect(button).toBeLessThan(hoverGroup);
        expect(row.slice(0, button)).toMatch(/\{inv\.campaign_id && \(\s*<button\s+type="button"\s*$/);
    });

    it('the dialog gets the invoice row itself, whose items the list response already carries — nothing is fetched', () => {
        expect(src).toMatch(/\{bundleSummaryInvoice && \(\s*<InvoiceBundleSummaryDialog\s+invoice=\{bundleSummaryInvoice\}/);
        const dialog = code('components/invoices/InvoiceBundleSummaryDialog.tsx');
        expect(dialog).toContain('bundleSummaryFromInvoiceItems(invoice.items)');
        expect(dialog).not.toMatch(/fetch\(|\/api\//);
        // The list endpoint selects every item column (variant_size and bundle_id included).
        expect(code('app/api/tenant/invoices/route.ts')).toMatch(/items: true,/);
    });

    it('renders the acceptance example read-only: rows, totals, invoice reference, and no editable control', async () => {
        await closeout();
        const m = html(createElement(InvoiceBundleSummaryDialog, {
            invoice: { id: 'inv-acceptance-0001', customer: { name: 'Example County Fundraiser' }, items: frozenInvoiceItems() },
            onClose: () => undefined,
        }));
        expect(m).toContain('role="dialog"');
        expect(text(m)).toContain('Example County Fundraiser · #INV-ACCE');
        expect(section(m, 'tbody')).toEqual([
            ['Family Friendly - Fall 2026', 'Serves 5', '14', '$1,750'],
            ['Family Friendly - Fall 2026', 'Serves 2', '22', '$1,320'],
            ['Keto Bundle - Fall 2026', 'Serves 5', '9', '$1,125'],
            ['Keto Bundle - Fall 2026', 'Serves 2', '26', '$1,560'],
        ]);
        expect(section(m, 'tfoot')).toEqual([['Total', '', '71', '$5,755']]);
        expect(m).not.toMatch(/<input|<select|<textarea|<form/);
        expect((m.match(/<button/g) || []).length).toBe(1);
        expect(m).toContain('aria-label="Close bundle summary"');
        // The dialog scrolls inside a short phone screen.
        expect(m).toContain('max-h-[calc(100dvh-2rem)]');
        expect(m).toContain('overflow-y-auto');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. The coordinator portal card
// ═════════════════════════════════════════════════════════════════════════════
describe('F. coordinator portal — bundle totals above Recent orders', () => {
    const portal = read(PORTAL);
    const card = (props: { orders: any[]; isClosed: boolean; totalSales?: number | string | null }) =>
        html(createElement(BundleTotalsCard, props));

    it('is placed immediately above every Recent orders list, and is handed the FULL list', () => {
        const cards = [...portal.matchAll(/<BundleTotalsCard\b[\s\S]*?\/>/g)];
        expect(cards).toHaveLength(3);
        expect(portal.match(/<RecentOrders\b/g)).toHaveLength(3);
        for (const m of cards) {
            const c = m[0];
            expect(c).toContain('orders={activeOrders}');
            expect(c).toContain('isClosed={isClosed}');
            expect(c).toContain('totalSales={campaign.total_sales}');
            expect(c).not.toMatch(/limit|slice|showAllOrders/);
            // Nothing but whitespace and comments between THIS card and the next Recent orders.
            const after = portal.slice(m.index! + c.length);
            const gap = after.slice(0, after.indexOf('<RecentOrders')).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
            expect(gap.trim()).toBe('');
        }
        expect(portal).toContain('const activeOrders = (campaign.orders || []);');
    });

    it('the payload is every non-canceled order — no row limit in the coordinator GET', () => {
        const api = code('app/api/coordinator/route.ts');
        const include = api.slice(api.indexOf('orders: {'), api.indexOf('select: SUPPORTER_ORDER_SELECT') + 40);
        expect(include).toContain('where: { canceled_at: null }');
        expect(include).not.toMatch(/\btake:/);
    });

    it('totals all 45 orders while Recent orders previews three', () => {
        const orders = coordinatorOrders().filter((o) => !o.canceled_at);
        const m = card({ orders, isClosed: false, totalSales: 5755 });
        expect(section(m, 'tbody')).toEqual([
            ['Family Friendly - Fall 2026', 'Serves 5', '14'],
            ['Family Friendly - Fall 2026', 'Serves 2', '22'],
            ['Keto Bundle - Fall 2026', 'Serves 5', '9'],
            ['Keto Bundle - Fall 2026', 'Serves 2', '26'],
        ]);
        expect(text(m)).toContain('Total physical bundles: 71');
        expect(text(m)).toContain('45 supporter orders · $5,755 in orders');
        const preview = html(createElement(RecentOrders, { orders, onCancel: () => undefined, limit: 3 }));
        expect((preview.match(/aria-label="Cancel order"/g) || []).length).toBe(3);
    });

    it('multiple supporters aggregate into one row per bundle and size; Serves 5 and Serves 2 stay apart', () => {
        const s = bundleSummaryFromSupporterOrders([
            { canceled_at: null, items: [{ quantity: 1, variant_size: 'serves_5', item_name: 'Keto', bundle_id: 'k5' }] },
            { canceled_at: null, items: [{ quantity: 2, variant_size: 'serves_5', item_name: 'Keto', bundle_id: 'k5' }] },
            { canceled_at: null, items: [{ quantity: 1, variant_size: 'serves_2', item_name: 'Keto (Serves 2)', bundle_id: 'k2' }] },
        ]);
        expect(rowsOf(s)).toEqual([['Keto', 'Serves 5', 3, 0], ['Keto', 'Serves 2', 1, 0]]);
    });

    it('canceled orders never contribute — not to a row, not to the total, not to the order count', () => {
        const all = coordinatorOrders(); // includes the two canceled orders
        expect(all.filter((o) => o.canceled_at)).toHaveLength(2);
        const m = card({ orders: all, isClosed: false, totalSales: 5755 });
        expect(text(m)).not.toContain('Seasonal Special');
        expect(text(m)).toContain('Total physical bundles: 71');
        expect(text(m)).toContain('45 supporter orders');
        expect(bundleSummaryFromSupporterOrders(all).totalQuantity).toBe(71);
    });

    it('reflects new orders on the next render: no state, no effect, no fetch of its own', () => {
        const orders = coordinatorOrders().filter((o) => !o.canceled_at);
        const before = card({ orders, isClosed: false, totalSales: 5755 });
        const extra = { ...orders[0], id: 'new-order', items: [{ quantity: 2, variant_size: 'serves_5', item_name: BUNDLES.k5.name, bundle_id: BUNDLES.k5.id }] };
        const after = card({ orders: [extra, ...orders], isClosed: false, totalSales: 6005 });
        expect(text(before)).toContain('Total physical bundles: 71');
        expect(text(after)).toContain('Total physical bundles: 73');
        expect(section(after, 'tbody')[2]).toEqual(['Keto Bundle - Fall 2026', 'Serves 5', '11']);
        expect(text(after)).toContain('46 supporter orders · $6,005 in orders');
        const src = code('components/coordinator/BundleTotalsCard.tsx');
        expect(src).not.toMatch(/useState|useEffect|useMemo|fetch\(/);
    });

    it('open vs closed copy; the closed card is read-only', () => {
        const orders = coordinatorOrders().filter((o) => !o.canceled_at);
        const open = text(card({ orders, isClosed: false, totalSales: 5755 }));
        expect(open).toContain('Current bundle totals');
        expect(open).toContain('Updates as orders are added.');
        const closedHtml = card({ orders, isClosed: true, totalSales: 5755 });
        expect(text(closedHtml)).toContain('Final bundle totals');
        expect(text(closedHtml)).toContain('Ordering is closed. These totals reflect the completed fundraiser.');
        expect(closedHtml).not.toMatch(/<button|<input|<select|<textarea|<form|<a /);
    });

    it('shows no tenant-only invoice, profit-share or accounting figure', () => {
        const m = card({ orders: coordinatorOrders(), isClosed: true, totalSales: 5755 });
        expect(section(m, 'thead')).toEqual([['Bundle', 'Size', 'Qty']]);
        expect(text(m)).not.toMatch(/invoice|profit|share|remit|earned|tax|due|Sales/i);
        // The only dollar figure is the order total the portal already shows.
        expect(text(m).match(/\$[\d,.]+/g)).toEqual(['$5,755']);
        const src = code('components/coordinator/BundleTotalsCard.tsx');
        expect(src).not.toMatch(/invoice|profit|org_share|organization_amount|settlement/i);
    });

    it('the order-count line appears only when the payload supplied total_sales', () => {
        const orders = coordinatorOrders().filter((o) => !o.canceled_at);
        expect(text(card({ orders, isClosed: true, totalSales: null }))).not.toContain('supporter orders');
        expect(text(card({ orders, isClosed: true, totalSales: '5755.20' }))).toContain('45 supporter orders · $5,755.20 in orders');
    });

    it('is readable on a phone: full-width table, wrapping names, unbroken sizes and counts', () => {
        const m = card({ orders: coordinatorOrders(), isClosed: true, totalSales: 5755 });
        expect(m).toMatch(/<table class="w-full /);
        const firstRow = m.match(/<tbody\b[^>]*>\s*<tr>([\s\S]*?)<\/tr>/)![1];
        const tds = [...firstRow.matchAll(/<td class="([^"]*)"/g)].map((x) => x[1]);
        expect(tds[0]).toContain('[overflow-wrap:anywhere]');
        expect(tds[1]).toContain('whitespace-nowrap');
        expect(tds[2]).toMatch(/text-right/);
        expect(m).not.toMatch(/\b(min-)?w-\[\d+px\]/);
    });

    it('renders nothing before the first order', () => {
        expect(card({ orders: [], isClosed: false, totalSales: 0 })).toBe('');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. Scope — presentation only
// ═════════════════════════════════════════════════════════════════════════════
describe('G. scope: no calculation, invoice, tax, settlement, QuickBooks, order or schema file touched', () => {
    // Pinned to THIS phase's own commit range. It first read the live working tree, which made every
    // later phase that legitimately edits one of these paths (COORD-CLOSEOUT-PICKUP-1 changes two
    // coordinator routes and lib/coordinatorSupporterOrders.ts) fail it until committed.
    const PHASE_COMMIT = '7172b6872618f31e13b233d6432341067117be12';
    it('the phase commit leaves every money and data path alone', () => {
        const out = execSync([
            `git diff --name-only ${BASELINE} ${PHASE_COMMIT} --`,
            'app/api',
            'lib/fundraiserCloseoutMath.ts lib/fundraiserTax.ts lib/pricing.ts lib/quickbooks',
            'lib/invoiceSettlement.ts lib/invoiceSettlementTransition.ts lib/invoiceSendTruth.ts',
            'lib/serving_multipliers.ts lib/mealLabel.ts lib/coordinatorSupporterOrders.ts lib/coordinatorMaterialBundles.ts',
            'components/coordinator/RecentOrders.tsx prisma',
        ].join(' '), { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });
});
