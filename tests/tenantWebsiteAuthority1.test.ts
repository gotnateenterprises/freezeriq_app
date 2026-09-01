/**
 * TENANT-WEBSITE-AUTHORITY-1 — ONE customer-facing website/URL authority
 * across FreezerIQ, closing the gap TENANT-BRAND-AUTHORITY-2 deliberately
 * deferred: the live 2026 fundraiser flyer/document template hardcoded
 * https://myfreezerchef.com as EVERY tenant's website link.
 *
 * AUTHORITY DISCOVERED, NOT INVENTED: lib/tenantBrand.ts already exports
 * customerFacingWebsite()/resolveTenantBrand(), fully built, already wired
 * into every outbound email template (app/api/email/send/route.ts,
 * lib/inquiryAcknowledgement.ts, app/api/campaigns/[id]/coordinator-email)
 * via resolveTenantBrand(). Those are proven CORRECT here, not fixed.
 *
 * PRIMARY DEFECT, traced to its one real location: the isGlobal seed
 * template 'tmpl_fc_flyer_2026' in app/api/documents/templates/route.ts,
 * rendered client-side by components/DocumentCenter.tsx. lib/generateFlyer.ts
 * (the jsPDF flyer/packet generator behind /api/flyer/generate,
 * /api/flyer/download, /api/packet/download) was independently audited and
 * contains NO website field at all — not broken, not in scope to add one.
 *
 * LEGITIMATE, UNTOUCHED: app/[domain]/page.tsx's two
 * `decodedDomain.includes('myfreezerchef.com')` fallbacks are custom-domain
 * ROUTING for the founding tenant during the single->multi-tenant launch,
 * not a customer-facing link. Proven still intact, not proven "fixed".
 *
 * Two tenant fixtures, used throughout:
 *   Tenant A: display_name "Freezer Chef",        custom_domain "myfreezerchef.com"
 *   Tenant B: display_name "Nate's Freezer Guy",   custom_domain "natesfreezerguy.com"
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { customerFacingWebsite, customerFacingBusinessName } from '@/lib/tenantBrand';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TENANT_A = { id: 'biz-a', name: 'My Freezer Chef', display_name: 'Freezer Chef', slug: 'freezer-chef', custom_domain: 'myfreezerchef.com' };
const TENANT_B = { id: 'biz-b', name: 'Nate Holdings LLC', display_name: "Nate's Freezer Guy", slug: 'nate-freezer-guy', custom_domain: 'natesfreezerguy.com' };
/** No custom domain configured — must fall back to ITS OWN storefront URL, never another tenant's domain. */
const TENANT_NO_DOMAIN = { id: 'biz-c', name: 'No Domain Co', display_name: null, slug: 'no-domain-co', custom_domain: null };

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__twa1Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__twa1Prisma = m.client; };

// Module-level: jest.mock() factories are hoisted per MODULE PATH, not per
// describe block (TENANT-BRAND-AUTHORITY-2's fix, reused here).
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

