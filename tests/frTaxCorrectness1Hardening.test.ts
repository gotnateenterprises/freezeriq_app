/**
 * FR-TAX-CORRECTNESS-1 — FINAL HARDENING.
 *
 * Three live fundraisers (Clark, Cumberland, Jasper Co Farm Bureau) are frozen
 * at TAXABLE @ 1.00% and will take their first supporter orders on whatever
 * code is deployed next. This file is the gate on that code.
 *
 * It closes two holes the adversarial review found, and pins the invariants
 * that stop them recurring:
 *
 *   1. TAX-EXEMPT AUTHORITY. resolveCampaignTaxSnapshot used to let a client
 *      form's override beat an organization the SERVER had recorded as exempt.
 *      Free while the tenant rate was 0.00%; now it charges real supporters.
 *
 *   2. ACTIVATION SNAPSHOT. PATCH /api/campaigns/[id] could move a campaign to
 *      'Active' without resolving any tax snapshot, leaving it permanently and
 *      silently collecting nothing.
 *
 * Both fixes are gated so they can NEVER touch an existing live fundraiser.
 * That is asserted here as hard as the fixes themselves.
 */
import {
    resolveCampaignTaxSnapshot,
    decideCampaignTaxOverride,
    isCampaignTaxOverrideRejected,
    decideActivationTaxSnapshot,
    computeSupporterOrderTax,
    supporterAmountDue,
    resolveCloseoutTaxRate,
    CAMPAIGN_TAX_EXEMPTION_NOT_ON_RECORD,
} from '@/lib/fundraiserTax';
import { computeCloseoutFinancials, roundCents } from '@/lib/fundraiserCloseoutMath';
import fs from 'fs';
import path from 'path';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readCode = (...p: string[]) => strip(read(...p));

/** The tenant rate My Freezer Chef is now configured at. Never hardcoded into
 *  source — supplied here the way the Business row supplies it at runtime. */
const TENANT_RATE = 1.0;

