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

// The 4x6 label geometry, read from the page's own print CSS.
const PAGE_W_IN = 4;
const PAGE_H_IN = 6;
const PAD_IN = 0.25;
const USABLE_W_IN = PAGE_W_IN - PAD_IN * 2; // 3.5
const USABLE_H_IN = PAGE_H_IN - PAD_IN * 2; // 5.5

/** The size this SQUARE logo actually renders at under `contain`. */
const squareRendered = (maxH: number, maxW: number) => Math.min(maxH, maxW);

describe('OPS-6A.3 logo sizing', () => {
    const src = strip(read(PAGE));
    const maxH = readInches(src, 'LOGO_MAX_HEIGHT_IN');
    const maxW = readInches(src, 'LOGO_MAX_WIDTH_IN');

    it('1. the logo is NOTICEABLY larger than the previous 0.62in ceiling', () => {
        const PREVIOUS_IN = 0.62;
        const rendered = squareRendered(maxH, maxW);
        expect(rendered).toBeGreaterThan(PREVIOUS_IN);
        // The owner asked for roughly 50-75% more presence.
        const growth = rendered / PREVIOUS_IN;
        expect(growth).toBeGreaterThanOrEqual(1.5);
        expect(growth).toBeLessThanOrEqual(1.8);
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
        // Width ceiling raised too, so a future WIDE wordmark also benefits
        // without ever exceeding the printable width.
        expect(maxW).toBeGreaterThan(2.6);
    });

    it('4. the whole label still fits on ONE 4x6 sheet in the worst case', () => {
        // Worst case: two-line supporter name and four content lines.
        const PT = 1 / 72;
        const header = maxH + 0.16;
        const name = 28 * 1.05 * 2 * PT + 0.14;
        const boxNofM = 19 * 1.2 * PT + 0.18;
        const contents = 14 * 1.2 * 4 * PT + 0.05 * 3;
        const boxType = 8 * 1.2 * PT + 0.2;
        const total = header + name + boxNofM + contents + boxType;
        expect(total).toBeLessThan(USABLE_H_IN);
        // Meaningful headroom, not a hairline pass.
        expect(USABLE_H_IN - total).toBeGreaterThan(0.75);
    });

    it('5. the supporter name remains the primary identifier', () => {
        // The name block is the largest TEXT and is not shrunk by this phase.
        const printBlock = src.slice(src.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/fontSize: '28pt', fontWeight: 900/);
        // The reserved header block stays smaller than the name's own visual
        // weight allowance, so the logo cannot dominate the carton.
        const nameBlockIn = 28 * 1.05 * (1 / 72);
        expect(maxH).toBeLessThan(nameBlockIn * 3);
    });

    it('6. the reserved header block and the image ceiling stay in lockstep', () => {
        // One constant drives both, so the container can never reserve less
        // space than the image it holds.
        const printBlock = src.slice(src.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/minHeight: LOGO_MAX_HEIGHT_IN/);
    });

    it('7. the 4x6 print contract and page-break protection are untouched', () => {
        const raw = read(PAGE);
        expect(raw).toMatch(/size:\s*4in 6in/);
        expect(raw).toMatch(/width:\s*4in/);
        expect(raw).toMatch(/height:\s*6in/);
        expect(raw).toMatch(/padding:\s*0\.25in/);
        expect(raw).toMatch(/overflow:\s*hidden/);
        expect(raw).toMatch(/\.print-page:last-child\s*\{[\s\S]*?break-after:\s*auto/);
    });

    it('8. logo authority, readiness and fallback logic are untouched', () => {
        expect(src).toMatch(/chooseBrandHeader\(branding\.logoUrl, branding\.businessName, logoStatus\)/);
        expect(src).toMatch(/new window\.Image\(\)/);
        expect(src).toMatch(/isLogoSettling\(branding\.logoUrl, logoStatus\)/);
        expect(src).toMatch(/onError=\{\(\) => setLogoStatus\('failed'\)\}/);
    });
});
