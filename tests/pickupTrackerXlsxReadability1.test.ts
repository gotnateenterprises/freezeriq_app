/**
 * PICKUP-TRACKER-XLSX-READABILITY-1 — the Pickup Sheet workbook is a black-ruled grid with a
 * visible every-other-row shade.
 *
 * PRESENTATION ONLY. /api/tracker/pickup-sheet used to emit a sheet with no cell borders and a
 * near-invisible stripe (slate-50, FFF8FAFC), which is hard to follow across a page, on screen or
 * on paper. It now draws a thin black border on every cell of the table and shades every other
 * order row slate-200 (FFE2E8F0).
 *
 * These tests run the REAL route handler against the shared recording Prisma double, open the
 * workbook it actually returns with ExcelJS, and assert on cells — not on source text — so a style
 * that exists in code but never reaches a cell (the classic `eachCell` gap on blank cells) fails.
 * The fixture is fictional: tests/helpers/pickupSheetFixture.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { SHEET_CAMPAIGN, SHEET_BUNDLES, SHEET_SUPPORTER_COUNT, sheetOrders } from './helpers/pickupSheetFixture';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { PAYMENT_NOT_MARKED_LABEL, PAYMENT_PAID_LABEL } from '@/lib/supporterPayment';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__pxrPrisma; } }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => ((global as any).__pxrAuthed && name === (global as any).__pxrCookieName
            ? { name, value: 'pxr-session-secret' } : undefined),
        set: () => undefined,
        delete: () => undefined,
    }),
}));

const ROUTE_SRC = readFileSync(join(process.cwd(), 'app', 'api', 'tracker', 'pickup-sheet', 'route.ts'), 'utf8');

const HEADER_ROW = 4;
const FIRST_DATA_ROW = 5;
const COLUMNS = 9; // #, Customer, Phone, 3 bundles, Total Bundles, Amount Due, Payment
const STRIPE = 'FFE2E8F0';
const OLD_STRIPE = 'FFF8FAFC';
const BLACK = 'FF000000';

let mock: PrismaMock;
async function generate(orders: any[]) {
    mock = createPrismaMock({
        results: {
            'coordinatorSession.findUnique': { id: 's', campaign_id: SHEET_CAMPAIGN.id, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null },
            'fundraiserCampaign.findFirst': SHEET_CAMPAIGN,
            'order.findMany': orders,
            'bundle.findMany': [],
        },
    });
    (global as any).__pxrPrisma = mock.client;
    const res: Response = await require('@/app/api/tracker/pickup-sheet/route').GET(
        new Request('http://localhost/api/tracker/pickup-sheet', { headers: { origin: 'http://localhost' } }),
    );
    expect(res.status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(await res.arrayBuffer());
    await wb.xlsx.load(buf as any);
    return { wb, ws: wb.worksheets[0], buf };
}

const sides = ['top', 'left', 'bottom', 'right'] as const;
/** Every side thin and black? Returns the offending sides (empty = a correct cell). */
function badSides(cell: any): string[] {
    return sides.filter((s) => {
        const b = cell.border?.[s];
        return !(b && b.style === 'thin' && b.color?.argb === BLACK);
    });
}
const fillArgb = (cell: any): string | undefined =>
    cell.fill && cell.fill.pattern === 'solid' ? cell.fill.fgColor?.argb : undefined;

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
beforeEach(() => {
    (global as any).__pxrCookieName = coordinatorSessionCookieName();
    (global as any).__pxrAuthed = true;
});

