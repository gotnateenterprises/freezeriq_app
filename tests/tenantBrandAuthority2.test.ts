/**
 * TENANT-BRAND-AUTHORITY-2 — ONE customer-facing business-name authority
 * across FreezerIQ: Business.display_name (falling back to Business.name),
 * via the existing lib/tenantBrand.customerFacingBusinessName(). No second
 * resolver, and TenantBranding.business_name must not independently
 * override the public identity anywhere.
 *
 * PRODUCTION DATA SAFETY CHECK (Part C), already performed read-only before
 * any code was touched: the one real TenantBranding row in Production
 * (business "My Freezer Chef") has business_name = 'Freezer Chef', which
 * EXACTLY MATCHES Business.display_name = 'Freezer Chef' for that same
 * business. No divergent value exists to lose. Confirmed clear, not assumed.
 *
 * DEAD CODE FOUND, NOT FIXED: components/crm/MarketingFlyer.tsx has ZERO
 * importers anywhere in the repo (verified by rg). It looked like "the
 * fundraiser marketing flyer" but is unreachable. The REAL, live flyer
 * generator is lib/generateFlyer.ts, called from app/api/flyer/generate and
 * app/api/flyer/download — both fixed below. This corrects an assumption
 * TENANT-BRAND-AUTHORITY-1's audit made without verifying importers.
 *
 * Two tenant fixtures, used throughout:
 *   Tenant A: name "My Freezer Chef", display_name "Freezer Chef"
 *   Tenant B: name "Nate Holdings LLC", display_name "Nate's Freezer Guy"
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { customerFacingBusinessName } from '@/lib/tenantBrand';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TENANT_A = { id: 'biz-a', name: 'My Freezer Chef', display_name: 'Freezer Chef', slug: 'freezer-chef' };
const TENANT_B = { id: 'biz-b', name: 'Nate Holdings LLC', display_name: "Nate's Freezer Guy", slug: 'nate-freezer-guy' };
/** An UNCONFIGURED tenant: no display_name set, own internal name is bland. */
const TENANT_UNCONFIGURED = { id: 'biz-u', name: 'Unconfigured Test Tenant', display_name: null, slug: 'unconfigured' };

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__tba2Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__tba2Prisma = m.client; };

// A single, module-level mock: jest.mock() factories are hoisted per MODULE
// PATH, not per describe block, so this must be declared once here (not
// inside each describe) and driven per-test via mockAuth.mockResolvedValue().
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

