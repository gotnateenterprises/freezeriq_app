/**
 * INV-B — the fundraiser closeout financial model.
 *
 * Every number here is checked against real Production data or the owner's own
 * worked example, so a regression shows up as a wrong dollar figure rather than
 * an abstract assertion failure.
 *
 * The food tax is the reason this suite exists in the shape it does. Five
 * historical invoices settled at 81% of gross against a 20% share, which looks
 * like a 101% error until you read `invoices.tax_amount` — where the exact 1%
 * was recorded all along. These tests pin BOTH halves: the share math must never
 * drift to 81%, and the tax must remain its own visible fact.
 *
 * FR-TAX-1B moved the TAX BASE. On the owner's confirmed ruling the taxable
 * selling price is the NET after the organization's share, and the rate now
 * arrives as an input from the campaign's frozen snapshot instead of a product
 * constant. The five historical invoices are consequently no longer reproduced
 * by this function — and are deliberately never recalculated.
 */

import {
    aggregateBundleLines,
    assertLinesReconcile,
    computeCloseoutFinancials,
    CloseoutReconciliationError,
    sumLineTotals,
    roundCents,
    FOOD_TAX_RATE_PERCENT,
    FOOD_TAX_DEFAULT_APPLIED,
} from '@/lib/fundraiserCloseoutMath';

/** Edgar County Farm Bureau, exactly as it exists in Production. */
const EDGAR = [
    { bundleId: 'b-comfort', description: 'Q2 - Comfort Foods (Serves 2)', variantSize: 'serves_2', quantity: 17, unitPrice: 60 },
    { bundleId: 'b-hearty', description: 'Q1 - Hearty Meals (Serves 2)', variantSize: 'serves_2', quantity: 7, unitPrice: 60 },
    { bundleId: 'b-hearty5', description: 'Q1 - Hearty Meals', variantSize: 'serves_5', quantity: 3, unitPrice: 125 },
    { bundleId: 'b-comfort5', description: 'Q2 - Comfort Foods', variantSize: 'serves_5', quantity: 2, unitPrice: 125 },
];

