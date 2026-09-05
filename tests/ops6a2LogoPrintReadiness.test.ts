/**
 * OPS-6A.2 — OUTER-BOX LABEL LOGO, POST-UPLOAD CLOSEOUT.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PROVEN ROOT CAUSE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * OPS-6A.1 fixed the API so a configured logo is RETURNED. The owner then
 * uploaded a logo and the label still showed no logo — and, decisively, the
 * tenant-NAME text that had been there before the upload DISAPPEARED.
 *
 * That disappearance is the whole diagnosis. The old header was:
 *
 *     if (logoUrl && !logoBroken) return <img onError={...} />   // returns early
 *     if (businessName)           return <div>{businessName}</div>
 *
 * so the name branch became unreachable the instant a URL existed. Which
 * proves, without needing a network trace, that:
 *   - GET /api/tenant/branding fired,
 *   - its response carried logo_url,
 *   - that value reached component state,
 *   - and an <img> was mounted with it.
 *
 * The image then failed to become PRINTABLE. `onError` fires only on a failed
 * load; an image that is merely STILL LOADING never trips it, so `logoBroken`
 * stayed false and the header rendered an <img> with no painted pixels.
 * `img.complete` is false immediately after a fresh src is set on any uncached
 * image, and this label's print block sits inside a display:none container
 * until @media print activates — so the first time that image is asked to
 * paint is the print capture itself.
 *
 * Everything upstream was verified clean before touching code:
 *   - the upload PERSISTED (TenantBranding.logo_url set, updated_at current);
 *   - the stored object is REACHABLE (HTTP 200, image/png, public, no auth);
 *   - GET /api/tenant/branding RETURNS it (proven by running the real handler
 *     against the real persisted values);
 *   - Preview and Production share ONE database (a single Vercel DATABASE_URL
 *     scoped to Production, Preview and Development), so no split-environment
 *     write/read mismatch exists;
 *   - no global or local print CSS hides <img>.
 *
 * THE FIX: the logo is preloaded off-DOM and rendered only once its bytes are
 * proven loaded. Until then the tenant name is on the label, so the header is
 * never blank. Print additionally waits, BOUNDED, for an in-flight logo.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { chooseBrandHeader, isLogoSettling, type TenantLogoStatus } from '@/lib/tenantLogo';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = 'app/production/box-labels/page.tsx';
const HELPER = 'lib/tenantLogo.ts';
const ROUTE = 'app/api/tenant/branding/route.ts';
const PACKING = 'lib/physicalBoxPacking.ts';
const MANIFEST = 'lib/supporterBoxManifest.ts';
const QUEUE = 'components/production/DeliveryQueue.tsx';

const LOGO = 'https://images.freezeriqapp.com/logo.png';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops6a2Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops6a2Prisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const callBranding = async (qs?: Record<string, string>) => {
    const { GET } = await import('@/app/api/tenant/branding/route');
    const url = qs
        ? `http://localhost/api/tenant/branding?${new URLSearchParams(qs)}`
        : 'http://localhost/api/tenant/branding';
    const res = await GET(new Request(url) as any);
    return res.json();
};

// ═════════════════════════════════════════════════════════════════════════════
// 0. FAILING-FIRST — the exact state transition the owner observed.
// ═════════════════════════════════════════════════════════════════════════════
describe('0. failing-first: the blank-header transition', () => {
    it('0a. the decision helper exists and is pure', () => {
        expect(existsSync(join(ROOT, HELPER))).toBe(true);
        const s = strip(read(HELPER));
        expect(s).not.toMatch(/from ['"]react['"]|prisma|fetch\(|document\.|window\./);
    });

    it('0b. REPRODUCES THE OWNER TRANSITION: before upload -> name; after upload -> name (never blank)', () => {
        // Before the upload: no logo configured at all.
        expect(chooseBrandHeader(null, 'Freezer Chef', 'idle')).toBe('name');
        // After the upload, while the image is still in flight. THIS is the
        // case that used to render a blank <img> and is the entire defect.
        expect(chooseBrandHeader(LOGO, 'Freezer Chef', 'pending')).toBe('name');
        // And once it has actually loaded, the logo takes over.
        expect(chooseBrandHeader(LOGO, 'Freezer Chef', 'ok')).toBe('logo');
    });

    it('0c. the defective URL-presence predicate is gone from the page', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/branding\.logoUrl && !logoBroken/);
        expect(s).not.toMatch(/logoBroken/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1-3. UPLOAD / PERSISTENCE.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-3. upload and persistence', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId: 'biz-a' } });
    });

    const postForm = (fields: Record<string, string>) => {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const req = new Request('http://localhost/api/tenant/branding', { method: 'POST' }) as any;
        req.formData = async () => fd;
        return req;
    };

    it('1. the Branding upload writes the canonical TenantBranding.logo_url column', () => {
        // The upload path is unchanged by this phase and still targets the one
        // canonical column; pinned so a future edit cannot silently move it.
        const src = strip(read(ROUTE));
        expect(src).toMatch(/logo_url:\s*logoUrl,?$/m);
        expect(src).toMatch(/\.\.\.\(logoUrl && \{ logo_url: logoUrl \}\)/);
        expect(src).toMatch(/uploadToS3\(/);
    });

    it('2. a stored logo survives a read and comes back on the branding response', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'My Freezer Chef', display_name: 'Freezer Chef', logo_url: null },
                'tenantBranding.findFirst': { logo_url: LOGO, business_name: 'Freezer Chef' },
            },
        }));
        const body = await callBranding();
        expect(body.logo_url).toBe(LOGO);
    });

    it('3. the branding save is tenant-scoped — no cross-tenant write', async () => {
        useMock(createPrismaMock({
            results: {
                'tenantBranding.findFirst': null,
                'tenantBranding.upsert': { user_id: 'user-1' },
            },
        }));
        const { POST } = await import('@/app/api/tenant/branding/route');
        await POST(postForm({
            business_name: 'X', contact_email: '', tagline: '', thank_you_note: '',
            review_prompt: '', sign_off: '', primary_color: '#000', secondary_color: '#000', accent_color: '#000',
        }));
        const update = mock.firstCall('business.update');
        if (update) expect(update.args?.where?.id).toBe('biz-a');
        const find = mock.firstCall('tenantBranding.findFirst');
        expect(find?.args?.where?.user?.business_id).toBe('biz-a');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4-8. BRANDING API.
// ═════════════════════════════════════════════════════════════════════════════
describe('4-8. branding API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId: 'biz-a' } });
    });

    it('4. a configured TenantBranding.logo_url is returned', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'X', logo_url: null },
                'tenantBranding.findFirst': { logo_url: LOGO },
            },
        }));
        expect((await callBranding()).logo_url).toBe(LOGO);
    });

    it('5. TenantBranding logo WINS over a Business logo', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'X', logo_url: 'https://stale/business.png' },
                'tenantBranding.findFirst': { logo_url: LOGO },
            },
        }));
        const body = await callBranding();
        expect(body.logo_url).toBe(LOGO);
        expect(body.logo_url).not.toMatch(/stale/);
    });

    it('6. Business.logo_url is used when TenantBranding has none', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'X', logo_url: 'https://cdn/business.png' },
                'tenantBranding.findFirst': { logo_url: null },
            },
        }));
        expect((await callBranding()).logo_url).toBe('https://cdn/business.png');
    });

    it('7. neither logo -> null, so the page falls back to the canonical tenant name', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'My Freezer Chef', display_name: 'Freezer Chef', logo_url: null },
                'tenantBranding.findFirst': { logo_url: null },
            },
        }));
        const body = await callBranding();
        expect(body.logo_url).toBeNull();
        expect(body.business_name).toBe('Freezer Chef');
        expect(chooseBrandHeader(body.logo_url, body.business_name, 'idle')).toBe('name');
    });

    it('8. a newly saved logo is reflected on the next GET — the route is not cached', async () => {
        // force-dynamic is what makes a POST-then-GET reflect immediately.
        expect(strip(read(ROUTE))).toMatch(/export const dynamic = 'force-dynamic';/);
        // And the page does not opt into a cached fetch.
        const page = strip(read(PAGE));
        expect(page).not.toMatch(/cache:\s*['"]force-cache['"]/);
        expect(page).not.toMatch(/next:\s*\{\s*revalidate/);

        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'X', logo_url: null },
                'tenantBranding.findFirst': { logo_url: LOGO },
            },
        }));
        expect((await callBranding()).logo_url).toBe(LOGO);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9-12. IMAGE READINESS — the core of this phase.
// ═════════════════════════════════════════════════════════════════════════════
describe('9-12. image readiness', () => {
    it('9. a valid, LOADED logo renders as the logo', () => {
        expect(chooseBrandHeader(LOGO, 'Freezer Chef', 'ok')).toBe('logo');
    });

    it('10. a BROKEN logo shows the visible tenant-name fallback', () => {
        expect(chooseBrandHeader(LOGO, 'Freezer Chef', 'failed')).toBe('name');
    });

    it('11. a logo that 404s or is still loading never leaves a BLANK header', () => {
        for (const status of ['idle', 'pending', 'failed'] as TenantLogoStatus[]) {
            expect(chooseBrandHeader(LOGO, 'Freezer Chef', status)).toBe('name');
        }
        // 'none' is reachable only when the tenant genuinely has no name either.
        expect(chooseBrandHeader(LOGO, null, 'pending')).toBe('none');
        expect(chooseBrandHeader(LOGO, '   ', 'failed')).toBe('none');
    });

    it('11b. the image is PRELOADED off-DOM and rendered only once proven loaded', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/new window\.Image\(\)/);
        expect(s).toMatch(/probe\.onload = \(\) => \{[\s\S]*?setLogoStatus\('ok'\)/);
        expect(s).toMatch(/probe\.onerror = \(\) => \{[\s\S]*?setLogoStatus\('failed'\)/);
        expect(s).toMatch(/probe\.src = url;/);
        // And the render gate consults the helper, not a raw URL check.
        expect(s).toMatch(/chooseBrandHeader\(branding\.logoUrl, branding\.businessName, logoStatus\)/);
    });

    it('12. the logo never depends on query-string data', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/useSearchParams|URLSearchParams|window\.location\.search/);
        expect(strip(read(ROUTE))).not.toMatch(/searchParams\.get\(['"]logo/i);
    });

    it('12b. isLogoSettling only reports pending for a tenant that HAS a logo', () => {
        expect(isLogoSettling(LOGO, 'pending')).toBe(true);
        expect(isLogoSettling(LOGO, 'ok')).toBe(false);
        expect(isLogoSettling(LOGO, 'failed')).toBe(false);
        // A tenant with no logo must never make anyone wait.
        expect(isLogoSettling(null, 'pending')).toBe(false);
        expect(isLogoSettling('', 'pending')).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13-15. TENANT SECURITY.
// ═════════════════════════════════════════════════════════════════════════════
describe('13-15. tenant security', () => {
    beforeEach(() => jest.clearAllMocks());

    it('13. Tenant A can never receive Tenant B\'s logo', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': (args: any) =>
                    args?.where?.id === 'biz-a'
                        ? { id: 'biz-a', name: 'A', logo_url: 'https://cdn/a.png' }
                        : { id: 'biz-b', name: 'B', logo_url: 'https://cdn/b.png' },
                'tenantBranding.findFirst': null,
            },
        }));
        mockAuth.mockResolvedValue({ user: { id: 'ua', businessId: 'biz-a' } });
        const a = await callBranding();
        expect(a.logo_url).toBe('https://cdn/a.png');

        mockAuth.mockResolvedValue({ user: { id: 'ub', businessId: 'biz-b' } });
        const b = await callBranding();
        expect(b.logo_url).toBe('https://cdn/b.png');
        expect(b.logo_url).not.toBe(a.logo_url);
    });

    it('14. a client-supplied businessId cannot select the logo', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': (args: any) =>
                    args?.where?.id === 'biz-a' ? { id: 'biz-a', name: 'A', logo_url: 'https://cdn/a.png' } : null,
                'tenantBranding.findFirst': null,
            },
        }));
        mockAuth.mockResolvedValue({ user: { id: 'ua', businessId: 'biz-a' } });
        const body = await callBranding({ businessId: 'biz-b' });
        expect(body.logo_url).toBe('https://cdn/a.png');
        expect(mock.firstCall('business.findUnique')?.args?.where?.id).toBe('biz-a');
    });

    it('15. a query-string logo_url cannot override the stored logo', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: 'biz-a', name: 'A', logo_url: null },
                'tenantBranding.findFirst': { logo_url: LOGO },
            },
        }));
        mockAuth.mockResolvedValue({ user: { id: 'ua', businessId: 'biz-a' } });
        const body = await callBranding({ logo_url: 'https://attacker/evil.png' });
        expect(body.logo_url).toBe(LOGO);
        expect(body.logo_url).not.toMatch(/attacker/);
    });

    it('15b. a missing session fails closed before any DB read', async () => {
        useMock(createPrismaMock({ results: {} }));
        mockAuth.mockResolvedValue(null);
        const { GET } = await import('@/app/api/tenant/branding/route');
        const res = await GET(new Request('http://localhost/api/tenant/branding') as any);
        expect(res.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16-20. PRINT.
// ═════════════════════════════════════════════════════════════════════════════
describe('16-20. print', () => {
    it('16. the branding header is inside the always-mounted printable DOM', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/renderBrandHeader\(\)/);
        expect((s.match(/renderBrandHeader\(\)/g) || []).length).toBe(1);
    });

    it('17. printing waits, BOUNDED, for an in-flight logo so a valid logo is not lost to a fast click', () => {
        const s = strip(read(PAGE));
        const handler = s.slice(s.indexOf('const handlePrintAll'), s.indexOf('const supporterCount'));
        expect(handler).toMatch(/isLogoSettling\(branding\.logoUrl, logoStatus\)/);
        expect(handler).toMatch(/await Promise\.race\(/);
        expect(handler).toMatch(/LOGO_SETTLE_TIMEOUT_MS/);
        expect(handler).toMatch(/window\.print\(\)/);
        // The wait is bounded by a real, finite constant.
        expect(s).toMatch(/const LOGO_SETTLE_TIMEOUT_MS = \d+;/);
        const ms = Number((s.match(/const LOGO_SETTLE_TIMEOUT_MS = (\d+);/) || [])[1]);
        expect(ms).toBeGreaterThan(0);
        expect(ms).toBeLessThanOrEqual(5000);
    });

    it('17b. branding still FAILS OPEN — nothing about the logo can stop a print', () => {
        const s = strip(read(PAGE));
        const handler = s.slice(s.indexOf('const handlePrintAll'), s.indexOf('const supporterCount'));
        // Print is gated on `blocked` (packing truth) only — never on branding.
        expect(handler).toMatch(/if \(blocked\.length > 0\)/);
        // The ONLY early return in the handler is the packing gate. A branding
        // condition must never be able to abort a print, so no `return` may
        // appear after the settle-wait begins.
        expect((handler.match(/\breturn;/g) || [])).toHaveLength(1);
        const afterSettle = handler.slice(handler.indexOf('isLogoSettling'));
        expect(afterSettle).not.toMatch(/\breturn;/);
        expect(handler).not.toMatch(/if \(!branding/);
        expect(s).toMatch(/disabled=\{[^}]*blocked\.length > 0/);
        expect(s).not.toMatch(/disabled=\{[^}]*logoStatus/);
        expect(s).not.toMatch(/disabled=\{[^}]*branding/);
    });

    it('18. a broken logo still leaves a PRINTABLE name fallback', () => {
        expect(chooseBrandHeader(LOGO, 'Freezer Chef', 'failed')).toBe('name');
        const s = strip(read(PAGE));
        const fn = s.slice(s.indexOf('const renderBrandHeader'), s.indexOf('if (!boxes && batchError)'));
        expect(fn).toMatch(/if \(choice === 'name'\)/);
        expect(fn).toMatch(/branding\.businessName/);
    });

    it('19. the 4x6 print contract is unchanged', () => {
        const s = read(PAGE);
        expect(s).toMatch(/size:\s*4in 6in/);
        expect(s).toMatch(/width:\s*4in/);
        expect(s).toMatch(/height:\s*6in/);
    });

    it('20. no trailing blank page — the OPS-5F last-child exemption is intact', () => {
        const s = read(PAGE);
        expect(s).toMatch(/\.print-page\s*\{[^}]*break-after:\s*always/);
        expect(s).toMatch(/\.print-page:last-child\s*\{[\s\S]*?break-after:\s*auto/);
        const exemption = s.slice(
            s.indexOf('.print-page:last-child'),
            s.indexOf('}', s.indexOf('.print-page:last-child')),
        );
        expect(exemption).not.toMatch(/display:\s*none|visibility:\s*hidden|height:\s*0/);
    });

    it('20b. no print rule hides images, locally or globally', () => {
        const local = read(PAGE);
        const printCss = local.slice(local.indexOf('@media print'), local.indexOf('`,\n                }} />'));
        expect(printCss).not.toMatch(/img\s*\{[^}]*display:\s*none/);
        const globals = read('app/globals.css');
        const globalPrint = globals.slice(globals.indexOf('@media print'));
        expect(globalPrint).not.toMatch(/(^|[^.\w])img[^{]*\{[^}]*display:\s*none/m);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 21-30. REGRESSIONS — owner-approved content and packing truth untouched.
// ═════════════════════════════════════════════════════════════════════════════
describe('21-30. regressions', () => {
    it('21. supporter name unchanged, and still the largest element', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/box\.supporterName/);
        expect(printBlock).toMatch(/fontSize: '28pt', fontWeight: 900/);
    });

    it('22. Box N of M unchanged', () => {
        expect(strip(read(PAGE))).toMatch(/Box \{box\.boxNumber\} of \{box\.boxTotal\}/);
    });

    it('23. bundle/tier wording unchanged', () => {
        const s = strip(read(PACKING));
        expect(s).toMatch(/\$\{line\.bundleName\} — \$\{line\.servingTier\}/);
        expect(s).toMatch(/\$\{base\}\s*×\$\{line\.count\}/);
    });

    it('24. LARGE / SMALL BOX text unchanged', () => {
        expect(strip(read(PAGE))).toMatch(/\{box\.boxType\} box/);
    });

    it('25/26. Serves-2 pairing and label-count-equals-box-count unchanged', () => {
        const { packOrder } = require('@/lib/physicalBoxPacking');
        const ITEM = (over: any = {}) => ({
            id: 'oi-x', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2',
            item_name: 'A', bundle: { id: 'b-1', name: 'A' }, ...over,
        });
        const order = {
            id: 'ord-1', first_name: 'Jane', last_name: 'Smith', customer_name: 'Jane Smith',
            items: [ITEM({ id: 'oi-1' }), ITEM({ id: 'oi-2', bundle_id: 'b-2', item_name: 'B' })],
        };
        const r = packOrder(order);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.result.purchasedBundleCount).toBe(2);
            expect(r.result.physicalBoxCount).toBe(1);
            expect(r.result.boxes).toHaveLength(r.result.physicalBoxCount);
            expect(r.result.boxes[0].boxType).toBe('large');
        }
        // Three Serves-2 still pair into one large plus one small leftover.
        const three = packOrder({ ...order, items: [ITEM({ id: 'oi-1', quantity: 3 })] });
        expect(three.ok && three.result.physicalBoxCount).toBe(2);
    });

    it('26b. packing knows nothing about branding — structurally isolated', () => {
        for (const f of [PACKING, MANIFEST]) {
            expect(strip(read(f))).not.toMatch(/logo|branding|business_name/i);
        }
        expect(strip(read(HELPER))).not.toMatch(/box|packing|supporter|bundle/i);
    });

    it('27. no address, email or phone added on this path', () => {
        for (const f of [PAGE, HELPER, PACKING, MANIFEST]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/\bemail\b/i);
            expect(s).not.toMatch(/\bphone\b/i);
            expect(s).not.toMatch(/delivery_address/);
        }
    });

    it('28. no PII in query params — the page reads none at all', () => {
        expect(strip(read(PAGE))).not.toMatch(/useSearchParams|URLSearchParams|window\.location\.search/);
        const q = strip(read(QUEUE));
        expect(q).not.toMatch(/URLSearchParams/);
        expect(q).toMatch(/router\.push\('\/production\/box-labels'\)/);
    });

    it('29. no schema change — still exactly three logo_url columns', () => {
        const schema = read('prisma/schema.prisma');
        expect((schema.match(/logo_url\s+String\?/g) || []).length).toBe(3);
    });

    it('30. no Production data mutation — the GET path and the new helper write nothing', () => {
        const src = strip(read(ROUTE));
        const getBody = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
        expect(getBody).not.toMatch(/\.create\(|\.update\(|\.delete\(|\.upsert\(|\$executeRaw/);
        expect(strip(read(HELPER))).not.toMatch(/prisma|\.update\(|\.create\(/);
    });
});
