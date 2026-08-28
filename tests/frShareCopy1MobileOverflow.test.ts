/**
 * FR-SHARE-COPY-1 ADDENDUM — mobile right-edge clipping (Galaxy S24 Ultra).
 *
 * Root cause (full audit in the session record): TWO independent
 * `overflow-x: clip` boundaries (app/globals.css + components/LayoutWrapper.tsx)
 * make any overflow permanently unrecoverable — no scrollbar can exist under
 * `clip`, unlike `hidden`/`auto`. That mechanism was left in place on purpose
 * (the owner explicitly does not want the whole page horizontally scrollable);
 * these tests instead pin the actual overflow SOURCES that were removed, plus
 * the stacked-padding waste in the shared wrapper.
 *
 * Source-level, not live-DOM: this repo has no jsdom layout engine, so these
 * pin the exact CSS/className facts a browser resolves into "does it fit" —
 * the same discipline as every other FR-COORD-123 suite.
 */
import fs from 'fs';
import path from 'path';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const LAYOUT = 'components/LayoutWrapper.tsx';
const LOCKED_ROW = 'components/coordinator/CoordinatorSetupFields.tsx';
const FUNDRAISER = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const SCOREBOARD = 'app/fundraiser/[token]/ScoreboardClient.tsx';
const GLOBALS_CSS = 'app/globals.css';

// ── SHARED WRAPPER — NO DUPLICATE PAGE-LEVEL PADDING ────────────────────────
describe('FR-SHARE-COPY-1 · LayoutWrapper no longer stacks unconditional p-8 on the coordinator/fundraiser routes', () => {
    it('coordinator, fundraiser and shop routes all resolve to the SAME responsive padding branch', () => {
        const code = R(LAYOUT);
        expect(code).toContain(
            "const isEdgeToEdgePage = isShopPage || pathname?.startsWith('/coordinator/') || pathname?.startsWith('/fundraiser/');"
        );
        // The <main> className branches on isEdgeToEdgePage now, not isShopPage —
        // that's the one-line fix that removes the coordinator/scoreboard-only
        // unconditional p-8 (32px/side, no mobile scale-down).
        expect(code).toContain("${!isEdgeToEdgePage ? 'h-full overflow-y-auto p-8' : 'min-h-screen p-4 sm:p-8'}");
        expect(code).not.toContain("${!isShopPage ? 'h-full overflow-y-auto p-8'");
    });

    it('sidebar visibility is unchanged — still keyed to isShopPage alone, not widened by this fix', () => {
        const code = R(LAYOUT);
        expect(code).toContain('const showSidebar = hasSession && !isShopPage;');
    });

    it('the whole-page horizontal-scroll boundary (overflow-x: clip) is untouched — this fix removes overflow SOURCES, not the clip itself', () => {
        expect(R(LAYOUT)).toContain('overflow-x-clip');
        const globals = R(GLOBALS_CSS);
        expect(globals).toContain('overflow-x: clip');
        expect(globals).not.toContain('overflow-x: auto');
        expect(globals).not.toContain('overflow-x: scroll');
    });
});

// ── COORDINATOR PANEL — LOCKED ROW EMAIL WRAP ───────────────────────────────
describe('FR-SHARE-COPY-1 · coordinator LockedRow value wraps instead of overflowing', () => {
    it('the value span has a shrinkable flex basis and wraps long tokens (a real email address)', () => {
        const code = R(LOCKED_ROW);
        const span = code.slice(code.indexOf('<span className="min-w-0'), code.indexOf('{value}</span>') + 15);
        expect(span).toContain('min-w-0');
        expect(span).toContain('flex-1');
        expect(span).toContain('break-words');
    });

    it('the row itself stays a flex row (no unrelated structural change)', () => {
        const code = R(LOCKED_ROW);
        expect(code).toContain('<div className="flex items-start justify-between gap-3 py-2">');
    });
});

// ── PUBLIC FUNDRAISER PAGE — TOPBAR + ORDER ROW + FREE TEXT ─────────────────
describe('FR-SHARE-COPY-1 · public fundraiser page topbar no longer forces overflow', () => {
    it('the tenant-brand badge can shrink and ellipsize instead of holding full content width', () => {
        const code = R(FUNDRAISER);
        const badge = code.slice(code.indexOf("marginLeft: 'auto'"), code.indexOf('by {tenantName}'));
        expect(badge).toContain("minWidth: 0");
        expect(badge).toContain("maxWidth: '40%'");
        expect(badge).toContain("overflow: 'hidden'");
        expect(badge).toContain("textOverflow: 'ellipsis'");
        expect(badge).not.toContain("flex: 'none'");
    });

    it('the campaign title defensively carries minWidth:0 alongside its existing overflow:hidden ellipsis', () => {
        const code = R(FUNDRAISER);
        const title = code.slice(code.indexOf('fontFamily: SERIF, fontSize:'), code.indexOf('{campaignTitle}'));
        expect(title).toContain('minWidth: 0');
        expect(title).toContain("overflow: 'hidden'");
    });

    it('the topbar no longer duplicates the shared wrapper\'s horizontal padding', () => {
        const code = R(FUNDRAISER);
        expect(code).toContain("padding: '.75rem 0 .6rem'");
        expect(code).not.toContain("padding: '.75rem 1rem .6rem'");
    });

    it('an order line (qty stepper + total + remove) can wrap instead of overflowing the row', () => {
        const code = R(FUNDRAISER);
        const i = code.indexOf('{orderLines.map(line =>');
        const block = code.slice(i, code.indexOf('borderBottom:', i) + 40);
        expect(block).toContain("flexWrap: 'wrap'");
    });

    it('the About section wraps a long unbroken token instead of overflowing', () => {
        const code = R(FUNDRAISER);
        expect(code).toContain("whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'");
    });

    it('the already-correct guarded patterns are untouched (name/price block, BundleCard, share URL code)', () => {
        const code = R(FUNDRAISER);
        expect(code).toContain('flex: 1, minWidth: 0');
    });
});

// ── SCOREBOARD — PAYMENT INSTRUCTIONS WRAP ──────────────────────────────────
describe('FR-SHARE-COPY-1 · scoreboard payment instructions wrap instead of overflowing', () => {
    it('long free-text payment instructions can break', () => {
        const code = R(SCOREBOARD);
        expect(code).toContain('whitespace-pre-wrap break-words');
    });
});
