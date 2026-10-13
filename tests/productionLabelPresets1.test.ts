/**
 * PRODUCTION-LABEL-PRESETS-1 — label stock presets + Avery 15513.
 *
 * Freezer Chef bought Avery 15513 (2" x 4" waterproof film, laser, ten to a US
 * Letter sheet, on Avery's 5163 template). The box-label sheet now prints on a
 * chosen PRESET: a named sheet geometry plus the text sizes budgeted for that
 * label size. The preset never decides what a label says.
 *
 * What these tests hold:
 *   - doing nothing prints exactly what was printed before (the OL600WX stock);
 *   - Avery 15513 is the Avery 5163 geometry, to the manufacturer's figures;
 *   - an id outside the registry is refused, never interpreted;
 *   - the SAME boxes print the SAME business content, in the same order, with
 *     the same count, on every stock — only placement and type size differ;
 *   - 10-up pagination neither drops nor repeats a label at a page boundary;
 *   - auth, tenancy, the Production print action and Delivery's reprint are
 *     untouched.
 *
 * Several tests render the REAL page component (react-dom/server) with the
 * selected preset, so "the selector is ignored" cannot pass by matching text.
 * Byte-identity of the default output against Production 407f851, the real
 * Chrome print and the Avery template overlay are proven outside the suite
 * (see the phase report); this suite pins the behaviour that makes them true.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    OL600_SHEET,
    AVERY_5163_SHEET,
    FIRST_SLOT,
    lastSlot,
    slotOrigin,
    normalizeStartPosition,
    paginateLabelSheets,
    placedLabels,
    occupiedSlotCount,
    sheetGeometryProblems,
    type LabelSheetGeometry,
} from '@/lib/labelSheetLayout';
import {
    LABEL_PRESETS,
    LABEL_PRESET_IDS,
    DEFAULT_LABEL_PRESET,
    DEFAULT_LABEL_PRESET_ID,
    resolveLabelPreset,
    describePaper,
    formatInches,
    type LabelPreset,
} from '@/lib/labelPresets';
import {
    STICKER_FACES,
    DEFAULT_STICKER_FACE,
    STICKER_TYPOGRAPHY_TIERS,
    NAME_LONG_THRESHOLD,
    ORG_NAME_MEDIUM_THRESHOLD,
    ORG_NAME_LONG_THRESHOLD,
    chooseStickerTypography,
    chooseOrgNameTypography,
    type StickerFace,
} from '@/lib/labelTypography';
import { buildPhysicalBoxManifest, boxContentLines, formatBoxContentLine, type PhysicalBox } from '@/lib/physicalBoxPacking';

jest.mock('next/link', () => ({
    __esModule: true,
    default: (p: any) => require('react').createElement('a', { href: p.href, className: p.className }, p.children),
}));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGE = 'app/production/box-labels/page.tsx';
const PRESETS = 'lib/labelPresets.ts';
const LAYOUT = 'lib/labelSheetLayout.ts';
const TYPO = 'lib/labelTypography.ts';
const ROUTE = 'app/api/production/box-labels/route.ts';
const DELIVERY = 'app/delivery/page.tsx';
const QUEUE_UI = 'components/production/DeliveryQueue.tsx';

const AVERY = resolveLabelPreset('avery-15513') as LabelPreset;
const PT = 1 / 72;

// ── Fictional orders through the REAL packing authority ─────────────────────────
let seq = 0;
const item = (name: string, size: 'serves_2' | 'serves_5', quantity = 1) => {
    seq += 1;
    return { id: `oi-${String(seq).padStart(3, '0')}`, bundle_id: `b-${name}`, quantity, variant_size: size, item_name: name, bundle: { id: `b-${name}`, name } };
};
const order = (id: string, first: string, last: string, org: string | null, items: any[]) => ({
    id, first_name: first, last_name: last, customer_name: `${first} ${last}`,
    campaign_organization_name: org, campaign_name: org ? 'Fall Fundraiser (fictional)' : null, items,
});
const LONG_ORG = 'Northwest Example County Agricultural Youth Leaders'; // 51 chars: wraps, smallest bucket
const LONG_NAME_FIRST = 'Christopher';
const LONG_NAME_LAST = 'Vanderbilt-Harrington';                          // 33 chars with the first name
function fixtureBoxes(): PhysicalBox[] {
    seq = 0;
    const m = buildPhysicalBoxManifest([
        order('ord-01', 'Al', 'Li', 'Sample County Farm Bureau', [item('Hearty Family Meals', 'serves_5')]),
        order('ord-02', 'Jo', 'Sample', 'Sample County Farm Bureau', [item('Family Favorites (Serves 2) - Fall 2026', 'serves_2'), item('Comfort Classics (Serves 2) - Fall 2026', 'serves_2')]),
        order('ord-03', 'Avery', 'Testwell', 'Sample County Farm Bureau', [item('Keto Kitchen (Serves 2) - Fall 2026', 'serves_2', 3)]),
        order('ord-04', LONG_NAME_FIRST, LONG_NAME_LAST, 'Example Valley Farm Bureau Foundation', [item('Q1 - Soups & Casseroles Sampler (Serves 2)', 'serves_2'), item('Family Favorites (Serves 2) - Fall 2026', 'serves_2')]),
        order('ord-05', 'Mary-Catherine', "O'Sullivan-Hernandez", LONG_ORG, [item('Comfort Classics (Serves 2) - Fall 2026', 'serves_2'), item('Q1 - Soups & Casseroles Sampler (Serves 2)', 'serves_2')]),
        order('ord-06', 'Bartholomew', 'Featherstonehaugh', LONG_ORG, [item('Hearty Family Meals', 'serves_5', 2), item('Clean Eating/Paleo - Fall 2026', 'serves_2')]),
        order('ord-07', 'Riley', 'Example', 'Example Valley Farm Bureau Foundation', [item('Clean Eating/Paleo - Fall 2026', 'serves_2')]),
        order('ord-08', 'Morgan', 'Placeholder', 'Sample County Farm Bureau', [item('Family Favorites (Serves 2) - Fall 2026', 'serves_2', 2)]),
        order('ord-09', 'Casey', 'Demoson', null, [item('Comfort Classics', 'serves_5')]),
        order('ord-10', 'Taylor', 'Mockford', 'Example Valley Farm Bureau Foundation', [item('Keto Kitchen (Serves 2) - Fall 2026', 'serves_2'), item('Hearty Family Meals', 'serves_5')]),
        order('ord-11', 'Quinn', 'Trialson', LONG_ORG, [item('Q1 - Soups & Casseroles Sampler (Serves 2)', 'serves_2', 4)]),
        order('ord-12', 'Rowan', 'Specimen', 'Sample County Farm Bureau', [item('Clean Eating/Paleo - Fall 2026', 'serves_2'), item('Keto Kitchen (Serves 2) - Fall 2026', 'serves_2'), item('Family Favorites (Serves 2) - Fall 2026', 'serves_2')]),
        order('ord-13', 'Sage', 'Notreal', null, [item('Hearty Family Meals', 'serves_5')]),
        order('ord-14', 'Emerson', 'Fictional', 'Example Valley Farm Bureau Foundation', [item('Hearty Family Meals', 'serves_5'), item('Family Favorites (Serves 2) - Fall 2026', 'serves_2')]),
    ] as any);
    if (m.blocked.length) throw new Error('fixture must pack');
    return m.boxes;
}

/**
 * Render the real page as it stands once its batch has loaded, on `preset`.
 *
 * State is answered by identity rather than position where possible: the
 * label-stock state is the one initialised with DEFAULT_LABEL_PRESET, the start
 * position the one initialised with FIRST_SLOT, and the boxes are the page's
 * first state. Everything else keeps its own initial value. Effects (auth and
 * fetch) do not run.
 */
