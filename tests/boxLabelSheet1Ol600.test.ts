/**
 * BOX-LABEL-SHEET-1 — OL600WX 8-up physical box label sheet printing.
 *
 * The owner's real stock is OnlineLabels OL600WX: 4" x 2.5" stickers, eight
 * to a US Letter sheet. Every phase up to OPS-6A.3 printed ONE physical box
 * onto ONE 4x6 page, so sixteen boxes meant sixteen pages instead of two
 * sheets.
 *
 * THIS PHASE CHANGES PAGINATION ONLY. The physical-box truth — what a box is,
 * what it contains, and its Box N of M — is decided upstream by
 * lib/physicalBoxPacking.ts and is asserted here to be untouched.
 *
 * FAILING-FIRST: a temporary probe ran against HEAD a72bb42 (Production)
 * before any implementation and failed 7/7 — no sheet-layout authority, the
 * page still declared `size: 4in 6in`, eight labels could not be shown to
 * occupy one sheet, the print DOM mapped one box to one full page, and there
 * was no start-position support. Folded into section 0 below.
 *
 * The geometry figures are OnlineLabels' published OL600 template, asserted
 * exactly so a future "tidy up" cannot round 0.18 to 0.25 or drop the 0.14
 * gutter and silently shift every sticker off its die-cut.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
    OL600_SHEET,
    FIRST_SLOT,
    LAST_SLOT,
    slotOrigin,
    paginateLabelSheets,
    normalizeStartPosition,
    placedLabels,
    occupiedSlotCount,
} from '@/lib/labelSheetLayout';
import { packOrder, boxContentLines, formatBoxContentLine } from '@/lib/physicalBoxPacking';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = 'app/production/box-labels/page.tsx';
const LAYOUT = 'lib/labelSheetLayout.ts';
const PACKING = 'lib/physicalBoxPacking.ts';
const MANIFEST = 'lib/supporterBoxManifest.ts';

/** N distinct, identifiable stand-in labels. */
const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `L${i + 1}` }));
const ids = (arr: { id: string }[]) => arr.map((x) => x.id);

// Real physical boxes, from the real packing authority.
const ITEM = (over: any = {}) => ({
    id: 'oi-x', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2',
    item_name: 'A', bundle: { id: 'b-1', name: 'A' }, ...over,
});
const ORDER = (items: any[], over: any = {}) => ({
    id: 'ord-1', first_name: 'Jane', last_name: 'Smith', customer_name: 'Jane Smith',
    items, ...over,
});
const boxesOf = (order: any) => {
    const r = packOrder(order);
    if (!r.ok) throw new Error(`expected packing: ${r.reason}`);
    return r.result.boxes;
};

