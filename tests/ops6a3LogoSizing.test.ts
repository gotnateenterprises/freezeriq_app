/**
 * OPS-6A.3 — printed tenant-logo sizing on the 4x6 outer-box label.
 *
 * The owner accepted the OPS-6A.2 label in full except that the logo read as
 * a tiny icon rather than a branded header. The tenant's logo is SQUARE
 * (500x500), so `object-fit: contain` scaling was bound entirely by the
 * height ceiling — the old 2.6in width ceiling was never reached, and raising
 * it alone would have changed nothing visible.
 *
 * These assertions deliberately check the GEOMETRY against the real page
 * budget rather than pinning magic numbers, so a future adjustment is free to
 * move the values as long as the logo still fits, stays proportional, and
 * stays subordinate to the supporter name.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PAGE = 'app/production/box-labels/page.tsx';

/** Inches, from the page's own constants. */
const readInches = (src: string, name: string): number => {
    const m = src.match(new RegExp(`const ${name} = '([\\d.]+)in';`));
    if (!m) throw new Error(`${name} not found as an inch constant`);
    return Number(m[1]);
};

// REVISED BY BOX-LABEL-SHEET-1: the medium changed from a 4x6 page-per-box
// to a 4 x 2.5 sticker, eight to a US Letter OL600WX sheet. The logo was
// re-sized for that sticker, so this file's geometry now describes the
// STICKER. The guarantees it protects are unchanged: proportional, bounded,
// non-clipping, and subordinate to the supporter name.
const LABEL_W_IN = 4;
const LABEL_H_IN = 2.5;
const PAD_IN = 0.12;
const USABLE_W_IN = LABEL_W_IN - PAD_IN * 2; // 3.76
const USABLE_H_IN = LABEL_H_IN - PAD_IN * 2; // 2.26

/** The size this SQUARE logo actually renders at under `contain`. */
const squareRendered = (maxH: number, maxW: number) => Math.min(maxH, maxW);