function renderPage(preset: LabelPreset, boxes: PhysicalBox[], startPosition = FIRST_SLOT): string {
    let call = 0;
    const useState = jest.spyOn(React, 'useState').mockImplementation(((init: any) => {
        call += 1;
        if (call === 1) return [boxes, () => {}];
        if (init === DEFAULT_LABEL_PRESET) return [preset, () => {}];
        if (init === FIRST_SLOT) return [startPosition, () => {}];
        return [typeof init === 'function' ? init() : init, () => {}];
    }) as any);
    const useEffect = jest.spyOn(React, 'useEffect').mockImplementation((() => {}) as any);
    try {
        const Page = require('@/app/production/box-labels/page').default;
        return renderToStaticMarkup(createElement(Page));
    } finally {
        useState.mockRestore();
        useEffect.mockRestore();
    }
}

const printDom = (html: string) => html.slice(html.indexOf('<div class="hidden print:block">'));
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/** Each printed sticker's visible text, in print order. */
const stickerTexts = (html: string): string[] => printDom(html)
    .split('<div class="label-slot"').slice(1)
    .map((chunk) => decode(chunk.replace(/^[^>]*>/, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
/** Each printed sticker's position on its sheet, in inches. */
const stickerOrigins = (html: string): Array<[number, number]> =>
    Array.from(printDom(html).matchAll(/class="label-slot" style="left:([\d.]+)in;top:([\d.]+)in"/g)).map((m) => [Number(m[1]), Number(m[2])]);
const sheetCount = (html: string) => (printDom(html).match(/class="label-sheet"/g) || []).length;
/** Origins equal to the inch figures, to float precision (0.18 + 4.14 prints as 4.319999999999999). */
const expectOrigins = (actual: Array<[number, number]>, expected: number[][]) => {
    expect(actual).toHaveLength(expected.length);
    actual.forEach(([l, t], i) => {
        expect(l).toBeCloseTo(expected[i][0], 9);
        expect(t).toBeCloseTo(expected[i][1], 9);
    });
};
const cssRule = (html: string, selector: string) => {
    const at = printDom(html).indexOf(selector);
    return printDom(html).slice(at, printDom(html).indexOf('}', at));
};
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `L${i + 1}` }));

