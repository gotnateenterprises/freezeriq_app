/**
 * COORD-SHARE-CENTER-POLISH-2 — the four supporter-sharing tools (View
 * Supporter Page, QR, Flyer, Scoreboard) now sit inside one deliberate pale
 * emerald "tools" panel instead of reading as four loose buttons under the
 * copy box, and three of the four labels are clarified. Presentation only:
 * every href, handler, and conditional-rendering rule is unchanged.
 *
 * Source-string assertions, sliced to exact blocks — this repo has no
 * @testing-library/react / jsdom (jest.config.ts pins testEnvironment:
 * 'node' project-wide). Intent and behavior are protected, not exact
 * Tailwind class ordering: assertions check for the PRESENCE of the
 * relevant utility classes (e.g. `bg-emerald-50`), not a full className
 * string match, so a harmless class reorder cannot fail this suite.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SHARE_CENTER = 'components/coordinator/ShareCenter.tsx';

describe('COORD-SHARE-CENTER-POLISH-2', () => {
    const raw = read(SHARE_CENTER);
    const src = strip(raw);

    // ═════════════════════════════════════════════════════════════════════
    // 1-2. A dedicated wrapper groups the four actions with a subtle treatment.
    // ═════════════════════════════════════════════════════════════════════
    describe('1-2. the tool panel wrapper', () => {
        it('1. a dedicated wrapper visually groups all four supporter-tool actions (View Supporter Page + the three conditional links) inside one container', () => {
            const wrapperStart = src.indexOf('rounded-2xl border border-emerald-200');
            expect(wrapperStart).toBeGreaterThan(-1);
            // The wrapper's own closing tag — find the matching </div> for
            // the outer emerald container by locating the next occurrence of
            // the AI button (or section close) after it, and confirm all
            // four link calls fall inside that span.
            const afterWrapper = src.indexOf('onOpenAi &&', wrapperStart) > -1
                ? src.indexOf('onOpenAi &&', wrapperStart)
                : src.indexOf('</section>', wrapperStart);
            const panel = src.slice(wrapperStart, afterWrapper);
            expect(panel).toContain('PrimaryMiniLink href={shareUrl} label="View Supporter Page"');
            expect(panel).toContain('label="Printable QR Code"');
            expect(panel).toContain('label="Printable Flyer"');
            expect(panel).toContain('label="Share Scoreboard"');
        });

        it('2. the wrapper uses a subtle pale-green/mint treatment — no saturated color, no heavy shadow', () => {
            const wrapperStart = src.indexOf('rounded-2xl border border-emerald-200');
            const wrapperTag = src.slice(wrapperStart, src.indexOf('>', wrapperStart));
            // Pale variants only (the -50/-200 shades this codebase already
            // uses for calm, positive panels — see BundleSelectionStep).
            expect(wrapperTag).toMatch(/bg-emerald-50/);
            expect(wrapperTag).toMatch(/border-emerald-200/);
            // Not a saturated/solid fill and not a heavy shadow.
            expect(wrapperTag).not.toMatch(/bg-emerald-[4-9]00/);
            expect(wrapperTag).not.toMatch(/shadow-(lg|xl|2xl)/);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 3-5. View Supporter Page remains the emphasized action, href/tab intact.
    // ═════════════════════════════════════════════════════════════════════
    describe('3-5. View Supporter Page', () => {
        it('3. remains the emphasized action — the only one of the four rendered via PrimaryMiniLink', () => {
            const line = src.split('\n').find((l) => l.includes('label="View Supporter Page"'));
            expect(line).toMatch(/<PrimaryMiniLink\b/);
            for (const label of ['Printable QR Code', 'Printable Flyer', 'Share Scoreboard']) {
                const l = src.split('\n').find((ln) => ln.includes(`label="${label}"`));
                expect(l).toMatch(/<MiniLink\b/);
                expect(l).not.toMatch(/<PrimaryMiniLink\b/);
            }
            // PrimaryMiniLink itself still carries a distinct indigo accent,
            // not the neutral treatment shared by the other three.
            const primaryBlock = src.slice(src.indexOf('function PrimaryMiniLink'), src.indexOf('function PrimaryMiniLink') + 400);
            expect(primaryBlock).toMatch(/text-indigo-700/);
        });

        it('4. href is the unchanged shareUrl authority — no second URL formula', () => {
            expect(src).toContain('href={shareUrl} label="View Supporter Page"');
            expect(src).toContain('{shareUrl.replace(');
            expect(src).not.toMatch(/\/shop\/|\/fundraiser\/|window\.location|new URL\(/);
        });

        it('5. still opens in a new tab with the same rel authority', () => {
            const block = src.slice(src.indexOf('function PrimaryMiniLink'), src.indexOf('function PrimaryMiniLink') + 400);
            expect(block).toContain('target="_blank"');
            expect(block).toContain('rel="noreferrer"');
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 6-8. Updated labels.
    // ═════════════════════════════════════════════════════════════════════
    describe('6-8. clarified labels', () => {
        it('6. QR label reads "Printable QR Code"', () => {
            expect(src).toContain('label="Printable QR Code"');
            expect(src).not.toMatch(/label="QR code"/);
        });

        it('7. Flyer label reads "Printable Flyer"', () => {
            expect(src).toContain('label="Printable Flyer"');
            expect(src).not.toMatch(/label="Flyer"/);
        });

        it('8. Scoreboard label reads "Share Scoreboard"', () => {
            expect(src).toContain('label="Share Scoreboard"');
            expect(src).not.toMatch(/label="Scoreboard"/);
        });

        it('View Supporter Page label is explicitly unchanged', () => {
            expect(src).toContain('label="View Supporter Page"');
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 9-11. Underlying behavior for QR/Flyer/Scoreboard unchanged.
    // ═════════════════════════════════════════════════════════════════════
    describe('9-11. underlying QR/Flyer/Scoreboard behavior is unchanged', () => {
        it('9. QR: same conditional render on the same qrHref prop, same MiniLink primitive', () => {
            expect(src).toContain('{qrHref && <MiniLink href={qrHref} label="Printable QR Code" />}');
        });

        it('10. Flyer: same conditional render on the same flyerHref prop, same MiniLink primitive', () => {
            expect(src).toContain('{flyerHref && <MiniLink href={flyerHref} label="Printable Flyer" />}');
        });

        it('11. Scoreboard: same conditional render on the same scoreboardHref prop, same MiniLink primitive', () => {
            expect(src).toContain('{scoreboardHref && <MiniLink href={scoreboardHref} label="Share Scoreboard" />}');
        });

        it('the component props (qrHref/flyerHref/scoreboardHref/shareUrl) are unchanged in shape', () => {
            expect(src).toMatch(/qrHref\?:\s*string;\s*flyerHref\?:\s*string;\s*scoreboardHref\?:\s*string;/);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 12. Everything else in Share Center is untouched.
    // ═════════════════════════════════════════════════════════════════════
    describe('12. the rest of Share Center is untouched', () => {
        it('the public URL box and Copy button are unchanged', () => {
            expect(src).toContain('{shareUrl.replace(/^https?:\\/\\//, \'\')}');
            expect(src).toContain("onClick={onCopy}");
            expect(src).toContain("{copied ? 'Copied ✓' : 'Copy'}");
        });

        it('the "Write a message for me" / AI button is unchanged', () => {
            expect(src).toContain("aiLabel = '✨ Write a message for me'");
            expect(src).toContain('onClick={onOpenAi}');
        });

        it('the section heading and outer card are unchanged', () => {
            expect(src).toContain('id="share-center"');
            expect(src).toContain('Share Center</h3>');
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    // 16. Scope — presentation-only, verified against the actual git diff.
    // ═════════════════════════════════════════════════════════════════════
    describe('16. scope contains no backend/schema/migration files', () => {
        it('the working-tree diff touches only ShareCenter.tsx and test files', () => {
            const { execSync } = require('child_process');
            const out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
            const changed = out
                .split('\n')
                .filter(Boolean)
                .map((l: string) => l.slice(3).trim())
                .filter((f: string) => !f.startsWith('.claude/'))
                .filter((f: string) => !['CLAUDE.md', 'GEMINI.md', 'app/login/page.tsx', 'components/RecipeEditor.tsx',
                    'components/recipes/printRecipe.ts', 'docs/ai/UI_REDESIGN_SPEC.md', 'docs/rebuild/phase-roadmap.md',
                    'prisma/schema.prisma'].includes(f))
                .filter((f: string) => !f.startsWith('app/api/auth/forgot-password/') && !f.startsWith('app/api/auth/reset-password/')
                    && !f.startsWith('app/forgot-password/') && !f.startsWith('app/reset-password/')
                    && !['check-all.ts', 'prisma-check.ts', 'prisma-real-supabase-check.ts', 'prisma-real-supabase-check2.ts', 'prisma-supabase-check.ts'].includes(f)
                    && !f.startsWith('docs/ai/visual-reviews/') && !f.startsWith('docs/franchise/') && !f.startsWith('review_exports/'));

            for (const f of changed) {
                const allowed = f === SHARE_CENTER || f.startsWith('tests/');
                expect(allowed).toBe(true);
            }
            const forbidden = /^(prisma\/migrations|app\/api\/|lib\/kitchen_engine|lib\/cost_engine|lib\/deliveryPackaging|lib\/physicalBoxPacking|app\/delivery|app\/production|app\/api\/checkout|app\/api\/webhooks|app\/api\/invoices|lib\/pricing)/;
            for (const f of changed) {
                expect(f).not.toMatch(forbidden);
            }
        });

        it('no migration directory was created by this phase', () => {
            const { execSync } = require('child_process');
            const out = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT, encoding: 'utf8' });
            expect(out).not.toMatch(/prisma\/migrations\//);
        });
    });
});
