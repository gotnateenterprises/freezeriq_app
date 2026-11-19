/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — produce one poster image from a bundle, as stored right now.
 *
 *   model      ← the bundle row the route just read (its linked recipes, their saved photos)
 *   backdrop   ← AI (theme + optional notes) or the drawn scene; ALWAYS falls back to the drawn scene
 *   photos     ← each meal's own image_url, fetched from the media host, checked to really be an
 *                image, and cropped to its slot ("attention" crop keeps the food prominent); a meal
 *                without a usable photo gets the neutral card — generation never fails for it
 *   rasterise  ← the element tree drawn with the bundled fonts, then saved as JPEG
 *
 * Nothing is cached and nothing is stored: every call reads the photos the recipes point at now, so
 * a changed photo, bundle composition, order or theme shows up on the next Generate, and no old
 * poster is kept anywhere to go stale.
 */

import fs from 'fs/promises';
import path from 'path';
import { parseFontMetrics } from '@/lib/poster/fontMetrics';
import type { PosterModel } from '@/lib/poster/posterModel';
import type { PosterTheme } from '@/lib/poster/posterThemes';
import type { BackgroundPlan } from '@/lib/poster/backgroundPrompt';
import { fallbackBackgroundSvg } from '@/lib/poster/fallbackBackground';
import { generatePosterBackground, type PosterBackgroundFailure } from '@/lib/poster/posterBackgroundAi';
import { POSTER_HEIGHT, POSTER_WIDTH } from '@/lib/poster/posterLayout';
import {
    FONT_LABEL, FONT_SCRIPT, FONT_TITLE, buildPosterTree, photoInnerSize, posterTextPlan, type PosterMetrics,
} from '@/lib/poster/posterTemplate';

export const POSTER_FONT_FILES = {
    anton: 'Anton-Regular.ttf',
    pacifico: 'Pacifico-Regular.ttf',
    bebas: 'BebasNeue-Regular.ttf',
} as const;

export const PHOTO_FETCH_TIMEOUT_MS = 10_000;
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const JPEG_QUALITY = 88;

export class PosterRenderError extends Error {
    readonly kind = 'PosterRenderError' as const;
    constructor(public readonly code: 'POSTER_FONTS_MISSING' | 'POSTER_RENDER_FAILED', message: string) {
        super(message);
        this.name = 'PosterRenderError';
    }
}
export const isPosterRenderError = (e: unknown): e is PosterRenderError =>
    !!e && typeof e === 'object' && (e as any).kind === 'PosterRenderError';

// ── fonts ─────────────────────────────────────────────────────────────────────────────────────

let fontCache: { data: Record<keyof typeof POSTER_FONT_FILES, Buffer>; metrics: PosterMetrics } | null = null;

export async function loadPosterFonts() {
    if (fontCache) return fontCache;
    const dir = path.join(process.cwd(), 'lib', 'poster', 'fonts');
    try {
        const [anton, pacifico, bebas] = await Promise.all([
            fs.readFile(path.join(dir, POSTER_FONT_FILES.anton)),
            fs.readFile(path.join(dir, POSTER_FONT_FILES.pacifico)),
            fs.readFile(path.join(dir, POSTER_FONT_FILES.bebas)),
        ]);
        fontCache = {
            data: { anton, pacifico, bebas },
            metrics: { anton: parseFontMetrics(anton), pacifico: parseFontMetrics(pacifico), bebas: parseFontMetrics(bebas) },
        };
        return fontCache;
    } catch {
        throw new PosterRenderError('POSTER_FONTS_MISSING', 'The poster fonts are not available on the server.');
    }
}

// ── dependencies (real by default; tests swap them) ────────────────────────────────────────────

export interface PosterDeps {
    fetchImpl: typeof fetch;
    /** Element tree + fonts → PNG bytes. */
    rasterize: (tree: unknown, fonts: { name: string; data: Buffer }[]) => Promise<Buffer>;
    sharp: typeof import('sharp');
}

async function realRasterize(tree: unknown, fonts: { name: string; data: Buffer }[]): Promise<Buffer> {
    const { ImageResponse } = await import('next/og');
    const res = new ImageResponse(tree as any, {
        width: POSTER_WIDTH,
        height: POSTER_HEIGHT,
        fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: 400 as const, style: 'normal' as const })),
    });
    return Buffer.from(await res.arrayBuffer());
}

export async function defaultPosterDeps(): Promise<PosterDeps> {
    const sharpMod = (await import('sharp')) as any;
    return { fetchImpl: fetch, rasterize: realRasterize, sharp: sharpMod.default ?? sharpMod };
}

// ── photos ────────────────────────────────────────────────────────────────────────────────────

export type PhotoOutcome = 'placed' | 'missing' | 'not_https' | 'unsupported_host' | 'fetch_failed' | 'not_an_image';

const DECODABLE = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff']);

