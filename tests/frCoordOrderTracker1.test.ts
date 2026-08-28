/**
 * FR-COORD-ORDER-TRACKER-1 — coordinator Order Tracker XLSX Bundle-family
 * correctness.
 *
 * Failure modes pinned here:
 *  - "Bundle 1"/"Bundle 2" staying permanently generic template text instead
 *    of the campaign's actual selected family names
 *  - the reference-area meal list for one family silently showing another
 *    family's meals, or a Serves-2 sibling's meals instead of the canonical
 *    Serves-5 list, because the source data was a flat, family-blind,
 *    unordered list indexed purely by array position
 *  - a Serves-5/Serves-2 pair crossing families (Family A's Serves-2 priced
 *    or labeled as Family B's, or vice versa)
 *  - stale/hardcoded prices that don't match the campaign's real Bundle.price
 *  - a leftover 'candidate' (never-selected) Bundle appearing in the output
 *  - inventing tax computation the real fundraiser order flow never charges
 *  - a raw UUID leaking into a cell a coordinator actually reads
 */

import ExcelJS from 'exceljs';
import path from 'path';
import {
    buildTrackerFamilies,
    populateTrackerWorksheet,
    shortFamilyLabel,
    type TrackerBundleRow,
} from '@/lib/coordinatorOrderTracker';

const TEMPLATE_PATH = path.join(process.cwd(), 'templates', 'tracking_sheet.xlsx');

async function loadTemplate() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE_PATH);
    return wb.worksheets[0];
}

// Real, current Production shape for "The Best Brew Test1 Fundraiser":
// families Comfort Food + Keto Bundle, both $125 family / $60 serves_2.
function comfortFoodRows(): TrackerBundleRow[] {
    return [
        {
            id: 'bundle-comfort-s5', name: 'Comfort Food - Fall 2026', price: 125,
            serving_tier: 'family', family_id: 'family-comfort',
            meals: ['Mac-n-Cheese (Chili)', 'Cranberry Pork', 'Orange Chicken', 'Cheeseburger Soup', 'Chicken Spaghetti'],
        },
        {
            id: 'bundle-comfort-s2', name: 'Comfort Food (Serves 2) - Fall 2026', price: 60,
            serving_tier: 'serves_2', family_id: 'family-comfort',
            meals: ['Cranberry Pork (Serves 2)', 'Orange Chicken (Serves 2)', 'Cheeseburger Soup (Serves 2)', 'Chicken Spaghetti (Serves 2)', 'Mac-n-Cheese (Chili) (Serves 2)'],
        },
    ];
}

function ketoRows(): TrackerBundleRow[] {
    return [
        {
            id: 'bundle-keto-s5', name: 'Keto Bundle - Fall 2026', price: 125,
            serving_tier: 'family', family_id: 'family-keto',
            meals: ['Bacon Cheeseburger Soup - KETO', 'Tuscan Garlic Chicken - Keto', 'Chicken Fajita Casserole - Keto', 'Chicken Cordon Bleu Casserole - Keto', 'Mississippi Mud Pork'],
        },
        {
            id: 'bundle-keto-s2', name: 'Keto Bundle (Serves 2) - Fall 2026', price: 60,
            serving_tier: 'serves_2', family_id: 'family-keto',
            meals: ['Mississippi Mud Pork (Serves 2)', 'Bacon Cheeseburger Soup - KETO (Serves 2)'],
        },
    ];
}

// The owner's explicit "another fundraiser" example — must work identically,
// proving nothing is hardcoded to Comfort Food/Keto.
function cleanEatingRows(): TrackerBundleRow[] {
    return [
        { id: 'ce-s5', name: 'Clean Eating/Paleo', price: 125, serving_tier: 'family', family_id: 'family-ce', meals: ['Chicken Fajitas (CE/P/GF)', 'Apple Rosemary Pork'] },
        { id: 'ce-s2', name: 'Clean Eating/Paleo (Serves 2)', price: 60, serving_tier: 'serves_2', family_id: 'family-ce', meals: ['Chicken Fajitas (CE/P/GF) (Serves 2)'] },
    ];
}
function familyFriendlyRows(): TrackerBundleRow[] {
    return [
        { id: 'ff-s5', name: 'Family Friendly', price: 125, serving_tier: 'family', family_id: 'family-ff', meals: ['Creamy Italian Chicken', 'Zuppa Toscana'] },
        { id: 'ff-s2', name: 'Family Friendly (Serves 2)', price: 60, serving_tier: 'serves_2', family_id: 'family-ff', meals: ['Creamy Italian Chicken (Serves 2)'] },
    ];
}

