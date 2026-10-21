/**
 * COORDINATOR-GUIDE-SHARE-LINK-1 — the Success Guide hands out the SAME supporter
 * link as the Coordinator Panel.
 *
 * THE DEFECT: app/coordinator/portal/guide/page.tsx built its own link as
 * `window.location.origin + /shop/<slug>/fundraiser/<id>`. The dashboard uses the
 * URL the API resolves server-side (`share.orderUrl`: the tenant's storefront domain
 * when it has one, otherwise the pinned platform origin). So for every tenant with
 * a storefront domain the guide's Copy Link differed from the dashboard's, and on a
 * Vercel Preview it copied the Preview host.
 *
 * THE CONTRACT:
 *   - The guide reads `share.orderUrl` from GET /api/coordinator and nothing else.
 *   - Copy Link / Share Order Page pass exactly that string on — no rebuilding.
 *   - No URL from the browser (origin, portal path, fragment) can reach a supporter.
 *   - When the API sent no URL the guide shows no link rather than inventing one.
 *
 * The first block runs the REAL route handler. The second keeps the guide's old
 * formula as a recorded fixture, so the disagreement is proven rather than asserted.
 * All fixtures are fictional.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toast } from 'sonner';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { CANONICAL_COORDINATOR_ORIGIN } from '@/lib/fundraiserUrls';
import {
    GuideMobileShare,
    GuideShareCard,
    guideOrderUrl,
} from '@/components/coordinator/GuideShareLink';

jest.mock('sonner', () => ({ toast: { success: jest.fn() } }));
jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__gsl1Prisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__gsl1CookieName ? { name, value: 'gsl1-test-secret' } : undefined,
    }),
}));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Comments describe the old defect on purpose; only code counts. */
const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const CAMPAIGN_ID = 'campaign-gsl1-a';
const PLATFORM_HOST = CANONICAL_COORDINATOR_ORIGIN;
const PREVIEW_HOST = 'https://guide-share-example-preview.vercel.app';

/** A tenant with its own storefront domain. */
const TENANT_STOREFRONT = {
    name: 'Northwind Meals LLC', display_name: 'Northwind Meals', slug: 'northwind-meals',
    custom_domain: 'orders.example.test', contact_email: 'jordan@example.test', timezone: 'America/Chicago',
};
/** A tenant with none: it shops on the platform. */
const TENANT_DEFAULT = {
    name: 'Harbor Kitchen', display_name: null, slug: 'harbor-kitchen',
    custom_domain: null, contact_email: null, timezone: 'America/Chicago',
};

const STOREFRONT_URL = `https://orders.example.test/shop/northwind-meals/fundraiser/${CAMPAIGN_ID}`;
const DEFAULT_URL = `${PLATFORM_HOST}/shop/harbor-kitchen/fundraiser/${CAMPAIGN_ID}`;

// ── a real GET /api/coordinator against a recording Prisma double ───────────

const env = process.env as Record<string, string | undefined>;
let savedNodeEnv: string | undefined;
let mock: PrismaMock;

/** Vercel builds a Preview exactly like Production, so NODE_ENV is 'production' on both. */
const asProductionBuild = () => { env.NODE_ENV = 'production'; };

beforeEach(() => {
    jest.clearAllMocks();
    savedNodeEnv = env.NODE_ENV;
});
afterEach(() => {
    if (savedNodeEnv === undefined) delete env.NODE_ENV; else env.NODE_ENV = savedNodeEnv;
});

const campaignFor = (business: any) => ({
    id: CAMPAIGN_ID,
    name: 'Spring Fundraiser',
    status: 'Active',
    end_date: null, delivery_date: null, delivery_time: null,
    closed_at: null, settlement_total: null,
    pickup_location: 'Gym',
    external_payment_link: null, payment_instructions: null,
    bundle_goal: 40, total_sales: 0, org_share_percent: 20,
    participant_label: 'Student',
    bundle_selection_status: 'not_required', bundle_selection_limit: 2,
    public_token: 'public-token-gsl1',
    customer_id: 'org-gsl1',
    customer: {
        name: 'Lakeside PTO', contact_name: 'Riley Parent', contact_email: 'riley@pto.example.test',
        business_id: 'biz-gsl1',
        business: { ...business, logo_url: null, plan: 'FREE', subscription_status: 'active' },
    },
    orders: [],
});