/** One meal's own photo → a JPEG cropped to its slot, or null with the reason. */
async function preparePhoto(url: string, w: number, h: number, deps: PosterDeps): Promise<{ data: string | null; outcome: PhotoOutcome }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PHOTO_FETCH_TIMEOUT_MS);
    let bytes: Buffer;
    try {
        const res = await deps.fetchImpl(url, { signal: controller.signal, redirect: 'error' });
        if (!res.ok) return { data: null, outcome: 'fetch_failed' };
        const declared = Number(res.headers?.get?.('content-length') ?? 0);
        if (declared > PHOTO_MAX_BYTES) return { data: null, outcome: 'fetch_failed' };
        bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES) return { data: null, outcome: 'fetch_failed' };
    } catch {
        return { data: null, outcome: 'fetch_failed' };
    } finally {
        clearTimeout(timer);
    }
    try {
        const meta = await deps.sharp(bytes).metadata();
        if (!meta.format || !DECODABLE.has(meta.format)) return { data: null, outcome: 'not_an_image' };
        const out = await deps.sharp(bytes).rotate().resize(w, h, { fit: 'cover', position: 'attention' })
            .jpeg({ quality: 86 }).toBuffer();
        return { data: `data:image/jpeg;base64,${out.toString('base64')}`, outcome: 'placed' };
    } catch {
        return { data: null, outcome: 'not_an_image' };
    }
}

// ── backdrop ──────────────────────────────────────────────────────────────────────────────────

export type BackgroundSource = 'ai' | 'template';
export type BackgroundNote = 'custom_neutral' | 'no_api_key' | PosterBackgroundFailure | null;

async function drawnBackdrop(theme: PosterTheme, deps: PosterDeps): Promise<string> {
    const jpg = await deps.sharp(Buffer.from(fallbackBackgroundSvg(theme), 'utf8'))
        .resize(POSTER_WIDTH, POSTER_HEIGHT).jpeg({ quality: 86 }).toBuffer();
    return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

async function backdrop(plan: BackgroundPlan, theme: PosterTheme, apiKey: string | null, deps: PosterDeps):
    Promise<{ data: string; source: BackgroundSource; note: BackgroundNote }> {
    if (plan.mode === 'template') return { data: await drawnBackdrop(theme, deps), source: 'template', note: plan.reason };
    if (!apiKey) return { data: await drawnBackdrop(theme, deps), source: 'template', note: 'no_api_key' };
    const ai = await generatePosterBackground(apiKey, plan.prompt, { fetchImpl: deps.fetchImpl });
    if (!ai.ok) return { data: await drawnBackdrop(theme, deps), source: 'template', note: ai.reason };
    try {
        const jpg = await deps.sharp(ai.image.bytes).resize(POSTER_WIDTH, POSTER_HEIGHT, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 86 }).toBuffer();
        return { data: `data:image/jpeg;base64,${jpg.toString('base64')}`, source: 'ai', note: null };
    } catch {
        return { data: await drawnBackdrop(theme, deps), source: 'template', note: 'AI_INVALID_IMAGE' };
    }
}

// ── the poster ────────────────────────────────────────────────────────────────────────────────

export interface RenderedPoster {
    bytes: Buffer;
    contentType: 'image/jpeg';
    width: number;
    height: number;
    background: BackgroundSource;
    backgroundNote: BackgroundNote;
    /** Per meal, in order: what happened to its photo. */
    photos: PhotoOutcome[];
}

export async function renderBundlePoster(input: {
    model: PosterModel;
    theme: PosterTheme;
    background: BackgroundPlan;
    apiKey: string | null;
    deps?: PosterDeps;
}): Promise<RenderedPoster> {
    const deps = input.deps ?? await defaultPosterDeps();
    const fonts = await loadPosterFonts();
    const plan = posterTextPlan(input.model, input.theme, fonts.metrics);

    const [bg, photos] = await Promise.all([
        backdrop(input.background, input.theme, input.apiKey, deps),
        Promise.all(input.model.meals.map((meal, i) => {
            if (!meal.photoUrl) return Promise.resolve({ data: null, outcome: (meal.photoIssue ?? 'missing') as PhotoOutcome });
            const size = photoInnerSize(plan.meals[i].slot);
            return preparePhoto(meal.photoUrl, size.w, size.h, deps);
        })),
    ]);

    const tree = buildPosterTree(input.model, input.theme, plan, { background: bg.data, photos: photos.map((p) => p.data) }, fonts.metrics);
    let png: Buffer;
    try {
        png = await deps.rasterize(tree, [
            { name: FONT_TITLE, data: fonts.data.anton },
            { name: FONT_SCRIPT, data: fonts.data.pacifico },
            { name: FONT_LABEL, data: fonts.data.bebas },
        ]);
    } catch (e: any) {
        console.error(`[BundlePoster] Rasterize failed: ${e?.name ?? 'Error'}`);
        throw new PosterRenderError('POSTER_RENDER_FAILED', 'The poster could not be drawn. Please try again.');
    }
    const bytes = await deps.sharp(png).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();

    return {
        bytes, contentType: 'image/jpeg', width: POSTER_WIDTH, height: POSTER_HEIGHT,
        background: bg.source, backgroundNote: bg.note,
        photos: photos.map((p) => p.outcome),
    };
}
