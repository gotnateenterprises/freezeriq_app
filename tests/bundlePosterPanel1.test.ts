/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the Bundle Poster panel, driven like a tenant would use it:
 * Generate → Preview / Download → change a setting → Regenerate. No DOM: the real component runs on
 * the small hook runtime in tests/helpers/hookRuntime, and fetch / object URLs are faked.
 */
jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());

import { findAll, mountComponent, textOf } from './helpers/hookRuntime';
import BundlePosterPanel from '@/components/bundles/BundlePosterPanel';

const props = {
    bundleId: 'b-keto-s5', bundleName: 'Keto - Winter 27', sizeLabel: 'Serves 5', mealCount: 5, photoCount: 5,
    defaultTheme: 'winter' as const, derivedBadge: 'Keto Meal Favorites',
};

let calls: { url: string; init: any }[] = [];
let reply: { ok: boolean; headers?: Record<string, string>; json?: any } = { ok: true };
let urlN = 0;

beforeEach(() => {
    calls = [];
    urlN = 0;
    reply = {
        ok: true,
        headers: {
            'Content-Disposition': 'inline; filename="Keto-Winter-27-Serves-5-poster.jpg"',
            'X-Poster-Background': 'ai', 'X-Poster-Background-Note': 'none',
            'X-Poster-Photos': 'placed,placed,placed,placed,missing', 'X-Poster-Omitted-Meals': '0',
        },
    };
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        return {
            ok: reply.ok,
            status: reply.ok ? 200 : 500,
            blob: async () => new Blob([Buffer.from('ffd8ff', 'hex')], { type: 'image/jpeg' }),
            json: async () => reply.json ?? {},
            headers: { get: (k: string) => reply.headers?.[k] ?? null },
        };
    });
    (URL as any).createObjectURL = jest.fn(() => `blob:poster-${++urlN}`);
    (URL as any).revokeObjectURL = jest.fn();
});

const button = (tree: any, text: RegExp) => findAll(tree, (el) => el.type === 'button' && text.test(textOf(el)))[0];
const links = (tree: any) => findAll(tree, (el) => el.type === 'a');

it('Generate posts the chosen theme, instructions and badge flag for THIS bundle, then offers Preview and Download', async () => {
    const m = mountComponent(BundlePosterPanel, props);
    expect(links(m.tree)).toHaveLength(0);
    const ta = findAll(m.tree, (el) => el.type === 'textarea')[0];
    ta.props.onChange({ target: { value: 'Snowy cabin window with pine branches.' } });
    m.render();
    await button(m.tree, /Generate Poster/).props.onClick();
    m.render();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/bundles/b-keto-s5/poster');
    expect(JSON.parse(calls[0].init.body)).toEqual({ theme: 'winter', backgroundInstructions: 'Snowy cabin window with pine branches.', showBadge: true });

    const [preview, download] = links(m.tree);
    expect(textOf(preview)).toBe('Preview Poster');
    expect(preview.props.href).toBe('blob:poster-1');
    expect(preview.props.target).toBe('_blank');
    expect(textOf(download)).toBe('Download Poster');
    expect(download.props.download).toBe('Keto-Winter-27-Serves-5-poster.jpg');
    expect(findAll(m.tree, (el) => el.type === 'img')[0].props.src).toBe('blob:poster-1');
    const text = textOf(m.tree);
    expect(text).toContain('Background: AI-generated Winter scene.');
    expect(text).toContain('1 of 5 meals had no usable photo');
    expect(button(m.tree, /Regenerate/)).toBeTruthy();
});

it('changing the theme after a poster exists marks it out of date; Regenerate replaces it and frees the old one', async () => {
    const m = mountComponent(BundlePosterPanel, props);
    await button(m.tree, /Generate Poster/).props.onClick();
    m.render();
    expect(textOf(m.tree)).not.toContain('Settings changed');

    findAll(m.tree, (el) => el.type === 'select')[0].props.onChange({ target: { value: 'fall' } });
    m.render();
    expect(textOf(m.tree)).toContain('Settings changed since this poster was made. Click Regenerate to update it.');

    await button(m.tree, /Regenerate/).props.onClick();
    m.render();
    expect(JSON.parse(calls[1].init.body).theme).toBe('fall');
    expect(findAll(m.tree, (el) => el.type === 'img')[0].props.src).toBe('blob:poster-2');
    expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:poster-1');
    expect(textOf(m.tree)).not.toContain('Settings changed');
});

it('an unknown theme value from the control falls back to the default; hiding the badge is sent', async () => {
    const m = mountComponent(BundlePosterPanel, props);
    findAll(m.tree, (el) => el.type === 'select')[0].props.onChange({ target: { value: '__proto__' } });
    findAll(m.tree, (el) => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } });
    m.render();
    await button(m.tree, /Generate Poster/).props.onClick();
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ theme: 'winter', showBadge: false });
});

it('a failure shows the server\'s message and leaves no poster to download', async () => {
    reply = { ok: false, json: { error: 'Add recipes to this bundle before making its poster.' } };
    const m = mountComponent(BundlePosterPanel, props);
    await button(m.tree, /Generate Poster/).props.onClick();
    m.render();
    expect(textOf(m.tree)).toContain('Add recipes to this bundle before making its poster.');
    expect(links(m.tree)).toHaveLength(0);
});

it('a double click sends one request', async () => {
    const m = mountComponent(BundlePosterPanel, props);
    const click = button(m.tree, /Generate Poster/).props.onClick;
    await Promise.all([click(), click()]);
    expect(calls).toHaveLength(1);
});