describe('1-2. dynamic family names replace generic-only "Bundle 1"/"Bundle 2"', () => {
    it('a Comfort Food + Keto campaign produces those actual family names in the workbook', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;

        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('B23').value).toBe('Comfort Food - Fall 2026');
        expect(ws.getCell('C23').value).toBe('Keto Bundle - Fall 2026');
    });

    it('a DIFFERENT campaign (Clean Eating/Paleo + Family Friendly) produces THOSE names — nothing is hardcoded', async () => {
        const resolved = buildTrackerFamilies([...cleanEatingRows(), ...familyFriendlyRows()]);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;

        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('B23').value).toBe('Clean Eating/Paleo');
        expect(ws.getCell('C23').value).toBe('Family Friendly');
        expect(ws.getCell('B23').value).not.toMatch(/^Bundle 1$/);
        expect(ws.getCell('C23').value).not.toMatch(/^Bundle 2 ?$/);
    });

    it('the generic template text is gone from the reference-area headers', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });
        expect(ws.getCell('B23').value).not.toBe('Bundle 1');
        expect(ws.getCell('C23').value).not.toBe('Bundle 2 ');
    });
});

describe('3-6. Serves-5 / Serves-2 mapping never crosses families', () => {
    it('Family A (Comfort) Serves-5 -> F9, Serves-2 -> D9; Family B (Keto) Serves-5 -> G9, Serves-2 -> E9', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('D9').value).toContain('Comfort');
        expect(ws.getCell('D9').value).toContain('S2');
        expect(ws.getCell('F9').value).toContain('Comfort');
        expect(ws.getCell('F9').value).toContain('S5');
        expect(ws.getCell('E9').value).toContain('Keto');
        expect(ws.getCell('E9').value).toContain('S2');
        expect(ws.getCell('G9').value).toContain('Keto');
        expect(ws.getCell('G9').value).toContain('S5');
    });

    it('Family A never pulls Family B price, and vice versa, when prices diverge', async () => {
        const rows = [
            { ...comfortFoodRows()[0], price: 150 }, // Comfort S5 = $150 (diverges)
            comfortFoodRows()[1],                    // Comfort S2 = $60
            ...ketoRows(),                           // Keto S5 = $125, S2 = $60
        ];
        const resolved = buildTrackerFamilies(rows);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        // Serves-5 prices now diverge ($150 vs $125) -> row 9 must carry the
        // specific number per column, never a shared/blended figure.
        expect(ws.getCell('F9').value).toBe('Comfort Food S5 $150.00');
        expect(ws.getCell('G9').value).toBe('Keto Bundle S5 $125.00');
        // Serves-2 still uniform ($60 = $60) -> short label only, no price
        // needed there since row 8 already carries the true shared number.
        expect(ws.getCell('D9').value).toBe('Comfort Food S2');
        expect(ws.getCell('E9').value).toBe('Keto Bundle S2');
    });
});

describe('7-9. meal reference area uses the CANONICAL (Serves-5) list per family', () => {
    it('Family A meals come from Family A\'s Serves-5 bundle, Family B from Family B\'s', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('B24').value).toBe('Mac-n-Cheese (Chili)');
        expect(ws.getCell('B25').value).toBe('Cranberry Pork');
        expect(ws.getCell('C24').value).toBe('Bacon Cheeseburger Soup - KETO');
        expect(ws.getCell('C25').value).toBe('Tuscan Garlic Chicken - Keto');
    });

    it('the Serves-2 sibling\'s "(Serves 2)"-suffixed meal names never appear in the canonical reference list', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        for (let r = 24; r <= 28; r++) {
            expect(String(ws.getCell(`B${r}`).value || '')).not.toMatch(/\(Serves 2\)/);
            expect(String(ws.getCell(`C${r}`).value || '')).not.toMatch(/\(Serves 2\)/);
        }
    });

    it('falls back to the Serves-2 meal list only when a family has no Serves-5 side at all', () => {
        const rows: TrackerBundleRow[] = [
            { id: 's2-only', name: 'Odd Family (Serves 2)', price: 60, serving_tier: 'serves_2', family_id: 'family-odd', meals: ['Only Meal (Serves 2)'] },
        ];
        const resolved = buildTrackerFamilies(rows);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.families[0].serves5).toBeNull();
        expect(resolved.families[0].serves2?.meals).toEqual(['Only Meal (Serves 2)']);
    });
});

