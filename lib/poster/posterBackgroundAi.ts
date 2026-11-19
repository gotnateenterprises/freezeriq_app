/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — ask the image model for the poster BACKDROP only.
 *
 * Same provider path as recipe photos (lib/ai/gemini.ts: the GEMINI_IMAGE_MODEL / default model, the
 * documented generateContent endpoint, the key in the x-goog-api-key header, the same strict image
 * extraction) — imported, not modified. Only the request differs: a portrait aspect ratio, and a
 * prompt that forbids food and text (lib/poster/backgroundPrompt.ts). Logs carry the model, the HTTP
 * status and the provider's error status — never the key, the prompt or the tenant's notes.
 */

import { extractGeneratedImage, imageModelId, isRecipeImageError, providerErrorSummary, type GeneratedImage } from '@/lib/ai/gemini';

/** Portrait; the model's 3:4 is cropped to the poster's 4:5. 1K is plenty for a soft backdrop. */
export const POSTER_BACKGROUND_IMAGE_CONFIG = { aspectRatio: '3:4', imageSize: '1K' } as const;
export const POSTER_BACKGROUND_TIMEOUT_MS = 40_000;

export function buildPosterBackgroundRequest(prompt: string) {
    return {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { ...POSTER_BACKGROUND_IMAGE_CONFIG },
        },
    };
}

export type PosterBackgroundFailure =
    | 'AI_TIMEOUT' | 'AI_QUOTA' | 'AI_API_ERROR' | 'AI_BLOCKED' | 'AI_NO_IMAGE' | 'AI_INVALID_IMAGE' | 'AI_MALFORMED';

export type PosterBackgroundResult =
    | { ok: true; image: GeneratedImage }
    | { ok: false; reason: PosterBackgroundFailure; httpStatus?: number; model: string };

export async function generatePosterBackground(
    apiKey: string,
    prompt: string,
    opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<PosterBackgroundResult> {
    const model = imageModelId();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const doFetch = opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? POSTER_BACKGROUND_TIMEOUT_MS);
    try {
        let res: Response;
        try {
            res = await doFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify(buildPosterBackgroundRequest(prompt)),
                signal: controller.signal,
            });
        } catch {
            const reason = controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_API_ERROR';
            console.error(`[BundlePoster] Background call failed: reason=${reason} model=${model}`);
            return { ok: false, reason, model };
        }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.error(`[BundlePoster] Background API error: model=${model} http=${res.status} ${providerErrorSummary(text)}`);
            return { ok: false, reason: res.status === 402 || res.status === 429 ? 'AI_QUOTA' : 'AI_API_ERROR', httpStatus: res.status, model };
        }
        let data: unknown;
        try {
            data = await res.json();
        } catch {
            return { ok: false, reason: 'AI_MALFORMED', httpStatus: res.status, model };
        }
        try {
            return { ok: true, image: extractGeneratedImage(data, model) };
        } catch (e) {
            const reason = isRecipeImageError(e) ? e.code as PosterBackgroundFailure : 'AI_MALFORMED';
            console.error(`[BundlePoster] Background not usable: reason=${reason} model=${model}`);
            return { ok: false, reason, httpStatus: res.status, model };
        }
    } finally {
        clearTimeout(timer);
    }
}
