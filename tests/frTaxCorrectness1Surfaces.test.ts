/**
 * FR-TAX-CORRECTNESS-1, part 2 — the SURFACES that quote a money figure.
 *
 * tests/frTaxCorrectness1.test.ts proves the arithmetic: total_amount is the
 * pre-tax food subtotal, tax_amount is the frozen tax, and the supporter owes
 * the sum. This file proves the consequence — that every surface which shows
 * someone a number shows the RIGHT one.
 *
 * The distinction this file exists to protect:
 *
 *   COLLECTION figures (add tax): the supporter's receipt, the coordinator's
 *   new-order notification, the per-supporter list a coordinator reconciles
 *   against cash, the printable tracker's "Total Cost" column.
 *
 *   SALES figures (stay pre-tax): goal progress, the participant leaderboard,
 *   the closeout settlement basis, the organization's share. Collected tax is
 *   money held for the taxing authority, not money the fundraiser raised.
 *
 * Getting these backwards is not a rounding error — it either tells a
 * coordinator to collect less than a supporter was charged, or inflates a
 * fundraiser's progress with money the organization never keeps.
 *
 * Assertions here are largely source-level, which is a real limitation worth
 * naming: this repo pins testEnvironment 'node' with no jsdom and no Prisma
 * test harness, so a Next route handler and a React component cannot be
 * rendered or executed here. They target the exact expressions that would have
 * to change for the behaviour to regress, and comments are stripped before
 * matching so prose describing a rule can neither satisfy nor violate it.
 */
import {
    computeSupporterOrderTax,
    supporterAmountDue,
    resolveCloseoutTaxRate,
} from '@/lib/fundraiserTax';
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readCode = (...p: string[]) => strip(read(...p));

