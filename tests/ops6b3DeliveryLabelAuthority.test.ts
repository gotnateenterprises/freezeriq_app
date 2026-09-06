/**
 * OPS-6B.3 — ONE canonical outer-box label authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7 (two label systems
 * exist — MEAL labels and CUSTOMER OUTER-BOX labels — and must not be merged)
 * and §11 Rule 8 (reuse, do not re-derive).
 *
 * THE DEFECT THIS PINS SHUT: the Delivery dashboard's primary "Print Labels"
 * action opened /delivery/print-batch, a SECOND outer-box label system that
 * shared nothing with the approved one — hardcoded Avery 5821 geometry, no
 * canonical PhysicalBox anywhere in the file, and a hard dependency on a
 * per-PackagingItem "label template" assignment that failed in owner
 * acceptance with "No label assigned to Large Box."
 *
 * The fix is a REWIRE, not a reimplementation: Delivery now queues Order IDs
 * through the same writeBoxLabelBatch the Production lane uses and navigates
 * to the same /production/box-labels page. Delivery imports no label geometry
 * at all, which is why the OL600 walk-guards over app/delivery/** stay armed.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DELIVERY = 'app/delivery/page.tsx';
const AVERY = 'app/delivery/print-batch/page.tsx';
const OL600_PAGE = 'app/production/box-labels/page.tsx';
const OL600_ROUTE = 'app/api/production/box-labels/route.ts';
const QUEUE_UI = 'components/production/DeliveryQueue.tsx';
const LAYOUT = 'lib/labelSheetLayout.ts';

// ═════════════════════════════════════════════════════════════════════════════
// 1-2. THE STALE AVERY PATH IS UNREACHABLE
// ═════════════════════════════════════════════════════════════════════════════
describe('STALE AVERY PATH RETIRED', () => {
    it('A1. the Delivery dashboard no longer navigates to the Avery print-batch page', () => {
        const s = strip(read(DELIVERY));
        // No Link href, no router.push, no window.location to that page.
        expect(s).not.toMatch(/href=\{?[`'"][^`'"]*delivery\/print-batch/);
        expect(s).not.toMatch(/push\([`'"][^`'"]*delivery\/print-batch/);
        expect(s).not.toMatch(/delivery\/print-batch/);
    });

    it('A2. NO file anywhere navigates to the Avery print-batch page', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            let entries: any[];
            try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next') continue;
                    walk(full);
                    continue;
                }
                if (!/\.(ts|tsx)$/.test(e.name)) continue;
                // The page itself is allowed to mention its own path.
                if (full.replace(/\\/g, '/').includes('app/delivery/print-batch/')) continue;
                const src = strip(readFileSync(full, 'utf8'));
                if (/delivery\/print-batch/.test(src)) offenders.push(full);
            }
        };
        for (const root of ['app', 'components', 'lib']) walk(join(ROOT, root));
        expect(offenders).toEqual([]);
    });

    it('A3. the "No label assigned to Large Box" error is unreachable from the Delivery workflow', () => {
        // The error string still exists in the dormant page...
        expect(read(AVERY)).toMatch(/No label assigned to Large Box\./);
        // ...but nothing routes an operator there any more (proved by A2), and
        // the per-PackagingItem assignment UI that fed it is gone from Delivery.
        const s = strip(read(DELIVERY));
        expect(s).not.toMatch(/defaultLabelId:/);
        expect(s).not.toMatch(/Label Template/);
        expect(s).not.toMatch(/labelTemplates/);
        expect(s).not.toMatch(/api\/delivery\/labels/);
    });

    it('A4. the dormant Avery page is left in place, not deleted', () => {
        // Part D: dormant historical code may remain; only the workflow link goes.
        expect(existsSync(join(ROOT, AVERY))).toBe(true);
        // And the tenant's own label DESIGNER stays reachable on its own route.
        expect(existsSync(join(ROOT, 'app/delivery/labels/page.tsx'))).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3-4 + 11-12 + 16. ONE CANONICAL AUTHORITY
// ═════════════════════════════════════════════════════════════════════════════
describe('ONE CANONICAL LABEL AUTHORITY', () => {
    it('B1. Delivery reuses the approved OL600 path — same batch helper, same page', () => {
        const s = strip(read(DELIVERY));
        expect(s).toMatch(/writeBoxLabelBatch\(/);
        expect(s).toMatch(/router\.push\('\/production\/box-labels'\)/);
        // Identical mechanism to the Production lane.
        const q = strip(read(QUEUE_UI));
        expect(q).toMatch(/writeBoxLabelBatch\(/);
        expect(q).toMatch(/router\.push\('\/production\/box-labels'\)/);
    });

    it('B2. Delivery creates NO new label renderer and copies NO geometry', () => {
        const s = strip(read(DELIVERY));
        expect(s).not.toMatch(/labelSheetLayout|labelTypography|OL600_SHEET|paginateLabelSheets/);
        expect(s).not.toMatch(/avery|5821/i);
        // No inch/grid geometry constants introduced.
        expect(s).not.toMatch(/UNITS_PER_INCH|gridTemplateColumns|2\.5in|4in/);
    });

    it('B3. Delivery creates NO second physical-box authority', () => {
        const s = strip(read(DELIVERY));
        expect(s).not.toMatch(/buildPhysicalBoxManifest|packInstancesIntoBoxes|boxContentLines/);
        expect(s).not.toMatch(/serving_tier|includes\('family'\)/);
    });

    it('B4. the OL600 walk-guards over app/delivery remain ARMED and green', () => {
        // These guards are why the rewire navigates to a page under
        // app/production/ instead of importing geometry into Delivery.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            let entries: any[];
            try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = join(dir, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                if (!/\.(ts|tsx)$/.test(e.name)) continue;
                if (/labelSheetLayout|labelTypography/.test(readFileSync(full, 'utf8'))) offenders.push(full);
            }
        };
        walk(join(ROOT, 'app/delivery'));
        walk(join(ROOT, 'app/api/delivery'));
        expect(offenders).toEqual([]);
    });

    it('B5. Production Packed & Ready box labels are UNCHANGED', () => {
        const page = strip(read(OL600_PAGE));
        expect(page).toMatch(/OL600_SHEET/);
        expect(page).toMatch(/paginateLabelSheets\(/);
        expect(page).toMatch(/readBoxLabelBatch\(/);
        expect(page).toMatch(/'\/api\/production\/box-labels'/);
        const q = strip(read(QUEUE_UI));
        expect(q).toMatch(/Box Labels — All Orders/);
    });

    it('B6. the OL600 sheet geometry itself is untouched', () => {
        const s = strip(read(LAYOUT));
        expect(s).toMatch(/labelsPerSheet:\s*8/);
        expect(s).toMatch(/labelWidthIn:\s*4/);
        expect(s).toMatch(/labelHeightIn:\s*2\.5/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17-19. REPRINT SCOPE
// ═════════════════════════════════════════════════════════════════════════════
describe('REPRINT SCOPE', () => {
    it('C1. the reprint batch is sourced from the ACTIVE Delivery population only', () => {
        const s = strip(read(DELIVERY));
        const fn = s.slice(s.indexOf('const reprintBoxLabels'), s.indexOf('const refreshData'));
        expect(fn.length).toBeGreaterThan(100);
        // `locations` is built from /api/delivery/queue, which is released-only.
        expect(fn).toMatch(/locations\.map\(l => l\.id\)/);
        expect(s).toMatch(/api\/delivery\/queue/);
    });

    it('C2. an unreleased order cannot enter the reprint batch, by construction', () => {
        // The queue route demands the handoff, so an unreleased order is never
        // in `locations` and therefore never in the batch.
        const q = strip(read('app/api/delivery/queue/route.ts'));
        expect(q).toMatch(/activeDeliveryOrderWhere\(/);
        const authority = strip(read('lib/delivery/activeDeliveryPopulation.ts'));
        expect(authority).toMatch(/released_to_delivery_at: \{ not: null \}/);
    });

    it('C3. reprinting consumes NO inventory and mutates NO lifecycle state', () => {
        // The label route is read-only by construction.
        const route = strip(read(OL600_ROUTE));
        expect(route).not.toMatch(/\.create\(|\.update\(|\.updateMany\(|\.upsert\(|\.delete\(|\$executeRaw|\$transaction/);
        expect(route).not.toMatch(/packagingItem|released_to_delivery|status:\s*'delivered'/);
        // And the Delivery handler itself only writes a browser batch.
        const s = strip(read(DELIVERY));
        const fn = s.slice(s.indexOf('const reprintBoxLabels'), s.indexOf('const refreshData'));
        expect(fn).not.toMatch(/api\/delivery\/handoff|released_to_delivery|packagingItem|record-print-job/);
    });

    it('C4. the reprint is tenant-verified before anything is queued', () => {
        const s = strip(read(DELIVERY));
        const fn = s.slice(s.indexOf('const reprintBoxLabels'), s.indexOf('const refreshData'));
        expect(fn).toMatch(/fetchAuthenticatedBusinessId\(\)/);
        expect(fn).toMatch(/if \(!ownerBusinessId\)/);
        expect(fn).toMatch(/businessId: ownerBusinessId/);
        // And the server re-checks tenant on every id regardless.
        expect(strip(read(OL600_ROUTE))).toMatch(/business_id: businessId/);
    });

    it('C5. a refusal is surfaced, never silent', () => {
        const s = strip(read(DELIVERY));
        expect(s).toMatch(/setLabelError\(/);
        expect(s).toMatch(/\{labelError && \(/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4-10 + 13-15. NOTHING ELSE MOVED
// ═════════════════════════════════════════════════════════════════════════════
describe('PRESERVATION', () => {
    it('D1. Delivery counts, Slips badge and Manifest links are unchanged', () => {
        const s = read(DELIVERY);
        expect(s).toMatch(/\{stats\?\.physicalBoxCount \?\? 0\}/);
        expect(s).toMatch(/\{stats\?\.largeBoxCount \?\? 0\}/);
        expect(s).toMatch(/\{stats\?\.smallBoxCount \?\? 0\}/);
        expect(s).toMatch(/\{slipCount \?\? stats\?\.physicalBoxCount \?\? 0\}/);
        expect(s).toMatch(/\/delivery\/print-manifest/);
        expect(s).toMatch(/\/delivery\/print-packing-slips/);
    });

    it('D2. canonical packing is untouched — 2 same-order S2 still make ONE large box', () => {
        const { summarizeItemPacking } = require('@/lib/physicalBoxPacking');
        const r = summarizeItemPacking([{ id: 'o', items: [
            { id: 'i', bundle_id: 'b', quantity: 2, variant_size: 'serves_2' },
        ] }]);
        expect(r.physicalBoxCount).toBe(1);
        expect(r.largeBoxCount).toBe(1);
        expect(r.smallBoxCount).toBe(0);

        for (const f of ['lib/physicalBoxPacking.ts', 'lib/supporterBoxManifest.ts']) {
            expect(strip(read(f))).not.toMatch(/avery|5821|defaultLabelId/i);
        }
    });

    it('D3. Send to Delivery and the handoff are unchanged', () => {
        const q = strip(read(QUEUE_UI));
        expect(q).toMatch(/const sendToDelivery = async/);
        expect((q.match(/\/api\/delivery\/handoff/g) || []).length).toBe(1);
        const h = strip(read('app/api/delivery/handoff/route.ts'));
        expect(h).toMatch(/released_to_delivery_at: null/);   // the compare-and-set guard
        expect(h).toMatch(/released_to_delivery_at: releasedAt/);
    });

    it('D4. packing slips — both contexts — are unchanged', () => {
        expect(strip(read('app/api/production/packing-slips/route.ts'))).toMatch(/released_to_delivery_at: null/);
        expect(strip(read('app/api/delivery/packing-slips/route.ts'))).toMatch(/activeDeliveryOrderWhere\(/);
        expect(strip(read('app/delivery/print-packing-slips/page.tsx'))).toMatch(/source'\) === 'packed-ready'/);
    });

    it('D5. no Delivered or Archive behaviour was added', () => {
        const s = strip(read(DELIVERY));
        const fn = s.slice(s.indexOf('const reprintBoxLabels'), s.indexOf('const refreshData'));
        expect(fn).not.toMatch(/archive/i);
        expect(fn).not.toMatch(/status:\s*'delivered'/);
    });

    it('D6. no schema change and no migration were made by this phase', () => {
        const schema = read('prisma/schema.prisma');
        expect((schema.match(/released_to_delivery_at/g) || []).length).toBe(1);
        // PackagingItem.defaultLabelId still EXISTS — the column is dormant,
        // not dropped, exactly as Part D requires.
        expect(schema).toMatch(/defaultLabelId\s+String\?/);
        const migrations = readdirSync(join(ROOT, 'prisma/migrations')).filter(d => /^\d{14}_/.test(d));
        expect(migrations[migrations.length - 1]).toBe('20260905000000_ops6b_order_delivery_handoff');
    });
});
