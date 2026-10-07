/**
 * PICKUP-TRACKER-XLSX-READABILITY-1 — fictional data for the Pickup Sheet workbook.
 *
 * Pure data, no imports, so the regression test and the artifact generator build the
 * very same workbook. Everything here is invented: *.invalid addresses, 555 phone
 * numbers, "Example County". Eighteen supporters (an even count, so the last order row
 * is a shaded one), three bundles, several blank bundle quantities (the cells an
 * `eachCell()` loop skips), two very long names, and a mix of paid and not-marked.
 */
export const SHEET_CAMPAIGN = {
    id: 'camp-xlsx-fixture', name: 'Example County Farm Bureau Fall Fundraiser', status: 'Closed',
    closed_at: new Date('2026-10-01T00:24:45Z'), customer_id: 'org-xlsx-fixture',
    bundle_selection_status: 'selected', bundle_selection_limit: 3, end_date: new Date('2026-09-30T00:00:00Z'),
    customer: { name: 'Example County Farm Bureau', contact_name: 'Pat', business_id: 'biz-xlsx-fixture' },
};

export const SHEET_BUNDLES = {
    family: { id: 'bundle-family', name: 'Q1 - Comfort Foods (Serves a Family of 4)' },
    paleo: { id: 'bundle-paleo', name: 'Q2 - Clean Eating/Paleo (Serves 2)' },
    keto: { id: 'bundle-keto', name: 'Q3 - Keto Favorites With A Deliberately Long Bundle Name (Serves 2)' },
};

const LONG_A = 'Bartholomew Featherstonehaugh-Montgomery III and Family';
const LONG_B = 'The Honorable Wilhelmina Alexandria Cunningham-Pennington';

/** [name, familyQty, paleoQty, ketoQty, paid, total, tax] — 0 means "not on this order". */
const ROWS: Array<[string, number, number, number, boolean, number, number]> = [
    ['Avery Example', 1, 0, 0, true, 125, 0],
    ['Blake Sample', 0, 2, 0, false, 190, 0],
    [LONG_A, 2, 1, 0, true, 310, 12.4],
    ['Casey Testperson', 0, 0, 1, false, 95, 0],
    ['Drew Placeholder', 1, 1, 1, true, 345, 0],
    ['Emery Fictional', 3, 0, 0, false, 375, 0],
    ['Finley Demo', 0, 1, 0, true, 95, 0],
    [LONG_B, 1, 0, 2, false, 315, 0],
    ['Gray Mockup', 0, 0, 2, true, 190, 7.6],
    ['Harper Specimen', 1, 0, 0, false, 125, 0],
    ['Indigo Dummy', 0, 3, 0, true, 285, 0],
    ['Jules Notreal', 2, 0, 0, false, 250, 0],
    ['Kai Samplesmith', 0, 1, 1, true, 190, 0],
    ['Logan Testcase', 1, 1, 0, false, 220, 0],
    ['Morgan Exemplar', 0, 0, 1, true, 95, 0],
    ['Noel Madeup', 1, 0, 1, false, 220, 0],
    ['Oakley Pretend', 0, 2, 0, true, 190, 0],
    ['Parker Imaginary', 4, 0, 0, false, 500, 20],
];

export const SHEET_SUPPORTER_COUNT = ROWS.length;

export function sheetOrders(): any[] {
    const line = (b: { id: string; name: string }, qty: number) => ({
        quantity: qty, variant_size: 'serves_5', item_name: b.name, bundle_id: b.id, bundle: { id: b.id, name: b.name },
    });
    return ROWS.map(([name, fam, paleo, keto, paid, total, tax], i) => {
        const items = [
            fam ? line(SHEET_BUNDLES.family, fam) : null,
            paleo ? line(SHEET_BUNDLES.paleo, paleo) : null,
            keto ? line(SHEET_BUNDLES.keto, keto) : null,
        ].filter(Boolean);
        return {
            id: `ord-xlsx-${i + 1}`, customer_name: name, participant_name: null,
            total_amount: total.toFixed(2), tax_amount: tax.toFixed(2),
            paid_at: paid ? new Date('2026-10-01T15:00:00Z') : null,
            // Strictly increasing, so the route's created_at order is the fixture's order.
            created_at: new Date(Date.UTC(2026, 8, 20, 15, i, 0)),
            canceled_at: null, source: 'fundraiser', status: 'fundraiser_hold',
            phone: `217-555-01${String(i).padStart(2, '0')}`, email: null,
            customer_id: `cust-xlsx-${i + 1}`, customer: { contact_email: `supporter${i + 1}@example.invalid` },
            items,
        };
    });
}
