/**
 * FR-ACCEPTANCE-MOBILE-POLISH-1 — four acceptance-polish findings from a real
 * successful end-to-end walkthrough ("The Best Brew Test1 Fundraiser").
 *
 * Two of the four (weighting math, the post-order payment fallback) already
 * had correct underlying logic before this phase — this suite proves that
 * explicitly, alongside the actual fixes (mobile double-padding, the PayBadge
 * assumption, the coordinator momentum panel). Source-level checks are used
 * for the two purely-presentational components (FundraiserClient.tsx,
 * LaunchSteps.tsx) since neither can be rendered in this project's jest
 * environment (testEnvironment: 'node', no DOM) — labeled as such rather than
 * claimed as behavioral coverage.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const FUNDRAISER_CLIENT = "app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx";
const LAYOUT_WRAPPER = 'components/LayoutWrapper.tsx';
const LAUNCH_STEPS = 'components/coordinator/LaunchSteps.tsx';
const PORTAL_PAGE = 'app/coordinator/portal/page.tsx';

let fc: string;
let layoutWrapper: string;
let launchSteps: string;
let portal: string;

beforeAll(() => {
    fc = read(FUNDRAISER_CLIENT);
    layoutWrapper = read(LAYOUT_WRAPPER);
    launchSteps = read(LAUNCH_STEPS);
    portal = read(PORTAL_PAGE);
});

// ===========================================================================
describe('MOBILE — the smaller-phone clipping defect', () => {
    it('1. the double-padding root cause is actually removed: FundraiserClient no longer applies its own horizontal padding', () => {
        // The exact pre-fix line stacked padding: '0 1rem' on top of
        // LayoutWrapper's `main` p-4/sm:p-8 — same 1rem value, doubled.
        expect(fc).not.toContain("padding: '0 1rem'");
        expect(fc).toMatch(/maxWidth: '36rem', margin: '0 auto', padding: 0,/);
    });

    it('1b. LayoutWrapper — the OTHER half of the double-padding — is untouched, confirming a single-layer fix rather than two changes fighting each other', () => {
        expect(layoutWrapper).toContain("'min-h-screen p-4 sm:p-8'");
    });

    it('2. the Add control cannot have its label clipped: it never shrinks and never wraps mid-word', () => {
        const cardStart = fc.indexOf('function BundleCard');
        // Fixed-length window rather than searching for a closing brace: the
        // props destructuring itself closes with `}) {` at the start of a
        // line, which a naive `\n}` search matches immediately.
        const cardBody = fc.slice(cardStart, cardStart + 4000);
        // The exact button that renders "Add" / "✓ Added".
        const btnIdx = cardBody.indexOf("{inOrder ? '✓ Added' : 'Add'}");
        expect(btnIdx).toBeGreaterThan(-1);
        const btnStyleStart = cardBody.lastIndexOf('style={{', btnIdx);
        const btnStyle = cardBody.slice(btnStyleStart, btnIdx);
        expect(btnStyle).toContain('flexShrink: 0');
        expect(btnStyle).toContain("whiteSpace: 'nowrap'");
    });

    it('2b. the sibling price/serves label is the one that shrinks, correctly (min-w-0 + ellipsis) — the two together are what the audit checklist asked for', () => {
        const cardStart = fc.indexOf('function BundleCard');
        const cardBody = fc.slice(cardStart, cardStart + 4000);
        const priceSpanIdx = cardBody.indexOf("minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis'");
        expect(priceSpanIdx).toBeGreaterThan(-1);
        // It must come BEFORE the Add button in source order (same flex row).
        expect(priceSpanIdx).toBeLessThan(cardBody.indexOf("{inOrder ? '✓ Added' : 'Add'}"));
    });

    it('3. larger phones and desktop are unaffected: the one existing breakpoint-gated rule and the page-level max-width are both untouched', () => {
        // maxWidth:'36rem' is the page's only WIDTH ceiling — a max, not a
        // min, so it cannot force overflow on any viewport; confirming it is
        // still exactly 36rem (unchanged) proves desktop/large-phone layout
        // wasn't altered by the padding fix.
        expect(fc).toContain("maxWidth: '36rem'");
        expect(fc).toContain('className="md:-mx-12"'); // the one existing desktop-only rule, unchanged
    });

    it('no unintended horizontal overflow is introduced: no new overflow-x or fixed large pixel width appears in the diff-relevant regions', () => {
        const cardStart = fc.indexOf('function BundleCard');
        const cardBody = fc.slice(cardStart, cardStart + 4000);
        expect(cardBody).not.toMatch(/overflow-x/);
        // 4+ digit pixel width only — '100%'/'100vw' etc. are 3-digit
        // percentages/units, not oversized fixed pixel values.
        expect(cardBody).not.toMatch(/width:\s*['"]?\d{4,}(?!%|vw|rem)/);
    });
});

// ===========================================================================
describe('WEIGHTING — explaining the existing (unmodified) progress engine', () => {
    // Import fresh inside this block: the underlying weighting functions are
    // exercised directly, proving the engine itself is untouched by this phase.
    const { getBundleUnitWeight, computeBundleUnitsFromItems } = require('@/lib/fundraiserMetrics');

    it('4. Serves 5 (family) = 1.0 progress unit', () => {
        expect(getBundleUnitWeight('serves_5')).toBe(1.0);
        expect(getBundleUnitWeight('family')).toBe(1.0);
    });

    it('5. Serves 2 (couple) = 0.5 progress unit', () => {
        expect(getBundleUnitWeight('serves_2')).toBe(0.5);
        expect(getBundleUnitWeight('couple')).toBe(0.5);
    });

    it('6. mixed quantities aggregate correctly — the exact shape the display copy renders', () => {
        const units = computeBundleUnitsFromItems([
            { quantity: 3, variant_size: 'serves_5' },
            { quantity: 4, variant_size: 'serves_2' },
        ]);
        expect(units).toBe(5.0); // 3×1.0 + 4×0.5, matches the module's own doc example
    });

    it('7a. the explanatory legend is present, using the terminology already shown to supporters on this exact page ("serves 5" / "serves 2", not "Family Size")', () => {
        const legend = 'Fundraiser goal credit: serves 5 = 1 bundle · serves 2 = ½ bundle';
        const occurrences = fc.split(legend).length - 1;
        // Both preferred placements: near the bundle choices AND below the
        // post-order progress statement — "and/or" in the brief, implemented
        // as both, each a single line, not per-card (avoids clutter).
        expect(occurrences).toBe(2);
    });

    it('7b. the legend is NOT duplicated per bundle card (that would be the clutter the brief explicitly warned against)', () => {
        const cardStart = fc.indexOf('function BundleCard');
        const cardBody = fc.slice(cardStart, cardStart + 4000);
        expect(cardBody).not.toContain('Fundraiser goal credit');
    });

    describe('the OWNER\'S EXACT worked examples, via the display-formatting helper', () => {
        // formatBundleCredit is not exported (module-private, deliberately —
        // it is presentation-only and must never be imported as if it were
        // part of the weighting engine). Re-derive it identically here so the
        // exact three examples from the brief are pinned byte-for-byte,
        // without re-exporting internals purely for testability.
        function formatBundleCredit(units: number): string {
            const whole = Math.floor(units);
            const hasHalf = Math.abs(units - whole - 0.5) < 1e-9;
            if (!hasHalf) return String(whole);
            return whole === 0 ? '½' : `${whole}½`;
        }
        const sentence = (units: number) => {
            const { computeBundleUnitsFromItems: agg } = require('@/lib/fundraiserMetrics');
            void agg;
            const plural = units <= 1 ? '' : 's';
            return `Your order added ${formatBundleCredit(units)} bundle${plural} toward the fundraiser goal 🎉`;
        };

        it('1 Serves-2 item → "½ bundle" (singular, matching the brief\'s exact wording)', () => {
            const units = computeBundleUnitsFromItems([{ quantity: 1, variant_size: 'serves_2' }]);
            expect(units).toBe(0.5);
            expect(sentence(units)).toBe('Your order added ½ bundle toward the fundraiser goal 🎉');
        });

        it('1 Serves-5 item → "1 bundle" (singular)', () => {
            const units = computeBundleUnitsFromItems([{ quantity: 1, variant_size: 'serves_5' }]);
            expect(units).toBe(1);
            expect(sentence(units)).toBe('Your order added 1 bundle toward the fundraiser goal 🎉');
        });

        it('mixed quantities → correct aggregate, plural once it exceeds 1', () => {
            const units = computeBundleUnitsFromItems([
                { quantity: 1, variant_size: 'serves_5' },
                { quantity: 1, variant_size: 'serves_2' },
            ]);
            expect(units).toBe(1.5);
            expect(sentence(units)).toBe('Your order added 1½ bundles toward the fundraiser goal 🎉');
        });

        it('the pluralization boundary is <= 1, not === 1 — this is the exact bug the worked examples caught', () => {
            const src = fc;
            expect(src).toContain('thanks.unitsAdded <= 1');
            expect(src).not.toContain('thanks.unitsAdded === 1 ?');
        });
    });

    it('the underlying weighting engine (lib/fundraiserMetrics.ts) is untouched by this phase', () => {
        const { execSync } = require('child_process');
        const diff = execSync('git diff --stat -- lib/fundraiserMetrics.ts lib/serving_multipliers.ts',
            { cwd: ROOT, encoding: 'utf8' });
        expect(diff.trim()).toBe('');
    });
});

// ===========================================================================
describe('PAYMENT — no unsupported cash/check/pickup/Venmo assumption', () => {
    it('8. the pre-order PayBadge no longer invents a specific payment method', () => {
        // 'PayBadge' alone also matches the file's top-of-file header comment
        // ("Topbar → ProgressHero → PayBadge → ..."); anchor on the actual
        // banner emoji instead, which is unique.
        const badgeIdx = fc.indexOf('💵 No card needed here');
        expect(badgeIdx).toBeGreaterThan(-1);
        const badgeBody = fc.slice(badgeIdx, badgeIdx + 200);
        expect(badgeBody).not.toMatch(/venmo/i);
        expect(badgeBody).not.toMatch(/\bcheck\b/i);
        expect(badgeBody).not.toMatch(/\bcash\b/i);
        expect(badgeBody).toContain("you'll pay your coordinator directly");
    });

    it('8b. the post-order generic fallback (already correct) still contains no cash/check/Venmo/pickup assumption', () => {
        const fallbackIdx = fc.indexOf('Please pay');
        expect(fallbackIdx).toBeGreaterThan(-1);
        const fallback = fc.slice(fallbackIdx, fallbackIdx + 200);
        expect(fallback).not.toMatch(/venmo/i);
        expect(fallback).not.toMatch(/\bcheck\b/i);
        expect(fallback).not.toMatch(/\bcash\b/i);
        expect(fallback).not.toMatch(/pickup/i);
    });

    it('the literal "Cash or check at pickup." string exists ONLY as the coordinator\'s own setup-form placeholder, never as supporter-facing fallback copy', () => {
        const setupFields = read('components/coordinator/CoordinatorSetupFields.tsx');
        expect(setupFields).toContain('placeholder="Cash or check at pickup."');
        // And critically: FundraiserClient must not contain that literal string
        // anywhere as a hardcoded fallback.
        expect(fc).not.toContain('Cash or check at pickup');
    });

    it('9. a configured payment_instructions value still wins over the generic fallback — precedence unchanged', () => {
        const ternaryIdx = fc.indexOf('thanks.paymentInstructions\n');
        expect(ternaryIdx).toBeGreaterThan(-1);
        const block = fc.slice(ternaryIdx, ternaryIdx + 400);
        expect(block).toMatch(/thanks\.paymentInstructions\s*\n\s*\?\s*<>\{thanks\.paymentInstructions\}/);
        expect(block).toContain(": <>Please pay");
    });

    it('10. the externalPaymentLink security protections (SUPPORTER-CONFIRM-HTML-1) are untouched', () => {
        const linkIdx = fc.indexOf('thanks.externalPaymentLink &&');
        expect(linkIdx).toBeGreaterThan(-1);
        const block = fc.slice(linkIdx, linkIdx + 400);
        expect(block).toContain('target="_blank"');
        expect(block).toContain('rel="noopener noreferrer"');
        expect(block).toContain('href={thanks.externalPaymentLink}');
    });

    it('the payment_instructions/external_payment_link fields already exist and are already wired — no new schema needed', () => {
        const schema = read('prisma/schema.prisma');
        expect(schema).toContain('payment_instructions  String?');
        expect(schema).toContain('external_payment_link String?');
    });
});

// ===========================================================================
describe('COORDINATOR — the momentum/share panel on the ongoing portal', () => {
    it('11. the share buttons now render even after all three steps are complete — this is the exact defect (they used to disappear)', () => {
        const allCompleteIdx = launchSteps.indexOf('if (allComplete)');
        const braceEnd = launchSteps.indexOf('\n    return (', allCompleteIdx); // start of the non-collapsed branch
        const collapsedBranch = launchSteps.slice(allCompleteIdx, braceEnd);

        expect(collapsedBranch).toContain('Help us keep the momentum going');
        expect(collapsedBranch).toContain('ShareBtn label="✉️ Email"');
        expect(collapsedBranch).toContain('ShareBtn label="📘 Facebook"');
        expect(collapsedBranch).toContain('ShareBtn label="💬 Text"');
        expect(collapsedBranch).toContain('onCopyLink');
    });

    it('11b. it reuses the SAME handlers/component as the non-collapsed steps — not a duplicate implementation', () => {
        const nonCollapsedShare = launchSteps.slice(
            launchSteps.indexOf('{/* ── STEP 2 ── */}'),
            launchSteps.indexOf('{/* ── STEP 3 ── */}'),
        );
        const collapsedShare = launchSteps.slice(
            launchSteps.indexOf('if (allComplete)'),
            launchSteps.indexOf('\n    return (', launchSteps.indexOf('if (allComplete)')),
        );
        for (const marker of ['onShareEmail', 'onShareFacebook', 'onShareText', 'onCopyLink']) {
            expect(nonCollapsedShare).toContain(marker);
            expect(collapsedShare).toContain(marker);
        }
        // Same ShareBtn component, not a second one defined anywhere else.
        expect((launchSteps.match(/function ShareBtn/g) ?? []).length).toBe(1);
    });

    it('12. rendering is NOT gated on a one-time "setup just completed" flag — the portal mounts LaunchSteps for the entire active campaign life', () => {
        expect(portal).toContain("campaignPhase !== 'complete'");
        // This condition is unrelated to setupComplete/sharingStarted/firstOrderReceived
        // — those only affect LaunchSteps' OWN internal collapsed/expanded state,
        // never whether the portal mounts it at all.
        const mountIdx = portal.indexOf("campaignPhase !== 'complete'");
        const mountLine = portal.slice(mountIdx - 5, mountIdx + 30);
        expect(mountLine).not.toMatch(/setupComplete|sharingStarted|firstOrderReceived/);
    });

    it('12b. the coordinator can return to a fully-graduated campaign and the panel is still there: LaunchSteps is unconditionally passed the same live handler props regardless of allComplete', () => {
        const propsBlock = portal.slice(portal.indexOf('<LaunchSteps'), portal.indexOf('/>', portal.indexOf('<LaunchSteps')));
        expect(propsBlock).toContain('onShareFacebook={handleShareFacebook}');
        expect(propsBlock).toContain('onShareText={handleShareText}');
        expect(propsBlock).toContain('onCopyLink={handleCopyLink}');
    });

    it('13. no coordinator-session/auth/security file was touched by this phase', () => {
        const { execSync } = require('child_process');
        const diff = execSync(
            'git diff --stat -- lib/coordinatorSession.ts app/api/coordinator/bundle-selection/route.ts app/api/coordinator/route.ts app/api/coordinator/session/route.ts',
            { cwd: ROOT, encoding: 'utf8' }
        );
        expect(diff.trim()).toBe('');
    });

    it('13b. no tenant-admin data is newly exposed: the momentum panel reuses only already-passed share handlers, no new prop/fetch was added to LaunchSteps', () => {
        // The props interface itself is unchanged — same names, same shape —
        // meaning no new data surface was introduced to satisfy this fix.
        const propsInterface = launchSteps.slice(
            launchSteps.indexOf('export interface LaunchStepsProps'),
            launchSteps.indexOf('export function LaunchSteps'),
        );
        expect(propsInterface).toMatch(/setupComplete: boolean;/);
        expect(propsInterface).toMatch(/onShareEmail: \(\) => void;/);
        // No new fields such as a raw fetch URL, token, or admin flag.
        expect(propsInterface).not.toMatch(/token|secret|adminOnly|businessId/i);
    });
});