describe('OPS-6A.3 logo sizing', () => {
    const src = strip(read(PAGE));
    const maxH = readInches(src, 'LOGO_MAX_HEIGHT_IN');
    const maxW = readInches(src, 'LOGO_MAX_WIDTH_IN');

    it('1. the logo is substantial on the sticker without dominating it', () => {
        // SUPERSEDED BY BOX-LABEL-SHEET-1. The old "1.5-1.8x the 0.62in 4x6
        // ceiling" band described a page with 5.5in of usable height; the
        // sticker has 2.26in, so carrying 1.05in across would have swallowed
        // the supporter name. The guarantee is restated for the new medium:
        // big enough to read as branding, small enough to stay secondary.
        const rendered = squareRendered(maxH, maxW);
        // Occupies a meaningful share of the sticker's height...
        expect(rendered / USABLE_H_IN).toBeGreaterThan(0.12);
        // ...but never more than a third of it.
        expect(rendered / USABLE_H_IN).toBeLessThan(0.34);
    });

    it('2. aspect ratio is preserved — bounded by max-* with contain, never fixed w+h', () => {
        const imgTag = src.slice(src.indexOf('<img'), src.indexOf('/>', src.indexOf('<img')));
        expect(imgTag).toMatch(/objectFit:\s*'contain'/);
        expect(imgTag).toMatch(/maxHeight: LOGO_MAX_HEIGHT_IN/);
        expect(imgTag).toMatch(/maxWidth: LOGO_MAX_WIDTH_IN/);
        // A fixed width AND height together would stretch a non-square logo.
        expect(imgTag).not.toMatch(/\bheight:\s*'[\d.]+in'/);
        expect(imgTag).not.toMatch(/\bwidth:\s*'[\d.]+in'/);
    });

    it('3. the logo can never overflow or clip the printable area', () => {
        expect(maxW).toBeLessThanOrEqual(USABLE_W_IN);
        expect(maxH).toBeLessThan(USABLE_H_IN);
        // REVISED BY BOX-LABEL-SHEET-1: the old floor (maxW > 2.6in) belonged
        // to the 4x6 page. On a 4in sticker the width ceiling must instead
        // leave room for the Box N of M that now shares the header row.
        expect(maxW).toBeLessThan(USABLE_W_IN * 0.5);
    });

    it('4. the whole sticker still fits in its 4 x 2.5 slot in the worst case', () => {
        // REVISED BY BOX-LABEL-SHEET-1 for the sticker's own typography.
        // Worst case: two-line supporter name, and content lines wrapped to
        // four rendered rows (the packing rules bound a box to at most TWO
        // content lines, so four rendered rows already assumes both wrap).
        // Box N of M now shares the header row, so it costs no extra height.
        const PT = 1 / 72;
        const header = maxH + 0.04;
        const name = 17 * 1.05 * 2 * PT + 0.06;
        const contents = 9 * 1.22 * 4 * PT + 0.02 * 3;
        const boxType = 6.5 * 1.2 * PT;
        const total = header + name + contents + boxType;
        expect(total).toBeLessThan(USABLE_H_IN);
        // Meaningful headroom, not a hairline pass.
        expect(USABLE_H_IN - total).toBeGreaterThan(0.3);
    });

    it('5. the supporter name remains the primary identifier', () => {
        // Scoped to the STICKER, not the whole print block: the fail-closed
        // "DO NOT USE" refusal sheet also carries a 900-weight heading, and
        // matching that instead would be a false pass.
        // REVISED BY BOX-LABEL-SHEET-1A: the name and content sizes are now
        // chosen per sticker by lib/labelTypography.ts, so they are template
        // literals rather than fixed strings. The hierarchy is asserted
        // against the tier values themselves, which is stronger than parsing
        // one hardcoded size out of the source.
        const sticker = src.slice(src.indexOf('className="label-slot"'));
        expect(sticker).toMatch(/fontSize: `\$\{type\.nameSizePt\}pt`, fontWeight: 900, lineHeight: 1\.05/);

        const { STICKER_TYPOGRAPHY_TIERS } = require('@/lib/labelTypography');
        const typeSize = Number((sticker.match(/fontSize: '([\d.]+)pt'[^}]*textTransform: 'uppercase'/) || [])[1]);
        expect(typeSize).toBeGreaterThan(0);

        let smallestName = Infinity;
        for (const tier of Object.values(STICKER_TYPOGRAPHY_TIERS) as any[]) {
            // In EVERY tier the name outranks the content lines and box type.
            expect(tier.nameSizePt).toBeGreaterThan(tier.contentSizePt);
            expect(tier.nameSizePt).toBeGreaterThan(typeSize);
            smallestName = Math.min(smallestName, tier.nameSizePt);
        }

        // ...and the logo cannot dominate the name, even in the tier where
        // the name is smallest.
        const nameBlockIn = smallestName * 1.05 * (1 / 72);
        expect(maxH).toBeLessThan(nameBlockIn * 3);
    });

    it('6. the reserved header block and the image ceiling stay in lockstep', () => {
        // One constant drives both, so the container can never reserve less
        // space than the image it holds.
        const printBlock = src.slice(src.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/minHeight: LOGO_MAX_HEIGHT_IN/);
    });

    it('7. the print contract and page-break protection are intact', () => {
        // REVISED BY BOX-LABEL-SHEET-1: the printed PAGE is now the US Letter
        // stock sheet and the sticker is 4 x 2.5 within it. Same guarantees,
        // new medium.
        const raw = read(PAGE);
        expect(raw).toMatch(/size:\s*8\.5in 11in/);
        expect(raw).toMatch(/width:\s*\$\{OL600_SHEET\.labelWidthIn\}in/);
        expect(raw).toMatch(/height:\s*\$\{OL600_SHEET\.labelHeightIn\}in/);
        expect(raw).toMatch(/overflow:\s*hidden/);
        expect(raw).toMatch(/\.label-sheet:last-child\s*\{[\s\S]*?break-after:\s*auto/);
    });

    it('8. logo authority, readiness and fallback logic are untouched', () => {
        expect(src).toMatch(/chooseBrandHeader\(branding\.logoUrl, branding\.businessName, logoStatus\)/);
        expect(src).toMatch(/new window\.Image\(\)/);
        expect(src).toMatch(/isLogoSettling\(branding\.logoUrl, logoStatus\)/);
        expect(src).toMatch(/onError=\{\(\) => setLogoStatus\('failed'\)\}/);
    });
});
