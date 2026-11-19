/**
 * BUNDLE-POSTER-USE-AS-IMAGE-1 — the Bundle Poster panel's "Use as Bundle Image", driven like a tenant
 * would: Generate → (Preview / Download) → Use as Bundle Image → confirm. No DOM: the real component
 * runs on tests/helpers/hookRuntime; fetch, object URLs and the page's event target are faked.
 */
jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());

import fs from 'fs';
import path from 'path';
import { findAll, mountComponent, textOf, walk } from './helpers/hookRuntime';
import BundlePosterPanel, { POSTER_PUBLISHED_MESSAGE, POSTER_REGENERATE_FIRST } from '@/components/bundles/BundlePosterPanel';
import {
    BUNDLE_IMAGE_PUBLISHED_EVENT, announceBundleImagePublished, publishedImageFor, subscribeBundleImagePublished,
} from '@/lib/bundles/bundleImageEvents';

const ROOT = path.join(__dirname, '..');
const props = {
    bundleId: 'b-keto-s5', bundleName: 'Keto - Winter 27', sizeLabel: 'Serves 5', mealCount: 5, photoCount: 5,
    defaultTheme: 'winter' as const, derivedBadge: 'Keto Meal Favorites',
};
const NEW_URL = 'https://media.example.test/preview/1795000000001-bundle_biz-fixture-a_poster.jpg';

let calls: { url: string; init: any }[] = [];
let posterReply: { ok: boolean; receipt?: string | null; json?: any };
let publishReply: { status: number; json: any };
let urlN = 0;
let receiptN = 0;
let announced: { bundleId: string; imageUrl: string }[] = [];
let pageTarget: EventTarget;

beforeEach(() => {
    calls = [];
    urlN = 0;
    receiptN = 0;
    announced = [];
    posterReply = { ok: true };
    publishReply = { status: 200, json: { imageUrl: NEW_URL, bundleId: 'b-keto-s5', message: 'Bundle image updated successfully.' } };
    pageTarget = new EventTarget();
    (global as any).window = pageTarget;
    pageTarget.addEventListener(BUNDLE_IMAGE_PUBLISHED_EVENT, (e) => announced.push((e as CustomEvent).detail));
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        if (url.endsWith('/poster/publish')) {
            return { ok: publishReply.status >= 200 && publishReply.status < 300, status: publishReply.status, json: async () => publishReply.json };
        }
        const receipt = posterReply.receipt === undefined ? `receipt-${++receiptN}` : posterReply.receipt;
        const headers: Record<string, string | null> = {
            'Content-Disposition': 'inline; filename="Keto-Winter-27-Serves-5-poster.jpg"',
            'X-Poster-Background': 'template', 'X-Poster-Background-Note': 'no_api_key',
            'X-Poster-Photos': 'placed,placed,placed,placed,placed', 'X-Poster-Omitted-Meals': '0',
            'X-Poster-Receipt': receipt,
        };
        return {
            ok: posterReply.ok,
            status: posterReply.ok ? 200 : 500,
            blob: async () => new Blob([Buffer.from(`ffd8ff-poster-${receiptN}`)], { type: 'image/jpeg' }),
            json: async () => posterReply.json ?? {},
            headers: { get: (k: string) => headers[k] ?? null },
        };
    });
    (URL as any).createObjectURL = jest.fn(() => `blob:poster-${++urlN}`);
    (URL as any).revokeObjectURL = jest.fn();
});

afterEach(() => { delete (global as any).window; });

const buttons = (tree: any) => findAll(tree, (el) => el.type === 'button');
const button = (tree: any, text: RegExp) => buttons(tree).find((el) => text.test(textOf(el)));
const useButton = (tree: any) => button(tree, /^(Use as Bundle Image|Saving…|Bundle Image Updated)$/);
const links = (tree: any) => findAll(tree, (el) => el.type === 'a');
/** The action row's controls, in the order a tenant sees them. */
const actionOrder = (tree: any) => {
    const out: string[] = [];
    walk(tree, (el) => { if (el.type === 'button' || el.type === 'a') out.push(textOf(el)); });
    return out;
};
const publishCalls = () => calls.filter((c) => c.url.endsWith('/poster/publish'));