describe('10-12. no candidate, unrelated, or cross-tenant Bundle data leaks in', () => {
    it('buildTrackerFamilies only ever sees what its caller passed it — no independent fetch', () => {
        // Structural guarantee: the function takes rows as its only input and
        // performs no I/O, so a caller that queries `state: 'active'` (as the
        // route now does) cannot have 'candidate' rows leak in via this
        // function — they were never in `rows` to begin with.
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        expect(resolved.families).toHaveLength(2);
        expect(resolved.families.map(f => f.familyName).sort()).toEqual(
            ['Comfort Food - Fall 2026', 'Keto Bundle - Fall 2026'].sort()
        );
    });

    it('the route scopes its CampaignBundle query to state: "active" and this campaign only', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app', 'api', 'tracker', 'download', 'route.ts'), 'utf8'
        );
        expect(src).toMatch(/state:\s*'active'/);
        expect(src).toMatch(/campaign_id:\s*campaign\.id/);
    });

    it('the route scopes its legacy Bundle query to this business only', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app', 'api', 'tracker', 'download', 'route.ts'), 'utf8'
        );
        expect(src).toMatch(/business_id:\s*businessId/);
    });
});

describe('13. pricing matches the authoritative campaign/Bundle data', () => {
    it('the real Best Brew Test1 figures ($125 family / $60 serves_2, uniform) render exactly, in row 8', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('D8').value).toBe('Serves 2- $60.00');
        expect(ws.getCell('F8').value).toBe('Serves 5- $125.00');
        // The old stale template figures must be gone.
        expect(ws.getCell('D8').value).not.toContain('60.60');
        expect(ws.getCell('F8').value).not.toContain('126.50');
    });

    it('a missing price refuses the whole tracker rather than printing $0 or a stale number', () => {
        const rows: TrackerBundleRow[] = [
            { id: 'bad', name: 'Broken Bundle', price: null, serving_tier: 'family', family_id: 'family-bad', meals: [] },
        ];
        const resolved = buildTrackerFamilies(rows);
        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        expect(resolved.code).toBe('missing_price');
    });
});

describe('14-16. no formulas exist, and no tax is invented', () => {
    it('the template has no formula cells for the populated range (nothing to break)', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        for (const addr of ['B4', 'B5', 'B23', 'C23', 'D8', 'F8', 'D9', 'E9', 'F9', 'G9', 'I9', 'B24', 'C24']) {
            const cell = ws.getCell(addr);
            expect(cell.formula).toBeUndefined();
        }
    });

    it('the tax-clarity label is truthful and no tax percentage/formula was invented', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('I9').value).toBe('Total Cost (No Tax)');
        for (let r = 1; r <= 31; r++) {
            for (let c = 1; c <= 12; c++) {
                const v = ws.getRow(r).getCell(c).value;
                if (typeof v === 'string') expect(v).not.toMatch(/\b\d{1,2}(\.\d+)?%/);
            }
        }
    });

    it('the real fundraiser order flow never charges tax — the generator has no tax logic to match', () => {
        const orderRouteSrc = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app', 'api', 'public', 'order', 'route.ts'), 'utf8'
        );
        expect(orderRouteSrc.toLowerCase()).not.toMatch(/tax/);
        const trackerLibSrc = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib', 'coordinatorOrderTracker.ts'), 'utf8'
        );
        expect(trackerLibSrc.toLowerCase().replace(/no tax/g, '')).not.toMatch(/tax_amount|tax_rate|tax_percent/);
    });
});

describe('17. long family names do not corrupt workbook structure', () => {
    it('shortFamilyLabel truncates at a clean word boundary for the narrow columns', () => {
        expect(shortFamilyLabel('Comfort Food - Fall 2026')).toBe('Comfort Food');
        expect(shortFamilyLabel('Family Friendly - Fall 2026')).toBe('Family');
        expect(shortFamilyLabel('Short')).toBe('Short');
        // A single word longer than maxLen falls back to a raw slice rather
        // than producing an empty label.
        expect(shortFamilyLabel('Supercalifragilisticexpialidocious', 10)).toBe('Supercalif');
    });

    it('the wide reference-area header still gets the FULL untruncated name', async () => {
        const rows: TrackerBundleRow[] = [
            { id: 'long-s5', name: 'An Extremely Long Bundle Family Name For This Season', price: 125, serving_tier: 'family', family_id: 'family-long', meals: ['Meal'] },
            { id: 'long-s2', name: 'An Extremely Long Bundle Family Name For This Season (Serves 2)', price: 60, serving_tier: 'serves_2', family_id: 'family-long', meals: ['Meal (Serves 2)'] },
        ];
        const resolved = buildTrackerFamilies(rows);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('B23').value).toBe('An Extremely Long Bundle Family Name For This Season');
        // The narrow row-9 label stays short.
        expect(String(ws.getCell('F9').value)).toMatch(/^An Extremely S5$|^An S5$/);
        expect(String(ws.getCell('F9').value).length).toBeLessThan(20);
    });
});

