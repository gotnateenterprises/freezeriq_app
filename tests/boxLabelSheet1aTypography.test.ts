/**
 * BOX-LABEL-SHEET-1A — OL600WX sticker typography and space utilisation.
 *
 * The owner physically test-printed BOX-LABEL-SHEET-1 and accepted the sheet
 * alignment, the 8-up pagination and the packing. The remaining issue was
 * INSIDE each sticker: measured against its own 3.76in x 2.26in printable
 * area it filled only ~52% of the height, and `marginTop: 'auto'` on the box
 * type pooled all 1.08in of slack into one gap — the empty canyon. The
 * supporter name, the field a packer reads from several feet away, sat at
 * 17pt.
 *
 * This phase spends that slack on the things that matter. It changes NOTHING
 * outside the sticker: the OL600 geometry the owner physically verified is
 * asserted here to be byte-identical, because a geometry change would be a
 * regression against an already-approved physical print.
 *
 * FAILING-FIRST: a temporary probe ran against HEAD 707cb52 before any
 * implementation and failed 6/6 — no typography authority, name at the 17pt
 * baseline, content at 9pt, logo at 0.40in, `marginTop: 'auto'` present, and
 * no adaptation to name length. Folded into section 0 below.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
    chooseStickerTypography,
    STICKER_TYPOGRAPHY_TIERS,
    NAME_LONG_THRESHOLD,
} from '@/lib/labelTypography';
import { OL600_SHEET, paginateLabelSheets, slotOrigin, normalizeStartPosition } from '@/lib/labelSheetLayout';
import { packOrder, boxContentLines, formatBoxContentLine } from '@/lib/physicalBoxPacking';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = 'app/production/box-labels/page.tsx';
const TYPO = 'lib/labelTypography.ts';
const LAYOUT = 'lib/labelSheetLayout.ts';
const PACKING = 'lib/physicalBoxPacking.ts';

// The BOX-LABEL-SHEET-1 baseline this phase improves on.
const BASELINE_NAME_PT = 17;
const BASELINE_CONTENT_PT = 9;
const BASELINE_LOGO_IN = 0.4;

// Sticker geometry, from the frozen manufacturer template.
const PT = 1 / 72;
const PAD_IN = 0.12;
const USABLE_W_IN = OL600_SHEET.labelWidthIn - PAD_IN * 2;   // 3.76
const USABLE_H_IN = OL600_SHEET.labelHeightIn - PAD_IN * 2;  // 2.26

/**
 * Extract one CSS rule body, delimited by the NEXT selector.
 *
 * Deliberately not `indexOf('}')`: these declarations embed `${...}`
 * interpolations, and the interpolation's own closing brace would truncate
 * the slice mid-declaration — which would silently make a scoped assertion
 * match nothing at all.
 */
const cssRule = (raw: string, selector: string, nextMarker: string): string => {
    const start = raw.indexOf(selector);
    if (start === -1) throw new Error(`CSS rule not found: ${selector}`);
    const end = raw.indexOf(nextMarker, start);
    return raw.slice(start, end === -1 ? undefined : end);
};

const src = strip(read(PAGE));
const sticker = src.slice(src.indexOf('className="label-slot"'));
const logoIn = (name: string) =>
    Number((src.match(new RegExp(`const ${name} = '([\\d.]+)in';`)) || [])[1]);
const LOGO_H = logoIn('LOGO_MAX_HEIGHT_IN');
const LOGO_W = logoIn('LOGO_MAX_WIDTH_IN');
const BOX_TYPE_PT = Number((sticker.match(/fontSize: '([\d.]+)pt'[^}]*textTransform: 'uppercase'/) || [])[1]);

/**
 * Worst-case printed height of a sticker under one tier: the supporter name
 * on `nameLines` lines, and EVERY content entry wrapped to two rendered rows.
 */
const worstCaseHeight = (tier: { nameSizePt: number; contentSizePt: number }, nameLines: number, entries: number) => {
    const header = LOGO_H + 0.04;
    const name = nameLines * (tier.nameSizePt * 1.05 * PT) + 0.06;
    const contents = entries * 2 * (tier.contentSizePt * 1.25 * PT) + (entries - 1) * 0.02;
    const boxType = BOX_TYPE_PT * 1.2 * PT;
    return header + name + contents + boxType;
};