async function generated() {
    const m = mountComponent(BundlePosterPanel, props);
    await button(m.tree, /Generate Poster/).props.onClick();
    m.render();
    return m;
}
async function confirmUse(m: any) {
    useButton(m.tree).props.onClick();
    m.render();
    await button(m.tree, /^Use Poster$/).props.onClick();
    m.render();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
it('1 · Use as Bundle Image appears only after a poster was generated successfully, last in the row', async () => {
    const m = mountComponent(BundlePosterPanel, props);
    expect(useButton(m.tree)).toBeUndefined();

    posterReply = { ok: false, json: { error: 'The poster could not be made. Please try again.' } };
    await button(m.tree, /Generate Poster/).props.onClick();
    m.render();
    expect(useButton(m.tree)).toBeUndefined();

    posterReply = { ok: true };
    await button(m.tree, /Generate Poster/).props.onClick();
    m.render();
    expect(useButton(m.tree).props.disabled).toBe(false);
    expect(actionOrder(m.tree)).toEqual(['Regenerate', 'Preview Poster', 'Download Poster', 'Use as Bundle Image']);
    expect(useButton(m.tree).props.className).toContain('bg-emerald-600'); // a publishing action, not a red one
    expect(useButton(m.tree).props.className).not.toMatch(/rose|red/);
});

it('generating changes nothing: no publish call, no announcement', async () => {
    const m = await generated();
    await button(m.tree, /Regenerate/).props.onClick();
    m.render();
    expect(publishCalls()).toHaveLength(0);
    expect(announced).toHaveLength(0);
});

it('2 · clicking asks once; "Use Poster" sends the poster bytes, its receipt and the CURRENT settings to THIS bundle', async () => {
    const m = await generated();
    useButton(m.tree).props.onClick();
    m.render();
    expect(textOf(m.tree)).toContain('Use this poster as the bundle image?');
    expect(publishCalls()).toHaveLength(0); // nothing until confirmed

    await button(m.tree, /^Use Poster$/).props.onClick();
    m.render();
    const [c] = publishCalls();
    expect(c.url).toBe('/api/bundles/b-keto-s5/poster/publish');
    expect(c.init.method).toBe('POST');
    const form: FormData = c.init.body;
    const poster = form.get('poster') as File;
    expect(Buffer.from(await poster.arrayBuffer()).toString()).toBe('ffd8ff-poster-1');
    expect(poster.name).toBe('Keto-Winter-27-Serves-5-poster.jpg');
    expect(form.get('receipt')).toBe('receipt-1');
    expect(form.get('theme')).toBe('winter');
    expect(form.get('backgroundInstructions')).toBe('');
    expect(form.get('showBadge')).toBe('true');
    expect([...form.keys()].sort()).toEqual(['backgroundInstructions', 'poster', 'receipt', 'showBadge', 'theme']); // never a URL
});

it('Cancel sends nothing', async () => {
    const m = await generated();
    useButton(m.tree).props.onClick();
    m.render();
    button(m.tree, /^Cancel$/).props.onClick();
    m.render();
    expect(textOf(m.tree)).not.toContain('Use this poster as the bundle image?');
    expect(publishCalls()).toHaveLength(0);
});

it('12 · 13 · 14 · success: the message, the editor is told THIS bundle\'s new URL, and Preview / Download still work', async () => {
    const m = await generated();
    await confirmUse(m);
    expect(textOf(m.tree)).toContain(POSTER_PUBLISHED_MESSAGE);
    expect(POSTER_PUBLISHED_MESSAGE).toBe('Bundle image updated successfully.');
    expect(announced).toEqual([{ bundleId: 'b-keto-s5', imageUrl: NEW_URL }]);
    expect(textOf(useButton(m.tree))).toBe('Bundle Image Updated');
    expect(useButton(m.tree).props.disabled).toBe(true); // the same poster is not sent twice

    const [preview, download] = links(m.tree);
    expect([textOf(preview), preview.props.href, preview.props.target]).toEqual(['Preview Poster', 'blob:poster-1', '_blank']);
    expect([textOf(download), download.props.href, download.props.download]).toEqual(['Download Poster', 'blob:poster-1', 'Keto-Winter-27-Serves-5-poster.jpg']);
});

it('14 · Regenerate after publishing makes a new poster that can be used again; the old object URL is freed', async () => {
    const m = await generated();
    await confirmUse(m);
    await button(m.tree, /Regenerate/).props.onClick();
    m.render();
    expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:poster-1');
    expect(links(m.tree)[0].props.href).toBe('blob:poster-2');
    expect(textOf(m.tree)).not.toContain(POSTER_PUBLISHED_MESSAGE);
    expect(useButton(m.tree).props.disabled).toBe(false);
    await confirmUse(m);
    expect((publishCalls()[1].init.body as FormData).get('receipt')).toBe('receipt-2');
});

it('11 · after a settings change the button is disabled with the regenerate note, and cannot be forced; Regenerate re-enables it', async () => {
    const m = await generated();
    findAll(m.tree, (el) => el.type === 'select')[0].props.onChange({ target: { value: 'fall' } });
    m.render();
    expect(useButton(m.tree).props.disabled).toBe(true);
    expect(textOf(m.tree)).toContain(POSTER_REGENERATE_FIRST);
    expect(POSTER_REGENERATE_FIRST).toBe('Regenerate the poster before using it as the bundle image.');
    useButton(m.tree).props.onClick(); // a forced click does nothing
    m.render();
    expect(textOf(m.tree)).not.toContain('Use this poster as the bundle image?');
    expect(publishCalls()).toHaveLength(0);

    for (const change of [
        () => findAll(m.tree, (el) => el.type === 'textarea')[0].props.onChange({ target: { value: 'Bright spring table' } }),
        () => findAll(m.tree, (el) => el.type === 'input' && el.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } }),
    ]) {
        change();
        m.render();
        expect(useButton(m.tree).props.disabled).toBe(true);
    }

    await button(m.tree, /Regenerate/).props.onClick();
    m.render();
    expect(useButton(m.tree).props.disabled).toBe(false);
    expect(textOf(m.tree)).not.toContain(POSTER_REGENERATE_FIRST);
    await confirmUse(m);
    const form: FormData = publishCalls()[0].init.body;
    expect([form.get('theme'), form.get('backgroundInstructions'), form.get('showBadge')]).toEqual(['fall', 'Bright spring table', 'false']);
});

