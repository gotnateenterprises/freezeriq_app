/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — measure text with the REAL font, so every line on the poster is
 * wrapped by this code (deterministic, testable) rather than left to the renderer.
 *
 * A minimal TrueType reader: unitsPerEm (head), advance widths (hhea + hmtx) and the Unicode BMP
 * character map (cmap format 4). Kerning is ignored; FIT_MARGIN covers it, so a measured line is
 * never narrower than the drawn one.
 */

export interface FontMetrics {
    unitsPerEm: number;
    /** Advance width of one code point, in font units (the .notdef width for unmapped characters). */
    advance(codePoint: number): number;
}

const FIT_MARGIN = 1.04;

export function parseFontMetrics(buf: Buffer): FontMetrics {
    const u16 = (o: number) => buf.readUInt16BE(o);
    const i16 = (o: number) => buf.readInt16BE(o);
    const u32 = (o: number) => buf.readUInt32BE(o);

    const numTables = u16(4);
    const tables: Record<string, number> = {};
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        tables[buf.toString('latin1', rec, rec + 4)] = u32(rec + 8);
    }
    for (const t of ['head', 'hhea', 'hmtx', 'cmap']) {
        if (tables[t] === undefined) throw new Error(`font is missing its ${t} table`);
    }

    const unitsPerEm = u16(tables.head + 18);
    const numberOfHMetrics = u16(tables.hhea + 34);
    const advanceOfGlyph = (g: number) => u16(tables.hmtx + 4 * Math.min(g, numberOfHMetrics - 1));

    // cmap: prefer Windows Unicode BMP (3,1), else Unicode (0,3) / (0,4) — format 4 only.
    const cmap = tables.cmap;
    let sub = -1;
    const n = u16(cmap + 2);
    for (const [pid, eid] of [[3, 1], [0, 3], [0, 4], [0, 0]]) {
        for (let i = 0; i < n && sub < 0; i++) {
            const r = cmap + 4 + i * 8;
            if (u16(r) === pid && u16(r + 2) === eid && u16(cmap + u32(r + 4)) === 4) sub = cmap + u32(r + 4);
        }
        if (sub >= 0) break;
    }
    if (sub < 0) throw new Error('font has no format-4 Unicode cmap');

    const segCount = u16(sub + 6) / 2;
    const endCodes = sub + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;

    const glyphOf = (c: number): number => {
        if (c > 0xffff) return 0;
        for (let s = 0; s < segCount; s++) {
            const end = u16(endCodes + s * 2);
            if (c > end) continue;
            const start = u16(startCodes + s * 2);
            if (c < start) return 0;
            const delta = i16(idDeltas + s * 2);
            const rangeOffsetAt = idRangeOffsets + s * 2;
            const rangeOffset = u16(rangeOffsetAt);
            if (rangeOffset === 0) return (c + delta) & 0xffff;
            const g = u16(rangeOffsetAt + rangeOffset + 2 * (c - start));
            return g === 0 ? 0 : (g + delta) & 0xffff;
        }
        return 0;
    };

    const cache = new Map<number, number>();
    return {
        unitsPerEm,
        advance(cp: number) {
            let w = cache.get(cp);
            if (w === undefined) { w = advanceOfGlyph(glyphOf(cp)); cache.set(cp, w); }
            return w;
        },
    };
}

/** Width in px of `text` at `fontSize`, plus letter spacing after every character, with margin. */
export function measureText(m: FontMetrics, text: string, fontSize: number, letterSpacing = 0): number {
    let units = 0, count = 0;
    for (const ch of text) { units += m.advance(ch.codePointAt(0)!); count++; }
    return (units * fontSize / m.unitsPerEm + letterSpacing * count) * FIT_MARGIN;
}

export interface FitOptions {
    maxWidth: number;
    maxHeight: number;
    maxLines: number;
    /** Candidate sizes, largest first. */
    sizes: readonly number[];
    lineHeight?: number;
    letterSpacing?: number | ((size: number) => number);
}

export interface FittedText {
    fontSize: number;
    lineHeight: number;
    lines: string[];
    /** True when even the smallest size could not hold the whole text and the last line ends in "…". */
    truncated: boolean;
}

const spacingAt = (o: FitOptions, size: number) =>
    typeof o.letterSpacing === 'function' ? o.letterSpacing(size) : (o.letterSpacing ?? 0);

/** Greedy word wrap; a word wider than the line is broken by characters. */
function wrap(m: FontMetrics, words: string[], size: number, o: FitOptions): string[] {
    const ls = spacingAt(o, size);
    const fits = (s: string) => measureText(m, s, size, ls) <= o.maxWidth;
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (fits(candidate)) { line = candidate; continue; }
        if (line) { lines.push(line); line = ''; }
        if (fits(word)) { line = word; continue; }
        let piece = '';
        for (const ch of word) {
            if (fits(piece + ch)) piece += ch;
            else { if (piece) lines.push(piece); piece = ch; }
        }
        line = piece;
    }
    if (line) lines.push(line);
    return lines;
}

/**
 * The largest size at which the whole text fits the box, wrapped on word boundaries. A word that is
 * wider than the box on its own is never accepted at a larger size (it would have to be split); if
 * nothing fits, the smallest size is used and the last allowed line ends in "…".
 */
const SEPARATOR = /^[-–—&+/|·:]+$/;

/**
 * Break units: words, except that a standalone dash / ampersand / slash binds the words on BOTH sides
 * ("SOUP - KETO", "BROCCOLI & RICE"), so no line starts or ends on a separator.
 */
export function breakUnits(text: string): string[] {
    const tokens = text.split(/\s+/).filter(Boolean);
    const units: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!SEPARATOR.test(tok)) { units.push(tok); continue; }
        const next = i + 1 < tokens.length ? tokens[i + 1] : null;
        if (units.length > 0) {
            units[units.length - 1] = next ? `${units[units.length - 1]} ${tok} ${next}` : `${units[units.length - 1]} ${tok}`;
        } else {
            units.push(next ? `${tok} ${next}` : tok);
        }
        if (next) i++;
    }
    return units;
}

export function fitText(m: FontMetrics, text: string, o: FitOptions): FittedText {
    const lineHeight = o.lineHeight ?? 1.05;
    const words = breakUnits(text);
    if (words.length === 0) return { fontSize: o.sizes[o.sizes.length - 1], lineHeight, lines: [], truncated: false };

    for (const size of o.sizes) {
        const ls = spacingAt(o, size);
        const wordsFit = words.every((w) => measureText(m, w, size, ls) <= o.maxWidth);
        if (!wordsFit) continue;
        const lines = wrap(m, words, size, o);
        if (lines.length <= o.maxLines && lines.length * size * lineHeight <= o.maxHeight) {
            return { fontSize: size, lineHeight, lines, truncated: false };
        }
    }

    // Nothing fits whole: smallest size, as many lines as the box holds, the last one ending in "…".
    const size = o.sizes[o.sizes.length - 1];
    const ls = spacingAt(o, size);
    const capacity = Math.max(1, Math.min(o.maxLines, Math.floor(o.maxHeight / (size * lineHeight))));
    const lines = wrap(m, words, size, o);
    if (lines.length <= capacity) return { fontSize: size, lineHeight, lines, truncated: false };
    const kept = lines.slice(0, capacity);
    let last = kept[capacity - 1];
    while (last.length > 0 && measureText(m, `${last}…`, size, ls) > o.maxWidth) last = last.slice(0, -1).trimEnd();
    kept[capacity - 1] = `${last}…`;
    return { fontSize: size, lineHeight, lines: kept, truncated: true };
}