/** GET /api/coordinator as served from `requestUrl` (a platform or a Preview host). */
async function getCoordinator(business: any, requestUrl = `${PLATFORM_HOST}/api/coordinator`) {
    (global as any).__gsl1CookieName = coordinatorSessionCookieName();
    mock = createPrismaMock({
        results: {
            'coordinatorSession.findUnique': {
                id: 'session-gsl1', campaign_id: CAMPAIGN_ID,
                expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
            },
            'fundraiserCampaign.findFirst': campaignFor(business),
            'order.findMany': [],
            'bundle.findMany': [],
        },
    });
    (global as any).__gsl1Prisma = mock.client;
    const { GET } = await import('@/app/api/coordinator/route');
    const res = await GET(new Request(requestUrl, {
        method: 'GET', headers: { origin: new URL(requestUrl).origin },
    }) as any);
    return { status: res.status, body: await res.json() };
}

/** The guide's OLD formula, verbatim — kept only to prove how it disagreed. */
const legacyGuideUrl = (browserOrigin: string, body: any) => {
    const slug = body?.customer?.business?.slug;
    return slug && body?.id
        ? `${browserOrigin}/shop/${slug}/fundraiser/${body.id}`
        : `${browserOrigin}/fundraiser/${body?.public_token}`;
};

// ── a browser stand-in: clipboard, share sheet, and a location that must stay unused ──

const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function installBrowser(opts: { locationHref: string; share?: boolean }) {
    const clipboard = { writeText: jest.fn() };
    const share = opts.share === false ? undefined : jest.fn();
    Object.defineProperty(globalThis, 'navigator', {
        value: { clipboard, share }, configurable: true, writable: true,
    });
    const u = new URL(opts.locationHref);
    (globalThis as any).window = { location: { origin: u.origin, href: u.href, pathname: u.pathname, hash: u.hash } };
    return { clipboard, share };
}
afterEach(() => {
    if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
    delete (globalThis as any).window;
});

/** First host element of `tag` in a rendered element tree. */
function find(node: unknown, tag: string): ReactElement<any> | null {
    if (Array.isArray(node)) {
        for (const n of node) { const hit = find(n, tag); if (hit) return hit; }
        return null;
    }
    if (!isValidElement(node)) return null;
    const el = node as ReactElement<any>;
    if (el.type === tag) return el;
    return find(el.props?.children, tag);
}