it('confirming while the settings changed underneath sends nothing', async () => {
    const m = await generated();
    useButton(m.tree).props.onClick();
    m.render();
    const usePoster = button(m.tree, /^Use Poster$/);
    findAll(m.tree, (el) => el.type === 'select')[0].props.onChange({ target: { value: 'spring' } });
    m.render();
    expect(button(m.tree, /^Use Poster$/)).toBeUndefined(); // the confirmation closes
    await usePoster.props.onClick(); // and the old handler refuses
    expect(publishCalls()).toHaveLength(0);
});

it.each([
    [502, { error: 'The poster could not be saved. Your bundle image was not changed.', code: 'POSTER_STORAGE_FAILED' }],
    [500, { error: 'The bundle image could not be updated. Your bundle image was not changed.', code: 'POSTER_SAVE_FAILED' }],
    [200, { message: 'ok but no url' }],
])('9 · 10 · a %s failure shows the error, never the success message, and tells the editor nothing', async (status, json) => {
    publishReply = { status, json };
    const m = await generated();
    await confirmUse(m);
    const text = textOf(m.tree);
    expect(text).not.toContain(POSTER_PUBLISHED_MESSAGE);
    expect(text).toContain(json.error ?? 'Your bundle image was not changed.');
    expect(announced).toHaveLength(0);
    expect(useButton(m.tree).props.disabled).toBe(false); // can try again
});

