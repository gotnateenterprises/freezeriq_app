/**
 * FR-SUPPORTER-ORDER-CONVERSION-1 — the public fundraiser page's bundle cards and bundle detail.
 *
 * The REAL FundraiserClient is driven without a DOM (tests/helpers/hookRuntime): cards are clicked,
 * the detail opens, its action runs, and the page's own order card / submission are read back. The
 * REAL page.tsx data path runs against a Prisma double that honours the lineup's SQL filters, so
 * campaign scope and the public payload are proven on the code that ships. All data is fictional.
 *
 *  A. lib/supporterBundleDetail — text, image, name, order, size and goal-credit rules
 *  B. the collapsed card — photo window, title, price, size, affordances, the existing Add control
 *  C. opening and closing the detail — image, link, close, Escape, overlay; the right bundle
 *  D. the full photo — contain, never cover; expands in place
 *  E. meals — authoritative order, names, descriptions, photos, fallbacks, empty bundle
 *  F. the action — the page's own add and steppers, exact bundle, totals, state survives
 *  G. Serves 5 / Serves 2 — separate products, separate labels, separate lines
 *  H. campaign scope and the public payload — through page.tsx
 *  I. phone layout, accessibility and performance
 *  J. regression — submission, tax, sharing, deadline, sample mode
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mountComponent, findAll, textOf, walk } from './helpers/hookRuntime';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import {
    publicText,
    publicImageUrl,
    supporterMealDisplayName,
    supporterBundleMeals,
    supporterServesLabel,
    supporterGoalCredit,
} from '@/lib/supporterBundleDetail';
import {
    PUBLIC_SUPPORTER_BUNDLE_FIELDS,
    PUBLIC_SUPPORTER_RECIPE_FIELDS,
    FORBIDDEN_PUBLIC_SUPPORTER_FIELDS,
    toPublicSupporterBusiness,
} from '@/lib/publicFundraiserPayload';
import { resolveVariantSize } from '@/lib/serving_multipliers';
import { computeSupporterOrderTax } from '@/lib/fundraiserTax';
import { SUPPORTER_BUNDLE_DETAIL_CSS } from '@/components/fundraiser/SupporterBundleDetail';

jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__soc1Prisma; } }));
// The REAL house focus hook, with what the page tells it recorded (its effects cannot run without a DOM).
jest.mock('@/components/crm2/useDialogFocus', () => {
    const actual = jest.requireActual('@/components/crm2/useDialogFocus');
    return { useDialogFocus: (open: boolean, reKey?: unknown) => { (global as any).__soc1FocusOpen = open; return actual.useDialogFocus(open, reKey); } };
});
const focusHookOpen = () => (global as any).__soc1FocusOpen;

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const CLIENT_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const DETAIL_PATH = 'components/fundraiser/SupporterBundleDetail.tsx';
const LIB_PATH = 'lib/supporterBundleDetail.ts';
const PAGE_PATH = 'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx';

// ── fictional fixtures ────────────────────────────────────────────────────────────────────────
const BIZ_ID = 'biz-soc1-fixture';
const SLUG = 'cedar-kitchen-fixture';
const CAMPAIGN_ID = 'aaaa2222-0000-4000-8000-00000000c0c1';
const ORG = 'Cedar Hollow Swim Team (fixture)';
const PRIMARY = '#2f7d5b';
const IMG = (n: string) => `https://images.example.test/${n}.png`;
const S5_NAME = 'Harvest Table Bundle (fixture)';
const S2_NAME = 'Harvest Table Bundle (Serves 2) (fixture)';
const LONG_BUNDLE = 'The Extraordinarily Long Weeknight Comfort Classics Bundle With Extra Sides (fixture)';
const LONG_MEAL = 'Slow-Simmered Smoky Chipotle Black Bean And Sweet Potato Chili With Lime Crema (fixture)';

/** Five meals in the bundle's own order — deliberately NOT alphabetical. */
const S5_MEALS = [
    { name: 'Zesty Lemon Herb Chicken', description: 'Tender chicken thighs in a bright lemon and herb sauce.', image_url: IMG('m-zesty'), cook_time: '45-60 min', allergens: 'Dairy' },
    { name: 'Apple Cider Pork Roast', description: 'Pork loin slow-roasted with apple cider and thyme.', image_url: null, cook_time: '6-8 hours LOW', allergens: null },
    { name: 'Beef Barley Stew', description: null, image_url: IMG('m-beef'), cook_time: null, allergens: 'Gluten' },
    { name: LONG_MEAL, description: '   ', image_url: '', cook_time: '', allergens: '' },
    { name: 'Maple Glazed Salmon', description: 'null', image_url: 'javascript:alert(1)', cook_time: '25-30 min', allergens: 'None Confirmed' },
];
const S2_MEALS = S5_MEALS.map((m) => ({ ...m, name: `${m.name} (Serves 2)` }));
const items = (meals: any[]) => meals.map((m) => ({ quantity: 1, recipe: { macros: null, ...m } }));

const bundleS5 = { id: 'b-s5', name: S5_NAME, description: null, serving_tier: 'family', price: 125, image_url: IMG('harvest-s5'), items: items(S5_MEALS) };
const bundleS2 = { id: 'b-s2', name: S2_NAME, description: null, serving_tier: 'serves_2', price: 60, image_url: IMG('harvest-s2'), items: items(S2_MEALS) };
const bundleBare = { id: 'b-bare', name: LONG_BUNDLE, description: null, serving_tier: 'serves_5', price: 99, image_url: null, items: [] };
const LINEUP = [bundleS5, bundleS2, bundleBare];

const clientProps = (over: any = {}) => ({
    business: { name: 'Cedar Kitchen (fixture)', display_name: null, slug: SLUG, logo_url: null, branding: { primary_color: PRIMARY, logo_url: null }, bundles: LINEUP },
    campaign: {
        id: CAMPAIGN_ID, name: `${ORG} Fundraiser`, organization_name: ORG, about_text: null, participant_label: 'Swimmer',
        end_date: '2026-11-20', delivery_date: '2026-12-01', pickup_location: 'Fixture Natatorium', delivery_time: null,
        payment_instructions: 'Pay the coordinator by check', external_payment_link: null, tax_status: null, tax_rate_percent: null,
        customer_fundraiser_info: { delivery_date: null, delivery_time: null, pickup_location: null },
    },
    bundleProgress: { totalBundlesSold: 4, bundleGoal: 20 },
    orderMode: { allowed: true, mode: 'selected' },
    slug: SLUG,
    fundraiserId: CAMPAIGN_ID,
    shareUrl: `https://www.freezeriqapp.com/shop/${SLUG}/fundraiser/${CAMPAIGN_ID}`,
    deadline: { kind: 'days', days: 19 },
    ...over,
});