describe('PICKUP-TRACKER-XLSX-READABILITY-1 — workbook structure and data are untouched', () => {
    it('is still one sheet, "Pickup Sheet": 4 title/header rows + one row per supporter + a totals row', async () => {
        const { wb, ws } = await generate(sheetOrders());
        expect(wb.worksheets.map((w) => w.name)).toEqual(['Pickup Sheet']);
        expect(ws.rowCount).toBe(HEADER_ROW + SHEET_SUPPORTER_COUNT + 1);
        expect(ws.columnCount).toBe(COLUMNS);
        expect(ws.model.merges).toEqual(['A1:H1', 'A2:H2', 'A3:H3']);
    });

    it('header text is unchanged', async () => {
        const { ws } = await generate(sheetOrders());
        const header = Array.from({ length: COLUMNS }, (_, i) => ws.getCell(HEADER_ROW, i + 1).value);
        expect(header).toEqual([
            '#', 'Customer', 'Phone',
            'Q1 - Comfort Foods\n(Family)',
            'Q2 - Clean Eating/Paleo\n(Serves 2)',
            'Q3 - Keto Favorites With A Deliberately Long Bundle Name\n(Serves 2)',
            'Total\nBundles', 'Amount\nDue', 'Payment',
        ]);
    });

    it('every business value, and the row order, is exactly what the orders say', async () => {
        const orders = sheetOrders();
        const { ws } = await generate(orders);
        const qty = (o: any, id: string) => o.items.filter((i: any) => i.bundle_id === id).reduce((n: number, i: any) => n + i.quantity, 0);
        orders.forEach((o, idx) => {
            const r = FIRST_DATA_ROW + idx;
            const fam = qty(o, SHEET_BUNDLES.family.id), paleo = qty(o, SHEET_BUNDLES.paleo.id), keto = qty(o, SHEET_BUNDLES.keto.id);
            const v = (c: number) => ws.getCell(r, c).value;
            expect(v(1)).toBe(idx + 1);
            expect(v(2)).toBe(o.customer_name);
            expect(v(3)).toBe(o.phone);
            expect([v(4), v(5), v(6)]).toEqual([fam || '', paleo || '', keto || '']);
            expect(v(7)).toBe(fam + paleo + keto);
            expect(v(8)).toBeCloseTo(Number(o.total_amount) + Number(o.tax_amount), 2);
            expect(v(9)).toBe(o.paid_at ? PAYMENT_PAID_LABEL : PAYMENT_NOT_MARKED_LABEL);
            expect(ws.getCell(r, 8).numFmt).toBe('$#,##0.00');
        });
        const t = FIRST_DATA_ROW + orders.length;
        expect(ws.getCell(t, 2).value).toBe('TOTALS');
        expect(ws.getCell(t, 7).value).toBe(orders.reduce((n, o) => n + o.items.reduce((m: number, i: any) => m + i.quantity, 0), 0));
        expect(ws.getCell(t, 9).value).toBe(`${orders.filter((o) => o.paid_at).length} of ${orders.length} marked paid`);
        expect(ws.getRow(t + 1).hasValues).toBe(false); // no extra row appeared
    });

    it('column widths and the number/quantity/payment alignment are untouched', async () => {
        const { ws } = await generate(sheetOrders());
        expect(ws.columns.map((c) => c.width)).toEqual([6, 26, 16, 20, 20, 20, 12, 13, 20]);
        expect(ws.getCell(FIRST_DATA_ROW, 4).alignment).toEqual({ horizontal: 'center' });
        expect(ws.getCell(FIRST_DATA_ROW, 8).alignment).toEqual({ horizontal: 'right' });
        expect(ws.getCell(FIRST_DATA_ROW, 9).alignment).toEqual({ horizontal: 'left' });
    });

    it('body text keeps its default (black) colour — no style on a body cell lightens it', async () => {
        const { ws } = await generate(sheetOrders());
        for (let r = FIRST_DATA_ROW; r < FIRST_DATA_ROW + SHEET_SUPPORTER_COUNT; r++) {
            for (let c = 1; c <= COLUMNS; c++) {
                const color = (ws.getCell(r, c).font as any)?.color;
                // Calibri 11 in theme colour 1 (text), or no colour at all. Never an explicit light ARGB.
                expect(color === undefined || color.theme === 1).toBe(true);
            }
        }
    });
});

