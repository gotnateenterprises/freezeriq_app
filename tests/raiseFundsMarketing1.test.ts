/**
 * RAISE-FUNDS-MARKETING-1 — the public "[Tenant] Fundraisers" page, rebuilt to
 * sell the fundraiser (benefits first) and end in the unchanged inquiry form.
 *
 * WHAT THESE TESTS PROTECT
 *
 *  1. Truthfulness. No fixed percentage, no viral/guaranteed-results language,
 *     no claim the page cannot back (the old "Protected by reCAPTCHA" line had
 *     no reCAPTCHA behind it anywhere in the app).
 *  2. Multi-tenancy. Nothing tenant-specific is written into the file: name,
 *     brand color, hero image, bundles (names, photos, prices) and testimonials
 *     all come from the tenant's own public payload. No stock photography.
 *  3. Benefits, not rules. Operational program terms (minimums, order
 *     deadlines, delivery days, bundle-selection rules, payment terms) are OFF
 *     the page by owner decision — they belong in the follow-up to an inquiry.
 *  4. The inquiry form is behaviourally unchanged from FR-FUNNEL-1 /
 *     FR-ACCEPTANCE-1: same endpoint, same idempotency key, same website input.
 *
 * Source-text assertions, like the rest of this project's UI tests (Jest env is
 * 'node' — no DOM renderer for JSX).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE_PATH = 'app/shop/[slug]/raise-funds/page.tsx';
const raw = read(PAGE_PATH);
const page = strip(raw);

// ═════════════════════════════════════════════════════════════════════════════
// A. The locked positioning is on the page, word for word
// ═════════════════════════════════════════════════════════════════════════════
describe('A. locked positioning copy', () => {
    it.each([
        'Raise money with something families already need: dinner.',
        'a night off from cooking',
        'Raise more. Stress less.',
        'Why a food fundraiser works',
        'Dinner is different.',
        'not just donating',
        'less like asking for a donation and more like offering',
        'to ordered in just a few taps.',
        'Spend your time promoting the fundraiser, not sorting through paperwork.',
        'shoebox of forms',
        'Turn dinner into support for your organization.',
        'One fundraiser. A lot more ways to reach people.',
        'Built to be shared. Designed to help your fundraiser reach more people.',
        'Three steps, start to finish',
        'Keep the momentum going',
    ])('says: %s', (phrase) => {
        expect(page).toContain(phrase);
    });

    it('the three steps read Set it up / Share it / Keep the momentum going — "Cheer it on" is retired', () => {
        expect(page).toMatch(/title: 'Set it up'/);
        expect(page).toMatch(/title: 'Share it'/);
        expect(page).toMatch(/title: 'Keep the momentum going'/);
        expect(page).not.toMatch(/Cheer it on/);
    });

    it('names every share channel the owner listed: text, social, email, group chats, QR codes', () => {
        for (const label of ["'Text'", "'Social media'", "'Email'", "'Group chats'", "'QR code on a flyer'"]) {
            expect(page).toContain(label);
        }
    });

    it('closes the steps with the owner-approved reassurance line', () => {
        expect(page).toMatch(/You focus on spreading the word\. We(&apos;|')ll help keep the fundraiser organized\./);
    });

    it('the trust strip says ONLINE ordering, not "no paper" — paper forms remain allowed', () => {
        expect(page).toContain('Online, mobile-friendly ordering');
        expect(page).not.toMatch(/no paper/i);
    });

    it('names the audience without singling out one organization', () => {
        expect(page).toMatch(/Schools, churches, teams, clubs, Farm Bureaus, nonprofits/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Truthfulness guardrails
// ═════════════════════════════════════════════════════════════════════════════
describe('B. truthfulness guardrails', () => {
    it('promises no fixed percentage anywhere', () => {
        expect(page).not.toMatch(/\d+ ?%/);
    });

    it('uses the agreed-percentage wording with the amount set per campaign', () => {
        expect(page).toMatch(/agreed fundraising percentage/);
        expect(page).toMatch(/exact\s+amount set for your campaign/);
    });

    it('never promises viral reach or guaranteed results', () => {
        expect(page).not.toMatch(/viral/i);
        expect(page).not.toMatch(/guarantee/i);
    });

    it('does not claim automatic payment processing', () => {
        expect(page).not.toMatch(/automatically (collect|process)/i);
        expect(page).toMatch(/Payment\s+instructions are yours to set/);
    });

    it('the false "Protected by reCAPTCHA" claim is gone (nothing in the app implements it)', () => {
        expect(raw).not.toMatch(/reCAPTCHA/i);
    });

    it('does not invent a testimonial — quotes render only from the tenant payload', () => {
        expect(page).toMatch(/storefrontConfig\?\.testimonials/);
        expect(page).toMatch(/testimonials\.length > 0 &&/);
        // No literal quotation text anywhere outside the data-driven blockquote.
        expect(page).not.toMatch(/"[^"]*(coordinator|fundraiser|meals)[^"]*"\s*<\/blockquote>/i);
        expect(page).toMatch(/&ldquo;\{t\.quote\}&rdquo;/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Multi-tenant: nothing tenant-specific in the source
// ═════════════════════════════════════════════════════════════════════════════
describe('C. multi-tenant — nothing tenant-specific written into the page', () => {
    it.each([
        'Freezer Chef', 'MyFreezerChef', 'myfreezerchef', 'Laurie',
        '$125', '$60', '10 sets', '10 years', 'images.unsplash.com',
    ])('does not hardcode: %s', (forbidden) => {
        expect(raw).not.toContain(forbidden);
    });

    it('takes the tenant name from the brand authority on the public payload', () => {
        expect(page).toMatch(/branding\?\.business_name/);
        expect(page).toMatch(/\$\{tenantName\} Fundraisers/);
    });

    it('takes the brand color, hero image, bundles and testimonials from the payload', () => {
        expect(page).toMatch(/branding\?\.primary_color/);
        expect(page).toMatch(/storefrontConfig\?\.hero_image_url/);
        expect(page).toMatch(/tenant\?\.bundles/);
    });

    it('fetches the RELATIVE public tenant path — never NEXT_PUBLIC_APP_URL (PREVIEW-METADATA-ISOLATION-1)', () => {
        expect(page).toMatch(/fetch\(`\/api\/public\/tenant\/\$\{slug\}`\)/);
        expect(raw).not.toMatch(/NEXT_PUBLIC_APP_URL/);
    });

    it('hero falls back to the tenant\'s OWN bundle photos, then a brand-colored panel — never stock imagery', () => {
        expect(page).toMatch(/heroImageUrl \?/);
        expect(page).toMatch(/collage\.length > 0 \?/);
        expect(page).not.toMatch(/unsplash|pexels|shutterstock|istock/i);
    });

    it('pairs Serves-5 / Serves-2 siblings by exact family_id using the shared tier resolver, like the storefront', () => {
        expect(page).toMatch(/import \{ resolveVariantSize \} from '@\/lib\/serving_multipliers'/);
        expect(page).toMatch(/if \(b\.family_id\) \{/);
        expect(page).toMatch(/resolveVariantSize\(m\.serving_tier\) === 'serves_5'/);
        expect(page).toMatch(/resolveVariantSize\(m\.serving_tier\) === 'serves_2'/);
    });

    it('hides the bundle section entirely when the tenant has no public bundles', () => {
        expect(page).toMatch(/bundleTiles\.length > 0 && \(/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. Benefits, not rules — operational program terms are OFF the page
// ═════════════════════════════════════════════════════════════════════════════
describe('D. operational program terms stay off the public page (owner-locked)', () => {
    it.each([
        /two weeks before delivery/i,
        /payment due upon receipt/i,
        /10 days before delivery/i,
        /minimum requirement/i,
        /sets of 5/i,
        /\bTue\b|Tuesday|Wednesday|Thursday/,
        /Final orders are due/i,
        /Choose 2 meal bundles/i,
        /slow-cooker/i,
        /invoice the remaining balance/i,
    ])('does not state: %s', (re) => {
        expect(page).not.toMatch(re);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. The inquiry form is behaviourally unchanged
// ═════════════════════════════════════════════════════════════════════════════
describe('E. inquiry form unchanged (FR-FUNNEL-1 / FR-ACCEPTANCE-1)', () => {
    it('posts to the same endpoint with the same idempotency key', () => {
        expect(page).toContain("fetch('/api/public/fundraiser-request'");
        expect(page).toContain('submissionKeyRef.current = crypto.randomUUID();');
        expect(page).toContain('submissionKey: submissionKeyRef.current,');
        expect(page).toContain('submissionKeyRef.current = null;');
    });

    it('keeps the four required fields and the optional ones', () => {
        for (const key of ['name', 'email', 'phone', 'orgName', 'website', 'deliveryLocation', 'cause', 'notes']) {
            expect(page).toContain(`formData.${key}`);
        }
    });

    it('the website input still does not demand a scheme', () => {
        const i = page.indexOf('formData.website');
        const website = page.slice(Math.max(0, i - 600), i + 200);
        expect(website).not.toMatch(/type="url"/);
        expect(website).toMatch(/type="text"/);
        expect(website).toMatch(/inputMode="url"/);
    });

    it('the hero CTA scrolls to the form; the second CTA opens the sample supporter page', () => {
        expect(page).toContain('id="contact-form"');
        expect(page).toMatch(/onClick=\{scrollToForm\}/);
        // tests/raiseFundsSamplePage.test.ts pins the sample route itself.
        expect(page).toMatch(/href=\{`\/shop\/\$\{slug\}\/raise-funds\/sample`\}/);
        // Exactly two network calls in the file: the public tenant read and the
        // inquiry submit. Nothing in the marketing sections fetches or creates
        // anything — a visitor becomes a lead only by submitting the form.
        expect((page.match(/fetch\(/g) || []).length).toBe(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Scope: presentation only
// ═════════════════════════════════════════════════════════════════════════════
describe('F. scope — presentation only', () => {
    it('no migration directory and no schema change', () => {
        const out = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT, encoding: 'utf8' });
        expect(out).not.toMatch(/prisma\/migrations\//);
        expect(out).not.toMatch(/prisma\/schema\.prisma/);
    });

    it('the inquiry route, lead rule, and public tenant API were not touched', () => {
        const out = execSync('git status --porcelain -- app/api/public/fundraiser-request/route.ts lib/fundraiserLead.ts "app/api/public/tenant/[slug]/route.ts"', { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });
});