// Real physical boxes from the real packing authority.
const ITEM = (over: any = {}) => ({
    id: 'oi-x', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2',
    item_name: 'A', bundle: { id: 'b-1', name: 'A' }, ...over,
});
const ORDER = (items: any[], over: any = {}) => ({
    id: 'ord-1', first_name: 'Wyatt', last_name: 'Williamson', customer_name: 'Wyatt Williamson',
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
describe('0. failing-first: the sticker was undersized and under-used', () => {
    it('0a. a deterministic typography authority exists and is pure', () => {
        expect(existsSync(join(ROOT, TYPO))).toBe(true);
        const s = strip(read(TYPO));
        expect(s).not.toMatch(/from ['"]react['"]|prisma|fetch\(|document\.|window\.|getBoundingClientRect/);
    });

    it('0b. the baseline 52% utilisation is measurably improved', () => {
        // The old stack: 0.40in logo row, 17pt name, 2 x 9pt content, 6.5pt type.
        const before = (0.4 + 0.04)
            + (BASELINE_NAME_PT * 1.05 * PT + 0.06)
            + (2 * (BASELINE_CONTENT_PT * 1.22 * PT) + 0.02)
            + (6.5 * 1.2 * PT);
        // The same case now (short name, two content entries -> standard).
        const t = chooseStickerTypography('Wyatt Williamson', 2);
        const after = (LOGO_H + 0.04)
            + (t.nameSizePt * 1.05 * PT + 0.06)
            + (2 * (t.contentSizePt * 1.25 * PT) + 0.02)
            + (BOX_TYPE_PT * 1.2 * PT);
        expect(before / USABLE_H_IN).toBeLessThan(0.55);
        expect(after).toBeGreaterThan(before);
        expect(after / USABLE_H_IN).toBeGreaterThan(0.65);
    });

    it('0c. slack is distributed, not pooled below the content', () => {
        expect(read(PAGE)).not.toMatch(/marginTop: 'auto'/);
        expect(read(PAGE)).toMatch(/\.label-slot\s*\{[\s\S]*?justify-content:\s*space-between/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1-2. FROZEN GEOMETRY — the owner's physical alignment must not move.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-2. OL600 geometry is frozen', () => {
    it('1. every manufacturer figure is unchanged', () => {
        expect(OL600_SHEET.sheetWidthIn).toBe(8.5);
        expect(OL600_SHEET.sheetHeightIn).toBe(11);
        expect(OL600_SHEET.labelWidthIn).toBe(4);
        expect(OL600_SHEET.labelHeightIn).toBe(2.5);
        expect(OL600_SHEET.columns).toBe(2);
        expect(OL600_SHEET.rows).toBe(4);
        expect(OL600_SHEET.labelsPerSheet).toBe(8);
        expect(OL600_SHEET.marginTopIn).toBe(0.5);
        expect(OL600_SHEET.marginBottomIn).toBe(0.5);
        expect(OL600_SHEET.marginLeftIn).toBe(0.18);
        expect(OL600_SHEET.marginRightIn).toBe(0.18);
        expect(OL600_SHEET.horizontalGapIn).toBe(0.14);
        expect(OL600_SHEET.verticalGapIn).toBe(0);
        expect(OL600_SHEET.horizontalPitchIn).toBe(4.14);
        expect(OL600_SHEET.verticalPitchIn).toBe(2.5);
    });

    it('1b. slot origins are unchanged, so registration cannot have moved', () => {
        const expected = [
            [0.18, 0.5], [4.32, 0.5], [0.18, 3.0], [4.32, 3.0],
            [0.18, 5.5], [4.32, 5.5], [0.18, 8.0], [4.32, 8.0],
        ];
        for (let p = 1; p <= 8; p++) {
            const { leftIn, topIn } = slotOrigin(p);
            expect(leftIn).toBeCloseTo(expected[p - 1][0], 10);
            expect(topIn).toBeCloseTo(expected[p - 1][1], 10);
        }
    });

    it('2. the sticker rectangle is still exactly 4 x 2.5 on a Letter page', () => {
        const raw = read(PAGE);
        expect(raw).toMatch(/size:\s*8\.5in 11in/);

        // Scoped to the .label-slot RULE, not the whole file: .align-slot
        // declares the same dimensions, so an unscoped match would pass even
        // while the real sticker was resized — and a sticker taller than its
        // die-cut would bleed into the row below.
        //
        // The rule body is delimited by the NEXT selector rather than the
        // next `}`: these declarations contain `${...}` interpolations, whose
        // closing brace would otherwise truncate the slice mid-declaration.
        const slotRule = cssRule(raw, '.label-slot {', '.align-slot {');
        expect(slotRule).toMatch(/width:\s*\$\{OL600_SHEET\.labelWidthIn\}in/);
        expect(slotRule).toMatch(/height:\s*\$\{OL600_SHEET\.labelHeightIn\}in/);
        expect(slotRule).toMatch(/padding:\s*\$\{LABEL_PADDING_IN\}/);
        expect(slotRule).toMatch(/overflow:\s*hidden/);
        // No hardcoded inch dimension may replace the shared constants.
        expect(slotRule).not.toMatch(/width:\s*[\d.]+in/);
        expect(slotRule).not.toMatch(/height:\s*[\d.]+in/);

        // The alignment-test outline uses the same constants, so the printed
        // guide can never disagree with the real sticker.
        const alignRule = cssRule(raw, '.align-slot {', '`,');
        expect(alignRule).toMatch(/width:\s*\$\{OL600_SHEET\.labelWidthIn\}in/);
        expect(alignRule).toMatch(/height:\s*\$\{OL600_SHEET\.labelHeightIn\}in/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3-7. SUPPORTER NAME AND LOGO.
// ═════════════════════════════════════════════════════════════════════════════
describe('3-7. name and logo', () => {
    it('3. the supporter name is larger than the 17pt baseline in EVERY tier', () => {
        for (const tier of Object.values(STICKER_TYPOGRAPHY_TIERS)) {
            expect(tier.nameSizePt).toBeGreaterThan(BASELINE_NAME_PT);
        }
        // The common case is substantially larger.
        expect(chooseStickerTypography('Wyatt Williamson', 2).nameSizePt).toBeGreaterThanOrEqual(20);
        expect(chooseStickerTypography('Sue Fulton', 1).nameSizePt).toBeGreaterThanOrEqual(24);
    });

    it('4. the name remains the largest text on the sticker in EVERY tier', () => {
        for (const tier of Object.values(STICKER_TYPOGRAPHY_TIERS)) {
            expect(tier.nameSizePt).toBeGreaterThan(tier.contentSizePt);
            expect(tier.nameSizePt).toBeGreaterThan(BOX_TYPE_PT);
        }
        // Box N of M is fixed at 10pt and must also stay below the name.
        const boxNumPt = Number((sticker.match(/fontSize: '(\d+)pt', fontWeight: 900, whiteSpace: 'nowrap'/) || [])[1]);
        expect(boxNumPt).toBeGreaterThan(0);
        for (const tier of Object.values(STICKER_TYPOGRAPHY_TIERS)) {
            expect(tier.nameSizePt).toBeGreaterThan(boxNumPt);
        }
    });

    it('5. the tenant logo is larger than the 0.40in baseline', () => {
        expect(LOGO_H).toBeGreaterThan(BASELINE_LOGO_IN);
        const growth = LOGO_H / BASELINE_LOGO_IN;
        expect(growth).toBeGreaterThanOrEqual(1.25);
        expect(growth).toBeLessThanOrEqual(1.5);
        // The width ceiling grew too, for a future wide wordmark.
        expect(LOGO_W).toBeGreaterThan(1.3);
    });

    it('6. the logo stays proportional and cannot overpower the name', () => {
        const imgTag = src.slice(src.indexOf('<img'), src.indexOf('/>', src.indexOf('<img')));
        expect(imgTag).toMatch(/objectFit:\s*'contain'/);
        expect(imgTag).toMatch(/maxHeight: LOGO_MAX_HEIGHT_IN/);
        expect(imgTag).toMatch(/maxWidth: LOGO_MAX_WIDTH_IN/);
        expect(imgTag).not.toMatch(/\bheight:\s*'[\d.]+in'/);
        expect(imgTag).not.toMatch(/\bwidth:\s*'[\d.]+in'/);
        // Bounded relative to the smallest name tier.
        const smallestName = Math.min(...Object.values(STICKER_TYPOGRAPHY_TIERS).map((t) => t.nameSizePt));
        expect(LOGO_H).toBeLessThan(smallestName * 1.05 * PT * 3);
        // The header row still leaves room for Box N of M beside the logo.
        expect(LOGO_W).toBeLessThan(USABLE_W_IN * 0.55);
    });

    it('7. the logo readiness and tenant-name fallback are untouched', () => {
        expect(src).toMatch(/chooseBrandHeader\(branding\.logoUrl, branding\.businessName, logoStatus\)/);
        expect(src).toMatch(/new window\.Image\(\)/);
        expect(src).toMatch(/onError=\{\(\) => setLogoStatus\('failed'\)\}/);
        const { chooseBrandHeader } = require('@/lib/tenantLogo');
        expect(chooseBrandHeader('https://cdn/l.png', 'Freezer Chef', 'failed')).toBe('name');
        expect(chooseBrandHeader('https://cdn/l.png', 'Freezer Chef', 'pending')).toBe('name');
        expect(chooseBrandHeader('https://cdn/l.png', 'Freezer Chef', 'ok')).toBe('logo');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8-12. CONTENT, FIT AND COMPOSITION.
// ═════════════════════════════════════════════════════════════════════════════
describe('8-12. content and fit', () => {
    it('8. Box N of M is semantically unchanged', () => {
        expect(sticker).toMatch(/Box \{box\.boxNumber\} of \{box\.boxTotal\}/);
        const boxes = boxesOf(ORDER([ITEM({ id: 'oi-1', quantity: 3 })]));
        expect(boxes.map((b: any) => `${b.boxNumber}/${b.boxTotal}`)).toEqual(['1/2', '2/2']);
    });

    it('9. content wording is unchanged', () => {
        const p = strip(read(PACKING));
        expect(p).toMatch(/\$\{line\.bundleName\} — \$\{line\.servingTier\}/);
        expect(p).toMatch(/\$\{base\}\s*×\$\{line\.count\}/);
        expect(sticker).toMatch(/formatBoxContentLine\(line\)/);
    });

    it('9b. EVERY content line is rendered — truth is never abbreviated to fit', () => {
        // A paired Serves-2 box carries two real bundles. Rendering only the
        // first would silently omit a bundle that is physically in the
        // carton, which is the one thing this label must never do. The
        // sticker maps the WHOLE array, with no slice, cap or filter.
        expect(sticker).toMatch(/\{contentLines\.map\(\(line, i\) =>/);
        expect(sticker).not.toMatch(/contentLines\.slice\(/);
        expect(sticker).not.toMatch(/contentLines\[0\]/);
        expect(sticker).not.toMatch(/contentLines\.filter\(/);
        // ...and the count it sizes from is the full count, so a truncating
        // render could not even be masked by a smaller tier.
        expect(src).toMatch(/chooseStickerTypography\(box\.supporterName, contentLines\.length\)/);

        // Behavioural counterpart: a paired box really does have two lines.
        const boxes = boxesOf(ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Q1 - Hearty Meals' }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Q2 - Comfort Foods' }),
        ]));
        expect(boxContentLines(boxes[0])).toHaveLength(2);
    });

    it('10. content lines are at least as readable as the 9pt baseline', () => {
        for (const tier of Object.values(STICKER_TYPOGRAPHY_TIERS)) {
            expect(tier.contentSizePt).toBeGreaterThan(BASELINE_CONTENT_PT);
        }
        expect(chooseStickerTypography('Sue Fulton', 1).contentSizePt).toBeGreaterThanOrEqual(12);
    });

    it('11/12. one- and two-content-line layouts both fit their worst case', () => {
        const one = chooseStickerTypography('Sue Fulton', 1);
        const two = chooseStickerTypography('Wyatt Williamson', 2);
        expect(worstCaseHeight(one, 1, 1)).toBeLessThan(USABLE_H_IN);
        expect(worstCaseHeight(two, 1, 2)).toBeLessThan(USABLE_H_IN);
    });

    it('13. a long supporter name fits safely on two lines', () => {
        const long = 'Christopher Vanderbilt-Harrington';
        expect(long.length).toBeGreaterThan(NAME_LONG_THRESHOLD);
        const t = chooseStickerTypography(long, 2);
        expect(t.tier).toBe('compact');
        expect(worstCaseHeight(t, 2, 2)).toBeLessThan(USABLE_H_IN);
    });

    it('14. the worst case of ALL — long name plus two long bundles — still fits', () => {
        for (const [nameLines, entries] of [[1, 1], [1, 2], [2, 1], [2, 2]] as const) {
            const t = chooseStickerTypography(
                nameLines === 2 ? 'Christopher Vanderbilt-Harrington' : 'Sue Fulton',
                entries,
            );
            const h = worstCaseHeight(t, nameLines, entries);
            expect(h).toBeLessThan(USABLE_H_IN);
            // Real headroom, not a hairline pass.
            expect(USABLE_H_IN - h).toBeGreaterThan(0.15);
        }
    });

    it('15. LARGE / SMALL BOX remains visible and distinct', () => {
        expect(sticker).toMatch(/\{box\.boxType\} box/);
        expect(sticker).toMatch(/textTransform: 'uppercase'/);
        // Grew slightly and gained weight, but stays the smallest text.
        expect(BOX_TYPE_PT).toBeGreaterThan(6.5);
        for (const tier of Object.values(STICKER_TYPOGRAPHY_TIERS)) {
            expect(BOX_TYPE_PT).toBeLessThan(tier.contentSizePt);
        }
    });

    it('16/17. nothing overflows the sticker or bleeds into a neighbour', () => {
        const raw = read(PAGE);
        expect(raw).toMatch(/\.label-slot\s*\{[\s\S]*?overflow:\s*hidden/);
        expect(sticker).toMatch(/wordBreak: 'break-word'/);
        // Each tier fits the worst case it can actually be SELECTED for, so
        // clipping is a last resort that should never trigger. Asserting a
        // tier against a shape it is never chosen for would test an
        // unreachable state: `comfortable` is only ever picked for a short
        // name with one content entry, which is why it can afford 24pt.
        const reachable: Array<[string, number, number]> = [
            ['comfortable', 1, 1],  // short name, one entry
            ['standard', 1, 2],     // short name, two entries
            ['standard', 2, 1],     // long name, one entry
            ['compact', 2, 2],      // long name, two entries
        ];
        for (const [tierName, nameLines, entries] of reachable) {
            const tier = (STICKER_TYPOGRAPHY_TIERS as any)[tierName];
            expect(worstCaseHeight(tier, nameLines, entries)).toBeLessThan(USABLE_H_IN);
        }
        // And the selector really does map those shapes to those tiers.
        expect(chooseStickerTypography('Sue Fulton', 1).tier).toBe('comfortable');
        expect(chooseStickerTypography('Sue Fulton', 2).tier).toBe('standard');
        expect(chooseStickerTypography('Christopher Vanderbilt-Harrington', 1).tier).toBe('standard');
        expect(chooseStickerTypography('Christopher Vanderbilt-Harrington', 2).tier).toBe('compact');
    });

    it('18. the whole sticker is never CSS-transform scaled', () => {
        const raw = read(PAGE);
        expect(raw).not.toMatch(/transform:\s*scale/);
        expect(raw).not.toMatch(/zoom:/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTOMATIC TYPOGRAPHY — deterministic, never DOM-measured.
// ═════════════════════════════════════════════════════════════════════════════
describe('automatic typography is deterministic', () => {
    it('picks the expected tier for each real owner case', () => {
        // 1. Wyatt Williamson, two S2 content lines.
        expect(chooseStickerTypography('Wyatt Williamson', 2).tier).toBe('standard');
        // 2. Sue Fulton, one S2 content line.
        expect(chooseStickerTypography('Sue Fulton', 1).tier).toBe('comfortable');
        // 3. Julie Williamson, one S5 content line.
        expect(chooseStickerTypography('Julie Williamson', 1).tier).toBe('comfortable');
        // 4. A long name that wraps.
        expect(chooseStickerTypography('Christopher Vanderbilt-Harrington', 2).tier).toBe('compact');
    });

    it('is a pure function of its two inputs — same input, same output', () => {
        for (const n of ['Sue Fulton', 'Wyatt Williamson', 'Christopher Vanderbilt-Harrington']) {
            for (const c of [1, 2]) {
                expect(chooseStickerTypography(n, c)).toEqual(chooseStickerTypography(n, c));
            }
        }
    });

    it('never measures the DOM or loops to fit', () => {
        const s = strip(read(TYPO));
        expect(s).not.toMatch(/getBoundingClientRect|offsetWidth|scrollHeight|while\s*\(|requestAnimationFrame/);
        expect(strip(read(PAGE))).not.toMatch(/getBoundingClientRect|offsetHeight|scrollHeight/);
    });

    it('degrades safely on odd input rather than throwing', () => {
        expect(chooseStickerTypography('', 1).tier).toBe('comfortable');
        expect(chooseStickerTypography(null as any, 2).tier).toBe('standard');
        expect(chooseStickerTypography(undefined as any, NaN as any).tier).toBe('comfortable');
        expect(chooseStickerTypography('Sue', 0).tier).toBe('comfortable');
        expect(chooseStickerTypography('Sue', 99).tier).toBe('standard');
    });

    it('the page routes both variable sizes through the authority', () => {
        expect(src).toMatch(/chooseStickerTypography\(box\.supporterName, contentLines\.length\)/);
        expect(sticker).toMatch(/fontSize: `\$\{type\.nameSizePt\}pt`/);
        expect(sticker).toMatch(/fontSize: `\$\{type\.contentSizePt\}pt`/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19-26. FROZEN BEHAVIOUR.
// ═════════════════════════════════════════════════════════════════════════════
describe('19-26. frozen behaviour', () => {
    it('19. one physical box is still exactly one sticker', () => {
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

    it('20. Serves-2 pairing is unchanged', () => {
        const three = packOrder(ORDER([ITEM({ id: 'oi-1', quantity: 3 })]));
        expect(three.ok && three.result.physicalBoxCount).toBe(2);
        expect(three.ok && three.result.boxes.map((b: any) => b.boxType)).toEqual(['large', 'small']);
        const s5 = packOrder(ORDER([ITEM({ id: 'oi-1', variant_size: 'serves_5' })]));
        expect(s5.ok && s5.result.boxes[0].boxType).toBe('large');
    });

    it('21/23/24. pagination is unchanged — 8 to a sheet, 16 to two', () => {
        const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));
        expect(paginateLabelSheets(labels(8), 1)).toHaveLength(1);
        expect(paginateLabelSheets(labels(16), 1)).toHaveLength(2);
        expect(paginateLabelSheets(labels(9), 1)).toHaveLength(2);
        expect(paginateLabelSheets(labels(17), 1)).toHaveLength(3);
        expect(paginateLabelSheets([], 1)).toEqual([]);
    });

    it('22. start-position behaviour is unchanged', () => {
        const labels = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));
        const sheets = paginateLabelSheets(labels(6), 4);
        expect(sheets).toHaveLength(2);
        expect(sheets[0].slots.filter((s) => s.label !== null).map((s) => s.position)).toEqual([4, 5, 6, 7, 8]);
        expect(sheets[1].slots.filter((s) => s.label !== null).map((s) => s.position)).toEqual([1]);
        expect(normalizeStartPosition(9)).toBe(8);
        expect(src).toMatch(/paginateLabelSheets\(boxes \|\| \[\], startPosition\)/);
    });

    it('25. Delivery is untouched', () => {
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
                    && /labelTypography|labelSheetLayout|physicalBoxPacking/.test(fs.readFileSync(full, 'utf8'))) {
                    hits.push(full);
                }
            }
        };
        walk(path.join(ROOT, 'app/delivery'));
        walk(path.join(ROOT, 'app/api/delivery'));
        expect(hits).toEqual([]);
    });

    it('26. no schema change, and the typography authority writes nothing', () => {
        expect(read('prisma/schema.prisma')).not.toMatch(/typography|font_size|sticker/i);
        const s = strip(read(TYPO));
        expect(s).not.toMatch(/prisma|\.create\(|\.update\(/);
        // It knows nothing about packing or geometry — it only sizes text.
        expect(s).not.toMatch(/OL600|slot|sheet|pagination/i);
    });

    it('26b. the layout and packing authorities are untouched by this phase', () => {
        const layout = strip(read(LAYOUT));
        expect(layout).not.toMatch(/labelTypography|fontSize|nameSizePt/);
        const packing = strip(read(PACKING));
        expect(packing).not.toMatch(/labelTypography|fontSize/);
    });
});