// ── browser doubles ───────────────────────────────────────────────────────────────────────────
let fetchMock: jest.Mock;
function installBrowser(response: { ok: boolean; body: any } = { ok: true, body: { orderId: 'ord-soc1-0001', total: 0, paymentData: { orgName: ORG } } }) {
    const win = { open: jest.fn(), location: { href: 'https://example.test/', hostname: 'example.test' }, scrollTo: jest.fn() };
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: win });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: jest.fn(async () => undefined) } } });
    fetchMock = jest.fn(async () => ({ ok: response.ok, json: async () => response.body }));
    (globalThis as any).fetch = fetchMock;
}
beforeEach(() => { jest.clearAllMocks(); installBrowser(); });

const loadClient = () => require('@/app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient').default;
const mount = (over: any = {}) => mountComponent(loadClient(), clientProps(over));
const buttons = (tree: any) => findAll(tree, (el) => el.type === 'button');
const byLabel = (tree: any, label: string) => findAll(tree, (el) => el.type === 'button' && el.props['aria-label'] === label);
const one = (tree: any, label: string) => {
    const hit = byLabel(tree, label)[0];
    if (!hit) throw new Error(`no button labelled "${label}"`);
    return hit;
};
const byText = (tree: any, re: RegExp) => findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)));
const dialogOf = (tree: any) => findAll(tree, (el) => el.props && el.props.role === 'dialog')[0] ?? null;
const overlayOf = (tree: any) => findAll(tree, (el) => el.props && el.props.className === 'fr-detail-overlay')[0] ?? null;
const orderHeading = (tree: any) => textOf(findAll(tree, (el) => el.type === 'b' && /^Your order/.test(textOf(el.props.children)))[0]);
const inputByLabel = (tree: any, label: string) => findAll(tree, (el) => el.type === 'input' && el.props['aria-label'] === label)[0];
const click = (m: ReturnType<typeof mountComponent>, el: any) => { el.props.onClick({ stopPropagation: () => undefined }); return m.render(); };
const openPhoto = (m: ReturnType<typeof mountComponent>, b: any) => click(m, one(m.tree, `${b.items.length ? `See the ${supporterBundleMeals(b).length} meals` : 'See details'} in ${b.name}`));
const openLink = (m: ReturnType<typeof mountComponent>, b: any) => click(m, one(m.tree, `See what's included in ${b.name}`));
const mealNamesShown = (tree: any) => findAll(dialogOf(tree), (el) => el.type === 'li').map((li) => textOf(findAll(li, (x) => x.type === 'b')[0]));
const detailAdd = (tree: any) => byText(dialogOf(tree), /^Add to my order/)[0];

async function fillContactAndSubmit(m: ReturnType<typeof mountComponent>) {
    for (const [label, value] of [['First Name', 'Ada'], ['Last Name', 'Fixturely'], ['Email', 'ada.fixture@example.test'], ['Phone Number', '555-0100']]) {
        inputByLabel(m.tree, label).props.onChange({ target: { value } }); m.render();
    }
    await byText(m.tree, /^Place my order/)[0].props.onClick(); m.render();
}
const lastBody = () => JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);