// ═════════════════════════════════════════════════════════════════════════════
// 1-2. THE DEFAULT IS THE STOCK PRINTED BEFORE THIS PHASE.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-2. current preset is the default and is unchanged', () => {
    it('1. OnlineLabels OL600WX is the default, first in the selector, and the page starts on it', () => {
        expect(DEFAULT_LABEL_PRESET_ID).toBe('onlinelabels-ol600wx');
        expect(DEFAULT_LABEL_PRESET.id).toBe(DEFAULT_LABEL_PRESET_ID);
        expect(LABEL_PRESETS[0]).toBe(DEFAULT_LABEL_PRESET);
        expect(DEFAULT_LABEL_PRESET.displayName).toBe('OnlineLabels OL600WX — Current');
        const page = strip(read(PAGE));
        expect(page).toMatch(/useState<LabelPreset>\(DEFAULT_LABEL_PRESET\)/);
        expect(page).toMatch(/value=\{preset\.id\}/);
        // Not remembered anywhere: no storage, no cookie, no request carries it.
        const presetLines = page.split('\n').filter((l) => /preset/i.test(l));
        expect(presetLines.join('\n')).not.toMatch(/localStorage|sessionStorage|document\.cookie|fetch\(|JSON\.stringify/);
    });

    it('2. the default preset is the OL600 sheet and the 4" x 2.5" face, figure for figure', () => {
        expect(DEFAULT_LABEL_PRESET.geometry).toBe(OL600_SHEET);
        expect({ ...OL600_SHEET }).toEqual({
            sheetWidthIn: 8.5, sheetHeightIn: 11, labelWidthIn: 4, labelHeightIn: 2.5,
            columns: 2, rows: 4, labelsPerSheet: 8,
            marginTopIn: 0.5, marginBottomIn: 0.5, marginLeftIn: 0.18, marginRightIn: 0.18,
            horizontalGapIn: 0.14, verticalGapIn: 0, horizontalPitchIn: 4.14, verticalPitchIn: 2.5,
            cornerRadiusIn: 0.125, orientation: 'portrait',
        });
        const face = DEFAULT_LABEL_PRESET.face;
        expect(face).toBe(STICKER_FACES['4x2.5']);
        expect(face).toBe(DEFAULT_STICKER_FACE);
        expect(face.tiers).toBe(STICKER_TYPOGRAPHY_TIERS);
        // The pre-phase sizes, unchanged.
        expect(face.tiers.comfortable).toMatchObject({ nameSizePt: 24, contentSizePt: 12 });
        expect(face.tiers.standard).toMatchObject({ nameSizePt: 22, contentSizePt: 11 });
        expect(face.tiers.compact).toMatchObject({ nameSizePt: 18, contentSizePt: 10 });
        expect(face.orgNameSizesPt).toEqual({ short: 10, medium: 9, long: 8 });
        expect(face.logoMaxHeight).toBe('0.55in');
        expect(face.logoMaxWidth).toBe('1.70in');
    });

    it('2b. the default render prints the OL600 sticker exactly as before', () => {
        const html = renderPage(DEFAULT_LABEL_PRESET, fixtureBoxes());
        expect(printDom(html)).toMatch(/@page \{\s*size: 8\.5in 11in;\s*margin: 0;/);
        expect(cssRule(html, '.label-slot {')).toMatch(/width: 4in;\s*height: 2\.5in;/);
        expect(cssRule(html, '.label-slot {')).toMatch(/padding: 0\.12in/);
        expect(cssRule(html, '.align-slot {')).toMatch(/border-radius: 0\.125in/);
        expectOrigins(stickerOrigins(html).slice(0, 8), [
            [0.18, 0.5], [4.32, 0.5], [0.18, 3], [4.32, 3], [0.18, 5.5], [4.32, 5.5], [0.18, 8], [4.32, 8],
        ]);
        expect(printDom(html)).toMatch(/max-height:0\.55in;max-width:1\.70in|min-height:0\.55in/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3-4. RESOLUTION AND REFUSAL.
// ═════════════════════════════════════════════════════════════════════════════
describe('3-4. registry resolution', () => {
    it('3. avery-15513 resolves to the Avery 15513 preset with the agreed metadata', () => {
        expect(LABEL_PRESET_IDS).toEqual(['onlinelabels-ol600wx', 'avery-15513']);
        expect(AVERY).not.toBeNull();
        expect(AVERY).toMatchObject({
            id: 'avery-15513',
            displayName: 'Waterproof Film — Avery 15513',
            manufacturer: 'Avery',
            model: '15513',
            materialLabel: 'Waterproof matte-white film',
            printerType: 'laser',
            shape: 'rectangle',
            stockName: 'Avery 15513',
        });
        expect(AVERY.templateFamily).toMatch(/Avery 5163/);
        expect(AVERY.helperText).toBe('Laser printer • Waterproof film • 2" × 4" • 10 per sheet');
        expect(AVERY.geometry).toBe(AVERY_5163_SHEET);
        expect(AVERY.face).toBe(STICKER_FACES['4x2']);
        // The current stock's material and printer were never recorded, so none is claimed.
        expect(DEFAULT_LABEL_PRESET.materialLabel).toBeNull();
        expect(DEFAULT_LABEL_PRESET.printerType).toBeNull();
    });

    it('4. anything that is not a registered id is refused — never guessed, never built', () => {
        for (const bad of ['', ' avery-15513', 'avery-15513 ', 'AVERY-15513', 'avery-5163', 'avery_15513', '15513',
            'current', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '{"labelWidthIn":4}', 'javascript:alert(1)',
            null, undefined, 0, 15513, true, {}, [], ['avery-15513'], { id: 'avery-15513' }]) {
            expect(resolveLabelPreset(bad as any)).toBeNull();
        }
        // Registered ids resolve to the registry's OWN frozen entry.
        for (const p of LABEL_PRESETS) {
            expect(resolveLabelPreset(p.id)).toBe(p);
            expect(Object.isFrozen(p)).toBe(true);
            expect(Object.isFrozen(p.geometry)).toBe(true);
            expect(Object.isFrozen(p.face)).toBe(true);
        }
        expect(Object.isFrozen(LABEL_PRESETS)).toBe(true);
        // The page acts only on a resolved registry entry; a refusal changes nothing.
        const page = strip(read(PAGE));
        const handler = page.slice(page.indexOf('const choosePreset'), page.indexOf('};', page.indexOf('const choosePreset')));
        expect(handler).toMatch(/const next = resolveLabelPreset\(id\);\s*if \(!next\) return;\s*setPreset\(next\);/);
        // No caller-supplied dimension, CSS or URL can become a preset.
        expect(strip(read(PRESETS))).not.toMatch(/JSON\.parse|eval\(|new Function|fetch\(|https?:\/\//);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5-8. AVERY 15513 = THE AVERY 5163 TEMPLATE.
// ═════════════════════════════════════════════════════════════════════════════
describe('5-8. Avery 15513 geometry', () => {
    const g = AVERY.geometry;

    it('5. each label is 4" wide x 2" high', () => {
        expect(g.labelWidthIn).toBe(4);
        expect(g.labelHeightIn).toBe(2);
    });

    it('6. ten labels per sheet: 2 columns x 5 rows', () => {
        expect(g.columns).toBe(2);
        expect(g.rows).toBe(5);
        expect(g.labelsPerSheet).toBe(10);
        expect(lastSlot(g)).toBe(10);
    });

    it('7. every preset is portrait US Letter 8.5" x 11"', () => {
        for (const p of LABEL_PRESETS) {
            expect(p.geometry.sheetWidthIn).toBe(8.5);
            expect(p.geometry.sheetHeightIn).toBe(11);
            expect(p.geometry.orientation).toBe('portrait');
            expect(describePaper(p.geometry)).toBe('US Letter 8.5 × 11');
        }
    });

    it('8. margins and pitches are the Avery 5163 figures, and the sheet closes exactly', () => {
        expect(g.marginTopIn).toBe(0.5);
        expect(g.marginBottomIn).toBe(0.5);
        expect(g.marginLeftIn).toBe(0.15625);
        expect(g.marginRightIn).toBe(0.15625);
        expect(g.horizontalGapIn).toBe(0.1875);
        expect(g.verticalGapIn).toBe(0);
        expect(g.horizontalPitchIn).toBe(4.1875);
        expect(g.verticalPitchIn).toBe(2);
        expect(g.cornerRadiusIn).toBeNull(); // not published by Avery, so not invented
        expect(g.marginLeftIn + 2 * g.labelWidthIn + g.horizontalGapIn + g.marginRightIn).toBe(8.5);
        expect(g.marginTopIn + 5 * g.labelHeightIn + g.marginBottomIn).toBe(11);
        // Every slot origin, in reading order.
        const expected = [
            [0.15625, 0.5], [4.34375, 0.5], [0.15625, 2.5], [4.34375, 2.5], [0.15625, 4.5],
            [4.34375, 4.5], [0.15625, 6.5], [4.34375, 6.5], [0.15625, 8.5], [4.34375, 8.5],
        ];
        for (let p = 1; p <= 10; p++) expect([slotOrigin(p, g).leftIn, slotOrigin(p, g).topIn]).toEqual(expected[p - 1]);
        // ...and the page really prints there, at that size.
        const html = renderPage(AVERY, fixtureBoxes());
        expectOrigins(stickerOrigins(html).slice(0, 10), expected);
        expect(cssRule(html, '.label-slot {')).toMatch(/width: 4in;\s*height: 2in;/);
        expect(cssRule(html, '.align-slot {')).toMatch(/width: 4in;\s*height: 2in;/);
        expect(cssRule(html, '.align-slot {')).toMatch(/border-radius: 0in/);
        expect(printDom(html)).toMatch(/@page \{\s*size: 8\.5in 11in;\s*margin: 0;/);
    });

    it('8b. every registered sheet passes the geometry check a future template must pass', () => {
        for (const p of LABEL_PRESETS) expect(sheetGeometryProblems(p.geometry)).toEqual([]);
        const broken: LabelSheetGeometry = { ...AVERY_5163_SHEET, marginLeftIn: 0.25 };
        expect(sheetGeometryProblems(broken).join(' ')).toMatch(/sheet width/);
        expect(sheetGeometryProblems({ ...AVERY_5163_SHEET, labelsPerSheet: 8 }).join(' ')).toMatch(/columns x rows/);
        expect(sheetGeometryProblems({ ...AVERY_5163_SHEET, verticalPitchIn: 2.1 }).join(' ')).toMatch(/vertical pitch/);
    });

    it('8c. no scaling: the print is never fit-to-page or transformed', () => {
        const raw = read(PAGE);
        expect(raw).not.toMatch(/transform:\s*scale|zoom:/);
        const html = renderPage(AVERY, fixtureBoxes());
        expect(printDom(html)).not.toMatch(/scale\(|zoom/);
        // The operator is still told to print at actual size, whichever stock.
        expect(strip(raw)).toMatch(/100% \/ Actual Size/);
        expect(strip(raw)).toMatch(/not<\/strong> select Fit to Page or Shrink to Fit/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9-10. SAME BOXES, SAME CONTENT, SAME COUNT — ON EVERY STOCK.
// ═════════════════════════════════════════════════════════════════════════════
describe('9-10. content and count are independent of the stock', () => {
    it('9. the same boxes print the same business content, in the same order, on both stocks', () => {
        const boxes = fixtureBoxes();
        expect(boxes.length).toBeGreaterThanOrEqual(20);
        const current = stickerTexts(renderPage(DEFAULT_LABEL_PRESET, boxes));
        const avery = stickerTexts(renderPage(AVERY, boxes));
        expect(avery).toEqual(current);
        // ...and that content is exactly each box's own facts.
        boxes.forEach((box, i) => {
            for (const fact of [
                box.supporterName,
                `Box ${box.boxNumber} of ${box.boxTotal}`,
                `${box.boxType} box`,
                ...boxContentLines(box).map(formatBoxContentLine),
                ...(box.organizationName ? [box.organizationName] : []),
            ]) {
                expect(avery[i]).toContain(fact);
            }
        });
        // The pagination authority hands both stocks the very same box objects.
        expect(placedLabels(paginateLabelSheets(boxes, 1, AVERY.geometry)))
            .toEqual(placedLabels(paginateLabelSheets(boxes, 1, DEFAULT_LABEL_PRESET.geometry)));
    });

    it('10. changing stock never changes how many labels (physical boxes) are printed', () => {
        const boxes = fixtureBoxes();
        for (const preset of LABEL_PRESETS) {
            expect(stickerTexts(renderPage(preset, boxes))).toHaveLength(boxes.length);
            for (const start of [1, 4, 7]) {
                expect(stickerTexts(renderPage(preset, boxes, normalizeStartPosition(start, preset.geometry)))).toHaveLength(boxes.length);
            }
        }
        for (let n = 0; n <= 45; n++) {
            for (const preset of LABEL_PRESETS) {
                for (let start = 1; start <= lastSlot(preset.geometry); start++) {
                    const placed = placedLabels(paginateLabelSheets(ids(n), start, preset.geometry)).map((x) => x.id);
                    expect(placed).toEqual(ids(n).map((x) => x.id));
                }
            }
        }
        // The page's own count line comes from the server manifest, never from the stock.
        const page = strip(read(PAGE));
        expect(page).toMatch(/\{counts\.physical\} physical box/);
        expect(page).not.toMatch(/counts\.[a-z]+\s*[*/]\s*geometry|labelsPerSheet\s*\*\s*sheets/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11-14. 10-UP PAGINATION.
// ═════════════════════════════════════════════════════════════════════════════
describe('11-14. Avery pagination', () => {
    const g = AVERY_5163_SHEET;
    const cases: Array<[number, number[]]> = [[1, [1]], [10, [10]], [11, [10, 1]], [20, [10, 10]], [21, [10, 10, 1]]];
    for (const [n, perSheet] of cases) {
        it(`${n} label${n === 1 ? '' : 's'} -> ${perSheet.length} sheet${perSheet.length === 1 ? '' : 's'}`, () => {
            const sheets = paginateLabelSheets(ids(n), 1, g);
            expect(sheets).toHaveLength(perSheet.length);
            expect(sheets.map(occupiedSlotCount)).toEqual(perSheet);
            for (const sheet of sheets) expect(sheet.slots).toHaveLength(10);
            expect(sheets.map((s) => s.sheetNumber)).toEqual(perSheet.map((_, i) => i + 1));
            // Nothing dropped or repeated across a page boundary.
            const placed = placedLabels(sheets).map((x) => x.id);
            expect(placed).toEqual(ids(n).map((x) => x.id));
            expect(new Set(placed).size).toBe(n);
        });
    }

    it('the 10th and 11th labels sit on either side of the page break, once each', () => {
        const sheets = paginateLabelSheets(ids(11), 1, g);
        expect(sheets[0].slots[9].label).toEqual({ id: 'L10' });
        expect(sheets[1].slots[0].label).toEqual({ id: 'L11' });
        expect(sheets[1].slots.slice(1).every((s) => s.label === null)).toBe(true);
    });

    it('the rendered page prints one Letter sheet per 10 labels', () => {
        const boxes = fixtureBoxes(); // 21 boxes
        expect(boxes).toHaveLength(21);
        expect(sheetCount(renderPage(AVERY, boxes))).toBe(3);
        expect(sheetCount(renderPage(DEFAULT_LABEL_PRESET, boxes))).toBe(3); // 8 + 8 + 5
        expect(sheetCount(renderPage(AVERY, boxes.slice(0, 10)))).toBe(1);
        expect(sheetCount(renderPage(AVERY, boxes.slice(0, 11)))).toBe(2);
        expect(sheetCount(renderPage(AVERY, boxes.slice(0, 20)))).toBe(2);
        expect(sheetCount(renderPage(DEFAULT_LABEL_PRESET, boxes.slice(0, 10)))).toBe(2);
    });

    it('start position follows the selected sheet: 1-10 on Avery, 1-8 on OL600, re-clamped on switch', () => {
        expect(normalizeStartPosition(10, g)).toBe(10);
        expect(normalizeStartPosition(11, g)).toBe(10);
        expect(normalizeStartPosition(10)).toBe(8);
        expect(normalizeStartPosition(10, OL600_SHEET)).toBe(8);
        const sheets = paginateLabelSheets(ids(5), 7, g);
        expect(sheets.map(occupiedSlotCount)).toEqual([4, 1]);
        const page = strip(read(PAGE));
        expect(page).toMatch(/Array\.from\(\{ length: lastSlot\(geometry\) \}/);
        expect(page).toMatch(/setStartPosition\(\(current\) => normalizeStartPosition\(current, next\.geometry\)\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15-17. LONG NAMES AND THE ORGANIZATION LINE.
// ═════════════════════════════════════════════════════════════════════════════
describe('15-17. long names and the organization line on the 2" label', () => {
    const face = STICKER_FACES['4x2'];
    const USABLE_H_IN = AVERY_5163_SHEET.labelHeightIn - 0.12 * 2; // 1.76
    // The 4x2.5 suite's own methodology, plus the organization line at its line height.
    const worst = (f: StickerFace, tier: { nameSizePt: number; contentSizePt: number }, nameLines: number, entries: number, orgPt: number, orgLines: number) => {
        const header = parseFloat(f.logoMaxHeight) + 0.04;
        const org = orgLines * (orgPt * 1.1 * PT) + 0.02;
        const name = nameLines * (tier.nameSizePt * 1.05 * PT) + 0.06;
        const contents = entries * 2 * (tier.contentSizePt * 1.25 * PT) + (entries - 1) * 0.02;
        const boxType = 8 * 1.2 * PT;
        return header + org + name + contents + boxType;
    };

    it('15. a long fundraiser name stays on the label, whole, wrapping instead of truncating', () => {
        expect(LONG_ORG.length).toBeGreaterThan(ORG_NAME_LONG_THRESHOLD);
        expect(chooseOrgNameTypography(LONG_ORG, face).sizePt).toBe(8);
        const html = renderPage(AVERY, fixtureBoxes());
        const longOrgStickers = stickerTexts(html).filter((t) => t.includes(LONG_ORG));
        expect(longOrgStickers.length).toBe(6); // ord-05 (1) + ord-06 (3) + ord-11 (2)
        const sticker = strip(read(PAGE)).slice(strip(read(PAGE)).indexOf('className="label-slot"'));
        const orgBlock = sticker.slice(sticker.indexOf('box.organizationName &&'), sticker.indexOf('box.supporterName'));
        expect(orgBlock).toMatch(/wordBreak: 'break-word'/);
        expect(orgBlock).not.toMatch(/whiteSpace: 'nowrap'|textOverflow|\.slice\(|substring/);
        // Even a two-line organization name fits beside a long two-line customer name with one entry.
        expect(worst(face, face.tiers.standard, 2, 1, 8, 2)).toBeLessThan(USABLE_H_IN);
    });

    it('16. a long customer name is sized down a tier and still fits — every reachable shape, worst case', () => {
        expect(`${LONG_NAME_FIRST} ${LONG_NAME_LAST}`.length).toBeGreaterThan(NAME_LONG_THRESHOLD);
        expect(chooseStickerTypography(`${LONG_NAME_FIRST} ${LONG_NAME_LAST}`, 2, face).tier).toBe('compact');
        const reachable: Array<['comfortable' | 'standard' | 'compact', number, number]> = [
            ['comfortable', 1, 1], ['standard', 1, 2], ['standard', 2, 1], ['compact', 2, 2],
        ];
        for (const [tier, nameLines, entries] of reachable) {
            // With the organization line at its LARGEST size (a short organization name).
            const h = worst(face, face.tiers[tier], nameLines, entries, face.orgNameSizesPt.short, 1);
            expect(h).toBeLessThan(USABLE_H_IN);
            expect(USABLE_H_IN - h).toBeGreaterThan(0.05);
        }
        // The full name is printed — nothing is cut to make it fit.
        const html = renderPage(AVERY, fixtureBoxes());
        expect(stickerTexts(html).some((t) => t.includes(`${LONG_NAME_FIRST} ${LONG_NAME_LAST}`))).toBe(true);
        expect(printDom(html)).toMatch(/\.label-slot \{[\s\S]*?overflow: hidden/);
    });

    it('16b. on the 2" face the customer name is still the largest text, and the hierarchy holds', () => {
        const smallestName = Math.min(...Object.values(face.tiers).map((t) => t.nameSizePt));
        for (const t of Object.values(face.tiers)) {
            expect(t.nameSizePt).toBeGreaterThan(t.contentSizePt);
            expect(t.contentSizePt).toBeGreaterThan(8);          // LARGE/SMALL BOX stays the smallest text
            expect(t.nameSizePt).toBeGreaterThan(10);            // ...and Box N of M stays below the name
        }
        for (const org of ['Edgar County Farm Bureau', 'Shelby County Farm Bureau Foundation', LONG_ORG, 'x'.repeat(200)]) {
            expect(chooseOrgNameTypography(org, face).sizePt).toBeLessThan(smallestName);
        }
        expect(parseFloat(face.logoMaxHeight)).toBeLessThan(smallestName * 1.05 * PT * 3);
        expect(parseFloat(face.logoMaxHeight)).toBeLessThan(USABLE_H_IN / 3);
    });

    it('16c. the page sizes every sticker from the SELECTED stock\'s face — name, content, organization and logo row', () => {
        const boxes = fixtureBoxes();
        for (const preset of LABEL_PRESETS) {
            const chunks = printDom(renderPage(preset, boxes)).split('<div class="label-slot"').slice(1);
            expect(chunks).toHaveLength(boxes.length);
            chunks.forEach((chunk, i) => {
                const box = boxes[i];
                const lines = boxContentLines(box);
                const type = chooseStickerTypography(box.supporterName, lines.length, preset.face);
                expect(chunk).toContain(`min-height:${preset.face.logoMaxHeight}`);
                expect(chunk).toContain(`font-size:${type.nameSizePt}pt;font-weight:900;line-height:1.05`);
                const contentSizes = Array.from(chunk.matchAll(/font-size:([\d.]+)pt;font-weight:700;line-height:1\.25/g)).map((m) => Number(m[1]));
                expect(contentSizes).toEqual(lines.map(() => type.contentSizePt));
                const orgSizes = Array.from(chunk.matchAll(/font-size:([\d.]+)pt;font-weight:800;line-height:1\.1/g)).map((m) => Number(m[1]));
                expect(orgSizes).toEqual(box.organizationName ? [chooseOrgNameTypography(box.organizationName, preset.face).sizePt] : []);
            });
        }
    });

    it('17. the organization line behaves exactly as before on the current stock, and identically on Avery', () => {
        // Current stock: the BOX-LABEL-ORG-1 sizes, from length alone.
        expect(chooseOrgNameTypography('Edgar County Farm Bureau').sizePt).toBe(10);
        expect(chooseOrgNameTypography('Cumberland County Farm Bureau').sizePt).toBe(9);
        expect(chooseOrgNameTypography(LONG_ORG).sizePt).toBe(8);
        expect(chooseOrgNameTypography(null).sizePt).toBe(10);
        // Avery: same buckets, same thresholds, its own sizes.
        expect(ORG_NAME_MEDIUM_THRESHOLD).toBe(26);
        expect(ORG_NAME_LONG_THRESHOLD).toBe(40);
        expect(chooseOrgNameTypography('Edgar County Farm Bureau', face).sizePt).toBe(9);
        expect(chooseOrgNameTypography('Cumberland County Farm Bureau', face).sizePt).toBe(8.5);
        // The tier RULE is the same on both faces.
        for (const name of ['Sue Fulton', 'Wyatt Williamson', 'Christopher Vanderbilt-Harrington', '', null]) {
            for (const count of [1, 2, 0, 99, NaN]) {
                expect(chooseStickerTypography(name as any, count, face).tier).toBe(chooseStickerTypography(name as any, count).tier);
            }
        }
        // A storefront box has no organization line on either stock — never "null".
        const boxes = fixtureBoxes();
        const storefront = boxes.findIndex((b) => b.organizationName === null);
        for (const preset of LABEL_PRESETS) {
            const t = stickerTexts(renderPage(preset, boxes))[storefront];
            expect(t).not.toMatch(/null|undefined|Farm Bureau/);
            expect(t).toContain(boxes[storefront].supporterName);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18-20. PRINT ACTION, DELIVERY REPRINT, AUTH AND TENANCY.
// ═════════════════════════════════════════════════════════════════════════════
describe('18-20. unchanged paths', () => {
    it('18. the Production print action is unchanged: queue -> this page -> Print All', () => {
        const q = strip(read(QUEUE_UI));
        expect(q).toMatch(/writeBoxLabelBatch\(\{ orderIds, businessId: ownerBusinessId, name \}\)/);
        expect(q).toMatch(/router\.push\('\/production\/box-labels'\)/);
        expect(q).toMatch(/Box Labels — All Orders/);
        const page = strip(read(PAGE));
        expect(page).toMatch(/const handlePrintAll = async \(\) =>/);
        expect(page).toMatch(/window\.print\(\);/);
        expect(page).toMatch(/disabled=\{counts\.physical === 0 \|\| isPrinting \|\| blocked\.length > 0\}/);
        // The selector sits with the other operator controls, never on a sticker.
        const printBlock = page.slice(page.indexOf('hidden print:block'));
        expect(printBlock).not.toMatch(/Label Type|<select|choosePreset|helperText|displayName/);
        expect(page.slice(0, page.indexOf('hidden print:block'))).toMatch(/htmlFor="labelPreset"[\s\S]*Label Type/);
    });

    it('19. Delivery\'s Reprint Box Labels lands on this same page, so it gets the same stocks', () => {
        const d = strip(read(DELIVERY));
        expect(d).toMatch(/writeBoxLabelBatch\(/);
        expect(d).toMatch(/router\.push\('\/production\/box-labels'\)/);
        // Delivery still imports no label geometry, typography or presets of its own.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (/\.(ts|tsx)$/.test(e.name) && /labelSheetLayout|labelTypography|labelPresets/.test(readFileSync(full, 'utf8'))) offenders.push(full);
            }
        };
        walk(join(ROOT, 'app/delivery'));
        walk(join(ROOT, 'app/api/delivery'));
        expect(offenders).toEqual([]);
        // The preset modules are imported by exactly this page.
        const importers: string[] = [];
        const scan = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, e.name);
                if (e.isDirectory()) { if (!['node_modules', '.next', '.git', 'tests'].includes(e.name)) scan(full); }
                else if (/\.(ts|tsx)$/.test(e.name) && /from\s*['"][^'"]*\blabelPresets['"]/.test(readFileSync(full, 'utf8'))) importers.push(full.slice(ROOT.length + 1).replace(/\\/g, '/'));
            }
        };
        scan(ROOT);
        expect(importers).toEqual([PAGE]);
    });

    it('20. auth and tenant scoping are unchanged — the stock never reaches the server', () => {
        const route = strip(read(ROUTE));
        expect(route).toMatch(/const session = await auth\(\);/);
        expect(route).toMatch(/business_id: businessId/);
        expect(route).not.toMatch(/preset|labelWidth|geometry|labelsPerSheet/i);
        const page = strip(read(PAGE));
        expect(page).toMatch(/fetchAuthenticatedBusinessId\(\)/);
        expect(page).toMatch(/body: JSON\.stringify\(\{ orderIds: queued\.batch\.orderIds \}\)/);
        expect(page).not.toMatch(/useSearchParams|URLSearchParams|window\.location\.search/);
        // Code-level registry: no database, no network, no schema.
        for (const f of [PRESETS, LAYOUT, TYPO]) {
            expect(strip(read(f))).not.toMatch(/prisma|fetch\(|XMLHttpRequest|from ['"]react['"]/);
        }
        // (schema.prisma's existing `label_templates` is the MEAL-label editor's table,
        // untouched; that the schema is not in this phase's diff at all is proven at
        // the repo level — `git diff --name-only` against Production — in the report.)
        expect(read('prisma/schema.prisma')).not.toMatch(/label_preset|labelPreset|avery|ol600|15513|5163/i);
    });

    it('the printing instructions follow the stock — Avery says laser; the current stock says what it always said', () => {
        const page = strip(read(PAGE));
        expect(page).toMatch(/Load <strong>\{preset\.stockName\}<\/strong> sheets\./);
        expect(page).toMatch(/\{preset\.printerType === 'laser' && \(/);
        expect(DEFAULT_LABEL_PRESET.stockName).toBe('OnlineLabels OL600 / OL600WX');
        expect(formatInches(DEFAULT_LABEL_PRESET.geometry.marginLeftIn)).toBe('0.18');
        expect(formatInches(AVERY.geometry.marginLeftIn)).toBe('0.16');
        const avery = renderPage(AVERY, fixtureBoxes());
        expect(avery).toContain('Laser printer • Waterproof film • 2&quot; × 4&quot; • 10 per sheet');
        expect(avery).toMatch(/Printer: <strong>Laser<\/strong>/);
        const current = renderPage(DEFAULT_LABEL_PRESET, fixtureBoxes());
        expect(current).not.toMatch(/Printer: <strong>Laser/);
        expect(current).toContain('Load <strong>OnlineLabels OL600 / OL600WX</strong> sheets.');
        expect(current).toContain('This stock has 0.18&quot; side margins');
    });
});