describe('bundle aggregation', () => {
    it('collapses many supporter orders into one line per bundle + serving size', () => {
        // Six separate supporter orders of the same two products.
        const items = [
            { bundleId: 'b1', description: 'Hearty Meals', variantSize: 'serves_5', quantity: 1, unitPrice: 125 },
            { bundleId: 'b1', description: 'Hearty Meals', variantSize: 'serves_5', quantity: 2, unitPrice: 125 },
            { bundleId: 'b2', description: 'Hearty Meals (Serves 2)', variantSize: 'serves_2', quantity: 3, unitPrice: 60 },
            { bundleId: 'b2', description: 'Hearty Meals (Serves 2)', variantSize: 'serves_2', quantity: 4, unitPrice: 60 },
        ];
        const lines = aggregateBundleLines(items);

        expect(lines).toHaveLength(2);
        const s5 = lines.find((l) => l.variantSize === 'serves_5')!;
        const s2 = lines.find((l) => l.variantSize === 'serves_2')!;
        expect(s5).toMatchObject({ quantity: 3, unitPrice: 125, total: 375 });
        expect(s2).toMatchObject({ quantity: 7, unitPrice: 60, total: 420 });
    });

    it('keeps serves_5 and serves_2 of the SAME bundle as separate lines', () => {
        const lines = aggregateBundleLines([
            { bundleId: 'same', description: 'Comfort Foods', variantSize: 'serves_5', quantity: 2, unitPrice: 125 },
            { bundleId: 'same', description: 'Comfort Foods', variantSize: 'serves_2', quantity: 6, unitPrice: 60 },
        ]);
        expect(lines).toHaveLength(2);
        expect(lines.map((l) => l.variantSize).sort()).toEqual(['serves_2', 'serves_5']);
    });

    it('does NOT emit one line per supporter order', () => {
        const many = Array.from({ length: 26 }, () => ({
            bundleId: 'b1', description: 'Hearty Meals', variantSize: 'serves_5', quantity: 1, unitPrice: 125,
        }));
        const lines = aggregateBundleLines(many);
        expect(lines).toHaveLength(1);
        expect(lines[0].quantity).toBe(26);
        expect(lines[0].total).toBe(3250);
    });

    it('reproduces the real Edgar campaign exactly', () => {
        const lines = aggregateBundleLines(EDGAR);
        expect(lines.map((l) => [l.description, l.quantity, l.total])).toEqual([
            ['Q2 - Comfort Foods (Serves 2)', 17, 1020],
            ['Q1 - Hearty Meals (Serves 2)', 7, 420],
            ['Q1 - Hearty Meals', 3, 375],
            ['Q2 - Comfort Foods', 2, 250],
        ]);
        expect(sumLineTotals(lines)).toBe(2065);
    });

    it('does not average away two different prices for the same product', () => {
        // A price change mid-campaign must not invent a unit price nobody paid.
        const lines = aggregateBundleLines([
            { bundleId: 'b1', description: 'Hearty', variantSize: 'serves_5', quantity: 2, unitPrice: 125 },
            { bundleId: 'b1', description: 'Hearty', variantSize: 'serves_5', quantity: 2, unitPrice: 130 },
        ]);
        expect(lines).toHaveLength(2);
        expect(sumLineTotals(lines)).toBe(510);
    });

    it('ignores zero and negative quantities', () => {
        const lines = aggregateBundleLines([
            { bundleId: 'b1', description: 'X', variantSize: 'serves_5', quantity: 0, unitPrice: 125 },
            { bundleId: 'b2', description: 'Y', variantSize: 'serves_5', quantity: -3, unitPrice: 125 },
        ]);
        expect(lines).toHaveLength(0);
    });
});