// ═════════════════════════════════════════════════════════════════════════════
// 1. TAX-EXEMPT AUTHORITY — the server's record outranks the browser.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. tax-exempt authority', () => {
    it('1. authoritative TAX_EXEMPT organization + client says TAXABLE -> campaign stays TAX_EXEMPT / 0%', () => {
        const snap = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAX_EXEMPT',
            tenantDefaultRatePercent: TENANT_RATE,
            override: { status: 'TAXABLE', ratePercent: TENANT_RATE },
        });
        expect(snap.status).toBe('TAX_EXEMPT');
        expect(snap.ratePercent).toBe(0);
        // And the consequence a supporter would feel.
        expect(computeSupporterOrderTax({ subtotal: 60, snapshot: snap }).taxAmount).toBe(0);
    });

    it('2. authoritative TAX_EXEMPT organization + missing client tax field -> 0%', () => {
        for (const override of [undefined, null] as const) {
            const snap = resolveCampaignTaxSnapshot({
                organizationStatus: 'TAX_EXEMPT',
                tenantDefaultRatePercent: TENANT_RATE,
                override,
            });
            expect(snap.status).toBe('TAX_EXEMPT');
            expect(snap.ratePercent).toBe(0);
        }
    });

    it('3. a failed/stale wizard state cannot produce a taxable campaign for an exempt organization', () => {
        // The exact shape a failed prefill produces: the form never learned the
        // organization was exempt, so it posts its TAXABLE default plus the
        // tenant rate it did manage to fetch.
        const staleWizardPayload = { status: 'TAXABLE' as const, ratePercent: '1.00' };
        const snap = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAX_EXEMPT',
            tenantDefaultRatePercent: TENANT_RATE,
            override: staleWizardPayload,
        });
        expect(snap.status).toBe('TAX_EXEMPT');
        expect(snap.ratePercent).toBe(0);
        expect(supporterAmountDue({
            total_amount: 60,
            tax_amount: computeSupporterOrderTax({ subtotal: 60, snapshot: snap }).taxAmount,
        })).toBe(60);
    });

    it('4. UNKNOWN organization + tenant 1% -> TAXABLE @ 1%', () => {
        const snap = resolveCampaignTaxSnapshot({
            organizationStatus: 'UNKNOWN',
            tenantDefaultRatePercent: TENANT_RATE,
        });
        expect(snap).toEqual({ status: 'TAXABLE', ratePercent: 1 });
    });

    it('5. TAXABLE organization + tenant 1% -> TAXABLE @ 1%', () => {
        const snap = resolveCampaignTaxSnapshot({
            organizationStatus: 'TAXABLE',
            tenantDefaultRatePercent: TENANT_RATE,
        });
        expect(snap).toEqual({ status: 'TAXABLE', ratePercent: 1 });
    });

    it('6. a client cannot INVENT exemption — the request is refused, not silently taxed', () => {
        for (const orgStatus of ['UNKNOWN', 'TAXABLE', null, undefined] as const) {
            const d = decideCampaignTaxOverride({
                organizationStatus: orgStatus as any,
                requestedStatus: 'TAX_EXEMPT',
            });
            expect(isCampaignTaxOverrideRejected(d)).toBe(true);
            if (isCampaignTaxOverrideRejected(d)) {
                expect(d.status).toBe(409);
                expect(d.error).toBe(CAMPAIGN_TAX_EXEMPTION_NOT_ON_RECORD);
            }
        }
    });

    it('an override on an organization that IS recorded exempt is allowed through (it agrees with the record)', () => {
        const d = decideCampaignTaxOverride({
            organizationStatus: 'TAX_EXEMPT',
            requestedStatus: 'TAX_EXEMPT',
        });
        expect(isCampaignTaxOverrideRejected(d)).toBe(false);
    });

    it('a client asking TAXABLE on an exempt organization is NOT an error — it is silently corrected to exempt', () => {
        // Failing the launch over a stale radio button would punish the tenant
        // for a UI race. Resolving it correctly protects the supporter.
        const d = decideCampaignTaxOverride({
            organizationStatus: 'TAX_EXEMPT',
            requestedStatus: 'TAXABLE',
        });
        expect(isCampaignTaxOverrideRejected(d)).toBe(false);
        expect(resolveCampaignTaxSnapshot({
            organizationStatus: 'TAX_EXEMPT',
            tenantDefaultRatePercent: TENANT_RATE,
            override: { status: 'TAXABLE' },
        }).status).toBe('TAX_EXEMPT');
    });

    it('an unrecognised or absent requestedStatus claims nothing and is not refused', () => {
        for (const requested of [undefined, null, '', 'BANANA', 'UNKNOWN', 7, {}]) {
            expect(isCampaignTaxOverrideRejected(
                decideCampaignTaxOverride({ organizationStatus: 'UNKNOWN', requestedStatus: requested })
            )).toBe(false);
        }
    });

    it('the ORGANIZATION check sits ABOVE the override branch in the resolver — structurally, not by luck', () => {
        const src = readCode('lib', 'fundraiserTax.ts');
        const start = src.indexOf('export function resolveCampaignTaxSnapshot');
        expect(start).toBeGreaterThan(-1);
        // The signature's inline parameter type also closes with a column-0 "}",
        // so slice to the NEXT top-level export instead of the first "\n}".
        const after = src.indexOf('\nexport ', start + 1);
        const body = src.slice(start, after > -1 ? after : src.length);
        const exemptIdx = body.indexOf("organizationStatus === 'TAX_EXEMPT'");
        const overrideIdx = body.indexOf('if (input.override)');
        expect(exemptIdx).toBeGreaterThan(-1);
        expect(overrideIdx).toBeGreaterThan(-1);
        expect(exemptIdx).toBeLessThan(overrideIdx);
        // And the override branch no longer contains a TAX_EXEMPT return.
        expect(body.slice(overrideIdx)).not.toMatch(/status:\s*'TAX_EXEMPT'/);
    });

    it('the campaign creation route actually calls the gate, with the SERVER-loaded organization status', () => {
        const src = readCode('app', 'api', 'campaigns', 'route.ts');
        expect(src).toMatch(/decideCampaignTaxOverride\(\{/);
        expect(src).toMatch(/organizationStatus:\s*customer\.tax_status/);
        expect(src).toMatch(/requestedStatus:\s*body\.taxStatus/);
        // The refusal must happen BEFORE the snapshot is resolved.
        expect(src.indexOf('decideCampaignTaxOverride'))
            .toBeLessThan(src.indexOf('resolveCampaignTaxSnapshot({'));
    });

    it('the gate is UNCONDITIONAL and actually returns the refusal — not short-circuited', () => {
        // Mutation H3: `if (false && isCampaignTaxOverrideRejected(...))` keeps
        // the identifier present while disabling the gate entirely. Assert the
        // guard's exact shape and that its body returns the error response.
        const src = readCode('app', 'api', 'campaigns', 'route.ts');
        const m = src.match(
            /if\s*\(isCampaignTaxOverrideRejected\(taxOverrideDecision\)\)\s*\{\s*return NextResponse\.json\(\s*\{\s*error:\s*taxOverrideDecision\.error\s*\},\s*\{\s*status:\s*taxOverrideDecision\.status\s*\}\s*\);\s*\}/
        );
        expect(m).not.toBeNull();
        // Nothing may weaken the condition.
        expect(src).not.toMatch(/if\s*\([^)]*&&\s*isCampaignTaxOverrideRejected/);
        expect(src).not.toMatch(/isCampaignTaxOverrideRejected[^)]*\)\s*&&/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE WIZARD NO LONGER HIDES A FAILED LOOKUP.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the launch wizard surfaces an unverified tax position', () => {
    const src = readCode('components', 'crm2', 'StartFundraiserWizard.tsx');

    it('a non-ok organization response is recorded as an error, not silently ignored', () => {
        expect(src).toMatch(/if\s*\(!res\.ok\)\s*\{\s*setOrgTaxLoad\('error'\);\s*return;\s*\}/);
        // The old silent form must be gone.
        expect(src).not.toMatch(/if\s*\(cancelled\s*\|\|\s*!res\.ok\)\s*return;/);
    });

    it('a thrown fetch is recorded as an error too — no empty catch on this path', () => {
        const effect = src.slice(src.indexOf('/api/tenant/tax-settings'), src.indexOf('Dup-check while typing'));
        expect(effect).toMatch(/catch\s*\{\s*if\s*\(!cancelled\)\s*setOrgTaxLoad\('error'\);\s*\}/);
    });

    it('the launch button is blocked while the tax position is unverified', () => {
        expect(src).toMatch(/orgTaxLoad === 'error' \|\|/);
    });

    it('the failure is visible to the person launching, with a retry', () => {
        const raw = read('components', 'crm2', 'StartFundraiserWizard.tsx');
        expect(raw).toMatch(/Could not load this organization&apos;s recorded tax status/);
        expect(raw).toMatch(/wiz-tax-status-retry/);
        expect(src).toMatch(/setOrgTaxReloadKey\(\(k\) => k \+ 1\)/);
    });

    it('retrying actually re-runs the lookup (the key is a dependency of the effect)', () => {
        expect(src).toMatch(/\}, \[useExistingId, orgTaxReloadKey\]\);/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. ACTIVATION ALWAYS CARRIES A SNAPSHOT — and never repairs a live campaign.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. activation snapshot guard', () => {
    const base = {
        currentStatus: 'Lead',
        nextStatus: 'Active',
        existingTaxStatus: null,
        hasFinancialActivity: false,
        tenantDefaultRatePercent: TENANT_RATE,
    };

    it('1. future UNKNOWN org + tenant 1% -> Active campaign snapshots TAXABLE @ 1%', () => {
        const d = decideActivationTaxSnapshot({ ...base, organizationStatus: 'UNKNOWN' });
        expect(d.write).toBe(true);
        if (d.write) expect(d.snapshot).toEqual({ status: 'TAXABLE', ratePercent: 1 });
    });

    it('2. future TAXABLE org + tenant 1% -> TAXABLE @ 1%', () => {
        const d = decideActivationTaxSnapshot({ ...base, organizationStatus: 'TAXABLE' });
        expect(d.write).toBe(true);
        if (d.write) expect(d.snapshot).toEqual({ status: 'TAXABLE', ratePercent: 1 });
    });

    it('3. future TAX_EXEMPT org -> TAX_EXEMPT / 0%, even with the tenant at 1%', () => {
        const d = decideActivationTaxSnapshot({ ...base, organizationStatus: 'TAX_EXEMPT' });
        expect(d.write).toBe(true);
        if (d.write) expect(d.snapshot).toEqual({ status: 'TAX_EXEMPT', ratePercent: 0 });
    });

    it('4. an existing Active NULL/NULL campaign is UNCHANGED — Edgar County Farm Bureau', () => {
        // The real live shape: already Active, no snapshot, 3 supporter orders.
        const d = decideActivationTaxSnapshot({
            currentStatus: 'Active',
            nextStatus: 'Active',
            existingTaxStatus: null,
            hasFinancialActivity: true,
            organizationStatus: 'UNKNOWN',
            tenantDefaultRatePercent: TENANT_RATE,
        });
        expect(d.write).toBe(false);

        // And every other way this campaign could be PATCHed.
        for (const nextStatus of ['Active', 'Production', 'Delivery', undefined]) {
            expect(decideActivationTaxSnapshot({
                currentStatus: 'Active',
                nextStatus,
                existingTaxStatus: null,
                hasFinancialActivity: true,
                organizationStatus: 'UNKNOWN',
                tenantDefaultRatePercent: TENANT_RATE,
            }).write).toBe(false);
        }
    });

    it('5. an existing Active TAXABLE@0 campaign is UNCHANGED — Home Schoolers USA / Best Brew Test 4', () => {
        const d = decideActivationTaxSnapshot({
            currentStatus: 'Active',
            nextStatus: 'Active',
            existingTaxStatus: 'TAXABLE',
            hasFinancialActivity: true,
            organizationStatus: 'UNKNOWN',
            tenantDefaultRatePercent: TENANT_RATE,
        });
        expect(d.write).toBe(false);
    });

    it('6. activation cannot bypass the snapshot by using a different route', () => {
        // Census: every path that can make a campaign publicly/financially
        // active must obtain or already possess a frozen snapshot.
        const creates = [
            ['app/api/campaigns/route.ts', 'resolveCampaignTaxSnapshot'],
            ['app/api/opportunities/[id]/launch/route.ts', 'resolveCampaignTaxSnapshot'],
            ['app/api/fundraisers/upload/route.ts', 'resolveCampaignTaxSnapshot'],
        ] as const;
        for (const [file, needle] of creates) {
            expect(readCode(...file.split('/'))).toMatch(new RegExp(needle));
        }
        // The transition path is gated by the shared decision.
        expect(readCode('app', 'api', 'campaigns', '[id]', 'route.ts'))
            .toMatch(/decideActivationTaxSnapshot\(\{/);

        // No OTHER file writes campaign.status — so there is no fourth door.
        const { execSync } = require('child_process');
        const out = execSync(
            'git grep -n --untracked -E "status: *.Active." -- "app/**/*.ts" "app/**/*.tsx" "lib/**/*.ts" || true',
            { cwd: process.cwd(), encoding: 'utf8' }
        ) as string;
        const writers = out.split('\n').filter(Boolean)
            // `where:` filters and customer-form defaults are not campaign writes.
            .filter((l) => !l.includes('where:'))
            .filter((l) => !l.includes("type: 'Individual'"))
            .filter((l) => !/app\/(customers|fundraisers)\/\[id\]\/page\.tsx/.test(l))
            .filter((l) => !/^tests\//.test(l));
        for (const w of writers) {
            expect(w).toMatch(/app\/api\/campaigns\/route\.ts/);
        }
    });

    it('an ALREADY-ACTIVE campaign with no snapshot and no orders is STILL not rewritten', () => {
        // Mutation H8: dropping the `currentStatus !== 'Active'` half of the
        // transition test was survivable because every other already-Active
        // case in this file also carries financial activity, which rule 3
        // catches. This is the shape that isolates rule 1 on its own — a live
        // campaign that simply has not taken an order yet. A PATCH that merely
        // re-saves its name must never quietly freeze a tax position onto it.
        const d = decideActivationTaxSnapshot({
            currentStatus: 'Active',
            nextStatus: 'Active',
            existingTaxStatus: null,
            hasFinancialActivity: false,
            organizationStatus: 'UNKNOWN',
            tenantDefaultRatePercent: TENANT_RATE,
        });
        expect(d.write).toBe(false);
        expect(d.reason).toMatch(/not a not-active -> Active transition/);
    });

    it('the transition test requires BOTH halves — next is Active AND current is not', () => {
        const src = readCode('lib', 'fundraiserTax.ts');
        const start = src.indexOf('export function decideActivationTaxSnapshot');
        const after = src.indexOf('\nexport ', start + 1);
        const body = src.slice(start, after > -1 ? after : src.length);
        expect(body).toMatch(/input\.nextStatus === ACTIVE_CAMPAIGN_STATUS/);
        expect(body).toMatch(/input\.currentStatus !== ACTIVE_CAMPAIGN_STATUS/);
    });

    it('the PATCH route actually WRITES the resolved snapshot — the decision is not dead code', () => {
        // Mutation H7: computing activationTaxData and then never spreading it
        // into the update leaves the hole wide open while every "does the route
        // call the helper" assertion still passes.
        const src = readCode('app', 'api', 'campaigns', '[id]', 'route.ts');
        expect(src).toMatch(/activationTaxData\s*=\s*\{\s*tax_status:\s*decision\.snapshot\.status,\s*tax_rate_percent:\s*decision\.snapshot\.ratePercent,\s*\}/);
        // And that value must reach the update's data object.
        const update = src.slice(src.indexOf('fundraiserCampaign.update({'));
        expect(update.slice(0, update.indexOf('});'))).toMatch(/\.\.\.\(activationTaxData \?\? \{\}\)/);
    });

    it('a campaign that already has a snapshot keeps it — this fills a gap, it does not re-decide', () => {
        const d = decideActivationTaxSnapshot({
            ...base,
            existingTaxStatus: 'TAX_EXEMPT',
            organizationStatus: 'UNKNOWN', // would otherwise resolve TAXABLE@1
        });
        expect(d.write).toBe(false);
    });

    it('a not-yet-active campaign WITH financial activity is left alone rather than repriced', () => {
        const d = decideActivationTaxSnapshot({
            ...base,
            hasFinancialActivity: true,
            organizationStatus: 'UNKNOWN',
        });
        expect(d.write).toBe(false);
    });

    it('a non-activation edit never writes tax — renaming a Lead is not an activation', () => {
        for (const [currentStatus, nextStatus] of [
            ['Lead', 'Agreement'], ['Lead', undefined], ['Onboarding', 'Onboarding'], ['Active', 'Archived'],
        ] as const) {
            expect(decideActivationTaxSnapshot({
                ...base, currentStatus, nextStatus, organizationStatus: 'UNKNOWN',
            }).write).toBe(false);
        }
    });

    it('the PATCH route passes the SERVER-loaded organization status and real activity counts', () => {
        const src = readCode('app', 'api', 'campaigns', '[id]', 'route.ts');
        expect(src).toMatch(/organizationStatus:\s*\(campaign\.customer as any\)\?\.tax_status/);
        expect(src).toMatch(/prisma\.order\.count\(\{\s*where:\s*\{\s*campaign_id:\s*id\s*\}\s*\}\)/);
        expect(src).toMatch(/prisma\.invoice\.count\(\{\s*where:\s*\{\s*campaign_id:\s*id\s*\}\s*\}\)/);
        expect(src).toMatch(/closed_at/);
        // It must not read a tax position off the request.
        expect(src).not.toMatch(/body\.(taxStatus|tax_status|taxRatePercent|tax_rate_percent)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. FUNDRAISER INVOICE TAX = COLLECTED TAX, never a fresh calculation.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. fundraiser closeout invoice carries collected tax', () => {
    it('the invoice tax equals the sum of accepted Order.tax_amount, not subtotal x rate', () => {
        // Three orders that were taxed at 1% when they were placed.
        const orders = [
            { total_amount: 60, tax_amount: 0.6 },
            { total_amount: 125, tax_amount: 1.25 },
            { total_amount: 185, tax_amount: 1.85 },
        ];
        const foodSales = roundCents(orders.reduce((s, o) => s + o.total_amount, 0));   // 370
        const taxCollected = roundCents(orders.reduce((s, o) => s + o.tax_amount, 0));  // 3.70

        const f = computeCloseoutFinancials({
            grossSales: foodSales, orgSharePercent: 20, applyFoodTax: true,
            taxCollected, taxRatePercent: 1,
        });

        expect(f.taxAmount).toBe(taxCollected);
        expect(f.organizationAmount).toBe(74);            // 20% of PRE-TAX 370
        expect(f.totalDue).toBe(roundCents(370 - 74 + 3.7)); // 299.70
    });

    it('a rate that disagrees with what was collected does NOT win — collected tax is the authority', () => {
        // The campaign is frozen at 1%, but only $0.60 was actually collected
        // (one taxed order, one legacy untaxed order). The invoice must carry
        // $0.60 — not 1% of the $370 subtotal.
        const f = computeCloseoutFinancials({
            grossSales: 370, orgSharePercent: 20, applyFoodTax: true,
            taxCollected: 0.6, taxRatePercent: 1,
        });
        expect(f.taxAmount).toBe(0.6);
        expect(f.taxAmount).not.toBe(3.7);
        expect(f.taxAmount).not.toBe(roundCents((370 - 74) * 1 / 100));
    });

    it('the closeout math derives tax from taxCollected and performs no rate multiplication', () => {
        const src = readCode('lib', 'fundraiserCloseoutMath.ts');
        expect(src).toMatch(/taxCollected/);
        // The FR-TAX-1B net-basis formula must be gone.
        expect(src).not.toMatch(/baseRemit\s*\*\s*rate\s*\/\s*100/);
    });

    it('the closeout route sums accepted orders\' tax_amount and hands it to the math', () => {
        const src = readCode('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts');
        expect(src).toMatch(/tax_amount:\s*true/);
        expect(src).toMatch(/taxCollected/);
        expect(src).toMatch(/Number\(o\.tax_amount\)/);
        // And the invoice row carries that number, not a recomputation.
        expect(src).toMatch(/tax_amount:\s*financials\.taxAmount/);
        expect(src).toMatch(/total_amount:\s*financials\.totalDue/);
    });

    it('a fully legacy closeout (no tax collected anywhere) still produces a zero-tax invoice', () => {
        const f = computeCloseoutFinancials({
            grossSales: 250, orgSharePercent: 20, applyFoodTax: true,
            taxCollected: 0, taxRatePercent: 0,
        });
        expect(f.taxAmount).toBe(0);
        expect(f.totalDue).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE MANUAL INVOICE COMPOSER IS A DIFFERENT DOCUMENT.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. the manual composer is separate from the closeout invoice path', () => {
    it('the closeout invoice is created SERVER-side and never passes through the composer', () => {
        const closeout = readCode('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts');
        expect(closeout).toMatch(/tx\.invoice\.create\(\{/);
        expect(closeout).not.toMatch(/InvoiceComposeModal/);
    });

    it('the composer is mounted only by the manual invoices page', () => {
        const { execSync } = require('child_process');
        const out = execSync(
            'git grep -l --untracked "InvoiceComposeModal" -- "app/**" "components/**" || true',
            { cwd: process.cwd(), encoding: 'utf8' }
        ) as string;
        const files = out.split('\n').filter(Boolean).filter((f) => !f.includes('backups/'));
        expect(files.sort()).toEqual([
            'app/invoices/page.tsx',
            'components/crm/InvoiceComposeModal.tsx',
        ]);
    });

    it('the composer applies NO automatic fundraiser rate — it cannot invent a tax the supporters never paid', () => {
        const src = readCode('components', 'crm', 'InvoiceComposeModal.tsx');
        // The old unconditional 1% is gone and did not come back.
        expect(src).not.toMatch(/subtotal\s*\*\s*0\.01/);
        // Any rate it uses must be supplied, and a missing one means no tax.
        expect(src).toMatch(/safeRate\s*<=\s*0/);
        // Its only caller passes no rate, so the automatic path is inert.
        const page = readCode('app', 'invoices', 'page.tsx');
        const mount = page.slice(page.indexOf('<InvoiceComposeModal'));
        expect(mount.slice(0, mount.indexOf('/>'))).not.toMatch(/taxRatePercent/);
    });

    it('the composer respects an organization recorded as exempt', () => {
        const src = readCode('components', 'crm', 'InvoiceComposeModal.tsx');
        expect(src).toMatch(/selectedCustomer\?\.tax_status === 'TAX_EXEMPT'/);
        expect(src).toMatch(/if \(isTaxExempt \|\| orgIsExempt \|\| safeRate <= 0\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE total_amount CONTRACT — reasserted, not reopened.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. Order.total_amount stays PRE-TAX', () => {
    const TAXABLE_1PCT = { status: 'TAXABLE' as const, ratePercent: 1 };

    it('$60 taxable -> total_amount 60.00, tax_amount 0.60, amount due 60.60', () => {
        const t = computeSupporterOrderTax({ subtotal: 60, snapshot: TAXABLE_1PCT });
        const persisted = { total_amount: t.subtotal, tax_amount: t.taxAmount };
        expect(persisted.total_amount).toBe(60);
        expect(persisted.tax_amount).toBe(0.6);
        expect(supporterAmountDue(persisted)).toBe(60.6);
        expect(persisted.total_amount).not.toBe(60.6);
    });

    it('$125 taxable -> total_amount 125.00, tax_amount 1.25, amount due 126.25', () => {
        const t = computeSupporterOrderTax({ subtotal: 125, snapshot: TAXABLE_1PCT });
        const persisted = { total_amount: t.subtotal, tax_amount: t.taxAmount };
        expect(persisted.total_amount).toBe(125);
        expect(persisted.tax_amount).toBe(1.25);
        expect(supporterAmountDue(persisted)).toBe(126.25);
        expect(persisted.total_amount).not.toBe(126.25);
    });

    it('the organization share is never inflated by tax', () => {
        const f = computeCloseoutFinancials({
            grossSales: 1000, orgSharePercent: 20, applyFoodTax: true,
            taxCollected: 10, taxRatePercent: 1,
        });
        expect(f.organizationAmount).toBe(200);
        expect(f.organizationAmount).not.toBe(202);
        expect(f.totalDue).toBe(810);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. ALL FOUR PRODUCTION SHAPES VALID SIMULTANEOUSLY.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. every real Production campaign shape, at once', () => {
    const SHAPES = [
        { label: 'new taxable (Clark/Cumberland/Jasper)', snap: { status: 'TAXABLE', ratePercent: 1 }, tax60: 0.6, tax125: 1.25 },
        { label: 'live legacy taxable (Home Schoolers, Best Brew 4)', snap: { status: 'TAXABLE', ratePercent: 0 }, tax60: 0, tax125: 0 },
        { label: 'live legacy null (Edgar County)', snap: { status: null, ratePercent: null }, tax60: 0, tax125: 0 },
        { label: 'future tax exempt', snap: { status: 'TAX_EXEMPT', ratePercent: 0 }, tax60: 0, tax125: 0 },
    ] as const;

    for (const s of SHAPES) {
        it(`${s.label} behaves correctly and independently`, () => {
            const a = computeSupporterOrderTax({ subtotal: 60, snapshot: s.snap as any });
            const b = computeSupporterOrderTax({ subtotal: 125, snapshot: s.snap as any });
            expect(a.taxAmount).toBe(s.tax60);
            expect(b.taxAmount).toBe(s.tax125);
            expect(a.subtotal).toBe(60);
            expect(b.subtotal).toBe(125);
            expect(supporterAmountDue({ total_amount: 60, tax_amount: a.taxAmount })).toBe(roundCents(60 + s.tax60));
            expect(supporterAmountDue({ total_amount: 125, tax_amount: b.taxAmount })).toBe(roundCents(125 + s.tax125));
        });
    }

    it('raising the tenant default to 1% cannot reach any already-frozen snapshot', () => {
        // The frozen rate is read from the campaign row; the tenant default is
        // not an input to the order-time calculation at all.
        for (const s of SHAPES) {
            expect(resolveCloseoutTaxRate({
                taxStatus: s.snap.status as any,
                taxRatePercent: s.snap.ratePercent as any,
            })).toBe(s.label.startsWith('new taxable') ? 1 : 0);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. THE THREE FARM BUREAU CAMPAIGNS, END TO END.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. Clark / Cumberland / Jasper deployment proof', () => {
    // Their real frozen Production snapshot and their real bundle prices.
    const SNAPSHOT = { status: 'TAXABLE' as const, ratePercent: 1 };
    const CAMPAIGNS = ['Clark Co Farm Bureau', 'Cumberland Co Farm Bureau', 'Jasper Co Farm Bureau'];

    for (const name of CAMPAIGNS) {
        it(`${name}: $60 -> $60.60 and $125 -> $126.25`, () => {
            const a = computeSupporterOrderTax({ subtotal: 60, snapshot: SNAPSHOT });
            expect([a.subtotal, a.taxAmount, supporterAmountDue({ total_amount: a.subtotal, tax_amount: a.taxAmount })])
                .toEqual([60, 0.6, 60.6]);

            const b = computeSupporterOrderTax({ subtotal: 125, snapshot: SNAPSHOT });
            expect([b.subtotal, b.taxAmount, supporterAmountDue({ total_amount: b.subtotal, tax_amount: b.taxAmount })])
                .toEqual([125, 1.25, 126.25]);
        });
    }

    it('the supporter sees the tax BEFORE submitting', () => {
        const client = readCode('app', 'shop', '[slug]', 'fundraiser', '[fundraiserId]', 'FundraiserClient.tsx');
        expect(client).toMatch(/computeSupporterOrderTax/);
        expect(client).toMatch(/orderAmountDue/);
        const raw = read('app', 'shop', '[slug]', 'fundraiser', '[fundraiserId]', 'FundraiserClient.tsx');
        expect(raw).toMatch(/Subtotal/);
        expect(raw).toMatch(/Food tax/);
    });

    it('the SERVER computes it independently and persists the two parts separately', () => {
        const route = readCode('app', 'api', 'public', 'order', 'route.ts');
        expect(route).toMatch(/computeSupporterOrderTax\(/);
        expect(route).toMatch(/snapshot:\s*campaign\s*\?/);
        expect(route).toMatch(/total_amount:\s*serverSubtotal/);
        expect(route).toMatch(/tax_amount:\s*orderTax\.taxAmount/);
        expect(route).not.toMatch(/body\.(tax|taxAmount|tax_amount|taxRate|tax_rate)/);
    });

    it('the coordinator collection amount includes the tax', () => {
        expect(readCode('lib', 'coordinatorSupporterOrders.ts')).toMatch(/amount_due:\s*supporterAmountDue\(/);
        expect(readCode('components', 'coordinator', 'RecentOrders.tsx')).toMatch(/o\.amount_due\s*\?\?\s*o\.total_amount/);
        expect(readCode('lib', 'email.ts')).toMatch(/supporterAmountDue\(\{\s*total_amount:\s*totalAmount,\s*tax_amount:\s*taxAmount\s*\}\)/);
    });

    it('closeout and the invoice both carry the collected tax', () => {
        const closeout = readCode('app', 'api', 'campaigns', '[id]', 'closeout', 'route.ts');
        expect(closeout).toMatch(/taxCollected/);
        expect(closeout).toMatch(/tax_amount:\s*financials\.taxAmount/);

        const f = computeCloseoutFinancials({
            grossSales: 1850, orgSharePercent: 20, applyFoodTax: true,
            taxCollected: 18.5, taxRatePercent: 1,
        });
        expect(f.organizationAmount).toBe(370);
        expect(f.taxAmount).toBe(18.5);
        expect(f.totalDue).toBe(roundCents(1850 - 370 + 18.5)); // 1498.50
    });
});
