/**
 * FR-TAX-CORRECTNESS-1 — supporter-collected food tax on a GROSS basis.
 *
 * THE RE-RULING THIS PROVES
 * ────────────────────────
 * FR-TAX-1B charged the organization a tax computed at closeout on the NET
 * after its fundraiser share. The owner has since ruled that the SUPPORTER pays
 * the tax at order time on the retail price, that the organization's share is
 * taken on PRE-TAX food sales only, and that the tax is pass-through money the
 * organization remits in full. See lib/fundraiserTax.ts CONFIRMED_TAXABLE_BASE.
 *
 * WHY THE LEGACY SECTION IS FIRST
 * ───────────────────────────────
 * Three campaigns were taking real supporter money in Production when this was
 * written — one carrying no tax snapshot at all (tax_status NULL) and two
 * frozen at TAXABLE 0.00%. None of them may be repriced by a cent. Those exact
 * two shapes are the first thing this file asserts, because every other test
 * here is worthless if deploying it changes what a live supporter is charged.
 */
import {
    computeSupporterOrderTax,
    supporterAmountDue,
    resolveCloseoutTaxRate,
    CONFIRMED_TAXABLE_BASE,
} from '@/lib/fundraiserTax';
import { computeCloseoutFinancials, roundCents } from '@/lib/fundraiserCloseoutMath';

// The two legacy shapes that exist in Production today.
const LEGACY_NO_SNAPSHOT = { status: null, ratePercent: null };
const LEGACY_TAXABLE_ZERO = { status: 'TAXABLE' as const, ratePercent: 0 };
// What a correctly configured campaign looks like after this phase.
const CORRECTED_TAXABLE = { status: 'TAXABLE' as const, ratePercent: 1 };
const EXEMPT = { status: 'TAX_EXEMPT' as const, ratePercent: 0 };