describe('organization share and remit', () => {
    it('the owner worked example: $2,065 at 20% with tax ON', () => {
        // FR-TAX-1B: the taxable base is now the NET after the organization's
        // share, per the owner's confirmed ruling, and the rate arrives from
        // the campaign's frozen snapshot rather than a product constant.
        // 1% of $1,652 = $16.52 — NOT the $20.65 the superseded gross basis
        // produced.
        const f = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
        expect(f.organizationAmount).toBe(413);
        expect(f.baseRemit).toBe(1652);
        expect(f.taxRatePercent).toBe(1);
        expect(f.taxAmount).toBe(16.52);
        expect(f.totalDue).toBe(1668.52);
    });

    it('no rate means no tax, even with the owner switch ON', () => {
        // A campaign that carries no FR-TAX-1 snapshot reaches here with no
        // rate. Charging nothing is the deliberate legacy rule — see
        // resolveCloseoutTaxRate — never a fabricated default.
        const f = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: true });
        expect(f.taxApplied).toBe(false);
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(1652);
    });

    it('the same campaign with tax OFF', () => {
        const f = computeCloseoutFinancials({ grossSales: 2065, orgSharePercent: 20, applyFoodTax: false });
        expect(f.organizationAmount).toBe(413);
        expect(f.baseRemit).toBe(1652);
        expect(f.taxApplied).toBe(false);
        expect(f.taxRatePercent).toBe(0);
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(1652);
    });

    it('THE OLD 81% BUG IS NOT PROPAGATED: share and remit sum to exactly gross', () => {
        // The historical shape was org 20% + remit 81% = 101% of gross. The new
        // model must always total exactly 100% BEFORE tax, with tax added on top
        // as its own visible amount.
        for (const gross of [2065, 1410, 4785, 845, 6420, 12345.67]) {
            const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
            expect(roundCents(f.organizationAmount + f.baseRemit)).toBe(roundCents(gross));
            expect(f.baseRemit).not.toBe(roundCents(gross * 0.81));
            expect(f.totalDue).toBe(roundCents(f.baseRemit + f.taxAmount));
        }
        // A single penny is deliberately excluded above: at $0.01 the 80% and 81%
        // shapes both round to $0.01, so that value cannot distinguish them and
        // asserting it would only look like coverage.
        const penny = computeCloseoutFinancials({ grossSales: 0.01, orgSharePercent: 20, applyFoodTax: true });
        expect(roundCents(penny.organizationAmount + penny.baseRemit)).toBe(0.01);
    });

    it('honours a NON-20% campaign share', () => {
        const f = computeCloseoutFinancials({ grossSales: 1000, orgSharePercent: 35, applyFoodTax: false });
        expect(f.organizationAmount).toBe(350);
        expect(f.baseRemit).toBe(650);
        expect(f.totalDue).toBe(650);
    });

    it('handles 0% and 100% shares without losing a cent', () => {
        const zero = computeCloseoutFinancials({ grossSales: 500, orgSharePercent: 0, applyFoodTax: false });
        expect(zero.organizationAmount).toBe(0);
        expect(zero.baseRemit).toBe(500);

        const all = computeCloseoutFinancials({ grossSales: 500, orgSharePercent: 100, applyFoodTax: false });
        expect(all.organizationAmount).toBe(500);
        expect(all.baseRemit).toBe(0);
    });

    it('rounds to cents and still balances on an awkward share', () => {
        // 33.33% of 1000.05 is 333.3167 -> 333.32, remit must absorb the rest.
        const f = computeCloseoutFinancials({ grossSales: 1000.05, orgSharePercent: 33.33, applyFoodTax: true, taxRatePercent: 1 });
        expect(f.organizationAmount).toBe(333.32);
        expect(f.baseRemit).toBe(666.73);
        expect(roundCents(f.organizationAmount + f.baseRemit)).toBe(1000.05);
        // FR-TAX-1B: 1% of the NET 666.73 = 6.6673 -> 6.67.
        expect(f.taxAmount).toBe(6.67);
        expect(f.totalDue).toBe(673.40);
    });

    it('FR-TAX-1B: the five historical invoices are NOT reproduced, and are never recalculated', () => {
        // Those invoices were computed on GROSS x 1%, the basis the owner has
        // since superseded. This function no longer reproduces them BY DESIGN.
        // They remain in Production untouched as historical records of what was
        // actually billed and settled — nothing backfills or recomputes them.
        const historical: Array<[number, number, number]> = [
            [6420, 1284, 5200.20],
            [845, 169, 684.45],
            [870, 174, 704.70],
            [860, 172, 696.60],
            [1220, 244, 988.20],
        ];
        for (const [gross, org, oldTotal] of historical) {
            const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });
            // The organization's share is unchanged — only the tax base moved.
            expect(f.organizationAmount).toBe(org);
            // Tax is now 1% of NET, so the new total is strictly lower than the
            // historical one by exactly 1% of the organization's share.
            expect(f.taxAmount).toBe(roundCents(f.baseRemit * 0.01));
            expect(f.totalDue).toBeLessThan(oldTotal);
            expect(roundCents(oldTotal - f.totalDue)).toBe(roundCents(org * 0.01));
        }
    });

    it('the legacy constant still exists for the historical record, but no longer drives the math', () => {
        expect(FOOD_TAX_RATE_PERCENT).toBe(1);
        expect(FOOD_TAX_DEFAULT_APPLIED).toBe(true);
        // FR-TAX-1B: the rate is now an input. Omitting it charges nothing —
        // the constant cannot leak back in as a silent default.
        const noRate = computeCloseoutFinancials({ grossSales: 1000, orgSharePercent: 20, applyFoodTax: true });
        expect(noRate.taxAmount).toBe(0);
    });
});

