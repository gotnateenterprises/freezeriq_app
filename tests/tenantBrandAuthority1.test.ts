/**
 * TENANT-BRAND-AUTHORITY-1 — Business.display_name is the tenant brand
 * authority for fundraiser supporter/coordinator UX.
 *
 * THE OWNER RULING
 *
 * Whenever supporter/coordinator fundraiser UX refers to the business running
 * the fundraiser, it must read Business.display_name (falling back to
 * Business.name only when display_name is unset) — never a hardcoded literal,
 * never a raw Business.name read that skips the fallback rule, and never the
 * legacy TenantBranding.business_name column (which carries a schema DEFAULT
 * of the literal 'Freezer Chef' — see lib/tenantBrand.ts's own docblock).
 *
 * THE EXISTING AUTHORITY, REUSED NOT REINVENTED
 *
 * lib/tenantBrand.ts's customerFacingBusinessName() already implements exactly
 * this rule and is already tested (tests/frAcceptance2A.test.ts). This phase
 * does not add a second resolver — it finds the places that were not calling
 * the first one and wires them to it.
 *
 * TWO CONFIRMED DEFECTS, BOTH FAILING-FIRST BELOW
 *
 * 1. app/coordinator/portal/page.tsx read
 *      const tenantName = campaign.customer?.business?.name || null;
 *    — Business.name (the internal identity, e.g. "My Freezer Chef"), not
 *    display_name (the customer-facing brand, e.g. "Freezer Chef"). This value
 *    feeds components/coordinator/WhatsNext.tsx ("{tenantName} confirms your
 *    totals") and components/coordinator/ActionBar.tsx ("Contact {tenantName}
 *    →"), so a coordinator read the tenant's internal legal-style name instead
 *    of its brand.
 *
 * 2. app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx and its
 *    parent page.tsx (both generateMetadata and getData) never selected
 *    Business.display_name at all, and resolved the supporter-facing tenant
 *    name from business.branding?.business_name (the legacy, schema-default-
 *    'Freezer Chef' source) falling back to business.name, falling back to a
 *    hardcoded literal 'Freezer Chef'. Three wrong sources, in priority order.
 *
 * WHAT WAS ALREADY CORRECT (preservation, not fixed)
 *
 *   - lib/tenantBrand.ts's own resolver (frAcceptance2A.test.ts covers it).
 *   - app/api/coordinator/route.ts's shareTenantDisplayName, which already
 *     calls customerFacingBusinessName and is used for the SHARE messaging
 *     (a completely separate code path from the buggy WhatsNext/ActionBar one
 *     this phase fixes — proving the API layer was already right and the bug
 *     was purely in unrelated client-side derivation).
 *   - lib/email.ts getTenantSender(), which uses Business.name — NOT
 *     display_name — for the email FROM header. This is documented as
 *     INTENTIONAL (lib/tenantBrand.ts's own docblock: "Business.name is the
 *     canonical internal identity and the authority for the From header").
 *     This phase must not "fix" it to display_name.
 *   - lib/emailTemplates.ts's lead_intro/thank_you templates, already proven
 *     tenant-dynamic by tests/frAcceptance1C.test.ts.
 *   - Organization name (FundraiserCampaign's linked Customer) and campaign
 *     name remain distinct concepts from tenant business name; this phase
 *     changes neither.
 *
 * NOT IN SCOPE (found during audit, deliberately left untouched — see
 * TENANT-BRAND-AUTHORITY-1's final report §8 for the reasoning on each):
 * app/invoices/page.tsx, components/crm/MarketingFlyer.tsx, the isGlobal
 * document templates, StorefrontClient.tsx and the general (non-fundraiser)
 * storefront — all read the same legacy TenantBranding-backed source, but
 * fixing them safely means not disturbing the branding SETTINGS FORM's own
 * read-modify-write cycle, which is a larger change than this narrow phase.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { customerFacingBusinessName } from '@/lib/tenantBrand';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PORTAL = 'app/coordinator/portal/page.tsx';
const FUNDRAISER_CLIENT = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const FUNDRAISER_PAGE = 'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx';
const EMAIL = 'lib/email.ts';

/** The two required tenant fixtures. */
const TENANT_A = { name: 'My Freezer Chef', display_name: 'Freezer Chef' };
const TENANT_B = { name: "Nate's Freezer Guy LLC", display_name: "Nate's Freezer Guy" };

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE AUTHORITY — behavioral, two tenants, no cross-tenant leakage.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. Business.display_name is the tested tenant brand authority', () => {
    it('Tenant A renders its own display_name', () => {
        expect(customerFacingBusinessName(TENANT_A)).toBe('Freezer Chef');
    });

    it('Tenant B renders its own display_name — never Tenant A\'s', () => {
        const rendered = customerFacingBusinessName(TENANT_B);
        expect(rendered).toBe("Nate's Freezer Guy");
        expect(rendered).not.toBe('Freezer Chef');
        expect(rendered).not.toContain('Freezer Chef');
    });

    it('the SAME function renders each tenant correctly from the same call site', () => {
        // "the same component/template renders each tenant correctly" —
        // proven by driving one resolver with two fixtures rather than two
        // hand-written branches that could silently diverge.
        for (const [tenant, expected] of [
            [TENANT_A, 'Freezer Chef'],
            [TENANT_B, "Nate's Freezer Guy"],
        ] as const) {
            expect(customerFacingBusinessName(tenant)).toBe(expected);
        }
    });

    it('falls back to Business.name only when display_name is genuinely unset — the EXISTING documented fallback, not a new one', () => {
        expect(customerFacingBusinessName({ name: 'Raw Legal Name LLC' })).toBe('Raw Legal Name LLC');
        expect(customerFacingBusinessName({ name: 'Raw Legal Name LLC', display_name: '   ' })).toBe('Raw Legal Name LLC');
    });

    it('never falls back to the organization/campaign name — that is a different concept entirely', () => {
        // customerFacingBusinessName's input type has no field an organization
        // or campaign name could arrive through; this proves it structurally.
        const src = read('lib/tenantBrand.ts');
        expect(src).toMatch(/interface TenantBrandSource \{[\s\S]*?name: string;[\s\S]*?display_name/);
        expect(src).not.toMatch(/organization/i);
        expect(src).not.toMatch(/campaign/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE DEFECT — coordinator portal WhatsNext / ActionBar. Fails pre-fix.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. coordinator portal tenantName is resolved through the authority', () => {
    it('DEFECT: the portal no longer reads raw Business.name for tenantName', () => {
        const src = strip(read(PORTAL));
        // The exact defective line this phase found and fixed:
        //   const tenantName = campaign.customer?.business?.name || null;
        expect(src).not.toMatch(/const tenantName = campaign\.customer\?\.business\?\.name \|\| null;/);
    });

    it('the portal computes tenantName via customerFacingBusinessName', () => {
        const src = strip(read(PORTAL));
        expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
        expect(src).toMatch(/customerFacingBusinessName\(/);
    });

    it('WhatsNext and ActionBar still receive tenantName by the same prop name — no consumer rewrite needed', () => {
        const src = strip(read(PORTAL));
        expect(src).toMatch(/<WhatsNext[\s\S]{0,200}tenantName=\{tenantName/);
        // ActionBar carries longer inline handlers (onAddOrder/onShare) before
        // tenantName than WhatsNext does, hence the wider window.
        expect(src).toMatch(/<ActionBar[\s\S]{0,400}tenantName=\{tenantName/);
    });

    it('WhatsNext itself is untouched — it was always a correct, pure consumer of its tenantName prop', () => {
        const src = read('components/coordinator/WhatsNext.tsx');
        expect(src).toContain('${tenantName} confirms your totals');
        expect(src).not.toMatch(/Freezer Chef/i);
    });

    it('organization label (orgLabel) remains a SEPARATE variable from tenantName', () => {
        const src = strip(read(PORTAL));
        expect(src).toMatch(/const orgLabel = campaign\.customer\?\.name/);
        // Two distinct declarations, not one merged into the other.
        expect((src.match(/const tenantName =/g) || []).length).toBe(1);
        expect((src.match(/const orgLabel =/g) || []).length).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE DEFECT — supporter fundraiser page. Fails pre-fix.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. supporter fundraiser page tenantName is resolved through the authority', () => {
    it('DEFECT: FundraiserClient no longer reads business.branding?.business_name for the tenant name', () => {
        const src = strip(read(FUNDRAISER_CLIENT));
        expect(src).not.toMatch(/business\.branding\?\.business_name/);
    });

    it('DEFECT: FundraiserClient no longer falls back to a hardcoded "Freezer Chef" literal', () => {
        const src = strip(read(FUNDRAISER_CLIENT));
        // Narrow: only the tenantName derivation, not the whole file (a doc
        // comment mentioning the brand elsewhere must not trip this).
        const tenantNameLine = src.slice(src.indexOf('const tenantName ='), src.indexOf('const tenantName =') + 300);
        expect(tenantNameLine).not.toMatch(/'Freezer Chef'/);
        expect(tenantNameLine).toMatch(/customerFacingBusinessName\(/);
    });

    it('FundraiserClient imports the shared authority rather than re-deriving the rule', () => {
        const src = strip(read(FUNDRAISER_CLIENT));
        expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
    });

    it('the fundraiser page SELECTS display_name for both generateMetadata and getData', () => {
        const src = strip(read(FUNDRAISER_PAGE));
        const selects = src.match(/select: \{[^}]*\}/g) || [];
        const businessSelects = selects.filter((s) => s.includes('name: true') && s.includes('logo_url'));
        expect(businessSelects.length).toBeGreaterThanOrEqual(2);
        for (const sel of businessSelects) {
            expect(sel).toMatch(/display_name: true/);
        }
    });

    it('DEFECT: generateMetadata no longer resolves the tenant name via raw tenant_branding SQL with a hardcoded fallback', () => {
        const src = strip(read(FUNDRAISER_PAGE));
        const metaFn = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('async function getData'));
        expect(metaFn).not.toMatch(/business_name && brandingRecords\[0\]\.business_name !== 'FreezerIQ'/);
        expect(metaFn).toMatch(/customerFacingBusinessName\(/);
    });

    it('the fundraiser page imports the shared authority', () => {
        const src = strip(read(FUNDRAISER_PAGE));
        expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
    });

    it('campaignTitle still falls back to organization_name, never tenant name — the two stay distinct', () => {
        const src = strip(read(FUNDRAISER_CLIENT));
        expect(src).toMatch(/const campaignTitle = campaign\.name \|\| `\$\{campaign\.organization_name\} Fundraiser`/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PRESERVATION — surfaces that were already correct, or intentionally
//    different, must not be touched by this phase.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. preserved surfaces', () => {
    it('the coordinator API\'s own share.tenantDisplayName still uses the authority (was already correct)', () => {
        const src = strip(read('app/api/coordinator/route.ts'));
        expect(src).toMatch(/shareTenantDisplayName = business \? customerFacingBusinessName\(business\)/);
    });

    it('getTenantSender still uses Business.name for the FROM header — this is documented, intentional, and must NOT become display_name', () => {
        const src = strip(read(EMAIL));
        const fn = src.slice(src.indexOf('export async function getTenantSender'), src.indexOf('export async function getTenantSender') + 800);
        expect(fn).toMatch(/select:\s*\{\s*name:\s*true/);
        expect(fn).toMatch(/\$\{business\.name\}\s+via FreezerIQ/);
        expect(fn).not.toMatch(/display_name/);
    });

    it('lead_intro / thank_you email templates remain tenant-dynamic (no regression from this phase)', () => {
        const { EMAIL_TEMPLATES } = require('@/lib/emailTemplates');
        const a = EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', TENANT_A);
        const b = EMAIL_TEMPLATES.lead_intro('Dana', 'Oak Ridge PTO', TENANT_B);
        expect(a.html).not.toContain("Nate's Freezer Guy");
        expect(b.html).not.toMatch(/Freezer Chef/i);
    });

    it('the coordinator notification email body never names the tenant at all — nothing to fix, nothing broken', () => {
        // sendFundraiserCoordinatorNotification's body concerns the supporter,
        // campaign and organization only. Confirmed by source: it has no
        // tenant/business field in its destructured input.
        const src = strip(read(EMAIL));
        const fn = src.slice(src.indexOf('export async function sendFundraiserCoordinatorNotification'), src.indexOf('export async function sendLeadNotificationEmail'));
        expect(fn).not.toMatch(/business\.name|business_name|display_name|tenantName/);
    });

    it('the supporter order-confirmation email body never names the tenant at all — nothing to fix, nothing broken', () => {
        const src = strip(read(EMAIL));
        const fn = src.slice(src.indexOf('export async function sendOrderConfirmationEmail'), src.indexOf('export async function sendFundraiserCoordinatorNotification'));
        // Only the FROM-header resolution touches identity; the visible body
        // ("Order Received! Thank you, {name}...") does not.
        const htmlBody = fn.slice(fn.indexOf('const htmlContent'));
        expect(htmlBody).not.toMatch(/business\.name|business_name|display_name|tenantName/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. REGRESSION GUARD — the narrow surfaces this phase fixed cannot silently
//    regain a hardcoded brand literal. Deliberately scoped to exactly the
//    files this phase touches, not a repo-wide sweep (which would flag
//    legitimate historical docs, unrelated proper nouns, and test fixtures).
// ═════════════════════════════════════════════════════════════════════════════
describe('5. regression guard — no hardcoded tenant brand on the fixed surfaces', () => {
    const GUARDED_FILES = [PORTAL, FUNDRAISER_CLIENT, FUNDRAISER_PAGE];

    it.each(GUARDED_FILES)('%s contains no quoted "Freezer Chef" / "My Freezer Chef" literal', (file) => {
        const src = strip(read(file));
        expect(src).not.toMatch(/['"`]My Freezer Chef['"`]/);
        expect(src).not.toMatch(/['"`]Freezer Chef['"`]/);
    });

    it.each(GUARDED_FILES)('%s never reads business_name off TenantBranding for the tenant identity', (file) => {
        const src = strip(read(file));
        expect(src).not.toMatch(/branding\??\.business_name/);
        expect(src).not.toMatch(/brandingRecords\[0\]\.business_name/);
    });
});