it('a network failure is reported, not success', async () => {
    const m = await generated();
    (global as any).fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
    await confirmUse(m);
    expect(textOf(m.tree)).toContain('The bundle image could not be updated. Please check your connection and try again.');
    expect(announced).toHaveLength(0);
});

it('11 · the server saying the poster is out of date locks the button until Regenerate', async () => {
    publishReply = { status: 409, json: { error: 'This bundle has changed since the poster was made. Regenerate the poster before using it as the bundle image.', code: 'POSTER_BUNDLE_CHANGED' } };
    const m = await generated();
    await confirmUse(m);
    expect(textOf(m.tree)).toContain('This bundle has changed since the poster was made.');
    expect(useButton(m.tree).props.disabled).toBe(true);
    expect(textOf(m.tree)).toContain(POSTER_REGENERATE_FIRST);
    publishReply = { status: 200, json: { imageUrl: NEW_URL } };
    await button(m.tree, /Regenerate/).props.onClick();
    m.render();
    expect(useButton(m.tree).props.disabled).toBe(false);
});

it('a poster without a receipt cannot be used, and says why', async () => {
    posterReply = { ok: true, receipt: null };
    const m = await generated();
    expect(useButton(m.tree).props.disabled).toBe(true);
    expect(textOf(m.tree)).toContain('This poster can\'t be used as the bundle image. Regenerate it and try again.');
});

it('a double click on Use Poster sends one request', async () => {
    const m = await generated();
    useButton(m.tree).props.onClick();
    m.render();
    const click = button(m.tree, /^Use Poster$/).props.onClick;
    await Promise.all([click(), click()]);
    expect(publishCalls()).toHaveLength(1);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('13 · the editor\'s Bundle Image area follows a publish for its own bundle only', () => {
    it('subscribers hear only their own bundle; malformed announcements are ignored; unsubscribe stops it', () => {
        const target = new EventTarget();
        const heard: string[] = [];
        const off = subscribeBundleImagePublished('b-keto-s5', (u) => heard.push(u), target);
        announceBundleImagePublished('b-keto-s2', 'https://media.example.test/s2.jpg', target); // the sibling
        announceBundleImagePublished('b-keto-s5', NEW_URL, target);
        target.dispatchEvent(new CustomEvent(BUNDLE_IMAGE_PUBLISHED_EVENT, { detail: { bundleId: 'b-keto-s5', imageUrl: 42 } }));
        target.dispatchEvent(new CustomEvent(BUNDLE_IMAGE_PUBLISHED_EVENT, { detail: null }));
        target.dispatchEvent(new Event(BUNDLE_IMAGE_PUBLISHED_EVENT));
        off();
        announceBundleImagePublished('b-keto-s5', 'https://media.example.test/after.jpg', target);
        expect(heard).toEqual([NEW_URL]);
        expect(publishedImageFor(new CustomEvent('x', { detail: { bundleId: 'a', imageUrl: 'u' } }), 'a')).toBe('u');
        expect(announceBundleImagePublished('b', 'u', null)).toBe(false);
    });

    it('BundleEditor puts the announced URL into its existing image field, so the next Save Bundle keeps it', () => {
        const src = fs.readFileSync(path.join(ROOT, 'components/BundleEditor.tsx'), 'utf8').replace(/\r\n/g, '\n');
        expect(src).toContain("import { useBundleImagePublished } from '@/lib/bundles/bundleImageEvents';");
        expect(src).toContain("useBundleImagePublished(initialData?.id, (url) => setValue('image_url', url));");
        // The existing Bundle Image area renders that same field.
        expect(src).toContain("<img src={watch('image_url')} alt=\"Bundle\"");
        expect(src).toContain('No image selected');
    });
});