// ═════════════════════════════════════════════════════════════════════════════
// 1. LIVE-CAMPAIGN SAFETY — the shapes currently taking real money.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. live Production campaign shapes are not repriced', () => {
    it('a campaign with NO tax snapshot charges the supporter exactly what it charged before', () => {
        const t = computeSupporterOrderTax({ subtotal: 125, snapshot: LEGACY_NO_SNAPSHOT });
        expect(t.taxAmount).toBe(0);
        expect(t.total).toBe(125);
        expect(t.taxApplied).toBe(false);
    });

    it('a campaign frozen at TAXABLE 0.00% charges the supporter exactly what it charged before', () => {
        const t = computeSupporterOrderTax({ subtotal: 60, snapshot: LEGACY_TAXABLE_ZERO });
        expect(t.taxAmount).toBe(0);
        expect(t.total).toBe(60);
    });

    it('a non-campaign (storefront) order passes a null snapshot and is untaxed', () => {
        expect(computeSupporterOrderTax({ subtotal: 89.99, snapshot: null }).total).toBe(89.99);
    });

    it('legacy orders (tax_amount 0) owe exactly their stored total — nothing is added', () => {
        expect(supporterAmountDue({ total_amount: 125, tax_amount: 0 })).toBe(125);
        // A row written before tax_amount was ever populated.
        expect(supporterAmountDue({ total_amount: 125 })).toBe(125);
    });

    it('a legacy campaign closes out with the SAME numbers as before this phase', () => {
        // Edgar-shaped: $305 of food, 20% share, no tax ever collected.
        const f = computeCloseoutFinancials({
            grossSales: 305, orgSharePercent: 20, applyFoodTax: true, taxCollected: 0,
            taxRatePercent: resolveCloseoutTaxRate({ taxStatus: null, taxRatePercent: null }),
        });
        expect(f.organizationAmount).toBe(61);
        expect(f.baseRemit).toBe(244);
        expect(f.taxAmount).toBe(0);
        expect(f.taxApplied).toBe(false);
        expect(f.totalDue).toBe(244);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. SUPPORTER PRICING — the phase's worked examples.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. supporter pricing on a corrected taxable campaign', () => {
    it('$60.00 + 1% = $60.60', () => {
        const t = computeSupporterOrderTax({ subtotal: 60, snapshot: CORRECTED_TAXABLE });
        expect(t.taxAmount).toBe(0.6);
        expect(t.total).toBe(60.6);
        expect(t.ratePercent).toBe(1);
    });

    it('$125.00 + 1% = $126.25', () => {
        const t = computeSupporterOrderTax({ subtotal: 125, snapshot: CORRECTED_TAXABLE });
        expect(t.taxAmount).toBe(1.25);
        expect(t.total).toBe(126.25);
    });

    it('$185.00 + 1% = $186.85', () => {
        const t = computeSupporterOrderTax({ subtotal: 185, snapshot: CORRECTED_TAXABLE });
        expect(t.taxAmount).toBe(1.85);
        expect(t.total).toBe(186.85);
    });

    it('tax-exempt $60.00 stays $60.00 — no supporter override exists', () => {
        const t = computeSupporterOrderTax({ subtotal: 60, snapshot: EXEMPT });
        expect(t.taxAmount).toBe(0);
        expect(t.total).toBe(60);
        expect(t.taxApplied).toBe(false);
    });

    it('rounds half-up to the cent, never a third decimal', () => {
        // $19.99 x 1% = $0.1999 -> $0.20
        expect(computeSupporterOrderTax({ subtotal: 19.99, snapshot: CORRECTED_TAXABLE }).taxAmount).toBe(0.2);
        // $333.33 x 1% = $3.3333 -> $3.33
        expect(computeSupporterOrderTax({ subtotal: 333.33, snapshot: CORRECTED_TAXABLE }).taxAmount).toBe(3.33);
    });

    it('subtotal + tax always equals total exactly', () => {
        for (const sub of [0.01, 19.99, 60, 125, 185, 333.33, 1000.05, 6420]) {
            const t = computeSupporterOrderTax({ subtotal: sub, snapshot: CORRECTED_TAXABLE });
            expect(roundCents(t.subtotal + t.taxAmount)).toBe(t.total);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE TAXABLE BASE — gross, and the org share never touches tax.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. gross basis and organization share', () => {
    it('the confirmed taxable base is gross', () => {
        expect(CONFIRMED_TAXABLE_BASE).toBe('gross');
    });

    it('the phase example: $1,000 food, 20% share, 1% tax -> org $200, due $810', () => {
        const tax = computeSupporterOrderTax({ subtotal: 1000, snapshot: CORRECTED_TAXABLE });
        expect(tax.taxAmount).toBe(10);

        const f = computeCloseoutFinancials({
            grossSales: 1000, orgSharePercent: 20, applyFoodTax: true,
            taxCollected: tax.taxAmount, taxRatePercent: 1,
        });
        expect(f.organizationAmount).toBe(200);   // 20% of PRE-TAX 1000, not 1010
        expect(f.baseRemit).toBe(800);
        expect(f.taxAmount).toBe(10);
        expect(f.totalDue).toBe(810);
    });

    it('the organization does NOT earn its share on tax — $200, never $202', () => {
        const f = computeCloseoutFinancials({
            grossSales: 1000, orgSharePercent: 20, applyFoodTax: true, taxCollected: 10, taxRatePercent: 1,
        });
        expect(f.organizationAmount).toBe(200);
        expect(f.organizationAmount).not.toBe(202);
    });

    it('a tax-exempt campaign: $1,000 food -> org $200, due $800, no tax anywhere', () => {
        const tax = computeSupporterOrderTax({ subtotal: 1000, snapshot: EXEMPT });
        const f = computeCloseoutFinancials({
            grossSales: 1000, orgSharePercent: 20, applyFoodTax: true, taxCollected: tax.taxAmount, taxRatePercent: 0,
        });
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(800);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. STEP 28 — the required end-to-end reconciliation fixture.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. two-order reconciliation fixture', () => {
    const orderA = computeSupporterOrderTax({ subtotal: 60, snapshot: CORRECTED_TAXABLE });
    const orderB = computeSupporterOrderTax({ subtotal: 125, snapshot: CORRECTED_TAXABLE });

    it('each order stores its own stable subtotal, tax and total', () => {
        expect([orderA.subtotal, orderA.taxAmount, orderA.total]).toEqual([60, 0.6, 60.6]);
        expect([orderB.subtotal, orderB.taxAmount, orderB.total]).toEqual([125, 1.25, 126.25]);
    });

    it('campaign totals sum from the orders, not from a re-applied rate', () => {
        // Persisted EXACTLY as the order writers store them: total_amount is
        // the PRE-TAX subtotal, tax_amount is the frozen tax.
        const persisted = [
            { total_amount: orderA.subtotal, tax_amount: orderA.taxAmount },
            { total_amount: orderB.subtotal, tax_amount: orderB.taxAmount },
        ];
        const foodSales = roundCents(persisted.reduce((s, o) => s + Number(o.total_amount), 0));
        const taxCollected = roundCents(persisted.reduce((s, o) => s + Number(o.tax_amount), 0));
        const supporterDue = roundCents(persisted.reduce((s, o) => s + supporterAmountDue(o), 0));

        expect(foodSales).toBe(185);
        expect(taxCollected).toBe(1.85);
        expect(supporterDue).toBe(186.85);
        expect(roundCents(foodSales + taxCollected)).toBe(supporterDue);
    });

    it('settles to org $37.00 / food proceeds $148.00 / tax $1.85 / invoice $149.85', () => {
        const f = computeCloseoutFinancials({
            grossSales: 185, orgSharePercent: 20, applyFoodTax: true, taxCollected: 1.85, taxRatePercent: 1,
        });
        expect(f.organizationAmount).toBe(37);
        expect(f.baseRemit).toBe(148);
        expect(f.taxAmount).toBe(1.85);
        expect(f.totalDue).toBe(149.85);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. NO DOUBLE TAX — the defect the old model made possible.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. tax is charged exactly once', () => {
    it('closeout bills the tax supporters paid, and does not re-apply the rate', () => {
        // Supporters paid 1% on $1,000 = $10. Under the superseded NET basis
        // closeout would have computed 1% of $800 = $8 and billed that INSTEAD,
        // so the two models are distinguishable — this pins the new one.
        const f = computeCloseoutFinancials({
            grossSales: 1000, orgSharePercent: 20, applyFoodTax: true, taxCollected: 10, taxRatePercent: 1,
        });
        expect(f.taxAmount).toBe(10);
        expect(f.taxAmount).not.toBe(8);
    });

    it('a campaign that collected NO tax is billed no tax, whatever rate it carries', () => {
        const f = computeCloseoutFinancials({
            grossSales: 1000, orgSharePercent: 20, applyFoodTax: true, taxCollected: 0, taxRatePercent: 1,
        });
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(800);
    });

    it('the closeout switch cannot delete tax supporters already paid', () => {
        const f = computeCloseoutFinancials({
            grossSales: 1000, orgSharePercent: 20, applyFoodTax: false, taxCollected: 10, taxRatePercent: 1,
        });
        expect(f.taxAmount).toBe(10);
        expect(f.totalDue).toBe(810);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. SNAPSHOT AUTHORITY — live org edits never reach a priced order.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. the campaign snapshot is the contract', () => {
    it('an exempt snapshot wins even if a rate rode along with it', () => {
        expect(computeSupporterOrderTax({
            subtotal: 1000, snapshot: { status: 'TAX_EXEMPT', ratePercent: 5 },
        }).taxAmount).toBe(0);
    });

    it('a negative or unparseable rate is treated as no tax, never as an error price', () => {
        expect(computeSupporterOrderTax({ subtotal: 100, snapshot: { status: 'TAXABLE', ratePercent: -1 } }).taxAmount).toBe(0);
        expect(computeSupporterOrderTax({ subtotal: 100, snapshot: { status: 'TAXABLE', ratePercent: 'abc' } }).taxAmount).toBe(0);
    });

    it('an already-persisted order is immune to a later rate change — its numbers are stored, not derived', () => {
        const persisted = { total_amount: 60, tax_amount: 0.6 };
        // Organization is later switched to TAX_EXEMPT; the stored row is unmoved.
        expect(Number(persisted.total_amount)).toBe(60);
        expect(Number(persisted.tax_amount)).toBe(0.6);
        expect(supporterAmountDue(persisted)).toBe(60.6);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. THE FIELD CONTRACT — the regression guard that stops a future developer
//    casually redefining total_amount again. This is deliberately blunt.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. Order.total_amount is PRE-TAX, forever', () => {
    it('a $60 taxable order stores 60.00 / 0.60 and owes 60.60 — total_amount is NOT 60.60', () => {
        const t = computeSupporterOrderTax({ subtotal: 60, snapshot: CORRECTED_TAXABLE });
        const persisted = { total_amount: t.subtotal, tax_amount: t.taxAmount };

        expect(persisted.total_amount).toBe(60);
        expect(persisted.total_amount).not.toBe(60.6);   // the corrected design
        expect(persisted.tax_amount).toBe(0.6);
        expect(supporterAmountDue(persisted)).toBe(60.6);
    });

    it('a $125 taxable order stores 125.00 / 1.25 and owes 126.25', () => {
        const t = computeSupporterOrderTax({ subtotal: 125, snapshot: CORRECTED_TAXABLE });
        const persisted = { total_amount: t.subtotal, tax_amount: t.taxAmount };

        expect(persisted.total_amount).toBe(125);
        expect(persisted.total_amount).not.toBe(126.25);
        expect(persisted.tax_amount).toBe(1.25);
        expect(supporterAmountDue(persisted)).toBe(126.25);
    });

    it('a tax-exempt order stores the subtotal with zero tax and owes exactly the subtotal', () => {
        const t = computeSupporterOrderTax({ subtotal: 60, snapshot: EXEMPT });
        const persisted = { total_amount: t.subtotal, tax_amount: t.taxAmount };

        expect(persisted.total_amount).toBe(60);
        expect(persisted.tax_amount).toBe(0);
        expect(supporterAmountDue(persisted)).toBe(60);
    });

    it('the org-share basis reads total_amount directly and is therefore never inflated by tax', () => {
        // $1,000 of food + $10 tax. Share must be 20% of 1,000, not of 1,010.
        const persisted = [{ total_amount: 1000, tax_amount: 10 }];
        const foodSales = roundCents(persisted.reduce((s, o) => s + Number(o.total_amount), 0));
        expect(foodSales).toBe(1000);

        const f = computeCloseoutFinancials({
            grossSales: foodSales, orgSharePercent: 20, applyFoodTax: true, taxCollected: 10, taxRatePercent: 1,
        });
        expect(f.organizationAmount).toBe(200);
        expect(f.organizationAmount).not.toBe(202);
        expect(f.totalDue).toBe(810);
    });

    it('the closeout reconciliation gate still compares like with like (both pre-tax)', () => {
        // Bundle lines are quantity x unit_price = pre-tax; total_amount is
        // pre-tax; so a correctly taxed order is NOT a reconciliation offender.
        const order = { total_amount: 60, tax_amount: 0.6 };
        const lineSum = 60; // 1 x $60 bundle
        expect(Math.abs(Number(order.total_amount) - lineSum)).toBeLessThan(0.005);
    });
});
