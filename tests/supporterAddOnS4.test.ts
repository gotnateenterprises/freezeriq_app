/**
 * FR-SUPPORTER-ADDON-UPSELL-1 — S4: the PUBLIC supporter add-on card (owner-approved 2026-11-24).
 *
 * The REAL FundraiserClient is driven without a DOM (tests/helpers/hookRuntime): meals are added, the
 * inline "Complete your meals" card appears, is declined / reopened / added, the add-on line's steppers
 * run, the last meal is removed, an order is submitted and the server's 409 is handled. The REAL page.tsx
 * data path runs against a Prisma double. The S3 FundraiserClient (b867ddf) is rendered beside the S4 one
 * to prove a campaign with no add-on renders byte-for-byte as before. All data is fictional.
 *
 *  A. lib/supporterAddOnOffer — the offer state machine and its copy
 *  B. the public payload — page.tsx + lib/publicCampaignAddOn.ts (what crosses, and when nothing does)
 *  C. the inline card — when it shows, decline, reconsider, add, quantity, remove, last-meal removal
 *  D. the add-on detail — same dialog in its add-on mode; no serving size; focus and keyboard
 *  E. totals, tax and goal — subtotal / tax / total include the add-on; the goal never counts it
 *  F. a stale add-on (409 ADDON_CHANGED) — add-on out, meals kept, nothing placed
 *  G. boundaries — server rules, storefront, coordinator, consent, S3 labels, schema
 *  H. golden — no add-on: identical to S3
 *  I. narrow phones — no fixed widths, everything wraps, 44px targets
 *  J. the tenant's per-fundraiser "show the share %" toggle
 *  K. S3 gap re-audit — the Manual Planner's add-on labels (B) and the packet tracker (A)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mountComponent, findAll, textOf } from './helpers/hookRuntime';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import {
    ADD_ON_NO_LONGER_AVAILABLE_MESSAGE,
    ADD_ON_OFFER_EYEBROW,
    ADD_ON_OFFER_FOOTER,
    ADD_ON_OFFER_HEADING,
    ADD_ON_OFFER_LEAD,
    addOnOfferCta,
    INITIAL_ADD_ON_OFFER,
    addOnOfferBody,
    addOnOfferView,
    addOnQuantityInOrder,
    addOnRemovedWithLastMealMessage,
    addOnSupportLine,
    reduceAddOnOffer,
    type AddOnOfferEvent,
    type AddOnOfferState,
} from '@/lib/supporterAddOnOffer';
import {
    FORBIDDEN_PUBLIC_SUPPORTER_ADDON_FIELDS,
    PUBLIC_SUPPORTER_ADDON_FIELDS,
    PUBLIC_SUPPORTER_BUNDLE_FIELDS,
    PUBLIC_SUPPORTER_RECIPE_FIELDS,
} from '@/lib/publicFundraiserPayload';
import { publicAddOnSupportPercent } from '@/lib/campaignAddOnShare';
import { classifyFundraiserOrderLines, loadCampaignAddOnAuthority, type OrderBundleFact } from '@/lib/campaignAddOns';
import { computeBundleUnitsFromItems } from '@/lib/fundraiserMetrics';
import { computeSupporterOrderTax } from '@/lib/fundraiserTax';
import { formatOrderLine, orderLineSizeLabel, partitionOrderLines } from '@/lib/orderLineDisplay';
import { annotateAssemblyTasks, assemblyRowServingLabel, classifyPlanAssemblyRows } from '@/lib/planAddOnRows';
import { SUPPORTER_ADDON_CARD_CSS } from '@/components/fundraiser/SupporterAddOnCard';

jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ao4Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__ao4Session ?? null) }));
// The REAL house focus hook, with what the page tells it recorded (its effects cannot run without a DOM).
jest.mock('@/components/crm2/useDialogFocus', () => {
    const actual = jest.requireActual('@/components/crm2/useDialogFocus');
    return { useDialogFocus: (open: boolean, reKey?: unknown) => { (global as any).__ao4Focus = { open, reKey }; return actual.useDialogFocus(open, reKey); } };
});

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const S3_HEAD = 'b867ddf';
const CLIENT_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const DETAIL_PATH = 'components/fundraiser/SupporterBundleDetail.tsx';
const CARD_PATH = 'components/fundraiser/SupporterAddOnCard.tsx';

// ── fictional fixtures ─────────────────────────────────────────────────────────────────────────────
const BIZ_ID = 'biz-ao4-fixture';
const SLUG = 'maple-row-kitchen-fixture';
const CAMPAIGN_ID = 'aaaa4444-0000-4000-8000-0000000000a4';
const ORG = 'Willow Creek Robotics Club (fixture)';
const PRIMARY = '#2f6d7d';
const IMG = (n: string) => `https://images.example.test/${n}.png`;
const S5_NAME = 'Comfort Classics Bundle (fixture)';
const S2_NAME = 'Comfort Classics Bundle (Serves 2) (fixture)';
const ADDON_NAME = 'Sides & Dessert Bundle';

const meals = (names: string[]) => names.map((name) => ({ quantity: 1, recipe: { name, description: `${name} — fixture description.`, image_url: null, cook_time: null, allergens: null, macros: null } }));
const bundleS5 = { id: 'b-s5', name: S5_NAME, description: null, serving_tier: 'family', price: 125, image_url: IMG('s5'), items: meals(['Lemon Herb Chicken', 'Beef Stew']) };
const bundleS2 = { id: 'b-s2', name: S2_NAME, description: null, serving_tier: 'serves_2', price: 60, image_url: IMG('s2'), items: meals(['Lemon Herb Chicken (Serves 2)', 'Beef Stew (Serves 2)']) };
/** The add-on as the server projects it (lib/publicFundraiserPayload.toPublicSupporterAddOn). Meals deliberately NOT alphabetical. */
const ADDON = {
    id: 'b-addon', name: ADDON_NAME, description: 'Two sides and a dessert to round out the week (fixture).', image_url: IMG('addon'), price: 25,
    items: meals(['Garlic Green Beans', 'Brown Butter Cornbread', 'Salted Caramel Brownies']),
    supportPercent: null as number | null,
};

const clientProps = (over: any = {}) => ({
    business: { name: 'Maple Row Kitchen (fixture)', display_name: null, slug: SLUG, logo_url: null, branding: { primary_color: PRIMARY, logo_url: null }, bundles: [bundleS5, bundleS2] },
    campaign: {
        id: CAMPAIGN_ID, name: `${ORG} Fundraiser`, organization_name: ORG, about_text: null, participant_label: 'Member',
        end_date: '2026-12-20', delivery_date: '2027-01-08', pickup_location: 'Fixture Gym', delivery_time: null,
        payment_instructions: 'Pay the coordinator by check (fixture)', external_payment_link: null, tax_status: null, tax_rate_percent: null,
        payment_methods: null, customer_fundraiser_info: { delivery_date: null, delivery_time: null, pickup_location: null },
        ...(over.campaign || {}),
    },
    bundleProgress: { totalBundlesSold: 4, bundleGoal: 20 },
    orderMode: { allowed: true, mode: 'selected' },
    slug: SLUG,
    fundraiserId: CAMPAIGN_ID,
    shareUrl: `https://www.freezeriqapp.com/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`,
    deadline: { kind: 'days', days: 26 },
    addOn: ADDON,
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'campaign')),
});

// ── browser doubles ────────────────────────────────────────────────────────────────────────────────
let fetchMock: jest.Mock;
let responses: Array<{ ok: boolean; status?: number; body: any }> = [];
function installBrowser() {
    const win = { open: jest.fn(), location: { href: 'https://example.test/', hostname: 'example.test' }, scrollTo: jest.fn() };
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: win });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: jest.fn(async () => undefined) } } });
    fetchMock = jest.fn(async () => {
        const r = responses.shift() ?? { ok: true, status: 200, body: { orderId: 'ord-ao4-0001', total: 0, paymentData: { orgName: ORG } } };
        return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.body };
    });
    (globalThis as any).fetch = fetchMock;
}
beforeEach(() => { responses = []; installBrowser(); });
beforeAll(() => { for (const k of ['log', 'warn', 'error', 'info'] as const) jest.spyOn(console, k).mockImplementation(() => undefined); });