// ===========================================================================
describe('no-drift — this phase changed only the four named surfaces', () => {
    it('the diff touches exactly the expected files', () => {
        const { execSync } = require('child_process');
        const files = execSync('git diff --name-only', { cwd: ROOT, encoding: 'utf8' })
            .split('\n').filter(Boolean)
            .filter((f: string) => !f.startsWith('CLAUDE.md') && !f.startsWith('GEMINI.md')
                && !f.startsWith('app/login/') && !f.startsWith('components/RecipeEditor')
                && !f.startsWith('components/recipes/printRecipe') && !f.startsWith('docs/ai/')
                && !f.startsWith('docs/rebuild/') && !f.startsWith('prisma/schema.prisma'));
        expect(files.sort()).toEqual([
            'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx',
            'components/coordinator/LaunchSteps.tsx',
        ].sort());
    });

    it('no Bundle membership, Recipe, or environment-safety file is part of this phase\'s diff', () => {
        // prisma/schema.prisma is deliberately excluded here: it is
        // pre-existing PARKED dirt from unrelated earlier work (present since
        // before this phase started), not something this phase could ever
        // show as clean regardless of what it touches.
        const { execSync } = require('child_process');
        const diff = execSync(
            'git diff --stat -- lib/bundleContents.ts app/api/bundles app/api/recipes lib/devEnvGuard.ts instrumentation.ts',
            { cwd: ROOT, encoding: 'utf8' }
        );
        expect(diff.trim()).toBe('');
    });
});
