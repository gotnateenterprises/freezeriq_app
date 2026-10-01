/**
 * COORDINATOR-SUPPORTER-POLISH-1 — three small, contained fundraiser UX
 * improvements, none of which touch calculations, payments, orders, campaign
 * lifecycle, invoices, QuickBooks, Square, tax, closeout, or CRM lead
 * classification:
 *
 *   A. the coordinator's payment-instructions field now prompts for the
 *      coordinator's OWN specific instructions, with an example shown only
 *      while the field is genuinely empty — never silently saved as the
 *      coordinator's actual answer;
 *   B. a one-time "you're live" message after coordinator setup, linking to
 *      the SAME server-resolved supporter order URL Copy Link/ShareCenter
 *      already use — no new URL formula, no persistence for dismissal;
 *   C. the fundraiser supporter success screen's old "visit our storefront"
 *      note is now a fundraiser-lead CTA to /raise-funds — a plain
 *      navigation link with no side effect, so it can never itself create a
 *      CRM lead or send "New Lead Captured".
 *
 * This file asserts on SOURCE TEXT, like tests/frAcceptanceMobilePolish1.test.ts
 * (this project's Jest environment is 'node' — no DOM renderer for JSX).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SETUP_FIELDS_PATH = 'components/coordinator/CoordinatorSetupFields.tsx';
const BUNDLE_STEP_PATH = 'components/coordinator/BundleSelectionStep.tsx';
const PORTAL_PATH = 'app/coordinator/portal/page.tsx';
const FUNDRAISER_CLIENT_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';

const setupFields = strip(read(SETUP_FIELDS_PATH));
const bundleStep = strip(read(BUNDLE_STEP_PATH));
const portal = strip(read(PORTAL_PATH));
const fc = strip(read(FUNDRAISER_CLIENT_PATH));

const EXAMPLE_TEXT = 'Payment is due to the coordinator within 3 days. Venmo @____, checks';

// ═════════════════════════════════════════════════════════════════════════════
// A. Coordinator payment-instruction helper
// ═════════════════════════════════════════════════════════════════════════════
describe('A. coordinator payment-instructions: prompt + non-persisted example', () => {
    it('the coordinator setup-form field no longer suggests a specific payment method', () => {
        expect(setupFields).toContain('placeholder="Please add your specific payment instructions here"');
        expect(setupFields).not.toContain('Cash or check at pickup');
    });

    it('the ongoing Payment Settings modal (app/coordinator/portal/page.tsx) uses the same prompt', () => {
        expect(portal).toContain('placeholder="Please add your specific payment instructions here"');
    });

    it('both surfaces show the SAME example text', () => {
        expect(setupFields).toContain(EXAMPLE_TEXT);
        expect(portal).toContain(EXAMPLE_TEXT);
    });

    it('the example is gated on the field being EMPTY, in both surfaces — never a default value', () => {
        const setupIdx = setupFields.indexOf(EXAMPLE_TEXT);
        const setupGate = setupFields.slice(Math.max(0, setupIdx - 200), setupIdx);
        expect(setupGate).toMatch(/\{!values\.paymentInstructions\s*&&\s*\(/);

        const modalIdx = portal.indexOf(EXAMPLE_TEXT);
        const modalGate = portal.slice(Math.max(0, modalIdx - 200), modalIdx);
        expect(modalGate).toMatch(/\{!formData\.paymentInstructions\s*&&\s*\(/);
    });

    it('the example text is never assigned into component state — it is static JSX, not a seeded value', () => {
        // Every useState/setState call site in both files, searched for the
        // example text: none should contain it. A regex over the whole
        // stripped source is deliberately broad — the guarantee this test
        // wants is "not anywhere as a value", not "not in one specific call".
        expect(setupFields).not.toMatch(/useState\([^)]*Payment is due/);
        expect(portal).not.toMatch(/paymentInstructions:\s*['"`][^'"`]*Payment is due/);
    });

    it('validation and persistence are untouched: lib/coordinatorSetup.ts was not modified by this phase', () => {
        const out = execSync('git status --porcelain -- lib/coordinatorSetup.ts', { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });

    it('no structured Cash/Check/Venmo/PayPal/Cash-App/Other payment-METHOD selector was introduced — still one free-text field', () => {
        for (const src of [setupFields, portal]) {
            expect(src).not.toMatch(/type=["']radio["']/);
            expect(src).not.toMatch(/paymentMethod/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Setup complete → fundraiser is live
// ═════════════════════════════════════════════════════════════════════════════
describe('B. one-time "you\'re live" message after coordinator setup', () => {
    it('a NEW, separate boolean drives the banner — bundleSelectionDone/setupComplete keep their existing meaning untouched', () => {
        expect(portal).toContain('const [justCompletedSetup, setJustCompletedSetup] = useState(false);');
        // The pre-existing derivations this phase must not touch:
        expect(portal).toContain("const [bundleSelectionDone, setBundleSelectionDone] = useState(false);");
        expect(portal).toMatch(/const setupComplete = typeof campaign\.bundle_selection_status === 'string'/);
    });

    it('the callback sets justCompletedSetup ONLY when the child reports a fresh completion', () => {
        const idx = portal.indexOf('const handleBundleSelectionComplete');
        const fn = portal.slice(idx, idx + 300);
        expect(fn).toMatch(/\(justCompleted\?:\s*boolean\)\s*=>\s*\{/);
        expect(fn).toContain('setBundleSelectionDone(true);');
        expect(fn).toMatch(/if\s*\(justCompleted\)\s*setJustCompletedSetup\(true\);/);
    });

    it('BundleSelectionStep calls onSelectionComplete(true) on EXACTLY the fresh POST-success path — the two GET-driven paths are unchanged', () => {
        const bareCalls = bundleStep.match(/onSelectionComplete\(\);/g) || [];
        const freshCalls = bundleStep.match(/onSelectionComplete\(true\);/g) || [];
        expect(bareCalls.length).toBe(2); // legacy-not-required GET, and "already selected" GET
        expect(freshCalls.length).toBe(1); // the res.ok POST-success branch only
    });

    it('the prop type documents the fresh-vs-returning distinction', () => {
        expect(bundleStep).toContain('onSelectionComplete: (justCompleted?: boolean) => void;');
    });

    // The banner block, isolated by real code tokens on both sides (the comment
    // that used to mark "Business Logo" is removed by strip(), so the anchor
    // must be a token that survives comment-stripping).
    const bannerIdx = portal.indexOf('{justCompletedSetup && (');
    const logoIdx = portal.indexOf('campaign.customer?.business?.logo_url');
    const banner = portal.slice(bannerIdx, logoIdx);

    it('the banner renders INSIDE the existing bundleSelectionDone gate — never before it, never as a second top-level gate', () => {
        // Same anchor tests/frCoord123LaunchSteps.test.ts uses for LaunchSteps.
        // COORD-CLOSED-PORTAL-1 renamed the gate: portalContentReady is
        // `isClosed || bundleSelectionDone`, and this banner only follows a fresh
        // selection, which a closed campaign can never make.
        const gateIdx = portal.indexOf('{portalContentReady && (<>');
        expect(gateIdx).toBeGreaterThan(-1);
        expect(bannerIdx).toBeGreaterThan(gateIdx);
        expect(logoIdx).toBeGreaterThan(bannerIdx);
    });

    it('the banner uses the exact required copy', () => {
        expect(banner).toContain('Congratulations! Your Coordinator Panel and customer ordering page are now live.');
        expect(banner).toContain('Click here to see what your supporters will see when you share your fundraiser');
    });

    it('the link reuses the SAME shareUrl variable as Copy Link / ShareCenter — no second URL formula, and opens in a new tab', () => {
        expect(banner).toContain('href={shareUrl}');
        expect(banner).toContain('target="_blank"');
        expect(banner).not.toMatch(/window\.location\.origin/);
        expect(banner).not.toMatch(/\/shop\/\$\{/); // no re-derived template literal
        // shareUrl itself is still built by the one authority, unchanged by this phase.
        expect(portal).toContain('const shareUrl = getShopOrderUrl();');
    });

    it('dismissing the banner is a plain local state flip — no fetch, no new API route, no persistence', () => {
        expect(banner).toContain('setJustCompletedSetup(false)');
        expect(banner).not.toMatch(/fetch\(/);
    });

    it('multi-tenant safety: no tenant/organization/campaign name is hardcoded in the banner or its trigger', () => {
        for (const forbidden of ['Freezer Chef', 'FreezerIQ', 'MyFreezerChef', 'myfreezerchef', 'Laurie']) {
            expect(banner).not.toContain(forbidden);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Post-order fundraiser CTA
// ═════════════════════════════════════════════════════════════════════════════
describe('C. supporter success screen: fundraiser-lead CTA replaces the storefront-promotion note', () => {
    it('the old "visit our storefront" promotion is gone from the fundraiser success screen', () => {
        expect(fc).not.toMatch(/visit our storefront/i);
        expect(fc).not.toMatch(/refill after the fundraiser/i);
    });

    it('the new CTA uses the exact required copy', () => {
        expect(fc).toContain("Looking to raise funds for your school, church, team, or other organization? We'd love to help.");
        expect(fc).toContain('Click here to learn more about starting a fundraiser');
    });

    it('the CTA points at the canonical, tenant-scoped /raise-funds route — the SAME path StorefrontFooter/StorefrontClient already use', () => {
        expect(fc).toContain('href={`/shop/${slug}/raise-funds`}');
        const footer = strip(read('components/shop/StorefrontFooter.tsx'));
        const storefront = strip(read('app/shop/[slug]/StorefrontClient.tsx'));
        expect(footer).toContain('/shop/${slug}/raise-funds');
        expect(storefront).toContain('/shop/${slug}/raise-funds');
    });

    it('the CTA is a PLAIN navigation link — no onClick, no fetch, no side effect on render or click', () => {
        const ctaIdx = fc.indexOf('Looking to raise funds');
        const block = fc.slice(Math.max(0, ctaIdx - 600), ctaIdx + 300);
        expect(block).not.toMatch(/onClick/);
        expect(block).not.toMatch(/fetch\(/);
    });

    it('no tenant/organization name is hardcoded — the CTA uses the same resolved tenantName authority as the rest of the file', () => {
        const ctaIdx = fc.indexOf('Looking to raise funds');
        const block = fc.slice(Math.max(0, ctaIdx - 200), ctaIdx + 400);
        expect(block).toMatch(/\{tenantName\}/);
        for (const forbidden of ['Freezer Chef', 'FreezerIQ', 'MyFreezerChef', 'myfreezerchef', 'Laurie']) {
            expect(block).not.toContain(forbidden);
        }
    });

    it('LEAD-CLASSIFICATION REGRESSION: neither the fundraiser-lead rule nor the public order route was touched by this phase', () => {
        const out = execSync('git status --porcelain -- lib/fundraiserLead.ts app/api/public/order/route.ts app/api/public/fundraiser-request/route.ts', { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });

    it('STOREFRONT REGRESSION: the plain (non-fundraiser) storefront/checkout files were not touched by this phase', () => {
        const out = execSync('git status --porcelain -- app/shop/[slug]/StorefrontClient.tsx components/shop/StorefrontFooter.tsx components/shop/CheckoutModal.tsx app/shop/[slug]/checkout/success/page.tsx', { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-cutting: no calculation/payment/schema surface was touched
// ═════════════════════════════════════════════════════════════════════════════
describe('scope: presentation-only, no calculation/payment/lifecycle/schema change', () => {
    it('no migration directory was created by this phase', () => {
        const out = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT, encoding: 'utf8' });
        expect(out).not.toMatch(/prisma\/migrations\//);
    });

    it('prisma/schema.prisma was not modified by this phase', () => {
        const out = execSync('git status --porcelain -- prisma/schema.prisma', { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });

    it('no money/tax/closeout/QuickBooks/Square file was touched by this phase', () => {
        const out = execSync('git status --porcelain -- lib/fundraiserCloseoutMath.ts lib/fundraiserTax.ts app/api/campaigns/[id]/closeout/route.ts lib/quickbooks app/api/checkout lib/payments', { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });

    it('the campaign operational-detail editor (CRM-CAMPAIGN-DETAILS-1) was not touched by this phase', () => {
        const out = execSync('git status --porcelain -- lib/campaignOperationalDetails.ts', { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });
});