const loadClient = () => require('@/app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient').default;
const mount = (over: any = {}) => mountComponent(loadClient(), clientProps(over));
type M = ReturnType<typeof mount>;
const btn = (tree: any, re: RegExp) => findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)));
const byLabel = (tree: any, label: string) => findAll(tree, (el) => el.type === 'button' && el.props['aria-label'] === label)[0];
const click = (m: M, el: any) => { if (!el) throw new Error('nothing to click'); el.props.onClick({ stopPropagation: () => undefined }); return m.render(); };
const cardOf = (tree: any) => findAll(tree, (el) => el.props && el.props['data-addon-offer'] === 'card')[0] ?? null;
const quietOf = (tree: any) => findAll(tree, (el) => el.props && el.props['data-addon-offer'] === 'quiet')[0] ?? null;
const lineOf = (tree: any) => findAll(tree, (el) => el.props && el.props['data-addon-line'] === 'true')[0] ?? null;
const noticeOf = (tree: any) => findAll(tree, (el) => el.props && el.props['data-addon-notice'] === 'true')[0] ?? null;
const dialogOf = (tree: any) => findAll(tree, (el) => el.props && el.props.role === 'dialog')[0] ?? null;
const orderHeading = (tree: any) => textOf(findAll(tree, (el) => el.type === 'b' && /^Your order/.test(textOf(el.props.children)))[0]);
const inputByLabel = (tree: any, label: string) => findAll(tree, (el) => el.type === 'input' && el.props['aria-label'] === label)[0];
const addMeal = (m: M, b: any) => click(m, byLabel(m.tree, `Add ${b.name} to your order`));
const removeMeal = (m: M, b: any) => click(m, byLabel(m.tree, `Remove ${b.name}`));
const addOnFromCard = (m: M) => click(m, btn(cardOf(m.tree), /^Yes! Add to My Order/)[0]);
const html = (tree: any) => renderToStaticMarkup(tree).replace(/<!-- -->/g, '');
const lastBody = () => JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
async function fillContactAndSubmit(m: M) {
    for (const [label, value] of [['First Name', 'Rory'], ['Last Name', 'Fixturely'], ['Email', 'rory.fixture@example.test'], ['Phone Number', '555-0144']]) {
        inputByLabel(m.tree, label).props.onChange({ target: { value } }); m.render();
    }
    await btn(m.tree, /^Place my order/)[0].props.onClick(); m.render();
}
const FORBIDDEN_WORDS = /\bfree\b|\bbonus\b|discount|full bundle|Family Size|Serves 5|serves 5/i;

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('A. the offer state machine (lib/supporterAddOnOffer.ts)', () => {
    const run = (events: AddOnOfferEvent[], from: AddOnOfferState = INITIAL_ADD_ON_OFFER) => events.reduce(reduceAddOnOffer, from);
    const view = (s: AddOnOfferState, mainLineCount: number, hasAddOn = true) => addOnOfferView(s, { hasAddOn, mainLineCount });
    const meals = (n: number): AddOnOfferEvent => ({ type: 'mainLinesChanged', mainLineCount: n, addOnName: ADDON_NAME });

    it('A1. no add-on → hidden whatever the basket; add-on + no meal → hidden; add-on + a meal → the full card', () => {
        expect(view(INITIAL_ADD_ON_OFFER, 3, false)).toBe('hidden');
        expect(view(INITIAL_ADD_ON_OFFER, 0)).toBe('hidden');
        expect(view(INITIAL_ADD_ON_OFFER, 1)).toBe('card');
    });

    it('A2. "No thanks" → a quiet link that no later basket change re-opens', () => {
        let s = run([meals(1), { type: 'decline' }]);
        expect(view(s, 1)).toBe('quiet');
        for (const n of [2, 3, 1, 0, 1, 4]) { s = reduceAddOnOffer(s, meals(n)); if (n > 0) expect(view(s, n)).toBe('quiet'); }
    });

    it('A3. the quiet link re-opens; add → in order; + / − change the quantity; − to 0 → removed → quiet', () => {
        let s = run([{ type: 'decline' }, { type: 'reopen' }]);
        expect(view(s, 1)).toBe('card');
        s = run([{ type: 'add' }], s);
        expect([view(s, 1), s.quantity]).toEqual(['inOrder', 1]);
        s = run([{ type: 'increase' }, { type: 'increase' }], s);
        expect(s.quantity).toBe(3);
        s = run([{ type: 'decrease' }, { type: 'decrease' }, { type: 'decrease' }], s);
        expect([s.quantity, s.interaction, view(s, 1)]).toEqual([0, 'removed', 'quiet']);
    });

    it('A4. remove → quiet link only, never the full card again', () => {
        const s = run([{ type: 'add' }, { type: 'remove' }]);
        expect(view(s, 1)).toBe('quiet');
        expect(view(run([meals(2)], s), 2)).toBe('quiet');
    });

    it('A5. the last meal leaving takes the add-on with it, with an explanation; a meal back → quiet link, explanation cleared', () => {
        let s = run([{ type: 'add' }, { type: 'increase' }, meals(0)]);
        expect([s.quantity, view(s, 0)]).toEqual([0, 'hidden']);
        expect(s.notice).toBe(addOnRemovedWithLastMealMessage(ADDON_NAME));
        expect(s.notice).toBe('We removed the Sides & Dessert Bundle — it can only be ordered with a meal bundle.');
        s = run([meals(1)], s);
        expect([view(s, 1), s.notice]).toEqual(['quiet', null]);
    });

    it('A6. presented automatically ONCE per session: meals out and back in without a choice → the quiet link only', () => {
        const s = run([meals(1), meals(0), meals(1)]);
        expect(s.interaction).toBe('shown');
        expect(view(s, 1)).toBe('quiet');
        expect(s.notice).toBeNull();
        // quantity changes while it is first showing do not use up the presentation
        expect(view(run([meals(1), meals(2), meals(1)]), 1)).toBe('card');
        // a card re-opened from the quiet link does not come back by itself after the basket empties
        const r = run([meals(1), { type: 'decline' }, { type: 'reopen' }, meals(0), meals(1)]);
        expect(view(r, 1)).toBe('quiet');
    });

    it('A7. a 409 ADDON_CHANGED hides the offer for the session; add / reopen are ignored after it', () => {
        let s = run([{ type: 'add' }, { type: 'serverRejected' }]);
        expect([s.quantity, s.unavailable, view(s, 1)]).toEqual([0, true, 'hidden']);
        s = run([{ type: 'add' }, { type: 'reopen' }, { type: 'increase' }], s);
        expect([s.quantity, view(s, 2)]).toEqual([0, 'hidden']);
    });

    it('A8. the add-on can never enter an order without a meal line, whatever the state says', () => {
        const s = { ...INITIAL_ADD_ON_OFFER, quantity: 4, interaction: 'added' as const };
        expect(addOnQuantityInOrder(s, { hasAddOn: true, mainLineCount: 0 })).toBe(0);
        expect(addOnQuantityInOrder(s, { hasAddOn: false, mainLineCount: 2 })).toBe(0);
        expect(addOnQuantityInOrder(s, { hasAddOn: true, mainLineCount: 1 })).toBe(4);
    });

    it('A9. copy is the owner\'s approved wording (2026-11-24), filled from the campaign; no forbidden words', () => {
        expect(ADD_ON_OFFER_EYEBROW).toBe('Exclusive add-on offer');
        expect(ADD_ON_OFFER_HEADING).toBe('Make your meals even more delicious!');
        expect(ADD_ON_OFFER_LEAD).toBe('Great meals deserve delicious sides and a little something sweet!');
        expect(addOnOfferBody(ADDON_NAME, ORG)).toBe(`With your meal bundle purchase, you unlock the opportunity to add our Sides & Dessert Bundle — making mealtime even easier while helping ${ORG} raise even more.`);
        expect(addOnOfferBody('Holiday Pie Box', 'Pine Ridge Band (fixture)')).toBe('With your meal bundle purchase, you unlock the opportunity to add our Holiday Pie Box — making mealtime even easier while helping Pine Ridge Band (fixture) raise even more.');
        expect(addOnOfferCta(25)).toBe('Yes! Add to My Order · $25.00');
        expect(addOnOfferCta('31.5')).toBe('Yes! Add to My Order · $31.50');
        expect(ADD_ON_OFFER_FOOTER).toBe('Available exclusively with a meal bundle purchase.');
        for (const c of [ADD_ON_OFFER_EYEBROW, ADD_ON_OFFER_HEADING, ADD_ON_OFFER_LEAD, ADD_ON_OFFER_FOOTER, addOnOfferCta(25)]) expect(c).not.toMatch(FORBIDDEN_WORDS);
        expect(addOnSupportLine(ORG, 10)).toBe(`Your purchase also helps ${ORG} earn 10% on this add-on.`);
        expect(addOnSupportLine(ORG, 12.5)).toBe(`Your purchase also helps ${ORG} earn 12.5% on this add-on.`);
        for (const v of [null, undefined, 0, -5, NaN, '10']) expect(addOnSupportLine(ORG, v)).toBeNull();
        for (const t of [ADD_ON_OFFER_HEADING, addOnOfferBody(ADDON_NAME, ORG), addOnSupportLine(ORG, 10)!, ADD_ON_NO_LONGER_AVAILABLE_MESSAGE, addOnRemovedWithLastMealMessage(ADDON_NAME)]) {
            expect(t).not.toMatch(FORBIDDEN_WORDS);
        }
        expect(ADD_ON_NO_LONGER_AVAILABLE_MESSAGE).toBe('That add-on is no longer available. Your meal bundle selections are still in your order.');
    });

    it('A10. the state module is pure: no React, no fetch, no storage, no sizes', () => {
        const src = R('lib/supporterAddOnOffer.ts');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/^import /m);
        expect(code).not.toMatch(/useState|fetch\(|localStorage|sessionStorage|serving_tier|serves_5|variant_size/);
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('B. the public payload (page.tsx + lib/publicCampaignAddOn.ts)', () => {
    type Row = Record<string, any>;
    const BUNDLE_ROWS: Row[] = [
        { id: 'b-s5', name: S5_NAME, sku: 'SKU-INTERNAL-5', description: null, serving_tier: 'family', price: '125.00', business_id: BIZ_ID, image_url: IMG('s5'), stock_on_hand: '42', is_active: true, show_on_storefront: true, catalog_id: null, family_id: 'fam-INTERNAL', is_surplus: false, order_cutoff_date: null },
        { id: 'b-s2', name: S2_NAME, sku: 'SKU-INTERNAL-2', description: null, serving_tier: 'serves_2', price: '60.00', business_id: BIZ_ID, image_url: IMG('s2'), stock_on_hand: '7', is_active: true, show_on_storefront: true, catalog_id: null, family_id: 'fam-INTERNAL', is_surplus: false, order_cutoff_date: null },
    ];
    const addOnBundle = (over: Row = {}): Row => ({
        id: 'b-addon', name: ADDON_NAME, description: ADDON.description, image_url: IMG('addon'), price: '25.00',
        business_id: BIZ_ID, is_active: true, bundle_type: 'addon',
        contents: ADDON.items.map((i) => ({ quantity: 1, recipe: { ...i.recipe } })),
        ...over,
    });
    const assignment = (over: Row = {}, bundleOver: Row = {}): Row => ({
        business_id: BIZ_ID, bundle_id: 'b-addon', show_share_percent: false,
        bundle: addOnBundle(bundleOver),
        share_tiers: [{ starting_quantity: 1, percent: '10.00' }, { starting_quantity: 11, percent: '15.00' }],
        ...over,
    });
    function pageMock(opts: { campaign?: Row; addOn?: Row | null | (() => any) } = {}): PrismaMock {
        const business = { id: BIZ_ID, name: 'Maple Row Kitchen (fixture)', display_name: null, slug: SLUG, logo_url: null, timezone: 'America/Chicago', custom_domain: null };
        const campaignRow = {
            id: CAMPAIGN_ID, name: `${ORG} Fundraiser`, about_text: null, participant_label: null,
            end_date: new Date('2099-01-01T00:00:00.000Z'), delivery_date: null, pickup_location: null, delivery_time: null,
            payment_instructions: null, external_payment_link: null, payment_methods: null, checks_payable: null, bundle_goal: 20, total_sales: '0',
            status: 'Active', closed_at: null, tax_status: null, tax_rate_percent: null,
            bundle_selection_status: 'selected', bundle_selection_limit: 1,
            organization_name: ORG, customer_fundraiser_info: {}, portal_token: 'PORTAL-SECRET',
            ...(opts.campaign || {}),
        };
        return createPrismaMock({
            results: {
                'business.findUnique': business,
                'campaignBundle.findMany': [
                    { bundle: { id: 'b-s5', business_id: BIZ_ID, is_active: true, family_id: 'fam-INTERNAL', serving_tier: 'family' } },
                    { bundle: { id: 'b-s2', business_id: BIZ_ID, is_active: true, family_id: 'fam-INTERNAL', serving_tier: 'serves_2' } },
                ],
                'campaignAddOn.findUnique': typeof opts.addOn === 'function' ? opts.addOn : () => (opts.addOn === undefined ? null : opts.addOn),
                $queryRaw: ({ sql, values }: { sql: string; values: any[] }) => {
                    const flat = values.reduce((acc: any[], v: any) => acc.concat(v && typeof v === 'object' && Array.isArray(v.values) ? v.values : Array.isArray(v) ? v : [v]), []);
                    if (/FROM tenant_branding/.test(sql)) return [{ id: 7, user_id: 'user-INTERNAL', primary_color: PRIMARY, logo_url: null }];
                    if (/FROM fundraiser_campaigns fc/.test(sql)) return [campaignRow];
                    if (/FROM orders o/.test(sql)) return [];
                    if (/FROM bundle_contents bc/.test(sql)) return [];
                    if (/FROM bundles/.test(sql)) return BUNDLE_ROWS.filter((r) => flat.includes(r.id));
                    return [];
                },
            },
        });
    }
    const renderPage = async (opts: Parameters<typeof pageMock>[0] = {}) => {
        const mock = pageMock(opts);
        (global as any).__ao4Prisma = mock.client;
        const mod = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
        const el: any = await mod.default({ params: Promise.resolve({ slug: SLUG, fundraiserId: CAMPAIGN_ID }) });
        return { props: el.props, mock };
    };

    it('B1. (1) no assignment → addOn is null, and the page props are otherwise unchanged', async () => {
        const { props } = await renderPage({ addOn: null });
        expect(props.addOn).toBeNull();
        expect(Object.keys(props).sort()).toEqual(['addOn', 'bundleProgress', 'business', 'campaign', 'deadline', 'fundraiserId', 'orderMode', 'shareUrl', 'slug']);
    });

    it('B2. a valid add-on crosses as exactly the public include-list; meals in saved order; price a number', async () => {
        const { props, mock } = await renderPage({ addOn: assignment() });
        expect(Object.keys(props.addOn).sort()).toEqual(['description', 'id', 'image_url', 'items', 'name', 'price', 'supportPercent']);
        expect(props.addOn).toMatchObject({ id: 'b-addon', name: ADDON_NAME, description: ADDON.description, image_url: IMG('addon'), price: 25, supportPercent: null });
        expect(props.addOn.items.map((i: any) => i.recipe.name)).toEqual(['Garlic Green Beans', 'Brown Butter Cornbread', 'Salted Caramel Brownies']);
        for (const i of props.addOn.items) expect(Object.keys(i.recipe).sort()).toEqual([...PUBLIC_SUPPORTER_RECIPE_FIELDS].sort());
        const call = mock.firstCall('campaignAddOn.findUnique')!;
        expect(call.args.where).toEqual({ campaign_id: CAMPAIGN_ID });
        expect(call.args.select.bundle.select.contents.orderBy).toEqual({ position: { sort: 'asc', nulls: 'last' } });
    });

    it.each([
        ['another tenant\'s assignment', { business_id: 'biz-OTHER' }, {}],
        ['another tenant\'s bundle', {}, { business_id: 'biz-OTHER' }],
        ['an inactive bundle', {}, { is_active: false }],
        ['a bundle no longer typed add-on', {}, { bundle_type: 'meal' }],
        ['no price', {}, { price: null }],
        ['a $0 price', {}, { price: '0.00' }],
        ['no contents', {}, { contents: [] }],
        ['contents without a real meal name', {}, { contents: [{ quantity: 1, recipe: { name: '  ' } }, { quantity: 1, recipe: { name: 'null' } }] }],
        ['a mismatched bundle id', { bundle_id: 'b-elsewhere' }, {}],
    ])('B3. %s → no add-on reaches the page', async (_label, over, bundleOver) => {
        const { props } = await renderPage({ addOn: assignment(over as Row, bundleOver as Row) });
        expect(props.addOn).toBeNull();
    });

    it.each([
        ['closed', { status: 'Closed', closed_at: new Date('2026-11-01T00:00:00Z') }],
        ['past its deadline', { end_date: new Date('2020-01-01T00:00:00Z') }],
        ['bundle selection pending', { bundle_selection_status: 'pending' }],
    ])('B4. a campaign that is not orderable (%s) never even looks the add-on up', async (_l, campaign) => {
        const { props, mock } = await renderPage({ campaign, addOn: assignment() });
        expect(props.addOn).toBeNull();
        expect(mock.callsTo('campaignAddOn.findUnique')).toHaveLength(0);
    });

    it('B5. (35) the page never receives tier configuration: tiered + toggle on → no percent; nothing internal in the JSON', async () => {
        const { props } = await renderPage({ addOn: assignment({ show_share_percent: true }) });
        expect(props.addOn.supportPercent).toBeNull();
        const json = JSON.stringify(props.addOn);
        for (const secret of ['starting_quantity', 'share_tiers', '15', 'show_share_percent', 'serving_tier', 'bundle_type', 'is_active', 'business_id', BIZ_ID, 'sku', 'stock']) {
            expect(json).not.toContain(secret);
        }
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_ADDON_FIELDS) expect(props.addOn).not.toHaveProperty(f);
    });

    it('B6. single tier: the percent crosses only when the tenant turned the toggle on', async () => {
        const one = [{ starting_quantity: 1, percent: '10.00' }];
        expect((await renderPage({ addOn: assignment({ share_tiers: one, show_share_percent: false }) })).props.addOn.supportPercent).toBeNull();
        expect((await renderPage({ addOn: assignment({ share_tiers: one, show_share_percent: true }) })).props.addOn.supportPercent).toBe(10);
        expect(publicAddOnSupportPercent([{ startingQuantity: 1, percent: 10 }], true)).toBe(10);
        expect(publicAddOnSupportPercent([{ startingQuantity: 1, percent: 10 }], 'true')).toBeNull();
        expect(publicAddOnSupportPercent([{ startingQuantity: 1, percent: 0 }], true)).toBeNull();
        expect(publicAddOnSupportPercent([{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 15 }], true)).toBeNull();
        expect(publicAddOnSupportPercent([{ startingQuantity: 2, percent: 10 }], true)).toBeNull();
    });

    it('B7. a failing add-on lookup never breaks the page — it simply has no add-on', async () => {
        const { props } = await renderPage({ addOn: () => { throw new Error('database unavailable (fixture)'); } });
        expect(props.addOn).toBeNull();
        expect(props.business.bundles.map((b: any) => b.id)).toEqual(['b-s5', 'b-s2']);
    });

    it('B8. the include-lists: the add-on list has no serving tier; the meal lists are unchanged by S4', () => {
        expect([...PUBLIC_SUPPORTER_ADDON_FIELDS]).toEqual(['id', 'name', 'description', 'image_url']);
        expect([...PUBLIC_SUPPORTER_BUNDLE_FIELDS]).toEqual(['id', 'name', 'description', 'serving_tier', 'price', 'image_url']);
        expect([...PUBLIC_SUPPORTER_RECIPE_FIELDS]).toEqual(['name', 'description', 'image_url', 'cook_time', 'allergens', 'macros']);
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('C. the inline card in "Your order"', () => {
    it('C1. (1) no add-on configured → no card, no link, no notice region — empty or with meals', () => {
        const m = mount({ addOn: null });
        addMeal(m, bundleS5); addMeal(m, bundleS2);
        expect([cardOf(m.tree), quietOf(m.tree), lineOf(m.tree), noticeOf(m.tree)]).toEqual([null, null, null, null]);
        expect(html(m.tree)).not.toMatch(/Complete your meals|fr-addon|data-addon/);
    });

    it('C2. (2) add-on configured but no meal in the basket → no card', () => {
        const m = mount();
        expect(cardOf(m.tree)).toBeNull();
        expect(quietOf(m.tree)).toBeNull();
        expect(html(m.tree)).not.toMatch(/Complete your meals/);
    });

    it('C3. (3) a Serves 5 meal added → the full card, inside the order card, above the contact fields', () => {
        const m = mount();
        addMeal(m, bundleS5);
        const card = cardOf(m.tree);
        expect(card).not.toBeNull();
        expect(card.type).toBe('section');
        const t = textOf(card);
        expect(t).toContain('Exclusive add-on offer');
        expect(t).toContain('Make your meals even more delicious!');
        expect(t).toContain('Great meals deserve delicious sides and a little something sweet!');
        expect(t).toContain(`With your meal bundle purchase, you unlock the opportunity to add our ${ADDON_NAME} — making mealtime even easier while helping ${ORG} raise even more.`);
        expect(t).toContain('Available exclusively with a meal bundle purchase.');
        expect(btn(card, /^Yes! Add to My Order · \$25\.00$/)).toHaveLength(1);
        expect(btn(card, /^See what’s included$/)).toHaveLength(1);
        expect(btn(card, /^No thanks$/)).toHaveLength(1);
        const page = html(m.tree);
        expect(page.indexOf('data-addon-offer="card"')).toBeGreaterThan(page.indexOf('Your order'));
        expect(page.indexOf('data-addon-offer="card"')).toBeLessThan(page.indexOf('aria-label="First Name"'));
    });

    it('C4. (4) a Serves 2 meal alone qualifies too — card visibility never keys on Serves 5', () => {
        const m = mount();
        addMeal(m, bundleS2);
        expect(cardOf(m.tree)).not.toBeNull();
        const src = R(CLIENT_PATH);
        expect(src).toMatch(/mainLineCount: orderLines\.length/);
        expect(src).not.toMatch(/serving_tier === 'family'[^\n]*addOn|addOn[^\n]*serves_5/);
    });

    it('C5. heading semantics: the card is a <section> labelled by its <h3>', () => {
        const m = mount();
        addMeal(m, bundleS5);
        const card = cardOf(m.tree);
        const h3 = findAll(card, (el) => el.type === 'h3')[0];
        expect(card.props['aria-labelledby']).toBe(h3.props.id);
        expect(textOf(h3)).toBe('Make your meals even more delicious!');
    });

    it('C6. (11, 12) "No thanks" collapses to a quiet link; quantity changes and more meals never re-open it', () => {
        const m = mount();
        addMeal(m, bundleS5);
        click(m, btn(cardOf(m.tree), /^No thanks$/)[0]);
        expect(cardOf(m.tree)).toBeNull();
        const quietLink = btn(quietOf(m.tree), /Show add-on/)[0];
        expect(textOf(quietLink)).toBe(`+ Show add-on: ${ADDON_NAME} · $25.00`);
        // quiet: muted text, never the page's accent colour or a filled button
        expect(quietLink.props.style.color).not.toBe(PRIMARY);
        expect(quietLink.props.style.background).toBe('none');
        expect(quietLink.props.style.fontWeight).toBeLessThan(700);
        click(m, byLabel(m.tree, `Increase ${S5_NAME} quantity`));
        click(m, byLabel(m.tree, `Decrease ${S5_NAME} quantity`));
        addMeal(m, bundleS2);
        expect(cardOf(m.tree)).toBeNull();
        expect(quietOf(m.tree)).not.toBeNull();
    });

    it('C7. (13) the quiet link re-opens the full card', () => {
        const m = mount();
        addMeal(m, bundleS5);
        click(m, btn(cardOf(m.tree), /^No thanks$/)[0]);
        click(m, btn(quietOf(m.tree), /Show add-on/)[0]);
        expect(cardOf(m.tree)).not.toBeNull();
    });

    it('C8. (7, 8, 9, 10) add → an ordinary line "(Add-On)" with − / + / total / ✕; quantity > 1; remove → quiet link only', () => {
        const m = mount();
        addMeal(m, bundleS5);
        addOnFromCard(m);
        expect(cardOf(m.tree)).toBeNull();
        const line = () => lineOf(m.tree);
        expect(textOf(findAll(line(), (el) => el.type === 'b')[0])).toBe('Sides & Dessert Bundle (Add-On)');
        expect(textOf(line())).not.toMatch(/Serves|Family/);
        const inc = () => byLabel(m.tree, 'Increase Sides & Dessert Bundle (Add-On) quantity');
        const dec = () => byLabel(m.tree, 'Decrease Sides & Dessert Bundle (Add-On) quantity');
        click(m, inc()); click(m, inc());
        expect(textOf(line())).toContain('$75.00');
        click(m, dec());
        expect(textOf(line())).toContain('$50.00');
        click(m, byLabel(m.tree, 'Remove Sides & Dessert Bundle (Add-On)'));
        expect(line()).toBeNull();
        expect(cardOf(m.tree)).toBeNull();
        expect(quietOf(m.tree)).not.toBeNull();
    });

    it('C9. − from 1 also removes it, leaving only the quiet link', () => {
        const m = mount();
        addMeal(m, bundleS2);
        addOnFromCard(m);
        click(m, byLabel(m.tree, 'Decrease Sides & Dessert Bundle (Add-On) quantity'));
        expect([lineOf(m.tree), cardOf(m.tree)]).toEqual([null, null]);
        expect(quietOf(m.tree)).not.toBeNull();
    });

    it('C10. (14, 15) removing the last meal removes the add-on, with a visible, announced explanation; ordering is not possible', () => {
        const m = mount();
        addMeal(m, bundleS5);
        addOnFromCard(m);
        click(m, byLabel(m.tree, 'Increase Sides & Dessert Bundle (Add-On) quantity'));
        removeMeal(m, bundleS5);
        expect(lineOf(m.tree)).toBeNull();
        const notice = noticeOf(m.tree);
        expect(notice.props.role).toBe('status');
        expect(notice.props['aria-live']).toBe('polite');
        expect(textOf(notice)).toBe('We removed the Sides & Dessert Bundle — it can only be ordered with a meal bundle.');
        expect(notice.props.style.position).toBeUndefined();          // visible, not screen-reader-only
        expect(orderHeading(m.tree)).toBe('Your order · $0.00');
        expect(btn(m.tree, /^Place my order/)[0].props.disabled).toBe(true);
    });

    it('C11. the same happens when the last meal goes by its − stepper', () => {
        const m = mount();
        addMeal(m, bundleS2);
        addOnFromCard(m);
        click(m, byLabel(m.tree, `Decrease ${S2_NAME} quantity`));
        expect(lineOf(m.tree)).toBeNull();
        expect(textOf(noticeOf(m.tree))).toMatch(/^We removed the Sides & Dessert Bundle/);
    });

    it('C12. (16) re-adding a meal after the add-on was taken out, or after a decline, shows the quiet link only', () => {
        const m = mount();
        addMeal(m, bundleS5); addOnFromCard(m); removeMeal(m, bundleS5);
        addMeal(m, bundleS2);
        expect([cardOf(m.tree), lineOf(m.tree)]).toEqual([null, null]);
        expect(quietOf(m.tree)).not.toBeNull();
        expect(textOf(noticeOf(m.tree))).toBe('');                    // the explanation has done its job

        const d = mount();
        addMeal(d, bundleS5); click(d, btn(cardOf(d.tree), /^No thanks$/)[0]); removeMeal(d, bundleS5);
        addMeal(d, bundleS5);
        expect(cardOf(d.tree)).toBeNull();
        expect(quietOf(d.tree)).not.toBeNull();
    });

    it('C13. the card is presented automatically only once per session: meal out and back in → the quiet link, which still works', () => {
        const m = mount();
        addMeal(m, bundleS5); removeMeal(m, bundleS5); addMeal(m, bundleS2);
        expect(cardOf(m.tree)).toBeNull();
        expect(quietOf(m.tree)).not.toBeNull();
        click(m, btn(quietOf(m.tree), /Show add-on/)[0]);
        expect(cardOf(m.tree)).not.toBeNull();
    });

    it('C14. the percent line shows only when the page was given one (single tier + toggle on)', () => {
        const withPct = mount({ addOn: { ...ADDON, supportPercent: 10 } });
        addMeal(withPct, bundleS5);
        expect(textOf(cardOf(withPct.tree))).toContain(`Your purchase also helps ${ORG} earn 10% on this add-on.`);
        const without = mount();
        addMeal(without, bundleS5);
        expect(textOf(cardOf(without.tree))).not.toMatch(/%/);
    });

    it('C15. the card never says free / bonus / discount / full bundle / Family Size / Serves 5', () => {
        const m = mount({ addOn: { ...ADDON, supportPercent: 10 } });
        addMeal(m, bundleS5);
        expect(textOf(cardOf(m.tree))).not.toMatch(FORBIDDEN_WORDS);
        click(m, btn(cardOf(m.tree), /^No thanks$/)[0]);
        expect(textOf(quietOf(m.tree))).not.toMatch(FORBIDDEN_WORDS);
    });

    it('C17. the bundle name, price, image and organization come from the campaign — nothing is hard-coded', () => {
        const other = { ...ADDON, id: 'b-pie', name: 'Holiday Pie Box (fixture)', price: 31.5, image_url: IMG('pie') };
        const m = mount({ addOn: other, campaign: { organization_name: 'Pine Ridge Band (fixture)' } });
        addMeal(m, bundleS2);
        const card = cardOf(m.tree);
        const t = textOf(card);
        expect(t).toContain('add our Holiday Pie Box (fixture) — making mealtime even easier while helping Pine Ridge Band (fixture) raise even more.');
        expect(btn(card, /^Yes! Add to My Order · \$31\.50$/)).toHaveLength(1);
        expect(findAll(card, (el) => el.type === 'img')[0].props.src).toBe(IMG('pie'));
        expect(t).not.toMatch(/Sides & Dessert|\$25\.00|Willow Creek/);
        const src = (R(CARD_PATH) + R('lib/supporterAddOnOffer.ts')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // code, not comments
        expect(src).not.toMatch(/Sides & Dessert|\$25|Willow Creek|Robotics/);
    });

    it('C16. it is inline: no pop-up / dialog opens when the first meal is added', () => {
        const m = mount();
        addMeal(m, bundleS5);
        expect(dialogOf(m.tree)).toBeNull();
        expect((global as any).__ao4Focus.open).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('D. the add-on detail', () => {
    const openDetail = (m: M) => click(m, btn(cardOf(m.tree), /^See what’s included$/)[0]);

    it('D1. (5) "See what\'s included" opens the house dialog on the add-on', () => {
        const m = mount();
        addMeal(m, bundleS5);
        openDetail(m);
        const d = dialogOf(m.tree);
        expect(d.props['data-bundle-id']).toBe('b-addon');
        expect(d.props['aria-modal']).toBe('true');
        expect((global as any).__ao4Focus).toEqual({ open: true, reKey: 'b-addon' });
    });

    it('D2. (6) full image, name, price, description and the meals in saved order — no Serves label, no goal-credit wording', () => {
        const m = mount();
        addMeal(m, bundleS5);
        openDetail(m);
        const d = dialogOf(m.tree);
        const t = textOf(d);
        expect(t).toContain(ADDON_NAME);
        expect(t).toContain('$25.00');
        expect(t).toContain(ADDON.description);
        expect(t).toContain('Add-On');
        expect(t).toContain('Only available with a meal bundle in your order');
        expect(t).not.toMatch(/Serves 5|serves 5|Serves 2|serves 2|Family|Counts as|full bundle/);
        const img = findAll(d, (el) => el.type === 'img')[0];
        expect(img.props.src).toBe(IMG('addon'));
        expect(img.props.style.objectFit).toBe('contain');
        expect(img.props.alt).toBe(`${ADDON_NAME} — add-on photo`);
        const names = findAll(d, (el) => el.type === 'li').map((li) => textOf(findAll(li, (x) => x.type === 'b')[0]));
        expect(names).toEqual(['Garlic Green Beans', 'Brown Butter Cornbread', 'Salted Caramel Brownies']);
    });

    it('D3. its action reads "Add to my order · $25.00", adds the add-on and closes; reopened, it shows the steppers and Done', () => {
        const m = mount();
        addMeal(m, bundleS5);
        openDetail(m);
        const add = btn(dialogOf(m.tree), /^Add to my order/)[0];
        expect(textOf(add)).toBe('Add to my order · $25.00');
        click(m, add);
        expect(dialogOf(m.tree)).toBeNull();
        expect(lineOf(m.tree)).not.toBeNull();
        // reopen from the detail of... the add-on is now in the order; open it via its id path:
        const client = R(CLIENT_PATH);
        expect(client).toMatch(/quantityInOrder=\{addOnQty\}/);
    });

    it('D4. in the order, the detail\'s steppers are the add-on line\'s; Done closes', () => {
        const m = mount();
        addMeal(m, bundleS5);
        openDetail(m);
        click(m, btn(dialogOf(m.tree), /^Add to my order/)[0]);
        // the card is gone once added; reopen the detail through the quiet path: remove → quiet → reopen → detail → add
        click(m, byLabel(m.tree, 'Remove Sides & Dessert Bundle (Add-On)'));
        click(m, btn(quietOf(m.tree), /Show add-on/)[0]);
        openDetail(m);
        click(m, btn(dialogOf(m.tree), /^Add to my order/)[0]);
        expect(textOf(lineOf(m.tree))).toContain('$25.00');
    });

    it('D5. (34) keyboard and focus: Escape closes, the close button is named for the add-on, Tab is contained', () => {
        const m = mount();
        addMeal(m, bundleS5);
        openDetail(m);
        expect(byLabel(dialogOf(m.tree), 'Close add-on details')).toBeTruthy();
        const overlay = findAll(m.tree, (el) => el.props && el.props.className === 'fr-detail-overlay')[0];
        let stopped = false;
        overlay.props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped = true; } });
        m.render();
        expect(stopped).toBe(true);
        expect(dialogOf(m.tree)).toBeNull();
        expect((global as any).__ao4Focus.open).toBe(false);
    });

    it('D6. a meal bundle\'s detail is byte-identical to S3 (the add-on mode is opt-in)', () => {
        const S3Detail = loadS3('SupporterBundleDetail.s3.tsx', DETAIL_PATH).SupporterBundleDetail;
        const NowDetail = require('@/components/fundraiser/SupporterBundleDetail').SupporterBundleDetail;
        for (const bundle of [bundleS5, bundleS2]) for (const quantityInOrder of [0, 2]) for (const imageExpanded of [false, true]) {
            const props = { bundle, primaryColor: PRIMARY, quantityInOrder, imageExpanded, panelRef: null, onKeyDown: () => undefined, onClose: () => undefined, onAdd: () => undefined, onChangeQty: () => undefined, onToggleImage: () => undefined };
            expect(renderToStaticMarkup(createElement(NowDetail, props))).toBe(renderToStaticMarkup(createElement(S3Detail, props)));
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('E. totals, tax and the goal', () => {
    it('E1. (17, 18, 19) taxable campaign: the add-on joins the subtotal, the tax and the total — the shared tax rule', () => {
        const m = mount({ campaign: { tax_status: 'TAXABLE', tax_rate_percent: 7.5 } });
        addMeal(m, bundleS5); addOnFromCard(m);
        click(m, byLabel(m.tree, 'Increase Sides & Dessert Bundle (Add-On) quantity'));
        const expected = computeSupporterOrderTax({ subtotal: 175, snapshot: { status: 'TAXABLE', ratePercent: 7.5 } });
        expect(expected).toMatchObject({ subtotal: 175, taxApplied: true });
        const t = textOf(m.tree);
        expect(t).toContain(`Subtotal$${expected.subtotal.toFixed(2)}`);
        expect(t).toContain(`Food tax (7.5%)$${expected.taxAmount.toFixed(2)}`);
        expect(t).toContain(`Total due$${expected.total.toFixed(2)}`);
        expect(orderHeading(m.tree)).toBe(`Your order · $${expected.total.toFixed(2)}`);
    });

    it('E2. tax-exempt campaign: subtotal includes the add-on, tax exempt $0.00', () => {
        const m = mount({ campaign: { tax_status: 'TAX_EXEMPT', tax_rate_percent: 0 } });
        addMeal(m, bundleS2); addOnFromCard(m);
        const t = textOf(m.tree);
        expect(t).toContain('Subtotal$85.00');
        expect(t).toContain('Tax exempt$0.00');
        expect(t).toContain('Total due$85.00');
    });

    it('E3. a legacy untaxed campaign: the single total includes the add-on', () => {
        const m = mount();
        addMeal(m, bundleS5); addOnFromCard(m);
        expect(orderHeading(m.tree)).toBe('Your order · $150.00');
    });

    it('E4. the submitted line is just { bundleId, quantity, name } — the server decides role, price and name', async () => {
        const m = mount();
        addMeal(m, bundleS5); addOnFromCard(m);
        click(m, byLabel(m.tree, 'Increase Sides & Dessert Bundle (Add-On) quantity'));
        await fillContactAndSubmit(m);
        expect(lastBody().items).toEqual([
            { bundleId: 'b-s5', quantity: 1, serving_tier: 'family', name: S5_NAME },
            { bundleId: 'b-addon', quantity: 2, name: ADDON_NAME },
        ]);
    });

    it('E5. (20, 21) Serves 5 + 2 add-ons adds 1 bundle to the goal, never 3; the hero moves by 1', async () => {
        const m = mount();
        addMeal(m, bundleS5); addOnFromCard(m);
        click(m, byLabel(m.tree, 'Increase Sides & Dessert Bundle (Add-On) quantity'));
        responses.push({ ok: true, body: { orderId: 'ord-ao4-0005', total: 175, paymentData: { orgName: ORG } } });
        await fillContactAndSubmit(m);
        const t = textOf(m.tree);
        expect(t).toContain('Your order added 1 bundle toward the fundraiser goal');
        expect(t).toContain('5 of 20 bundles');
        expect(t).not.toContain('7 of 20 bundles');
    });

    it('E6. (22) Serves 2 + an add-on adds ½ bundle', async () => {
        const m = mount();
        addMeal(m, bundleS2); addOnFromCard(m);
        await fillContactAndSubmit(m);
        expect(textOf(m.tree)).toContain('Your order added ½ bundle toward the fundraiser goal');
    });

    it('E7. the shared weighting rule: add-on 0, Serves 5 1, Serves 2 ½', () => {
        expect(computeBundleUnitsFromItems([{ quantity: 3, serving_tier: null, item_role: 'addon' }])).toBe(0);
        expect(computeBundleUnitsFromItems([{ quantity: 1, serving_tier: 'family', item_role: 'main' }])).toBe(1);
        expect(computeBundleUnitsFromItems([{ quantity: 1, serving_tier: 'serves_2', item_role: 'main' }])).toBe(0.5);
        expect(R(CLIENT_PATH)).toMatch(/item_role: ADD_ON_ITEM_ROLE \}/);
    });

    it('E8. after a successful order the add-on state resets with the meals', async () => {
        const m = mount();
        addMeal(m, bundleS5); addOnFromCard(m);
        await fillContactAndSubmit(m);
        expect(lineOf(m.tree)).toBeNull();
        expect(cardOf(m.tree)).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('F. a stale add-on (409 ADDON_CHANGED)', () => {
    const stale = { ok: false, status: 409, body: { error: 'This fundraiser\'s add-on just changed. Please refresh and place your order again.', code: 'ADDON_CHANGED' } };

    it('F1. (25, 27) the add-on leaves the basket, every meal stays, nothing is placed, and the message says so', async () => {
        const m = mount();
        addMeal(m, bundleS5); addMeal(m, bundleS2); addOnFromCard(m);
        responses.push(stale);
        await fillContactAndSubmit(m);
        expect(lineOf(m.tree)).toBeNull();
        expect(byLabel(m.tree, `Remove ${S5_NAME}`)).toBeTruthy();
        expect(byLabel(m.tree, `Remove ${S2_NAME}`)).toBeTruthy();
        const alert = findAll(m.tree, (el) => el.props && el.props.role === 'alert')[0];
        expect(textOf(alert)).toBe(ADD_ON_NO_LONGER_AVAILABLE_MESSAGE);
        expect(textOf(m.tree)).not.toContain('You just backed');
        expect([cardOf(m.tree), quietOf(m.tree)]).toEqual([null, null]);
        expect(orderHeading(m.tree)).toBe('Your order · $185.00');
    });

    it('F2. the retry is a new logical submission: a new key, and no add-on line', async () => {
        const m = mount();
        addMeal(m, bundleS5); addOnFromCard(m);
        responses.push(stale);
        await fillContactAndSubmit(m);
        const first = lastBody();
        await btn(m.tree, /^Place my order/)[0].props.onClick(); m.render();
        const second = lastBody();
        expect(second.submissionKey).not.toBe(first.submissionKey);
        expect(second.items).toEqual([{ bundleId: 'b-s5', quantity: 1, serving_tier: 'family', name: S5_NAME }]);
    });

    it('F3. (26) deactivation is the same refusal: an inactive add-on has no authority, so the server answers 409', async () => {
        const db = (bundle: any) => ({ campaignAddOn: { findUnique: async () => ({ business_id: BIZ_ID, bundle_id: 'b-addon', bundle }) } });
        const active = { id: 'b-addon', name: ADDON_NAME, business_id: BIZ_ID, is_active: true, bundle_type: 'addon' };
        expect(await loadCampaignAddOnAuthority(db(active), { campaignId: CAMPAIGN_ID, businessId: BIZ_ID })).toEqual({ bundleId: 'b-addon', name: ADDON_NAME });
        expect(await loadCampaignAddOnAuthority(db({ ...active, is_active: false }), { campaignId: CAMPAIGN_ID, businessId: BIZ_ID })).toBeNull();
        const facts = new Map<string, OrderBundleFact>([['b-s5', { id: 'b-s5', name: S5_NAME, bundleType: 'meal' }], ['b-addon', { id: 'b-addon', name: ADDON_NAME, bundleType: 'addon' }]]);
        expect(classifyFundraiserOrderLines({ lineBundleIds: ['b-s5', 'b-addon'], isCampaignOrder: true, bundleFacts: facts, authorizedAddOn: null }))
            .toMatchObject({ ok: false, status: 409, code: 'ADDON_CHANGED' });
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('G. boundaries', () => {
    const facts = new Map<string, OrderBundleFact>([
        ['b-s5', { id: 'b-s5', name: S5_NAME, bundleType: 'meal' }],
        ['b-s2', { id: 'b-s2', name: S2_NAME, bundleType: 'meal' }],
        ['b-addon', { id: 'b-addon', name: ADDON_NAME, bundleType: 'addon' }],
        ['b-other-addon', { id: 'b-other-addon', name: 'Holiday Pie Add-On', bundleType: 'addon' }],
    ]);
    const authorized = { bundleId: 'b-addon', name: ADDON_NAME };

    it('G1. (23) an add-on-only payload is still refused by the server rule the order route applies', () => {
        expect(classifyFundraiserOrderLines({ lineBundleIds: ['b-addon'], isCampaignOrder: true, bundleFacts: facts, authorizedAddOn: authorized }))
            .toMatchObject({ ok: false, status: 400, code: 'ADDON_REQUIRES_MEAL' });
        // and both sizes qualify a real order with it
        for (const meal of ['b-s5', 'b-s2']) {
            expect(classifyFundraiserOrderLines({ lineBundleIds: [meal, 'b-addon'], isCampaignOrder: true, bundleFacts: facts, authorizedAddOn: authorized }))
                .toMatchObject({ ok: true, roles: ['main', 'addon'] });
        }
    });

    it('G2. (24) an add-on that is not this campaign\'s is refused', () => {
        expect(classifyFundraiserOrderLines({ lineBundleIds: ['b-s5', 'b-other-addon'], isCampaignOrder: true, bundleFacts: facts, authorizedAddOn: authorized }))
            .toMatchObject({ ok: false, status: 409, code: 'ADDON_CHANGED' });
    });

    it('G3. the public order route, the coordinator order path and the storefront are byte-identical to S3', () => {
        const files = [
            'app/api/public/order/route.ts', 'app/api/coordinator/route.ts', 'components/coordinator/ManualOrderForm.tsx',
            'app/api/checkout/session/route.ts', 'app/api/public/tenant/[slug]/route.ts', 'lib/storefrontEligibility.ts',
            'components/storefront/RoundOutRow.tsx', 'app/api/fundraiser/[token]/route.ts', 'lib/fundraiserMetrics.ts',
            'lib/fundraiserTax.ts', 'lib/pricing.ts', 'lib/serving_multipliers.ts', 'lib/kitchen_engine.ts', 'lib/prisma_adapter.ts',
            'lib/supporterConsentText.ts', 'lib/supporterPaymentMethods.ts', 'components/fundraiser/SupporterPaymentSection.tsx',
            'lib/orderLineDisplay.ts', 'lib/email.ts',
        ].filter((f) => fs.existsSync(path.join(ROOT, f)));
        expect(files.length).toBeGreaterThanOrEqual(17);
        const changed = execSync(`git diff --name-only ${S3_HEAD} -- ${files.map((f) => `"${f}"`).join(' ')}`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(changed).toBe('');
    });

    it('G4. (30) the ordinary storefront still never lists an add-on: the legacy lineup still requires show_on_storefront', () => {
        expect(R('app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx')).toMatch(/AND show_on_storefront = true/);
        expect(R('prisma/migrations/20261124120000_supporter_addon_s2/migration.sql')).toMatch(/bundles_addon_not_on_storefront/);
    });

    it('G5. (28) consent: same wording, both unchecked, never required — with an add-on in the basket', async () => {
        const m = mount();
        addMeal(m, bundleS5); addOnFromCard(m);
        const email = inputByLabel(m.tree, 'Email updates about future fundraisers');
        const sms = inputByLabel(m.tree, 'Text messages about future fundraisers');
        expect([email.props.checked, sms.props.checked]).toEqual([false, false]);
        const { supporterEmailConsentText, supporterSmsConsentText } = require('@/lib/supporterConsentText');
        expect(textOf(m.tree)).toContain(supporterEmailConsentText(ORG));
        expect(textOf(m.tree)).toContain(supporterSmsConsentText(ORG));
        await fillContactAndSubmit(m);
        expect(lastBody().marketingConsent).toEqual({ email: false, sms: false });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('G6. (31) the coordinator\'s manual add-on entry is untouched (same route and form as S3)', () => {
        const changed = execSync(`git diff --name-only ${S3_HEAD} -- "app/api/coordinator" "components/coordinator" "app/coordinator"`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(changed).toBe('');
    });

    it('G7. (32) a public add-on line is described by the S3 rules exactly like a coordinator one', () => {
        const stored = [
            { item_role: 'main', variant_size: 'serves_5', name: S5_NAME, quantity: 1 },
            { item_role: 'addon', variant_size: 'serves_5', name: ADDON_NAME, quantity: 2 },
        ];
        expect(stored.map(formatOrderLine)).toEqual([`${S5_NAME} — Serves 5 ×1`, 'Sides & Dessert Bundle (Add-On) ×2']);
        expect(orderLineSizeLabel(stored[1])).toBe('Add-On');
        expect(partitionOrderLines(stored).main).toHaveLength(1);
    });

    it('G8. no new money rule: the client never sends a price or a role, and computes nothing the server re-decides', () => {
        const src = R(CLIENT_PATH);
        const items = src.slice(src.indexOf('items: ['), src.indexOf('customer: {')).replace(/^\s*\/\/.*$/gm, '');
        expect(items).not.toMatch(/price|item_role|unit_price|discount/);
        expect(src).not.toMatch(/discount/i);
    });

    it('G9. schema: exactly one additive column; S1–S3 migrations untouched', () => {
        const sql = R('prisma/migrations/20261126120000_supporter_addon_s4/migration.sql');
        const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
        expect(statements).toEqual(['ALTER TABLE "campaign_add_ons" ADD COLUMN     "show_share_percent" BOOLEAN NOT NULL DEFAULT false']);
        expect(R('prisma/schema.prisma')).toMatch(/model CampaignAddOn \{[\s\S]*?show_share_percent Boolean @default\(false\)/);
        const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        expect(dirs[dirs.length - 1]).toBe('20261126120000_supporter_addon_s4');
        const changed = execSync(`git diff --name-only ${S3_HEAD} -- "prisma/migrations/20261123120000_supporter_addon_s1" "prisma/migrations/20261124120000_supporter_addon_s2" "prisma/migrations/20261125120000_supporter_addon_s3"`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(changed).toBe('');
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// The S3 source of a file, loaded beside the current one (written under /coverage, which git ignores).
const GOLDEN_DIR = path.join(ROOT, 'coverage', 's4-golden');
function loadS3(fileName: string, repoPath: string) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    const target = path.join(GOLDEN_DIR, fileName);
    fs.writeFileSync(target, execSync(`git show ${S3_HEAD}:"${repoPath}"`, { cwd: ROOT, encoding: 'utf8' }));
    return require(target);
}
afterAll(() => {
    fs.rmSync(GOLDEN_DIR, { recursive: true, force: true });
    // /coverage is git-ignored; leave nothing behind if this suite created it.
    const parent = path.dirname(GOLDEN_DIR);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
});

describe('H. (29) golden — a campaign with no add-on renders exactly as in S3', () => {
    const S3Client = () => loadS3('FundraiserClient.s3.tsx', CLIENT_PATH).default;
    const flows: Array<[string, any, (m: M) => void]> = [
        ['an empty order', {}, () => undefined],
        ['a Serves 5 meal', {}, (m) => addMeal(m, bundleS5)],
        ['both sizes, a quantity change and a removal', {}, (m) => { addMeal(m, bundleS5); addMeal(m, bundleS2); click(m, byLabel(m.tree, `Increase ${S5_NAME} quantity`)); removeMeal(m, bundleS2); }],
        ['a taxable campaign', { campaign: { tax_status: 'TAXABLE', tax_rate_percent: 7.5 } }, (m) => { addMeal(m, bundleS5); addMeal(m, bundleS2); }],
        ['a tax-exempt campaign', { campaign: { tax_status: 'TAX_EXEMPT', tax_rate_percent: 0 } }, (m) => addMeal(m, bundleS2)],
        ['an open meal detail', {}, (m) => click(m, byLabel(m.tree, `See what's included in ${S5_NAME}`))],
        ['a closed campaign', { orderMode: { allowed: false, mode: 'closed', safeMessage: 'Closed (fixture).' } }, () => undefined],
    ];
    it.each(flows)('H1. %s', (_label, over, act) => {
        const Old = S3Client();
        for (const addOn of [null, undefined]) {
            const props = { ...clientProps(over), addOn };
            if (addOn === undefined) delete (props as any).addOn;
            const now = mountComponent(loadClient(), props);
            const old = mountComponent(Old, props);
            act(now); act(old);
            expect(html(now.tree)).toBe(html(old.tree));
        }
    });

    it('H2. and the static first paint matches too', () => {
        const Old = S3Client();
        const props = { ...clientProps(), addOn: null };
        expect(renderToStaticMarkup(createElement(loadClient(), props))).toBe(renderToStaticMarkup(createElement(Old, props)));
    });

    it('H3. with an add-on but no meal yet, the only addition is an empty screen-reader status region', () => {
        const Old = S3Client();
        const withAddOn = html(mount().tree);
        const before = html(mountComponent(Old, { ...clientProps(), addOn: null }).tree);
        const stripped = withAddOn.replace(/<p data-addon-notice="true" role="status" aria-live="polite" style="[^"]*"><\/p>/, '');
        expect(stripped).toBe(before);
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('I. (33) narrow phones: nothing can push past a 360px screen', () => {
    const src = R(CARD_PATH);
    it('I1. no fixed width beyond the 56px thumbnail; text wraps; tap targets are 44px', () => {
        const widths = [...src.matchAll(/\b(width|minWidth|maxWidth):\s*([^,}\n]+)/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
        for (const w of widths) expect(w).toMatch(/^(width: (56|24|'100%')|minWidth: (0|'1rem'))$/);
        expect(src).not.toMatch(/nowrap|100vw|overflowX/);
        expect((src.match(/overflowWrap: 'anywhere'/g) || []).length).toBeGreaterThanOrEqual(5);
        expect((src.match(/minHeight: 44/g) || []).length).toBeGreaterThanOrEqual(4);
        expect(src).toMatch(/flexWrap: 'wrap', gap: '\.35rem \.9rem'/);
        expect(src).toMatch(/flex: '1 1 100%', minWidth: 0, minHeight: 44/);
        expect(SUPPORTER_ADDON_CARD_CSS).not.toMatch(/width/);
    });

    it('I2. the add-on line wraps like a meal line (the FR-SHARE-COPY-1 escape valve)', () => {
        expect(src).toMatch(/data-addon-line="true" className="fr-addon-line" style=\{\{ display: 'flex', alignItems: 'center', flexWrap: 'wrap'/);
    });

    it('I3. the card, link and line are hookless (the page owns all state)', () => {
        expect(src).not.toMatch(/useState|useEffect|useRef|useMemo|fetch\(/);
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('J. the tenant\'s per-fundraiser "show the share %" toggle', () => {
    const TENANT = BIZ_ID;
    const CAMP = 'camp-ao4-toggle';
    function world(opts: { assignment?: any; closed?: boolean } = {}) {
        const updates: any[] = [];
        const mock = createPrismaMock({
            results: {
                'fundraiserCampaign.findUnique': (args: any) => ({
                    id: CAMP, customer_id: 'cust-ao4', org_share_percent: '20.00',
                    closed_at: opts.closed ? new Date('2026-11-01T00:00:00Z') : null, status: opts.closed ? 'Closed' : 'Active',
                    customer: { business_id: TENANT },
                    ...(args?.select?.customer ? {} : {}),
                }),
                'campaignAddOn.findUnique': (args: any) => {
                    const a = opts.assignment === undefined ? { id: 'cao-1', business_id: TENANT, bundle_id: 'b-addon', show_share_percent: false } : opts.assignment;
                    if (!a) return null;
                    if (args?.select?.bundle) {
                        return { ...a, bundle: { id: 'b-addon', name: ADDON_NAME, price: '25.00', is_active: true, business_id: TENANT, bundle_type: 'addon' }, share_tiers: [{ starting_quantity: 1, percent: '10.00' }] };
                    }
                    return a;
                },
                'campaignAddOn.update': (args: any) => { updates.push(args); return { id: 'cao-1', ...args.data }; },
                'orderItem.findMany': [],
                'orderItem.aggregate': { _sum: { quantity: 0 } },
                'bundle.findMany': [],
            },
        });
        (global as any).__ao4Prisma = mock.client;
        return { mock, updates };
    }
    const patch = async (body: any) => {
        const { PATCH } = await import('@/app/api/campaigns/[id]/add-on/route');
        const req = new Request(`http://localhost/api/campaigns/${CAMP}/add-on`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return readJson(await PATCH(req as any, { params: Promise.resolve({ id: CAMP }) }));
    };
    const admin = () => { (global as any).__ao4Session = { user: { id: 'u-admin', businessId: TENANT, role: 'ADMIN' } }; };

    it('J1. an administrator turns it on and off — inside the campaign lock, display only', async () => {
        admin();
        const { mock, updates } = world();
        const res = await patch({ showSharePercent: true });
        expect(res.status).toBe(200);
        expect(updates).toEqual([{ where: { id: 'cao-1' }, data: { show_share_percent: true } }]);
        expect(mock.calls.filter((c) => c.model === '$executeRawUnsafe').length).toBeGreaterThanOrEqual(1);       // lockCampaignSelection
        expect(mock.callsTo('campaignAddOnShareTier.create')).toHaveLength(0);
        expect(mock.callsTo('campaignAddOnShareTier.updateMany')).toHaveLength(0);
        expect(res.body.addOn).toMatchObject({ showSharePercent: false });            // the double does not persist; shape only
        expect(res.body.addOn).toHaveProperty('publicSupportPercent');
    });

    it('J2. refusals: not a boolean → 400; not an administrator → 403; no add-on → 409; closed → 409', async () => {
        admin(); world();
        expect((await patch({ showSharePercent: 'yes' })).status).toBe(400);
        (global as any).__ao4Session = { user: { id: 'u-staff', businessId: TENANT, role: 'STAFF' } }; world();
        expect((await patch({ showSharePercent: true })).status).toBe(403);
        admin(); world({ assignment: null });
        expect((await patch({ showSharePercent: true })).body.code).toBe('NO_ADDON_ASSIGNED');
        admin(); world({ closed: true });
        expect((await patch({ showSharePercent: true })).body.code).toBe('CAMPAIGN_CLOSED');
    });

    it('J3. a tier edit is still a tier edit (the toggle travels alone)', async () => {
        admin(); const { updates } = world();
        const res = await patch({ tiers: [{ startingQuantity: 1, percent: 12 }], showSharePercent: true });
        expect(res.status).toBe(200);
        expect(updates).toHaveLength(0);
    });

    it('J4. the tenant card offers the checkbox and says what supporters will see', () => {
        const card = R('components/crm2/CampaignAddOnCard.tsx');
        expect(card).toMatch(/send\(\s*'PATCH',\s*\{ showSharePercent: e\.target\.checked \}/);
        expect(card).toMatch(/Show this share on the supporter page/);
        expect(card).toMatch(/Only shown while the share has one tier/);
        expect(card).toMatch(/disabled=\{!editable \|\| saving\}/);
    });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════
describe('K. S3 gap re-audit', () => {
    describe('B · the Manual Planner labels an add-on\'s food "Add-On", never "Serves 5"', () => {
        const lines = [
            { bundle_id: 'b-meal', variant_size: 'serves_5' },
            { bundle_id: 'b-addon', variant_size: 'serves_5' },
        ];
        const bundles = [
            { id: 'b-meal', bundle_type: 'meal', contents: [{ recipe_id: 'r-chicken' }, { recipe_id: 'r-shared' }] },
            { id: 'b-addon', bundle_type: 'addon', contents: [{ recipe_id: 'r-brownies' }, { recipe_id: 'r-shared' }] },
        ];

        it('K1. rows only from an add-on → "addon"; shared with a meal → "mixed"; meal-only rows untouched', () => {
            const kinds = classifyPlanAssemblyRows(lines, bundles);
            expect(Object.fromEntries(kinds)).toEqual({ 'r-brownies::serves_5': 'addon', 'r-shared::serves_5': 'mixed' });
        });

        it('K2. labels: Add-On, omitted (cannot be proven), and the meal\'s own size', () => {
            const tasks = annotateAssemblyTasks({
                'r-chicken::serves_5': { id: 'r-chicken', variantSize: 'serves_5', qty: 2 },
                'r-brownies::serves_5': { id: 'r-brownies', variantSize: 'serves_5', qty: 3 },
                'r-shared::serves_5': { id: 'r-shared', variantSize: 'serves_5', qty: 5 },
            }, classifyPlanAssemblyRows(lines, bundles));
            expect(assemblyRowServingLabel(tasks['r-chicken::serves_5'])).toBe('Serves 5');
            expect(assemblyRowServingLabel(tasks['r-brownies::serves_5'])).toBe('Add-On');
            expect(assemblyRowServingLabel(tasks['r-shared::serves_5'])).toBeNull();
            expect(Object.values(tasks).map((t: any) => t.qty)).toEqual([2, 3, 5]);     // quantities untouched
        });

        it('K3. the real /api/production/plan marks the add-on rows; quantities equal the unmarked plan; batch tier from meals', async () => {
            const recipe = (id: string, name: string) => ({
                id, name, type: 'menu_item', base_yield_qty: 1, base_yield_unit: 'batch', container_type: 'tray', category_id: null,
                label_text: null, macros: null, image_url: null, description: null, allergens: null, cook_time: null,
                child_items: [{ id: `ri-${id}`, parent_recipe_id: id, child_recipe_id: null, child_ingredient_id: `ing-${id}`,
                    child_ingredient: { name: `Ingredient ${id}`, unit: 'lb', cost_per_unit: 1, stock_quantity: 0, supplier: null },
                    child_recipe: null, quantity: 2, unit: 'lb', is_sub_recipe: false, section_name: null, section_batch: null }],
            });
            const contents: Record<string, string[]> = { 'b-meal': ['r-chicken'], 'b-meal-s2': ['r-chicken-s2'], 'b-addon': ['r-brownies'] };
            const types: Record<string, string> = { 'b-meal': 'meal', 'b-meal-s2': 'meal', 'b-addon': 'addon' };
            const plan = async (synced: any[], typed: boolean) => {
                const mock = createPrismaMock({ results: {
                    'recipe.findMany': [recipe('r-chicken', 'Chicken (fixture)'), recipe('r-chicken-s2', 'Chicken (Serves 2) (fixture)'), recipe('r-brownies', 'Brownies (fixture)')],
                    'bundleContent.findMany': (args: any) => (contents[args.where.bundle_id] || []).map((r) => ({ bundle_id: args.where.bundle_id, recipe_id: r, position: 1, quantity: 1 })),
                    'bundle.findMany': (args: any) => (args.where.id.in as string[]).filter((id) => args.where.business_id === BIZ_ID)
                        .map((id) => ({ id, bundle_type: typed ? types[id] : 'meal', contents: (contents[id] || []).map((r) => ({ recipe_id: r })) })),
                } });
                (global as any).__ao4Prisma = mock.client;
                (global as any).__ao4Session = { user: { id: 'u1', businessId: BIZ_ID } };
                const { POST } = await import('@/app/api/production/plan/route');
                const res = await POST(jsonRequest('http://localhost/api/production/plan', { syncedOrders: synced }) as any);
                return { body: await res.json(), mock };
            };
            const synced = [{ bundle_id: 'b-meal', quantity: 2, variant_size: 'serves_5' }, { bundle_id: 'b-addon', quantity: 3, variant_size: 'serves_5' }];
            const marked = await plan(synced, true);
            const unmarked = await plan(synced, false);
            const rows = Object.values(marked.body.assemblyTasks) as any[];
            expect(rows.find((r) => r.id === 'r-brownies')).toMatchObject({ addOn: true, qty: 3 });
            expect(rows.find((r) => r.id === 'r-chicken').addOn).toBeUndefined();
            expect(rows.map((r) => assemblyRowServingLabel(r))).toEqual(expect.arrayContaining(['Serves 5', 'Add-On']));
            const strip = (t: any) => Object.fromEntries(Object.entries(t).map(([k, v]: any) => [k, { ...v, addOn: undefined, addOnMixed: undefined }]));
            expect(strip(marked.body.assemblyTasks)).toEqual(strip(unmarked.body.assemblyTasks));
            expect(marked.body.rawIngredients).toEqual(unmarked.body.rawIngredients);
            expect(marked.body.servingTier).toBe('Serves 5');
            for (const c of marked.mock.callsTo('bundle.findMany')) {
                expect(c.args.where.business_id).toBe(BIZ_ID);
                expect(c.args.select.serving_tier).toBeUndefined();
            }
            // a Serves-2 meal beside the add-on: the batch tier is the MEAL's, not the add-on's stored serves_5
            const s2 = await plan([{ bundle_id: 'b-meal-s2', quantity: 1, variant_size: 'serves_2' }, { bundle_id: 'b-addon', quantity: 1, variant_size: 'serves_5' }], true);
            expect(s2.body.servingTier).toBe('Serves 2');
        });

        it('K4. every Manual Planner label builder uses the add-on-aware label; the engine and adapter are untouched', () => {
            const calc = R('components/production/ProductionCalculator.tsx');
            expect((calc.match(/servingTier: assemblyRowServingLabel\(row\)/g) || []).length).toBe(3);
            expect(calc).not.toMatch(/servingTier: servingTierLabel\(row\.variantSize\)/);
            const changed = execSync(`git diff --name-only ${S3_HEAD} -- "lib/kitchen_engine.ts" "lib/prisma_adapter.ts" "lib/serving_multipliers.ts" "lib/mealManifest.ts" "lib/mealLabel.ts" "app/api/production/sync/route.ts"`, { cwd: ROOT, encoding: 'utf8' }).trim();
            expect(changed).toBe('');
        });
    });

    it('A · the packet\'s small printable tracker is a blank form built from the meal lineup only — it never reads orders', () => {
        const src = R('lib/generateFullPacket.ts');
        const block = src.slice(src.indexOf('const trackerMenus = groupMaterialMenus('), src.indexOf('const trackerArrayBuffer'));
        expect(block).toMatch(/input\.bundles\.map/);
        expect(block).not.toMatch(/order|item_role|variant_size/i);
        expect(execSync(`git diff --name-only ${S3_HEAD} -- "lib/generateFullPacket.ts" "lib/generateTracker.ts"`, { cwd: ROOT, encoding: 'utf8' }).trim()).toBe('');
    });
});
