/**
 * BUNDLE-EDITOR-UX-1 (owner-approved 2026-11-25) — the Bundle Editor cleanup.
 *
 *  A. lib/bundleSkuGenerator.ts — the one SKU generator (format unchanged; AO for a fundraiser add-on).
 *  B. lib/bundleEditorSave.ts — Save sends the same values; a NEW bundle without a SKU gets a valid one and a
 *     duplicate-SKU 409 is retried with a fresh one; a typed or EXISTING SKU is never replaced.
 *  C. The editor itself, rendered (static) for new/existing × meal/add-on: what each tenant sees.
 *  D. The fundraiser add-on poster prints no serving size; meal posters are unchanged.
 *  E. Scope: the API, schema and migrations are untouched.
 *
 * jest runs without a DOM here, so the editor is rendered to static markup (react-hook-form renders on the
 * server) and its event handlers are pinned at source level. All data is fictional.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { generateBundleSku, skuPlatformPrefix, skuSizeSuffix } from '@/lib/bundleSkuGenerator';
import { MAX_AUTO_SKU_ATTEMPTS, saveBundle } from '@/lib/bundleEditorSave';
import { buildPosterModel, posterFileName, posterSizeLabel } from '@/lib/poster/posterModel';
import { POSTER_BUNDLE_SELECT, posterBundleFingerprint, sha256Hex } from '@/lib/poster/posterPublish';
import { parseFontMetrics } from '@/lib/poster/fontMetrics';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__beuPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => ({ user: { businessId: 'biz-beu-1', role: 'ADMIN', id: 'user-beu-1' } })) }));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const RC = 'a419087'; // the add-on release candidate this cleanup is built on

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('A · the SKU generator (one implementation, same format)', () => {
    const fixed = (n: number) => () => n; // random() -> n  =>  1000 + floor(n * 9000)

    it('prefix by platform, defaulting to the neutral OT (a tenant never has to pick a platform)', () => {
        expect([skuPlatformPrefix('square'), skuPlatformPrefix('qb'), skuPlatformPrefix('other'), skuPlatformPrefix(undefined), skuPlatformPrefix('anything')])
            .toEqual(['SQ', 'QB', 'OT', 'OT', 'OT']);
    });

    it('size suffix: the standard tiers, the strict tier names, custom tiers, and AO for an add-on', () => {
        expect(['family', 'couple', 'single', 'serves_5', 'serves_2'].map((t) => skuSizeSuffix(t))).toEqual(['FS', 'S2', 'SS', 'FS', 'S2']);
        expect(skuSizeSuffix('Family Size Keto')).toBe('FSK');
        expect(skuSizeSuffix('Couple Keto')).toBe('S2K');
        expect(skuSizeSuffix('Family Clean Eating')).toBe('FSCE');
        expect(skuSizeSuffix('', undefined)).toBe('FS');
        expect(skuSizeSuffix(undefined)).toBe('FS');
        // A fundraiser add-on has no serving size, so its SKU never reads as Family Size on kitchen screens.
        expect(skuSizeSuffix('family', 'addon')).toBe('AO');
    });

    it('whole SKU: <prefix><4 digits 1000–9999><suffix>', () => {
        expect(generateBundleSku({ platform: 'qb', servingTier: 'family', random: fixed(0) })).toBe('QB1000FS');
        expect(generateBundleSku({ platform: 'square', servingTier: 'couple', random: fixed(0.9999) })).toBe('SQ9999S2');
        expect(generateBundleSku({ servingTier: 'family', bundleType: 'addon', random: fixed(0.5) })).toBe('OT5500AO');
        for (let i = 0; i < 200; i++) {
            expect(generateBundleSku({ servingTier: 'Family Size Keto' })).toMatch(/^OT[1-9]\d{3}FSK$/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('B · Save Bundle: same request, and a valid unique SKU for a NEW bundle', () => {
    type Call = { url: string; method: string; body: any };
    const fetchSequence = (replies: Array<{ status: number; body?: any }>) => {
        const calls: Call[] = [];
        let i = 0;
        const impl = jest.fn(async (url: string, init: any) => {
            calls.push({ url, method: init.method, body: JSON.parse(init.body) });
            const r = replies[Math.min(i++, replies.length - 1)];
            return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} } as any;
        });
        return { impl: impl as unknown as typeof fetch, calls };
    };
    const MEAL = { name: 'Harvest Supper (fixture)', sku: '', description: '', serving_tier: 'family', catalog_id: '', image_url: '', price: '125', is_active: true, show_on_storefront: false, bundle_type: 'meal', order_cutoff_date: '', contents: [{ recipe_id: 'r1', name: 'Chicken Bake', quantity: 1 }] };

    it('a new bundle with no SKU: POSTs once with a generated OT SKU; every other value exactly as the form had it', async () => {
        const f = fetchSequence([{ status: 201, body: { id: 'b1' } }]);
        const r = await saveBundle({ isNew: true, data: MEAL, fetchImpl: f.impl, random: () => 0.25 });
        expect(r).toEqual({ ok: true, sku: 'OT3250FS', autoSku: true, attempts: 1 });
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]).toMatchObject({ url: '/api/bundles', method: 'POST' });
        expect(f.calls[0].body).toEqual({ ...MEAL, sku: 'OT3250FS' });
    });

    it('a new fundraiser add-on gets an AO SKU', async () => {
        const f = fetchSequence([{ status: 201 }]);
        const r = await saveBundle({ isNew: true, data: { ...MEAL, bundle_type: 'addon' }, fetchImpl: f.impl, random: () => 0 });
        expect(r).toMatchObject({ ok: true, sku: 'OT1000AO' });
    });

    it('a generated SKU that collides (409 "SKU must be unique") is replaced and the save retried', async () => {
        const f = fetchSequence([{ status: 409, body: { error: 'SKU must be unique' } }, { status: 409, body: { error: 'SKU must be unique' } }, { status: 201 }]);
        let n = 0;
        const r = await saveBundle({ isNew: true, data: MEAL, fetchImpl: f.impl, random: () => [0.1, 0.2, 0.3][n++] });
        expect(r).toEqual({ ok: true, sku: 'OT3700FS', autoSku: true, attempts: 3 });
        expect(f.calls.map((c) => c.body.sku)).toEqual(['OT1900FS', 'OT2800FS', 'OT3700FS']);
    });

    it('the retry is bounded: after the last attempt the tenant is told, and it is flagged as a SKU problem', async () => {
        const f = fetchSequence([{ status: 409, body: { error: 'SKU must be unique' } }]);
        const r = await saveBundle({ isNew: true, data: MEAL, fetchImpl: f.impl });
        expect(r).toMatchObject({ ok: false, status: 409, skuProblem: true, attempts: MAX_AUTO_SKU_ATTEMPTS });
        expect(f.calls).toHaveLength(MAX_AUTO_SKU_ATTEMPTS);
    });

    it('a SKU the tenant TYPED is never replaced: a collision is reported, not retried', async () => {
        const f = fetchSequence([{ status: 409, body: { error: 'SKU must be unique' } }]);
        const r = await saveBundle({ isNew: true, data: { ...MEAL, sku: 'SQ1234FS' }, fetchImpl: f.impl });
        expect(r).toMatchObject({ ok: false, skuProblem: true, attempts: 1 });
        expect(f.calls[0].body.sku).toBe('SQ1234FS');
    });

    it('an EXISTING bundle: PUT with its SKU exactly as loaded — never generated, never changed (even if blank)', async () => {
        const f = fetchSequence([{ status: 200 }]);
        await saveBundle({ isNew: false, bundleId: 'b-77', data: { ...MEAL, sku: 'QB4821FS' }, fetchImpl: f.impl });
        expect(f.calls[0]).toMatchObject({ url: '/api/bundles/b-77', method: 'PUT' });
        expect(f.calls[0].body).toEqual({ ...MEAL, sku: 'QB4821FS' });
        const g = fetchSequence([{ status: 400, body: { error: 'Bundle SKU is required.' } }]);
        const r = await saveBundle({ isNew: false, bundleId: 'b-77', data: { ...MEAL, sku: '' }, fetchImpl: g.impl });
        expect(g.calls[0].body.sku).toBe('');
        expect(r).toMatchObject({ ok: false, skuProblem: true, attempts: 1 });
    });

    it('against the REAL create route: a taken SKU is refused 409 by the database rule and the next one is saved', async () => {
        const { createPrismaMock } = require('./helpers/routeHarness');
        const taken = new Set(['OT1000FS']); // an existing bundle (another tenant's, even) already uses this SKU
        const created: any[] = [];
        const mock = createPrismaMock({
            results: {
                'recipe.findMany': [],
                'bundle.create': (args: any) => {
                    if (taken.has(args.data.sku)) throw Object.assign(new Error('Unique constraint failed on the fields: (`sku`)'), { code: 'P2002' });
                    created.push(args.data);
                    return { id: 'b-new', ...args.data };
                },
            },
        });
        (global as any).__beuPrisma = mock.client;
        const { POST } = require('@/app/api/bundles/route');
        const realRoute = (async (url: string, init: any) => {
            expect(url).toBe('/api/bundles');
            return POST(new Request('http://localhost/api/bundles', init));
        }) as unknown as typeof fetch;
        let n = 0;
        const r = await saveBundle({ isNew: true, data: { ...MEAL, contents: [] }, fetchImpl: realRoute, random: () => [0, 0.5][n++] });
        expect(r).toEqual({ ok: true, sku: 'OT5500FS', autoSku: true, attempts: 2 });
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ sku: 'OT5500FS', name: MEAL.name, business_id: 'biz-beu-1' });
        expect(mock.callsTo('bundle.create')).toHaveLength(2);
    });

    it('other failures are not retried and keep the server\'s message; a network failure is reported', async () => {
        const f = fetchSequence([{ status: 400, body: { error: 'Name and SKU are required' } }]);
        expect(await saveBundle({ isNew: true, data: MEAL, fetchImpl: f.impl })).toMatchObject({ ok: false, status: 400, error: 'Name and SKU are required', attempts: 1 });
        const boom = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
        expect(await saveBundle({ isNew: true, data: MEAL, fetchImpl: boom })).toMatchObject({ ok: false, status: null, error: 'Failed to save bundle.' });
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('C · the editor, rendered', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BundleEditor = require('@/components/BundleEditor').default;
    const { DESCRIPTION_HELP, NEW_BUNDLE_POSTER_MESSAGE, POSTER_STUDIO_ANCHOR_ID } = require('@/components/BundleEditor');
    const recipes = [{ id: 'r1', name: 'Chicken Bake (fixture)', type: 'menu_item' }];
    const saved = (over: Record<string, any> = {}) => ({
        id: 'b-1', name: 'Harvest Supper (fixture)', sku: 'QB4821FS', description: 'Three family meals.', serving_tier: 'family',
        catalog_id: 'cat-1', image_url: '', price: 125, stock_on_hand: -4, is_active: true, show_on_storefront: true,
        bundle_type: 'meal', order_cutoff_date: null, contents: [{ recipe_id: 'r1', quantity: 1, recipe: { name: 'Chicken Bake (fixture)' } }], ...over,
    });
    const html = (props: Record<string, any>) => renderToStaticMarkup(React.createElement(BundleEditor, { allRecipes: recipes, knownTiers: ['family', 'Couple Keto'], ...props }));
    const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

    it('new meal bundle: image controls, details, collapsed Advanced, save-first poster card, no legacy controls', () => {
        const h = html({ initialData: null });
        const t = text(h);
        for (const s of ['Bundle Image', 'Upload Image', 'Create Bundle Poster', 'Use an image link instead', 'Bundle Details', 'Bundle type', 'Bundle Name',
            'Serving Size Tier', 'Selling Price ($)', 'Description', DESCRIPTION_HELP, 'Active Status', 'Show on Customer Storefront',
            'Advanced Settings', 'Catalog & retail options', 'SKU created automatically when you save', 'Bundle Contents', 'Bundle Poster Studio',
            NEW_BUNDLE_POSTER_MESSAGE, 'Bundle Summary']) {
            expect({ s, shown: t.includes(s) }).toEqual({ s, shown: true });
        }
        // gone: the stock-photo "Generate AI", the never-saved Stock Quantity, the "Internal notes" placeholder
        for (const s of ['Generate AI', 'Stock Quantity', 'Internal notes', 'Auto Generate']) expect({ s, shown: t.includes(s) }).toEqual({ s, shown: false });
        // new bundle: no Delete, no Make Serves 2; the poster anchor exists; Advanced is a closed <details>
        expect(t).not.toContain('Delete Bundle');
        expect(t).not.toContain('Make Serves 2');
        expect(h).toContain(`id="${POSTER_STUDIO_ANCHOR_ID}"`);
        expect(h).not.toMatch(/<details[^>]*\sopen/);
        expect(h).toContain('placeholder="Created automatically when you save"');
        // one Save handler, reachable on every screen: the header button (lg+) and the sticky bar (below lg)
        expect((t.match(/Save Bundle/g) || []).length).toBe(2);
    });

    it('existing meal bundle: Catalog and SKU live in Advanced (summary shows the saved SKU); Delete and Make Serves 2 stay', () => {
        const h = html({ initialData: saved() });
        const t = text(h);
        expect(t).toContain('SKU QB4821FS');
        expect(h).toContain('id="bundle-catalog"');
        expect(h).toContain('id="bundle-sku"');
        expect(t).toContain('Changing an existing SKU can break a Square point-of-sale item link.');
        expect(t).toContain('Delete Bundle');
        expect(t).toContain('Make Serves 2');
        expect(t).toContain('Visible to public');
        // the poster the page hands over replaces the save-first card
        const withPanel = html({ initialData: saved(), posterStudio: React.createElement('div', null, 'PANEL-FIXTURE') });
        expect(withPanel).toContain('PANEL-FIXTURE');
        expect(withPanel).not.toContain(NEW_BUNDLE_POSTER_MESSAGE);
    });

    it('fundraiser add-on: no serving size, no storefront, no Catalog, no Make Serves 2 — the type note explains', () => {
        const h = html({ initialData: saved({ bundle_type: 'addon', name: 'Sides & Dessert (fixture)', sku: 'OT1234AO', catalog_id: '', show_on_storefront: false }) });
        const t = text(h);
        for (const s of ['Serving Size Tier', 'Show on Customer Storefront', 'Make Serves 2', 'Family Size (Serves 5)']) expect({ s, shown: t.includes(s) }).toEqual({ s, shown: false });
        expect(h).not.toContain('id="bundle-catalog"');
        expect(h).toContain('id="bundle-sku"');
        expect(t).toContain('It has one size and is never shown on the storefront.');
        expect(t).toContain('Not on the storefront');
        expect(t).toContain('Fundraiser add-on');
        expect(t).toContain('SKU OT1234AO');
    });

    it('layout: a container query decides the two columns (sidebar-aware); nothing forces a fixed width', () => {
        const src = R('components/BundleEditor.tsx');
        expect(src).toContain('@container max-w-6xl');
        expect(src).toContain('grid grid-cols-1 @4xl:grid-cols-2');
        expect(src).not.toContain('whitespace-nowrap');
        expect(src).not.toMatch(/\bw-48\b/);
        expect(src).toContain('fixed inset-x-0 bottom-0 z-30');
        expect(src).toContain('lg:hidden');
        // Exactly one Save is SHOWN at any width: the header one from lg up, the sticky one below lg.
        const h = renderToStaticMarkup(React.createElement(require('@/components/BundleEditor').default, { initialData: null, allRecipes: [], knownTiers: [] }));
        const saves = [...h.matchAll(/<button type="button" class="([^"]*)"[^>]*>(?:(?!<\/button>).)*Save Bundle/gs)].map((m) => m[1]);
        expect(saves).toHaveLength(2);
        expect(saves[0]).toMatch(/(^| )hidden( |$)/);
        expect(saves[0]).toMatch(/(^| )lg:inline-flex( |$)/);
        expect(saves[1]).toMatch(/(^| )flex( |$)/);
        expect(saves[1]).not.toMatch(/(^| )hidden( |$)/);
        expect(h).toMatch(/<div class="fixed inset-x-0 bottom-0 z-30[^"]*lg:hidden[^"]*">\s*<button type="button" class="flex w-full/);
    });

    it('Create Bundle Poster only scrolls: no request, no AI call — and the legacy endpoint is gone from the editor', () => {
        const src = R('components/BundleEditor.tsx');
        const nav = src.slice(src.indexOf('const goToPosterStudio = () => {'), src.indexOf('// The existing generator rules'));
        expect(nav).toContain('scrollIntoView');
        expect(nav).not.toMatch(/fetch\(|\/api\//);
        expect(src).not.toContain('/api/ai/generate-image');
        expect(src).not.toContain('/api/integrations/keys');
        expect(src).toMatch(/onClick=\{goToPosterStudio\}/);
    });

    it('save goes through the shared helper; Stock Quantity is not in the form; hidden values are kept', () => {
        const src = R('components/BundleEditor.tsx');
        expect(src).toContain("const result = await saveBundle({ isNew, bundleId: initialData?.id ?? null, data });");
        expect(src).not.toContain('stock_on_hand');
        // react-hook-form keeps the values of fields that are not rendered (no shouldUnregister) and Advanced is
        // a native <details> (its inputs stay in the form while closed).
        expect(src).not.toContain('shouldUnregister');
        expect(src).toMatch(/<details ref=\{advancedRef\}/);
        // SKU is required only for an existing bundle; a missing one opens Advanced instead of failing silently.
        expect(src).toContain("{...register('sku', { required: !isNew })}");
        expect(src).toContain('if (invalid.sku) openAdvanced();');
        expect(src).toContain('if (result.skuProblem) openAdvanced();');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('D · the fundraiser add-on poster prints no serving size; meal posters are unchanged', () => {
    const ROW = { id: 'b-1', name: 'Sides & Dessert Bundle', serving_tier: 'family', description: null, contents: [{ position: 0, recipe: { id: 'r1', name: 'Green Beans', image_url: null } }] };

    it('posterSizeLabel: meals keep Serves 5 / Serves 2; an add-on has none', () => {
        expect(posterSizeLabel('family', 'meal')).toBe('Serves 5');
        expect(posterSizeLabel('family', undefined)).toBe('Serves 5');
        expect(posterSizeLabel('couple', null)).toBe('Serves 2');
        expect(posterSizeLabel('family', 'addon')).toBeNull();
    });

    it('the model, the printed text plan and the download name: no "Serves" for an add-on', async () => {
        const meal = buildPosterModel(ROW, { theme: { seasonWord: null }, allowedHosts: [] });
        const addOn = buildPosterModel({ ...ROW, bundle_type: 'addon' }, { theme: { seasonWord: null }, allowedHosts: [] });
        expect(meal.sizeLabel).toBe('Serves 5');
        expect(addOn.sizeLabel).toBeNull();
        const { posterTextPlan } = await import('@/lib/poster/posterTemplate');
        const { posterThemeById } = await import('@/lib/poster/posterThemes');
        const bebas = parseFontMetrics(fs.readFileSync(path.join(ROOT, 'lib/poster/fonts/BebasNeue-Regular.ttf')));
        const anton = parseFontMetrics(fs.readFileSync(path.join(ROOT, 'lib/poster/fonts/Anton-Regular.ttf')));
        const theme = posterThemeById('winter');
        const mealPlan: any = posterTextPlan(buildPosterModel(ROW, { theme, allowedHosts: [] }), theme, { anton, bebas, pacifico: bebas });
        const addOnPlan: any = posterTextPlan(buildPosterModel({ ...ROW, bundle_type: 'addon' }, { theme, allowedHosts: [] }), theme, { anton, bebas, pacifico: bebas });
        expect(mealPlan.serves).not.toBeNull();
        expect(addOnPlan.serves).toBeNull();
        // every line of text the poster prints
        const printed = (p: any) => [p.season, p.title, p.serves, p.tagline, p.badge, ...(p.meals ?? []).map((m: any) => m.label)]
            .filter(Boolean).flatMap((f: any) => f.lines);
        expect(printed(mealPlan).join(' | ')).toMatch(/Serves 5/);
        expect(printed(addOnPlan).join(' | ')).not.toMatch(/serves/i);
        expect(posterFileName(addOn.bundleName, addOn.sizeLabel, 'jpg')).toBe('Sides-Dessert-Bundle-poster.jpg');
    });

    it('the panel text for an add-on has no "(Serves 5)"; both poster routes read bundle_type', () => {
        const BundlePosterPanel = require('@/components/bundles/BundlePosterPanel').default;
        const props = { bundleId: 'b-1', bundleName: 'Sides & Dessert Bundle', sizeLabel: null, mealCount: 3, photoCount: 3, defaultTheme: 'winter', derivedBadge: null };
        expect(renderToStaticMarkup(React.createElement(BundlePosterPanel, props))).not.toMatch(/Serves/);
        expect(Object.keys(POSTER_BUNDLE_SELECT)).toContain('bundle_type');
        expect(R('app/bundles/[id]/page.tsx')).toContain('sizeLabel: posterSizeLabel(rawBundle.serving_tier, (rawBundle as any).bundle_type),');
    });

    it('receipt fingerprints: a meal bundle hashes exactly as before; an add-on also binds its type', () => {
        const contents = [[0, 'r1', 'Green Beans', null]];
        const before = sha256Hex(JSON.stringify([ROW.id, ROW.name, ROW.serving_tier, null, contents]));
        expect(posterBundleFingerprint(ROW)).toBe(before);
        expect(posterBundleFingerprint({ ...ROW, bundle_type: 'meal' })).toBe(before);
        expect(posterBundleFingerprint({ ...ROW, bundle_type: 'addon' })).not.toBe(before);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('E · scope: presentation only', () => {
    const diff = (paths: string) => execSync(`git diff --name-only ${RC} -- ${paths}`, { cwd: ROOT, encoding: 'utf8' }).trim();

    it('no API, schema or migration change; pricing, kitchen, inventory and campaign code untouched', () => {
        // SUPERSEDED PIN (FR-ADDON-LAUNCH-FLOW-1 + INQUIRY-REPLY-EXTRA-1, owner-approved 2026-11-25): a LATER release
        // changes add-on, coordinator and inquiry code. This cleanup's own guarantee is checked against its commit
        // (284b43f on a419087): it changed none of these.
        const own = (paths: string) => execSync(`git diff --name-only ${RC} 284b43f -- ${paths}`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(own('app/api lib/bundleUpdate.ts lib/bundleTypeRules.ts prisma')).toBe('');
        expect(own('lib/pricing.ts lib/serving_multipliers.ts lib/kitchen_engine.ts lib/campaignAddOns.ts lib/campaignAddOnEarnings.ts lib/campaignAddOnShare.ts lib/ingestion')).toBe('');
        // And the later release still leaves the bundle write paths, pricing, kitchen and ingestion alone.
        expect(diff('app/api/bundles lib/bundleUpdate.ts lib/bundleTypeRules.ts lib/pricing.ts lib/serving_multipliers.ts lib/kitchen_engine.ts lib/campaignAddOnShare.ts lib/ingestion')).toBe('');
    });
});
