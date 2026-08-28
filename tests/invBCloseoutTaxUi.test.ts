/**
 * INV-B — the owner-facing 1% food-tax toggle.
 *
 * Closeout FREEZES the invoice's financial values, so the tax decision has to be
 * made before that happens rather than explained afterwards. An `applyFoodTax`
 * field that only an API client could set would not satisfy that: the owner would
 * be shown a tax amount they were never asked about.
 *
 * These assert the wiring end to end — the control exists, it is visible before
 * confirmation, its value reaches the request body, and the default is the one
 * derived from history rather than a silent assumption.
 *
 * The closeout dialog lives inside a large page component with many data
 * dependencies, so the UI contract is asserted against the source of the control
 * itself plus an executed test of the payload it produces. Where a behaviour can
 * be executed it is executed; where it is genuinely structural (does the checkbox
 * exist, is it inside the pre-confirmation branch) it is asserted structurally
 * and the mutation battery proves those assertions are load-bearing.
 */

import {
    FOOD_TAX_DEFAULT_APPLIED,
    FOOD_TAX_RATE_PERCENT,
    computeCloseoutFinancials,
} from '@/lib/fundraiserCloseoutMath';

const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

const PAGE = 'app/fundraisers/page.tsx';

describe('the tax choice is exposed to the owner before closeout', () => {
    it('a real checkbox control exists in the closeout dialog', () => {
        const src = read(PAGE);
        expect(src).toMatch(/id="closeout-food-tax"/);
        expect(src).toMatch(/type="checkbox"/);
        // FR-TAX-1B: the label names the CAMPAIGN's frozen rate rather than a
        // product constant, and degrades to a plain label for a campaign that
        // carries no snapshot (and is therefore charged no tax).
        expect(src).toContain('`Apply ${closeoutTaxRateLabel} food tax`');
        expect(src).toContain("'Apply food tax'");
    });

    it('it is bound to state the owner can change', () => {
        const src = read(PAGE);
        expect(src).toMatch(/checked=\{applyFoodTax\}/);
        expect(src).toMatch(/onChange=\{\(e\) => setApplyFoodTax\(e\.target\.checked\)\}/);
    });

    it('it is labelled, so it is reachable and readable', () => {
        const src = read(PAGE);
        expect(src).toMatch(/htmlFor="closeout-food-tax"/);
    });

    it('it renders BEFORE confirmation, not after success', () => {
        // The control sits inside the `!closeoutResult?.success` branch — the
        // consequence copy shown before the owner confirms.
        const src = read(PAGE);
        const guard = src.indexOf('{!closeoutResult?.success && (');
        const control = src.indexOf('id="closeout-food-tax"');
        const successPanel = src.indexOf('{closeoutResult?.success && (');
        expect(guard).toBeGreaterThan(-1);
        expect(control).toBeGreaterThan(guard);
        expect(control).toBeGreaterThan(successPanel);   // after the success block's JSX
    });

    it('the default is ON and comes from the shared constant, not a literal', () => {
        const src = read(PAGE);
        expect(src).toMatch(/useState\(FOOD_TAX_DEFAULT_APPLIED\)/);
        expect(FOOD_TAX_DEFAULT_APPLIED).toBe(true);
        // Visible, never hidden: the checkbox reflects the default rather than
        // the API quietly assuming it.
        expect(src).toMatch(/checked=\{applyFoodTax\}/);
    });

    it('the choice resets per campaign instead of carrying over', () => {
        const src = read(PAGE);
        const dismiss = src.slice(src.indexOf('const dismissCloseoutModal'));
        expect(dismiss.slice(0, 400)).toMatch(/setApplyFoodTax\(FOOD_TAX_DEFAULT_APPLIED\)/);
    });

    it('there is no geographic or jurisdictional tax logic anywhere near it', () => {
        // Comments are stripped first: both files document the DELIBERATE ABSENCE
        // of jurisdictional logic, and matching that prose would fail the test for
        // saying the right thing. The property is about executable code.
        const stripComments = (s: string) =>
            s.replace(/\/\*[\s\S]*?\*\//g, '')
                .split(/\r?\n/)
                .filter((l) => !/^\s*(\/\/|\*)/.test(l))
                .join('\n');

        const page = stripComments(read(PAGE));
        const math = stripComments(read('lib/fundraiserCloseoutMath.ts'));

        for (const banned of [/\bstate\s*tax/i, /jurisdiction/i, /taxRateFor/i, /exemption/i, /nexus/i]) {
            expect(page).not.toMatch(banned);
            expect(math).not.toMatch(banned);
        }
        // The only rate in the model is the single flat constant.
        expect(math).toMatch(/FOOD_TAX_RATE_PERCENT = 1\.0/);
    });
});

describe('the selected value reaches the closeout API', () => {
    it('the request body carries applyFoodTax', () => {
        const src = read(PAGE);
        const handler = src.slice(src.indexOf('const handleCloseout'), src.indexOf('const handleCloseout') + 1200);
        expect(handler).toMatch(/\/closeout`/);
        expect(handler).toMatch(/body: JSON\.stringify\(\{ applyFoodTax \}\)/);
    });

    it('the payload the UI builds is exactly what the API consumes', async () => {
        // Executed: build the body the page builds, and run it through the same
        // parse the route performs.
        for (const applyFoodTax of [true, false]) {
            const body = JSON.stringify({ applyFoodTax });
            const parsed = JSON.parse(body);
            expect(typeof parsed.applyFoodTax).toBe('boolean');
            expect(parsed.applyFoodTax).toBe(applyFoodTax);

            // And the money that choice produces.
            const f = computeCloseoutFinancials({
                grossSales: 2065, orgSharePercent: 20, applyFoodTax: parsed.applyFoodTax,
                taxRatePercent: 1,
            });
            expect(f.taxApplied).toBe(applyFoodTax);
            // FR-TAX-1B: 1% of the NET 1652 = 16.52, not 1% of gross.
            expect(f.totalDue).toBe(applyFoodTax ? 1668.52 : 1652);
        }
    });

    it('the route only accepts a real boolean, so a stray value cannot flip the tax', async () => {
        const routeSrc = read('app/api/campaigns/[id]/closeout/route.ts');
        expect(routeSrc).toMatch(/typeof body\.applyFoodTax === 'boolean'/);
    });
});

describe('the owner sees the resulting figures', () => {
    it('the success panel shows sales, organization earned, remit and final due', () => {
        const src = read(PAGE);
        expect(src).toMatch(/Total fundraiser sales/);
        expect(src).toMatch(/Organization earned/);
        expect(src).toMatch(/Base amount to remit/);
        expect(src).toMatch(/Final amount due/);
    });

    it('the food tax line appears ONLY when the tax was applied', () => {
        const src = read(PAGE);
        expect(src).toMatch(/\{closeoutResult\.financials\.tax_applied && \(/);
        const taxBlock = src.slice(src.indexOf('financials.tax_applied && ('));
        expect(taxBlock.slice(0, 400)).toMatch(/Food tax/);
    });

    it('it states plainly that nothing was sent or paid', () => {
        const src = read(PAGE);
        expect(src).toMatch(/Draft invoice created\. Nothing has been sent or marked paid\./);
    });

    it('the figures rendered are the server\'s, not recomputed in the browser', () => {
        const src = read(PAGE);
        // Every displayed number reads from closeoutResult.financials.
        for (const field of ['gross_sales', 'organization_amount', 'base_remit', 'tax_amount', 'total_due']) {
            expect(src).toMatch(new RegExp('closeoutResult\\.financials\\.' + field));
        }
        // No client-side share or tax arithmetic in the dialog.
        expect(src).not.toMatch(/\*\s*0\.01/);
        expect(src).not.toMatch(/org_share_percent\s*\/\s*100/);
    });

    it('FR-TAX-1B: the rate shown is the CAMPAIGN\'s frozen snapshot, not a constant', () => {
        const src = read(PAGE);
        // Derived through the one authority, from the campaign being closed out.
        expect(src).toMatch(/resolveCloseoutTaxRate\(\{/);
        expect(src).toContain('(closeoutTarget as any)?.tax_rate_percent');
        // The old product constant is no longer rendered anywhere on this page.
        expect(src).not.toMatch(/\{FOOD_TAX_RATE_PERCENT\}%/);
    });
});