describe('the generated invoice agrees with the existing PDF', () => {
    /**
     * app/invoices/page.tsx computes the printed balance itself:
     *     calculatedBalance = itemsSubtotal - profitAmount + taxAmountValue
     * where itemsSubtotal is the sum of the invoice's line totals. INV-B stores
     * `total_amount`. If those two ever disagree, the document a coordinator
     * reads would contradict the number the system thinks is owed — so the
     * agreement is asserted rather than assumed. No PDF redesign is needed
     * precisely because this already holds.
     */
    const pdfBalance = (itemsSubtotal: number, profitAmount: number, taxAmount: number) =>
        roundCents(itemsSubtotal - profitAmount + taxAmount);

    it('the PDF balance equals the stored total due, tax ON', () => {
        const lines = aggregateBundleLines(EDGAR);
        const gross = sumLineTotals(lines);
        const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: 20, applyFoodTax: true, taxRatePercent: 1 });

        expect(pdfBalance(gross, f.organizationAmount, f.taxAmount)).toBe(f.totalDue);
        // FR-TAX-1B: 1% of the NET $1,652 = $16.52 (was $20.65 on gross).
        expect(f.totalDue).toBe(1668.52);
    });

    it('the PDF balance equals the stored total due, tax OFF', () => {
        const lines = aggregateBundleLines(EDGAR);
        const gross = sumLineTotals(lines);
        const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: 20, applyFoodTax: false });

        expect(pdfBalance(gross, f.organizationAmount, f.taxAmount)).toBe(f.totalDue);
        expect(f.totalDue).toBe(1652);
    });

    it('agreement holds across shares and gross values', () => {
        for (const pct of [0, 15, 20, 33.33, 50, 100]) {
            for (const gross of [125, 1410, 2065, 4785, 9999.99]) {
                for (const tax of [true, false]) {
                    const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: pct, applyFoodTax: tax, taxRatePercent: 1 });
                    expect(pdfBalance(gross, f.organizationAmount, f.taxAmount)).toBe(f.totalDue);
                }
            }
        }
    });
});

describe('reconciliation gate', () => {
    it('passes when bundle lines equal the order gross', () => {
        const lines = aggregateBundleLines(EDGAR);
        expect(() => assertLinesReconcile(lines, 2065)).not.toThrow();
    });

    it('FAILS CLOSED when an order has a total but no items', () => {
        // The real Production case: "Brew Campaign 2", $125.00, zero order items.
        expect(() => assertLinesReconcile([], 125, [
            { orderId: 'order-brew-2', orderTotal: 125, lineSum: 0 },
        ])).toThrow(CloseoutReconciliationError);
    });

    it('names the offending order so the data can be repaired', () => {
        try {
            assertLinesReconcile([], 125, [{ orderId: 'order-brew-2', orderTotal: 125, lineSum: 0 }]);
            throw new Error('should have thrown');
        } catch (e: any) {
            expect(e).toBeInstanceOf(CloseoutReconciliationError);
            expect(e.message).toContain('$0.00');
            expect(e.message).toContain('$125.00');
            expect(e.detail).toContain('order-brew-2');
            expect(e.lineSum).toBe(0);
            expect(e.grossSales).toBe(125);
        }
    });

    it('FAILS CLOSED on any mismatch, however small', () => {
        const lines = aggregateBundleLines(EDGAR);
        expect(() => assertLinesReconcile(lines, 2065.01)).toThrow(CloseoutReconciliationError);
        expect(() => assertLinesReconcile(lines, 2064.99)).toThrow(CloseoutReconciliationError);
    });

    it('does not invent a balancing line to paper over a gap', () => {
        const lines = aggregateBundleLines(EDGAR);
        expect(() => assertLinesReconcile(lines, 2190)).toThrow();
        // The lines are untouched by the failed check — no $125 "adjustment".
        expect(lines).toHaveLength(4);
        expect(sumLineTotals(lines)).toBe(2065);
    });

    it('a campaign that sold nothing reconciles trivially', () => {
        expect(() => assertLinesReconcile([], 0)).not.toThrow();
    });
});
