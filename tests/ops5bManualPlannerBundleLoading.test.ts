/**
 * OPS-5B — Manual Planner Bundle dropdown recovery.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 (reuse the
 * canonical authorities, never re-derive them).
 *
 * OWNER-OBSERVED DEFECT, freshly traced (not assumed) at dcbc86e: on the
 * exact READY OPS-5A preview, Production -> Manual Planner rendered a
 * "Select a bundle..." dropdown with ZERO options, for a tenant proven (via
 * read-only Production Supabase verification) to have 10 active Bundles.
 * Vercel runtime logs for that exact deployment (dpl_FVKAcddWatfNNtkj5RQj8ohKZdH4)
 * show /production, /api/production/dashboard and /api/tenant/branding all
 * succeeding, but ZERO requests ever reaching /api/bundles -- the fetch never
 * left the browser.
 *
 * ROOT CAUSE. components/production/ProductionCalculator.tsx's mount effect
 * gated its ENTIRE body -- including the Bundle fetch -- behind
 * `if (!businessId) return;`, where businessId is a derived field read off
 * the CLIENT's own useSession() session object. Every sibling fetch that DID
 * succeed on the same page load (Kitchen Board's /api/production/dashboard,
 * TenantThemeProvider's /api/tenant/branding) resolves tenant scope
 * server-side via auth() and is not gated by any client session field at
 * all. app/customers/page.tsx already establishes the correct, working
 * pattern for a client-side gate: NextAuth's own resolved `status` field
 * (`status === 'authenticated'`), not a value mirrored off of it. This phase
 * reuses that exact pattern rather than inventing a third one.
 *
 * git diff 0038d1d9..dcbc86e -- components/production/ProductionCalculator.tsx
 * proves OPS-5/OPS-5A never touched this effect at all (byte-identical) --
 * this is a PRE-EXISTING defect, exposed during OPS-5A owner acceptance, not
 * something either phase introduced.
 *
 * app/api/bundles/route.ts (tenant scope, is_active filter) is untouched by
 * this phase and remains fully covered by tests/opsManualPlannerBundleFilter1.test.ts.
 * This suite only proves the CLIENT no longer prevents a legitimate,
 * already-correct request from ever being sent.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FILE = 'components/production/ProductionCalculator.tsx';

/** The useEffect that actually issues the Bundle fetch, isolated by its own braces. */
function bundleEffectBlock(src: string): string {
    const fetchIdx = src.indexOf("fetch('/api/bundles?activeOnly=true')");
    if (fetchIdx === -1) throw new Error('Bundle fetch call not found in source');
    const effectStart = src.lastIndexOf('useEffect(() => {', fetchIdx);
    const depsStart = src.indexOf('}, [', fetchIdx);
    if (effectStart === -1 || depsStart === -1) throw new Error('Could not isolate the Bundle-fetch effect');
    return src.slice(effectStart, depsStart);
}