// ═════════════════════════════════════════════════════════════════════════════
// 1. The authority itself — discovered, not invented; untouched by this phase.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. website authority discovered: lib/tenantBrand.ts, not a new resolver', () => {
    it('customerFacingWebsite exists and is untouched by this phase', () => {
        const src = read('lib/tenantBrand.ts');
        expect(src).toMatch(/export function customerFacingWebsite\(/);
        expect(src).toMatch(/const domain = normalizeDomain\(business\.custom_domain \?\? ''\);/);
        expect(src).toMatch(/if \(domain\) return \{ url: `https:\/\/\$\{domain\}`, label: domain \};/);
    });

    it('Tenant A resolves to its own custom domain', () => {
        const site = customerFacingWebsite(TENANT_A);
        expect(site.url).toBe('https://myfreezerchef.com');
        expect(site.label).toBe('myfreezerchef.com');
    });

    it('Tenant B resolves to ITS OWN custom domain — never Tenant A\'s', () => {
        const site = customerFacingWebsite(TENANT_B);
        expect(site.url).toBe('https://natesfreezerguy.com');
        expect(site.label).toBe('natesfreezerguy.com');
        expect(site.url).not.toBe('https://myfreezerchef.com');
        expect(site.label).not.toBe('myfreezerchef.com');
    });

    it('a tenant with no custom domain falls back to its OWN storefront URL, never another tenant\'s domain', () => {
        const site = customerFacingWebsite(TENANT_NO_DOMAIN, 'https://www.freezeriqapp.com');
        expect(site.url).toBe('https://www.freezeriqapp.com/shop/no-domain-co');
        expect(site.label).not.toMatch(/myfreezerchef/i);
        expect(site.label).not.toMatch(/natesfreezerguy/i);
    });

    it('with no custom domain AND no resolvable origin/slug, resolves to null/null — no fallback to another tenant\'s domain', () => {
        const site = customerFacingWebsite({ name: 'x', slug: '' }, 'https://www.freezeriqapp.com');
        expect(site.url).toBeNull();
        expect(site.label).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. GET /api/tenant/branding exposes the tenant-derived website.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. GET /api/tenant/branding: business_website is the composed authority', () => {
    const call = async (businessId: string) => {
        mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId } });
        const { GET } = await import('@/app/api/tenant/branding/route');
        const res = await GET(new Request('http://localhost/api/tenant/branding') as any);
        return res.json();
    };

    beforeEach(() => jest.clearAllMocks());

    it('DEFECT: Tenant A gets its OWN website', async () => {
        useMock(createPrismaMock({ results: { 'business.findUnique': TENANT_A, 'tenantBranding.findFirst': null } }));
        const body = await call(TENANT_A.id);
        expect(body.business_website_url).toBe('https://myfreezerchef.com');
        expect(body.business_website_label).toBe('myfreezerchef.com');
    });

    it('DEFECT: Tenant B gets its OWN website — never Tenant A\'s myfreezerchef.com', async () => {
        useMock(createPrismaMock({ results: { 'business.findUnique': TENANT_B, 'tenantBranding.findFirst': null } }));
        const body = await call(TENANT_B.id);
        expect(body.business_website_url).toBe('https://natesfreezerguy.com');
        expect(body.business_website_label).toBe('natesfreezerguy.com');
        expect(body.business_website_url).not.toMatch(/myfreezerchef/);
        expect(body.business_website_label).not.toMatch(/myfreezerchef/);
    });

    it('a tenant with no custom domain gets ITS OWN storefront URL, not another tenant\'s domain, even when a TenantBranding row exists', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': TENANT_NO_DOMAIN,
                'tenantBranding.findFirst': { business_name: 'irrelevant', primary_color: '#111' },
            },
        }));
        const body = await call(TENANT_NO_DOMAIN.id);
        expect(body.business_website_label).toMatch(/no-domain-co/);
        expect(body.business_website_label).not.toMatch(/myfreezerchef/i);
    });

    it('the route selects custom_domain on Business', async () => {
        useMock(createPrismaMock({ results: { 'business.findUnique': TENANT_A, 'tenantBranding.findFirst': null } }));
        await call(TENANT_A.id);
        const select = mock.firstCall('business.findUnique')?.args?.select;
        expect(select?.custom_domain).toBe(true);
    });

    it('the route imports and calls the shared website authority — not a new resolver', () => {
        const src = strip(read('app/api/tenant/branding/route.ts'));
        expect(src).toMatch(/customerFacingWebsite\(/);
    });

    it('BusinessName remains independently dynamic: differing name/website combinations both resolve correctly and independently', async () => {
        const mixed = { id: 'biz-mixed', name: 'Mixed Co', display_name: 'Mixed Brand', slug: 'mixed-co', custom_domain: 'mixedbrand.com' };
        useMock(createPrismaMock({ results: { 'business.findUnique': mixed, 'tenantBranding.findFirst': null } }));
        const body = await call(mixed.id);
        expect(body.business_name).toBe('Mixed Brand');
        expect(body.business_website_url).toBe('https://mixedbrand.com');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Document templates — the isGlobal seed content, the actual live defect.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. document templates: no hardcoded tenant website in seed content', () => {
    const getFlyerTemplate = async () => {
        mockAuth.mockResolvedValue({ user: { businessId: TENANT_B.id } });
        useMock(createPrismaMock({ results: { 'documentTemplate.findMany': [] } }));
        const { GET } = await import('@/app/api/documents/templates/route');
        const res = await GET(new Request('http://localhost/api/documents/templates') as any);
        const templates = await res.json();
        return templates.find((t: any) => t.id === 'tmpl_fc_flyer_2026');
    };

    it('DEFECT: the seed flyer template no longer hardcodes https://myfreezerchef.com', async () => {
        const flyer = await getFlyerTemplate();
        expect(flyer.content).not.toMatch(/myfreezerchef\.com/i);
    });

    it('DEFECT: the seed flyer template uses the {{BusinessWebsite}} merge field instead', async () => {
        const flyer = await getFlyerTemplate();
        expect(flyer.content).toMatch(/\{\{BusinessWebsite\}\}/);
    });

    it('the BusinessName merge field is untouched by this phase — still present, independently', async () => {
        const flyer = await getFlyerTemplate();
        expect(flyer.content).toMatch(/\{\{BusinessName\}\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. DocumentCenter.tsx — fetches, substitutes, and safely OMITS.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. DocumentCenter substitutes {{BusinessWebsite}} and omits safely when unavailable', () => {
    it('DEFECT: DocumentCenter now handles the {{BusinessWebsite}} merge field', () => {
        const src = strip(read('components/DocumentCenter.tsx'));
        expect(src).toMatch(/\{\{BusinessWebsite\}\}/);
    });

    it('DocumentCenter resolves the website from the SAME /api/tenant/branding fetch already used for BusinessName — no second network call', () => {
        const src = strip(read('components/DocumentCenter.tsx'));
        const fetchCount = (src.match(/fetch\(['"`]\/api\/tenant\/branding['"`]\)/g) || []).length;
        expect(fetchCount).toBe(1);
    });

    it('the website merge field defaults to an EMPTY value, never a hardcoded literal — the omit-safe contract', () => {
        const src = strip(read('components/DocumentCenter.tsx'));
        // The state declaration's initial value must be the empty string, not
        // e.g. 'myfreezerchef.com' or any other tenant's domain.
        expect(src).toMatch(/useState<string>\(''\)/);
        // Nothing in the file may hardcode a competing tenant's domain as a
        // fallback for the website merge field.
        expect(src).not.toMatch(/myfreezerchef\.com/i);
        expect(src).not.toMatch(/natesfreezerguy\.com/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. OrganizationName / campaign identity — untouched by the website wiring.
// ═════════════════════════════════════════════════════════════════════════════
describe('5-7. BusinessName, OrganizationName and campaign identity remain independently correct', () => {
    it('{{OrganizationName}} is untouched — still resolves from the campaign customer, not the tenant website', () => {
        const src = strip(read('components/DocumentCenter.tsx'));
        expect(src).toMatch(/\{\{OrganizationName\}\}\/g, customer\.name/);
    });

    it('{{BusinessName}} is untouched by this phase\'s website wiring — still its own independent token', () => {
        const src = strip(read('components/DocumentCenter.tsx'));
        expect(src).toMatch(/\{\{BusinessName\}\}\/g, businessName \|\| 'our team'/);
    });

    it('campaign name in the flyer/packet routes is untouched — still campaign.name, never the tenant website', () => {
        for (const file of ['app/api/flyer/generate/route.ts', 'app/api/flyer/download/route.ts', 'app/api/packet/download/route.ts']) {
            const src = strip(read(file));
            expect(src).toMatch(/campaignName:\s*campaign\.name/);
        }
    });

    it('lib/generateFlyer.ts (the PDF generator) has no website field at all — audited, correctly left untouched, not the defect', () => {
        const src = strip(read('lib/generateFlyer.ts'));
        expect(src).not.toMatch(/myfreezerchef/i);
        expect(src).not.toMatch(/websiteUrl|businessWebsite/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Routing preservation — the LEGITIMATE myfreezerchef.com occurrences.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. legitimate myfreezerchef.com domain-routing recognition is preserved', () => {
    it('app/[domain]/page.tsx still recognizes the founding tenant\'s custom domain for routing (generateMetadata AND the page component)', () => {
        const src = strip(read('app/[domain]/page.tsx'));
        const hits = (src.match(/decodedDomain\.includes\('myfreezerchef\.com'\)/g) || []).length;
        expect(hits).toBe(2);
    });

    it('the routing fallback still resolves to the my-freezer-chef slug — unchanged behavior', () => {
        const src = strip(read('app/[domain]/page.tsx'));
        const matches = src.match(/slug: 'my-freezer-chef'/g) || [];
        expect(matches.length).toBe(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. TWO-TENANT REGRESSION GUARD — the resolver itself, end to end.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. two-tenant proof: the same resolver renders each tenant\'s OWN website', () => {
    it('Tenant A name AND website both resolve to Tenant A\'s own values', () => {
        expect(customerFacingBusinessName(TENANT_A)).toBe('Freezer Chef');
        expect(customerFacingWebsite(TENANT_A).label).toBe('myfreezerchef.com');
    });

    it('Tenant B name AND website both resolve to Tenant B\'s own values — never Tenant A\'s', () => {
        expect(customerFacingBusinessName(TENANT_B)).toBe("Nate's Freezer Guy");
        expect(customerFacingWebsite(TENANT_B).label).toBe('natesfreezerguy.com');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. REGRESSION GUARD — narrowly scoped to the exact files this phase fixed.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. regression guard — no hardcoded tenant website on fixed surfaces', () => {
    const GUARDED_NO_HARDCODE = [
        'app/api/tenant/branding/route.ts',
        'app/api/documents/templates/route.ts',
        'components/DocumentCenter.tsx',
    ];

    it.each(GUARDED_NO_HARDCODE)('%s contains no hardcoded myfreezerchef.com literal', (file) => {
        const src = strip(read(file));
        expect(src).not.toMatch(/myfreezerchef\.com/i);
    });

    it('app/api/tenant/branding/route.ts GET response includes business_website_url in BOTH branches (no-row and populated-row)', () => {
        const src = strip(read('app/api/tenant/branding/route.ts'));
        const hits = (src.match(/business_website_url:/g) || []).length;
        expect(hits).toBe(2);
    });
});
