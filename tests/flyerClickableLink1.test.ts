/**
 * FLYER-CLICKABLE-LINK-1 — the printable fundraiser flyer's electronic link opens the FULL canonical
 * supporter ordering URL, the same one the QR code encodes.
 *
 * Root cause: the URL was printed as wrapped text (splitTextToSize + text) with no link annotation, so
 * a PDF viewer that guesses links from text linked only the first line — a truncated campaign id, a 404.
 *
 * The real flyer routes and the real jsPDF run; Prisma, the sessions and the order-mode resolver are
 * stubbed, and generateQrCode is wrapped (the real one still runs) to record what the QR encodes. The
 * PDF bytes are read directly: every /Link annotation, its /URI target and which page it sits on.
 * Fictional names only; the repository is public.
 */
process.env.TZ = 'America/Chicago';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__flDb; } }));
jest.mock('@/auth', () => ({ auth: async () => (global as any).__flAuth ?? null }));
jest.mock('@/lib/coordinatorSession', () => ({
    resolveCoordinatorSession: async () => ({ session: {}, campaignId: (global as any).__flCampaignId }),
    requireCoordinatorSession: async () => ({ ok: true, campaignId: (global as any).__flCampaignId, sessionId: 's-1' }),
}));
jest.mock('@/lib/campaignOrderBundles', () => ({
    resolveCampaignOrderMode: async () => ({ allowed: true, mode: 'selected', activeOrderableBundleIds: ['b-ck', 'b-ck2'] }),
}));
jest.mock('@/lib/generateQrCode', () => {
    const actual = jest.requireActual('@/lib/generateQrCode');
    return { ...actual, generateQrCode: jest.fn(async (url: string, ...rest: any[]) => { (global as any).__flQr.push(url); return actual.generateQrCode(url, ...rest); }) };
});

import { generateFlyer, ORDER_ONLINE_LABEL } from '@/lib/generateFlyer';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';

jest.setTimeout(60000);

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CAMPAIGN_ID = '7e57f000-0000-4000-8000-000000000010';
const BUNDLE_ROWS = [
    { id: 'b-ck', name: 'Winter Comfort Classics', price: '125.00', serving_tier: 'family', family_id: 'fam-ck' },
    { id: 'b-ck2', name: 'Winter Comfort Classics (Serves 2)', price: '60.00', serving_tier: 'serves_2', family_id: 'fam-ck' },
];

function makeDb(opts: { customDomain: string | null; slug?: string; tax?: Record<string, unknown> }) {
    const campaign = {
        id: CAMPAIGN_ID, name: 'Riverbend Robotics Fundraiser', status: 'Active', closed_at: null,
        bundle_selection_status: 'selected', bundle_selection_limit: 1,
        end_date: new Date('2026-12-05T00:00:00.000Z'), delivery_date: new Date('2026-12-12T00:00:00.000Z'),
        pickup_location: 'School gym', checks_payable: 'Riverbend Robotics', public_token: 'pub-fl',
        customer_id: 'org-fl', customer: { name: 'Riverbend Robotics Club', contact_name: 'Pat Example', business_id: 'biz-fl' },
        tax_status: 'TAX_EXEMPT', tax_rate_percent: null,
        ...(opts.tax ?? {}),
    };
    const customerWhere: any[] = [];
    return {
        customerWhere,
        fundraiserCampaign: { findFirst: async () => campaign },
        customer: { findFirst: async (args: any) => { customerWhere.push(args.where); return args.where?.business_id === 'biz-fl' ? { id: 'org-fl', name: 'Riverbend Robotics Club', business_id: 'biz-fl' } : null; } },
        tenantBranding: { findFirst: async () => null },
        business: { findUnique: async () => ({ name: 'Example Kitchen', display_name: 'Example Kitchen', slug: opts.slug ?? 'example-kitchen', custom_domain: opts.customDomain }) },
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join('?');
            if (/bundle_contents/.test(sql)) return BUNDLE_ROWS.map((b) => ({ bundle_id: b.id, recipe_name: `${b.name} Chili` }));
            return BUNDLE_ROWS;
        },
    };
}

// ── reading the PDF ─────────────────────────────────────────────────────────────────────────────
const unescapePdf = (s: string) => s.replace(/\\([()\\])/g, '$1');
interface Link { page: number; uri: string; rect: number[] }
/** Every link annotation, with the 1-based page it belongs to (jsPDF writes /Annots inline in each page object). */
function pdfLinks(buf: Buffer): Link[] {
    const s = buf.toString('latin1');
    const pages = s.split(/<<\/Type \/Page\n/).slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('endobj')));
    return pages.flatMap((p, i) => [...p.matchAll(/\/Subtype \/Link \/Rect \[([^\]]+)\][^]*?\/URI \(((?:[^()\\]|\\[\s\S])*)\)/g)]
        .map((m) => ({ page: i + 1, rect: m[1].trim().split(/\s+/).map(Number), uri: unescapePdf(m[2]) })));
}
/** Every string drawn with Tj, in order. */
function pdfTexts(buf: Buffer): string[] {
    return [...buf.toString('latin1').matchAll(/\(((?:[^()\\]|\\[\s\S])*)\)\s*Tj/g)].map((m) => unescapePdf(m[1]));
}
const area = (r: number[]) => Math.abs(r[2] - r[0]) * Math.abs(r[3] - r[1]);

