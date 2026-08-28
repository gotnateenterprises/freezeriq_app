/**
 * FR-TAX-1B — the confirmed taxable base, the tenant Settings control, and the
 * frozen invoice tax contract.
 *
 * THE OWNER'S RULING THIS SUITE ENCODES
 *   supporter-facing gross merchandise sales
 * - organization fundraiser share
 * = taxable selling price from Freezer Chef to the organization
 *
 * Failure modes pinned here:
 *  - the base silently reverting to GROSS (which would over-charge tax by
 *    exactly 1 rate-unit of the organization's share on every campaign)
 *  - a hardcoded 1% creeping back into the closeout or the Settings UI
 *  - closeout reading the tenant's CURRENT default rate, or the organization's
 *    CURRENT status, instead of the campaign's frozen snapshot
 *  - a TAX_EXEMPT campaign being taxed, or a taxable one silently zeroed
 *  - the invoice PDF re-deriving a total that disagrees with the stored
 *    total_amount Square will actually collect
 *  - a legacy campaign with no snapshot being reinterpreted under the new base
 *  - any historical invoice being recalculated or backfilled
 *  - Square payment code appearing in this phase
 */

import {
    CONFIRMED_TAXABLE_BASE,
    resolveTaxableSellingPrice,
    resolveCloseoutTaxRate,
    computeCampaignTax,
    resolveCampaignTaxSnapshot,
    parseTaxRatePercent,
} from '@/lib/fundraiserTax';
import { computeCloseoutFinancials, roundCents } from '@/lib/fundraiserCloseoutMath';
import { DEFAULT_FOOD_TAX_HELPER_TEXT } from '@/components/settings/FundraiserTaxSettings';

const fs = require('fs');
const path = require('path');
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS (matrix 1-4)
// ═══════════════════════════════════════════════════════════════════════════

