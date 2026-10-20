/**
 * COORDINATOR-GUIDE-CONTACT-1 — the Success Guide names the campaign's OWN tenant.
 *
 * THE DEFECT: app/coordinator/portal/guide/page.tsx hardcoded one tenant's
 * person and inbox ("Let <person> know…", "<person> is here to support you",
 * a literal mailto: address). FreezerIQ is multi-tenant, so a coordinator of
 * any other tenant was told to email a different company.
 *
 * THE CONTRACT:
 *   - The help contact is Business.contact_email of the session campaign's
 *     tenant — the same customer-facing inbox that is the reply-to on all of
 *     that tenant's mail — resolved by lib/tenantBrand.customerFacingContactEmail.
 *   - It is checked by the portal's one recipient rule
 *     (lib/mailtoLink.usableEmailAddress) and linked with mailtoHref; blank or
 *     unusable renders NO help block.
 *   - The tenant is named by the customer-facing name authority, never a literal.
 *   - The retired /coordinator/<token>/guide route stays static and tenant-blind.
 *
 * All fixtures are fictional.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { mailtoHref, usableEmailAddress } from '@/lib/mailtoLink';
import { customerFacingContactEmail } from '@/lib/tenantBrand';
import { GuideSupportContact } from '@/components/coordinator/GuideSupportContact';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Comments may describe the old defect; only code counts. */
const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const TENANT_A = {
    name: 'Northwind Meals LLC',
    display_name: 'Northwind Meals',
    slug: 'northwind-meals',
    custom_domain: null,
    contact_email: 'jordan@example.test',
};
const TENANT_B = {
    name: 'Harbor Kitchen',
    display_name: null,
    slug: 'harbor-kitchen',
    custom_domain: null,
    contact_email: 'casey@example.test',
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. The address authority
// ═════════════════════════════════════════════════════════════════════════════
describe('1. customerFacingContactEmail', () => {
    it('returns the tenant\'s configured address', () => {
        expect(customerFacingContactEmail(TENANT_A)).toBe('jordan@example.test');
        expect(customerFacingContactEmail(TENANT_B)).toBe('casey@example.test');
    });

    it('trims a hand-typed value and preserves its case', () => {
        expect(customerFacingContactEmail({ contact_email: '  Jordan.Lee@Example.test \t' }))
            .toBe('Jordan.Lee@Example.test');
    });

    it.each([
        'jordan+fundraisers@example.test',
        'jordan.lee@mail.example.test',
        "o'neil@example.test",
        'jordan_lee-2@sub-domain.example.test',
    ])('accepts the ordinary address %s', (v) => {
        expect(customerFacingContactEmail({ contact_email: v })).toBe(v);
    });

    it('is null when nothing is configured', () => {
        expect(customerFacingContactEmail(null)).toBeNull();
        expect(customerFacingContactEmail(undefined)).toBeNull();
        expect(customerFacingContactEmail({})).toBeNull();
        expect(customerFacingContactEmail({ contact_email: null })).toBeNull();
        expect(customerFacingContactEmail({ contact_email: '' })).toBeNull();
        expect(customerFacingContactEmail({ contact_email: '   ' })).toBeNull();
        expect(customerFacingContactEmail({ contact_email: 42 as any })).toBeNull();
    });

    it.each([
        'jordan',
        'jordan@',
        '@example.test',
        'jordan@@example.test',
        'jordan@exa@mple.test',
        'jordan @example.test',
        'jordan@example',
        'jordan@example..test',
        'jordan@-example.test',
        '.jordan@example.test',
        'jordan.@example.test',
        'jo..rdan@example.test',
        'javascript:alert(1)//@example.test',
        'javascript:alert(1)',
        '<b>jordan</b>@example.test',
        '"jordan"@example.test',
        'Jordan <jordan@example.test>',
        'jordan@example.test, casey@example.test',
        'jordan@example.test\nBcc: casey@example.test',
        `${'a'.repeat(65)}@example.test`,
        `jordan@${'a'.repeat(250)}.test`,
    ])('is null for the unusable value %j', (v) => {
        expect(customerFacingContactEmail({ contact_email: v })).toBeNull();
    });

    it('is the portal\'s one recipient rule, not a second one', () => {
        for (const v of [
            TENANT_A.contact_email, ' Jordan@Example.test ', 'jordan?cc=x@example.test',
            'a/b@example.test', 'jordan', 'jordan @example.test', 'javascript:alert(1)', '', null,
        ]) {
            expect(customerFacingContactEmail({ contact_email: v as any })).toBe(usableEmailAddress(v));
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The rendered help block
// ═════════════════════════════════════════════════════════════════════════════
describe('2. GuideSupportContact', () => {
    const render = (business: any) => renderToStaticMarkup(createElement(GuideSupportContact, { business }));

    it('links and names the campaign\'s own tenant', () => {
        const html = render(TENANT_A);
        expect(html).toContain('href="mailto:jordan@example.test"');
        expect(html).toContain('jordan@example.test</a>');
        expect(html).toContain('Northwind Meals is here to support you every step of the way.');
        expect(html).toContain('Need Help?');
    });

    it('a second tenant gets its OWN contact, never the first tenant\'s', () => {
        const html = render(TENANT_B);
        expect(html).toContain('href="mailto:casey@example.test"');
        // No display_name → the internal name is the customer-facing name.
        expect(html).toContain('Harbor Kitchen is here to support you');
        expect(html).not.toContain('jordan@example.test');
        expect(html).not.toContain('Northwind');
    });

    it('uses display_name over name, and name when display_name is blank', () => {
        expect(render(TENANT_A)).not.toContain('Northwind Meals LLC');
        expect(render({ ...TENANT_A, display_name: '   ' })).toContain('Northwind Meals LLC is here');
    });

    it('the link carries the trimmed address', () => {
        const html = render({ ...TENANT_A, contact_email: '  jordan@example.test  ' });
        expect(html).toContain('href="mailto:jordan@example.test"');
    });

    it('the link is mailtoHref\'s — URI-significant characters are encoded, so no header can be injected', () => {
        const raw = 'jordan?cc=x@example.test';
        expect(mailtoHref(raw)).toBe('mailto:jordan%3Fcc=x@example.test');
        const html = render({ ...TENANT_A, contact_email: raw });
        expect(html).toContain('href="mailto:jordan%3Fcc=x@example.test"');
        expect(html).not.toContain('href="mailto:jordan?cc');
    });

    it.each([
        ['no business', null],
        ['no contact_email', { ...TENANT_A, contact_email: null }],
        ['a blank contact_email', { ...TENANT_A, contact_email: '  ' }],
        ['a malformed contact_email', { ...TENANT_A, contact_email: 'jordan at example dot test' }],
        ['a script-shaped contact_email', { ...TENANT_A, contact_email: 'javascript:alert(1)' }],
    ])('renders nothing at all for %s', (_label, business) => {
        expect(render(business)).toBe('');
    });

    it('no rendered variant ever carries a hardcoded tenant contact', () => {
        for (const b of [TENANT_A, TENANT_B, null, { ...TENANT_B, contact_email: null }]) {
            const html = render(b);
            expect(html).not.toMatch(/Laurie/i);
            expect(html).not.toMatch(/myfreezerchef/i);
            expect(html).not.toMatch(/Freezer Chef/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. GET /api/coordinator delivers the session campaign's tenant contact
// ═════════════════════════════════════════════════════════════════════════════
const CAMPAIGN_ID = 'campaign-gc1-a';
let mock: PrismaMock;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__gc1Prisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__gc1CookieName ? { name, value: 'gc1-test-secret' } : undefined,
    }),
}));

const campaignFor = (business: any) => ({
    id: CAMPAIGN_ID,
    name: 'Spring Fundraiser',
    status: 'Active',
    end_date: null,
    delivery_date: null,
    delivery_time: null,
    closed_at: null,
    settlement_total: null,
    pickup_location: 'Gym',
    external_payment_link: null,
    payment_instructions: null,
    bundle_goal: 40,
    total_sales: 0,
    org_share_percent: 20,
    participant_label: 'Student',
    bundle_selection_status: 'not_required',
    bundle_selection_limit: 2,
    public_token: 'public-token-gc1',
    customer_id: 'org-gc1',
    customer: {
        name: 'Lakeside PTO',
        contact_name: 'Riley Parent',
        // The ORGANIZATION's inbox — must never be mistaken for the tenant's.
        contact_email: 'riley@pto.example.test',
        business_id: 'biz-gc1',
        business: { ...business, logo_url: null, plan: 'FREE', subscription_status: 'active' },
    },
    orders: [],
});

function useCampaign(business: any) {
    (global as any).__gc1CookieName = coordinatorSessionCookieName();
    mock = createPrismaMock({
        results: {
            'coordinatorSession.findUnique': {
                id: 'session-gc1',
                campaign_id: CAMPAIGN_ID,
                expires_at: new Date(Date.now() + 3_600_000),
                revoked_at: null,
            },
            'fundraiserCampaign.findFirst': campaignFor(business),
            'order.findMany': [],
            'bundle.findMany': [],
        },
    });
    (global as any).__gc1Prisma = mock.client;
}

async function callGet() {
    const { GET } = await import('@/app/api/coordinator/route');
    const res = await GET(new Request('http://localhost/api/coordinator', {
        method: 'GET', headers: { origin: 'http://localhost' },
    }) as any);
    return { status: res.status, body: await res.json() };
}

describe('3. GET /api/coordinator', () => {
    beforeEach(() => jest.clearAllMocks());

    // LOAD-BEARING: the recording double returns its fixture verbatim and does
    // not apply `select`, so only the query shape proves the field is fetched.
    it('selects Business.contact_email for the session\'s campaign', async () => {
        useCampaign(TENANT_A);
        await callGet();
        const q = mock.firstCall('fundraiserCampaign.findFirst');
        expect(q?.args?.where).toEqual({ id: CAMPAIGN_ID });
        expect(q?.args?.select?.customer?.select?.business?.select?.contact_email).toBe(true);
    });

    it('the business allowlist widened by exactly that one field', async () => {
        useCampaign(TENANT_A);
        await callGet();
        const q = mock.firstCall('fundraiserCampaign.findFirst');
        // timezone arrived with COORDINATOR-CONTACT-DATE-1; contact_email is ours.
        expect(Object.keys(q?.args?.select?.customer?.select?.business?.select).sort()).toEqual([
            'contact_email', 'custom_domain', 'display_name', 'logo_url',
            'name', 'plan', 'slug', 'subscription_status', 'timezone',
        ]);
    });

    it.each([
        ['tenant A', TENANT_A, 'jordan@example.test'],
        ['tenant B', TENANT_B, 'casey@example.test'],
    ])('the guide resolves %s\'s own contact from the response', async (_l, business, expected) => {
        useCampaign(business);
        const { status, body } = await callGet();
        expect(status).toBe(200);
        expect(customerFacingContactEmail(body.customer.business)).toBe(expected);
        // The organization's inbox is a different fact and is not used.
        expect(customerFacingContactEmail(body.customer.business)).not.toBe('riley@pto.example.test');
    });

    it('a tenant with no contact yields no guide contact', async () => {
        useCampaign({ ...TENANT_B, contact_email: null });
        const { status, body } = await callGet();
        expect(status).toBe(200);
        expect(customerFacingContactEmail(body.customer.business)).toBeNull();
        expect(renderToStaticMarkup(createElement(GuideSupportContact, { business: body.customer.business }))).toBe('');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Source guards — both guide routes and every coordinator surface
// ═════════════════════════════════════════════════════════════════════════════
const GUIDE = 'app/coordinator/portal/guide/page.tsx';
const LEGACY_GUIDE = 'app/coordinator/[token]/guide/page.tsx';
const COMPONENT = 'components/coordinator/GuideSupportContact.tsx';

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
        else if (/\.tsx?$/.test(name)) out.push(rel);
    }
    return out;
}

describe('4. no hardcoded tenant contact', () => {
    it('the portal guide names no tenant and links no literal address', () => {
        const src = code(read(GUIDE));
        expect(src).not.toMatch(/Laurie/i);
        expect(src).not.toMatch(/myfreezerchef/i);
        expect(src).not.toMatch(/Freezer Chef/);
        expect(src).not.toContain('mailto:');
    });

    it('the portal guide reads its tenant from the session campaign', () => {
        const src = code(read(GUIDE));
        expect(src).toContain('const business = campaign?.customer?.business ?? null;');
        expect(src).toContain('customerFacingBusinessName(business)');
        expect(src).toContain('<GuideSupportContact business={business} />');
        expect(src).toContain("`Let ${tenantName || 'the organizer'} know if you need help setting this up.`");
    });

    it('the help block builds its link only through mailtoHref', () => {
        const src = code(read(COMPONENT));
        expect(src).toContain('customerFacingContactEmail(business)');
        expect(src).toContain('mailtoHref(email)');
        expect(src).toContain('href={href}');
        // No hand-built mailto: string of any kind.
        expect(src).not.toContain('mailto:');
    });

    it('no coordinator surface hardcodes a recipient or a tenant person', () => {
        const files = [...walk('app/coordinator'), ...walk('components/coordinator')];
        expect(files).toEqual(expect.arrayContaining([GUIDE, LEGACY_GUIDE, COMPONENT]));
        for (const f of files) {
            const src = code(read(f));
            expect({ f, literalRecipient: /mailto:[A-Za-z0-9]/.test(src) }).toEqual({ f, literalRecipient: false });
            expect({ f, person: /Laurie|myfreezerchef/i.test(src) }).toEqual({ f, person: false });
        }
    });

    it('the retired /coordinator/<token>/guide route stays static and tenant-blind', () => {
        const src = code(read(LEGACY_GUIDE));
        expect(src).toContain("export const dynamic = 'force-static';");
        expect(src).not.toMatch(/params|prisma|fetch\(|mailto:/);
    });
});
