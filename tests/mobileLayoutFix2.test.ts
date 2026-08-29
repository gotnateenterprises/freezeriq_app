/**
 * MOBILE-LAYOUT-FIX-2 — the shared <main> is a FLEX ITEM and must be allowed
 * to shrink to the viewport.
 *
 * ── THE DEFECT THIS CLOSES ───────────────────────────────────────────────────
 *
 * components/LayoutWrapper.tsx renders:
 *     <div className="flex ... w-full">        <- flex CONTAINER
 *         <main className="flex-1 ...">        <- flex ITEM
 *
 * Per the CSS Flexbox spec, a flex item's default `min-width: auto` resolves to
 * its MIN-CONTENT width — the item refuses to shrink below the widest
 * unbreakable thing inside it. On the public fundraiser page the sticky topbar
 * contains a `white-space: nowrap` campaign title (~448px min-content) plus a
 * nowrap tenant badge (~119px), giving <main> a 647px min-content floor. On a
 * 412px phone <main> therefore rendered at 647px and 235px of the page — 36% —
 * sat off-screen.
 *
 * ── WHY TWO PRIOR PASSES MISSED IT ──────────────────────────────────────────
 *
 * `overflow-x: clip` (app/globals.css + LayoutWrapper) DELETED those 235px
 * instead of exposing them, so `document.documentElement.scrollWidth` reported
 * 412 — equal to clientWidth — and every `scrollWidth <= clientWidth` assertion
 * PASSED while real phones stayed broken. Measured, pre-fix, at 412px:
 *     main.getBoundingClientRect().width .... 647   <- the truth
 *     document.documentElement.scrollWidth .. 412   <- the lie
 * Any future mobile check must assert element RECTANGLES, not scrollWidth.
 *
 * Prior passes added `min-w-0` / `minWidth: 0` to individual elements INSIDE
 * the page (topbar title, tenant badge, order rows, the contact grid). Those
 * were all correct and are retained — but they were powerless while the shared
 * <main> above them was itself oversized. This fixes the outermost link.
 *
 * ── WHY THESE TESTS ARE STRUCTURAL ──────────────────────────────────────────
 *
 * Jest/jsdom has no layout engine (getBoundingClientRect returns zeros), so the
 * runtime rectangle assertions that actually caught this were performed in a
 * real browser against the real route. What is encoded here is the invariant
 * those measurements proved: every flex item in the shared layout chain must
 * carry an explicit min-width escape hatch. That is a RULE, not a spelling
 * check — it fails for any future element that reintroduces the same class of
 * bug, not merely for the exact string that caused this one.
 */
import fs from 'fs';
import path from 'path';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const LAYOUT = 'components/LayoutWrapper.tsx';
const GLOBALS = 'app/globals.css';
const FUNDRAISER = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';

/**
 * Pull the className string of the real <main> JSX element out of LayoutWrapper.
 * Anchored on `<main className=` specifically: this file's own documentation
 * mentions "<main>" in prose, and a bare `<main` match would slice the comment.
 */
function mainClassName(): string {
    const src = R(LAYOUT);
    const i = src.indexOf('<main className=');
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('>', i));
}