describe('PICKUP-TRACKER-XLSX-READABILITY-1 — the black grid', () => {
    it('the header row: every cell has a thin black border on all four sides', async () => {
        const { ws } = await generate(sheetOrders());
        for (let c = 1; c <= COLUMNS; c++) expect({ c, bad: badSides(ws.getCell(HEADER_ROW, c)) }).toEqual({ c, bad: [] });
    });

    it('every order row: every column, including blank bundle-quantity cells, is ruled thin and black', async () => {
        const { ws } = await generate(sheetOrders());
        let blanks = 0;
        for (let r = FIRST_DATA_ROW; r < FIRST_DATA_ROW + SHEET_SUPPORTER_COUNT; r++) {
            for (let c = 1; c <= COLUMNS; c++) {
                if (ws.getCell(r, c).value === '' || ws.getCell(r, c).value == null) blanks++;
                expect({ r, c, bad: badSides(ws.getCell(r, c)) }).toEqual({ r, c, bad: [] });
            }
        }
        expect(blanks).toBeGreaterThan(10); // the fixture really exercises the blank-cell case
    });

    it('the totals row is part of the grid', async () => {
        const { ws } = await generate(sheetOrders());
        const t = FIRST_DATA_ROW + SHEET_SUPPORTER_COUNT;
        for (let c = 1; c <= COLUMNS; c++) expect({ c, bad: badSides(ws.getCell(t, c)) }).toEqual({ c, bad: [] });
    });

    it('nothing outside the table is ruled: not the title rows, not a column to the right, not the row below', async () => {
        const { ws } = await generate(sheetOrders());
        const t = FIRST_DATA_ROW + SHEET_SUPPORTER_COUNT;
        for (const addr of ['A1', 'A2', 'A3', 'H1', `J${HEADER_ROW}`, `J${FIRST_DATA_ROW}`, `A${t + 1}`, `B${t + 2}`]) {
            // ExcelJS reports an unruled cell's border as {} — no side set.
            expect({ addr, ruledSides: sides.filter((s) => (ws.getCell(addr).border as any)?.[s]) }).toEqual({ addr, ruledSides: [] });
        }
    });

    it('the rule is thin — no heavier line anywhere in the workbook\'s table', async () => {
        const { ws } = await generate(sheetOrders());
        const styles = new Set<string>();
        for (let r = HEADER_ROW; r <= HEADER_ROW + SHEET_SUPPORTER_COUNT + 1; r++) {
            for (let c = 1; c <= COLUMNS; c++) for (const s of sides) styles.add(String((ws.getCell(r, c).border as any)?.[s]?.style));
        }
        expect([...styles]).toEqual(['thin']);
    });
});