// ═════════════════════════════════════════════════════════════════════════════
// 8. SERVER AUTHORITY — a supporter cannot choose their own tax.
//
// Pricing has always been server-authoritative in the public order route. Tax
// must inherit that property rather than becoming the one money field a client
// can influence.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. supporter-supplied values can never influence the tax', () => {
    const orderRoute = readCode('app', 'api', 'public', 'order', 'route.ts');
    const coordRoute = readCode('app', 'api', 'coordinator', 'route.ts');

    it('the public order route derives tax from the SERVER-resolved campaign snapshot, not the request body', () => {
        expect(orderRoute).toMatch(/computeSupporterOrderTax\(/);
        // The snapshot argument is the server's own campaign row.
        expect(orderRoute).toMatch(/snapshot:\s*campaign\s*\?/);
        // No request-sourced tax field is read anywhere in the route.
        expect(orderRoute).not.toMatch(/body\.(tax|taxAmount|tax_amount|taxRate|tax_rate|taxStatus|tax_status)/);
    });

    it('the persisted tax is the computed value and the persisted subtotal is the server-priced one', () => {
        expect(orderRoute).toMatch(/tax_amount:\s*orderTax\.taxAmount/);
        expect(orderRoute).toMatch(/total_amount:\s*serverSubtotal/);
    });

    it('the coordinator manual-order route has the same property', () => {
        expect(coordRoute).toMatch(/computeSupporterOrderTax\(/);
        expect(coordRoute).toMatch(/tax_amount:\s*orderTax\.taxAmount/);
        expect(coordRoute).not.toMatch(/body\.(tax|taxAmount|tax_amount|taxRate|tax_rate)/);
    });

    it('no tax rate literal is typed into either writer — the frozen snapshot is the only source', () => {
        for (const src of [orderRoute, coordRoute]) {
            expect(src).not.toMatch(/\*\s*0\.01|0\.01\s*\*/);
            expect(src).not.toMatch(/ratePercent:\s*\d/);
        }
    });

    it('the confirmation response is derived from the PERSISTED row, so it cannot disagree with the database', () => {
        expect(orderRoute).toMatch(/persistedOrder\.total_amount/);
        expect(orderRoute).toMatch(/persistedOrder\.tax_amount/);
        // And the replay path selects the tax column, so a duplicate submission
        // returns the same amount due rather than silently dropping the tax.
        const selects = orderRoute.match(/tax_amount:\s*true/g) || [];
        expect(selects.length).toBeGreaterThanOrEqual(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. THE TWO ORDER EMAILS STATE THE AMOUNT DUE.
// ═════════════════════════════════════════════════════════════════════════════
describe('9. order emails quote the amount due, not the pre-tax subtotal', () => {
    const emailCode = readCode('lib', 'email.ts');

    it('both emails route their figure through the one authority', () => {
        expect(emailCode).toMatch(/import\s*\{\s*supporterAmountDue\s*\}\s*from\s*'@\/lib\/fundraiserTax'/);
        // Two call sites: the supporter receipt and the coordinator notification.
        const calls = emailCode.match(/supporterAmountDue\(/g) || [];
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('neither email formats a bare pre-tax subtotal as its headline figure any more', () => {
        expect(emailCode).not.toMatch(/currency\.format\(Number\(order\.total_amount\)\)/);
        expect(emailCode).not.toMatch(/currency\.format\(Number\(totalAmount\)\s*\|\|\s*0\)/);
    });

    it('the coordinator notification accepts the frozen tax alongside the subtotal', () => {
        expect(emailCode).toMatch(/taxAmount\?:\s*number\s*\|\s*null/);
        expect(emailCode).toMatch(/supporterAmountDue\(\{\s*total_amount:\s*totalAmount,\s*tax_amount:\s*taxAmount\s*\}\)/);
    });

    it('the supporter receipt shows a breakdown only when tax was actually charged', () => {
        // A "$0.00 food tax" line on a tax-exempt organization's receipt would
        // be worse than no line at all.
        expect(emailCode).toMatch(/taxAmount\s*>\s*0/);
        expect(emailCode).toMatch(/Total Due/);
        expect(emailCode).toMatch(/Subtotal/);
        // The untaxed branch keeps the original single-row label.
        expect(emailCode).toMatch(/<strong>Total<\/strong>/);
    });

    it('the order route passes the PERSISTED tax to the coordinator notification', () => {
        const routeSrc = read('app', 'api', 'public', 'order', 'route.ts');
        expect(routeSrc).toMatch(/taxAmount:\s*Number\(\(order as any\)\.tax_amount\)\s*\|\|\s*0/);
    });

    it('an untaxed order produces the identical figure the emails produced before this phase', () => {
        // The legacy-collapse property as arithmetic rather than prose: with
        // tax_amount 0/absent/null, the amount due IS total_amount, so every
        // existing receipt and notification is unchanged.
        for (const subtotal of [0, 60, 125, 185, 247.5]) {
            expect(supporterAmountDue({ total_amount: subtotal, tax_amount: 0 })).toBe(subtotal);
            expect(supporterAmountDue({ total_amount: subtotal })).toBe(subtotal);
            expect(supporterAmountDue({ total_amount: subtotal, tax_amount: null })).toBe(subtotal);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. THE CSV IMPORT IS A CAMPAIGN CREATION PATH AND MUST SNAPSHOT TAX.
//
// It was the only creator writing neither tax column. NULL is not neutral: it
// means "legacy, collect nothing" permanently, and nothing re-snapshots an
// imported campaign later — both launch routes CREATE a campaign, and an
// imported Lead reaches Active through a PATCH that does no tax resolution.
// ═════════════════════════════════════════════════════════════════════════════
describe('10. imported campaigns are created with a real tax snapshot', () => {
    const importCode = readCode('app', 'api', 'fundraisers', 'upload', 'route.ts');

    it('the import resolves a snapshot through the same shared function the launch paths use', () => {
        expect(importCode).toMatch(/import\s*\{\s*resolveCampaignTaxSnapshot\s*\}\s*from\s*'@\/lib\/fundraiserTax'/);
        expect(importCode).toMatch(/resolveCampaignTaxSnapshot\(\{/);
        expect(importCode).toMatch(/organizationStatus:/);
        expect(importCode).toMatch(/tenantDefaultRatePercent:/);
    });

    it('both tax columns are actually written on create', () => {
        expect(importCode).toMatch(/tax_status:\s*importTaxSnapshot\.status/);
        expect(importCode).toMatch(/tax_rate_percent:\s*importTaxSnapshot\.ratePercent/);
    });

    it('the import invents no rate of its own', () => {
        expect(importCode).not.toMatch(/tax_rate_percent:\s*\d/);
        expect(importCode).not.toMatch(/\*\s*0\.01|0\.01\s*\*/);
    });

    it('only the create branch writes these columns — re-uploading a CSV cannot re-snapshot a live campaign', () => {
        expect(importCode).toMatch(/if\s*\(!existingCampaign\)/);
        expect(importCode).not.toMatch(/fundraiserCampaign\.update\([\s\S]{0,400}tax_/);
    });

    it('with the tenant default at 0.00 — the real Production value — the snapshot is behaviourally identical to NULL', () => {
        // This is what makes the change safe to deploy: it cannot alter what
        // any tenant charges today.
        const snap = { status: 'TAXABLE' as const, ratePercent: 0 };
        expect(resolveCloseoutTaxRate({ taxStatus: snap.status, taxRatePercent: snap.ratePercent })).toBe(0);
        expect(resolveCloseoutTaxRate({ taxStatus: null, taxRatePercent: null })).toBe(0);
        expect(computeSupporterOrderTax({ subtotal: 125, snapshot: snap }).taxAmount).toBe(0);
        expect(computeSupporterOrderTax({ subtotal: 125, snapshot: snap }).total).toBe(125);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. THE PRE-TAX READERS THAT MUST STAY PRE-TAX.
//
// Keeping total_amount pre-tax is the whole reason this phase has a small blast
// radius. This section pins which readers are sales figures and which are
// collection figures, so a later "make it consistent" edit cannot quietly move
// one across the line.
// ═════════════════════════════════════════════════════════════════════════════
describe('11. sales figures stay pre-tax; only collection figures add tax', () => {
    it('the participant leaderboard ranks on pre-tax sales — tax is not a seller\'s achievement', () => {
        const src = readCode('components', 'coordinator', 'Leaderboard.tsx');
        expect(src).toMatch(/stats\[name\]\.total\s*\+=\s*Number\(order\.total_amount\)/);
        expect(src).not.toMatch(/amount_due|tax_amount/);
    });

    it('coordinator total_sales (goal progress) stays pre-tax — held tax is not money raised', () => {
        const src = readCode('app', 'api', 'coordinator', 'route.ts');
        expect(src).toMatch(/computedTotalSales[\s\S]{0,200}Number\(o\.total_amount\s*\|\|\s*0\)/);
        expect(src).not.toMatch(/computedTotalSales[\s\S]{0,200}tax_amount/);
    });

    it('the closeout settlement basis stays pre-tax, with tax carried as its own separate total', () => {
        const src = readCode('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts');
        expect(src).toMatch(/settlementTotal[\s\S]{0,300}total_amount/);
        expect(src).toMatch(/taxCollected/);
    });

    it('the coordinator\'s per-supporter list DOES show the amount due — that one is cash in hand', () => {
        const src = readCode('components', 'coordinator', 'RecentOrders.tsx');
        expect(src).toMatch(/o\.amount_due\s*\?\?\s*o\.total_amount/);
    });

    it('the supporter order projection exposes both, so each reader can pick correctly', () => {
        const src = readCode('lib', 'coordinatorSupporterOrders.ts');
        expect(src).toMatch(/total_amount:\s*order\.total_amount/);
        expect(src).toMatch(/amount_due:\s*supporterAmountDue\(/);
    });

    it('the two bases genuinely differ once tax exists, so these are not the same assertion twice', () => {
        const orders = [{ total_amount: 1000, tax_amount: 10 }];
        const sales = orders.reduce((s, o) => s + Number(o.total_amount), 0);
        const cash = orders.reduce((s, o) => s + supporterAmountDue(o), 0);
        expect(sales).toBe(1000);
        expect(cash).toBe(1010);
        expect(sales).not.toBe(cash);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. THE SUPPORTER PAGE — the page that takes the money.
// ═════════════════════════════════════════════════════════════════════════════
describe('12. the public supporter page shows what will actually be charged', () => {
    const clientCode = readCode('app', 'shop', '[slug]', 'fundraiser', '[fundraiserId]', 'FundraiserClient.tsx');

    it('the page computes tax through the shared authority, never its own formula', () => {
        expect(clientCode).toMatch(/computeSupporterOrderTax/);
        expect(clientCode).not.toMatch(/\*\s*0\.01|0\.01\s*\*/);
    });

    it('the headline figure is the amount due, not the running pre-tax subtotal', () => {
        expect(clientCode).toMatch(/orderAmountDue/);
    });

    it('the confirmation falls back to the amount due, not the pre-tax total, when the server figure is missing', () => {
        expect(clientCode).toMatch(/Number\.isFinite\(serverTotal\)\s*\?\s*serverTotal\s*:\s*orderAmountDue/);
    });

    it('the campaign tax snapshot is allowlisted for the public payload, and the org share still is not', () => {
        const payload = readCode('lib', 'publicFundraiserPayload.ts');
        expect(payload).toMatch(/'tax_status',\s*\n?\s*'tax_rate_percent',/);
        // What the supporter PAYS is their business; what the organization
        // EARNS is not. This asymmetry is the point.
        expect(payload).toMatch(/FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS[\s\S]{0,600}'org_share_percent'/);
    });

    it('the server query actually selects the two columns the client now reads', () => {
        const pageCode = readCode('app', 'shop', '[slug]', 'fundraiser', '[fundraiserId]', 'page.tsx');
        expect(pageCode).toMatch(/tax_status/);
        expect(pageCode).toMatch(/tax_rate_percent/);
    });
});
