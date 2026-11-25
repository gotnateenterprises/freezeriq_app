/**
 * FR-SUPPORTER-ADDON-UPSELL-1 — S3: every surface shows and counts an add-on line correctly.
 *
 * One shared formatter (lib/orderLineDisplay.ts) decides how an order line reads. An add-on line
 * (item_role 'addon', stored with variant_size 'serves_5') is shown as "<name> (Add-On)" / size "Add-On",
 * never "Serves 5" or "Family Size"; it is never counted as a meal bundle; its dollars stay in every total.
 * Kitchen quantities, serving multipliers, box packing, tax and QuickBooks arithmetic are unchanged.
 *
 * Every name and id is fictional (the repository is public).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import {
    ADD_ON_SIZE_LABEL,
    addOnDisplayName,
    formatOrderLine,
    isAddOnLine,
    orderLineDisplayName,
    orderLineSizeLabel,
    partitionOrderLines,
} from '@/lib/orderLineDisplay';
import {
    bundleSummaryFromCloseoutLines,
    bundleSummaryFromInvoiceItems,
    bundleSummaryFromSupporterOrders,
    summarizeBundleLines,
} from '@/lib/bundleSummary';
import { aggregateBundleLines } from '@/lib/fundraiserCloseoutMath';
import { planQuickBooksInvoice, bundleLineDescription, FUNDRAISER_ORGANIZATION_SHARE_LABEL } from '@/lib/quickbooks/invoicePayload';
import { buildPhysicalBoxManifest, boxContentLines, formatBoxContentLine } from '@/lib/physicalBoxPacking';
import { resolveSoldTier, resolvePackingVariantSize } from '@/lib/supporterBoxManifest';
import { buildFundraiserBatches } from '@/lib/fundraiserProductionBatch';
import { generateFlyer, FLYER_ADD_ON_NOTE, type FlyerBundle } from '@/lib/generateFlyer';
import {
    addOnTrackerLabel,
    populateTrackerWorksheet,
    TRACKER_ADD_ON_TEMPLATE_FILE,
    TRACKER_TEMPLATE_FILE,
} from '@/lib/coordinatorOrderTracker';
import { supporterBundlePrice } from '@/lib/supporterMaterialPricing';

const send = jest.fn();
jest.mock('resend', () => ({ Resend: class { emails = { send: (...a: any[]) => send(...a) }; } }));
jest.mock('@/lib/db', () => ({
    get prisma() {
        return (global as any).__ao3Prisma ?? {
            business: { findUnique: jest.fn(async () => ({ name: 'Example Kitchen', contact_email: 'owner@example.test' })) },
        };
    },
}));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const S2_HEAD = 'e7c7f5d';
const ORIGINAL_ENV = { ...process.env };
beforeAll(() => { for (const k of ['log', 'warn', 'error', 'info'] as const) jest.spyOn(console, k).mockImplementation(() => undefined); });
beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, RESEND_API_KEY: 'test-key' };
    send.mockResolvedValue({ data: { id: 'm1' }, error: null });
});
afterAll(() => { process.env = ORIGINAL_ENV; });

const ADDON = { item_role: 'addon', variant_size: 'serves_5', name: 'Sides & Dessert Bundle', quantity: 2 };
const MEAL5 = { item_role: 'main', variant_size: 'serves_5', name: 'Comfort Foods', quantity: 1 };
const MEAL2 = { item_role: 'main', variant_size: 'serves_2', name: 'Comfort Foods', quantity: 1 };

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('1 · the shared formatter', () => {
    it('main lines keep their serving size; the add-on reads "(Add-On)" and never a size', () => {
        expect(formatOrderLine(MEAL5)).toBe('Comfort Foods — Serves 5 ×1');
        expect(formatOrderLine(MEAL2)).toBe('Comfort Foods — Serves 2 ×1');
        expect(formatOrderLine(ADDON)).toBe('Sides & Dessert Bundle (Add-On) ×2');
        expect(formatOrderLine(ADDON)).not.toMatch(/Serves|Family/);
        expect(orderLineSizeLabel(ADDON)).toBe(ADD_ON_SIZE_LABEL);
        expect(orderLineSizeLabel(MEAL5)).toBe('Serves 5');
        expect(orderLineSizeLabel({ variant_size: 'serves_5' })).toBe('Serves 5'); // pre-S1 rows are main
        expect(orderLineSizeLabel({ item_role: 'main', variant_size: 'weird' })).toBeNull();
    });
    it('the add-on marker is never doubled, and only the exact role "addon" is an add-on', () => {
        expect(addOnDisplayName('Holiday Pie Add-On')).toBe('Holiday Pie Add-On');
        expect(addOnDisplayName('Sides & Dessert Bundle (Add-On)')).toBe('Sides & Dessert Bundle (Add-On)');
        expect(addOnDisplayName('')).toBe('Add-On');
        expect(orderLineDisplayName({ ...MEAL5 })).toBe('Comfort Foods');
        for (const role of ['ADDON', 'add-on', 'Addon', null, undefined, 'main']) expect(isAddOnLine({ item_role: role as any })).toBe(false);
    });
    it('partition keeps meal lines and add-on lines apart (meal counts come from main only)', () => {
        const { main, addOns } = partitionOrderLines([MEAL5, ADDON, MEAL2]);
        expect(main).toEqual([MEAL5, MEAL2]);
        expect(addOns).toEqual([ADDON]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('2 · bundle totals (coordinator card, closeout dialog, invoice summary)', () => {
    const orders = [
        { items: [{ bundle_id: 'b5', item_name: 'Comfort Foods (Serves 5)', variant_size: 'serves_5', quantity: 2 }, { bundle_id: 'ba', item_name: 'Sides & Dessert Bundle', variant_size: 'serves_5', quantity: 3, item_role: 'addon' }] },
        { items: [{ bundle_id: 'b2', item_name: 'Comfort Foods (Serves 2)', variant_size: 'serves_2', quantity: 1 }, { bundle_id: 'ba', item_name: 'Sides & Dessert Bundle', variant_size: 'serves_5', quantity: 1, item_role: 'addon' }] },
        { canceled_at: '2026-11-20', items: [{ bundle_id: 'ba', item_name: 'Sides & Dessert Bundle', variant_size: 'serves_5', quantity: 9, item_role: 'addon' }] },
    ];
    it('add-ons are listed apart, sized "Add-On", and never counted as physical bundles', () => {
        const s = bundleSummaryFromSupporterOrders(orders);
        expect(s.rows.map((r) => [r.bundleName, r.sizeLabel, r.quantity])).toEqual([['Comfort Foods', 'Serves 5', 2], ['Comfort Foods', 'Serves 2', 1]]);
        expect(s.totalQuantity).toBe(3);
        expect(s.addOnRows!.map((r) => [r.bundleName, r.sizeLabel, r.quantity])).toEqual([['Sides & Dessert Bundle', 'Add-On', 4]]);
        expect(s.addOnQuantity).toBe(4);
    });
    it('invoice summary: add-on dollars stay in total sales; its quantity stays out of the bundle count', () => {
        const s = bundleSummaryFromInvoiceItems([
            { bundle_id: 'b5', description: 'Comfort Foods', variant_size: 'serves_5', quantity: '2', total: '250.00' },
            { bundle_id: 'ba', description: 'Sides & Dessert Bundle (Add-On)', variant_size: null, quantity: '4', total: '100.00', item_role: 'addon' },
        ]);
        expect(s.totalQuantity).toBe(2);
        expect(s.totalSales).toBe(350);
        expect(s.addOnRows).toEqual([{ key: 'addon|bundle:ba', bundleName: 'Sides & Dessert Bundle', sizeLabel: 'Add-On', quantity: 4, sales: 100 }]);
    });
    it('a summary with no add-on keeps its exact pre-S3 shape (no new keys)', () => {
        const s = summarizeBundleLines([{ bundleId: 'b5', description: 'Comfort Foods', variantSize: 'serves_5', quantity: 1, total: 125 }]);
        expect(Object.keys(s).sort()).toEqual(['rows', 'totalQuantity', 'totalSales']);
    });
    it('closeout lines: the add-on aggregates on its own line marked itemRole; meal lines keep their shape', () => {
        const lines = aggregateBundleLines([
            { bundleId: 'b5', description: 'Comfort Foods', variantSize: 'serves_5', quantity: 1, unitPrice: 125 },
            { bundleId: 'ba', description: 'Sides & Dessert Bundle (Add-On)', variantSize: null, quantity: 2, unitPrice: 25, itemRole: 'addon' },
            { bundleId: 'ba', description: 'Sides & Dessert Bundle (Add-On)', variantSize: null, quantity: 1, unitPrice: 25, itemRole: 'addon' },
        ]);
        expect(lines).toEqual([
            { bundleId: 'b5', description: 'Comfort Foods', variantSize: 'serves_5', quantity: 1, unitPrice: 125, total: 125 },
            { bundleId: 'ba', description: 'Sides & Dessert Bundle (Add-On)', variantSize: null, quantity: 3, unitPrice: 25, total: 75, itemRole: 'addon' },
        ]);
        const s = bundleSummaryFromCloseoutLines(lines)!;
        expect(s.totalQuantity).toBe(1);
        expect(s.totalSales).toBe(200);
        expect(s.addOnQuantity).toBe(3);
    });
    it('the coordinator card and invoice table render the add-on section apart and say it is not a bundle', () => {
        const card = R('components/coordinator/BundleTotalsCard.tsx');
        expect(card).toContain('(summary.addOnRows ?? []).map((r) =>');
        expect(card).toContain('Add-ons are not counted as bundles.');
        const table = R('components/invoices/BundleSummaryTable.tsx');
        expect(table).toContain('(summary.addOnRows ?? []).map((r) =>');
        expect(table).toContain("'add-on', 'add-ons')} (not counted as bundles)");
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('3 · coordinator surfaces', () => {
    it('order list: the add-on reads "2× Sides & Dessert Bundle (Add-On)" with no tier', () => {
        const src = R('components/coordinator/RecentOrders.tsx');
        expect(src).toContain("const tier = addOn ? '' : formatServingTierLabel(it.variant_size);");
        expect(src).toContain("{it.quantity}× {addOn ? addOnDisplayName(it.item_name) : (it.item_name || 'Item')}{tier ? ` — ${tier}` : ''}");
    });
    it('printable pickup tracker: size cell "Add-On"; header counts bundles and add-ons apart', () => {
        const page = R('app/coordinator/portal/pickup-tracker/page.tsx');
        expect(page).toContain('const tier = addOn ? orderLineSizeLabel(it) : formatServingTier(it.variant_size);');
        expect(page).toContain("add-on{manifest.totalAddOns === 1 ? '' : 's'}");
        const route = R('app/api/coordinator/pickup-tracker/route.ts');
        expect(route).toMatch(/partitionOrderLines\(g\.items as any\[\]\)\.main\.reduce/);
        expect(route).toMatch(/partitionOrderLines\(g\.items as any\[\]\)\.addOns\.reduce/);
        expect(route).toMatch(/totalBundles,\n\s+totalAddOns,/);
    });
    it('pickup spreadsheet: a dedicated "(Add-On)" column after Total Bundles; Total Bundles excludes it', async () => {
        const fixture = await import('./helpers/pickupSheetFixture');
        const orders = fixture.sheetOrders();
        const first = orders[0];
        first.items.push({ id: 'item-ao3-addon', bundle_id: 'b-ao3-addon', quantity: 2, variant_size: 'serves_5', item_name: 'Sides & Dessert Bundle', item_role: 'addon', unit_price: 25, bundle: { id: 'b-ao3-addon', name: 'Sides & Dessert Bundle' } });
        const before = first.items.filter((i: any) => i.item_role !== 'addon').reduce((n: number, i: any) => n + Number(i.quantity), 0);
        (global as any).__ao3Prisma = {
            coordinatorSession: { findUnique: async () => ({ id: 's', campaign_id: fixture.SHEET_CAMPAIGN.id, expires_at: new Date(Date.now() + 3600_000), revoked_at: null }) },
            fundraiserCampaign: { findFirst: async () => ({ ...fixture.SHEET_CAMPAIGN }), findUnique: async () => ({ ...fixture.SHEET_CAMPAIGN }) },
            order: { findMany: async () => orders },
            bundle: { findMany: async () => [] },
            campaignBundle: { findMany: async () => [] },
        };
        jest.resetModules();
        jest.doMock('next/headers', () => ({ cookies: async () => ({ get: () => ({ name: 'x', value: 'ao3-secret' }) }) }));
        jest.doMock('@/lib/coordinatorSession', () => ({ ...jest.requireActual('@/lib/coordinatorSession'), requireCoordinatorSession: async () => ({ ok: true, campaignId: fixture.SHEET_CAMPAIGN.id, sessionId: 's' }) }));
        jest.doMock('@/lib/campaignOrderBundles', () => ({ resolveCampaignOrderMode: async () => ({ allowed: false, mode: 'selected', activeOrderableBundleIds: [] }) }));
        const { GET } = await import('@/app/api/tracker/pickup-sheet/route');
        const res = await GET(new Request('http://localhost/api/tracker/pickup-sheet') as any);
        (global as any).__ao3Prisma = undefined;
        expect(res.status).toBe(200);
        const ExcelJS = (await import('exceljs')).default; // same module registry as the route
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
        const ws = wb.worksheets[0];
        const header = (ws.getRow(4).values as any[]).slice(1).map((v) => String(v ?? ''));
        const totalCol = header.indexOf('Total\nBundles') + 1;
        const addOnCol = header.findIndex((h) => /\(Add-On\)$/.test(h)) + 1;
        expect(addOnCol).toBe(totalCol + 1);
        expect(header.filter((h) => /Sides/.test(h))).toHaveLength(1);
        const row = ws.getRow(5);
        expect(Number(row.getCell(totalCol).value)).toBe(before);
        expect(Number(row.getCell(addOnCol).value)).toBe(2);
        expect(header[header.length - 2]).toBe('Amount\nDue');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('4 · box labels, packing slips, kitchen — labels only; packing and quantities unchanged', () => {
    const order = (role: string) => ({
        id: 'order-ao3-1', first_name: 'Dana', last_name: 'Fields', customer_name: 'Dana Fields',
        campaign_organization_name: 'Riverside Boosters (fixture)', campaign_name: 'Fall Fundraiser (fixture)',
        items: [
            { id: 'i1', bundle_id: 'b5', quantity: 1, variant_size: 'serves_5', item_name: 'Comfort Foods (Serves 5)', item_role: 'main' },
            { id: 'i2', bundle_id: 'ba', quantity: 2, variant_size: 'serves_5', item_name: 'Sides & Dessert Bundle', item_role: role },
        ],
    });
    it('the add-on box says "Sides & Dessert Bundle — Add-On"; boxes, Box N/M and box types are unchanged', () => {
        const withRole = buildPhysicalBoxManifest([order('addon') as any]);
        const asMain = buildPhysicalBoxManifest([order('main') as any]);
        const text = withRole.boxes.flatMap((b) => boxContentLines(b).map(formatBoxContentLine));
        expect(text).toEqual(['Comfort Foods (Serves 5) — Serves 5', 'Sides & Dessert Bundle — Add-On', 'Sides & Dessert Bundle — Add-On']);
        expect(text.join('|')).not.toMatch(/Sides & Dessert Bundle — Serves 5|Family Size/);
        expect(withRole.boxes.map((b) => [b.boxNumber, b.boxTotal, b.boxType])).toEqual(asMain.boxes.map((b) => [b.boxNumber, b.boxTotal, b.boxType]));
        expect(withRole.physicalBoxCount).toBe(asMain.physicalBoxCount);
        expect(withRole.boxes.every((b) => b.organizationName === 'Riverside Boosters (fixture)')).toBe(true);
    });
    it('resolveSoldTier says "Add-On" while the packing token stays the stored size', () => {
        const item = { id: 'x', bundle_id: 'ba', quantity: 1, variant_size: 'serves_5', item_name: 'S', item_role: 'addon' };
        expect(resolveSoldTier(item as any)).toBe('Add-On');
        expect(resolvePackingVariantSize(item as any)).toBe('serves_5');
        expect(resolveSoldTier({ ...item, variant_size: 'nonsense' } as any)).toBeNull(); // an unusable line still blocks
    });
    it('box-label and packing-slip queries carry the role', () => {
        expect(R('app/api/production/box-labels/route.ts')).toMatch(/item_name: true,\n\s+\/\/ FR-SUPPORTER-ADDON-UPSELL-1 \(S3\)[^\n]*\n\s+\.\.\.ITEM_ROLE_SELECT,/);
        expect(R('lib/packingSlipContents.ts')).toMatch(/item_name: true,\n\s+\/\/ FR-SUPPORTER-ADDON-UPSELL-1 \(S3\)[^\n]*\n\s+\.\.\.ITEM_ROLE_SELECT,/);
    });
    it('Fundraisers Waiting lane: the add-on line is labelled "Add-On"; units and line split are unchanged', () => {
        const batches = buildFundraiserBatches([{
            id: 'o1', campaign_id: 'c1', total_amount: 175, status: 'fundraiser_hold',
            campaign: { id: 'c1', name: 'Fall', customer: { name: 'Org' }, invoices: [] } as any,
            items: [
                { id: 'i1', bundle_id: 'b5', quantity: 1, variant_size: 'serves_5', item_name: 'Comfort Foods' },
                { id: 'i2', bundle_id: 'ba', quantity: 2, variant_size: 'serves_5', item_name: 'Sides & Dessert Bundle', item_role: 'addon' },
            ],
        } as any]);
        const lines = batches[0].lines.map((l: any) => [l.bundleName, l.servingTierLabel, l.quantity]);
        expect(lines).toEqual(expect.arrayContaining([['Comfort Foods', 'Serves 5', 1], ['Sides & Dessert Bundle', 'Add-On', 2]]));
        expect(batches[0].totalUnitCount).toBe(3);
    });
    it('prep list, prep waves and meal labels use the shared rule; kitchen engine, adapter and multipliers untouched', () => {
        expect(R('components/production/PrepList.tsx')).toContain('const tier = orderLineSizeLabel(item);');
        const waves = R('lib/prepWaves.ts');
        expect(waves).toContain('tierLabel: orderLineSizeLabel({ item_role: l.itemRole, variant_size: l.variantSize })');
        expect(waves).toContain('const tier = orderLineSizeLabel(row);');
        expect(R('app/api/production/dashboard/route.ts')).toContain("...(isAddOnLine(item as any) ? { item_role: 'addon' } : {}),");
        const changed = execSync(`git diff --name-only ${S2_HEAD} -- lib/kitchen_engine.ts lib/prisma_adapter.ts lib/serving_multipliers.ts lib/pricing.ts lib/mealManifest.ts lib/physicalBoxPacking.ts lib/deliveryPackaging.ts`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(changed).toBe('');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('5 · emails', () => {
    it('supporter confirmation: meal "Size: Serves 5"; add-on "(Add-On)" with no size; never the raw "serves_5"', async () => {
        const { sendOrderConfirmationEmail } = await import('@/lib/email');
        await sendOrderConfirmationEmail('dana@example.test', { customer_name: 'Dana', external_id: 'ord_ao3', total_amount: 175 }, [
            { quantity: 1, variant_size: 'serves_5', item_role: 'main', bundle: { name: 'Comfort Foods' } },
            { quantity: 2, variant_size: 'serves_5', item_role: 'addon', bundle: { name: 'Sides & Dessert Bundle' } },
        ], 'org@example.test', null, null, 'biz-1');
        const html: string = send.mock.calls[0][0].html;
        expect(html).toContain('1x Comfort Foods</p>');
        expect(html).toContain('Size: Serves 5</p>');
        expect(html).toContain('2x Sides &amp; Dessert Bundle (Add-On)</p>');
        expect(html).not.toMatch(/serves_5/);
        expect(html.match(/Size:/g)).toHaveLength(1);
    });
    it('coordinator new-order email: "1x Sides & Dessert Bundle (Add-On)" and no "Serves 5" on it; meals unchanged', async () => {
        const { sendFundraiserCoordinatorNotification } = await import('@/lib/email');
        await sendFundraiserCoordinatorNotification({
            coordinatorEmail: 'coord@example.test', campaignName: 'Fall', organizationName: 'Org', supporterName: 'Dana',
            items: [
                { item_name: 'Comfort Foods', quantity: 1, variant_size: 'serves_5', item_role: 'main' },
                { item_name: 'Sides & Dessert Bundle', quantity: 1, variant_size: 'serves_5', item_role: 'addon' },
            ],
            totalAmount: 150, orderReference: 'ord_ao3',
        } as any);
        const html: string = send.mock.calls[0][0].html;
        expect(html).toContain('1x Sides &amp; Dessert Bundle (Add-On)</p>');
        expect(html.match(/Serves 5/g)).toHaveLength(1);
        expect(html).toContain('1x Comfort Foods</p>');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('6 · flyer page 2 — one add-on row, tax-inclusive, still one printable page', () => {
    jest.setTimeout(60000); // two real PDFs with QR codes per test
    function pdfTexts(buffer: Buffer): Array<{ text: string; y: number; x: number }> {
        const raw = buffer.toString('latin1');
        const out: Array<{ text: string; y: number; x: number }> = [];
        for (const m of raw.matchAll(/([\d.]+) ([\d.]+) Td\s*\(((?:[^()\\]|\\[\s\S])*)\)\s*Tj/g)) {
            out.push({ x: Number(m[1]), y: Number(m[2]), text: m[3].replace(/\\([()\\])/g, '$1').replace(/\x96/g, '–') });
        }
        return out;
    }
    const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;
    const bundles: FlyerBundle[] = [
        { name: 'Comfort Foods', price: 126.25, servingTier: 'serves_5', familyId: 'f1', meals: ['Lasagna', 'Chili', 'Pot Pie', 'Tacos', 'Soup'] },
        { name: 'Comfort Foods (Serves 2)', price: 65.65, servingTier: 'serves_2', familyId: 'f1', meals: ['Lasagna'] },
        { name: 'Weeknight Favorites', price: 126.25, servingTier: 'serves_5', familyId: 'f2', meals: ['Stir Fry'] },
        { name: 'Weeknight Favorites (Serves 2)', price: 65.65, servingTier: 'serves_2', familyId: 'f2', meals: ['Stir Fry'] },
    ] as any;
    const input = (addOn: any) => ({
        campaignName: 'Riverside Boosters Fall Fundraiser (fixture)', organizationName: 'Riverside Boosters (fixture)', businessName: 'Example Kitchen',
        endDate: '2026-12-20', deliveryDate: '2027-01-05', pickupLocation: 'School gym (fixture)', checksPayable: 'Riverside Boosters',
        publicUrl: 'https://example.test/shop/x/fundraiser/y', bundles, taxRatePercent: 1, addOn,
    });

    it('the row prints name, "Add-On", the tax-inclusive price and the rule — never "full bundle"', async () => {
        const price = supporterBundlePrice(25, { tax_status: 'TAXABLE', tax_rate_percent: 1 } as any);
        expect(price).toBe(25.25);
        const buf = Buffer.from(await generateFlyer(input({ name: 'Sides & Dessert Bundle', price }) as any));
        const t = pdfTexts(buf).map((x) => x.text);
        const i = t.indexOf('Sides & Dessert Bundle');
        expect(t.slice(i, i + 4)).toEqual(['Sides & Dessert Bundle', 'Add-On', '$25.25', FLYER_ADD_ON_NOTE]);
        expect(FLYER_ADD_ON_NOTE).toBe('Only available with a meal bundle above');
        expect(t.join('|')).not.toMatch(/full bundle/i);
        expect(t.filter((x) => x === 'Family Size')).toHaveLength(2); // meal rows unchanged
    });
    it('page 2 stays one page: add-on row between the meal rows and GRAND TOTAL, nothing below the footer', async () => {
        const without = Buffer.from(await generateFlyer(input(null) as any));
        const withAddOn = Buffer.from(await generateFlyer(input({ name: 'Sides & Dessert Bundle', price: 25.25 }) as any));
        expect(pages(without)).toBe(2);
        expect(pages(withAddOn)).toBe(2);
        const t = pdfTexts(withAddOn);
        const y = (s: string) => t.find((x) => x.text === s)!.y;
        const lastMealRow = Math.min(...t.filter((x) => x.text === 'Serves 2').map((x) => x.y));
        expect(y('Sides & Dessert Bundle')).toBeLessThan(lastMealRow - 20);         // below the last meal row (PDF y grows upward)
        expect(y(FLYER_ADD_ON_NOTE)).toBeLessThan(y('Sides & Dessert Bundle'));
        expect(y(FLYER_ADD_ON_NOTE)).toBeGreaterThan(y('GRAND TOTAL:  $ _______________') + 15); // no overlap with the total
        const footerY = Math.min(...t.map((x) => x.y));
        expect(footerY).toBeGreaterThan(20);                                         // inside the page (pt from the bottom)
        // The add-on row pushes the rest down by a fixed 16mm (45.35pt) and no more.
        const gt = (buf: Buffer) => pdfTexts(buf).find((x) => x.text === 'GRAND TOTAL:  $ _______________')!.y;
        expect(gt(without) - gt(withAddOn)).toBeCloseTo(16 * 72 / 25.4, 1);
    });
    it('all three material routes look the add-on up and price it by the same supporter rule as the meals', () => {
        for (const f of ['app/api/flyer/download/route.ts', 'app/api/flyer/generate/route.ts', 'app/api/packet/download/route.ts']) {
            const src = R(f);
            expect(src).toContain('supporterPrice: (basePrice: number) => supporterBundlePrice(basePrice, campaign),');
            expect(src).toContain('addOn: materialAddOn ? { name: materialAddOn.name, price: materialAddOn.supporterPrice } : null,');
        }
        expect(R('lib/generateFullPacket.ts')).toContain('addOn: input.addOn ?? null,');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('7 · paper order tracker — an Excel-built Add-On column', () => {
    const fam = (name: string) => ({
        familyName: name,
        serves5: { id: `${name}5`, name, price: 126.25, meals: ['A', 'B', 'C', 'D', 'E'] },
        serves2: { id: `${name}2`, name: `${name} (Serves 2)`, price: 65.65, meals: ['A'] },
    });
    async function load(file: string) {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path.join(ROOT, 'templates', file));
        return wb.worksheets[0];
    }
    it('the original template is byte-identical to S2; the add-on template exists beside it', () => {
        const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
        const was = execSync(`git show ${S2_HEAD}:templates/tracking_sheet.xlsx`, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
        expect(sha(fs.readFileSync(path.join(ROOT, 'templates', TRACKER_TEMPLATE_FILE)))).toBe(sha(was));
        expect(fs.existsSync(path.join(ROOT, 'templates', TRACKER_ADD_ON_TEMPLATE_FILE))).toBe(true);
    });
    it('the add-on template: H "Add-On" / "with a meal", I "Total Sets (meals)", J Total Cost … M Paid Date; merges shifted by Excel; one page wide', async () => {
        const ws = await load(TRACKER_ADD_ON_TEMPLATE_FILE);
        expect(String(ws.getCell('H7').value)).toBe('Add-On');
        expect(String(ws.getCell('H8').value)).toBe('with a meal');
        expect(ws.getCell('H9').alignment?.wrapText).toBe(true);
        expect(ws.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 });
        expect(String(ws.getCell('I9').value)).toBe('Total Sets (meals)');
        expect(String(ws.getCell('J9').value)).toBe('Total Cost');
        expect(String(ws.getCell('M9').value)).toBe('Paid Date');
        const merges = ((ws as any).model.merges as string[]).slice().sort();
        expect(merges).toEqual(['A29:B29', 'A31:B31', 'B1:M1', 'B7:C8', 'D21:E21', 'D30:E30', 'D31:E31', 'D7:G7', 'D8:E8', 'E23:M27', 'F8:G8', 'G30:J30', 'G31:J31', 'I7:M8', 'K21:L21', 'K30:M30', 'K31:M31'].sort());
        let formulas = 0;
        ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => { if ((c as any).formula || (c.value as any)?.formula) formulas++; }));
        expect(formulas).toBe(0);
        expect(ws.columnCount).toBe(13);
    });
    it('populate: bundle choices D–G unchanged; H9 = the add-on at its supporter price; Total Cost header moves to J9', async () => {
        const plain = await load(TRACKER_TEMPLATE_FILE);
        const withAddOn = await load(TRACKER_ADD_ON_TEMPLATE_FILE);
        const info = { endDate: new Date('2026-12-20T00:00:00Z'), payee: 'Riverside Boosters', taxRatePercent: 1 };
        populateTrackerWorksheet(plain, [fam('Comfort Foods'), fam('Weeknight')] as any, info);
        populateTrackerWorksheet(withAddOn, [fam('Comfort Foods'), fam('Weeknight')] as any, info, { addOn: { name: 'Sides & Dessert Bundle', price: 25.25 } });
        for (const c of ['D8', 'F8', 'D9', 'E9', 'F9', 'G9', 'B4', 'B5', 'B23', 'C23']) expect(withAddOn.getCell(c).value).toEqual(plain.getCell(c).value);
        expect(withAddOn.getCell('H9').value).toBe('Sides & Dessert $25.25');
        expect(withAddOn.getCell('J9').value).toBe('Total Cost (incl. 1% Tax)');
        expect(plain.getCell('I9').value).toBe('Total Cost (incl. 1% Tax)');
        expect(addOnTrackerLabel('Holiday Pie Add-On', 18)).toBe('Holiday Pie $18.00');
        expect(addOnTrackerLabel('Sides & Dessert Bundle (Add-On)', 0)).toBe('Sides & Dessert');
    });
    it('the route uses the add-on template only when the campaign has a sellable add-on', () => {
        const src = R('app/api/tracker/download/route.ts');
        expect(src).toContain('`./templates/${materialAddOn ? TRACKER_ADD_ON_TEMPLATE_FILE : TRACKER_TEMPLATE_FILE}`');
        expect(src).toContain('{ addOn: materialAddOn ? { name: materialAddOn.name, price: materialAddOn.supporterPrice } : null }');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('8 · closeout, invoice PDF and QuickBooks — one stable label, the exact stored amount', () => {
    it('closeout result: five lines when an add-on sold; no percentage on the add-on or the total', () => {
        const page = R('app/fundraisers/page.tsx');
        const block = page.slice(page.indexOf('data-org-share-breakdown'), page.indexOf(') : (', page.indexOf('data-org-share-breakdown')));
        for (const label of ['Main meal sales', 'Organization share @ {closeoutResult.financials.org_share_percent}%', 'Add-on sales', 'Add-on earned share', 'Total organization share']) {
            expect(block).toContain(label);
        }
        expect(block.match(/%/g)).toHaveLength(1);
    });
    it('closeout writes the add-on invoice line as "<name> (Add-On)", no size, item_role addon; meal lines as before', () => {
        const src = R('app/api/campaigns/[id]/closeout/route.ts');
        expect(src).toContain('description: addOn ? addOnDisplayName(name) : name,');
        expect(src).toContain("variantSize: addOn ? null : ((it.variant_size as string | null) ?? null),");
        expect(src).toContain("...(l.itemRole === 'addon' ? ({ item_role: 'addon' } as {}) : {}),");
    });
    it('invoice PDF: "Fundraiser Organization Share:" with the stored amount — never "(20%)"', () => {
        const page = R('app/invoices/page.tsx');
        expect(page).toContain("doc.text('Fundraiser Organization Share:', 40, y);");
        expect(page).not.toContain('Fundraiser Profit (');
        expect(page).toContain("doc.text('-$' + profitAmount.toFixed(2), 560, y, { align: 'right' });");
        const modal = R('components/crm/InvoiceComposeModal.tsx');
        expect(modal).toContain('Less Fundraiser Organization Share');
        expect(modal).toContain('const isGeneratedCampaignInvoice = Boolean(invoiceToEdit?.campaign_id);');
    });
    it('QuickBooks: share line "Fundraiser Organization Share", amount = stored share; add-on line "(Add-On)", never "Serves 5"; totals reconcile', () => {
        const plan = planQuickBooksInvoice({
            invoice: {
                id: 'inv-ao3', campaignId: 'c1', totalAmount: '122.50', taxAmount: '0', taxRatePercent: '0', taxStatus: null,
                shareAmount: '27.50', sharePercent: '20.00',
                items: [
                    { id: 'l1', description: 'Comfort Foods', variantSize: 'serves_5', quantity: '1', unitPrice: '125.00', total: '125.00' },
                    { id: 'l2', description: 'Sides & Dessert Bundle (Add-On)', variantSize: null, quantity: '1', unitPrice: '25.00', total: '25.00' },
                ],
            },
            mapping: { salesItemId: 'si', salesAccountId: 'sa', shareItemId: 'sh', shareAccountId: 'sha', taxItemId: null, taxAccountId: null, termId: 't', termDueDays: 15 },
            customerRef: 'cust-1', docNumber: 'FZ-1', txnDate: '2026-11-24',
        } as any);
        expect(plan.ok).toBe(true);
        const lines = (plan as any).expected.lines;
        expect(lines.map((l: any) => [l.role, l.description, l.amountCents])).toEqual([
            ['bundle', 'Comfort Foods — Serves 5', 12500],
            ['bundle', 'Sides & Dessert Bundle (Add-On)', 2500],
            ['share', FUNDRAISER_ORGANIZATION_SHARE_LABEL, -2750],
        ]);
        expect(FUNDRAISER_ORGANIZATION_SHARE_LABEL).toBe('Fundraiser Organization Share');
        expect(bundleLineDescription('Sides & Dessert Bundle (Add-On)', null)).toBe('Sides & Dessert Bundle (Add-On)');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('9 · schema and boundaries', () => {
    it('migration: one additive column with a CHECK; it is the newest migration', () => {
        const sql = R('prisma/migrations/20261125120000_supporter_addon_s3/migration.sql');
        const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
        expect(statements).toEqual([
            'ALTER TABLE "invoice_items" ADD COLUMN     "item_role" TEXT NOT NULL DEFAULT \'main\'',
            'ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_item_role_check"\n    CHECK ("item_role" IN (\'main\', \'addon\'))',
        ]);
        const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        // SUPERSEDED PIN (S4, owner-approved 2026-11-24): S4's approved share-display column follows S3's.
        // SUPERSEDED PIN (B1/B2 remediation, owner-approved 2026-11-25): then the additive campaign_add_ons.removed_at.
        expect(dirs.slice(-5)).toEqual(['20261123120000_supporter_addon_s1', '20261124120000_supporter_addon_s2', '20261125120000_supporter_addon_s3', '20261126120000_supporter_addon_s4', '20261127120000_supporter_addon_b2_removed_at']);
        expect(R('prisma/schema.prisma')).toMatch(/model InvoiceItem \{[\s\S]*?item_role    String  @default\("main"\)/);
    });
    it('untouched by S3: public order route, supporter page, money/tax/kitchen engines, S1/S2 migrations', () => {
        const files = [
            'app/api/public/order/route.ts', 'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx',
            'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx', 'app/api/fundraiser/[token]/route.ts',
            'lib/kitchen_engine.ts', 'lib/serving_multipliers.ts', 'lib/pricing.ts', 'lib/fundraiserTax.ts',
            'lib/campaignAddOns.ts', 'lib/campaignAddOnShare.ts', 'lib/quickbooks/invoiceSend.ts', 'app/api/coordinator/route.ts',
            'prisma/migrations/20261123120000_supporter_addon_s1/migration.sql', 'prisma/migrations/20261124120000_supporter_addon_s2/migration.sql',
        ];
        // SUPERSEDED PIN (S4, owner-approved 2026-11-24): S4 is the public supporter card, so the supporter page,
        // its client and two add-on rule modules change in S4. S3 itself (S2_HEAD..b867ddf) changed none of these;
        // the rest are still untouched today.
        const changedInS3 = execSync(`git diff --name-only ${S2_HEAD} b867ddf -- ${files.map((f) => `"${f}"`).join(' ')}`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(changedInS3).toBe('');
        const S4_APPROVED = new Set([
            'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx', 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx',
            'lib/campaignAddOns.ts', 'lib/campaignAddOnShare.ts',
        ]);
        // SUPERSEDED PIN (B1/B2 remediation, owner-approved 2026-11-25): the coordinator route's cancel/restore now take
        // the campaign lock, and its GET returns the recorded add-on money (addOnMoney). Named here, nothing else.
        const B12_APPROVED = new Set(['app/api/coordinator/route.ts']);
        const stillUntouched = files.filter((f) => !S4_APPROVED.has(f) && !B12_APPROVED.has(f));
        const changed = execSync(`git diff --name-only ${S2_HEAD} -- ${stillUntouched.map((f) => `"${f}"`).join(' ')}`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(changed).toBe('');
        for (const f of files) expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
    });
    it('no surface re-implements the add-on label: every S3 consumer imports the shared module', () => {
        for (const f of [
            'lib/bundleSummary.ts', 'lib/email.ts', 'lib/supporterBoxManifest.ts', 'lib/fundraiserProductionBatch.ts', 'lib/prepWaves.ts',
            'components/production/PrepList.tsx', 'components/coordinator/RecentOrders.tsx', 'app/coordinator/portal/pickup-tracker/page.tsx',
            'app/api/coordinator/pickup-tracker/route.ts', 'app/api/tracker/pickup-sheet/route.ts', 'app/api/campaigns/[id]/closeout/route.ts',
            'app/api/production/dashboard/route.ts',
        ]) {
            expect({ f, imports: /from '(@\/lib\/|\.\/)orderLineDisplay'/.test(R(f)) }).toEqual({ f, imports: true });
        }
    });
});