// ═════════════════════════════════════════════════════════════════════════════
// 0. FAILING-FIRST.
// ═════════════════════════════════════════════════════════════════════════════
describe('0. failing-first: one 4x6 page per box could not satisfy OL600WX', () => {
    it('0a. a pure OL600 sheet-layout authority now exists', () => {
        expect(existsSync(join(ROOT, LAYOUT))).toBe(true);
        const s = strip(read(LAYOUT));
        expect(s).not.toMatch(/from ['"]react['"]|prisma|fetch\(|document\.|window\.|Date\.now|Math\.random/);
    });

    it('0b. the printed page is US Letter, not a 4x6 label page', () => {
        const s = read(PAGE);
        expect(s).toMatch(/size:\s*8\.5in 11in/);
        expect(s).not.toMatch(/size:\s*4in 6in/);
    });

    it('0c. 8 labels occupy ONE sheet and 16 occupy exactly TWO', () => {
        expect(paginateLabelSheets(labels(8), 1)).toHaveLength(1);
        expect(paginateLabelSheets(labels(16), 1)).toHaveLength(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1-12. GEOMETRY — the manufacturer template, exactly.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-12. OL600 geometry', () => {
    it('1. the page is exactly 8.5 x 11', () => {
        expect(OL600_SHEET.sheetWidthIn).toBe(8.5);
        expect(OL600_SHEET.sheetHeightIn).toBe(11);
        expect(read(PAGE)).toMatch(/size:\s*8\.5in 11in/);
    });

    it('2. the label is exactly 4 x 2.5', () => {
        expect(OL600_SHEET.labelWidthIn).toBe(4);
        expect(OL600_SHEET.labelHeightIn).toBe(2.5);
    });

    it('3/4. 2 columns x 4 rows = 8 per sheet', () => {
        expect(OL600_SHEET.columns).toBe(2);
        expect(OL600_SHEET.rows).toBe(4);
        expect(OL600_SHEET.labelsPerSheet).toBe(8);
        expect(OL600_SHEET.columns * OL600_SHEET.rows).toBe(OL600_SHEET.labelsPerSheet);
    });

    it('5/6. top and bottom margins are 0.5', () => {
        expect(OL600_SHEET.marginTopIn).toBe(0.5);
        expect(OL600_SHEET.marginBottomIn).toBe(0.5);
    });

    it('7/8. left and right margins are 0.18', () => {
        expect(OL600_SHEET.marginLeftIn).toBe(0.18);
        expect(OL600_SHEET.marginRightIn).toBe(0.18);
    });

    it('9. horizontal gap is 0.14', () => {
        expect(OL600_SHEET.horizontalGapIn).toBe(0.14);
    });

    it('10. vertical gap is zero', () => {
        expect(OL600_SHEET.verticalGapIn).toBe(0);
    });

    it('11. horizontal pitch is 4.14 and equals width + gap', () => {
        expect(OL600_SHEET.horizontalPitchIn).toBe(4.14);
        expect(OL600_SHEET.labelWidthIn + OL600_SHEET.horizontalGapIn)
            .toBeCloseTo(OL600_SHEET.horizontalPitchIn, 10);
    });

    it('12. vertical pitch is 2.5 and equals height + gap', () => {
        expect(OL600_SHEET.verticalPitchIn).toBe(2.5);
        expect(OL600_SHEET.labelHeightIn + OL600_SHEET.verticalGapIn)
            .toBeCloseTo(OL600_SHEET.verticalPitchIn, 10);
    });

    it('12b. the geometry CLOSES arithmetically in both axes', () => {
        const w = OL600_SHEET.marginLeftIn + OL600_SHEET.labelWidthIn
            + OL600_SHEET.horizontalGapIn + OL600_SHEET.labelWidthIn + OL600_SHEET.marginRightIn;
        expect(w).toBeCloseTo(OL600_SHEET.sheetWidthIn, 10);

        const h = OL600_SHEET.marginTopIn
            + OL600_SHEET.rows * OL600_SHEET.labelHeightIn + OL600_SHEET.marginBottomIn;
        expect(h).toBeCloseTo(OL600_SHEET.sheetHeightIn, 10);
    });

    it('12c. every slot origin sits inside the sheet, in reading order', () => {
        const expected = [
            [0.18, 0.5], [4.32, 0.5],
            [0.18, 3.0], [4.32, 3.0],
            [0.18, 5.5], [4.32, 5.5],
            [0.18, 8.0], [4.32, 8.0],
        ];
        for (let p = FIRST_SLOT; p <= LAST_SLOT; p++) {
            const { leftIn, topIn } = slotOrigin(p);
            expect(leftIn).toBeCloseTo(expected[p - 1][0], 10);
            expect(topIn).toBeCloseTo(expected[p - 1][1], 10);
            // Never crosses the sheet edge.
            expect(leftIn + OL600_SHEET.labelWidthIn)
                .toBeLessThanOrEqual(OL600_SHEET.sheetWidthIn - OL600_SHEET.marginRightIn + 1e-9);
            expect(topIn + OL600_SHEET.labelHeightIn)
                .toBeLessThanOrEqual(OL600_SHEET.sheetHeightIn - OL600_SHEET.marginBottomIn + 1e-9);
        }
    });

    it('12d. the page positions slots from the shared authority, not hardcoded CSS', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/left: `\$\{slot\.leftIn\}in`/);
        expect(s).toMatch(/top: `\$\{slot\.topIn\}in`/);
        expect(s).toMatch(/width:\s*\$\{OL600_SHEET\.labelWidthIn\}in/);
        expect(s).toMatch(/height:\s*\$\{OL600_SHEET\.labelHeightIn\}in/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13-21. PAGINATION.
// ═════════════════════════════════════════════════════════════════════════════
describe('13-21. pagination', () => {
    it('13. 1 label -> 1 sheet with 1 occupied slot', () => {
        const sheets = paginateLabelSheets(labels(1), 1);
        expect(sheets).toHaveLength(1);
        expect(occupiedSlotCount(sheets[0])).toBe(1);
        expect(sheets[0].slots[0].label).toEqual({ id: 'L1' });
    });

    it('13b. 0 labels -> 0 printable sheets', () => {
        expect(paginateLabelSheets([], 1)).toEqual([]);
        expect(paginateLabelSheets(labels(0), 5)).toEqual([]);
    });

    it('14. 8 labels -> exactly 1 full sheet', () => {
        const sheets = paginateLabelSheets(labels(8), 1);
        expect(sheets).toHaveLength(1);
        expect(occupiedSlotCount(sheets[0])).toBe(8);
    });

    it('15. 9 labels -> 2 sheets', () => {
        const sheets = paginateLabelSheets(labels(9), 1);
        expect(sheets).toHaveLength(2);
        expect(occupiedSlotCount(sheets[0])).toBe(8);
        expect(occupiedSlotCount(sheets[1])).toBe(1);
    });

    it('16. 16 labels -> exactly 2 sheets, both full', () => {
        const sheets = paginateLabelSheets(labels(16), 1);
        expect(sheets).toHaveLength(2);
        expect(sheets.map(occupiedSlotCount)).toEqual([8, 8]);
    });

    it('17. 17 labels -> exactly 3 sheets', () => {
        const sheets = paginateLabelSheets(labels(17), 1);
        expect(sheets).toHaveLength(3);
        expect(sheets.map(occupiedSlotCount)).toEqual([8, 8, 1]);
    });

    it('18. a final partial sheet leaves its unused positions blank', () => {
        const sheets = paginateLabelSheets(labels(11), 1);
        const last = sheets[1];
        expect(last.slots.filter((s) => s.label === null).map((s) => s.position))
            .toEqual([4, 5, 6, 7, 8]);
        // Every sheet always exposes all 8 slots, blanks included.
        for (const sheet of sheets) expect(sheet.slots).toHaveLength(8);
    });

    it('19/20. no label is duplicated, and none is lost', () => {
        for (const n of [1, 5, 8, 9, 16, 17, 33]) {
            for (const start of [1, 3, 8]) {
                const placed = ids(placedLabels(paginateLabelSheets(labels(n), start)));
                expect(placed).toHaveLength(n);
                expect(new Set(placed).size).toBe(n);
            }
        }
    });

    it('21. ordering is deterministic and preserves the input order exactly', () => {
        const input = labels(17);
        const a = ids(placedLabels(paginateLabelSheets(input, 1)));
        const b = ids(placedLabels(paginateLabelSheets(input, 1)));
        expect(b).toEqual(a);
        expect(a).toEqual(ids(input));
        // Sheet numbers run 1..N with no gaps.
        const sheets = paginateLabelSheets(input, 1);
        expect(sheets.map((s) => s.sheetNumber)).toEqual([1, 2, 3]);
    });

    it('21b. the canonical physical-box order from packing is preserved', () => {
        // 1 x S5 + 3 x S2 -> 3 boxes in a defined order.
        const boxes = boxesOf(ORDER([
            ITEM({ id: 'oi-1', variant_size: 'serves_5', item_name: 'Big' }),
            ITEM({ id: 'oi-2', item_name: 'B' }),
            ITEM({ id: 'oi-3', item_name: 'C' }),
            ITEM({ id: 'oi-4', item_name: 'D' }),
        ]));
        expect(boxes).toHaveLength(3);
        const placed = placedLabels(paginateLabelSheets(boxes, 1));
        expect(placed.map((b: any) => b.boxNumber)).toEqual(boxes.map((b: any) => b.boxNumber));
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 22-27. START POSITION — using up a part-used sheet.
// ═════════════════════════════════════════════════════════════════════════════
describe('22-27. start position', () => {
    it('22. start=1 behaves as a fresh sheet', () => {
        const sheets = paginateLabelSheets(labels(3), 1);
        expect(sheets).toHaveLength(1);
        expect(sheets[0].slots.slice(0, 3).every((s) => s.label !== null)).toBe(true);
    });

    it('23. start=4 leaves positions 1-3 blank on the FIRST sheet', () => {
        const sheets = paginateLabelSheets(labels(5), 4);
        expect(sheets).toHaveLength(1);
        const s = sheets[0];
        expect(s.slots.filter((x) => x.label === null).map((x) => x.position)).toEqual([1, 2, 3]);
        expect(s.slots.filter((x) => x.label !== null).map((x) => x.position)).toEqual([4, 5, 6, 7, 8]);
    });

    it('24. start=8 places the first label in position 8', () => {
        const sheets = paginateLabelSheets(labels(1), 8);
        expect(sheets).toHaveLength(1);
        expect(sheets[0].slots[7].label).toEqual({ id: 'L1' });
        expect(occupiedSlotCount(sheets[0])).toBe(1);
    });

    it('25/26. overflow moves to the next sheet, which begins at position 1', () => {
        // 6 labels starting at 4: five on sheet one, one on sheet two.
        const sheets = paginateLabelSheets(labels(6), 4);
        expect(sheets).toHaveLength(2);
        expect(sheets[0].slots.filter((x) => x.label !== null).map((x) => x.position))
            .toEqual([4, 5, 6, 7, 8]);
        expect(sheets[1].slots.filter((x) => x.label !== null).map((x) => x.position))
            .toEqual([1]);
        // The lead-in offset applies to the FIRST sheet only.
        expect(sheets[1].slots[0].label).toEqual({ id: 'L6' });
    });

    it('26b. an out-of-range start position is clamped, never crashes', () => {
        expect(normalizeStartPosition(0)).toBe(1);
        expect(normalizeStartPosition(-4)).toBe(1);
        expect(normalizeStartPosition(9)).toBe(8);
        expect(normalizeStartPosition(1.5)).toBe(1);
        expect(normalizeStartPosition('4')).toBe(4);
        expect(normalizeStartPosition(undefined)).toBe(1);
        expect(normalizeStartPosition(NaN)).toBe(1);
    });

    it('27. the start position NEVER changes physical box count or Box N of M', () => {
        const boxes = boxesOf(ORDER([ITEM({ id: 'oi-1', quantity: 3 })]));
        const canonical = boxes.map((b: any) => `${b.boxNumber}/${b.boxTotal}`);
        for (const start of [1, 2, 5, 8]) {
            const placed = placedLabels(paginateLabelSheets(boxes, start));
            expect(placed).toHaveLength(boxes.length);
            expect(placed.map((b: any) => `${b.boxNumber}/${b.boxTotal}`)).toEqual(canonical);
        }
        // Blank lead-in slots are unused stickers, not missing boxes.
        const sheets = paginateLabelSheets(boxes, 5);
        expect(occupiedSlotCount(sheets[0]) + (sheets[1] ? occupiedSlotCount(sheets[1]) : 0))
            .toBe(boxes.length);
    });

    it('27b. the page exposes the control and routes it through the authority', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/const \[startPosition, setStartPosition\] = useState<number>\(FIRST_SLOT\);/);
        expect(s).toMatch(/setStartPosition\(normalizeStartPosition\(e\.target\.value\)\)/);
        expect(s).toMatch(/paginateLabelSheets\(boxes \|\| \[\], startPosition\)/);
        expect(s).toMatch(/Start at label position/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 28-36. LABEL CONTENT — owner-approved meaning preserved.
// ═════════════════════════════════════════════════════════════════════════════
describe('28-36. label content', () => {
    const sticker = () => {
        const s = strip(read(PAGE));
        return s.slice(s.indexOf('className="label-slot"'), s.indexOf('</div>\n                                );'));
    };

    it('28/29. supporter name and Box N of M are preserved on the sticker', () => {
        const s = sticker();
        expect(s).toMatch(/box\.supporterName/);
        expect(s).toMatch(/Box \{box\.boxNumber\} of \{box\.boxTotal\}/);
    });

    it('30. a Serves-5 box still prints its single bundle', () => {
        const boxes = boxesOf(ORDER([ITEM({ id: 'oi-1', variant_size: 'serves_5', item_name: 'Comfort Foods' })]));
        expect(boxes).toHaveLength(1);
        expect(boxContentLines(boxes[0]).map(formatBoxContentLine))
            .toEqual(['Comfort Foods — Serves 5']);
    });

    it('31. a paired box prints BOTH different Serves-2 bundles', () => {
        const boxes = boxesOf(ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Q1 - Hearty Meals' }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Q2 - Comfort Foods' }),
        ]));
        expect(boxes).toHaveLength(1);
        expect(boxContentLines(boxes[0]).map(formatBoxContentLine)).toEqual([
            'Q1 - Hearty Meals — Serves 2',
            'Q2 - Comfort Foods — Serves 2',
        ]);
    });

    it('32. identical Serves-2 purchases still merge to "x2"', () => {
        const boxes = boxesOf(ORDER([ITEM({ id: 'oi-1', item_name: 'Comfort Foods', quantity: 2 })]));
        expect(boxContentLines(boxes[0]).map(formatBoxContentLine))
            .toEqual(['Comfort Foods — Serves 2 ×2']);
    });

    it('33. the sold tier still comes from the frozen OrderItem.variant_size', () => {
        const boxes = boxesOf(ORDER([
            ITEM({ id: 'oi-1', variant_size: 'serves_2', bundle: { id: 'b-1', name: 'A', serving_tier: 'family' } }),
        ]));
        expect(boxes[0].contents[0].servingTier).toBe('Serves 2');
        for (const f of [PACKING, MANIFEST, LAYOUT]) {
            expect(strip(read(f))).not.toMatch(/serving_tier/);
        }
    });

    it('34. LARGE / SMALL BOX wording is preserved', () => {
        expect(sticker()).toMatch(/\{box\.boxType\} box/);
    });

    it('35/36. tenant logo authority and its name fallback are unchanged', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/chooseBrandHeader\(branding\.logoUrl, branding\.businessName, logoStatus\)/);
        expect(s).toMatch(/new window\.Image\(\)/);
        expect(s).toMatch(/onError=\{\(\) => setLogoStatus\('failed'\)\}/);
        expect(sticker()).toMatch(/renderBrandHeader\(\)/);
        const { chooseBrandHeader } = require('@/lib/tenantLogo');
        expect(chooseBrandHeader('https://cdn/l.png', 'Freezer Chef', 'failed')).toBe('name');
        expect(chooseBrandHeader('https://cdn/l.png', 'Freezer Chef', 'pending')).toBe('name');
        expect(chooseBrandHeader('https://cdn/l.png', 'Freezer Chef', 'ok')).toBe('logo');
    });

    it('36b. LONG CONTENT cannot bleed into a neighbouring sticker', () => {
        // A box holds at most TWO purchased instances by the packing rules, so
        // a sticker can never need more than two content lines — nothing is
        // dropped to make it fit. Long names wrap; the slot clips as a last
        // resort so one sticker can never overwrite another.
        const long = 'Quarter 1 Extremely Long Hearty Comfort Meals Bundle Name';
        const boxes = boxesOf(ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: long }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: long + ' Two' }),
        ], { first_name: 'Wyattlongfirstname', last_name: 'Williamsonlongsurname' }));
        expect(boxes).toHaveLength(1);
        expect(boxContentLines(boxes[0])).toHaveLength(2);

        const raw = read(PAGE);
        expect(raw).toMatch(/\.label-slot\s*\{[\s\S]*?overflow:\s*hidden/);
        expect(sticker()).toMatch(/wordBreak: 'break-word'/);
    });

    it('36c. no box can ever need more than two content lines', () => {
        for (const order of [
            ORDER([ITEM({ id: 'oi-1', variant_size: 'serves_5', quantity: 3 })]),
            ORDER([ITEM({ id: 'oi-1', quantity: 9 })]),
            ORDER([
                ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'A', quantity: 3 }),
                ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'B', quantity: 4 }),
            ]),
        ]) {
            for (const box of boxesOf(order)) {
                expect(boxContentLines(box).length).toBeLessThanOrEqual(2);
            }
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 37-42. PRINT SAFETY.
// ═════════════════════════════════════════════════════════════════════════════
describe('37-42. print safety', () => {
    it('37/38/39. controls, instructions and loading states are never printed', () => {
        const s = strip(read(PAGE));
        // Every operator surface sits inside print:hidden containers.
        expect(s).toMatch(/className="print:hidden max-w-4xl mx-auto p-6"/);
        expect(s).toMatch(/Preparing box labels…<\/div>/);
        expect(s).toMatch(/className="p-12 text-center print:hidden"/);
        expect(s).toMatch(/className="p-12 max-w-xl mx-auto text-center print:hidden"/);
        // The printable block contains no control or instruction text.
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).not.toMatch(/Print All|Start at label position|Actual Size|Shrink to Fit|<button/);
        expect(printBlock).not.toMatch(/Preparing box labels/);
    });

    it('40. no trailing blank sheet — the OPS-5F exemption carried to sheets', () => {
        const s = read(PAGE);
        expect(s).toMatch(/\.label-sheet\s*\{[^}]*break-after:\s*always/);
        expect(s).toMatch(/\.label-sheet:last-child\s*\{[\s\S]*?break-after:\s*auto/);
        expect(s).toMatch(/\.label-sheet:last-child\s*\{[\s\S]*?page-break-after:\s*auto/);
        const exemption = s.slice(
            s.indexOf('.label-sheet:last-child'),
            s.indexOf('}', s.indexOf('.label-sheet:last-child')),
        );
        expect(exemption).not.toMatch(/display:\s*none|visibility:\s*hidden|height:\s*0/);
    });

    it('41. one Letter DOM page per LabelSheet', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/sheets\.map\(\(sheet\) =>/);
        expect(printBlock).toMatch(/className="label-sheet"/);
        const raw = read(PAGE);
        expect(raw).toMatch(/\.label-sheet\s*\{[\s\S]*?width:\s*8\.5in/);
        expect(raw).toMatch(/\.label-sheet\s*\{[\s\S]*?height:\s*11in/);
    });

    it('42. no browser margin can insert an empty page between sheets', () => {
        const s = read(PAGE);
        const page = s.slice(s.indexOf('@page'), s.indexOf('}', s.indexOf('@page')) + 1);
        expect(page).toMatch(/margin:\s*0/);
        // The sheet is exactly the page, with overflow contained.
        expect(s).toMatch(/\.label-sheet\s*\{[\s\S]*?overflow:\s*hidden/);
    });

    it('42b. Ctrl+P fail-closed behaviour is preserved', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/blocked\.length > 0 \?/);
        expect(printBlock).toMatch(/DO NOT USE/);
        expect(s).toMatch(/if \(blocked\.length > 0\)/);
        expect(s).toMatch(/disabled=\{[^}]*blocked\.length > 0/);
    });

    it('42c. the alignment test prints slot outlines and NO supporter data', () => {
        const s = strip(read(PAGE));
        // Slice forward from the alignment branch to the NEXT sheets.map after
        // it — `sheets.map` also appears earlier in the screen preview, so an
        // unanchored indexOf would run the range backwards and match nothing.
        const alignStart = s.indexOf('alignmentMode ? (');
        expect(alignStart).toBeGreaterThan(-1);
        const align = s.slice(alignStart, s.indexOf('sheets.map((sheet) =>', alignStart));
        expect(align).toMatch(/className="align-slot"/);
        expect(align).not.toMatch(/supporterName|boxContentLines|box\.boxNumber|orderId/);
        expect(s).toMatch(/const handleAlignmentTest/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 43-47. SECURITY, SCHEMA, SCOPE.
// ═════════════════════════════════════════════════════════════════════════════
describe('43-47. security and scope', () => {
    it('43. tenant scope is unchanged — the page still proves ownership server-side', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/fetchAuthenticatedBusinessId\(\)/);
        expect(s).not.toMatch(/useSession/);
        const route = strip(read('app/api/production/box-labels/route.ts'));
        expect(route).toMatch(/business_id: businessId/);
        expect(route).not.toMatch(/body\??\.businessId|body\??\.business_id/);
    });

    it('44. no PII query params — the page still reads none at all', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/useSearchParams|URLSearchParams|window\.location\.search/);
        for (const f of [PAGE, LAYOUT]) {
            const src = strip(read(f));
            expect(src).not.toMatch(/\bemail\b/i);
            expect(src).not.toMatch(/\bphone\b/i);
            expect(src).not.toMatch(/delivery_address/);
        }
    });

    it('45. no schema change', () => {
        const schema = read('prisma/schema.prisma');
        expect(schema).not.toMatch(/label_sheet|slot_position|start_position|ol600/i);
    });

    it('46. no Production data mutation on the print path', () => {
        for (const f of [PAGE, LAYOUT]) {
            expect(strip(read(f)))
                .not.toMatch(/\.create\(|\.update\(|\.delete\(|\.upsert\(|\$executeRaw/);
        }
    });

    it('47. Delivery is untouched — nothing there consumes the new layout', () => {
        const fs = require('fs');
        const path = require('path');
        const hits: string[] = [];
        const walk = (dir: string) => {
            let entries: any[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (/\.(ts|tsx)$/.test(e.name)
                    && /labelSheetLayout|physicalBoxPacking|supporterBoxManifest/.test(fs.readFileSync(full, 'utf8'))) {
                    hits.push(full);
                }
            }
        };
        walk(path.join(ROOT, 'app/delivery'));
        walk(path.join(ROOT, 'app/api/delivery'));
        expect(hits).toEqual([]);
    });

    it('47b. packing truth is untouched by this phase', () => {
        // One physical box is still one sticker: pairing, counts and the
        // Serves-2 rules are exactly as OPS-6A left them.
        const paired = packOrder(ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'A' }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'B' }),
        ]));
        expect(paired.ok && paired.result.purchasedBundleCount).toBe(2);
        expect(paired.ok && paired.result.physicalBoxCount).toBe(1);
        const three = packOrder(ORDER([ITEM({ id: 'oi-1', quantity: 3 })]));
        expect(three.ok && three.result.physicalBoxCount).toBe(2);
        expect(three.ok && three.result.boxes.map((b: any) => b.boxType)).toEqual(['large', 'small']);
        // The layout authority knows nothing about packing.
        expect(strip(read(LAYOUT))).not.toMatch(/bundle|supporter|serves|tier|packing/i);
    });

    it('47c. two S2 bundles sharing a box still produce exactly ONE sticker', () => {
        const boxes = boxesOf(ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Q1 - Hearty Meals' }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Q2 - Comfort Foods' }),
        ]));
        const placed = placedLabels(paginateLabelSheets(boxes, 1));
        expect(placed).toHaveLength(1);
        expect(boxContentLines(placed[0] as any)).toHaveLength(2);
    });
});