describe('18. the generated workbook remains a valid, openable XLSX', () => {
    it('round-trips through writeBuffer and back through ExcelJS with no throw', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(TEMPLATE_PATH);
        populateTrackerWorksheet(wb.worksheets[0], resolved.families, {
            endDate: new Date('2026-11-15T12:00:00Z'),
            payee: 'The Best Brew Test1',
        });
        const buffer = await wb.xlsx.writeBuffer();
        expect(buffer.byteLength).toBeGreaterThan(0);

        const reread = new ExcelJS.Workbook();
        await expect(reread.xlsx.load(buffer as any)).resolves.not.toThrow();
        expect(reread.worksheets[0].getCell('B23').value).toBe('Comfort Food - Fall 2026');
    });
});

describe('19. no raw UUID or internal-only identifier leaks into any cell', () => {
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    it('every populated cell is free of UUID-shaped text', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: 'Some Org' });

        for (let r = 1; r <= 31; r++) {
            for (let c = 1; c <= 12; c++) {
                const v = ws.getRow(r).getCell(c).value;
                if (typeof v === 'string') expect(v).not.toMatch(UUID_RE);
            }
        }
    });
});

describe('20. Bundle 1 / Bundle 2 mapping is deterministic by input (position) order, not name/id', () => {
    it('swapping which family comes first in the input row order swaps which column it lands in', async () => {
        const forward = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        const reversed = buildTrackerFamilies([...ketoRows(), ...comfortFoodRows()]);
        if (!forward.ok || !reversed.ok) throw new Error('unexpected refusal');

        const wsForward = await loadTemplate();
        populateTrackerWorksheet(wsForward, forward.families, { endDate: null, payee: null });
        const wsReversed = await loadTemplate();
        populateTrackerWorksheet(wsReversed, reversed.families, { endDate: null, payee: null });

        expect(wsForward.getCell('B23').value).toBe('Comfort Food - Fall 2026');
        expect(wsReversed.getCell('B23').value).toBe('Keto Bundle - Fall 2026');
        // Mapping follows input order consistently — never a fixed/alphabetical
        // assumption independent of the campaign's actual selection order.
        expect(wsForward.getCell('C23').value).toBe('Keto Bundle - Fall 2026');
        expect(wsReversed.getCell('C23').value).toBe('Comfort Food - Fall 2026');
    });
});

describe('additional: fail-closed validation, legacy grouping, and blank-slot handling', () => {
    it('an unresolvable serving tier refuses the whole tracker', () => {
        const rows: TrackerBundleRow[] = [
            { id: 'weird', name: 'Weird Bundle', price: 100, serving_tier: 'extra_large', family_id: 'family-weird', meals: [] },
        ];
        const resolved = buildTrackerFamilies(rows);
        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        expect(resolved.code).toBe('unknown_serving_tier');
    });

    it('legacy rows without family_id group by serving-suffix-stripped name, matching groupMaterialMenus', () => {
        const rows: TrackerBundleRow[] = [
            { id: 'legacy-s5', name: 'Legacy Menu', price: 125, serving_tier: 'family', family_id: null, meals: ['Meal 1'] },
            { id: 'legacy-s2', name: 'Legacy Menu (Serves 2)', price: 60, serving_tier: 'serves_2', family_id: null, meals: ['Meal 1 (Serves 2)'] },
        ];
        const resolved = buildTrackerFamilies(rows);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.families).toHaveLength(1);
        expect(resolved.families[0].familyName).toBe('Legacy Menu');
        expect(resolved.families[0].serves5?.bundleId).toBe('legacy-s5');
        expect(resolved.families[0].serves2?.bundleId).toBe('legacy-s2');
    });

    it('a campaign with only one selected family blanks the second slot instead of leaving stale "Bundle 2" text', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, { endDate: null, payee: null });

        expect(ws.getCell('B23').value).toBe('Comfort Food - Fall 2026');
        expect(ws.getCell('C23').value).toBe('');
        expect(ws.getCell('E9').value).toBe('');
        expect(ws.getCell('G9').value).toBe('');
    });

    it('the deadline (B4) and payee (B5) logic is unchanged from the pre-fix route', async () => {
        const resolved = buildTrackerFamilies([...comfortFoodRows(), ...ketoRows()]);
        if (!resolved.ok) throw new Error('unexpected refusal');
        const ws = await loadTemplate();
        populateTrackerWorksheet(ws, resolved.families, {
            endDate: new Date('2026-11-15T12:00:00Z'),
            payee: 'The Best Brew Test1',
        });
        expect(ws.getCell('B4').value).toContain('November 15, 2026');
        expect(ws.getCell('B5').value).toContain('The Best Brew Test1');
    });
});