// ═════════════════════════════════════════════════════════════════════════════
describe('A. lib/supporterBundleDetail', () => {
    it('A1. publicText: only a real stored string — never "null", "undefined", blanks or non-strings', () => {
        for (const v of [null, undefined, '', '   ', 'null', 'NULL', ' undefined ', 0, 12, {}, []]) expect(publicText(v)).toBeNull();
        expect(publicText('  Hearty and warm. ')).toBe('Hearty and warm.');
    });

    it('A2. publicImageUrl: http(s), root-relative or inline images only', () => {
        expect(publicImageUrl('https://images.example.test/a.png')).toBe('https://images.example.test/a.png');
        expect(publicImageUrl('/freezer-chef-logo.png')).toBe('/freezer-chef-logo.png');
        expect(publicImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
        for (const v of ['javascript:alert(1)', '//evil.example/x.png', 'ftp://x/y.png', 'null', '', null, 7]) expect(publicImageUrl(v)).toBeNull();
    });

    it('A3. a trailing serving-size note is dropped for display; nothing else about a name changes', () => {
        expect(supporterMealDisplayName('Bacon Cheeseburger Soup - KETO (Serves 2)')).toBe('Bacon Cheeseburger Soup - KETO');
        expect(supporterMealDisplayName('Chili (serves 5) ')).toBe('Chili');
        expect(supporterMealDisplayName('Mac (Serves 2) And Cheese')).toBe('Mac (Serves 2) And Cheese');
        expect(supporterMealDisplayName('(Serves 2)')).toBe('(Serves 2)');
        expect(supporterMealDisplayName('Tuscan Garlic Chicken - Keto')).toBe('Tuscan Garlic Chicken - Keto');
    });

    it('A4. meals keep the order they arrived in (the position order), never alphabetical', () => {
        const meals = supporterBundleMeals(bundleS5);
        expect(meals.map((m) => m.name)).toEqual(S5_MEALS.map((m) => m.name));
        expect(meals.map((m) => m.name)).not.toEqual([...meals.map((m) => m.name)].sort());
    });

    it('A5. a row without a real name is skipped; missing photos / descriptions / meta become null', () => {
        const meals = supporterBundleMeals({ items: [
            { recipe: { name: '  ', description: 'x' } }, { recipe: null }, {}, null,
            ...items(S5_MEALS),
        ] });
        expect(meals).toHaveLength(5);
        expect(meals[1]).toMatchObject({ description: 'Pork loin slow-roasted with apple cider and thyme.', imageUrl: null, allergens: null });
        expect(meals[2]).toMatchObject({ description: null, imageUrl: IMG('m-beef') });
        expect(meals[3]).toMatchObject({ description: null, imageUrl: null, cookTime: null, allergens: null });
        expect(meals[4]).toMatchObject({ description: null, imageUrl: null, cookTime: '25-30 min', allergens: 'None Confirmed' });
        expect(supporterBundleMeals(null)).toEqual([]);
        expect(supporterBundleMeals({ items: 'nope' } as any)).toEqual([]);
    });

    it('A6. the size label is the card\'s own expression for every tier spelling, and the two sizes never merge', () => {
        const cardLabel = (t: any) => (resolveVariantSize(t) === 'serves_5' ? 'serves 5' : 'serves 2');
        for (const t of ['family', 'Family Size', 'family_size', 'serves_5', 'start_fresh', 'serves_2', 'couple', 'Couple', null]) {
            expect(supporterServesLabel(t)).toBe(cardLabel(t));
        }
        expect(supporterServesLabel('family')).toBe('serves 5');
        expect(supporterServesLabel('serves_2')).toBe('serves 2');
    });

    it('A7. goal credit comes from the weighting engine: serves 5 = 1 bundle, serves 2 = ½ bundle', () => {
        expect(supporterGoalCredit('family')).toBe('1 bundle');
        expect(supporterGoalCredit('serves_2')).toBe('½ bundle');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('B. the collapsed bundle card', () => {
    it('B1. the photo is a 5:4 window that covers, upper-anchored — not the old 120px strip', () => {
        const m = mount();
        const photo = one(m.tree, `See the 5 meals in ${S5_NAME}`);
        expect(photo.props.style.aspectRatio).toBe('5 / 4');
        expect(photo.props.style.width).toBe('100%');
        const img = findAll(photo, (el) => el.type === 'img')[0];
        expect(img.props.src).toBe(IMG('harvest-s5'));
        expect(img.props.style).toMatchObject({ objectFit: 'cover', width: '100%', height: '100%' });
        expect(img.props.style.objectPosition).toMatch(/^center \d+%$/);
        expect(img.props.alt).toBe(`${S5_NAME} bundle photo`);
        expect(photo.props.style.height).toBeUndefined();
        expect(read(CLIENT_PATH)).not.toMatch(/height: 120, display: 'grid'/);           // the old strip is gone
    });

    it('B2. title, price, size, a meal summary, the detail link and the existing Add control are all there', () => {
        const html = renderToStaticMarkup(createElement(loadClient(), clientProps())).replace(/<!-- -->/g, '');
        expect(html).toContain(`>${S5_NAME}</h3>`);
        expect(html).toContain('$125.00');
        expect(html).toContain('· serves 5');
        expect(html).toContain('$60.00');
        expect(html).toContain('· serves 2');
        expect(html).toContain('Zesty Lemon Herb Chicken · Apple Cider Pork Roast · Beef Barley Stew');
        expect(html).toContain('See what’s included →');
        expect(html).toContain('See the 5 meals →');
        const m = mount();
        expect(one(m.tree, `Add ${S5_NAME} to your order`).props['aria-pressed']).toBe(false);
        expect(textOf(one(m.tree, `Add ${S5_NAME} to your order`))).toBe('Add');
    });

    it('B3. a card with no photo shows the warm placeholder (no <img>, no broken icon) and still opens its detail', () => {
        const m = mount();
        const photo = one(m.tree, `See details in ${LONG_BUNDLE}`);
        expect(findAll(photo, (el) => el.type === 'img')).toHaveLength(0);
        expect(textOf(photo)).toContain('🍲');
        expect(photo.props.style.height).toBe(120);                                      // a short band, not a big empty block
        expect(photo.props.style.aspectRatio).toBeUndefined();
        click(m, photo);
        expect(dialogOf(m.tree).props['data-bundle-id']).toBe('b-bare');
    });

    it('B4. a photo that fails to load hides itself, leaving the placeholder (never a broken-image icon)', () => {
        const m = mount();
        const img = findAll(one(m.tree, `See the 5 meals in ${S5_NAME}`), (el) => el.type === 'img')[0];
        const target = { style: { visibility: '' } };
        img.props.onError({ currentTarget: target });
        expect(target.style.visibility).toBe('hidden');
    });

    it('B5. nothing on the page reads "null" or "undefined"', () => {
        const html = renderToStaticMarkup(createElement(loadClient(), clientProps())).replace(/<!-- -->/g, '');
        const visible = html.replace(/<[^>]+>/g, ' ');
        expect(visible).not.toMatch(/\bnull\b|\bundefined\b|NaN/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('C. opening and closing the detail', () => {
    it('C1. nothing is open at first', () => {
        expect(dialogOf(mount().tree)).toBeNull();
    });

    it('C2. tapping a photo opens THAT bundle — for every card, not just the first', () => {
        for (const b of LINEUP) {
            const m = mount();
            openPhoto(m, b);
            const d = dialogOf(m.tree);
            expect(d.props['data-bundle-id']).toBe(b.id);
            expect(textOf(findAll(d, (el) => el.type === 'h2')[0])).toBe(b.name);
        }
    });

    it('C3. the "See what\'s included" link opens the same bundle', () => {
        const m = mount();
        openLink(m, bundleS2);
        expect(dialogOf(m.tree).props['data-bundle-id']).toBe('b-s2');
    });

    it('C4. the close button closes it', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        click(m, one(m.tree, 'Close bundle details'));
        expect(dialogOf(m.tree)).toBeNull();
    });

    it('C5. Escape closes it; other keys (Tab) do not', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        overlayOf(m.tree).props.onKeyDown({ key: 'Tab', shiftKey: false, defaultPrevented: false, preventDefault: () => undefined, stopPropagation: () => undefined });
        m.render();
        expect(dialogOf(m.tree)).not.toBeNull();
        const stop = jest.fn();
        overlayOf(m.tree).props.onKeyDown({ key: 'Escape', stopPropagation: stop, preventDefault: () => undefined });
        m.render();
        expect(dialogOf(m.tree)).toBeNull();
        expect(stop).toHaveBeenCalled();
    });

    it('C6. a tap on the dimmed backdrop closes it; a tap inside the panel does not reach the backdrop', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const stop = jest.fn();
        dialogOf(m.tree).props.onClick({ stopPropagation: stop });
        expect(stop).toHaveBeenCalled();
        overlayOf(m.tree).props.onClick();
        m.render();
        expect(dialogOf(m.tree)).toBeNull();
    });

    it('C7. browsing is read-only: open/close changes no order line, field or total', () => {
        const m = mount();
        click(m, one(m.tree, `Add ${S5_NAME} to your order`));
        click(m, one(m.tree, `Increase ${S5_NAME} quantity`));
        inputByLabel(m.tree, 'First Name').props.onChange({ target: { value: 'Ada' } }); m.render();
        const before = orderHeading(m.tree);
        for (const b of LINEUP) { openPhoto(m, b); click(m, one(m.tree, 'Close bundle details')); }
        openLink(m, bundleS2); overlayOf(m.tree).props.onKeyDown({ key: 'Escape', stopPropagation: () => undefined }); m.render();
        expect(orderHeading(m.tree)).toBe(before);
        expect(before).toBe('Your order · $250.00');
        expect(inputByLabel(m.tree, 'First Name').props.value).toBe('Ada');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('C8. a bundle that leaves the lineup cannot stay open (only THIS page\'s bundles can be shown)', () => {
        const m = mount();
        openPhoto(m, bundleS2);
        m.setProps({ business: { ...clientProps().business, bundles: [bundleS5] } });
        expect(dialogOf(m.tree)).toBeNull();
        expect(focusHookOpen()).toBe(false);
    });

    it('C9. the focus hook (and its page scroll lock) is open exactly while the dialog is — never once ordering is off screen', async () => {
        const m = mount();
        expect(focusHookOpen()).toBe(false);
        openPhoto(m, bundleS5);
        expect(focusHookOpen()).toBe(true);
        m.setProps({ orderMode: { allowed: false, mode: 'closed', safeMessage: 'Closed.' } });
        expect(dialogOf(m.tree)).toBeNull();
        expect(focusHookOpen()).toBe(false);                                   // no scroll lock left behind a closed page
        // and after a completed order the thank-you view replaces ordering
        const m2 = mount();
        click(m2, one(m2.tree, `Add ${S5_NAME} to your order`));
        openPhoto(m2, bundleS2);
        expect(focusHookOpen()).toBe(true);
        await fillContactAndSubmit(m2);
        expect(overlayOf(m2.tree)).toBeNull();                                 // (the success modal is the only dialog now)
        expect(textOf(dialogOf(m2.tree))).toContain('Order received!');
        expect(focusHookOpen()).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('D. the full bundle photo', () => {
    it('D1. the detail photo is contained (the whole picture), keeps its aspect ratio, and is never cropped', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const img = findAll(dialogOf(m.tree), (el) => el.type === 'img' && el.props.src === IMG('harvest-s5'))[0];
        expect(img.props.style.objectFit).toBe('contain');
        expect(img.props.style.height).toBe('auto');
        expect(img.props.style.width).toBe('100%');
        expect(img.props.alt).toBe(`${S5_NAME} — full bundle photo`);
    });

    it('D2. tapping the photo shows it at full natural size, and again returns to the screen-sized view', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const toggle = () => findAll(dialogOf(m.tree), (el) => el.type === 'button' && el.props['aria-pressed'] !== undefined)[0];
        const imgStyle = () => findAll(dialogOf(m.tree), (el) => el.type === 'img' && el.props.src === IMG('harvest-s5'))[0].props.style;
        expect(imgStyle().maxHeight).not.toBe('none');
        expect(toggle().props['aria-pressed']).toBe(false);
        click(m, toggle());
        expect(imgStyle().maxHeight).toBe('none');
        expect(imgStyle().objectFit).toBe('contain');
        expect(toggle().props['aria-pressed']).toBe(true);
        click(m, toggle());
        expect(imgStyle().maxHeight).not.toBe('none');
    });

    it('D3. a bundle with no photo shows the placeholder in the detail, not an empty frame', () => {
        const m = mount();
        openPhoto(m, bundleBare);
        expect(findAll(dialogOf(m.tree), (el) => el.type === 'img')).toHaveLength(0);
        const band = findAll(dialogOf(m.tree), (el) => el.type === 'div' && textOf(el) === '🍲')[0];
        expect(band.props.style.height).toBeLessThanOrEqual(120);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('E. the meals', () => {
    it('E1. every meal, in the bundle\'s own order (position), not alphabetical', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const shown = mealNamesShown(m.tree);
        expect(shown).toEqual(S5_MEALS.map((x) => x.name));
        expect(shown).not.toEqual([...shown].sort());
        expect(findAll(dialogOf(m.tree), (el) => el.type === 'ol')).toHaveLength(1);
        expect(findAll(dialogOf(m.tree), (el) => el.type === 'li').map((li) => li.props['data-meal-index'])).toEqual([0, 1, 2, 3, 4]);
    });

    it('E2. stored descriptions are shown in full, readable, untruncated; a missing one renders nothing', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const lis = findAll(dialogOf(m.tree), (el) => el.type === 'li');
        const paras = (li: any) => findAll(li, (el) => el.type === 'p');
        const desc0 = paras(lis[0])[0];
        expect(textOf(desc0)).toBe(S5_MEALS[0].description);
        expect(parseFloat(desc0.props.style.fontSize)).toBeGreaterThanOrEqual(0.8);
        expect(desc0.props.style.WebkitLineClamp).toBeUndefined();
        expect(desc0.props.style.overflowWrap).toBe('anywhere');
        // Beef Barley Stew: no description → no description paragraph, only its meta line
        expect(paras(lis[2]).map((p) => textOf(p))).toEqual(['Allergens: Gluten']);
        // blank / literal "null" descriptions: nothing, never the word
        expect(paras(lis[3])).toHaveLength(0);
        expect(textOf(dialogOf(m.tree))).not.toMatch(/\bnull\b|\bundefined\b/);
    });

    it('E3. meal photos where they exist (descriptive alt, lazy); a tasteful placeholder where they do not', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const lis = findAll(dialogOf(m.tree), (el) => el.type === 'li');
        const imgOf = (li: any) => findAll(li, (el) => el.type === 'img')[0];
        expect(imgOf(lis[0]).props).toMatchObject({ src: IMG('m-zesty'), alt: 'Photo of Zesty Lemon Herb Chicken', loading: 'lazy' });
        expect(imgOf(lis[2]).props.src).toBe(IMG('m-beef'));
        for (const i of [1, 3, 4]) {                               // none, blank, and an unsafe javascript: URL
            expect(imgOf(lis[i])).toBeUndefined();
            expect(textOf(lis[i])).toContain('🍽️');
        }
        const target = { style: { visibility: '' } };
        imgOf(lis[0]).props.onError({ currentTarget: target });
        expect(target.style.visibility).toBe('hidden');
    });

    it('E4. cook time and allergens appear only when stored, as a quiet line under the meal', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const text = textOf(dialogOf(m.tree));
        expect(text).toContain('⏱ 45-60 min · Allergens: Dairy');
        expect(text).toContain('⏱ 6-8 hours LOW');
        expect(text).toContain('⏱ 25-30 min · Allergens: None Confirmed');
        expect(text).not.toMatch(/macros/i);
    });

    it('E5. long meal and bundle names wrap instead of overflowing', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const long = findAll(dialogOf(m.tree), (el) => el.type === 'b' && textOf(el) === LONG_MEAL)[0];
        expect(long.props.style.overflowWrap).toBe('anywhere');
        const m2 = mount();
        openPhoto(m2, bundleBare);
        expect(findAll(dialogOf(m2.tree), (el) => el.type === 'h2')[0].props.style.overflowWrap).toBe('anywhere');
        const cardTitle = findAll(m2.tree, (el) => el.type === 'h3' && textOf(el) === LONG_BUNDLE)[0];
        expect(cardTitle.props.style.overflowWrap).toBe('anywhere');
    });

    it('E6. a bundle with no meals does not crash, invents nothing, and stays orderable (its lineup says so)', () => {
        const m = mount();
        openPhoto(m, bundleBare);
        const d = dialogOf(m.tree);
        expect(textOf(d)).toContain('The meal list for this bundle isn’t available right now.');
        expect(findAll(d, (el) => el.type === 'li')).toHaveLength(0);
        expect(detailAdd(m.tree).props.disabled).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('F. the action uses the page\'s own order', () => {
    it('F1. "Add to my order" adds THIS bundle once, closes, and the card shows ✓ Added', () => {
        const m = mount();
        openPhoto(m, bundleS2);
        expect(textOf(detailAdd(m.tree))).toBe('Add to my order · Serves 2 · $60.00');
        click(m, detailAdd(m.tree));
        expect(dialogOf(m.tree)).toBeNull();
        expect(orderHeading(m.tree)).toBe('Your order · $60.00');
        expect(byLabel(m.tree, `Remove ${S2_NAME} from your order`)[0].props['aria-pressed']).toBe(true);
        expect(byLabel(m.tree, `Add ${S5_NAME} to your order`)).toHaveLength(1);       // the other size untouched
        expect(textOf(findAll(m.tree, (el) => el.type === 'p' && el.props['aria-live'] === 'polite' && /in your order/.test(textOf(el)))[0]))
            .toBe(`${S2_NAME} (serves 2) is in your order.`);
    });

    it('F2. totals after a detail add are exactly the totals after a card add (taxable campaign too)', () => {
        const campaign = { ...clientProps().campaign, tax_status: 'TAXABLE', tax_rate_percent: 8.25 };
        const viaCard = mount({ campaign });
        click(viaCard, one(viaCard.tree, `Add ${S5_NAME} to your order`));
        const viaDetail = mount({ campaign });
        openPhoto(viaDetail, bundleS5);
        click(viaDetail, detailAdd(viaDetail.tree));
        const expected = computeSupporterOrderTax({ subtotal: 125, snapshot: { status: 'TAXABLE', ratePercent: 8.25 } });
        expect(orderHeading(viaDetail.tree)).toBe(orderHeading(viaCard.tree));
        expect(orderHeading(viaDetail.tree)).toBe(`Your order · $${expected.total.toFixed(2)}`);
        expect(renderText(viaDetail)).toBe(renderText(viaCard));
    });

    it('F3. already in the order: the detail says so, shows the quantity, and its −/+ are the order card\'s', () => {
        const m = mount();
        click(m, one(m.tree, `Add ${S5_NAME} to your order`));
        click(m, one(m.tree, `Increase ${S5_NAME} quantity`));
        openPhoto(m, bundleS5);
        const d = dialogOf(m.tree);
        expect(textOf(d)).toContain('✓ In your order');
        expect(textOf(d)).toContain('Quantity 2');
        expect(detailAdd(m.tree)).toBeUndefined();
        click(m, one(m.tree, `One more ${S5_NAME}`));
        expect(orderHeading(m.tree)).toBe('Your order · $375.00');
        click(m, one(m.tree, `One fewer ${S5_NAME}`));
        click(m, one(m.tree, `One fewer ${S5_NAME}`));
        click(m, one(m.tree, `One fewer ${S5_NAME}`));                       // at 1 → removed, exactly as the order card's −
        expect(orderHeading(m.tree)).toBe('Your order · $0.00');
        expect(textOf(detailAdd(m.tree))).toBe('Add to my order · Serves 5 · $125.00');
        click(m, detailAdd(m.tree));
        expect(orderHeading(m.tree)).toBe('Your order · $125.00');
    });

    it('F4. the steppers change only the open bundle; "Done" closes and keeps the quantity', () => {
        const m = mount();
        click(m, one(m.tree, `Add ${S5_NAME} to your order`));
        click(m, one(m.tree, `Add ${S2_NAME} to your order`));
        openPhoto(m, bundleS2);
        click(m, one(m.tree, `One more ${S2_NAME}`));
        click(m, byText(dialogOf(m.tree), /^Done$/)[0]);
        expect(dialogOf(m.tree)).toBeNull();
        expect(orderHeading(m.tree)).toBe('Your order · $245.00');               // 125 + 2 × 60
        openPhoto(m, bundleS2);
        expect(textOf(dialogOf(m.tree))).toContain('Quantity 2');
    });

    it('F5. a detail add never toggles a bundle back OUT of the order', () => {
        const m = mount();
        click(m, one(m.tree, `Add ${S5_NAME} to your order`));
        openPhoto(m, bundleS5);
        // in-order state shows no Add; even calling the add path again keeps the line
        const src = read(CLIENT_PATH);
        expect(src).toMatch(/if \(!orderLines\.some\(l => l\.bundleId === bundle\.id\)\) toggleLine\(bundle\);/);
        expect(orderHeading(m.tree)).toBe('Your order · $125.00');
    });

    it('F6. the detail goes through toggleLine / changeQty — a changed order retires the submission key', async () => {
        installBrowser({ ok: false, body: { error: 'Temporary failure' } });
        const m = mount();
        click(m, one(m.tree, `Add ${S5_NAME} to your order`));
        await fillContactAndSubmit(m);
        const firstKey = lastBody().submissionKey;
        await byText(m.tree, /^Place my order/)[0].props.onClick(); m.render();
        expect(lastBody().submissionKey).toBe(firstKey);                     // same logical submission: replay-safe retry
        openPhoto(m, bundleS2);
        click(m, detailAdd(m.tree));                                          // order changed through the detail
        await byText(m.tree, /^Place my order/)[0].props.onClick(); m.render();
        const afterAdd = lastBody().submissionKey;
        expect(afterAdd).not.toBe(firstKey);
        openPhoto(m, bundleS2);
        click(m, one(m.tree, `One more ${S2_NAME}`));                          // and through the detail's stepper
        await byText(m.tree, /^Place my order/)[0].props.onClick(); m.render();
        expect(lastBody().submissionKey).not.toBe(afterAdd);
    });

    it('F7. the detail has no cart, no price math and no order object of its own', () => {
        const detail = read(DETAIL_PATH);
        expect(detail).not.toMatch(/useState|useReducer|setOrderLines|localStorage|fetch\(|computeSupporterOrderTax|\* quantity|quantity \*/);
        const client = read(CLIENT_PATH);
        const at = client.indexOf('const addFromDetail');
        const add = client.slice(at, client.indexOf('closeDetail();', at));
        expect(add).toContain('toggleLine(bundle)');
        expect(add).not.toContain('setOrderLines');
        expect(client).toMatch(/onChangeQty=\{\(delta\) => changeQty\(detailBundle\.id, delta\)\}/);
        expect(client).toMatch(/onAdd=\{\(\) => addFromDetail\(detailBundle\)\}/);
    });
});

/** The order card's visible text (lines, subtotal, tax, total), for whole-card equality. */
function renderText(m: ReturnType<typeof mountComponent>) {
    const cards = findAll(m.tree, (el) => el.type === 'div' && el.props.style && el.props.style.borderRadius === 20
        && /^Your order/.test(textOf(el)) && /Place my order/.test(textOf(el)));
    return textOf(cards[cards.length - 1]);
}

// ═════════════════════════════════════════════════════════════════════════════
describe('G. Serves 5 and Serves 2 stay separate products', () => {
    it('G1. each card and each detail names its own size, price and goal credit', () => {
        const m = mount();
        const chip = (b: any) => textOf(findAll(one(m.tree, `See the 5 meals in ${b.name}`), (el) => el.type === 'span' && /^Serves \d$/.test(textOf(el)))[0]);
        expect(chip(bundleS5)).toBe('Serves 5');
        expect(chip(bundleS2)).toBe('Serves 2');
        openPhoto(m, bundleS2);
        let t = textOf(dialogOf(m.tree));
        expect(t).toContain('Serves 2');
        expect(t).toContain('$60.00 · serves 2');
        expect(t).toContain('Counts as ½ bundle toward the fundraiser goal');
        expect(t).not.toContain('Serves 5');
        click(m, one(m.tree, 'Close bundle details'));
        openPhoto(m, bundleS5);
        t = textOf(dialogOf(m.tree));
        expect(t).toContain('$125.00 · serves 5');
        expect(t).toContain('Counts as 1 bundle toward the fundraiser goal');
    });

    it('G2. adding both sizes gives two lines with their own ids, tiers and prices in the submitted order', async () => {
        const m = mount();
        openPhoto(m, bundleS5); click(m, detailAdd(m.tree));
        openPhoto(m, bundleS2); click(m, detailAdd(m.tree));
        expect(orderHeading(m.tree)).toBe('Your order · $185.00');
        await fillContactAndSubmit(m);
        expect(lastBody().items).toEqual([
            { bundleId: 'b-s5', quantity: 1, serving_tier: 'family', name: S5_NAME },
            { bundleId: 'b-s2', quantity: 1, serving_tier: 'serves_2', name: S2_NAME },
        ]);
    });

    it('G3. the detail\'s meal names drop the repeated "(Serves 2)" but the bundle size is still stated three times', () => {
        const m = mount();
        openPhoto(m, bundleS2);
        expect(mealNamesShown(m.tree)[0]).toBe('Zesty Lemon Herb Chicken');
        const t = textOf(dialogOf(m.tree));
        expect((t.match(/Serves 2|serves 2/g) || []).length).toBeGreaterThanOrEqual(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// H. Campaign scope and the public payload, through page.tsx
// ═════════════════════════════════════════════════════════════════════════════
type Row = Record<string, any>;
const BUNDLE_ROWS: Row[] = [
    { id: 'b-s5', name: S5_NAME, sku: 'SKU-INTERNAL-5', description: null, serving_tier: 'family', price: '125.00', business_id: BIZ_ID, image_url: IMG('harvest-s5'), stock_on_hand: '42', is_active: true, show_on_storefront: true, catalog_id: 'cat-INTERNAL', family_id: 'fam-INTERNAL', is_surplus: false, order_cutoff_date: null },
    { id: 'b-s2', name: S2_NAME, sku: 'SKU-INTERNAL-2', description: null, serving_tier: 'serves_2', price: '60.00', business_id: BIZ_ID, image_url: IMG('harvest-s2'), stock_on_hand: '7', is_active: true, show_on_storefront: true, catalog_id: 'cat-INTERNAL', family_id: 'fam-INTERNAL', is_surplus: false, order_cutoff_date: null },
    // a tenant bundle that is NOT in this campaign's lineup (an old campaign's / the storefront's)
    { id: 'b-old', name: 'Last Spring Bundle (fixture)', sku: 'SKU-OLD', description: null, serving_tier: 'family', price: '110.00', business_id: BIZ_ID, image_url: null, stock_on_hand: '0', is_active: true, show_on_storefront: true, catalog_id: null, family_id: 'fam-old', is_surplus: false, order_cutoff_date: null },
    // an inactive tenant bundle
    { id: 'b-inactive', name: 'Retired Bundle (fixture)', sku: 'SKU-RET', description: null, serving_tier: 'family', price: '90.00', business_id: BIZ_ID, image_url: null, stock_on_hand: '0', is_active: false, show_on_storefront: true, catalog_id: null, family_id: 'fam-ret', is_surplus: false, order_cutoff_date: null },
];
/** bundle_contents for b-s5 in POSITION order (what the SQL's ORDER BY returns), with internal recipe columns. */
const CONTENT_ROWS: Row[] = S5_MEALS.map((m, i) => ({
    id: `bc-${i}`, bundle_id: 'b-s5', recipe_id: `r-INTERNAL-${i}`, position: i + 1, quantity: 1,
    recipe_name: m.name, recipe_description: m.description, recipe_image_url: m.image_url, recipe_cook_time: m.cook_time,
    recipe_allergens: m.allergens, recipe_macros: null,
}));

function pageMock(over: { campaign?: Row } = {}): PrismaMock {
    const business = { id: BIZ_ID, name: 'Cedar Kitchen (fixture)', display_name: null, slug: SLUG, logo_url: null, timezone: 'America/Chicago', custom_domain: null };
    const campaignRow = {
        id: CAMPAIGN_ID, name: `${ORG} Fundraiser`, about_text: null, participant_label: null,
        end_date: new Date('2099-01-01T00:00:00.000Z'), delivery_date: null, pickup_location: null, delivery_time: null,
        payment_instructions: null, external_payment_link: null, bundle_goal: 20, total_sales: '0',
        status: 'Active', closed_at: null, tax_status: null, tax_rate_percent: null,
        bundle_selection_status: 'selected', bundle_selection_limit: 1,
        organization_name: ORG, customer_fundraiser_info: {}, portal_token: 'PORTAL-SECRET',
        ...(over.campaign || {}),
    };
    return createPrismaMock({
        results: {
            'business.findUnique': business,
            'campaignBundle.findMany': [
                { bundle: { id: 'b-s5', business_id: BIZ_ID, is_active: true, family_id: 'fam-INTERNAL', serving_tier: 'family' } },
                { bundle: { id: 'b-s2', business_id: BIZ_ID, is_active: true, family_id: 'fam-INTERNAL', serving_tier: 'serves_2' } },
            ],
            $queryRaw: ({ sql, values }: { sql: string; values: any[] }) => {
                // Prisma.join(...) arrives as one Sql value carrying its own `values`; arrays arrive whole.
                const flat = values.reduce((acc: any[], v: any) => acc.concat(v && typeof v === 'object' && Array.isArray(v.values) ? v.values : Array.isArray(v) ? v : [v]), []);
                if (/FROM tenant_branding/.test(sql)) return [{ id: 7, user_id: 'user-INTERNAL', primary_color: PRIMARY, logo_url: null }];
                if (/FROM fundraiser_campaigns fc/.test(sql)) return [campaignRow];
                if (/FROM orders o/.test(sql)) return [];
                if (/FROM bundle_contents bc/.test(sql)) return CONTENT_ROWS.filter((r) => flat.includes(r.bundle_id));
                if (/FROM bundles/.test(sql)) {
                    // Honour the lineup query's own filters, so a query that stops filtering is caught.
                    let rows = BUNDLE_ROWS.slice();
                    if (/WHERE id IN/.test(sql)) rows = rows.filter((r) => flat.includes(r.id));
                    if (/business_id = /.test(sql)) rows = rows.filter((r) => flat.includes(r.business_id));
                    if (/is_active = true/.test(sql)) rows = rows.filter((r) => r.is_active);
                    if (/show_on_storefront = true/.test(sql)) rows = rows.filter((r) => r.show_on_storefront);
                    return rows;
                }
                return [];
            },
        },
    });
}
const usePrisma = (m: PrismaMock) => { (global as any).__soc1Prisma = m.client; return m; };
const pageParams = () => ({ params: Promise.resolve({ slug: SLUG, fundraiserId: CAMPAIGN_ID }) });
const renderPage = async (over: { campaign?: Row } = {}) => {
    const mock = usePrisma(pageMock(over));
    const mod = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
    const el: any = await mod.default(pageParams());
    return { props: el.props, mock };
};

describe('H. campaign scope and the public payload (page.tsx)', () => {
    it('H1. only THIS campaign\'s active lineup reaches the page — not the tenant\'s other or inactive bundles', async () => {
        const { props } = await renderPage();
        expect(props.business.bundles.map((b: any) => b.id)).toEqual(['b-s5', 'b-s2']);
        const json = JSON.stringify(props);
        expect(json).not.toContain('b-old');
        expect(json).not.toContain('b-inactive');
    });

    it('H2. the meals arrive in position order (the SQL orders them; position itself stays server-side)', async () => {
        const { props, mock } = await renderPage();
        const sql = mock.calls.filter((c) => c.model === '$queryRaw').map((c) => c.args.sql).find((s: string) => /FROM bundle_contents bc/.test(s))!;
        expect(sql).toMatch(/ORDER BY bc\.position ASC NULLS LAST/);
        const s5 = props.business.bundles.find((b: any) => b.id === 'b-s5');
        expect(s5.items.map((i: any) => i.recipe.name)).toEqual(S5_MEALS.map((m) => m.name));
        for (const i of s5.items) expect(Object.keys(i).sort()).toEqual(['quantity', 'recipe']);
    });

    it('H3. every field the detail needs is already public — and nothing more', async () => {
        const { props } = await renderPage();
        const s5 = props.business.bundles.find((b: any) => b.id === 'b-s5');
        expect(Object.keys(s5).sort()).toEqual(['description', 'id', 'image_url', 'items', 'name', 'price', 'serving_tier']);
        expect(Object.keys(s5.items[0].recipe).sort()).toEqual(['allergens', 'cook_time', 'description', 'image_url', 'macros', 'name']);
        expect(s5.items[0].recipe).toMatchObject({ name: S5_MEALS[0].name, description: S5_MEALS[0].description, image_url: IMG('m-zesty'), cook_time: '45-60 min', allergens: 'Dairy' });
        const json = JSON.stringify(props);
        for (const secret of ['SKU-INTERNAL', 'cat-INTERNAL', 'fam-INTERNAL', 'r-INTERNAL', 'user-INTERNAL', 'PORTAL-SECRET', BIZ_ID, 'stock_on_hand', '"position"', 'bundle_id', 'America/Chicago']) {
            expect(json).not.toContain(secret);
        }
    });

    it('H4. the include-lists were not widened by this feature', () => {
        expect([...PUBLIC_SUPPORTER_BUNDLE_FIELDS]).toEqual(['id', 'name', 'description', 'serving_tier', 'price', 'image_url']);
        expect([...PUBLIC_SUPPORTER_RECIPE_FIELDS]).toEqual(['name', 'description', 'image_url', 'cook_time', 'allergens', 'macros']);
    });

    it('H5. internal bundle and recipe columns cannot cross even if a query starts selecting them', () => {
        const biz = toPublicSupporterBusiness({ name: 'N', display_name: null, slug: 's', logo_url: null } as any, {} as any, [{
            ...BUNDLE_ROWS[0],
            items: [{ id: 'i', recipe_id: 'r', bundle_id: 'b', position: 3, quantity: 1, recipe: {
                name: 'R', description: 'D', image_url: null, cook_time: null, allergens: null, macros: null,
                instructions: 'SECRET-STEPS', label_text: 'SECRET-LABEL', business_id: 'SECRET-BIZ', sku: 'SECRET-SKU', base_yield_qty: 9, storage_instructions: 'SECRET-STORAGE', dcg_id: 'SECRET-DCG',
            } }],
        }] as any);
        const json = JSON.stringify(biz);
        expect(json).not.toMatch(/SECRET-|base_yield_qty|recipe_id|"position"|SKU-INTERNAL|fam-INTERNAL|cat-INTERNAL/);
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_FIELDS.bundle) expect(biz.bundles[0]).not.toHaveProperty(f);
        for (const f of FORBIDDEN_PUBLIC_SUPPORTER_FIELDS.item) expect(biz.bundles[0].items[0]).not.toHaveProperty(f);
    });

    it('H6. a closed or pending campaign shows no cards, so no detail can open', () => {
        for (const orderMode of [{ allowed: false, mode: 'closed', safeMessage: 'Closed.' }, { allowed: false, mode: 'pending' }, { allowed: false, mode: 'invalid' }]) {
            const m = mount({ orderMode });
            expect(findAll(m.tree, (el) => el.type === 'button' && el.props.className === 'fr-bundle-open')).toHaveLength(0);
            expect(dialogOf(m.tree)).toBeNull();
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('I. phone layout, accessibility, performance', () => {
    const css = SUPPORTER_BUNDLE_DETAIL_CSS;

    it('I1. no fixed width anywhere in the detail: the panel is 100% wide with a desktop ceiling, a sheet on phones', () => {
        const widths = [...css.matchAll(/(?:^|[\s;{])((?:min-|max-)?width):\s*([^;]+);/g)].map((m) => `${m[1]}: ${m[2].trim()}`);
        for (const w of widths) {
            expect(w).toMatch(/^(width: 100%|max-width: (34rem|none)|width: 36px)$/);
        }
        expect(css).toMatch(/@media \(max-width: 640px\)/);
        expect(css).toMatch(/\.fr-detail-overlay \{ align-items: flex-end; padding: 0; \}/);
        expect(css).toMatch(/max-height: 94dvh/);
        expect(css).toMatch(/max-height: 88dvh/);
        expect(css).not.toMatch(/overflow-x|100vw|white-space: nowrap/);
        const inline = read(DETAIL_PATH).replace(/SUPPORTER_BUNDLE_DETAIL_CSS = `[\s\S]*?`;/, '');
        expect(inline).not.toMatch(/width:\s*['"]?\d{3,}(?!%)/);              // no 3+ digit px widths inline either
    });

    it('I2. the meal list scrolls inside the panel; the close button and the action stay put', () => {
        expect(css).toMatch(/\.fr-detail-body \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
        expect(css).toMatch(/\.fr-detail-head \{ flex: none;/);
        expect(css).toMatch(/\.fr-detail-foot \{ flex: none;/);
        expect(css).toMatch(/env\(safe-area-inset-bottom/);
    });

    it('I3. the actions are full-width, ≥44px tap targets', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        expect(detailAdd(m.tree).props.style).toMatchObject({ width: '100%', minHeight: 48 });
        expect(one(m.tree, 'Close bundle details').props.style).toMatchObject({ width: 44, height: 44 });
        click(m, detailAdd(m.tree));
        openPhoto(m, bundleS5);
        for (const l of [`One more ${S5_NAME}`, `One fewer ${S5_NAME}`]) expect(one(m.tree, l).props.style).toMatchObject({ width: 44, height: 44 });
    });

    it('I4. a real dialog: role, aria-modal, a title it is named by, focus target, and the house focus hook', () => {
        const m = mount();
        openPhoto(m, bundleS5);
        const d = dialogOf(m.tree);
        expect(d.props['aria-modal']).toBe('true');
        expect(d.props.tabIndex).toBe(-1);
        const title = findAll(d, (el) => el.type === 'h2')[0];
        expect(d.props['aria-labelledby']).toBe(title.props.id);
        const client = read(CLIENT_PATH);
        expect(client).toContain("import { useDialogFocus } from '@/components/crm2/useDialogFocus';");
        expect(client).toMatch(/useDialogFocus\(detailOpen, detailBundleId\)/);
        expect(client).toMatch(/panelRef=\{detailPanelRef\}/);
        expect(read(DETAIL_PATH)).toMatch(/ref=\{panelRef\}/);
        // the hook: focus in, scroll lock, focus back to the trigger, Tab contained
        const hook = read('components/crm2/useDialogFocus.ts');
        expect(hook).toContain('panelRef.current?.focus()');
        expect(hook).toContain('restoreFocusRef.current?.focus?.()');
        expect(hook).toContain("document.body.style.overflow = 'hidden'");
    });

    it('I5. every control is a <button> with a name; the photo triggers say they open a dialog', () => {
        const m = mount();
        for (const b of findAll(m.tree, (el) => el.props && el.props.className === 'fr-bundle-open')) {
            expect(b.type).toBe('button');
            expect(b.props.type).toBe('button');
            expect(b.props['aria-haspopup']).toBe('dialog');
            expect(b.props['aria-label']).toBeTruthy();
        }
        openPhoto(m, bundleS5);
        for (const b of buttons(dialogOf(m.tree))) expect(b.props['aria-label'] || textOf(b)).toBeTruthy();
        const detail = read(DETAIL_PATH);
        expect(detail).not.toMatch(/<(span|img|li|b|p|h2|h3)\s[^>]*onClick/);
        expect(css).toMatch(/button:focus-visible \{ outline: 3px solid #3b2a2f;/);
        expect(read(CLIENT_PATH)).toContain('.fr-bundle-open:focus-visible { outline: 3px solid #3b2a2f;');
    });

    it('I6. performance: meal photos are not on the page until a detail opens; card photos after the first are lazy', () => {
        const html = renderToStaticMarkup(createElement(loadClient(), clientProps()));
        expect(html).not.toContain(IMG('m-zesty'));
        expect(html).not.toContain(IMG('m-beef'));
        const m = mount();
        const imgs = findAll(m.tree, (el) => el.type === 'img' && /harvest-/.test(el.props.src));
        expect(imgs.map((i) => i.props.loading)).toEqual(['eager', 'lazy']);
        expect(imgs.every((i) => i.props.decoding === 'async')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('J. regression', () => {
    it('J1. ordering is unchanged: the card Add path submits exactly what it did before', async () => {
        const m = mount();
        click(m, one(m.tree, `Add ${S5_NAME} to your order`));
        click(m, one(m.tree, `Increase ${S5_NAME} quantity`));
        await fillContactAndSubmit(m);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/public/order');
        const body = lastBody();
        expect(body.items).toEqual([{ bundleId: 'b-s5', quantity: 2, serving_tier: 'family', name: S5_NAME }]);
        expect(body.campaignId).toBe(CAMPAIGN_ID);
        expect(body.slug).toBe(SLUG);
        expect(Object.keys(body).sort()).toEqual(['campaignId', 'customer', 'items', 'slug', 'submissionKey']);
    });

    it('J2. the pre-order share stays after "Place my order" and in the quiet style; the detail adds no share control', () => {
        const m = mount();
        const all: any[] = [];
        walk(m.tree, (el: any) => all.push(el));
        const order = byText(m.tree, /^Place my order/)[0];
        const share = one(m.tree, 'Share this fundraiser');
        expect(all.indexOf(order)).toBeLessThan(all.indexOf(share));
        expect(share.props.style.background).not.toBe(PRIMARY);
        expect(order.props.style.background).toBe(PRIMARY);
        openPhoto(m, bundleS5);
        expect(buttons(dialogOf(m.tree)).some((b) => /share/i.test(`${b.props['aria-label'] || ''} ${textOf(b)}`))).toBe(false);
    });

    it('J3. the deadline pill and progress still render from the server descriptor', () => {
        const html = renderToStaticMarkup(createElement(loadClient(), clientProps({ deadline: { kind: 'today' } }))).replace(/<!-- -->/g, '');
        expect(html).toMatch(/Today/);
        expect(html).toContain('4 of 20 bundles');
    });

    it('J4. sample mode: the detail works for browsing and adding, and still nothing can be submitted', async () => {
        const m = mount({ sampleMode: true, shareUrl: null });
        openPhoto(m, bundleS5);
        click(m, detailAdd(m.tree));
        expect(orderHeading(m.tree)).toBe('Your order · $125.00');
        await fillContactAndSubmit(m);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('J5. no schema, payload-module, pricing, tax or order-route change ships with this feature', () => {
        const lib = read(LIB_PATH);
        expect(lib).not.toMatch(/prisma|fetch\(|process\.env/);
        expect(read(PAGE_PATH)).toMatch(/ORDER BY bc\.position ASC NULLS LAST/);
    });
});
