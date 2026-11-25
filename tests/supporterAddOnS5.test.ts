/**
 * FR-SUPPORTER-ADDON-UPSELL-1 — S5 full-feature acceptance: code-level checks that travel with the repository.
 *
 *  P. The coordinator packet's small printable tracker (templates/tracker.xlsx) — the S3 known gap, resolved
 *     narrowly in S5: a campaign with an add-on lists it apart from the meal bundles (row 12) and gets a
 *     dedicated "Add-On Qty" column; every other campaign's tracker is unchanged.
 *  A. Characterization of the add-on share accounting around cancellation, restoration and re-assignment —
 *     the behaviour S5 reports to the owner as a release decision (no accounting policy is invented here).
 *
 * All data is fictional.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { generateTracker, type TrackerInput } from '@/lib/generateTracker';
import { splitAddOnLineIntoSlices, validateShareScheduleEdit, defaultShareTiers } from '@/lib/campaignAddOnShare';

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const S4_HEAD = '30ef6da';

const BASE: TrackerInput = {
    campaignName: 'Willow Creek Robotics Spring Fundraiser (fixture)',
    organizationName: 'Willow Creek Robotics Club (fixture)',
    endDate: '2026-12-20T12:00:00.000Z',
    publicUrl: 'https://www.example.test/shop/fixture/fundraiser/abc',
    coordinatorName: 'Rory Fixture',
    bundles: [{ name: 'Comfort Classics', price: 125 }, { name: 'Weeknight Favorites', price: 125 }],
};
const sheetOf = async (buf: ArrayBuffer | Buffer) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    return wb.worksheets[0];
};
const cells = (ws: ExcelJS.Worksheet) => {
    const out: Record<string, unknown> = {};
    ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => { out[c.address] = c.value; }));
    return out;
};

describe('P. the coordinator packet\'s printable tracker', () => {
    it('P1. with an add-on: listed apart from the meals at its supporter price, and its own "Add-On Qty" column', async () => {
        const ws = await sheetOf(await generateTracker({ ...BASE, addOn: { name: 'Sides & Dessert Bundle', price: 26.88 } }));
        expect(ws.getCell('A10').value).toBe('Comfort Classics ($125.00)');
        expect(ws.getCell('A11').value).toBe('Weeknight Favorites ($125.00)');
        expect(ws.getCell('A12').value).toBe('Add-on: Sides & Dessert Bundle ($26.88) — only with a meal bundle');
        expect(ws.getCell('E13').value).toBe('Add-On Qty');
        // The new header is styled like the template's own "Amount" header beside it (bold), not left plain.
        expect(ws.getCell('D13').font?.bold).toBe(true);
        expect(ws.getCell('E13').style).toEqual(ws.getCell('D13').style);
        expect([ws.getCell('A13').value, ws.getCell('B13').value, ws.getCell('C13').value, ws.getCell('D13').value]).toEqual(['#', 'Customer Name', 'Bundle', 'Amount']);
        expect(ws.getColumn(5).width).toBe(12);
        expect(ws.pageSetup).toMatchObject({ fitToPage: true, fitToWidth: 1, fitToHeight: 0 });
        expect(String(ws.getCell('A12').value)).not.toMatch(/Serves|Family|free|bonus|full bundle/i);
    });

    it('P2. without an add-on (null, absent, or unpriced): every cell and the print setup are exactly as before', async () => {
        const before = await sheetOf(await generateTracker(BASE));
        for (const addOn of [null, undefined, { name: 'Unpriced', price: 0 }, { name: 'Broken', price: NaN }]) {
            const ws = await sheetOf(await generateTracker({ ...BASE, addOn } as TrackerInput));
            expect(cells(ws)).toEqual(cells(before));
            expect(ws.getColumn(5).width).toBe(before.getColumn(5).width);
            expect(ws.pageSetup.fitToPage).toBe(before.pageSetup.fitToPage);
        }
        expect(before.getCell('A12').value).toBeNull();
        expect(before.getCell('E13').value).toBeNull();
    });

    it('P3. the packet hands the tracker the SAME add-on (and price) its flyer prints', async () => {
        const src = R('lib/generateFullPacket.ts');
        const block = src.slice(src.indexOf('const trackerInput: TrackerInput = {'), src.indexOf('const trackerArrayBuffer'));
        expect(block).toMatch(/addOn: input\.addOn \?\? null,/);
        expect(src).toMatch(/addOn: input\.addOn \?\? null,\s*\n[\s\S]*?generateFlyer|generateFlyer[\s\S]*?addOn: input\.addOn \?\? null/);
        // still a blank form: the tracker never reads orders
        expect(block).not.toMatch(/order|item_role|variant_size/i);
    });

    it('P4. the full packet zip carries the add-on row and column when the campaign has an add-on', async () => {
        jest.resetModules();
        const { generateFullPacket } = await import('@/lib/generateFullPacket');
        const zipBuf = await generateFullPacket({
            campaignName: BASE.campaignName, organizationName: BASE.organizationName, businessName: 'Maple Row Kitchen (fixture)', endDate: BASE.endDate,
            deliveryDate: '2027-01-08', pickupLocation: 'Fixture Gym', checksPayable: 'Willow Creek Robotics Club (fixture)', publicUrl: BASE.publicUrl,
            coordinatorName: 'Rory Fixture', bundles: [
                { name: 'Comfort Classics', price: 125, servingTier: 'serves_5', familyId: 'fam-a', meals: ['Lemon Herb Chicken', 'Beef Stew'] } as any,
                { name: 'Comfort Classics (Serves 2)', price: 60, servingTier: 'serves_2', familyId: 'fam-a', meals: ['Lemon Herb Chicken', 'Beef Stew'] } as any,
            ],
            addOn: { name: 'Sides & Dessert Bundle', price: 25 },
        } as any);
        const zip = await JSZip.loadAsync(zipBuf);
        const tracker = await zip.file('printable-tracker.xlsx')!.async('nodebuffer');
        const ws = await sheetOf(tracker);
        expect(ws.getCell('A12').value).toBe('Add-on: Sides & Dessert Bundle ($25.00) — only with a meal bundle');
        expect(ws.getCell('E13').value).toBe('Add-On Qty');
    }, 60000);
});

describe('A. add-on share accounting — characterization (reported to the owner as a release decision)', () => {
    const TIERS = [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 15 }, { startingQuantity: 21, percent: 20 }];

    it('A1. the brief\'s threshold arithmetic: 9 sold, then 3 more at $25 → unit 10 @10% $2.50 + units 11–12 @15% $7.50 = $10', () => {
        const slices = splitAddOnLineIntoSlices({ tiers: TIERS, soldBefore: 9, quantity: 3, unitPrice: 25 });
        expect(slices.map((s) => [s.firstUnit, s.quantity, s.percent, s.shareAmount])).toEqual([[10, 1, 10, 2.5], [11, 2, 15, 7.5]]);
        expect(slices.reduce((n, s) => n + s.shareAmount, 0)).toBe(10);
    });

    it('A2. units are numbered from the count of NON-canceled add-ons: after a cancel, the next order re-uses the canceled units', () => {
        // order A took units 1–3; A is canceled, so "sold before" for order C is 0 again (countCampaignAddOnUnitsSold
        // excludes canceled orders) and C is numbered 1–3 too. Restoring A does not renumber either order.
        const a = splitAddOnLineIntoSlices({ tiers: TIERS, soldBefore: 0, quantity: 3, unitPrice: 25 });
        const c = splitAddOnLineIntoSlices({ tiers: TIERS, soldBefore: 0, quantity: 3, unitPrice: 25 });
        expect(a[0].firstUnit).toBe(1);
        expect(c[0].firstUnit).toBe(1);
        expect(R('lib/campaignAddOnEarnings.ts')).toMatch(/order: \{\s*campaign_id: campaignId,\s*canceled_at: null,/);
        // the coordinator's cancel and restore only flip canceled_at — no recompute, no campaign lock
        const coord = R('app/api/coordinator/route.ts');
        const restore = coord.slice(coord.indexOf('// 2. Atomic restore'), coord.indexOf('Restore Coordinator Order Error'));
        expect(restore).toMatch(/data: \{\s*canceled_at: null,\s*canceled_by: null\s*\}/);
        expect(restore).not.toMatch(/AddOnShare|recordAddOnShareEarnings|lockCampaignSelection/);
    });

    it('A3. re-assigning after a removal starts a fresh single tier at the meal share, and units already sold lock it', () => {
        const fresh = defaultShareTiers('20.00');
        expect(fresh).toEqual([{ startingQuantity: 1, percent: 20 }]);
        const edit = validateShareScheduleEdit({ current: fresh, next: [{ startingQuantity: 1, percent: 10 }], unitsSold: 12 });
        expect(edit).toMatchObject({ ok: false, status: 409, code: 'SHARE_TIER_LOCKED' });
    });
});

describe('S5 scope', () => {
    it('S5 changes exactly the packet tracker and its pass-through (plus tests); S1–S4 migrations untouched', () => {
        const changed = execSync(`git diff --name-only ${S4_HEAD} -- . ":(exclude)tests"`, { cwd: ROOT, encoding: 'utf8' })
            .split('\n').map((s) => s.trim()).filter(Boolean);
        expect(changed.sort()).toEqual(['lib/generateFullPacket.ts', 'lib/generateTracker.ts']);
    });
});
