/**
 * PICKUP-TRACKER-READABILITY-1 — the printable Pickup Tracker is a ruled grid.
 *
 * PRESENTATION ONLY. The tracker at /coordinator/portal/pickup-tracker is what a
 * coordinator prints for pickup day. It used to be a list of rows with one pale
 * rule under each, which is hard to follow across a page. It is now a table with
 * a solid black 1px grid and a visibly darker every-other-row shade.
 *
 * These assertions read the page source, as this repo's other presentation tests
 * do (tests run in a node environment, with no DOM). What they pin:
 *   - the grid exists and is black, thin, and on every cell including the header
 *   - the stripe is the intended shade, on the cells, and survives printing
 *   - every rule is scoped to .pickup-grid, so no other table changed
 *   - the DATA is untouched: same fields, same order source, same states
 *
 * The visual result is checked separately, by rendering the real page and
 * printing it — see the phase report.
 */
import fs from 'fs';
import path from 'path';

const PAGE = fs.readFileSync(
    path.join(process.cwd(), 'app', 'coordinator', 'portal', 'pickup-tracker', 'page.tsx'),
    'utf8',
).replace(/\r\n/g, '\n');

/** The page's own global style block, as written. */
const STYLE = PAGE.slice(PAGE.indexOf('<style jsx global>'), PAGE.indexOf('</style>'));
/** Only the rules that apply on screen AND paper (everything before @media print). */
const GRID_CSS = STYLE.slice(0, STYLE.indexOf('@media print'));
const PRINT_CSS = STYLE.slice(STYLE.indexOf('@media print'));

/** The CSS rule whose selector list matches `selector`, body without braces. */
function rule(css: string, selector: RegExp): string {
    const m = css.match(new RegExp(`(?:^|\\n)\\s*(${selector.source})\\s*\\{([^}]*)\\}`));
    if (!m) throw new Error(`no CSS rule matching ${selector}`);
    return m[2];
}

