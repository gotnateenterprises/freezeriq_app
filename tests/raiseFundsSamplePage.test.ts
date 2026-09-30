/**
 * RAISE-FUNDS-MARKETING-1 — "See a sample ordering page".
 *
 * The /raise-funds hero's second CTA used to link to the tenant's plain
 * customer storefront (/shop/<slug>), which is not what a prospective
 * organizer needs to see. It now opens /shop/<slug>/raise-funds/sample: the
 * REAL supporter component, rendered with the tenant's real branding and
 * bundles and an obviously fictional fundraiser, in a sample mode that cannot
 * place an order.
 *
 * WHAT THESE TESTS PROTECT
 *  1. The CTA text and a RELATIVE tenant-scoped href (Preview stays on
 *     Preview, Production on Production — never NEXT_PUBLIC_APP_URL).
 *  2. The sample route is tenant-scoped, read-only, and hardcodes no tenant,
 *     organization, or campaign.
 *  3. Order safety: sampleMode's early return is the first statement of
 *     submitOrder, ahead of the only fetch in the component; the real route
 *     never passes sampleMode.
 *  4. The sample data is fictional and never a real id.
 *
 * Source-text assertions plus pure unit tests of lib/sampleFundraiser.ts, as
 * elsewhere in this project (Jest env is 'node' — no DOM renderer for JSX).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import {
    buildSampleCampaign,
    SAMPLE_BUNDLE_PROGRESS,
    SAMPLE_FUNDRAISER_ID,
    SAMPLE_FUNDRAISER_NAME,
    SAMPLE_ORDER_MODE,
    SAMPLE_ORGANIZATION_NAME,
} from '@/lib/sampleFundraiser';
import { PUBLIC_CAMPAIGN_FIELDS, FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS } from '@/lib/publicFundraiserPayload';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const MARKETING_PATH = 'app/shop/[slug]/raise-funds/page.tsx';
const SAMPLE_PATH = 'app/shop/[slug]/raise-funds/sample/page.tsx';
const CLIENT_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const REAL_PAGE_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx';
const ORDER_ROUTE_PATH = 'app/api/public/order/route.ts';

const marketing = strip(read(MARKETING_PATH));
const sampleRaw = read(SAMPLE_PATH);
const sample = strip(sampleRaw);
const client = strip(read(CLIENT_PATH));
const realPage = strip(read(REAL_PAGE_PATH));

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ═════════════════════════════════════════════════════════════════════════════
// 1. The marketing CTA
// ═════════════════════════════════════════════════════════════════════════════
describe('1. the marketing page CTA', () => {
    it('reads "See a sample ordering page" — the old "See the ordering page" is gone', () => {
        expect(marketing).toContain('See a sample ordering page');
        expect(marketing).not.toContain('See the ordering page');
    });

    it('links to the tenant-scoped sample route with a RELATIVE path', () => {
        expect(marketing).toMatch(/<Link href=\{`\/shop\/\$\{slug\}\/raise-funds\/sample`\}[^>]*>\s*See a sample ordering page\s*<\/Link>/);
    });

    it('never builds the link from an absolute or configured origin (the Preview-link lesson)', () => {
        expect(read(MARKETING_PATH)).not.toMatch(/NEXT_PUBLIC_APP_URL|NEXT_PUBLIC_BASE_URL|VERCEL_URL|https?:\/\/[a-z0-9.-]*(freezeriq|freezerchef)/i);
    });

    it('the primary inquiry CTA is unchanged: it still scrolls to the form', () => {
        expect(marketing).toMatch(/onClick=\{scrollToForm\}[^>]*>\s*Start a fundraiser/);
        expect(marketing).toContain('id="contact-form"');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The sample route: tenant-scoped, read-only, nothing hardcoded
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the sample route', () => {
    it('lives under the tenant slug, next to the marketing page', () => {
        expect(SAMPLE_PATH).toBe('app/shop/[slug]/raise-funds/sample/page.tsx');
        expect(sample).toMatch(/params: Promise<\{ slug: string \}>/);
    });

    it('resolves the tenant from the slug with the literal-slug helper and 404s an unknown slug', () => {
        expect(sample).toMatch(/findBusinessBySlug<SampleBusiness>\(prisma, slug,/);
        expect(sample).toMatch(/if \(!business\) notFound\(\);/);
    });

    it('reads branding and bundles for THAT tenant only — the real supporter page\'s own predicates', () => {
        expect(sample).toMatch(/WHERE u\.business_id = \$\{business\.id\}\s*AND u\.role = 'ADMIN'/);
        expect(sample).toMatch(/WHERE business_id = \$\{business\.id\}\s*AND is_active = true\s*AND show_on_storefront = true/);
        // The same legacy-branch predicate the real page uses — so the sample
        // shows exactly the lineup a legacy campaign would.
        expect(realPage).toMatch(/WHERE business_id = \$\{business\.id\}\s*AND is_active = true\s*AND show_on_storefront = true/);
    });

    it('hardcodes no tenant, organization, or campaign', () => {
        for (const forbidden of ['Freezer Chef', 'MyFreezerChef', 'myfreezerchef', 'Preview Test', 'preview-test-tenant', 'Edgar', 'Laurie']) {
            expect(sampleRaw).not.toContain(forbidden);
        }
        expect(sampleRaw).not.toMatch(UUID_RE);
    });

    it('never reads a real campaign, organization, customer, or order', () => {
        expect(sample).not.toMatch(/fundraiser_campaigns|fundraiserCampaign|customers\b|\bcustomer\.|orders\b|order_items|campaign_bundles/);
    });

    it('performs no writes of any kind and makes no request', () => {
        expect(sample).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
        expect(sample).not.toMatch(/\$executeRaw|\$transaction/);
        expect(sample).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
        expect(sample).not.toMatch(/fetch\(/);
    });

    it('renders the REAL supporter component, in sample mode, with the sample fundraiser', () => {
        expect(sample).toContain("import FundraiserClient from '../../fundraiser/[fundraiserId]/FundraiserClient';");
        expect(sample).toMatch(/<FundraiserClient[\s\S]*campaign=\{buildSampleCampaign\(\)\}[\s\S]*sampleMode\s*\/>/);
        expect(sample).toMatch(/fundraiserId=\{SAMPLE_FUNDRAISER_ID\}/);
    });

    it('says, subtly, that it is a sample — and offers a relative way back', () => {
        expect(sample).toContain('Sample fundraiser ordering page.');
        expect(sample).toContain('This is an example of what your supporters will see.');
        expect(sample).toMatch(/<Link href=\{`\/shop\/\$\{slug\}\/raise-funds`\}/);
    });

    it('is kept out of search results', () => {
        expect(sample).toMatch(/robots: \{ index: false, follow: false \}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Order safety
// ═════════════════════════════════════════════════════════════════════════════
describe('3. the sample cannot place an order', () => {
    // End anchor is CODE, not a comment — strip() removes comment lines.
    const SHARE_ROW_START = 'const pageUrl = () =>';
    const submitStart = client.indexOf('const submitOrder = async () => {');
    const submitEnd = client.indexOf(SHARE_ROW_START, submitStart);
    const submitBody = client.slice(submitStart, submitEnd);

    it('the submitOrder slice is anchored on real code on both ends', () => {
        expect(submitStart).toBeGreaterThan(-1);
        expect(submitEnd).toBeGreaterThan(submitStart);
    });

    it('sampleMode is optional and defaults to false', () => {
        expect(client).toMatch(/fundraiserId,\s*\n\s*sampleMode = false\s*\n\}: any\)/);
    });

    it('the sample-mode early return is the FIRST statement of submitOrder', () => {
        expect(submitBody).toMatch(/^const submitOrder = async \(\) => \{\s*if \(sampleMode\) return;\s*if \(!canSubmit\) return;/);
    });

    it('it precedes the submission key and the only network call in the component', () => {
        const guard = submitBody.indexOf('if (sampleMode) return;');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(submitBody.indexOf('crypto.randomUUID()'));
        expect(guard).toBeLessThan(submitBody.indexOf("fetch('/api/public/order'"));
        expect((client.match(/fetch\(/g) || []).length).toBe(1);
    });

    it('the thanks screen (and its share buttons) is only ever set after a successful order response', () => {
        const setThanksIdx = client.indexOf('setThanks({');
        expect(setThanksIdx).toBeGreaterThan(client.indexOf("fetch('/api/public/order'"));
        expect(setThanksIdx).toBeLessThan(submitEnd);
        expect((client.match(/setThanks\(/g) || []).length).toBe(1);
    });

    it('shows the non-mutating sample message at the point of ordering', () => {
        expect(client).toMatch(/\{sampleMode && \(\s*<p role="status"[^>]*>\s*Sample only\. This is a sample ordering page\. Your supporters will be able to submit their order here during your fundraiser\.\s*<\/p>\s*\)\}/);
    });

    it('the real submit wiring and gate are untouched', () => {
        expect(client).toMatch(/onClick=\{submitOrder\}/);
        expect(client).toMatch(/disabled=\{!canSubmit\}/);
    });

    it('the real fundraiser route never passes sampleMode', () => {
        expect(realPage).not.toMatch(/sampleMode/);
    });

    it('the real fundraiser route and the order endpoint are not modified by this phase', () => {
        const out = execSync(`git status --porcelain -- "${REAL_PAGE_PATH}" "${ORDER_ROUTE_PATH}" lib/fundraiserLead.ts app/api/public/fundraiser-request/route.ts`, { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The sample data is fictional, public-shaped, and never a real id
// ═════════════════════════════════════════════════════════════════════════════
describe('4. sample fundraiser data', () => {
    const NOW = new Date('2026-09-29T15:00:00.000Z');
    const c = buildSampleCampaign(NOW) as Record<string, unknown>;

    it('uses an obviously fictional organization and title', () => {
        expect(SAMPLE_ORGANIZATION_NAME).toBe('Sample Community Organization');
        expect(SAMPLE_FUNDRAISER_NAME).toBe('Sample Community Organization Fundraiser');
        expect(c.organization_name).toBe(SAMPLE_ORGANIZATION_NAME);
        expect(c.name).toBe(SAMPLE_FUNDRAISER_NAME);
    });

    it('the id is not, and cannot collide with, a real campaign id', () => {
        expect(SAMPLE_FUNDRAISER_ID).toBe('sample');
        expect(SAMPLE_FUNDRAISER_ID).not.toMatch(UUID_RE);
        expect(c.id).toBe('sample');
    });

    it('carries exactly the public campaign allowlist — nothing tenant-internal', () => {
        expect(Object.keys(c).sort()).toEqual([...PUBLIC_CAMPAIGN_FIELDS].sort());
        for (const forbidden of FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS) {
            expect(c).not.toHaveProperty(forbidden);
        }
    });

    it('dates are always in the future: deadline in two weeks, pickup a week after', () => {
        expect(c.end_date).toBe('2026-10-13');
        expect(c.delivery_date).toBe('2026-10-20');
    });

    it('pickup details are generic, and the sample is untaxed', () => {
        expect(c.pickup_location).toBe('Sample Community Center');
        expect(c.tax_status).toBeNull();
        expect(c.tax_rate_percent).toBeNull();
        expect(c.external_payment_link).toBeNull();
    });

    it('demo progress is plausible and unfinished', () => {
        expect(SAMPLE_BUNDLE_PROGRESS.bundleGoal).toBe(60);
        expect(SAMPLE_BUNDLE_PROGRESS.totalBundlesSold).toBe(38);
        expect(SAMPLE_BUNDLE_PROGRESS.totalBundlesSold).toBeLessThan(SAMPLE_BUNDLE_PROGRESS.bundleGoal);
        expect(SAMPLE_BUNDLE_PROGRESS.raisedAmount).toBeNull();
    });

    it('uses the real page\'s own "legacy" order mode, so every current public bundle shows', () => {
        expect(SAMPLE_ORDER_MODE).toEqual({ allowed: true, mode: 'legacy', activeOrderableBundleIds: [] });
    });
});
