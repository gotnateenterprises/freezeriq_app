/**
 * COORD-POLISH-1 — three small, presentation-only coordinator UI changes,
 * approved after the owner accepted View Supporter Page, optional supporter
 * email, and Preview-host preservation:
 *
 *   1. View Supporter Page — visually more prominent than the plain QR/
 *      Flyer/Scoreboard utility row, using the SAME indigo accent already
 *      used elsewhere on this panel (Copy button, AI button) — not a new
 *      color token, not a new icon dependency (lucide-react's ExternalLink
 *      is already an installed dependency, just newly imported here).
 *   2. Email (Optional) — a small helper sentence directly beneath the
 *      field. Copy only: no checkbox, no consent field, no change to
 *      Order.email behavior.
 *   3. The bottom "Downloads" action is relabeled "Printable Tracker".
 *      Label only: same handler, same route, same file.
 *
 * Source-string assertions, sliced to exact blocks — this repo has no
 * @testing-library/react / jsdom (jest.config.ts pins testEnvironment:
 * 'node' project-wide); introducing one for three copy/style tweaks would be
 * exactly the redesign this phase forbids.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SHARE_CENTER = 'components/coordinator/ShareCenter.tsx';
const QUIET_LINKS = 'components/coordinator/QuietLinks.tsx';
const PORTAL = 'app/coordinator/portal/page.tsx';
const TRACKER_ROUTE = 'app/api/tracker/download/route.ts';
const COORD_ROUTE = 'app/api/coordinator/route.ts';

const HELPER_COPY = 'With permission, save their email so you can reconnect for a future fundraiser.';

// ═════════════════════════════════════════════════════════════════════════════
// 1-4. View Supporter Page — still renders, same href, new tab, more prominent.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-4. View Supporter Page', () => {
    const src = strip(read(SHARE_CENTER));

    it('1. still renders with the exact required label', () => {
        expect(src).toContain('View Supporter Page');
    });

    it('2. its href is the unchanged shareUrl authority (same identifier the Copy row displays/copies)', () => {
        expect(src).toContain('href={shareUrl} label="View Supporter Page"');
        expect(src).toContain('{shareUrl.replace(');
    });

    it('3. still opens in a new tab with the same rel authority', () => {
        const block = src.slice(src.indexOf('function PrimaryMiniLink'), src.indexOf('function PrimaryMiniLink') + 400);
        expect(block).toContain('target="_blank"');
        expect(block).toContain('rel="noreferrer"');
    });

    it('4. receives a distinct, more prominent treatment than the plain QR/Flyer/Scoreboard row, via an existing brand accent', () => {
        // Rendered via a DIFFERENT component than the plain utility links.
        const line = src.split('\n').find((l) => l.includes('label="View Supporter Page"'));
        expect(line).toMatch(/<PrimaryMiniLink\b/);
        expect(line).not.toMatch(/<MiniLink\b/);

        // The plain utility links (QR/Flyer/Scoreboard) share one neutral
        // treatment via MiniLink, so the contrast with View Supporter Page
        // is real. COORD-SHARE-CENTER-POLISH-2 relabeled them (see that
        // phase's own suite); the conditional-rendering wiring is unchanged.
        expect(src).toContain('<MiniLink href={qrHref} label=');
        expect(src).toContain('<MiniLink href={flyerHref} label=');
        expect(src).toContain('<MiniLink href={scoreboardHref} label=');

        // PrimaryMiniLink reuses the indigo-50/indigo-700 pairing already on
        // this exact panel's AI button — an existing accent, not invented.
        const primaryBlock = src.slice(src.indexOf('function PrimaryMiniLink'), src.indexOf('function PrimaryMiniLink') + 400);
        expect(primaryBlock).toMatch(/bg-indigo-50/);
        expect(primaryBlock).toMatch(/text-indigo-700/);
        expect(src).toMatch(/bg-indigo-50[^"]*text-indigo-700|text-indigo-700[^"]*bg-indigo-50/); // AI button, same pairing, proves reuse not invention

        // And it must not overpower the panel's true primary action (Copy),
        // which stays a solid indigo-600 fill — PrimaryMiniLink must not
        // also claim that solid fill.
        expect(primaryBlock).not.toMatch(/bg-indigo-600/);
    });

    it('no new icon dependency was added — ExternalLink comes from the already-installed lucide-react package', () => {
        const raw = read(SHARE_CENTER);
        expect(raw).toContain("from 'lucide-react'");
        const pkg = JSON.parse(read('package.json'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        expect(deps).toHaveProperty('lucide-react');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5-9. Email (Optional) — helper copy, still optional, persistence unchanged.
// ═════════════════════════════════════════════════════════════════════════════
describe('5-9. Email (Optional) helper copy, with persistence regression', () => {
    const src = read(PORTAL);

    it('5. Email (Optional) still renders', () => {
        expect(src).toContain('Email (Optional)');
    });

    it('6. the exact approved helper sentence renders directly with the Email field (same space-y-1 wrapper, after the input)', () => {
        const labelIdx = src.indexOf('Email (Optional)');
        const wrapperStart = src.lastIndexOf('<div className="space-y-1">', labelIdx);
        // Two nested </div> closes after the label: first ends the input's
        // wrapping "relative" div, second ends the space-y-1 field wrapper
        // itself (the helper <p> is a plain sibling with no div of its own).
        const relativeDivClose = src.indexOf('</div>', labelIdx);
        const wrapperEnd = src.indexOf('</div>', relativeDivClose + '</div>'.length);
        const fieldBlock = src.slice(wrapperStart, wrapperEnd + '</div>'.length);
        expect(fieldBlock).toContain(HELPER_COPY);
        // Directly beneath the input, not detached elsewhere in the form.
        const inputIdx = fieldBlock.indexOf('value={formData.email}');
        const helperIdx = fieldBlock.indexOf(HELPER_COPY);
        expect(inputIdx).toBeGreaterThan(-1);
        expect(helperIdx).toBeGreaterThan(inputIdx);
    });

    it('7. Email remains optional — no `required` attribute, no checkbox, no consent field added', () => {
        const emailFieldStart = src.indexOf('type="email"');
        const tagStart = src.lastIndexOf('<input', emailFieldStart);
        const tagEnd = src.indexOf('/>', emailFieldStart);
        const tag = src.slice(tagStart, tagEnd);
        expect(tag).not.toMatch(/\brequired\b/);
        expect(src).not.toMatch(/type="checkbox"[\s\S]{0,200}Email/);
        expect(src).not.toMatch(/consent/i);
    });

    it('8. Email persistence is unchanged — still writes to Order.email via the existing normalized-email path', () => {
        const route = strip(read(COORD_ROUTE));
        expect(route).toContain('const normalizedEmail = normalizeSupporterEmail(email);');
        expect(route).toContain('email: normalizedEmail || null,');
    });

    it('9. Customer.contact_email remains untouched — no customer write exists in the manual-order create path', () => {
        const route = strip(read(COORD_ROUTE));
        expect(route).not.toMatch(/customer\.update\(|customer\.upsert\(/);
        expect(route).not.toMatch(/contact_email:\s*normalizedEmail/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10-12. Printable Tracker rename — label only, same handler, same export.
// ═════════════════════════════════════════════════════════════════════════════
describe('10-12. Printable Tracker (was "Downloads")', () => {
    it('10. the action previously labeled Downloads now renders "Printable Tracker", and never the forbidden alternatives', () => {
        const src = read(QUIET_LINKS);
        expect(src).toContain('Printable Tracker');
        expect(src).not.toContain('>Downloads<');
        expect(src).not.toMatch(/Tracker Excel|Excel Tracker/);
    });

    it('11. the renamed action still calls the exact same handler prop — no new click target', () => {
        const src = strip(read(QUIET_LINKS));
        expect(src).toContain('<button onClick={onOpenDownloads} className="font-medium hover:text-slate-700">Printable Tracker</button>');

        // The portal still wires the SAME handler function into that prop.
        const portal = strip(read(PORTAL));
        expect(portal).toContain('onOpenDownloads={handleDownloadTracker}');
    });

    it('12. the underlying download destination and generated file are byte-for-byte unchanged', () => {
        const portal = strip(read(PORTAL));
        const handler = portal.slice(
            portal.indexOf('const handleDownloadTracker'),
            portal.indexOf('};', portal.indexOf('const handleDownloadTracker')),
        );
        expect(handler).toContain("fetch('/api/tracker/download')");
        expect(handler).toContain("a.download = 'order-tracker.xlsx';");

        // The route itself — export behavior — was not touched by this phase.
        const route = strip(read(TRACKER_ROUTE));
        expect(route).toContain('requireCoordinatorSession(req)');
        expect(route).toContain('buildTrackerFamilies');
        expect(route).toContain('populateTrackerWorksheet');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15-18. Scope — presentation-only, verified against the actual git diff.
// ═════════════════════════════════════════════════════════════════════════════
describe('15-18. scope stayed presentation-only', () => {
    // Every file this phase is allowed to have modified. Test files included,
    // since this phase also updates the regression suites its own change broke.
    //
    // This check runs against LIVE `git status`, not a frozen commit range, so
    // a later, separately-authorized phase that also touches ShareCenter.tsx
    // legitimately adds its own file to this list — COORD-SHARE-CENTER-
    // POLISH-2 is exactly that: it refined the same component further and
    // added its own dedicated test file. Extending this allowlist is the
    // deliberate acknowledgment of that later, in-scope change, not a
    // loosening of what THIS phase's own diff was.
    const ALLOWED = new Set([
        'components/coordinator/ShareCenter.tsx',
        'components/coordinator/QuietLinks.tsx',
        'app/coordinator/portal/page.tsx',
        'tests/coordPublicPreview1.test.ts',
        'tests/coordManualEmail1b.test.ts',
        'tests/coordPolish1.test.ts',
        'tests/coordShareCenterPolish2.test.ts',
    ]);

    it('15/16/17/18. the working-tree diff touches only the three UI files (+ their regression tests) — no API route, schema, migration, kitchen, Delivery, packaging, payment or invoice file', () => {
        const out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
        const changed = out
            .split('\n')
            .filter(Boolean)
            .map((l) => l.slice(3).trim())
            // Pre-existing parked dirt this phase must not disturb further —
            // excluded here because it predates this phase, not because this
            // phase is allowed to touch it (session-wide constraint, not
            // re-litigated by this test).
            .filter((f) => !f.startsWith('.claude/'))
            .filter((f) => !['CLAUDE.md', 'GEMINI.md', 'app/login/page.tsx', 'components/RecipeEditor.tsx',
                'components/recipes/printRecipe.ts', 'docs/ai/UI_REDESIGN_SPEC.md', 'docs/rebuild/phase-roadmap.md',
                'prisma/schema.prisma'].includes(f))
            .filter((f) => !f.startsWith('app/api/auth/forgot-password/') && !f.startsWith('app/api/auth/reset-password/')
                && !f.startsWith('app/forgot-password/') && !f.startsWith('app/reset-password/')
                && !['check-all.ts', 'prisma-check.ts', 'prisma-real-supabase-check.ts', 'prisma-real-supabase-check2.ts', 'prisma-supabase-check.ts'].includes(f)
                && !f.startsWith('docs/ai/visual-reviews/') && !f.startsWith('docs/franchise/') && !f.startsWith('review_exports/'));

        for (const f of changed) {
            expect(ALLOWED.has(f)).toBe(true);
        }
        // And explicitly: no path under these directories appears at all.
        const forbidden = /^(prisma\/migrations|app\/api\/|lib\/kitchen_engine|lib\/cost_engine|lib\/deliveryPackaging|lib\/physicalBoxPacking|app\/delivery|app\/production|app\/api\/checkout|app\/api\/webhooks|app\/api\/invoices|lib\/pricing)/;
        for (const f of changed) {
            expect(f).not.toMatch(forbidden);
        }
    });

    it('no migration directory was created by this phase', () => {
        const out = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT, encoding: 'utf8' });
        expect(out).not.toMatch(/prisma\/migrations\//);
    });
});