// WCAG relative luminance / contrast, for the "visible but readable" claim.
function luminance(hex: string): number {
    const n = parseInt(hex.replace('#', ''), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

describe('PICKUP-TRACKER-READABILITY-1 — a ruled grid', () => {
    it('renders a real table: header row, then one body row per supporter group', () => {
        expect(PAGE).toMatch(/<table className="pickup-grid w-full text-left" data-pickup-grid>/);
        expect(PAGE).toContain('<thead>');
        expect(PAGE).toContain('<tbody>');
        expect((PAGE.match(/<th scope="col"/g) || [])).toHaveLength(5);
        expect(PAGE).toMatch(/\{groups\.map\(\(g\) => \(\s*<tr key=\{g\.key\} className="supporter-row">/);
    });

    it('every body row has the same five cells as the header has columns', () => {
        const row = PAGE.slice(PAGE.indexOf('<tr key={g.key}'), PAGE.indexOf('</tr>', PAGE.indexOf('<tr key={g.key}')));
        // Count only the row's own <td> cells (the nested item list has <li>, not <td>).
        expect((row.match(/<td[\s>]/g) || [])).toHaveLength(5);
    });

    it('draws a solid, thin, black border on the table, the header and every cell', () => {
        const table = rule(GRID_CSS, /\.pickup-grid/);
        expect(table).toMatch(/border-collapse:\s*collapse;/);
        expect(table).toMatch(/border:\s*1px solid #000;/);
        // A phone scrolls the (already overflow-x-auto) wrapper rather than crushing the columns.
        expect(table).toMatch(/min-width:\s*42rem;/); // 672px — still narrower than the 720px printed page
        expect(PAGE).toContain('overflow-x-auto print:overflow-visible');

        const cells = rule(GRID_CSS, /\.pickup-grid th,\s*\.pickup-grid td/);
        expect(cells).toMatch(/border:\s*1px solid #000;/);

        // Thin means thin: no heavier rule anywhere in the grid's own CSS.
        expect(GRID_CSS).not.toMatch(/border[^;]*:\s*[2-9]px/);
        expect(GRID_CSS).not.toMatch(/border[^;]*:\s*\d+px (dashed|dotted|double)/);
    });

    it('shades every even body row with slate-200, on the cells, so white/gray alternates', () => {
        const stripe = rule(GRID_CSS, /\.pickup-grid tbody tr:nth-child\(even\) > td/);
        expect(stripe).toMatch(/background-color:\s*#E2E8F0;/);
        // On the cells — not the <tr> — because browsers drop row backgrounds in print.
        expect(GRID_CSS).not.toMatch(/tr:nth-child\(even\)\s*\{/);
        // Header stays white so the stripe starts on the second body row.
        expect(rule(GRID_CSS, /\.pickup-grid th/)).toMatch(/background-color:\s*#fff;/);
    });

    it('the stripe is two Tailwind steps darker than the XLSX export\'s slate-50, yet text stays crisp', () => {
        // Tailwind slate: 50 F8FAFC · 100 F1F5F9 · 200 E2E8F0 — two notches is 200.
        const SLATE = { 50: '#F8FAFC', 100: '#F1F5F9', 200: '#E2E8F0' };
        expect(Object.values(SLATE).indexOf('#E2E8F0') - Object.values(SLATE).indexOf('#F8FAFC')).toBe(2);
        // The old shade was effectively invisible on paper...
        expect(contrast('#FFFFFF', SLATE[50])).toBeLessThan(1.1);
        // ...the new one is visibly distinct from white...
        expect(contrast('#FFFFFF', SLATE[200])).toBeGreaterThan(1.2);
        // ...and black text on it is far above the WCAG AAA bar of 7:1.
        expect(contrast('#000000', SLATE[200])).toBeGreaterThan(14);
    });

    it('keeps the shading and the black lines on paper', () => {
        const table = rule(GRID_CSS, /\.pickup-grid/);
        // Both spellings, each checked on its own. The unprefixed one is anchored so it
        // cannot be satisfied by the substring inside `-webkit-print-color-adjust`.
        expect(table).toMatch(/-webkit-print-color-adjust:\s*exact;/);
        expect(table).toMatch(/(?:^|[\s;{])print-color-adjust:\s*exact;/);
        // The page-wide guarantee that already existed is still there.
        expect(PRINT_CSS).toMatch(/\*\s*\{\s*-webkit-print-color-adjust:\s*exact;\s*print-color-adjust:\s*exact;\s*\}/);
    });

    it('repeats the header on every printed page and keeps one supporter whole', () => {
        expect(rule(GRID_CSS, /\.pickup-grid thead/)).toMatch(/display:\s*table-header-group;/);
        const row = rule(PRINT_CSS, /\.supporter-row/);
        expect(row).toMatch(/break-inside:\s*avoid;/);
        expect(row).toMatch(/page-break-inside:\s*avoid;/);
    });

    it('gives the Order column room and never splits "Serves 2", "Qty 3", an email or a phone across lines', () => {
        // Columns would otherwise squeeze the order text into "Serves / 2" and "(555) 010- / 1084".
        expect(PAGE).toContain('className="pickup-col-supporter"');
        expect(PAGE).toContain('className="pickup-col-order"');
        const widthOf = (cls: string) => Number(rule(GRID_CSS, new RegExp(`\\.pickup-grid \\.${cls}`)).match(/width:\s*(\d+)%/)![1]);
        // The columns that carry free text get the room; the order column is the widest.
        expect(widthOf('pickup-col-order')).toBeGreaterThan(widthOf('pickup-col-supporter'));
        expect(widthOf('pickup-col-order') + widthOf('pickup-col-supporter')).toBeLessThanOrEqual(70);
        // The short tokens are unbreakable; the separators between them still are.
        expect(PAGE).toContain('<span className="whitespace-nowrap">{tier}</span>');
        expect(PAGE).toContain('<span className="whitespace-nowrap">Qty {it.quantity}</span>');
        expect(PAGE).toContain('<span className="mr-3 whitespace-nowrap">{g.phone}</span>');
        // An email is the opposite case: short ones stay whole, but a very long one must be
        // allowed to wrap rather than force the Supporter column to eat the Order column
        // (found by rendering a 60-character address — never make it nowrap).
        expect(PAGE).toContain('<span className="mr-3 [overflow-wrap:anywhere]">{g.email}</span>');
        expect(PAGE).not.toMatch(/whitespace-nowrap[^>]*>\{g\.email\}/);
        // "PAID 1 OF 2" must reserve its own width instead of wrapping to two lines.
        expect(PAGE).toMatch(/className="whitespace-nowrap [^"]*" data-payment-state="paid"/);
        expect(PAGE).toMatch(/className="whitespace-nowrap [^"]*" data-payment-state="partly_marked"/);
    });

    it('is scoped: every grid selector starts with .pickup-grid, so no other table changes', () => {
        const selectors = GRID_CSS
            // Drop the JSX wrapper (`<style jsx global>{\``) and comments, leaving only CSS.
            .replace(/<style jsx global>\{`/, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('}')
            .map((r) => r.split('{')[0].trim())
            .filter(Boolean)
            .flatMap((list) => list.split(',').map((s) => s.trim()))
            .filter(Boolean);
        expect(selectors.length).toBeGreaterThan(5);
        for (const s of selectors) expect(s).toMatch(/^\.pickup-grid\b/);
        // The print block was already page-wide; it must not have grown a bare table selector.
        const printSelectors = PRINT_CSS
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/@media print\s*\{/, '')
            .split('}')
            .map((r) => r.split('{')[0].trim())
            .flatMap((list) => list.split(',').map((s) => s.trim()))
            .filter(Boolean);
        expect(printSelectors.length).toBeGreaterThan(0);
        for (const s of printSelectors) {
            expect(s).not.toMatch(/^(table|th|td|tr|thead|tbody|tfoot)\b/i);
        }
    });

    it('is presentation only — same fields, same states, same order source as before', () => {
        // Every field the list showed is still shown.
        for (const field of ['g.customer_name', 'g.email', 'g.phone', 'g.participant_name', 'g.items.map', 'g.total', 'g.payment?.state']) {
            expect(PAGE).toContain(field);
        }
        // All three payment states, with their data attributes and the "never Unpaid" wording.
        for (const state of ['paid', 'partly_marked', 'not_marked']) {
            expect(PAGE).toContain(`data-payment-state="${state}"`);
        }
        expect(PAGE).toMatch(/Paid \{g\.payment\.paidCount\} of \{g\.payment\.orderCount\}/);
        // Status lines and empty state are intact.
        expect(PAGE).toContain('data-printed-status={documentState}');
        expect(PAGE).toContain('data-empty-state=');
        // Rows come out in the API's order: the page never re-sorts, filters or reverses them.
        const rows = PAGE.slice(PAGE.indexOf('{groups.map('), PAGE.indexOf('</tbody>'));
        expect(rows).not.toMatch(/\.(sort|filter|reverse|slice)\(/);
        expect(PAGE).not.toMatch(/groups\s*\.\s*(sort|filter|reverse)\(/);
    });

    it('does not reach for any network call or write — it still only reads the one tracker endpoint', () => {
        expect((PAGE.match(/fetch\(/g) || [])).toHaveLength(1);
        expect(PAGE).toContain("fetch('/api/coordinator/pickup-tracker')");
        expect(PAGE).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/);
    });
});