// ═════════════════════════════════════════════════════════════════════════════
// 1. GET /api/tenant/branding — composes the authority, not the legacy column.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. GET /api/tenant/branding: business_name is the composed authority', () => {
    const call = async () => {
        const { GET } = await import('@/app/api/tenant/branding/route');
        const res = await GET(new Request('http://localhost/api/tenant/branding') as any);
        return res.json();
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId: TENANT_A.id } });
    });

    it('DEFECT (when a TenantBranding row exists): returns display_name-derived name, not the raw legacy column', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': TENANT_A,
                // The legacy row LOOKS plausible but must not win — this proves
                // the read no longer trusts it even when populated.
                'tenantBranding.findFirst': { business_name: 'Some Stale Legacy Name', primary_color: '#111', logo_url: 'x.png' },
            },
        }));
        const body = await call();
        expect(body.business_name).toBe('Freezer Chef');
        expect(body.business_name).not.toBe('Some Stale Legacy Name');
    });

    it('Tenant B gets its OWN name, never Tenant A\'s and never the legacy default', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': TENANT_B,
                'tenantBranding.findFirst': null,
            },
        }));
        mockAuth.mockResolvedValue({ user: { id: 'user-2', businessId: TENANT_B.id } });
        const body = await call();
        expect(body.business_name).toBe("Nate's Freezer Guy");
        expect(body.business_name).not.toBe('Freezer Chef');
    });

    it('an UNCONFIGURED tenant (no display_name, no TenantBranding row) falls back to Business.name — never the literal "Freezer Chef"', async () => {
        useMock(createPrismaMock({
            results: { 'business.findUnique': TENANT_UNCONFIGURED, 'tenantBranding.findFirst': null },
        }));
        mockAuth.mockResolvedValue({ user: { id: 'user-3', businessId: TENANT_UNCONFIGURED.id } });
        const body = await call();
        expect(body.business_name).toBe('Unconfigured Test Tenant');
        expect(body.business_name).not.toBe('Freezer Chef');
    });

    it('visual branding (colors/logo/tagline) still comes from TenantBranding when a row exists — unchanged', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': TENANT_A,
                'tenantBranding.findFirst': {
                    business_name: 'irrelevant now', primary_color: '#abcdef', logo_url: 'https://x/logo.png', tagline: 'Custom tagline',
                },
            },
        }));
        const body = await call();
        expect(body.primary_color).toBe('#abcdef');
        expect(body.logo_url).toBe('https://x/logo.png');
        expect(body.tagline).toBe('Custom tagline');
    });

    it('the route selects display_name on Business', async () => {
        useMock(createPrismaMock({ results: { 'business.findUnique': TENANT_A, 'tenantBranding.findFirst': null } }));
        await call();
        const select = mock.firstCall('business.findUnique')?.args?.select;
        expect(select?.display_name).toBe(true);
    });

    it('the route imports and calls the shared authority', () => {
        const src = strip(read('app/api/tenant/branding/route.ts'));
        expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
        expect(src).toMatch(/customerFacingBusinessName\(/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. POST /api/tenant/branding — Branding Settings SAVE.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. POST /api/tenant/branding: business name saves to Business.display_name', () => {
    const postForm = (fields: Record<string, string>) => {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const req = new Request('http://localhost/api/tenant/branding', { method: 'POST' }) as any;
        req.formData = async () => fd;
        return req;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId: TENANT_B.id } });
        useMock(createPrismaMock({
            results: {
                'tenantBranding.findFirst': null,
                'tenantBranding.upsert': { user_id: 'user-1', business_name: 'whatever' },
            },
        }));
    });

    it('DEFECT: saving a new business name writes Business.display_name', async () => {
        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(postForm({
            business_name: "Nate's Freezer Guy", contact_email: 'x@y.com', tagline: '', thank_you_note: '',
            review_prompt: '', sign_off: '', primary_color: '#000', secondary_color: '#000', accent_color: '#000',
        }));

        const businessUpdate = mock.firstCall('business.update');
        expect(businessUpdate).toBeDefined();
        expect(businessUpdate?.args?.data?.display_name).toBe("Nate's Freezer Guy");
        expect(businessUpdate?.args?.where?.id).toBe(TENANT_B.id);
    });

    it('the SAME save also still updates contact_email on Business — one write, not two competing ones', async () => {
        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(postForm({
            business_name: 'X', contact_email: 'hello@nate.example', tagline: '', thank_you_note: '',
            review_prompt: '', sign_off: '', primary_color: '#000', secondary_color: '#000', accent_color: '#000',
        }));
        expect(mock.callsTo('business.update')).toHaveLength(1);
        expect(mock.firstCall('business.update')?.args?.data).toMatchObject({
            contact_email: 'hello@nate.example', display_name: 'X',
        });
    });

    it('visual settings (colors/logo/tagline) are still written to TenantBranding — unchanged', async () => {
        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(postForm({
            business_name: 'X', contact_email: '', tagline: 'My tagline', thank_you_note: 'Thanks!',
            review_prompt: 'Please review', sign_off: 'The Team', primary_color: '#123456', secondary_color: '#654321', accent_color: '#abcabc',
        }));
        const upsert = mock.firstCall('tenantBranding.upsert');
        expect(upsert?.args?.create).toMatchObject({
            tagline: 'My tagline', primary_color: '#123456', secondary_color: '#654321', accent_color: '#abcabc',
        });
    });

    it('clearing the business name field clears display_name (falls back to Business.name) rather than writing an empty string', async () => {
        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(postForm({
            business_name: '   ', contact_email: '', tagline: '', thank_you_note: '',
            review_prompt: '', sign_off: '', primary_color: '#000', secondary_color: '#000', accent_color: '#000',
        }));
        expect(mock.firstCall('business.update')?.args?.data?.display_name).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. General storefront — /api/public/tenant/[slug] and its consumers.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. general storefront: public tenant API composes the authority', () => {
    const call = async (slug: string) => {
        const { GET } = await import('@/app/api/public/tenant/[slug]/route');
        const res = await GET(
            new Request(`http://localhost/api/public/tenant/${slug}`) as any,
            { params: Promise.resolve({ slug }) },
        );
        return res.json();
    };

    beforeEach(() => {
        jest.clearAllMocks();
        useMock(createPrismaMock({
            results: {
                'business.findFirst': (args: any) => (args?.where?.slug === TENANT_B.slug ? TENANT_B : TENANT_A),
                'bundle.findMany': [],
                'fundraiserCampaign.findMany': [],
            },
        }));
    });

    it('DEFECT: Tenant A storefront returns "Freezer Chef", not the legacy tenant_branding row', async () => {
        const body = await call(TENANT_A.slug);
        expect(body.business.branding.business_name).toBe('Freezer Chef');
    });

    it('Tenant B storefront returns its OWN name — never "Freezer Chef"', async () => {
        const body = await call(TENANT_B.slug);
        expect(body.business.branding.business_name).toBe("Nate's Freezer Guy");
        expect(body.business.branding.business_name).not.toBe('Freezer Chef');
    });

    it('the business select includes display_name', async () => {
        await call(TENANT_A.slug);
        const select = mock.firstCall('business.findFirst')?.args?.select;
        expect(select?.display_name).toBe(true);
    });

    it('the route imports the shared authority', () => {
        const src = strip(read('app/api/public/tenant/[slug]/route.ts'));
        expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
        expect(src).toMatch(/customerFacingBusinessName\(/);
    });

    it('StorefrontClient consumes branding.business_name directly — no independent literal fallback needed for the fix to work', () => {
        const src = strip(read('app/shop/[slug]/StorefrontClient.tsx'));
        // The pre-existing defensive "!== FreezerIQ" guards are harmless and
        // untouched; what matters is the SOURCE value is now always correct.
        expect(src).toMatch(/branding\.business_name/);
    });

    it('storefront metadata (page title) uses the same fixed endpoint', () => {
        const src = strip(read('app/shop/[slug]/page.tsx'));
        expect(src).toMatch(/api\/public\/tenant\//);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Subscribe page — separate Prisma path, fixed directly.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. subscribe page: title and page use the authority', () => {
    it('generateMetadata no longer falls back to a hardcoded "Freezer Chef" literal without trying display_name first', () => {
        const src = strip(read('app/shop/[slug]/subscribe/page.tsx'));
        expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
        expect(src).toMatch(/customerFacingBusinessName\(/);
    });

    it('the business query selects display_name (or select is omitted, which already returns it)', () => {
        const src = strip(read('app/shop/[slug]/subscribe/page.tsx'));
        // Either an explicit display_name in a select, or no select object at
        // all on the business query (Prisma returns every scalar by default).
        const hasExplicitSelect = /business\.findUnique\(\{\s*where:\s*\{\s*slug\s*\},\s*select:/.test(src);
        if (hasExplicitSelect) {
            expect(src).toMatch(/select:\s*\{[^}]*display_name/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Fundraiser marketing flyer (the REAL, live one) + coordinator packet.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. fundraiser marketing flyer + packet: business name authority', () => {
    it('components/crm/MarketingFlyer.tsx is DEAD CODE — zero importers, correctly left unfixed', () => {
        const fs = require('fs');
        const path = require('path');
        let scanned = 0;
        const hits: string[] = [];
        const walk = (dir: string) => {
            let entries: any[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.next') walk(full); }
                else if (/\.(ts|tsx)$/.test(e.name) && full !== path.join(ROOT, 'components/crm/MarketingFlyer.tsx')) {
                    scanned++;
                    // An IMPORT/usage, not a prose mention — lib/generateFlyer.ts's
                    // own header comment references MarketingFlyer.tsx as the
                    // visual design it mirrored, which is not an importer.
                    if (/(?:from\s+['"][^'"]*MarketingFlyer['"]|<MarketingFlyer\b)/.test(fs.readFileSync(full, 'utf8'))) hits.push(full);
                }
            }
        };
        for (const root of ['app', 'components', 'lib']) walk(path.join(ROOT, root));
        expect(scanned).toBeGreaterThan(100);
        expect(hits).toEqual([]);
    });

    it.each(['app/api/flyer/generate/route.ts', 'app/api/flyer/download/route.ts', 'app/api/packet/download/route.ts'])(
        'DEFECT: %s no longer assigns raw Business.name to businessName',
        (file) => {
            const src = strip(read(file));
            expect(src).not.toMatch(/businessName = business\.name;/);
        },
    );

    it.each(['app/api/flyer/generate/route.ts', 'app/api/flyer/download/route.ts', 'app/api/packet/download/route.ts'])(
        '%s selects display_name and calls the shared authority',
        (file) => {
            const src = strip(read(file));
            expect(src).toMatch(/from ['"]@\/lib\/tenantBrand['"]/);
            expect(src).toMatch(/select:\s*\{[^}]*display_name/);
            expect(src).toMatch(/businessName = customerFacingBusinessName\(business\)/);
        },
    );

    it('the checks-payable-to campaign field is untouched by this phase in all three routes', () => {
        for (const file of ['app/api/flyer/generate/route.ts', 'app/api/flyer/download/route.ts', 'app/api/packet/download/route.ts']) {
            const src = strip(read(file));
            expect(src).toMatch(/checksPayable:\s*campaign\.checks_payable \|\| ''/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Document templates — the isGlobal seed content, via DocumentCenter.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. document templates: no hardcoded tenant identity in seed content', () => {
    const getTemplates = async () => {
        mockAuth.mockResolvedValue({ user: { businessId: TENANT_B.id } });
        useMock(createPrismaMock({ results: { 'documentTemplate.findMany': [] } }));
        const { GET } = await import('@/app/api/documents/templates/route');
        const res = await GET(new Request('http://localhost/api/documents/templates') as any);
        return res.json();
    };

    it('DEFECT: the seed "Fundraiser Agreement" no longer names "Freezer Chef" directly — uses a merge field', async () => {
        const templates = await getTemplates();
        const agreement = templates.find((t: any) => t.id === 'tmpl_basic_agreement');
        expect(agreement.content).not.toMatch(/Freezer Chef fundraising program/);
        expect(agreement.content).toMatch(/\{\{BusinessName\}\}/);
    });

    it('DEFECT: the seed flyer template body no longer hardcodes "Freezer Chef" as the sender identity', async () => {
        const templates = await getTemplates();
        const flyer = templates.find((t: any) => t.id === 'tmpl_fc_flyer_2026');
        expect(flyer.content).not.toMatch(/At Freezer Chef, we bring/);
        expect(flyer.content).toMatch(/\{\{BusinessName\}\}/);
    });

    it('DocumentCenter fetches branding and substitutes {{BusinessName}}', () => {
        const src = strip(read('components/DocumentCenter.tsx'));
        expect(src).toMatch(/fetch\(['"`]\/api\/tenant\/branding['"`]\)/);
        expect(src).toMatch(/\{\{BusinessName\}\}/);
    });

    it('the organization merge field is untouched — {{OrganizationName}} still resolves from the campaign customer, not the tenant', () => {
        const src = strip(read('components/DocumentCenter.tsx'));
        expect(src).toMatch(/\{\{OrganizationName\}\}\/g, customer\.name/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. StorefrontHero — presentational, fixed at its own hardcoded fallback.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. StorefrontHero fallback is no longer a specific competing tenant name', () => {
    it('DEFECT: the fallback is no longer the literal "Freezer Chef"', () => {
        const src = strip(read('components/shop/StorefrontHero.tsx'));
        expect(src).not.toMatch(/\?\s*'Freezer Chef'\s*:\s*businessName/);
    });

    it('the FreezerIQ-platform-name exclusion guard is preserved (legitimate, unrelated to this defect)', () => {
        const src = strip(read('components/shop/StorefrontHero.tsx'));
        expect(src).toMatch(/businessName === 'FreezerIQ'/);
        expect(src).toMatch(/businessName === 'Freezer IQ'/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Public customer loyalty lookup.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. public loyalty lookup uses the authority', () => {
    it('DEFECT: no longer returns raw Business.name', () => {
        const src = strip(read('app/api/public/customer/loyalty/route.ts'));
        expect(src).not.toMatch(/business_name:\s*business\.name,/);
        expect(src).toMatch(/customerFacingBusinessName\(/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8b. Tenant invoice PDF — fixed FOR FREE by the /api/tenant/branding source
//     fix (section 1), not by touching app/invoices/page.tsx directly. Proven
//     explicitly here because it is a named, required test target (Part I
//     item 4) and mutation target (Part K M2), and it consumes a DIFFERENT
//     endpoint than the storefront (section 3) — the two must not be
//     conflated.
// ═════════════════════════════════════════════════════════════════════════════
describe('8b. tenant invoice PDF name — fixed via the branding source, not touched directly', () => {
    it('PRESERVATION: app/invoices/page.tsx is untouched by this phase — same four call sites, same fetch', () => {
        const src = strip(read('app/invoices/page.tsx'));
        expect(src).toMatch(/fetch\(['"`]\/api\/tenant\/branding['"`]\)/);
        const siteCount = (src.match(/branding\?\.business_name/g) || []).length;
        expect(siteCount).toBe(4);
    });

    it('DEFECT, traced to its real source: an invoice PDF reads business_name from GET /api/tenant/branding, which now returns the composed authority', async () => {
        // This is the same assertion as section 1's GET tests, re-stated here
        // to make the invoice's dependency explicit and independently provable
        // — app/invoices/page.tsx has no logic of its own to test; its
        // correctness is entirely a function of what this endpoint returns.
        mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId: TENANT_B.id } });
        useMock(createPrismaMock({ results: { 'business.findUnique': TENANT_B, 'tenantBranding.findFirst': null } }));
        const { GET } = await import('@/app/api/tenant/branding/route');
        const res = await GET(new Request('http://localhost/api/tenant/branding') as any);
        const body = await res.json();
        // What app/invoices/page.tsx:236,359,426,499 would each render:
        expect(body.business_name).toBe("Nate's Freezer Guy");
        expect(body.business_name).not.toBe('Freezer Chef');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9/10. Organization and campaign identity remain distinct from tenant name.
// ═════════════════════════════════════════════════════════════════════════════
describe('9-10. organization and campaign identity remain distinct', () => {
    it('the flyer routes pass organizationName and campaignName from the CAMPAIGN/customer, never from Business', () => {
        for (const file of ['app/api/flyer/generate/route.ts', 'app/api/flyer/download/route.ts']) {
            const src = strip(read(file));
            expect(src).toMatch(/organizationName:\s*orgName/);
            expect(src).toMatch(/campaignName:\s*campaign\.name/);
        }
    });

    it('DEFECT: the generateFlyer/generateFullPacket call sites pass the RESOLVED businessName variable — never orgName/campaign.name substituted in', () => {
        // Distinct from the assignment-site check above: this catches a
        // mutation at the CALL SITE (the object literal handed to the
        // generator), where the businessName VARIABLE could be left correctly
        // assigned upstream but silently swapped for organization/campaign
        // data at the point of use.
        for (const file of ['app/api/flyer/generate/route.ts', 'app/api/flyer/download/route.ts', 'app/api/packet/download/route.ts']) {
            const src = strip(read(file));
            const call = src.slice(src.search(/generateFlyer\(\{|generateFullPacket\(\{/));
            expect(call).toMatch(/\bbusinessName,/);
            expect(call).not.toMatch(/businessName:\s*orgName/);
            expect(call).not.toMatch(/businessName:\s*campaign\.name/);
        }
    });

    it('customerFacingBusinessName has no organization/campaign field in its input type (structural proof of separation)', () => {
        const src = read('lib/tenantBrand.ts');
        expect(src).toMatch(/interface TenantBrandSource/);
        expect(src).not.toMatch(/organization/i);
        expect(src).not.toMatch(/campaign/i);
    });

    it('lib/tenantBrand.ts itself is untouched by this phase — same authority, not a new one', () => {
        const src = read('lib/tenantBrand.ts');
        // The exact function signature from TENANT-BRAND-AUTHORITY-1, unchanged.
        expect(src).toMatch(/export function customerFacingBusinessName\(business: TenantBrandSource\): string \{/);
        expect(src).toMatch(/const display = \(business\.display_name \?\? ''\)\.trim\(\);/);
        expect(src).toMatch(/return display \|\| business\.name;/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. TWO-TENANT REGRESSION GUARD — the authority itself, end to end.
// ═════════════════════════════════════════════════════════════════════════════
describe('11. two-tenant proof: the same resolver renders each tenant correctly', () => {
    it('Tenant A', () => {
        expect(customerFacingBusinessName(TENANT_A)).toBe('Freezer Chef');
    });
    it('Tenant B — never Tenant A\'s name', () => {
        const name = customerFacingBusinessName(TENANT_B);
        expect(name).toBe("Nate's Freezer Guy");
        expect(name).not.toBe('Freezer Chef');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. REGRESSION GUARD — narrowly scoped to the exact files this phase fixed.
//     Not a repo-wide sweep: it would trip on tests, historical docs, and the
//     legitimate proper-noun/dead-code exceptions this audit found.
// ═════════════════════════════════════════════════════════════════════════════
describe('12. regression guard — no hardcoded brand or TenantBranding-as-authority on fixed surfaces', () => {
    const GUARDED_NO_HARDCODE = [
        'app/api/tenant/branding/route.ts',
        'app/api/public/tenant/[slug]/route.ts',
        'app/shop/[slug]/subscribe/page.tsx',
        'app/api/flyer/generate/route.ts',
        'app/api/flyer/download/route.ts',
        'app/api/packet/download/route.ts',
        'app/api/public/customer/loyalty/route.ts',
    ];

    it.each(GUARDED_NO_HARDCODE)('%s contains no quoted "Freezer Chef" / "My Freezer Chef" literal as a NAME fallback', (file) => {
        const src = strip(read(file));
        // "My Business" and similar last-resort UI placeholders are fine; the
        // specific competing-tenant literal is not.
        expect(src).not.toMatch(/['"`]My Freezer Chef['"`]/);
        expect(src).not.toMatch(/(?<!\{\{)['"`]Freezer Chef['"`]/);
    });

    it('app/api/tenant/branding/route.ts GET no longer returns the raw TenantBranding.business_name value as business_name', () => {
        const src = strip(read('app/api/tenant/branding/route.ts'));
        // The old spread-and-trust pattern must be gone from the populated-row
        // branch: `...branding` alone (with no override) would leak it back.
        expect(src).toMatch(/\.\.\.branding,[\s\S]{0,100}business_name:\s*customerFacingName/);
    });
});
