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

            // FR-TAX-CORRECTNESS-1 is a later, separately-authorized phase that
            // legitimately edits the fundraiser tax/money path. This check runs
            // against LIVE `git status`, not a frozen commit range, so its files
            // are acknowledged here rather than the check being weakened.
            const FR_TAX_CORRECTNESS_1 = [
                'lib/fundraiserTax.ts',
                'lib/fundraiserCloseoutMath.ts',
                'lib/coordinatorSupporterOrders.ts',
                'app/api/public/order/route.ts',
                'app/api/coordinator/route.ts',
                'app/api/campaigns/[id]/closeout/route.ts',
                'components/crm/InvoiceComposeModal.tsx',
                'lib/publicFundraiserPayload.ts',
                'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx',
                'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx',
                'lib/email.ts',
                'lib/coordinatorOrderTracker.ts',
                'app/api/fundraisers/upload/route.ts',
                'app/api/tracker/download/route.ts',
                'components/coordinator/RecentOrders.tsx',
                'components/coordinator/Leaderboard.tsx',
                'app/api/campaigns/route.ts',
                'app/api/campaigns/[id]/route.ts',
                'components/crm2/StartFundraiserWizard.tsx',
                'lib/campaignCoordinatorContact.ts',
                'lib/calendarDate.ts',
                'app/api/campaigns/[id]/coordinator-email/route.ts',
                'app/coordinator/portal/page.tsx',
                'components/coordinator/LaunchSteps.tsx',
                'components/crm/FundraisersTab.tsx',
                'components/crm2/CampaignCard.tsx',
                'components/crm2/ArchivedCampaignList.tsx',
                'components/crm2/CampaignPriorityList.tsx',
            ];
            // FR-SUPPORTER-PAYMENT-STATUS-1 — a later, separately-authorized phase
            // (the coordinator's supporter-payment mark). Listed on its own rather
            // than folded into the array above, which is named for a different
            // phase. Its one approved migration is named by exact directory.
            const FR_SUPPORTER_PAYMENT_STATUS_1 = [
                'lib/supporterPayment.ts',
                'lib/coordinatorSupporterOrders.ts',
                'app/api/coordinator/route.ts',
                'components/coordinator/RecentOrders.tsx',
                'app/coordinator/portal/page.tsx',
                'app/coordinator/portal/pickup-tracker/page.tsx',
                'prisma/migrations/20260912000000_fr_supporter_payment_status_1_order_paid/',
            ];
            // QB-INVOICE-1A — a later, separately-authorized phase: legacy QuickBooks
            // quarantine + the secure sandbox OAuth connector. It legitimately touches
            // app/api/ (the retired qbo routes, the new quickbooks routes, sync/orders)
            // and removes two npm packages. Entries ending in '/' are directories, which
            // is how `git status --porcelain` reports a new untracked folder. No
            // migration: the connector reuses the existing integrations table.
            const QB_INVOICE_1A = [
                'app/api/auth/qbo/route.ts',
                'app/api/auth/qbo/callback/route.ts',
                'app/api/integrations/auth/qbo/login/route.ts',
                'app/api/integrations/auth/qbo/callback/route.ts',
                'app/api/integrations/sync/qbo/route.ts',
                'app/api/integrations/disconnect/route.ts',
                'app/api/integrations/status/route.ts',
                'app/api/integrations/quickbooks/',
                'app/api/sync/orders/route.ts',
                'app/settings/page.tsx',
                'components/SyncOrdersButton.tsx',
                'components/settings/QuickBooksConnectionCard.tsx',
                'lib/auth/oauthState.ts',
                'lib/auth/token_manager.ts',
                'lib/integrationTokenCrypto.ts',
                'lib/quickbooks/',
                'lib/qbo.ts',
                'lib/ingestion/qbo_poller.ts',
                'lib/ingestion/clients/qbo_client.ts',
                'lib/mock_data.ts',
                'types/integrations.ts',
                'types/intuit-oauth.d.ts',
                'types/node-quickbooks.d.ts',
                'simulate_qbo.bat',
                'test_qbo_import.js',
                'package.json',
                'package-lock.json',
                'docs/ai/ENVIRONMENT.md',
                'docs/ai/INTEGRATIONS.md',
                'docs/ai/Brain.md',
                'docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md',
                'docs/ai/QUICKBOOKS_INTEGRATION.md',
            ];
            const inQbInvoice1a = (f: string) => QB_INVOICE_1A.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

            // QB-INVOICE-1B — QuickBooks customer mapping + invoice-link schema foundation,
            // a later, separately-authorized phase. New files under lib/quickbooks/ and
            // app/api/integrations/quickbooks/ are covered by the QB-INVOICE-1A prefixes; its
            // schema hunk lives in prisma/schema.prisma (excluded above) and its one migration
            // is named exactly.
            const QB_INVOICE_1B = [
                'app/customers/[id]/page.tsx',
                'components/crm/QuickBooksCustomerLinkCard.tsx',
                'prisma/migrations/20260913120000_qb_invoice_1b_quickbooks_links/',
            ];
            const inQbInvoice1b = (f: string) => QB_INVOICE_1B.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

            // QB-INVOICE-1C — "Send via QuickBooks", a later, separately-authorized phase. Its new files under
            // lib/quickbooks/ and app/api/integrations/quickbooks/ are covered by the QB-INVOICE-1A prefixes and its
            // schema hunk lives in prisma/schema.prisma (excluded above). These are its other files — the invoice
            // routes gain QuickBooks locks — and its one migration is named exactly.
            const QB_INVOICE_1C = [
                'app/api/tenant/invoices/route.ts',
                'app/api/tenant/invoices/[id]/send/route.ts',
                'app/invoices/page.tsx',
                'components/invoices/',
                'components/settings/QuickBooksInvoiceSettingsCard.tsx',
                'prisma/migrations/20260915170000_qb_invoice_1c_invoice_send/',
                // Intuit production readiness, a later separately-authorized step of the same workstream: the
                // PUBLIC disconnect information page Intuit requires as the app's Disconnect URL. A static page
                // and its structural test; no route, no schema, no migration, no state change.
                'app/legal/disconnect/',
                'tests/qbDisconnectPage.test.ts',
            ];
            const inQbInvoice1c = (f: string) => QB_INVOICE_1C.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
            // QB-INVOICE-1D — "Check QuickBooks payment", a later, separately-authorized phase. Its files under
            // lib/quickbooks/, app/api/integrations/quickbooks/, components/invoices/ and app/invoices/page.tsx are
            // covered by the lists above. These are its other files: the settlement transition moved UNCHANGED out of
            // the settle route into its own module so a verified QuickBooks payment and Record Payment share it, and
            // settlement learns the verified method. Exact paths only; no schema, no migration.
            const QB_INVOICE_1D = [
                'app/api/tenant/invoices/[id]/settle/route.ts',
                'lib/invoiceSettlement.ts',
                'lib/invoiceSettlementTransition.ts',
            ];
            const inQbInvoice1d = (f: string) => QB_INVOICE_1D.includes(f);
            // SEC-INTUIT-ATTEST-1 — a later, separately-authorized phase closing the three
            // findings that blocked the owner's Intuit App Assessment security attestation:
            // a global no-store cache policy for /api, deletion of two full-request-body
            // debug logs, and a fail-closed tenant guard on two document GETs. Code only —
            // no schema, no migration, no financial logic.
            // Its follow-up aligned every route-level Cache-Control literal under app/api to the
            // exact value next.config.js sets, because on Vercel a handler's own header overrides
            // the config one. Header values only. Entries ending in '/' are directories.
            const SEC_INTUIT_ATTEST_1 = [
                'next.config.js',
                'app/api/tenant/invoices/route.ts',
                'app/api/documents/route.ts',
                'app/api/documents/templates/route.ts',
                'tests/secIntuitAttest1.test.ts',
                'app/api/auth/qbo/route.ts',
                'app/api/auth/qbo/callback/route.ts',
                'app/api/customers/[id]/tax-document/route.ts',
                'app/api/integrations/quickbooks/',
                'app/api/integrations/square/route.ts',
            ];
            const inSecIntuitAttest1 = (f: string) => SEC_INTUIT_ATTEST_1.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
            for (const f of changed) {
                const allowed = f === SHARE_CENTER || f.startsWith('tests/')
                    || FR_TAX_CORRECTNESS_1.includes(f) || FR_SUPPORTER_PAYMENT_STATUS_1.includes(f) || inQbInvoice1a(f) || inQbInvoice1b(f) || inQbInvoice1c(f)
                    || inQbInvoice1d(f) || inSecIntuitAttest1(f);
                expect(allowed).toBe(true);
            }
            const forbidden = /^(prisma\/migrations|app\/api\/|lib\/kitchen_engine|lib\/cost_engine|lib\/deliveryPackaging|lib\/physicalBoxPacking|app\/delivery|app\/production|app\/api\/checkout|app\/api\/webhooks|app\/api\/invoices|lib\/pricing)/;
            for (const f of changed) {
                // FR-TAX-CORRECTNESS-1 is separately authorized to edit the
                // fundraiser money path, so its files are exempt from THIS
                // phase's "presentation only" assertion. Everything else is
                // still held to it.
                if (FR_TAX_CORRECTNESS_1.includes(f) || FR_SUPPORTER_PAYMENT_STATUS_1.includes(f) || inQbInvoice1a(f) || inQbInvoice1b(f) || inQbInvoice1c(f)
                    || inQbInvoice1d(f) || inSecIntuitAttest1(f)) continue;
                expect(f).not.toMatch(forbidden);
            }
        });

        it('no migration directory was created by this phase', () => {
            const { execSync } = require('child_process');
            const out = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT, encoding: 'utf8' });
            // Live git status: exempt FR-SUPPORTER-PAYMENT-STATUS-1's single approved
            // migration BY EXACT PATH. Any other migration still fails this check.
            const approvedLater = [
                'prisma/migrations/20260912000000_fr_supporter_payment_status_1_order_paid/migration.sql',
                // QB-INVOICE-1B's single approved migration, by exact path.
                'prisma/migrations/20260913120000_qb_invoice_1b_quickbooks_links/',
                // QB-INVOICE-1C's single approved migration, by exact path.
                'prisma/migrations/20260915170000_qb_invoice_1c_invoice_send/',
            ];
            const remaining = out.split('\n').filter((l: string) => !approvedLater.some((a) => l.includes(a))).join('\n');
            expect(remaining).not.toMatch(/prisma\/migrations\//);
        });
    });
});
