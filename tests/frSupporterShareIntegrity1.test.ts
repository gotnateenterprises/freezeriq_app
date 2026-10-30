/**
 * FR-SUPPORTER-SHARE-INTEGRITY-1 — supporters always share the right fundraiser, by one URL.
 *
 * AUDIT (re-verified at Production 600da6b):
 *   1. canonical/og:url came from NEXT_PUBLIC_BASE_URL → VERCEL_URL; the variable is unset in Vercel,
 *      so every live fundraiser advertised the protected deployment host (a login wall).
 *   2. every supporter share used window.location.href — Preview hosts, tracking queries and share
 *      tokens all travelled into Copy / Facebook / Text.
 *   3. Days Left was Math.ceil((noon-LOCAL end_date − now) / 1 day) in the browser.
 *   4. there was no way to share before ordering.
 *   5. the page serialized the whole business / tenant_branding / bundle rows and the dollar sales.
 *   6. the scoreboard said "$null goal", shared its own address, linked nowhere, and its API returned
 *      dollar sales and each supporter's order total.
 *
 * THE INVARIANTS PINNED HERE
 *   canonical == og:url == every share destination (Copy, Facebook, Email, Text, native, pre-order,
 *   post-order, scoreboard), from ONE server-side authority; never the browser address, a Preview
 *   host, a query or an order; the deadline is a tenant-calendar question decided with the ordering
 *   mode; goals never render null/NaN; public payloads are include-lists.
 *
 * Every organization, supporter and domain below is FICTIONAL (the repository is public).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mountComponent, findAll, textOf } from './helpers/hookRuntime';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import {
    sanitizeSupporterShareUrl,
    supporterShareCaption,
    supporterFacebookHref,
    supporterSmsHref,
    supporterEmailHref,
    supporterNativeShareData,
    openFacebookShare,
    copyShareText,
    shareNatively,
    SUPPORTER_SHARE_CHANNELS,
    isSupporterShareChannel,
} from '@/lib/supporterShare';
import { describeSupporterDeadline, supporterDeadlineLabel, supporterDeadlinePill } from '@/lib/supporterDeadline';
import { resolveCanonicalSupporterUrl } from '@/lib/fundraiserCanonicalUrl';
import {
    toPublicSupporterBusiness,
    toPublicBundleProgress,
    toPublicOrderMode,
    toPublicScoreboard,
    FORBIDDEN_PUBLIC_SUPPORTER_FIELDS,
    FORBIDDEN_PUBLIC_SCOREBOARD_FIELDS,
    FORBIDDEN_PUBLIC_SCOREBOARD_ORDER_FIELDS,
    PUBLIC_SCOREBOARD_FIELDS,
} from '@/lib/publicFundraiserPayload';
import { buildSampleCampaign, SAMPLE_DEADLINE } from '@/lib/sampleFundraiser';
import { calendarDaysUntil } from '@/lib/tenantTimezone';

jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__si1Prisma; } }));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const CLIENT_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const PAGE_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx';

// ── fictional fixtures ────────────────────────────────────────────────────────────────────────
const BIZ_ID = 'biz-fixture-1';
const SLUG = 'maple-kitchen-fixture';
const DOMAIN = 'maple-kitchen.example';
const CAMPAIGN_ID = 'aaaa1111-0000-4000-8000-00000000c0de';
const ORG = 'Maple Grove Booster Club (fixture)';
const CANONICAL = `https://${DOMAIN}/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`;
const PLATFORM_CANONICAL = `https://www.freezeriqapp.com/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`;
/** What a supporter's browser might be showing: a Preview host, a tracking query, a share token. */
const BROWSER_URL = `https://freezeriq-git-feature-team.vercel.app/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}?utm_source=fb&fbclid=XYZ&_vercel_share=SECRET#thanks`;
const SUPPORTER = { first: 'Ada', last: 'Fixturely', email: 'ada.fixture@example.test', phone: '555-0100' };
const ORDER_ID = 'ord-PRIVATE-9f3c2b';
const PRIMARY = '#a1336b';

const bundle = (over: any = {}) => ({
    id: 'b-ff', name: 'Family Favorites (fixture)', description: 'Five dinners', serving_tier: 'family', price: 89, image_url: null,
    items: [{ quantity: 1, recipe: { name: 'Baked Ziti', description: null, image_url: null, cook_time: null, allergens: null, macros: null } }],
    ...over,
});
const clientProps = (over: any = {}) => ({
    business: { name: 'Maple Kitchen (fixture)', display_name: null, slug: SLUG, logo_url: null, branding: { primary_color: PRIMARY, logo_url: null }, bundles: [bundle()] },
    campaign: {
        id: CAMPAIGN_ID, name: `${ORG} Fundraiser`, organization_name: ORG, about_text: null, participant_label: 'Player',
        end_date: '2026-11-06', delivery_date: '2026-11-13', pickup_location: 'Fixture Gym', delivery_time: null,
        payment_instructions: 'Pay the coordinator by check', external_payment_link: null, tax_status: null, tax_rate_percent: null,
        customer_fundraiser_info: { delivery_date: null, delivery_time: null, pickup_location: null },
    },
    bundleProgress: { totalBundlesSold: 6, bundleGoal: 20 },
    orderMode: { allowed: true, mode: 'legacy' },
    slug: SLUG,
    fundraiserId: CAMPAIGN_ID,
    shareUrl: CANONICAL,
    deadline: { kind: 'days', days: 8 },
    ...over,
});

