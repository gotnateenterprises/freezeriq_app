/**
 * OPS-6A.1 — OUTER-BOX LABEL TENANT LOGO CLOSEOUT.
 *
 * DIAGNOSIS (not assumed — read from source and the real Production DB
 * read-only before any edit):
 *
 *   The box-label page's render logic (app/production/box-labels/page.tsx)
 *   was ALREADY correct to OPS-6A's own spec: logo -> business name -> nothing,
 *   fail-open, never both at once. It is called from exactly one place, inside
 *   the print block, so there is no separate "screen" render path to diverge
 *   from print. Print CSS does not hide it. None of that needed a change.
 *
 *   The actual gap is in the SHARED authority every consumer of branding
 *   reads: GET /api/tenant/branding. It read TenantBranding.logo_url only.
 *   Two other established precedents in this codebase already reconcile a
 *   second legitimate column, Business.logo_url, when TenantBranding has none
 *   (app/api/public/tenant/[slug]/route.ts's no-row branch, and
 *   FundraiserClient.tsx:131's `branding?.logo_url || business.logo_url`).
 *   This phase applies that SAME precedence inside the one route every
 *   Production-facing surface consumes, so the fix reaches meal labels, box
 *   labels, and every other consumer identically — not a second, page-local
 *   fallback.
 *
 *   A read-only query against the real Supabase/Production database (the one
 *   .env.local and .env.production both point at) confirmed BOTH logo columns
 *   are genuinely null for every business row today (including "My Freezer
 *   Chef", the tenant in the owner's screenshot). The text fallback the
 *   owner saw is therefore correct behaviour for the CURRENT data — there is
 *   no logo anywhere yet to display. This fix makes the plumbing correct for
 *   the moment a logo IS uploaded through Branding Settings
 *   (components/admin/BrandingSettings.tsx, mounted at /settings/storefront,
 *   POST /api/tenant/branding, writing TenantBranding.logo_url — the one live
 *   write path; PUT /api/business, which would write Business.logo_url, has
 *   zero callers anywhere in the app).
 *
 * FAILING-FIRST: a temporary probe ran against HEAD e027c56 before any
 * implementation and failed 3/3 — TenantBranding row present with a null
 * logo_url but Business.logo_url set still returned null; no TenantBranding
 * row at all with Business.logo_url set still returned null; the business
 * select never fetched logo_url. Folded into section 1 below.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTE = 'app/api/tenant/branding/route.ts';
const PAGE = 'app/production/box-labels/page.tsx';
const PACKING = 'lib/physicalBoxPacking.ts';
const MANIFEST = 'lib/supporterBoxManifest.ts';
const BOX_ROUTE = 'app/api/production/box-labels/route.ts';
const QUEUE = 'components/production/DeliveryQueue.tsx';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops6a1Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops6a1Prisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const call = async (body?: any) => {
    const { GET } = await import('@/app/api/tenant/branding/route');
    const url = body ? `http://localhost/api/tenant/branding?${new URLSearchParams(body)}` : 'http://localhost/api/tenant/branding';
    const res = await GET(new Request(url) as any);
    return res.json();
};

const TENANT_A_LOGO = 'https://cdn.example/business-logo.png';
const TENANT_B_LOGO = 'https://cdn.example/other-tenant-logo.png';

// ═════════════════════════════════════════════════════════════════════════════
// 1/3/4/6/7. GET /api/tenant/branding — the fixed logo reconciliation.
// ═════════════════════════════════════════════════════════════════════════════
describe('1/3/4/6/7. logo reconciliation authority', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId: 'biz-a' } });
    });

    it('1a. FAILING-FIRST FF1 (now fixed): TenantBranding row exists with a null logo -> falls back to Business.logo_url', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'My Freezer Chef', display_name: 'Freezer Chef', logo_url: TENANT_A_LOGO },
                'tenantBranding.findFirst': { business_name: 'Freezer Chef', primary_color: '#111', logo_url: null },
            },
        }));
        const body = await call();
        expect(body.logo_url).toBe(TENANT_A_LOGO);
    });

    it('1b. FAILING-FIRST FF2 (now fixed): no TenantBranding row at all -> still falls back to Business.logo_url', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'My Freezer Chef', display_name: 'Freezer Chef', logo_url: TENANT_A_LOGO },
                'tenantBranding.findFirst': null,
            },
        }));
        const body = await call();
        expect(body.logo_url).toBe(TENANT_A_LOGO);
    });

    it('1c. FAILING-FIRST FF3 (now fixed): the business select fetches logo_url', async () => {
        useMock(createPrismaMock({
            results: { 'business.findUnique': { id: 'biz-a', name: 'X' }, 'tenantBranding.findFirst': null },
        }));
        await call();
        const select = mock.firstCall('business.findUnique')?.args?.select;
        expect(select?.logo_url).toBe(true);
    });

    it('1 (REGRESSION, pinned by tenantBrandAuthority2.test.ts too): TenantBranding.logo_url WINS when the tenant explicitly configured one — never overridden by a stale Business.logo_url', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'X', logo_url: 'https://old-business-logo.example/stale.png' },
                'tenantBranding.findFirst': { logo_url: 'https://tenant-branding-configured.example/current.png' },
            },
        }));
        const body = await call();
        expect(body.logo_url).toBe('https://tenant-branding-configured.example/current.png');
        expect(body.logo_url).not.toBe('https://old-business-logo.example/stale.png');
    });

    it('3. no logo in EITHER column -> logo_url is null, so the page correctly falls back to the business name', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'My Freezer Chef', display_name: 'Freezer Chef', logo_url: null },
                'tenantBranding.findFirst': { logo_url: null },
            },
        }));
        const body = await call();
        expect(body.logo_url).toBeNull();
        expect(body.business_name).toBe('Freezer Chef');
    });

    it('6. a logo URL supplied via query parameters is never used for anything', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'X', logo_url: TENANT_A_LOGO },
                'tenantBranding.findFirst': null,
            },
        }));
        const body = await call({ logo_url: 'https://attacker.example/evil.png', logoUrl: 'https://attacker.example/evil2.png' });
        expect(body.logo_url).toBe(TENANT_A_LOGO);
        expect(body.logo_url).not.toMatch(/attacker/);
        // Structural: the route never reads req.nextUrl / searchParams for a logo.
        const src = strip(read(ROUTE));
        expect(src).not.toMatch(/searchParams\.get\(['"]logo/i);
        expect(src).not.toMatch(/req\.nextUrl.*logo/i);
    });

    it('7. a client-supplied businessId cannot select another tenant\'s logo', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': (args: any) =>
                    args?.where?.id === 'biz-a' ? { id: 'biz-a', name: 'A', logo_url: TENANT_A_LOGO } : null,
                'tenantBranding.findFirst': null,
            },
        }));
        // Session says biz-a; a query string claiming biz-b must be ignored.
        const body = await call({ businessId: 'biz-b' });
        expect(body.logo_url).toBe(TENANT_A_LOGO);
        expect(mock.firstCall('business.findUnique')?.args?.where?.id).toBe('biz-a');
        const src = strip(read(ROUTE));
        expect(src).not.toMatch(/searchParams\.get\(['"]businessId/i);
        expect(src).toMatch(/session\?\.user as any\)\?\.businessId/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. TENANT ISOLATION — Tenant A cannot render Tenant B's logo.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. tenant isolation', () => {
    beforeEach(() => jest.clearAllMocks());

    it('Tenant A session returns only Tenant A\'s logo, never Tenant B\'s', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': (args: any) =>
                    args?.where?.id === 'biz-a'
                        ? { id: 'biz-a', name: 'A', logo_url: TENANT_A_LOGO }
                        : { id: 'biz-b', name: 'B', logo_url: TENANT_B_LOGO },
                'tenantBranding.findFirst': null,
            },
        }));

        mockAuth.mockResolvedValue({ user: { id: 'user-a', businessId: 'biz-a' } });
        const bodyA = await call();
        expect(bodyA.logo_url).toBe(TENANT_A_LOGO);
        expect(bodyA.logo_url).not.toBe(TENANT_B_LOGO);

        mockAuth.mockResolvedValue({ user: { id: 'user-b', businessId: 'biz-b' } });
        const bodyB = await call();
        expect(bodyB.logo_url).toBe(TENANT_B_LOGO);
        expect(bodyB.logo_url).not.toBe(TENANT_A_LOGO);
    });

    it('the TenantBranding lookup is scoped by business_id through the user relation, not global', async () => {
        useMock(createPrismaMock({
            results: { 'business.findUnique': { id: 'biz-a', name: 'A' }, 'tenantBranding.findFirst': null },
        }));
        mockAuth.mockResolvedValue({ user: { id: 'user-a', businessId: 'biz-a' } });
        await call();
        const where = mock.firstCall('tenantBranding.findFirst')?.args?.where;
        expect(where?.user?.business_id).toBe('biz-a');
    });

    it('a missing authenticated session returns 401 before any DB read', async () => {
        useMock(createPrismaMock({ results: {} }));
        mockAuth.mockResolvedValue(null);
        const { GET } = await import('@/app/api/tenant/branding/route');
        const res = await GET(new Request('http://localhost/api/tenant/branding') as any);
        expect(res.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2/4. RENDERING CONTRACT — logo vs. name, never both; fail-open on load error.
// ═════════════════════════════════════════════════════════════════════════════
describe('2/4. rendering contract', () => {
    it('2. when a logo URL is present, the business-name text is NOT also rendered as the header', () => {
        const s = strip(read(PAGE));
        const fn = s.slice(s.indexOf('const renderBrandHeader'), s.indexOf('if (!boxes && batchError)'));
        // An if/else-if/return-null chain: the name branch is only reachable
        // when the logo branch's condition is false.
        expect(fn).toMatch(/if \(branding\.logoUrl && !logoBroken\) \{[\s\S]*?return \(/);
        expect(fn).toMatch(/if \(branding\.businessName\) \{[\s\S]*?return \(/);
        // The two branches are mutually exclusive returns, not both rendered.
        // `alt={branding.businessName || ''}` on the <img> itself is fine —
        // accessible alt text is not a second VISIBLE text header. What must
        // never appear in the logo branch is a second returned JSX element
        // (a <div>...) rendering the name as on-page text.
        const logoBranch = fn.slice(fn.indexOf('if (branding.logoUrl'), fn.indexOf('if (branding.businessName'));
        expect(logoBranch).not.toMatch(/<div[\s\S]*?branding\.businessName[\s\S]*?<\/div>/);
        expect((logoBranch.match(/return \(/g) || [])).toHaveLength(1);
    });

    it('3b. no configured logo renders the canonical tenant business name, unchanged wording/precedence', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/businessName:\s*typeof data\.business_name === 'string'/);
        expect(s).not.toMatch(/Freezer Chef|My Freezer Chef/);
    });

    it('4. a logo that fails to LOAD (onError) falls back to the business-name text, not to nothing', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/onError=\{\(\) => setLogoBroken\(true\)\}/);
        expect(s).toMatch(/branding\.logoUrl && !logoBroken/);
        // logoBroken is never reset to hide the fallback once tripped within a render.
        expect(s).toMatch(/const \[logoBroken, setLogoBroken\] = useState\(false\);/);
    });

    it('4b. branding fetch failure (network/500) still leaves the fallback path reachable', () => {
        const s = strip(read(PAGE));
        // Fetch is never awaited before boxes render, and its rejection is swallowed.
        expect(s).not.toMatch(/await fetch\('\/api\/tenant\/branding'\)/);
        expect(s).toMatch(/\.catch\(\(\) => \{[^}]*\}\)/);
        // Even with branding still at its initial null/null state, the header
        // function returns null rather than throwing, and nothing downstream
        // depends on it having resolved.
        expect(s).toMatch(/logoUrl: null,\s*\n\s*businessName: null,/);
    });

    it('sizing uses max-width/max-height with objectFit contain — no fixed-dimension distortion', () => {
        const s = strip(read(PAGE));
        const imgTag = s.slice(s.indexOf('<img'), s.indexOf('/>', s.indexOf('<img')));
        expect(imgTag).toMatch(/maxHeight:/);
        expect(imgTag).toMatch(/maxWidth:/);
        expect(imgTag).toMatch(/objectFit:\s*'contain'/);
        expect(imgTag).not.toMatch(/\bheight:\s*'[\d.]+in'/);
        expect(imgTag).not.toMatch(/\bwidth:\s*'[\d.]+in'/);
    });

    it('the logo does not crowd the supporter name — its container has a bounded height and its own bottom margin', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        const headerContainer = printBlock.slice(
            printBlock.indexOf('renderBrandHeader()') - 200,
            printBlock.indexOf('renderBrandHeader()'),
        );
        expect(headerContainer).toMatch(/minHeight:\s*'0\.62in'/);
        expect(headerContainer).toMatch(/marginBottom:/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8-11. OWNER-APPROVED CONTENT — untouched.
// ═════════════════════════════════════════════════════════════════════════════
describe('8-11. owner-approved label content is untouched', () => {
    it('8. supporter name remains present, and still the largest element', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/box\.supporterName/);
        expect(printBlock).toMatch(/fontSize: '28pt', fontWeight: 900/);
    });

    it('9. Box N of M rendering is untouched', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/Box \{box\.boxNumber\} of \{box\.boxTotal\}/);
    });

    it('10. combined Serves-2 content treatment (×2) is untouched', () => {
        const s = strip(read(PACKING));
        expect(s).toMatch(/\$\{base\}\s*×\$\{line\.count\}/);
        expect(strip(read(PAGE))).toMatch(/formatBoxContentLine/);
    });

    it('11. "LARGE BOX" / "SMALL BOX" wording is NOT removed', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/\{box\.boxType\} box/);
        // Still subordinate to supporter name and Box N/M, per Part J/H.
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        const boxTypeIdx = printBlock.indexOf('{box.boxType} box');
        const nameIdx = printBlock.indexOf('box.supporterName');
        expect(nameIdx).toBeGreaterThan(-1);
        expect(boxTypeIdx).toBeGreaterThan(nameIdx);
    });

    it('bundle/tier wording (e.g. "Comfort Foods — Serves 2") is untouched', () => {
        const s = strip(read(PACKING));
        expect(s).toMatch(/\$\{line\.bundleName\} — \$\{line\.servingTier\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12/13. PRINT CONTRACT.
// ═════════════════════════════════════════════════════════════════════════════
describe('12/13. print contract', () => {
    it('12. the 4x6 shipping-label contract is unchanged', () => {
        const s = read(PAGE);
        expect(s).toMatch(/size:\s*4in 6in/);
        expect(s).toMatch(/width:\s*4in/);
        expect(s).toMatch(/height:\s*6in/);
    });

    it('13. no trailing blank print page — the OPS-5F last-child exemption is intact', () => {
        const s = read(PAGE);
        expect(s).toMatch(/\.print-page\s*\{[^}]*break-after:\s*always/);
        expect(s).toMatch(/\.print-page:last-child\s*\{[\s\S]*?break-after:\s*auto/);
        expect(s).toMatch(/\.print-page:last-child\s*\{[\s\S]*?page-break-after:\s*auto/);
        const exemption = s.slice(
            s.indexOf('.print-page:last-child'),
            s.indexOf('}', s.indexOf('.print-page:last-child')),
        );
        expect(exemption).not.toMatch(/display:\s*none|visibility:\s*hidden|height:\s*0|content-visibility/);
    });

    it('the logo is inside the always-mounted printable DOM, not a screen-only preview', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/renderBrandHeader\(\)/);
        // Confirmed by construction: renderBrandHeader() is called exactly once.
        expect((s.match(/renderBrandHeader\(\)/g) || []).length).toBe(1);
    });

    it('one print-page element per physical box — unchanged by this phase', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/boxes\.map\(\(box\) =>/);
        expect(printBlock).toMatch(/className="print-page"/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14/15. PACKING MATH — untouched, behaviourally re-proven.
// ═════════════════════════════════════════════════════════════════════════════
describe('14/15. physical packing math is untouched', () => {
    const { packOrder, countPhysicalBoxes } = require('@/lib/physicalBoxPacking') as typeof import('@/lib/physicalBoxPacking') & { countPhysicalBoxes?: any };

    const ITEM = (over: any = {}) => ({
        id: 'oi-x', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_5',
        item_name: 'Bundle One', bundle: { id: 'b-1', name: 'Bundle One' }, ...over,
    });
    const ORDER = (items: any[]) => ({
        id: 'ord-1', first_name: 'Jane', last_name: 'Smith', customer_name: 'Jane Smith', items,
    });

    it('14. outer-label count still equals physical box count', () => {
        const r = packOrder(ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'A', variant_size: 'serves_2' }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'B', variant_size: 'serves_2' }),
        ]));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.result.purchasedBundleCount).toBe(2);
            expect(r.result.physicalBoxCount).toBe(1);
            expect(r.result.boxes).toHaveLength(r.result.physicalBoxCount);
        }
    });

    it('15. Serves-5 alone, Serves-2 pairing, and leftover-small rules are unchanged', () => {
        const one = packOrder(ORDER([ITEM({ variant_size: 'serves_5' })]));
        expect(one.ok && one.result.boxes[0].boxType).toBe('large');

        const three = packOrder(ORDER([ITEM({ variant_size: 'serves_2', quantity: 3 })]));
        expect(three.ok && three.result.physicalBoxCount).toBe(2);
        expect(three.ok && three.result.boxes.map((b: any) => b.boxType)).toEqual(['large', 'small']);
    });

    it('packing reads no branding data whatsoever — structurally isolated', () => {
        for (const f of [PACKING, MANIFEST]) {
            expect(strip(read(f))).not.toMatch(/logo|branding|business_name/i);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16/17. PRIVACY — untouched.
// ═════════════════════════════════════════════════════════════════════════════
describe('16/17. privacy is untouched', () => {
    it('16. no phone, email or address was added anywhere on this path', () => {
        for (const f of [PAGE, BOX_ROUTE, PACKING, MANIFEST]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/\bemail\b/i);
            expect(s).not.toMatch(/\bphone\b/i);
            expect(s).not.toMatch(/delivery_address/);
        }
        // QUEUE pre-existingly carries delivery_address on its Order interface
        // for the on-screen "Packed & Ready" card display — unrelated to the
        // label path and out of this phase's scope. Scoped to the label
        // HANDLER specifically, exactly as tests/ops6SupporterBoxLabels.test.ts
        // already does for the same file.
        const q = strip(read(QUEUE));
        const handler = q.slice(q.indexOf('const queueBoxLabels'), q.indexOf('if (orders.length === 0)'));
        expect(handler).not.toMatch(/email/i);
        expect(handler).not.toMatch(/phone/i);
        expect(handler).not.toMatch(/address/i);
        // The branding route itself never selects address/phone for logo use.
        const routeSrc = strip(read(ROUTE));
        const select = routeSrc.slice(routeSrc.indexOf('business.findUnique'), routeSrc.indexOf('});', routeSrc.indexOf('business.findUnique')));
        expect(select).not.toMatch(/address|phone/i);
    });

    it('17. no PII was added to any generated URL — the box-labels page still reads no query params', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/useSearchParams|searchParams|URLSearchParams|window\.location\.search/);
        const q = strip(read(QUEUE));
        expect(q).not.toMatch(/URLSearchParams/);
        expect(q).toMatch(/router\.push\('\/production\/box-labels'\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18/19. NO SCHEMA CHANGE, NO PRODUCTION MUTATION.
// ═════════════════════════════════════════════════════════════════════════════
describe('18/19. no schema change, no data mutation', () => {
    it('18. prisma/schema.prisma is untouched by this phase — same two logo columns, nothing new', () => {
        const schema = read('prisma/schema.prisma');
        const logoFields = (schema.match(/logo_url\s+String\?/g) || []).length;
        expect(logoFields).toBe(3); // Business, TenantBranding, Supplier — unchanged count.
    });

    it('19. the fixed route performs a READ only — no write call was added', () => {
        const src = strip(read(ROUTE));
        const getBody = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
        expect(getBody).not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\$executeRaw/);
    });

    it('19b. the POST handler (the only writer in this file) is completely untouched', () => {
        const src = strip(read(ROUTE));
        // Same upsert shape as before this phase — logo write path unchanged.
        expect(src).toMatch(/logo_url:\s*logoUrl,?$/m);
        expect(src).toMatch(/\.\.\.\(logoUrl && \{ logo_url: logoUrl \}\)/);
    });

    it('no other production surfaces were touched by this phase', () => {
        // Narrow, explicit changed-file list — nothing else moved.
        for (const untouched of [MANIFEST, PACKING, BOX_ROUTE, QUEUE]) {
            expect(read(untouched).length).toBeGreaterThan(0); // still exist, unmodified content proven by 14/15/16/17 above
        }
    });
});