describe('MOBILE-LAYOUT-FIX-2 · the shared <main> flex item can shrink to the viewport', () => {
    it('1. <main> carries min-w-0 — without it, min-width:auto pins it to a 647px min-content floor', () => {
        expect(mainClassName()).toMatch(/\bmin-w-0\b/);
    });

    it('2. THE INVARIANT: every flex item in the shared layout declares an explicit min-width escape hatch', () => {
        const src = R(LAYOUT);
        // Any element using flex-1 (a flex item that is expected to absorb space)
        // must also neutralise the spec's `min-width: auto` default, or it can
        // silently refuse to shrink below its content and blow past the viewport.
        const flexItems = src.match(/className=\{?[`"'][^`"']*\bflex-1\b[^`"']*/g) ?? [];
        expect(flexItems.length).toBeGreaterThan(0);
        for (const item of flexItems) {
            expect(item).toMatch(/\bmin-w-0\b/);
        }
    });

    it('3. <main> is genuinely a flex item — the parent really is a flex container (so the rule above applies)', () => {
        const src = R(LAYOUT);
        const openDiv = src.slice(src.indexOf('<div className="flex'), src.indexOf('<main'));
        expect(openDiv).toMatch(/className="flex\b/);
    });

    it('4. the clipping that MASKED this defect is still present — so the fix is a real width fix, not clip removal', () => {
        // Retained deliberately: it is the backstop that keeps the page from
        // becoming horizontally draggable. It must never again be the "fix".
        expect(mainClassName()).toMatch(/\boverflow-x-clip\b/);
        expect(R(GLOBALS)).toMatch(/overflow-x:\s*clip/);
    });
});

describe('MOBILE-LAYOUT-FIX-2 · no zoom/scale workaround was introduced', () => {
    const files = [LAYOUT, GLOBALS, FUNDRAISER];

    it('5. no CSS `zoom` property anywhere in the layout chain', () => {
        for (const f of files) {
            // `zoom` is the single most tempting wrong fix for this symptom.
            expect(R(f)).not.toMatch(/(^|[^-\w])zoom\s*:/);
        }
    });

    it('5b. the LAYOUT containers are never scaled down (decorative particle keyframes are not page scaling)', () => {
        // Deliberately scoped to the layout authority rather than a blanket
        // /scale\(/ search: FundraiserClient legitimately animates confetti
        // particles with `scale(.85)` inside an absolutely-positioned
        // overflow:hidden decorative layer, which is not page scaling and must
        // not be mistaken for it.
        for (const f of [LAYOUT, GLOBALS]) {
            expect(R(f)).not.toMatch(/transform:\s*['"`]?\s*scale\s*\(/);
        }
        const fc = R(FUNDRAISER);
        const scaleUses = fc.match(/scale\([^)]*\)/g) ?? [];
        for (const use of scaleUses) {
            const at = fc.indexOf(use);
            const context = fc.slice(Math.max(0, at - 400), at);
            // Every scale() must belong to the confetti keyframes, never a container.
            expect(context).toMatch(/frConfetti|fr-confetti|@keyframes/);
        }
    });

    it('6. the viewport contract is untouched and correct: width=device-width at scale 1', () => {
        const root = R('app/layout.tsx');
        expect(root).toMatch(/width:\s*'device-width'/);
        expect(root).toMatch(/initialScale:\s*1\b/);
        // No hardcoded pixel layout viewport (which would itself cause this symptom).
        expect(root).not.toMatch(/width:\s*'\d+'/);
    });

    it('7. the fix is a width constraint, not a horizontal-scroll surrender', () => {
        // Making the page horizontally scrollable was explicitly not acceptable.
        expect(R(GLOBALS)).not.toMatch(/overflow-x:\s*(auto|scroll)/);
    });
});

describe('MOBILE-LAYOUT-FIX-2 · prior mobile guards are retained, not regressed', () => {
    const fc = R(FUNDRAISER);

    it('8. the topbar title and tenant badge keep their shrink+ellipsis guards (now actually reachable)', () => {
        expect(fc).toMatch(/minWidth: 0[^}]*whiteSpace: 'nowrap'[^}]*textOverflow: 'ellipsis'/);
        expect(fc).toContain("maxWidth: '40%'");
    });

    it('9. the contact-form grid keeps auto-fit + per-input minWidth:0', () => {
        expect(fc).toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))'");
        expect(fc).not.toContain("gridTemplateColumns: '1fr 1fr'");
    });

    it('10. the order-line row keeps its wrap escape valve', () => {
        expect(fc).toContain("flexWrap: 'wrap'");
    });

    it('11. the page column is capped by maxWidth (never a fixed width that could set a floor)', () => {
        expect(fc).toContain("maxWidth: '36rem'");
        expect(fc).not.toMatch(/[^x]width: '36rem'/);
    });
});