// ── browser doubles ───────────────────────────────────────────────────────────────────────────
let win: { open: jest.Mock; location: { href: string; hostname: string }; scrollTo: jest.Mock };
let nav: { clipboard?: { writeText: jest.Mock } | null; share?: jest.Mock | undefined };
let fetchMock: jest.Mock;
function installBrowser(opts: { share?: boolean | 'reject'; clipboard?: 'ok' | 'reject' | 'missing' | 'pending' } = {}) {
    win = { open: jest.fn(), location: { href: BROWSER_URL, hostname: 'freezeriq-git-feature-team.vercel.app' }, scrollTo: jest.fn() };
    const clip = opts.clipboard ?? 'ok';
    nav = {
        clipboard: clip === 'missing' ? null : {
            writeText: jest.fn(() => (clip === 'ok' ? Promise.resolve() : clip === 'reject' ? Promise.reject(new Error('denied')) : new Promise<void>(() => { /* never settles */ }))),
        },
        share: opts.share === undefined || opts.share === false ? undefined
            : jest.fn(() => (opts.share === 'reject' ? Promise.reject(Object.assign(new Error('nope'), { name: 'NotAllowedError' })) : Promise.resolve())),
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: win });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: nav });
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ orderId: ORDER_ID, total: 89, paymentData: { orgName: ORG } }) }));
    (globalThis as any).fetch = fetchMock;
}

const byLabel = (tree: any, label: string) => findAll(tree, (el) => el.type === 'button' && el.props['aria-label'] === label);
const one = (tree: any, label: string) => {
    const hits = byLabel(tree, label);
    if (hits.length < 1) throw new Error(`no button labelled "${label}"`);
    return hits[0];
};
const byText = (tree: any, re: RegExp) => findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)));
const inputByLabel = (tree: any, label: string) => findAll(tree, (el) => el.type === 'input' && el.props['aria-label'] === label)[0];