describe('1-2. the tenant default-rate Settings control', () => {
    const UI = ['components', 'settings', 'FundraiserTaxSettings.tsx'];

    it('1. loads the tenant\'s CURRENT configured rate from the server', () => {
        const src = read(...UI);
        expect(src).toMatch(/fetch\('\/api\/tenant\/tax-settings'/);
        expect(src).toMatch(/setRate\(String\(data\.defaultFoodTaxPercent\)\)/);
    });

    it('2. saving PUTs the value back and re-reads what the server stored', () => {
        const src = read(...UI);
        expect(src).toMatch(/method: 'PUT'/);
        expect(src).toMatch(/defaultFoodTaxPercent: rate/);
        expect(src).toMatch(/setRate\(String\(data\.defaultFoodTaxPercent\)\)/);
    });

    it('is mounted on the real Settings page, so no API call by hand is needed', () => {
        const page = read('app', 'settings', 'page.tsx');
        expect(page).toMatch(/<FundraiserTaxSettings \/>/);
        expect(page).toMatch(/import FundraiserTaxSettings from '@\/components\/settings\/FundraiserTaxSettings'/);
    });

    it('carries the owner\'s helper copy verbatim', () => {
        expect(DEFAULT_FOOD_TAX_HELPER_TEXT).toBe(
            'Used as the default for new taxable fundraiser campaigns. Existing campaigns keep their saved tax rate.'
        );
        expect(read(...UI)).toContain('{DEFAULT_FOOD_TAX_HELPER_TEXT}');
    });

    it('7 (matrix). the Settings UI hardcodes no rate at all', () => {
        const src = stripComments(read(...UI));
        expect(src).not.toMatch(/\b1\.0+\s*%/);
        expect(src).not.toMatch(/FOOD_TAX_RATE_PERCENT/);
        expect(src).not.toMatch(/defaultFoodTaxPercent\s*\|\|\s*1/);
        // The only literal near the input is the empty/loading placeholder.
        expect(src).toMatch(/placeholder=\{loading \? 'Loading…' : '0\.00'\}/);
    });
});

describe('3. cross-tenant update is impossible', () => {
    it('the route derives the business from the session, never from the body', () => {
        const src = stripComments(read('app', 'api', 'tenant', 'tax-settings', 'route.ts'));
        expect(src).toMatch(/const session = await auth\(\)/);
        expect(src).toMatch(/where: \{ id: session\.user\.businessId \}/);
        expect(src).not.toMatch(/body\??\.\s*businessId|body\.business_id/);
    });

    it('both handlers refuse a caller with no tenant session', () => {
        const src = read('app', 'api', 'tenant', 'tax-settings', 'route.ts');
        const handlers = src.split(/export async function /).slice(1);
        expect(handlers.length).toBe(2); // GET + PUT
        for (const h of handlers) {
            expect(h).toMatch(/if \(!session\?\.user\?\.businessId\)/);
            expect(h).toMatch(/status: 401/);
        }
    });

    it('server-side validation is authoritative: 0 allowed, negative/malformed/over-max refused', () => {
        expect(parseTaxRatePercent(0)).toEqual({ ok: true, percent: 0 });
        expect(parseTaxRatePercent('1.25')).toEqual({ ok: true, percent: 1.25 });
        for (const bad of [-0.01, -1, 100.01, 1000, NaN, Infinity, 'abc', '', null, undefined, true, [], {}]) {
            expect(parseTaxRatePercent(bad as unknown).ok).toBe(false);
        }
    });
});

describe('4. changing the tenant default never rewrites an existing campaign snapshot', () => {
    it('the snapshot is a stored value; recomputing later yields a different one', () => {
        const atLaunch = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE', tenantDefaultRatePercent: 1,
        });
        const ifRecomputedAfterRateChange = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE', tenantDefaultRatePercent: 5,
        });
        expect(atLaunch.ratePercent).toBe(1);
        expect(ifRecomputedAfterRateChange.ratePercent).toBe(5);
        // Closeout uses the FROZEN one, so the money does not move.
        expect(resolveCloseoutTaxRate({ taxStatus: 'TAXABLE', taxRatePercent: atLaunch.ratePercent })).toBe(1);
    });

    it('closeout reads the campaign row, never the Business default', () => {
        const src = stripComments(read('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts'));
        expect(src).toMatch(/taxRatePercent: \(campaign as any\)\.tax_rate_percent/);
        expect(src).not.toMatch(/default_food_tax_percent/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// TAX BASE (matrix 5-7)
// ═══════════════════════════════════════════════════════════════════════════

describe('5-7. the confirmed NET taxable base', () => {
    it('5. the confirmed base is NET, recorded in code', () => {
        expect(CONFIRMED_TAXABLE_BASE).toBe('net');
    });

    it('5b. the taxable selling price is gross minus the organization share', () => {
        expect(resolveTaxableSellingPrice({ grossSales: 2065, organizationAmount: 413 })).toBe(1652);
        expect(resolveTaxableSellingPrice({ grossSales: 6420, organizationAmount: 1284 })).toBe(5136);
        expect(resolveTaxableSellingPrice({ grossSales: 1000, organizationAmount: 0 })).toBe(1000);
    });

    it('6. the organization share is REUSED, not reimplemented, so no penny goes missing', () => {
        // resolveTaxableSellingPrice takes the AMOUNT, never a percent to
        // re-multiply — a second independent computation could round to a
        // different cent than closeout's own.
        const src = read('lib', 'fundraiserTax.ts');
        expect(src).toMatch(/organizationAmount: number/);
        const fn = src.slice(src.indexOf('export function resolveTaxableSellingPrice'));
        expect(fn.slice(0, 400)).not.toMatch(/orgSharePercent|\/ 100/);

        // And closeout's own identity still holds exactly.
        for (const [gross, pct] of [[1000.05, 33.33], [2065, 20], [845, 20], [9999.99, 17.5]] as const) {
            const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: pct, applyFoodTax: true, taxRatePercent: 1 });
            expect(roundCents(f.organizationAmount + f.baseRemit)).toBe(roundCents(gross));
            expect(resolveTaxableSellingPrice({ grossSales: gross, organizationAmount: f.organizationAmount }))
                .toBe(f.baseRemit);
        }
    });

    it('7. zero and rounding behave', () => {
        expect(resolveTaxableSellingPrice({ grossSales: 0, organizationAmount: 0 })).toBe(0);
        const f = computeCloseoutFinancials({ grossSales: 0, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(0);
        // 1% of 666.73 = 6.6673 -> 6.67 (half-up at the edge, once).
        expect(computeCloseoutFinancials({ grossSales: 1000.05, orgSharePercent: 33.33, applyFoodTax: true, taxRatePercent: 1 }).taxAmount)
            .toBe(6.67);
    });

    it('the base is NET and demonstrably NOT gross', () => {
        const f = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
        expect(f.taxAmount).toBe(16.52);            // 1% of 1652
        expect(f.taxAmount).not.toBe(20.65);        // 1% of 2065 — the superseded basis
        // The gap is always exactly one rate-unit of the organization's share.
        expect(roundCents(20.65 - f.taxAmount)).toBe(roundCents(413 * 0.01));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXEMPT (matrix 8-9)
// ═══════════════════════════════════════════════════════════════════════════

describe('8-9. tax-exempt behaviour', () => {
    it('8. a TAX_EXEMPT campaign always resolves to a zero rate', () => {
        expect(resolveCloseoutTaxRate({ taxStatus: 'TAX_EXEMPT', taxRatePercent: 0 })).toBe(0);
        const f = computeCloseoutFinancials({
            grossSales: 2065, orgSharePercent: 20, applyFoodTax: true,
            taxRatePercent: resolveCloseoutTaxRate({ taxStatus: 'TAX_EXEMPT', taxRatePercent: 0 }),
        });
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(1652);
    });

    it('9. a nonzero stored rate CANNOT override TAX_EXEMPT status', () => {
        // Defence in depth: a bad backfill or hand-edited row that carries both
        // TAX_EXEMPT and a rate must still charge nothing. Status wins.
        expect(resolveCloseoutTaxRate({ taxStatus: 'TAX_EXEMPT', taxRatePercent: 5 })).toBe(0);
        expect(computeCampaignTax({ snapshot: { status: 'TAX_EXEMPT', ratePercent: 5 } as any, taxableBase: 1652 }).taxAmount)
            .toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// TAXABLE (matrix 10-12)
// ═══════════════════════════════════════════════════════════════════════════

describe('10-12. a taxable campaign uses its own frozen snapshot', () => {
    it('10. the frozen rate is what gets charged', () => {
        expect(resolveCloseoutTaxRate({ taxStatus: 'TAXABLE', taxRatePercent: 2.5 })).toBe(2.5);
        const f = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 2.5 });
        expect(f.taxAmount).toBe(41.30);            // 2.5% of 1652
        expect(f.totalDue).toBe(1693.30);
    });

    it('11. the tenant\'s CURRENT default is ignored after launch', () => {
        // Two campaigns, same gross, different frozen rates: the money differs,
        // proving nothing re-reads a single live tenant value.
        const a = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
        const b = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 3 });
        expect(a.taxAmount).toBe(16.52);
        expect(b.taxAmount).toBe(49.56);
    });

    it('12. the organization\'s CURRENT status is ignored after launch', () => {
        // The campaign row carries its own status; closeout reads that, so an
        // organization later flipped to TAX_EXEMPT cannot zero a live campaign.
        expect(resolveCloseoutTaxRate({ taxStatus: 'TAXABLE', taxRatePercent: 1 })).toBe(1);
        const src = stripComments(read('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts'));
        expect(src).toMatch(/taxStatus: \(campaign as any\)\.tax_status/);
        expect(src).not.toMatch(/customer\.tax_status/);
    });

    it('the owner switch can only ever turn tax OFF, never invent a rate', () => {
        const off = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: false, taxRatePercent: 5 });
        expect(off.taxApplied).toBe(false);
        expect(off.taxAmount).toBe(0);
        const noRate = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true });
        expect(noRate.taxAmount).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVOICE (matrix 13-18)
// ═══════════════════════════════════════════════════════════════════════════

describe('13-16. the frozen invoice contract', () => {
    it('13. amount due = taxable selling price + tax', () => {
        const f = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
        expect(f.totalDue).toBe(roundCents(f.baseRemit + f.taxAmount));
        expect(f.totalDue).toBe(1668.52);
    });

    it('14. the organization share is unchanged by the tax-base move', () => {
        for (const gross of [2065, 6420, 845, 1220]) {
            const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
            expect(f.organizationAmount).toBe(roundCents(gross * 0.20));
        }
    });

    it('15-16. the whole tax contract is FROZEN onto the invoice row', () => {
        const src = stripComments(read('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts'));
        expect(src).toMatch(/tax_rate_percent: financials\.taxRatePercent/);
        expect(src).toMatch(/tax_status: \(\(campaign as any\)\.tax_status \?\? null\)/);
        expect(src).toMatch(/taxable_base_amount: financials\.baseRemit/);

        // Frozen columns exist and are nullable, so pre-FR-TAX-1B invoices keep
        // NULL rather than an invented value.
        const schema = read('prisma', 'schema.prisma');
        expect(schema).toMatch(/tax_rate_percent\s+Decimal\?\s+@db\.Decimal\(5, 2\)/);
        expect(schema).toMatch(/taxable_base_amount\s+Decimal\?\s+@db\.Decimal\(10, 2\)/);
    });

    it('the PDF prints the FROZEN total, so Square and the document cannot disagree', () => {
        const src = read('app', 'invoices', 'page.tsx');
        expect(src).toMatch(/const calculatedBalance = invoice\.total_amount != null/);
        expect(src).toContain('Taxable Selling Price:');
    });
});

describe('17. historical invoices are never rewritten', () => {
    it('the migration adds columns without backfilling any of them', () => {
        const sql = read('prisma', 'migrations', '20260828140000_fr_tax_1b_invoice_tax_snapshot', 'migration.sql');
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "tax_rate_percent"/);
        expect(sql).not.toMatch(/\bUPDATE\b/i);
        expect(sql).not.toMatch(/\bINSERT\b/i);
    });

    it('nothing anywhere recomputes an existing invoice\'s money', () => {
        const closeout = stripComments(read('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts'));
        // The only invoice write is the CREATE; the P2002 path re-reads rather
        // than updating, so a second closeout cannot re-price a settled invoice.
        expect(closeout).not.toMatch(/invoice\.update|invoice\.updateMany/);

        // Settlement records that money arrived; it must never re-price the
        // document. Asserted on the WRITE payloads specifically — the route
        // legitimately SELECTs total_amount to display it.
        const settle = stripComments(read('app', 'api', 'tenant', 'invoices', '[id]', 'settle', 'route.ts'));
        const writes = settle.split(/data:\s*\{/).slice(1).map((s: string) => s.split('}')[0]);
        expect(writes.length).toBeGreaterThan(0);
        for (const w of writes) {
            expect(w).not.toMatch(/total_amount|tax_amount|taxable_base_amount|tax_rate_percent|fundraiser_profit/);
        }
    });

    it('a legacy campaign with NO snapshot is charged nothing, not reinterpreted', () => {
        expect(resolveCloseoutTaxRate({ taxStatus: null, taxRatePercent: null })).toBe(0);
        expect(resolveCloseoutTaxRate({ taxStatus: undefined, taxRatePercent: 1 })).toBe(0);
        const f = computeCloseoutFinancials({
            grossSales: 2065, orgSharePercent: 20, applyFoodTax: true,
            taxRatePercent: resolveCloseoutTaxRate({ taxStatus: null, taxRatePercent: null }),
        });
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(1652);
    });
});

describe('18. no Square payment implementation was introduced', () => {
    it('no FR-TAX-1B file references Square, payment links, or checkout', () => {
        for (const f of [
            ['lib', 'fundraiserTax.ts'],
            ['lib', 'fundraiserCloseoutMath.ts'],
            ['components', 'settings', 'FundraiserTaxSettings.tsx'],
            ['app', 'api', 'tenant', 'tax-settings', 'route.ts'],
            ['app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts'],
        ]) {
            const src = stripComments(read(...f)).toLowerCase();
            expect(src).not.toMatch(/square|payment_link|paymentlink|createpayment/);
        }
    });

    it('settlement remains a manual human attestation', () => {
        const settle = read('app', 'api', 'tenant', 'invoices', '[id]', 'settle', 'route.ts');
        expect(settle).not.toMatch(/fundraiserTax|computeCampaignTax|resolveCloseoutTaxRate/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRACKER (Part K)
// ═══════════════════════════════════════════════════════════════════════════

describe('Part K. the coordinator tracker stays a truthful SUPPORTER tally', () => {
    it('no organization-level tax was added to supporter lines', () => {
        const src = read('lib', 'coordinatorOrderTracker.ts');
        expect(src).not.toMatch(/taxRate|tax_rate_percent|computeCampaignTax/);
    });

    it('"Total Cost (No Tax)" remains truthful, because this sheet has no organization total', () => {
        // The label describes a PER-SUPPORTER row, and supporters are still
        // never taxed. It would only mislead if this workbook also presented an
        // organization settlement total — it does not. Asserted structurally
        // rather than trusting the wording: the sheet writes purchaser-level
        // columns only, and no amount-due / balance / settlement figure.
        const src = read('lib', 'coordinatorOrderTracker.ts');
        expect(src).toContain('Total Cost (No Tax)');
        const written = stripComments(src);
        expect(written).not.toMatch(/amount ?due|balance due|settlement|invoice total/i);
    });

    it('FR-COORD-ORDER-TRACKER-1\'s bundle-family work is untouched', () => {
        const src = read('lib', 'coordinatorOrderTracker.ts');
        expect(src).toMatch(/buildTrackerFamilies/);
        expect(src).toMatch(/resolveMaterialBundles/);
    });
});