// ═════════════════════════════════════════════════════════════════════════════
// PART B / C — root-cause pin. FAILS against the unfixed source: the fetch
// sits inside the SAME businessId-gated block that blocked it in production.
// ═════════════════════════════════════════════════════════════════════════════
describe('the Bundle-load effect is not gated behind the client businessId field', () => {
    it('DEFECT: the effect containing the Bundle fetch does not early-return on !businessId', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).not.toMatch(/if\s*\(\s*!businessId\s*\)\s*return;/);
    });

    it('FIX: the effect instead gates on NextAuth\'s own resolved status, matching the established app/customers/page.tsx pattern', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).toMatch(/status\s*!==\s*['"]authenticated['"]/);

        // Prove this is genuinely the SAME idiom already used elsewhere, not a
        // new invention (Part D: reuse, do not introduce a new authority).
        const customersSrc = strip(read('app/customers/page.tsx'));
        expect(customersSrc).toMatch(/status\s*===\s*['"]authenticated['"]/);
    });

    it('useSession is destructured for status, not just data', () => {
        const src = strip(read(FILE));
        expect(src).toMatch(/const\s*\{\s*data:\s*session,\s*status\s*\}\s*=\s*useSession\(\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART F / M5 — a fetch failure must be visible, never a silent empty list.
// ═════════════════════════════════════════════════════════════════════════════
describe('a failed or malformed Bundle response is never mistaken for "zero Bundles"', () => {
    it('DEFECT: the raw response is checked for res.ok before being parsed', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).toMatch(/if\s*\(\s*!res\.ok\s*\)/);
    });

    it('DEFECT: the parsed payload is verified to be an array before being trusted as the Bundle list', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).toMatch(/Array\.isArray\(data\)/);
    });

    it('DEFECT: the failure path sets a distinct error state rather than swallowing the error into an empty options list', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).toMatch(/\.catch\(/);
        expect(block).toMatch(/setBundlesLoadState\(\s*['"]error['"]\s*\)/);
    });

    it('a genuine zero-Bundle tenant and a fetch failure render DIFFERENT, truthful messages -- neither is fabricated data', () => {
        const src = strip(read(FILE));
        const selectRegion = src.slice(src.indexOf('<select'), src.indexOf('{bundles.map(b =>'));
        expect(selectRegion).toMatch(/bundlesLoadState === 'loading'/);
        expect(selectRegion).toMatch(/bundlesLoadState === 'error'/);
        expect(selectRegion).toMatch(/bundles\.length === 0/);
        // Three distinct human-readable strings, not one blanket placeholder.
        expect(selectRegion).toMatch(/Loading Bundles/);
        expect(selectRegion).toMatch(/Unable to load Bundles/);
        expect(selectRegion).toMatch(/No active Bundles/);
    });

    it('a visible operational error banner is wired to the same error state the catch handler sets', () => {
        const src = strip(read(FILE));
        const headerRegion = src.slice(src.indexOf('What are we making?'), src.indexOf('{orders.map'));
        expect(headerRegion).toMatch(/bundlesLoadState === 'error'/);
        expect(headerRegion).toMatch(/Unable to load Bundles\. Please refresh and try again\./);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// M6 — no hardcoded tenant/Bundle identity anywhere in the loader.
// ═════════════════════════════════════════════════════════════════════════════
describe('the Bundle loader carries no hardcoded tenant or Bundle identity', () => {
    it('no literal business/tenant name is present', () => {
        const src = read(FILE);
        expect(src).not.toMatch(/my\s*freezer\s*chef/i);
    });

    it('no literal business_id or bundle id is passed to the fetch', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).not.toMatch(/business_id\s*[:=]\s*['"]/);
        expect(block).toMatch(/fetch\(['"`]\/api\/bundles\?activeOnly=true['"`]\)/);
    });

    it('the endpoint and its activeOnly contract are unchanged (OPS-MANUAL-PLANNER-BUNDLE-FILTER-1 preserved)', () => {
        const src = strip(read(FILE));
        expect(src).toMatch(/fetch\(['"`]\/api\/bundles\?activeOnly=true['"`]\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Regression: the OTHER, legitimate businessId gate (per-tenant localStorage
// namespacing) is untouched -- this phase narrows ONE effect, not the pattern
// everywhere it is genuinely correct.
// ═════════════════════════════════════════════════════════════════════════════
describe('regression: localStorage restoration is still tenant-namespaced by businessId', () => {
    it('the localStorage-restore effect still early-returns on !businessId', () => {
        const src = strip(read(FILE));
        const queueIdx = src.indexOf('_productionQueue');
        const restoreEffectStart = src.lastIndexOf('useEffect(() => {', queueIdx);
        const guardRegion = src.slice(restoreEffectStart, queueIdx);
        expect(guardRegion).toMatch(/if\s*\(\s*!businessId\s*\)\s*return;/);
    });

    it('the Bundle-load effect and the localStorage-restore effect are two distinct effects', () => {
        const src = strip(read(FILE));
        const bundleBlock = bundleEffectBlock(src);
        expect(bundleBlock).not.toMatch(/_productionQueue/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// M7 — selected Bundle -> Calculate Plan path is untouched by this phase.
// Reuses the existing OPS-4A authority rather than re-testing it here.
// ═════════════════════════════════════════════════════════════════════════════
describe('M7: the selected-Bundle -> Calculate Plan path is unaffected', () => {
    it('calculatePlan and updateOrder are byte-identical to their OPS-4A-pinned shape', () => {
        const src = strip(read(FILE));
        const calcFn = src.slice(src.indexOf('const calculatePlan'), src.indexOf('const getSupplierSearchUrl'));
        // A row without a selected Bundle (or a non-positive quantity) must
        // never reach the plan request -- this is the actual "selected
        // Bundle -> Calculate Plan" path Part K exercises by hand.
        expect(calcFn).toMatch(/orders\.filter\(o\s*=>\s*o\.bundle_id\s*&&\s*o\.quantity\s*>\s*0\)/);
        expect(calcFn).toMatch(/variant_size\s*!=\s*null/);
        expect(calcFn).toMatch(/JSON\.stringify\(\{\s*syncedOrders,\s*manualOrders\s*\}\)/);

        const updateFn = src.slice(src.indexOf('const updateOrder'), src.indexOf('const addRow'));
        expect(updateFn).toMatch(/field === 'bundle_id'/);
        expect(updateFn).toMatch(/variant_size:\s*undefined/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// No schema change, no route change (Part D / out-of-scope compliance).
// ═════════════════════════════════════════════════════════════════════════════
describe('no schema change, no Bundle API route change', () => {
    it('app/api/bundles/route.ts is unmodified by this phase', () => {
        // Structural pin: the exact tenant + is_active predicate this phase
        // depends on, established by OPS-MANUAL-PLANNER-BUNDLE-FILTER-1.
        const src = read('app/api/bundles/route.ts');
        expect(src).toMatch(/business_id:\s*session\.user\.businessId/);
        expect(src).toMatch(/\.\.\.\(activeOnly \? \{ is_active: true \} : \{\}\)/);
    });
});