/** Every URL in a (decoded) string. */
const urlsIn = (s: string) => (s.match(/https?:\/\/[^\s"'<>)]+/g) || []);
/** Every share destination a payload carries, after decoding. */
function destinationsOf(href: string): string[] {
    const decoded = decodeURIComponent(href);
    return urlsIn(decoded).filter((u) => !u.startsWith('https://www.facebook.com/sharer'));
}

async function placeOrder(m: ReturnType<typeof mountComponent>) {
    one(m.tree, 'Add Family Favorites (fixture) to your order').props.onClick(); m.render();
    inputByLabel(m.tree, 'First Name').props.onChange({ target: { value: SUPPORTER.first } }); m.render();
    inputByLabel(m.tree, 'Last Name').props.onChange({ target: { value: SUPPORTER.last } }); m.render();
    inputByLabel(m.tree, 'Email').props.onChange({ target: { value: SUPPORTER.email } }); m.render();
    inputByLabel(m.tree, 'Phone Number').props.onChange({ target: { value: SUPPORTER.phone } }); m.render();
    await byText(m.tree, /^Place my order/)[0].props.onClick(); m.render();
}

const loadClient = () => require('@/app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient').default;

beforeEach(() => {
    jest.clearAllMocks();
    installBrowser();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE CANONICAL URL
// ═════════════════════════════════════════════════════════════════════════════
describe('1. one canonical public fundraiser URL', () => {
    const KEYS = ['NODE_ENV', 'VERCEL_URL', 'NEXT_PUBLIC_BASE_URL', 'NEXTAUTH_URL'] as const;
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = saved[k];
        }
    });

    it('1a. campaign → the tenant storefront domain + /shop/{slug}/fundraiser/{id}', () => {
        expect(resolveCanonicalSupporterUrl({ campaignId: CAMPAIGN_ID, slug: SLUG, customDomain: DOMAIN })).toBe(CANONICAL);
    });

    it('1b. a tenant with no storefront domain gets the PINNED platform origin in a production build', () => {
        (process.env as any).NODE_ENV = 'production';
        expect(resolveCanonicalSupporterUrl({ campaignId: CAMPAIGN_ID, slug: SLUG, customDomain: null })).toBe(PLATFORM_CANONICAL);
    });

    it('1c. a Preview deployment never becomes canonical (VERCEL_URL / NEXT_PUBLIC_BASE_URL are ignored; Preview builds are production builds)', () => {
        (process.env as any).NODE_ENV = 'production';
        process.env.VERCEL_URL = 'freezeriq-git-feature-team.vercel.app';
        process.env.NEXT_PUBLIC_BASE_URL = 'https://freezeriq-git-feature-team.vercel.app';
        process.env.NEXTAUTH_URL = 'https://freezeriq-app.vercel.app';
        const url = resolveCanonicalSupporterUrl({ campaignId: CAMPAIGN_ID, slug: SLUG, customDomain: null })!;
        expect(url).toBe(PLATFORM_CANONICAL);
        expect(url).not.toMatch(/vercel\.app/);
    });

    it('1d. where only a deployment host is available, it FAILS CLOSED (null), never a vercel.app URL', () => {
        (process.env as any).NODE_ENV = 'development';
        process.env.NEXTAUTH_URL = 'https://freezeriq-app.vercel.app';
        expect(resolveCanonicalSupporterUrl({ campaignId: CAMPAIGN_ID, slug: SLUG, customDomain: null })).toBeNull();
    });

    it('1e. queries, fragments, credentials, deployment hosts and non-fundraiser paths are refused, not trimmed', () => {
        expect(sanitizeSupporterShareUrl(CANONICAL)).toBe(CANONICAL);
        for (const bad of [
            `${CANONICAL}?utm_source=fb`, `${CANONICAL}#thanks`, `${CANONICAL}?order=${ORDER_ID}`,
            `https://user:pass@${DOMAIN}/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`,
            `https://freezeriq-app.vercel.app/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`,
            `https://${DOMAIN}/coordinator/access#tok`, `https://${DOMAIN}/api/fundraiser/tok`,
            `https://${DOMAIN}/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}/confirmation`,
            `http://${DOMAIN}/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`, 'javascript:alert(1)', '', null, undefined, 42,
        ]) expect(sanitizeSupporterShareUrl(bad as any)).toBeNull();
        // Plain http is allowed only for local development.
        expect(sanitizeSupporterShareUrl(`http://localhost:3000/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`)).toBe(`http://localhost:3000/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`);
    });

    it('1f. it is the SAME authority the coordinator dashboard, QR code and flyer use', () => {
        const src = strip(read('lib/fundraiserCanonicalUrl.ts'));
        expect(src).toMatch(/buildSupporterOrderUrl\(\s*resolveOutreachOrigin\(\)/);
        expect(src).not.toMatch(/window|VERCEL_URL|NEXT_PUBLIC_BASE_URL|headers\(|req\.url/);
        expect(strip(read('app/api/coordinator/route.ts'))).toMatch(/buildSupporterOrderUrl\(\s*resolveOutreachOrigin\(req\)/);
    });

    it('1g. the supporter page never derives a URL from the browser: the only window.location use is navigation to sms:/mailto:', () => {
        const src = strip(read(CLIENT_PATH));
        const uses = src.match(/window\.location[.\w]*\s*=?\s*[^;\n]*/g) || [];
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) expect(u).toMatch(/^window\.location\.href = supporter(Sms|Email)Href\(shareFacts\)$/);
        expect(src).not.toMatch(/document\.URL|location\.origin|location\.search|pageUrl/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. EVERY CHANNEL, ONE DESTINATION
// ═════════════════════════════════════════════════════════════════════════════
describe('2. every share channel carries exactly the canonical URL', () => {
    const facts = { url: CANONICAL, organizationName: ORG, bundleGoal: 20, bundlesSold: 6.5 };

    it('2a. caption, Facebook, Text, Email and native share data all point at the same URL, and only it', () => {
        expect(urlsIn(supporterShareCaption(facts))).toEqual([CANONICAL]);
        expect(new URL(supporterFacebookHref(CANONICAL)).searchParams.get('u')).toBe(CANONICAL);
        expect(destinationsOf(supporterSmsHref(facts))).toEqual([CANONICAL]);
        expect(supporterSmsHref(facts).startsWith('sms:?&body=')).toBe(true);
        const mail = supporterEmailHref(facts);
        expect(mail.startsWith('mailto:?subject=')).toBe(true);
        expect(destinationsOf(mail)).toEqual([CANONICAL]);
        const native = supporterNativeShareData(facts);
        expect(native.url).toBe(CANONICAL);
        expect(urlsIn(native.text)).toEqual([]);           // the link travels once, as `url`
    });

    it('2b. the text never renders null / NaN / Infinity, whatever the numbers', () => {
        for (const f of [{ ...facts, bundleGoal: NaN, bundlesSold: Infinity }, { ...facts, organizationName: null, bundleGoal: 0, bundlesSold: -1 }]) {
            const all = [supporterShareCaption(f), decodeURIComponent(supporterEmailHref(f)), supporterNativeShareData(f).text].join(' ');
            expect(all).not.toMatch(/null|NaN|Infinity|undefined/);
        }
    });

    it('2c. the channel names are a closed list (nothing else can be recorded)', () => {
        expect([...SUPPORTER_SHARE_CHANNELS]).toEqual(['copy_message', 'copy_link', 'facebook', 'email', 'text', 'native']);
        expect(isSupporterShareChannel('facebook')).toBe(true);
        expect(isSupporterShareChannel('ada.fixture@example.test')).toBe(false);
    });

    it('2d. the supporter page records no share analytics and makes no request but the order', () => {
        const src = strip(read(CLIENT_PATH));
        expect((src.match(/fetch\(/g) || []).length).toBe(1);
        expect(strip(read('lib/supporterShare.ts'))).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon/);
    });

    it('2e. BEFORE ordering — native share sheet receives the canonical URL, not the browser address', async () => {
        installBrowser({ share: true });
        const m = mountComponent(loadClient(), clientProps());
        await one(m.tree, 'Share this fundraiser').props.onClick(); m.render();
        expect(nav.share).toHaveBeenCalledTimes(1);
        expect(nav.share!.mock.calls[0][0].url).toBe(CANONICAL);
        expect(JSON.stringify(nav.share!.mock.calls[0][0])).not.toMatch(/vercel\.app|utm_|fbclid|_vercel_share/);
        expect(textOf(m.tree)).toContain('Thanks for sharing!');
    });

    it('2f. BEFORE ordering, with no share sheet — the options panel opens (never a silent no-op) and every option shares the canonical URL', async () => {
        installBrowser({ share: false });
        const m = mountComponent(loadClient(), clientProps());
        expect(findAll(m.tree, (el) => el.props?.role === 'group' && el.props['aria-label'] === 'Ways to share this fundraiser')).toHaveLength(0);
        await one(m.tree, 'Share this fundraiser').props.onClick(); m.render();
        expect(findAll(m.tree, (el) => el.props?.role === 'group' && el.props['aria-label'] === 'Ways to share this fundraiser')).toHaveLength(1);
        expect(textOf(m.tree)).toContain('Choose how you’d like to share:');
        expect(textOf(m.tree)).toContain(CANONICAL);                 // the link is visible for long-press

        await one(m.tree, 'Copy the fundraiser link').props.onClick(); m.render();
        expect(nav.clipboard!.writeText).toHaveBeenLastCalledWith(CANONICAL);

        await one(m.tree, 'Share the fundraiser on Facebook').props.onClick();
        expect(win.open).toHaveBeenCalledWith(supporterFacebookHref(CANONICAL), '_blank', 'noopener,noreferrer');

        one(m.tree, 'Email the fundraiser link').props.onClick();
        expect(destinationsOf(win.location.href)).toEqual([CANONICAL]);
        expect(win.location.href.startsWith('mailto:')).toBe(true);

        one(m.tree, 'Text the fundraiser link').props.onClick();
        expect(destinationsOf(win.location.href)).toEqual([CANONICAL]);
        expect(win.location.href.startsWith('sms:')).toBe(true);
    });

    it('2g. a failed share sheet also falls back to the options panel', async () => {
        installBrowser({ share: 'reject' });
        const m = mountComponent(loadClient(), clientProps());
        await one(m.tree, 'Share this fundraiser').props.onClick(); m.render();
        expect(findAll(m.tree, (el) => el.props?.['aria-label'] === 'Ways to share this fundraiser')).toHaveLength(1);
    });

    it('2h. AFTER ordering — Copy, Facebook, Text, Email and More-ways all share the PUBLIC page, never the order', async () => {
        installBrowser({ share: true });
        const m = mountComponent(loadClient(), clientProps());
        await placeOrder(m);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(textOf(m.tree)).toContain('One last step — pay your coordinator');   // confirmation still primary

        await one(m.tree, 'Copy the fundraiser share message and link').props.onClick(); m.render();
        const copied = nav.clipboard!.writeText.mock.calls.map((c) => c[0]).join('\n');
        expect(urlsIn(copied)).toEqual([CANONICAL]);

        await one(m.tree, 'Open Facebook to share the fundraiser (copies the caption first)').props.onClick();
        expect(win.open).toHaveBeenLastCalledWith(supporterFacebookHref(CANONICAL), '_blank', 'noopener,noreferrer');

        one(m.tree, 'Text the fundraiser message to friends').props.onClick();
        expect(destinationsOf(win.location.href)).toEqual([CANONICAL]);
        const sms = win.location.href;

        one(m.tree, 'Email the fundraiser link').props.onClick();
        expect(destinationsOf(win.location.href)).toEqual([CANONICAL]);
        const mail = win.location.href;

        await one(m.tree, 'More ways to share the fundraiser').props.onClick();
        expect(nav.share!.mock.calls[0][0].url).toBe(CANONICAL);

        // PRIVACY: nothing about this supporter or this order travels in any share.
        const everything = decodeURIComponent([copied, sms, mail, JSON.stringify(win.open.mock.calls), JSON.stringify(nav.share!.mock.calls)].join(' '));
        for (const secret of [ORDER_ID, ORDER_ID.slice(-6).toUpperCase(), SUPPORTER.first, SUPPORTER.last, SUPPORTER.email, SUPPORTER.phone, '_vercel_share', 'utm_', 'fbclid', 'vercel.app']) {
            expect(everything).not.toContain(secret);
        }
    });

    it('2i. Facebook opens SYNCHRONOUSLY from the click — before the clipboard settles, and even if it never does', async () => {
        installBrowser({ share: false, clipboard: 'pending' });
        const m = mountComponent(loadClient(), clientProps());
        await one(m.tree, 'Share this fundraiser').props.onClick(); m.render();
        void one(m.tree, 'Share the fundraiser on Facebook').props.onClick();   // NOT awaited: still inside the click
        expect(win.open).toHaveBeenCalledTimes(1);
        expect(win.open).toHaveBeenCalledWith(supporterFacebookHref(CANONICAL), '_blank', 'noopener,noreferrer');
        expect(nav.clipboard!.writeText).toHaveBeenCalledTimes(1);           // started, never settled
    });

    it('2j. the share helpers: Facebook needs no clipboard, copy never throws, native share is feature-detected', async () => {
        const w = { open: jest.fn() };
        expect(openFacebookShare(w, CANONICAL)).toBe(true);
        expect(w.open).toHaveBeenCalledTimes(1);
        expect(openFacebookShare(null, CANONICAL)).toBe(false);
        await expect(copyShareText(null, 'x')).resolves.toBe(false);
        await expect(copyShareText({ clipboard: { writeText: () => { throw new Error('sync'); } } } as any, 'x')).resolves.toBe(false);
        await expect(copyShareText({ clipboard: { writeText: () => Promise.reject(new Error('no')) } }, 'x')).resolves.toBe(false);
        await expect(shareNatively({}, { title: 't', text: 'x', url: CANONICAL })).resolves.toBe('unsupported');
        await expect(shareNatively({ share: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })) }, { title: 't', text: 'x', url: CANONICAL })).resolves.toBe('cancelled');
        await expect(shareNatively({ share: () => Promise.reject(new Error('x')) }, { title: 't', text: 'x', url: CANONICAL })).resolves.toBe('failed');
        expect(strip(read('lib/supporterShare.ts'))).not.toMatch(/userAgent/);
    });

    it('2k. with NO safe URL there is no share control anywhere (fail closed)', async () => {
        const m = mountComponent(loadClient(), clientProps({ shareUrl: null }));
        expect(byLabel(m.tree, 'Share this fundraiser')).toHaveLength(0);
        await placeOrder(m);
        expect(byLabel(m.tree, 'Copy the fundraiser share message and link')).toHaveLength(0);
        expect(byLabel(m.tree, 'More ways to share the fundraiser')).toHaveLength(0);
        expect(textOf(m.tree)).toContain('One last step — pay your coordinator');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. METADATA AND THE SERVER PAGE
// ═════════════════════════════════════════════════════════════════════════════
function pageMock(over: { campaign?: any; business?: any } = {}): PrismaMock {
    const business = { id: BIZ_ID, name: 'Maple Kitchen (fixture)', display_name: null, slug: SLUG, logo_url: null, timezone: 'America/Chicago', custom_domain: DOMAIN, ...(over.business || {}) };
    const campaignRow = {
        id: CAMPAIGN_ID, name: `${ORG} Fundraiser`, about_text: null, participant_label: null,
        end_date: new Date('2099-01-01T00:00:00.000Z'), delivery_date: null, pickup_location: null, delivery_time: null,
        payment_instructions: null, external_payment_link: null, bundle_goal: 20, total_sales: '1234.56',
        status: 'Active', closed_at: null, tax_status: null, tax_rate_percent: null,
        bundle_selection_status: 'not_required', bundle_selection_limit: null,
        organization_name: ORG, customer_fundraiser_info: { checks_payable_to: 'INTERNAL' }, portal_token: 'PORTAL-SECRET',
        ...(over.campaign || {}),
    };
    return createPrismaMock({
        results: {
            'business.findUnique': business,
            $queryRaw: ({ sql }: { sql: string }) => {
                if (/FROM tenant_branding/.test(sql)) return [{ id: 7, user_id: 'user-INTERNAL', business_name: 'Freezer Chef', primary_color: PRIMARY, logo_url: null, review_qr_url: 'https://internal.example/qr', thank_you_note: 'internal', sign_off: 'internal' }];
                if (/SELECT fc\.id, fc\.name, c\.name as organization_name/.test(sql)) return [{ id: campaignRow.id, name: campaignRow.name, organization_name: ORG }];
                if (/SELECT bu\.image_url/.test(sql)) return [];
                if (/FROM fundraiser_campaigns fc/.test(sql)) return [campaignRow];
                if (/FROM orders o/.test(sql)) return [{ id: 'o1', total_amount: '89.00' }];
                if (/FROM order_items oi/.test(sql)) return [{ order_id: 'o1', quantity: 2, variant_size: 'serves_5', serving_tier: 'family' }];
                if (/FROM bundles/.test(sql)) return [{ id: 'b-ff', name: 'Family Favorites (fixture)', sku: 'SKU-INTERNAL', description: null, serving_tier: 'family', price: '89.00', business_id: BIZ_ID, image_url: null, stock_on_hand: '42', is_active: true, show_on_storefront: true, catalog_id: 'cat-INTERNAL', family_id: 'fam-1', is_surplus: false, order_cutoff_date: null }];
                if (/FROM bundle_contents bc/.test(sql)) return [{ id: 'bc-1', bundle_id: 'b-ff', recipe_id: 'r-1', position: 1, quantity: 1, recipe_name: 'Baked Ziti', recipe_description: 'Cheesy', recipe_image_url: null, recipe_cook_time: 45, recipe_allergens: 'dairy', recipe_macros: null }];
                return [];
            },
        },
    });
}
const usePrisma = (m: PrismaMock) => { (global as any).__si1Prisma = m.client; return m; };
const pageParams = () => ({ params: Promise.resolve({ slug: SLUG, fundraiserId: CAMPAIGN_ID }) });

describe('3. canonical == og:url == the share destination the page hands its client', () => {
    it('3a. metadata publishes the canonical URL as canonical AND og:url, with an absolute image', async () => {
        usePrisma(pageMock());
        const { generateMetadata } = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
        const meta: any = await generateMetadata(pageParams());
        expect(meta.alternates.canonical).toBe(CANONICAL);
        expect(meta.openGraph.url).toBe(CANONICAL);
        expect(meta.openGraph.images[0].url).toBe(`https://${DOMAIN}/freezer-chef-logo.png`);
        expect(meta.twitter.images[0]).toBe(`https://${DOMAIN}/freezer-chef-logo.png`);
        expect(meta.openGraph.title).toBe(`Support ${ORG} | Maple Kitchen (fixture)`);
    });

    it('3b. the page hands the client the SAME URL', async () => {
        usePrisma(pageMock());
        const mod = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
        const meta: any = await mod.generateMetadata(pageParams());
        const el: any = await mod.default(pageParams());
        expect(el.props.shareUrl).toBe(meta.openGraph.url);
        expect(el.props.shareUrl).toBe(meta.alternates.canonical);
    });

    it('3c. the old NEXT_PUBLIC_BASE_URL / VERCEL_URL path is gone from the page', () => {
        expect(strip(read(PAGE_PATH))).not.toMatch(/NEXT_PUBLIC_BASE_URL|VERCEL_URL|process\.env/);
    });

    it('3d. a tenant with no storefront domain in a production build: still one URL everywhere, on the platform origin', async () => {
        const prev = process.env.NODE_ENV;
        (process.env as any).NODE_ENV = 'production';
        try {
            usePrisma(pageMock({ business: { custom_domain: null } }));
            const mod = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
            const meta: any = await mod.generateMetadata(pageParams());
            const el: any = await mod.default(pageParams());
            expect(meta.openGraph.url).toBe(PLATFORM_CANONICAL);
            expect(el.props.shareUrl).toBe(PLATFORM_CANONICAL);
        } finally { (process.env as any).NODE_ENV = prev; }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE DEADLINE IS A TENANT-CALENDAR QUESTION
// ═════════════════════════════════════════════════════════════════════════════
describe('4. Days Left — calendar dates in the tenant zone, consistent with the ordering authority', () => {
    const CHI = 'America/Chicago';
    const d = (endDate: any, now: string, tz: string | null = CHI, orderingOpen = true) =>
        describeSupporterDeadline({ endDate, timeZone: tz, orderingOpen, now: new Date(now) });

    it.each([
        ['today (morning, Chicago)', '2026-11-06', '2026-11-06T14:00:00Z', { kind: 'today' }, 'Ends today'],
        ['today (late evening Chicago = next day UTC) — still today, not closed', '2026-11-06', '2026-11-07T05:30:00Z', { kind: 'today' }, 'Ends today'],
        ['tomorrow', '2026-11-07', '2026-11-06T14:00:00Z', { kind: 'days', days: 1 }, '1 day left'],
        ['tomorrow, read just after midnight Chicago', '2026-11-07', '2026-11-06T06:05:00Z', { kind: 'days', days: 1 }, '1 day left'],
        ['two days, read just BEFORE midnight Chicago (already the 6th in UTC)', '2026-11-07', '2026-11-06T05:55:00Z', { kind: 'days', days: 2 }, '2 days left'],
        ['several days', '2026-11-14', '2026-11-06T14:00:00Z', { kind: 'days', days: 8 }, '8 days left'],
        ['month boundary', '2026-12-01', '2026-11-30T23:00:00Z', { kind: 'days', days: 1 }, '1 day left'],
        ['year boundary', '2027-01-01', '2026-12-31T20:00:00Z', { kind: 'days', days: 1 }, '1 day left'],
        ['across the November DST change', '2026-11-02', '2026-10-31T16:00:00Z', { kind: 'days', days: 2 }, '2 days left'],
        ['across the March DST change', '2027-03-15', '2027-03-13T16:00:00Z', { kind: 'days', days: 2 }, '2 days left'],
        ['a DATE column read as UTC midnight', new Date('2026-11-08T00:00:00.000Z'), '2026-11-06T14:00:00Z', { kind: 'days', days: 2 }, '2 days left'],
    ])('4a. %s', (_label, endDate, now, expected, label) => {
        const r = d(endDate, now);
        expect(r).toEqual(expected);
        expect(supporterDeadlineLabel(r)).toBe(label);
        expect(supporterDeadlineLabel(r)).not.toMatch(/^0 /);
    });

    it('4b. expired / closed — the ordering mode wins, whatever the arithmetic says', () => {
        expect(d('2026-11-14', '2026-11-06T14:00:00Z', CHI, false)).toEqual({ kind: 'closed' });
        expect(supporterDeadlineLabel({ kind: 'closed' })).toBe('Ordering closed');
        expect(supporterDeadlinePill({ kind: 'closed' })).toBeNull();
    });

    it('4c. no deadline, an unreadable date or an unusable zone: say nothing rather than guess', () => {
        expect(d(null, '2026-11-06T14:00:00Z')).toEqual({ kind: 'none' });
        expect(d('not-a-date', '2026-11-06T14:00:00Z')).toEqual({ kind: 'none' });
        expect(d('2026-11-14', '2026-11-06T14:00:00Z', '-05:00')).toEqual({ kind: 'none' });
        expect(d('2026-11-14', '2026-11-06T14:00:00Z', null)).toEqual({ kind: 'none' });
        expect(supporterDeadlinePill({ kind: 'none' })).toBeNull();
    });

    it('4d. the UTC boundary: 00:30 UTC is still the previous calendar day in Chicago', () => {
        expect(d('2026-11-07', '2026-11-07T00:30:00Z')).toEqual({ kind: 'days', days: 1 });
        expect(d('2026-11-07', '2026-11-07T00:30:00Z', 'UTC')).toEqual({ kind: 'today' });
    });

    it('4e. the process/browser timezone has no effect (a viewer east or west of the server sees the same answer)', () => {
        const prev = process.env.TZ;
        const answers: any[] = [];
        try {
            for (const tz of ['Pacific/Kiritimati', 'Asia/Tokyo', 'Europe/London', 'America/Chicago', 'America/Los_Angeles', 'Pacific/Pago_Pago']) {
                process.env.TZ = tz;
                answers.push([d('2026-11-07', '2026-11-06T14:00:00Z'), d('2026-11-06', '2026-11-07T05:30:00Z'), d('2026-11-14', '2026-11-06T23:59:00Z')]);
            }
        } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
        for (const a of answers) expect(a).toEqual(answers[0]);
    });

    it('4f. it is the same calendar rule the order route enforces (calendarDaysUntil, the tenant zone)', () => {
        for (const [end, now] of [['2026-11-07', '2026-11-06T14:00:00Z'], ['2026-11-14', '2026-11-07T05:30:00Z']]) {
            const r = d(end, now);
            const days = calendarDaysUntil(end, CHI, new Date(now))!;
            expect(r).toEqual(days <= 0 ? { kind: 'today' } : { kind: 'days', days });
        }
        expect(strip(read('lib/supporterDeadline.ts'))).not.toMatch(/new Date\(\s*[^)]*T12|getHours|getDate\(|Math\.ceil/);
    });

    it('4g. the page decides it in the SAME render as the ordering mode, from the tenant zone, and the client only renders it', () => {
        const page = strip(read(PAGE_PATH));
        expect(page).toMatch(/describeSupporterDeadline\(\{\s*endDate: campaign\.end_date,\s*timeZone: business\.timezone,\s*orderingOpen: orderMode\.mode !== 'closed',?\s*\}\)/);
        const client = strip(read(CLIENT_PATH));
        expect(client).not.toMatch(/Math\.ceil\(\(end\.getTime\(\)|const daysLeft = useMemo/);
        expect(client).toMatch(/supporterDeadlinePill\(deadline/);
    });

    it('4h. the pill renders the server decision — "Today / Ordering Ends" on the last day, never "0 Days Left"', () => {
        const html = renderToStaticMarkup(createElement(loadClient(), clientProps({ deadline: { kind: 'today' } })));
        expect(html).toContain('Today');
        expect(html).toContain('Ordering Ends');
        expect(html).not.toMatch(/>0<\/b><span[^>]*>Days? Left/);
        const one1 = renderToStaticMarkup(createElement(loadClient(), clientProps({ deadline: { kind: 'days', days: 1 } })));
        expect(one1).toMatch(/>1<\/b><span[^>]*>Day Left</);
        const none = renderToStaticMarkup(createElement(loadClient(), clientProps({ deadline: null })));
        expect(none).not.toMatch(/Days? Left|Ordering Ends/);
    });

    it('4i. the sample page\'s deadline descriptor matches its own fixed 14-day deadline', () => {
        const now = new Date('2026-09-29T15:00:00.000Z');
        expect(calendarDaysUntil(buildSampleCampaign(now).end_date as string, 'UTC', now)).toBe(14);
        expect(SAMPLE_DEADLINE).toEqual({ kind: 'days', days: 14 });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. GOAL / PROGRESS NEVER RENDERS NONSENSE
// ═════════════════════════════════════════════════════════════════════════════
describe('5. goal and progress', () => {
    // React's server renderer separates adjacent text nodes with <!-- --> markers; remove them to read the text.
    const render = (progress: any) => renderToStaticMarkup(createElement(loadClient(), clientProps({ bundleProgress: progress }))).replace(/<!-- -->/g, '');
    const widths = (html: string) => [...html.matchAll(/width:\s*([0-9.]+)%/g)].map((m) => Number(m[1]));

    it.each([
        ['valid', { totalBundlesSold: 6, bundleGoal: 20 }, '6 of 20 bundles'],
        ['missing goal → the owner-set default goal (FR-GOAL-CONFIG-1), not "null"', { totalBundlesSold: 6, bundleGoal: null }, '6 of 20 bundles'],
        ['zero goal', { totalBundlesSold: 6, bundleGoal: 0 }, '6 of 20 bundles'],
        ['invalid goal', { totalBundlesSold: 6, bundleGoal: 'abc' }, '6 of 20 bundles'],
        ['infinite goal', { totalBundlesSold: 6, bundleGoal: Infinity }, '6 of 20 bundles'],
        ['no sales', { totalBundlesSold: 0, bundleGoal: 20 }, '0 of 20 bundles'],
        ['NaN sales', { totalBundlesSold: NaN, bundleGoal: 20 }, '0 of 20 bundles'],
        ['partial, half bundles', { totalBundlesSold: 7.5, bundleGoal: 20 }, '7.5 of 20 bundles'],
        ['exactly the goal', { totalBundlesSold: 20, bundleGoal: 20 }, '20 of 20 bundles'],
        ['over the goal', { totalBundlesSold: 25, bundleGoal: 20 }, '25 of 20 bundles'],
        ['no progress object at all', undefined, '0 of 20 bundles'],
    ])('5a. %s', (_label, progress, line) => {
        const html = render(progress);
        expect(html).toContain(line);
        expect(html).not.toMatch(/null|NaN|Infinity|undefined/);
        for (const w of widths(html)) { expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(100); }
    });

    it('5b. over the goal: actual achievement is shown while the bar stays contained, and the copy says reached', () => {
        const html = render({ totalBundlesSold: 25, bundleGoal: 20 });
        expect(html).toContain('Goal reached');
        expect(html).toMatch(/aria-valuenow="100"/);
    });

    it('5c. canonical weighting is untouched: serves 5 = 1, serves 2 = 0.5 (fundraiserMetrics is not modified)', () => {
        const { computeBundleUnitsFromItems } = require('@/lib/fundraiserMetrics');
        expect(computeBundleUnitsFromItems([{ quantity: 3, variant_size: 'serves_5' }, { quantity: 4, variant_size: 'serves_2' }])).toBe(5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PUBLIC PAYLOADS ARE INCLUDE-LISTS
// ═════════════════════════════════════════════════════════════════════════════
describe('6. public data minimization', () => {
    it('6a. the supporter page payload carries no tenant internals, no stock/sku, no dollar sales, no reason codes', async () => {
        usePrisma(pageMock());
        const mod = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
        const el: any = await mod.default(pageParams());
        const p = el.props;
        expect(Object.keys(p.business).sort()).toEqual(['branding', 'bundles', 'display_name', 'logo_url', 'name', 'slug']);
        expect(Object.keys(p.business.branding).sort()).toEqual(['logo_url', 'primary_color']);
        expect(Object.keys(p.business.bundles[0]).sort()).toEqual(['description', 'id', 'image_url', 'items', 'name', 'price', 'serving_tier']);
        expect(Object.keys(p.business.bundles[0].items[0]).sort()).toEqual(['quantity', 'recipe']);
        expect(Object.keys(p.bundleProgress).sort()).toEqual(['bundleGoal', 'totalBundlesSold']);
        expect(Object.keys(p.orderMode).sort()).toEqual(['allowed', 'mode']);
        const json = JSON.stringify(p);
        for (const secret of ['SKU-INTERNAL', 'user-INTERNAL', 'cat-INTERNAL', 'PORTAL-SECRET', 'INTERNAL', '1234.56', 'America/Chicago', BIZ_ID, 'review_qr_url', 'stock_on_hand', 'totalSales', 'estimatedEarnings', 'reasonCode']) {
            expect(json).not.toContain(secret);
        }
        // and what the page needs is still there
        expect(p.business.bundles[0].price).toBe(89);
        expect(p.business.bundles[0].items[0].recipe.name).toBe('Baked Ziti');
        expect(p.bundleProgress).toEqual({ totalBundlesSold: 2, bundleGoal: 20 });
    });

    it('6b. the projections are include-lists: an unknown future column cannot leak', () => {
        const biz = toPublicSupporterBusiness({ name: 'N', display_name: null, slug: 's', logo_url: null, id: 'x', timezone: 'UTC', future_secret: 1 } as any,
            { primary_color: '#000', logo_url: null, user_id: 'u', future_secret: 1 } as any,
            [{ id: 'b', name: 'B', price: '9.50', sku: 'S', future_secret: 1, items: [{ id: 'i', recipe_id: 'r', quantity: '2', recipe: { name: 'R', secret: 1 } }] }] as any);
        const json = JSON.stringify(biz);
        expect(json).not.toMatch(/future_secret|"secret"|user_id|"sku"|recipe_id|timezone/);
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_FIELDS.business) expect(biz).not.toHaveProperty(f);
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_FIELDS.branding) expect(biz.branding).not.toHaveProperty(f);
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_FIELDS.bundle) expect(biz.bundles[0]).not.toHaveProperty(f);
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_FIELDS.item) expect(biz.bundles[0].items[0]).not.toHaveProperty(f);
        expect(biz.bundles[0].price).toBe(9.5);
        const prog = toPublicBundleProgress({ totalBundlesSold: 3, bundleGoal: 20, totalSales: 99, estimatedEarnings: 1, raisedAmount: 2, progressPercent: 15 } as any);
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_FIELDS.progress) expect(prog).not.toHaveProperty(f);
        const mode = toPublicOrderMode({ allowed: false, mode: 'closed', reasonCode: 'deadline_passed', safeMessage: 'Closed.', activeOrderableBundleIds: ['b'] });
        expect(mode).toEqual({ allowed: false, mode: 'closed', safeMessage: 'Closed.' });
    });

    it('6c. the public scoreboard API returns only what the scoreboard renders — no dollar sales, no per-supporter totals, names masked', async () => {
        const mock = usePrisma(createPrismaMock({
            results: {
                'fundraiserCampaign.findUnique': {
                    // as if a broad row came back — the response must still be the include-list
                    id: 'camp-INTERNAL', name: 'Fixture Fundraiser', status: 'Active', total_sales: '1234.56', goal_amount: null,
                    start_date: new Date(), end_date: new Date(), delivery_date: null, pickup_location: 'Fixture Gym',
                    bundle_goal: 20, bundle_selection_status: 'not_required', about_text: 'About', mission_text: null,
                    payment_instructions: 'Pay by check', external_payment_link: null, portal_token: 'PORTAL-SECRET', public_token: 'pub',
                    customer: { name: ORG, contact_email: 'internal@example.test' },
                    orders: [{ id: 'o-INTERNAL', customer_name: 'Ada Fixturely', total_amount: '89.00', email: SUPPORTER.email, created_at: new Date('2026-11-01T15:00:00Z'), items: [{ quantity: 2, variant_size: 'serves_2' }] }],
                },
            },
        }));
        const { GET } = await import('@/app/api/fundraiser/[token]/route');
        const res = await GET(new Request('http://localhost/api/fundraiser/pub') as any, { params: Promise.resolve({ token: 'pub' }) } as any);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual([...PUBLIC_SCOREBOARD_FIELDS, 'customer', 'orders'].sort());
        for (const f of FORBIDDEN_PUBLIC_SCOREBOARD_FIELDS) expect(body).not.toHaveProperty(f);
        for (const f of FORBIDDEN_PUBLIC_SCOREBOARD_ORDER_FIELDS) expect(body.orders[0]).not.toHaveProperty(f);
        expect(body.customer).toEqual({ name: ORG });
        expect(body.orders[0].customer_name).toBe('Ada F.');
        expect(JSON.stringify(body)).not.toMatch(/1234\.56|89\.00|PORTAL-SECRET|example\.test|INTERNAL/);
        // and the QUERY itself no longer asks for them
        const select = mock.firstCall('fundraiserCampaign.findUnique')!.args.select;
        for (const f of ['status', 'total_sales', 'goal_amount', 'start_date', 'end_date', 'id']) expect(select).not.toHaveProperty(f);
        expect(select.orders.select).not.toHaveProperty('total_amount');
        expect(toPublicScoreboard(null, () => null)).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. THE SCOREBOARD POINTS AT THE FUNDRAISER
// ═════════════════════════════════════════════════════════════════════════════
describe('7. scoreboard: truthful preview, canonical shares, no dead end', () => {
    const scoreRow = { id: CAMPAIGN_ID, name: `${ORG} Fundraiser`, public_token: 'pub-tok', customer: { name: ORG, business: { slug: SLUG, custom_domain: DOMAIN } } };

    it('7a. no "$null goal" — the preview text is goal-free and truthful, and og:url is the canonical ordering page', async () => {
        usePrisma(createPrismaMock({ results: { 'fundraiserCampaign.findUnique': scoreRow } }));
        const { generateMetadata } = await import('@/app/fundraiser/[token]/page');
        const meta: any = await generateMetadata({ params: Promise.resolve({ token: 'pub-tok' }) }, {} as any);
        expect(meta.description).not.toMatch(/\$|null|undefined/);
        expect(meta.openGraph.url).toBe(CANONICAL);
        expect(meta.alternates.canonical).toBe(CANONICAL);
        expect(meta.openGraph.images).toEqual([`https://${DOMAIN}/freezer-chef-logo.png`]);
        expect(JSON.stringify(meta)).not.toMatch(/fundraiser-og-default/);
    });

    it('7b. the scoreboard client is handed the canonical URL, and shares and links with it', async () => {
        usePrisma(createPrismaMock({ results: { 'fundraiserCampaign.findUnique': scoreRow } }));
        const mod = await import('@/app/fundraiser/[token]/page');
        const el: any = await mod.default({ params: Promise.resolve({ token: 'pub-tok' }) });
        expect(el.props.shareUrl).toBe(CANONICAL);
        const src = strip(read('app/fundraiser/[token]/ScoreboardClient.tsx'));
        expect(src).not.toMatch(/window\.location/);
        expect(src).toMatch(/openFacebookShare\(window, shareUrl\)/);
        expect(src).toMatch(/copyShareText\([^)]*, shareUrl\)/);
        expect(src).toMatch(/Support us here: \$\{shareUrl\}/);
        expect(src).toMatch(/href=\{shareUrl\}/);                    // the order link: no dead end
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. LAYOUT: THE ORDER CTA STAYS PRIMARY
// ═════════════════════════════════════════════════════════════════════════════
describe('8. the pre-order share never displaces or outranks the order button', () => {
    it('8a. one order button, and the share card comes AFTER it', () => {
        const m = mountComponent(loadClient(), clientProps());
        const order = byText(m.tree, /^Place my order/);
        expect(order).toHaveLength(1);
        const all: any[] = [];
        const { walk } = require('./helpers/hookRuntime');
        walk(m.tree, (el: any) => all.push(el));
        expect(all.indexOf(order[0])).toBeLessThan(all.indexOf(one(m.tree, 'Share this fundraiser')));
    });

    it('8b. the order button keeps the filled brand colour; the share button is the quiet secondary style', () => {
        const m = mountComponent(loadClient(), clientProps());
        expect(byText(m.tree, /^Place my order/)[0].props.style.background).toBe(PRIMARY);
        const share = one(m.tree, 'Share this fundraiser');
        expect(share.props.style.background).not.toBe(PRIMARY);
        expect(share.props.style.minHeight).toBeGreaterThanOrEqual(44);           // tappable
    });

    it('8c. no pre-order share where ordering is not open, and none in sample mode (no real URL to share)', () => {
        for (const over of [{ orderMode: { allowed: false, mode: 'closed', safeMessage: 'Closed.' } }, { orderMode: { allowed: false, mode: 'pending' } }, { shareUrl: null, sampleMode: true }]) {
            const m = mountComponent(loadClient(), clientProps(over));
            expect(byLabel(m.tree, 'Share this fundraiser')).toHaveLength(0);
        }
    });

    it('8d. long names wrap and the options grid cannot force horizontal overflow', () => {
        const src = read(CLIENT_PATH);
        const section = src.slice(src.indexOf('PRE-ORDER SHARE'), src.indexOf('{/* ── Fundraiser details'));
        expect(section).toMatch(/overflowWrap: 'anywhere'/);
        const panel = src.slice(src.indexOf('function SupporterShareOptions'));
        expect(panel).toMatch(/gridTemplateColumns: 'repeat\(auto-fit, minmax\(7rem, 1fr\)\)'/);
        expect(panel).toMatch(/overflowWrap: 'anywhere'/);
        expect(src).toMatch(/minWidth: 0,\s*cursor: 'pointer'/);                 // shareSecondaryBtn
    });

    it('8e. every new control is a real button with an accessible name, and status is announced', () => {
        const m = mountComponent(loadClient(), clientProps());
        const share = one(m.tree, 'Share this fundraiser');
        expect(share.type).toBe('button');
        const src = read(CLIENT_PATH);
        const section = src.slice(src.indexOf('PRE-ORDER SHARE'), src.indexOf('{/* ── Fundraiser details'));
        expect(section).toMatch(/aria-live="polite"/);
        expect(section).not.toMatch(/<div[^>]*onClick/);
    });
});