/** Every http(s) URL in rendered HTML, minus the SVG namespace lucide icons carry. */
const urlsIn = (html: string) =>
    (html.match(/https?:\/\/[^\s<>"']+/g) ?? []).filter((u) => !u.includes('w3.org'));

// ═════════════════════════════════════════════════════════════════════════════
// 1. The canonical URL comes from the server, whoever is asking
// ═════════════════════════════════════════════════════════════════════════════
describe('1. GET /api/coordinator — the one supporter URL', () => {
    it('a tenant with a storefront domain gets its own domain', async () => {
        asProductionBuild();
        const { status, body } = await getCoordinator(TENANT_STOREFRONT);
        expect(status).toBe(200);
        expect(body.share.orderUrl).toBe(STOREFRONT_URL);
    });

    it('a tenant with none falls back to the FreezerIQ platform domain', async () => {
        asProductionBuild();
        const { body } = await getCoordinator(TENANT_DEFAULT);
        expect(body.share.orderUrl).toBe(DEFAULT_URL);
        expect(DEFAULT_URL.startsWith('https://www.')).toBe(true);
    });

    it.each([
        ['a storefront-domain tenant', TENANT_STOREFRONT, STOREFRONT_URL],
        ['a default-domain tenant', TENANT_DEFAULT, DEFAULT_URL],
    ])('a Preview host never leaks into the URL — %s', async (_l, business, expected) => {
        asProductionBuild();
        const { body } = await getCoordinator(business, `${PREVIEW_HOST}/api/coordinator`);
        expect(body.share.orderUrl).toBe(expected);
        expect(body.share.orderUrl).not.toContain(new URL(PREVIEW_HOST).host);
        expect(body.share.orderUrl).not.toContain('vercel.app');
    });

    it.each([
        ['storefront', TENANT_STOREFRONT],
        ['default', TENANT_DEFAULT],
    ])('the coordinator portal URL is never the supporter URL — %s', async (_l, business) => {
        asProductionBuild();
        const { body } = await getCoordinator(business);
        const url: string = body.share.orderUrl;
        expect(url).toMatch(/\/shop\/[a-z-]+\/fundraiser\/campaign-gsl1-a$/);
        expect(url).not.toMatch(/coordinator|portal|access|guide|#/i);
        expect(url).not.toContain('public-token-gsl1');
    });

    it.each([
        ['storefront', TENANT_STOREFRONT],
        ['default', TENANT_DEFAULT],
    ])('guideOrderUrl returns that exact string — %s', async (_l, business) => {
        asProductionBuild();
        const { body } = await getCoordinator(business);
        expect(guideOrderUrl(body)).toBe(body.share.orderUrl);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Root cause — the guide's old formula disagreed with the dashboard's URL
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the old guide formula vs the canonical URL', () => {
    it('storefront-domain tenant, read on the platform host: DIFFERENT', async () => {
        asProductionBuild();
        const { body } = await getCoordinator(TENANT_STOREFRONT);
        const legacy = legacyGuideUrl(PLATFORM_HOST, body);
        expect(legacy).toBe(`${PLATFORM_HOST}/shop/northwind-meals/fundraiser/${CAMPAIGN_ID}`);
        expect(legacy).not.toBe(body.share.orderUrl);
    });

    it('default-domain tenant, read on the platform host: equal only by coincidence', async () => {
        asProductionBuild();
        const { body } = await getCoordinator(TENANT_DEFAULT);
        expect(legacyGuideUrl(PLATFORM_HOST, body)).toBe(body.share.orderUrl);
    });

    it.each([
        ['storefront', TENANT_STOREFRONT],
        ['default', TENANT_DEFAULT],
    ])('any tenant read on a Preview host: the old guide leaked the host — %s', async (_l, business) => {
        asProductionBuild();
        const { body } = await getCoordinator(business, `${PREVIEW_HOST}/api/coordinator`);
        const legacy = legacyGuideUrl(PREVIEW_HOST, body);
        expect(legacy.startsWith(PREVIEW_HOST)).toBe(true);
        expect(legacy).not.toBe(body.share.orderUrl);
        expect(body.share.orderUrl.startsWith(PREVIEW_HOST)).toBe(false);
    });

    it('the dashboard reads that same field first, so "canonical" is what it copies', () => {
        const dash = code(read('app/coordinator/portal/page.tsx'));
        expect(dash).toContain('if (campaign?.share?.orderUrl) return campaign.share.orderUrl as string;');
        const route = code(read('app/api/coordinator/route.ts'));
        expect(route).toContain('const shareOrderUrl = buildSupporterOrderUrl(');
        expect(route).toContain('resolveOutreachOrigin(req)');
        expect(route).toContain('orderUrl: shareOrderUrl,');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. What the coordinator sees, and what Copy Link / Share copy
// ═════════════════════════════════════════════════════════════════════════════
describe('3. the guide\'s share surfaces', () => {
    it('the card shows the canonical URL and no other', () => {
        const html = renderToStaticMarkup(createElement(GuideShareCard, { orderUrl: STOREFRONT_URL }));
        expect(html).toContain(`>${STOREFRONT_URL}</code>`);
        expect(html).toContain('Copy Link');
        expect(urlsIn(html)).toEqual([STOREFRONT_URL]);
    });

    it.each([null, undefined, ''])('with no URL (%j) the card and the mobile share render nothing', (v) => {
        const orderUrl = guideOrderUrl({ share: { orderUrl: v } });
        expect(orderUrl).toBeNull();
        expect(renderToStaticMarkup(createElement(GuideShareCard, { orderUrl }))).toBe('');
        expect(renderToStaticMarkup(createElement(GuideMobileShare, { orderUrl, campaignName: 'x' }))).toBe('');
    });

    it.each([null, undefined, {}, { share: null }, { share: {} }, { share: { orderUrl: 42 } }])(
        'guideOrderUrl is null for %j — never a rebuilt URL', (campaign) => {
            expect(guideOrderUrl(campaign as any)).toBeNull();
        });

    it.each([
        ['storefront-domain tenant', TENANT_STOREFRONT, STOREFRONT_URL],
        ['default-domain tenant', TENANT_DEFAULT, DEFAULT_URL],
    ])('Copy Link copies exactly the canonical URL — %s, read on a Preview host', async (_l, business, expected) => {
        asProductionBuild();
        const { body } = await getCoordinator(business, `${PREVIEW_HOST}/api/coordinator`);
        // The coordinator reads the guide at the portal URL, on a Preview host, with a
        // credential fragment. None of it may reach the clipboard.
        const { clipboard } = installBrowser({
            locationHref: `${PREVIEW_HOST}/coordinator/portal/guide#fictional-fragment`,
        });

        const tree = GuideShareCard({ orderUrl: guideOrderUrl(body) });
        find(tree, 'button')!.props.onClick();

        expect(clipboard.writeText).toHaveBeenCalledTimes(1);
        const copied: string = clipboard.writeText.mock.calls[0][0];
        expect(copied).toBe(expected);
        expect(copied).toBe(body.share.orderUrl);
        expect(copied).not.toContain(new URL(PREVIEW_HOST).host);
        expect(copied).not.toMatch(/\/coordinator|\/portal|\/guide|#|fictional-fragment/);
        expect(toast.success).toHaveBeenCalledWith('Public Link Copied!');
    });

    it('Share Order Page shares exactly the canonical URL', async () => {
        asProductionBuild();
        const { body } = await getCoordinator(TENANT_STOREFRONT, `${PREVIEW_HOST}/api/coordinator`);
        const { share } = installBrowser({ locationHref: `${PREVIEW_HOST}/coordinator/portal/guide` });

        const tree = GuideMobileShare({ orderUrl: guideOrderUrl(body), campaignName: body.name });
        find(tree, 'button')!.props.onClick();

        expect(share).toHaveBeenCalledTimes(1);
        expect(share).toHaveBeenCalledWith({
            title: 'Spring Fundraiser Fundraiser',
            text: 'Support our fundraiser and solve dinner!',
            url: STOREFRONT_URL,
        });
    });

    it('Share Order Page is inert on a device with no share sheet', () => {
        const { share } = installBrowser({ locationHref: `${PLATFORM_HOST}/coordinator/portal/guide`, share: false });
        const tree = GuideMobileShare({ orderUrl: DEFAULT_URL, campaignName: 'x' });
        expect(() => find(tree, 'button')!.props.onClick()).not.toThrow();
        expect(share).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Source guards
// ═════════════════════════════════════════════════════════════════════════════
const GUIDE = 'app/coordinator/portal/guide/page.tsx';
const COMPONENT = 'components/coordinator/GuideShareLink.tsx';

describe('4. the guide builds no URL of its own', () => {
    it('the page reads the API\'s URL and touches no browser location, clipboard or slug', () => {
        const src = code(read(GUIDE));
        expect(src).toContain('const orderUrl = guideOrderUrl(campaign);');
        expect(src).toContain('<GuideShareCard orderUrl={orderUrl} />');
        expect(src).toContain('<GuideMobileShare orderUrl={orderUrl} campaignName={campaign?.name} />');
        for (const forbidden of [/window\b/, /navigator\b/, /location\b/, /origin\b/, /\/shop\//, /\/fundraiser\//, /public_token/, /\bslug\b/, /publicUrl/]) {
            expect(src).not.toMatch(forbidden);
        }
    });

    it('the component passes the given URL through and builds none', () => {
        const src = code(read(COMPONENT));
        expect(src).toContain('navigator.clipboard.writeText(orderUrl);');
        expect(src).toContain('url: orderUrl');
        expect(src).toContain('campaign?.share?.orderUrl');
        for (const forbidden of [/window\b/, /location\b/, /origin\b/, /\/shop\//, /\/fundraiser\//, /public_token/, /\bslug\b/, /custom_domain/, /NEXTAUTH/]) {
            expect(src).not.toMatch(forbidden);
        }
    });

    it('the guide and the dashboard both read the API\'s share.orderUrl', () => {
        expect(code(read(COMPONENT))).toMatch(/campaign\?\.share\?\.orderUrl/);
        expect(code(read('app/coordinator/portal/page.tsx'))).toMatch(/campaign\?\.share\?\.orderUrl/);
    });
});