describe('PICKUP-TRACKER-XLSX-READABILITY-1 — the darker alternating shade', () => {
    it('white, E2E8F0, white, E2E8F0 … starting with white on the first order, on EVERY column', async () => {
        const { ws } = await generate(sheetOrders());
        for (let i = 0; i < SHEET_SUPPORTER_COUNT; i++) {
            const r = FIRST_DATA_ROW + i;
            for (let c = 1; c <= COLUMNS; c++) {
                expect({ r, c, fill: fillArgb(ws.getCell(r, c)) }).toEqual({ r, c, fill: i % 2 === 1 ? STRIPE : undefined });
            }
        }
    });

    it('the old pale shade is gone from the whole sheet', async () => {
        const { ws } = await generate(sheetOrders());
        for (let r = 1; r <= ws.rowCount; r++) for (let c = 1; c <= COLUMNS; c++) expect(fillArgb(ws.getCell(r, c))).not.toBe(OLD_STRIPE);
        // Executable code only: the route's own comment may name the shade it replaced.
        expect(ROUTE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toContain(OLD_STRIPE);
    });

    it('the stripe is two Tailwind slate steps darker than the old one, with black text staying crisp', () => {
        const slate = ['F8FAFC', 'F1F5F9', 'E2E8F0']; // slate 50, 100, 200
        expect(slate.indexOf('E2E8F0') - slate.indexOf('F8FAFC')).toBe(2);
        expect(STRIPE).toBe(`FF${slate[2]}`);
        const lum = (hex: string) => {
            const n = parseInt(hex, 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
                .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        };
        const contrast = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        expect(contrast('FFFFFF', 'F8FAFC')).toBeLessThan(1.1);  // the old shade, barely there
        expect(contrast('FFFFFF', 'E2E8F0')).toBeGreaterThan(1.2); // visible
        expect(contrast('000000', 'E2E8F0')).toBeGreaterThan(14);  // and text on it stays far above AAA
        // Grayscale printer (BT.601 luma): the new step is ~24 levels from white, the old one ~6.
        const luma = (hex: string) => { const n = parseInt(hex, 16); return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
        expect(255 - luma('E2E8F0')).toBeGreaterThan(20);
        expect(255 - luma('F8FAFC')).toBeLessThan(8);
    });

    it('small sheets alternate correctly too: one supporter is white, two are white then shaded, none still has a totals row', async () => {
        const one = await generate(sheetOrders().slice(0, 1));
        expect(fillArgb(one.ws.getCell(FIRST_DATA_ROW, 2))).toBeUndefined();
        const two = await generate(sheetOrders().slice(0, 2));
        expect(fillArgb(two.ws.getCell(FIRST_DATA_ROW, 2))).toBeUndefined();
        expect(fillArgb(two.ws.getCell(FIRST_DATA_ROW + 1, 2))).toBe(STRIPE);
        // No orders means no bundle columns either: # Customer Phone Total Amount Payment = 6 columns.
        const none = await generate([]);
        expect(none.ws.getCell(FIRST_DATA_ROW, 2).value).toBe('TOTALS');
        for (let c = 1; c <= 6; c++) {
            expect(badSides(none.ws.getCell(HEADER_ROW, c))).toEqual([]);
            expect(badSides(none.ws.getCell(FIRST_DATA_ROW, c))).toEqual([]);
        }
    });
});

/** The raw XML of one part of the generated workbook, bypassing ExcelJS's read-back defaults. */
async function rawPart(orders: any[], part: string): Promise<string> {
    const { buf } = await generate(orders); // the bytes the route returned, not a re-serialised copy
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buf);
    return zip.file(part).async('string');
}

describe('PICKUP-TRACKER-XLSX-READABILITY-1A — print layout', () => {
    it('prints landscape, ONE page wide, as many pages tall as it needs', async () => {
        const { ws } = await generate(sheetOrders());
        expect(ws.pageSetup.orientation).toBe('landscape');
        expect(ws.pageSetup.fitToPage).toBe(true);
        expect(ws.pageSetup.fitToWidth).toBe(1);
        // 0 = automatic. Anything else (the default 1) would squeeze a long sheet onto one page tall.
        expect(ws.pageSetup.fitToHeight).toBe(0);
    });

    it('writes those settings into the file itself, not just the read-back model', async () => {
        const sheet = await rawPart(sheetOrders(), 'xl/worksheets/sheet1.xml');
        const setup = sheet.match(/<pageSetup[^>]*>/)![0];
        expect(setup).toContain('orientation="landscape"');
        expect(setup).toContain('fitToWidth="1"');
        expect(setup).toContain('fitToHeight="0"');
        expect(sheet).toMatch(/<pageSetUpPr fitToPage="1"\/>/);
    });

    it('repeats exactly the table header row (row 4) on every printed page — not the title rows', async () => {
        const { ws } = await generate(sheetOrders());
        expect(ws.pageSetup.printTitlesRow).toBe(`${HEADER_ROW}:${HEADER_ROW}`);
        const book = await rawPart(sheetOrders(), 'xl/workbook.xml');
        expect(book).toMatch(/<definedName name="_xlnm\.Print_Titles" localSheetId="0">&apos;Pickup Sheet&apos;!\$4:\$4<\/definedName>/);
        // The header really is on row 4.
        expect(ws.getCell(HEADER_ROW, 2).value).toBe('Customer');
    });

    it('wraps the Customer column so a long name is shown whole, on every order row', async () => {
        const orders = sheetOrders();
        const { ws } = await generate(orders);
        for (let i = 0; i < orders.length; i++) {
            expect({ row: FIRST_DATA_ROW + i, wrap: ws.getCell(FIRST_DATA_ROW + i, 2).alignment?.wrapText }).toEqual({ row: FIRST_DATA_ROW + i, wrap: true });
        }
        // The name itself is the full name — nothing was truncated to make it fit.
        expect(orders.some((o) => o.customer_name.length > 50)).toBe(true);
        orders.forEach((o, i) => expect(ws.getCell(FIRST_DATA_ROW + i, 2).value).toBe(o.customer_name));
    });

    it('wraps every header cell, including the bundle names, which keep their full text', async () => {
        const { ws } = await generate(sheetOrders());
        for (let c = 1; c <= COLUMNS; c++) expect({ c, wrap: ws.getCell(HEADER_ROW, c).alignment?.wrapText }).toEqual({ c, wrap: true });
        expect(ws.getCell(HEADER_ROW, 6).value).toBe('Q3 - Keto Favorites With A Deliberately Long Bundle Name\n(Serves 2)');
    });

    it('leaves the header and order rows without a stored height, so Excel sizes them to the wrapped text', async () => {
        const { ws } = await generate(sheetOrders());
        for (let r = HEADER_ROW; r < FIRST_DATA_ROW + SHEET_SUPPORTER_COUNT; r++) {
            expect({ r, height: ws.getRow(r).height }).toEqual({ r, height: undefined });
        }
        const sheet = await rawPart(sheetOrders(), 'xl/worksheets/sheet1.xml');
        for (let r = HEADER_ROW; r < FIRST_DATA_ROW + SHEET_SUPPORTER_COUNT; r++) {
            expect(sheet.match(new RegExp(`<row r="${r}"[^>]*>`))![0]).not.toMatch(/customHeight|ht=/);
        }
    });

    it('does not touch the approved look: grid, stripe and totals fill are exactly as in 568366b', async () => {
        const { ws } = await generate(sheetOrders());
        const t = FIRST_DATA_ROW + SHEET_SUPPORTER_COUNT;
        for (let c = 1; c <= COLUMNS; c++) {
            expect(badSides(ws.getCell(HEADER_ROW, c))).toEqual([]);
            expect(fillArgb(ws.getCell(FIRST_DATA_ROW + 1, c))).toBe(STRIPE);
            expect(fillArgb(ws.getCell(FIRST_DATA_ROW, c))).toBeUndefined();
            expect(fillArgb(ws.getCell(t, c))).toBe(STRIPE);
            expect(badSides(ws.getCell(t, c))).toEqual([]);
        }
    });
});

describe('PICKUP-TRACKER-XLSX-READABILITY-1 — scope', () => {
    it('is read-only: the download writes nothing', async () => {
        await generate(sheetOrders());
        const READ = /^(findFirst|findUnique|findMany|count|aggregate|groupBy|findFirstOrThrow|findUniqueOrThrow)$/;
        expect(mock.calls.length).toBeGreaterThan(0);
        for (const c of mock.calls) expect({ call: `${c.model}.${c.method}`, read: READ.test(c.method) }).toEqual({ call: `${c.model}.${c.method}`, read: true });
        expect(((mock.client as any).$transaction as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('the styles are private to this route: not exported, and no other export or library carries them', () => {
        expect(ROUTE_SRC).toMatch(/^const PICKUP_SHEET_STRIPE_ARGB = 'FFE2E8F0';$/m);
        expect(ROUTE_SRC).not.toMatch(/export (const|function) (PICKUP_SHEET|GRID_)/);
        for (const other of [
            'app/api/tracker/download/route.ts', 'app/api/documents/tracking-sheet/route.ts',
            'lib/generateTracker.ts', 'lib/coordinatorOrderTracker.ts',
        ]) {
            const src = readFileSync(join(process.cwd(), other), 'utf8');
            expect(src).not.toContain('PICKUP_SHEET_STRIPE_ARGB');
            expect(src).not.toContain('pickup-sheet/route');
        }
    });
});