const FLYER_BASE = {
    campaignName: 'Riverbend Robotics Winter Fundraiser', organizationName: 'Riverbend Robotics Club', businessName: 'Example Kitchen',
    endDate: '2026-12-05', deliveryDate: '2026-12-12', pickupLocation: 'School gym', checksPayable: 'Riverbend Robotics', taxRatePercent: 0,
    bundles: [
        { name: 'Winter Comfort Classics', price: 125, servingTier: 'serves_5' as const, meals: ['Chili', 'Pasta'] },
        { name: 'Winter Comfort Classics (Serves 2)', price: 60, servingTier: 'serves_2' as const, meals: ['Chili'] },
    ],
};

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
beforeEach(() => { (global as any).__flQr = []; (global as any).__flCampaignId = CAMPAIGN_ID; (global as any).__flAuth = null; });

async function coordinatorFlyer(db: ReturnType<typeof makeDb>) {
    (global as any).__flDb = db;
    const { GET } = await import('@/app/api/flyer/download/route');
    const req = new Request('https://www.freezeriqapp.com/api/flyer/download');
    const res = await GET(req);
    expect(res.status).toBe(200);
    return { buf: Buffer.from(await res.arrayBuffer()), req };
}
async function crmFlyer(db: ReturnType<typeof makeDb>, businessId: string | null = 'biz-fl') {
    (global as any).__flDb = db;
    (global as any).__flAuth = businessId ? { user: { businessId } } : null;
    const { POST } = await import('@/app/api/flyer/generate/route');
    return POST(new Request('https://www.freezeriqapp.com/api/flyer/generate', { method: 'POST', body: JSON.stringify({ customerId: 'org-fl' }) }));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('1–4 · the generator: every link targets the exact QR URL, never a wrapped fragment', () => {
    const LONG = `https://www.freezeriqapp.com/shop/riverbend-robotics-booster-club-kitchen/fundraiser/${CAMPAIGN_ID}`;

    it('1 · 2 · the QR and every PDF link get the same full URL; page 1 has the explicit "Order online here" button', async () => {
        const buf = await generateFlyer({ ...FLYER_BASE, publicUrl: LONG });
        expect((global as any).__flQr).toEqual([LONG, LONG]); // page 1 and page 2 QR codes
        const links = pdfLinks(buf);
        expect(links.length).toBeGreaterThanOrEqual(6);
        expect(new Set(links.map((l) => l.uri))).toEqual(new Set([LONG]));
        expect(links.filter((l) => l.page === 1).length).toBeGreaterThanOrEqual(3); // button + address line(s) + QR
        expect(links.filter((l) => l.page === 2).length).toBeGreaterThanOrEqual(3); // label + QR + address line(s)
        expect(links.every((l) => area(l.rect) > 0)).toBe(true);
        expect(ORDER_ONLINE_LABEL).toBe('Order online here');
        expect(pdfTexts(buf)).toContain('Order online here');
    });

    it('3 · 4 · the printed address wraps (the old failure), yet no link ever points at a fragment; the campaign UUID is whole', async () => {
        const buf = await generateFlyer({ ...FLYER_BASE, publicUrl: LONG });
        const texts = pdfTexts(buf);
        // The printed address really is split across lines on page 1 — the condition that broke auto-linking.
        const firstLine = texts.find((t) => t.startsWith('https://') && LONG.startsWith(t) && t !== LONG);
        expect(firstLine).toBeDefined();
        expect(LONG.length).toBeGreaterThan(firstLine!.length);
        for (const l of pdfLinks(buf)) {
            expect(l.uri).toBe(LONG);
            expect(l.uri.endsWith(`/fundraiser/${CAMPAIGN_ID}`)).toBe(true);
        }
        // Every printed fragment of the address is covered by a link of its own (one per line, per page).
        const fragments = texts.filter((t) => t !== LONG && LONG.includes(t) && t.length >= 8);
        expect(pdfLinks(buf).length).toBeGreaterThanOrEqual(fragments.length + 3); // + button, 2 QRs, page-2 label − overlap
    });

    it('a short URL still gets the button, its line and the QR as explicit links', async () => {
        const SHORT = 'https://a.test/f/x';
        const links = pdfLinks(await generateFlyer({ ...FLYER_BASE, publicUrl: SHORT }));
        expect(links.filter((l) => l.page === 1)).toHaveLength(3);
        expect(links.every((l) => l.uri === SHORT)).toBe(true);
    });

    it('characters PDF strings must escape survive the round trip exactly', async () => {
        const ODD = `https://orders.example-kitchen.test/shop/k(1)/fundraiser/${CAMPAIGN_ID}`;
        const links = pdfLinks(await generateFlyer({ ...FLYER_BASE, publicUrl: ODD }));
        expect(links.length).toBeGreaterThan(0);
        expect(links.every((l) => l.uri === ODD)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('5–6 · through the real flyer routes: custom domain and platform fallback', () => {
    it('5 · tenant custom domain → the QR and every link carry the custom-domain supporter URL', async () => {
        const db = makeDb({ customDomain: 'orders.example-kitchen.test' });
        const { buf } = await coordinatorFlyer(db);
        const expected = `https://orders.example-kitchen.test/shop/example-kitchen/fundraiser/${CAMPAIGN_ID}`;
        expect((global as any).__flQr).toEqual([expected, expected]);
        const links = pdfLinks(buf);
        expect(links.length).toBeGreaterThanOrEqual(6);
        expect(links.every((l) => l.uri === expected)).toBe(true);
    });

    it('6 · no custom domain → the pinned platform origin, the same URL for QR and links (coordinator and CRM flyers)', async () => {
        const { buf, req } = await coordinatorFlyer(makeDb({ customDomain: null }));
        const expected = `${resolveOutreachOrigin(req)}/shop/example-kitchen/fundraiser/${CAMPAIGN_ID}`;
        expect(expected).toMatch(/^https:\/\/[^/]+\/shop\/example-kitchen\/fundraiser\/7e57f000-0000-4000-8000-000000000010$/);
        expect((global as any).__flQr).toEqual([expected, expected]);
        expect(pdfLinks(buf).every((l) => l.uri === expected)).toBe(true);

        (global as any).__flQr = [];
        const res = await crmFlyer(makeDb({ customDomain: null }));
        expect(res.status).toBe(200);
        const crmBuf = Buffer.from((await res.json()).content, 'base64');
        const crmQr = (global as any).__flQr;
        expect(crmQr).toHaveLength(2);
        expect(crmQr[0]).toBe(crmQr[1]);
        expect(crmQr[0].endsWith(`/shop/example-kitchen/fundraiser/${CAMPAIGN_ID}`)).toBe(true);
        expect(pdfLinks(crmBuf).every((l) => l.uri === crmQr[0])).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('7–9 · nothing else changed', () => {
    it('7 · prices and the tax note are drawn exactly as before', async () => {
        const { buf } = await coordinatorFlyer(makeDb({ customDomain: null, tax: { tax_status: 'TAXABLE', tax_rate_percent: '1.00' } }));
        const t = pdfTexts(buf);
        expect(t[t.indexOf('Family Size:') + 1]).toBe('$126.25');
        expect(t.filter((s) => s === 'Prices include 1% sales tax.').length).toBeGreaterThanOrEqual(1);
    });

    it('8 · the CRM flyer still requires a signed-in tenant, and reads the organization inside that tenant', async () => {
        expect((await crmFlyer(makeDb({ customDomain: null }), null)).status).toBe(401);
        const db = makeDb({ customDomain: null });
        await crmFlyer(db, 'biz-other');
        expect(db.customerWhere[0]).toMatchObject({ business_id: 'biz-other' });
    });

    it('8 · the flyer routes and the URL authority are byte-identical to Production 7c9c048', () => {
        const PINNED: Record<string, string> = {
            'app/api/flyer/download/route.ts': 'fc6426bff93282f5ce784c51df9a40971be046ff2d6ffa7147befbb7bf4a4599',
            'app/api/flyer/generate/route.ts': '6510a879224ca07d761f54e118c5be6e766587937b19e854cb34f04c2bb4a84e',
            'app/api/packet/download/route.ts': 'd0691a6aec17e62f46a2016ad5f83edcbe85e651605c891bb489e386a8a59364',
            'lib/supporterMaterialPricing.ts': 'e85372f7897b82f641bdf15971a4a7162b47cd9a0b80692124245e83547c69e0',
        };
        for (const [rel, digest] of Object.entries(PINNED)) {
            expect([rel, crypto.createHash('sha256').update(R(rel).replace(/\r\n/g, '\n')).digest('hex')]).toEqual([rel, digest]);
        }
        expect(R('lib/previousSupporterInvite.ts')).toContain('export function buildSupporterOrderUrl(');
    });

    it('the generator links with explicit annotations to the one URL it was given — it builds no URL of its own', () => {
        const src = R('lib/generateFlyer.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // code, not comments
        expect(src.match(/doc\.link\(/g)!.length).toBeGreaterThanOrEqual(6);
        expect(src).not.toMatch(/buildSupporterOrderUrl|new URL\(|\/shop\/|\/fundraiser\//);
        expect([...src.matchAll(/doc\.link\([^;]*\{ url: (\w+) \}\)/g)].map((m) => m[1])).toEqual(Array(6).fill('orderUrl'));
        expect([...src.matchAll(/const orderUrl = ([^;]+);/g)].map((m) => m[1])).toEqual(['input.publicUrl', 'input.publicUrl']);
    });
});
