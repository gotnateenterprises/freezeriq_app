/**
 * PREVIEW-METADATA-ISOLATION-1 — follow-up to PREVIEW-DB-ISOLATION-1.
 *
 * `/shop/[slug]` generateMetadata() self-fetched this application's OWN public
 * API through `NEXT_PUBLIC_APP_URL` — one value shared by Production, Preview
 * and local dev (a single Vercel entry, confirmed in the PREVIEW-DB-ISOLATION-1
 * audit). So a Preview deployment's storefront <title>/description/OpenGraph
 * tags for a real tenant slug were rendered from PRODUCTION's live data, even
 * though the Preview database has no such tenant and the page BODY (which
 * fetches the RELATIVE path '/api/public/tenant/<slug>', resolved by the
 * browser against whichever origin served the page) correctly showed
 * not-found.
 *
 * FIX: generateMetadata now resolves the tenant and its branding DIRECTLY from
 * this deployment's own database — the same `prisma` client PREVIEW-DB-ISOLATION-1
 * already made environment-correct, and the exact pattern the two sibling
 * metadata functions already used (app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx,
 * app/[domain]/page.tsx). No environment-tier branching was needed: removing the
 * self-fetch removes the cross-environment path entirely.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PAGE_PATH = 'app/shop/[slug]/page.tsx';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__pmi1Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__pmi1Prisma = m.client; };

const REAL_PRODUCTION_TENANT = { id: 'biz-real-1', name: 'Edgar County Farm Bureau Kitchen', display_name: 'Freezer Chef', logo_url: 'https://images.freezeriqapp.com/real-logo.png' };
const PREVIEW_FIXTURE_TENANT = { id: '7e57b000-0000-4000-8000-000000000001', name: 'Preview Test Tenant', display_name: null, logo_url: null };

async function callMetadata(slug: string) {
    // Matches the established convention (tests/tenantBrandAuthority2.test.ts,
    // tests/tenantWebsiteAuthority1.test.ts): a dynamic import per call, relying
    // on lib/db's `get prisma()` mock to pick up the CURRENT useMock() state on
    // every property access — no jest.isolateModules needed.
    const { generateMetadata } = await import('@/app/shop/[slug]/page');
    return generateMetadata({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
    jest.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// A/E. No self-fetch, no Production hostname, as the DATA source.
// ═════════════════════════════════════════════════════════════════════════════
describe('A/E. metadata never fetches this app\'s own API, and no Production hostname is the data source', () => {
    it('the fixed file contains no fetch() call and no NEXT_PUBLIC_APP_URL reference', () => {
        const src = strip(read(PAGE_PATH));
        expect(src).not.toMatch(/\bfetch\s*\(/);
        expect(src).not.toMatch(/NEXT_PUBLIC_APP_URL/);
        expect(src).not.toMatch(/freezeriqapp\.com|freezeriq\.com/);
    });

    it('generateMetadata calls global.fetch ZERO times for a real, resolvable slug', async () => {
        const fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(() => {
            throw new Error('generateMetadata must never call fetch()');
        });
        useMock(createPrismaMock({
            results: {
                'business.findFirst': REAL_PRODUCTION_TENANT,
                '$queryRaw': [{ tagline: 'Fresh meals, fast.', logo_url: 'https://images.freezeriqapp.com/branding-logo.png' }],
            },
        }));
        await callMetadata('edgar-county');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('generateMetadata calls global.fetch ZERO times for an unknown slug (not-found path)', async () => {
        const fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(() => {
            throw new Error('generateMetadata must never call fetch()');
        });
        useMock(createPrismaMock({ results: { 'business.findFirst': null } }));
        await callMetadata('no-such-tenant');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resolves the tenant through the SAME literal-slug helper the page body uses — no LIKE/ILIKE pattern', () => {
        // FR-PUBLIC-IDENTITY-1: both halves of this file must resolve identically.
        const src = strip(read(PAGE_PATH));
        const importsHelper = /import\s*\{[^}]*findBusinessBySlug[^}]*\}\s*from\s*'@\/lib\/publicIdentity'/.test(src);
        expect(importsHelper).toBe(true);
        const metaFn = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export default async function StorefrontPage'));
        expect(metaFn).toMatch(/findBusinessBySlug/);
        expect(metaFn).not.toMatch(/mode:\s*['"]insensitive['"]/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B/C. Whichever database `prisma` resolves to is what metadata renders — this
// is what makes Preview and Production each see ONLY their own tenant, with no
// environment-tier branching in the file at all.
// ═════════════════════════════════════════════════════════════════════════════
describe('B. Preview: the fake fixture tenant resolves from Preview\'s own (mocked) database', () => {
    it('renders the Preview Test Tenant\'s own branding — never the real tenant\'s', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': (args: any) => args.where.slug === 'preview-test-tenant' ? PREVIEW_FIXTURE_TENANT : null,
                '$queryRaw': [], // no tenant_branding row for the fixture tenant → defaults
            },
        }));
        const meta = await callMetadata('preview-test-tenant');
        expect(meta.title).toBe('Preview Test Tenant | Fresh Meals Delivered');
        expect(meta.description).toBe('Intelligence for your Kitchen.');
        expect(meta.openGraph.images).toEqual([]);
        expect(JSON.stringify(meta)).not.toMatch(/Edgar County|freezeriqapp\.com\/real-logo/);
    });

    it('a slug that exists only in Production resolves to NOT FOUND when the (Preview) database has no such row', async () => {
        useMock(createPrismaMock({ results: { 'business.findFirst': null } }));
        const meta = await callMetadata('edgar-county');
        expect(meta).toEqual({
            title: 'Shop Not Found | FreezerIQ',
            description: 'The requested storefront could not be found.',
        });
    });
});

describe('C. Production: a real tenant\'s own branding resolves correctly (same code path)', () => {
    it('title/description/OpenGraph come from the real tenant\'s own business + branding rows', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': REAL_PRODUCTION_TENANT,
                '$queryRaw': [{ tagline: 'Real farm-to-freezer meals.', logo_url: 'https://images.freezeriqapp.com/real-branding-logo.png' }],
            },
        }));
        const meta = await callMetadata('edgar-county');
        expect(meta.title).toBe('Freezer Chef | Fresh Meals Delivered');
        expect(meta.description).toBe('Real farm-to-freezer meals.');
        expect(meta.openGraph.images).toEqual(['https://images.freezeriqapp.com/real-branding-logo.png']);
    });

    it('the tenant_branding query is scoped to the resolved business_id and ADMIN/CHEF, ordered last-edit-wins', async () => {
        useMock(createPrismaMock({
            results: { 'business.findFirst': REAL_PRODUCTION_TENANT, '$queryRaw': [] },
        }));
        await callMetadata('edgar-county');
        const raw = mock.rawQueries.join('\n');
        expect(raw).toMatch(/tenant_branding/);
        expect(raw).toMatch(/JOIN users u ON b\.user_id = u\.id/);
        expect(raw).toMatch(/u\.role IN \('ADMIN', 'CHEF'\)/);
        expect(raw).toMatch(/ORDER BY b\.updated_at DESC/);
        const call = mock.firstCall('$queryRaw.raw');
        expect(call?.args.values).toEqual([REAL_PRODUCTION_TENANT.id]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Exact behavior preservation — every branch the old self-fetch code had.
// ═════════════════════════════════════════════════════════════════════════════
describe('behavior preservation: identical output to the old self-fetch implementation, for every branch', () => {
    it('no tenant_branding row at all → the same hardcoded tagline default, and Business.logo_url as the image', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { ...REAL_PRODUCTION_TENANT, logo_url: 'https://images.freezeriqapp.com/business-logo.png' },
                '$queryRaw': [],
            },
        }));
        const meta = await callMetadata('edgar-county');
        expect(meta.description).toBe('Intelligence for your Kitchen.');
        expect(meta.openGraph.images).toEqual(['https://images.freezeriqapp.com/business-logo.png']);
    });

    it('a tenant_branding row exists but its tagline column is NULL → falls to the generic "Order delicious..." sentence, not the hardcoded default', async () => {
        useMock(createPrismaMock({
            results: { 'business.findFirst': REAL_PRODUCTION_TENANT, '$queryRaw': [{ tagline: null, logo_url: null }] },
        }));
        const meta = await callMetadata('edgar-county');
        expect(meta.description).toBe('Order delicious, home-cooked freezer meals from Freezer Chef.');
        // The row exists (even with a null logo_url) — it does NOT fall back to Business.logo_url per-field.
        expect(meta.openGraph.images).toEqual([]);
    });

    it('display_name is preferred over name (TENANT-BRAND-AUTHORITY-2), via the same customerFacingBusinessName authority', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { id: 'biz-2', name: 'Nate Holdings LLC', display_name: "Nate's Freezer Guy", logo_url: null },
                '$queryRaw': [],
            },
        }));
        const meta = await callMetadata('nates-freezer-guy');
        expect(meta.title).toBe("Nate's Freezer Guy | Fresh Meals Delivered");
    });

    it('a tenant whose OWN resolved name is literally the platform name still gets the "Freezer Chef" fallback', async () => {
        useMock(createPrismaMock({
            results: { 'business.findFirst': { id: 'biz-3', name: 'FreezerIQ', display_name: null, logo_url: null }, '$queryRaw': [] },
        }));
        const meta = await callMetadata('freezeriq-internal');
        expect(meta.title).toBe('Freezer Chef | Fresh Meals Delivered');
    });

    it('an unresolvable slug still returns the "Shop Not Found" title/description, unchanged', async () => {
        useMock(createPrismaMock({ results: { 'business.findFirst': null } }));
        const meta = await callMetadata('%');
        expect(meta.title).toBe('Shop Not Found | FreezerIQ');
        expect(meta.description).toBe('The requested storefront could not be found.');
    });

    it('an unexpected throw still falls through to the generic "FreezerIQ Storefront" catch-all', async () => {
        useMock(createPrismaMock({
            results: { 'business.findFirst': () => { throw new Error('db unavailable'); } },
        }));
        const meta = await callMetadata('edgar-county');
        expect(meta).toEqual({ title: 'FreezerIQ Storefront', description: 'Order fresh freezer meals online.' });
    });

    it('openGraph always carries title/description/type "website", matching the pre-existing shape exactly', async () => {
        useMock(createPrismaMock({
            results: { 'business.findFirst': REAL_PRODUCTION_TENANT, '$queryRaw': [{ tagline: 'T', logo_url: null }] },
        }));
        const meta = await callMetadata('edgar-county');
        expect(meta.openGraph).toEqual({ title: meta.title, description: meta.description, type: 'website', images: [] });
        expect(Object.keys(meta).sort()).toEqual(['description', 'openGraph', 'title']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. Canonical / OG URL behavior: none existed before, none exists now.
// ═════════════════════════════════════════════════════════════════════════════
describe('D. canonical and public OpenGraph URL behavior is unchanged (none was ever emitted here)', () => {
    it('the fixed file emits no alternates.canonical and no openGraph.url', async () => {
        useMock(createPrismaMock({
            results: { 'business.findFirst': REAL_PRODUCTION_TENANT, '$queryRaw': [{ tagline: 'T', logo_url: 'https://images.freezeriqapp.com/x.png' }] },
        }));
        const meta = await callMetadata('edgar-county');
        expect(meta.alternates).toBeUndefined();
        expect(meta.openGraph.url).toBeUndefined();
    });

    it('source scan: no alternates/canonical field was introduced', () => {
        const src = strip(read(PAGE_PATH));
        const metaFn = src.slice(src.indexOf('export async function generateMetadata'), src.indexOf('export default async function StorefrontPage'));
        expect(metaFn).not.toMatch(/alternates|canonical/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. Storefront body / checkout / the JSON API route are untouched.
// ═════════════════════════════════════════════════════════════════════════════
describe('F. storefront body, checkout, and the public tenant API route are untouched', () => {
    it('this phase changed exactly one file (plus its own tests and the scope ledgers)', () => {
        // Three later, separately-authorized phases — CRM-DEADLINE-TIMEZONE-1,
        // COORDINATOR-SUPPORTER-POLISH-1 (which touches
        // app/coordinator/portal/page.tsx) and RAISE-FUNDS-MARKETING-1 (the
        // /raise-funds page, its sample route, and FundraiserClient's sampleMode)
        // — each touch their own unrelated files, so this can no longer be a LIVE
        // `git status --porcelain` check. That
        // would fail every later phase that ever touches any file this phase
        // also touched, forever, and would need a hand-maintained exemption list
        // growing on every subsequent phase. Pinned instead to the FROZEN
        // historical range this phase actually shipped in (baseline..c5e813a,
        // this phase's own commit) — still exactly as strict about what
        // PREVIEW-METADATA-ISOLATION-1 itself changed, but correctly indifferent
        // to any unrelated work that lands afterward, on any branch.
        const out = execSync('git diff --name-only cfaffaf9d01e069f145d5dfc01f71f5f1be9905d c5e813ab578104c64c2b493b2ca0619dec1d4fd6', { cwd: ROOT, encoding: 'utf8' });
        const changed = out.split('\n').filter(Boolean).map((l) => l.trim());
        const allowed = new Set([PAGE_PATH, 'tests/previewMetadataIsolation1.test.ts', 'tests/coordPolish1.test.ts', 'tests/coordShareCenterPolish2.test.ts', 'tests/tenantBrandAuthority2.test.ts']);
        for (const f of changed) {
            expect({ f, allowed: allowed.has(f) }).toEqual({ f, allowed: true });
        }
    });

    it('StorefrontClient.tsx still fetches the RELATIVE path (browser-resolved, already environment-correct)', () => {
        const src = strip(read('app/shop/[slug]/StorefrontClient.tsx'));
        expect(src).toMatch(/fetch\(\s*`\/api\/public\/tenant\/\$\{slug\}`\s*\)/);
        expect(src).not.toMatch(/NEXT_PUBLIC_APP_URL/);
    });

    it('the JSON API route (app/api/public/tenant/[slug]/route.ts), which the body/checkout depend on, was not touched by this phase', () => {
        // A behavioral proxy for "untouched": its branding defaults and business_name
        // override are still exactly what generateMetadata's fix was modeled on.
        const src = strip(read('app/api/public/tenant/[slug]/route.ts'));
        expect(src).toMatch(/tagline: 'Intelligence for your Kitchen\.'/);
        expect(src).toMatch(/branding\.business_name = customerFacingBusinessName\(business\)/);
    });

    it('the default export StorefrontPage (the page body) still resolves the session tenant via findBusinessBySlug, unchanged', () => {
        const src = strip(read(PAGE_PATH));
        const bodyFn = src.slice(src.indexOf('export default async function StorefrontPage'));
        expect(bodyFn).toMatch(/findBusinessBySlug\(prisma, slug, \{ id: true \}\)/);
        expect(bodyFn).toMatch(/hasCustomerSession/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. No schema / database change.
// ═════════════════════════════════════════════════════════════════════════════
describe('G. no schema or migration change', () => {
    it('no migration directory was created by this phase', () => {
        const out = execSync('git status --porcelain --untracked-files=all', { cwd: ROOT, encoding: 'utf8' });
        expect(out).not.toMatch(/prisma\/migrations\//);
    });

    it('prisma/schema.prisma was not modified by this phase', () => {
        const out = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
        expect(out).not.toMatch(/prisma\/schema\.prisma/);
    });
});
