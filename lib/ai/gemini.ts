
import { prisma } from '@/lib/db';

export async function getGeminiApiKey(businessId: string): Promise<string | null> {
    const integration = await prisma.integration.findUnique({
        where: {
            business_id_provider: {
                business_id: businessId,
                provider: 'gemini'
            }
        }
    });
    return integration?.access_token || process.env.GEMINI_API_KEY || null;
}

export async function callGemini(apiKey: string, prompt: string, options: { temperature?: number, maxTokens?: number, responseMimeType?: string } = {}) {
    const model = process.env.GEMINI_TEXT_MODEL?.trim() || "gemini-3.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    console.log(`[Gemini Utility] Calling text model: ${model}`);

    const body: any = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.maxTokens ?? 1000,
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    if (options.responseMimeType === 'application/json') {
        body.generationConfig.responseMimeType = 'application/json';
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errorText = await res.text();
        if (res.status === 429) {
            throw new Error(`Gemini API Error: 429 Too Many Requests. You've hit the rate limit for your API key. Please wait 60 seconds and try again.`);
        }
        console.error(`[Gemini Utility] API Error on model ${model}:`, {
            status: res.status,
            statusText: res.statusText,
            body: errorText
        });
        throw new Error(`Gemini API Error: ${res.status} ${res.statusText} - ${errorText}`);
    }

    const data = await res.json();

    // Check for candidates
    if (!data.candidates || data.candidates.length === 0) {
        // Check for safety block or other reasons
        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason) {
            throw new Error(`Gemini blocked the prompt: ${blockReason}`);
        }
        console.error('[Gemini Utility] No candidates returned:', JSON.stringify(data, null, 2));
        throw new Error('Gemini returned no candidates');
    }

    const text = data.candidates[0].content?.parts?.[0]?.text;

    if (!text) {
        const finishReason = data.candidates[0].finishReason;
        if (finishReason === 'SAFETY') {
            throw new Error('Gemini blocked the response due to safety filters');
        }
        throw new Error(`Gemini returned an empty response (Reason: ${finishReason || 'Unknown'})`);
    }

    return text.trim();
}

// ---------------------------------------------------------------------------
// RECIPE-AI-IMAGE-MODEL-1 — recipe photos via native Gemini image generation.
//
// The old path called Imagen's `:predict` endpoint with `imagen-4.0-fast-generate-001`, which Google
// shut down (announced for 2026-08-17; Production answered 404 from 2026-11-13 at the latest).
// Gemini image models are called through the same `generateContent` endpoint the text path above
// already uses, with image output requested in `generationConfig`. The image comes back as base64
// `inlineData` on one of the candidate's parts — not necessarily the first (text and thought parts
// may accompany it).
// ---------------------------------------------------------------------------

/** The approved recipe-photo model. GEMINI_IMAGE_MODEL may override it without a code change. */
export const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';
/** Recipe cards and list rows are square; 1K is the model default and enough for a card. */
export const RECIPE_IMAGE_CONFIG = { aspectRatio: '1:1', imageSize: '1K' } as const;

const MIN_IMAGE_BYTES = 1000;

export type RecipeImageErrorCode =
    | 'AI_QUOTA'          // 402 (prepaid credits depleted) / 429 (rate limit)
    | 'AI_API_ERROR'      // any other non-2xx answer
    | 'AI_BLOCKED'        // the prompt or the image was blocked by safety filters
    | 'AI_NO_IMAGE'       // a 2xx answer that carries no image part
    | 'AI_INVALID_IMAGE'  // an image part whose bytes are not a PNG / JPEG / WebP
    | 'AI_MALFORMED';     // a 2xx answer that is not the expected JSON shape

/**
 * Typed failure of the recipe-image call. Callers branch on `isRecipeImageError(e)` / `e.code`
 * (a discriminator, not `instanceof`: the ES5 build target breaks subclass instanceof).
 */
export class RecipeImageError extends Error {
    readonly kind = 'RecipeImageError' as const;
    constructor(public readonly code: RecipeImageErrorCode, message: string) {
        super(message);
        this.name = 'RecipeImageError';
    }
}
export const isRecipeImageError = (e: unknown): e is RecipeImageError =>
    !!e && typeof e === 'object' && (e as any).kind === 'RecipeImageError' && typeof (e as any).code === 'string';

export interface GeneratedImage {
    bytes: Buffer;
    /** The type proven from the bytes themselves, never just the type the API claimed. */
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    extension: 'png' | 'jpg' | 'webp';
    model: string;
}

/** Identify an image by its signature. Anything else is refused rather than stored. */
export function sniffImageType(bytes: Buffer): Pick<GeneratedImage, 'mimeType' | 'extension'> | null {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return { mimeType: 'image/png', extension: 'png' };
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return { mimeType: 'image/jpeg', extension: 'jpg' };
    }
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        return { mimeType: 'image/webp', extension: 'webp' };
    }
    return null;
}

export function imageModelId(env: NodeJS.ProcessEnv = process.env): string {
    return env.GEMINI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
}

/** The exact request body sent for one recipe photo (exported so tests pin its shape). */
export function buildRecipeImageRequest(prompt: string) {
    return {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { ...RECIPE_IMAGE_CONFIG },
        },
    };
}

const BLOCK_FINISH_REASONS = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/i;

/** Pull exactly one valid image out of a generateContent response, or throw a RecipeImageError. */
export function extractGeneratedImage(data: any, model: string): GeneratedImage {
    if (!data || typeof data !== 'object') {
        throw new RecipeImageError('AI_MALFORMED', 'The image service returned an unreadable response.');
    }
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) {
        throw new RecipeImageError('AI_BLOCKED', `The image request was blocked (${blockReason}).`);
    }
    const candidates = Array.isArray(data.candidates) ? data.candidates : null;
    if (!candidates || candidates.length === 0) {
        throw new RecipeImageError('AI_NO_IMAGE', 'The image service returned no image.');
    }
    const candidate = candidates[0] ?? {};
    const parts: any[] = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    // Skip thought parts (interim drafts); take the first real image part.
    const imagePart = parts.find((p) => p && !p.thought && p.inlineData && typeof p.inlineData.data === 'string'
        && p.inlineData.data.length > 0);
    if (!imagePart) {
        const finishReason = String(candidate.finishReason ?? '');
        if (BLOCK_FINISH_REASONS.test(finishReason)) {
            throw new RecipeImageError('AI_BLOCKED', `The image was blocked by safety filters (${finishReason}).`);
        }
        throw new RecipeImageError('AI_NO_IMAGE', `The image service returned no image${finishReason ? ` (${finishReason})` : ''}.`);
    }
    const bytes = Buffer.from(imagePart.inlineData.data, 'base64');
    const kind = sniffImageType(bytes);
    if (!kind || bytes.length < MIN_IMAGE_BYTES) {
        throw new RecipeImageError('AI_INVALID_IMAGE', 'The image service returned data that is not a valid image.');
    }
    return { bytes, ...kind, model };
}

/** Generate one recipe photo. Never returns empty or unverified bytes. */
export async function generateRecipeImage(apiKey: string, prompt: string): Promise<GeneratedImage> {
    const model = imageModelId();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    console.log(`[Gemini Image] Calling image model: ${model}`);

    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            // Key in the documented header, never in the URL (URLs end up in logs).
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(buildRecipeImageRequest(prompt)),
        });
    } catch (e: any) {
        throw new RecipeImageError('AI_API_ERROR', `Could not reach the image service: ${e?.message ?? 'network error'}`);
    }

    if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        console.error(`[Gemini Image] API Error on model ${model}: ${res.status} ${res.statusText}`, errorText.slice(0, 2000));
        if (res.status === 402 || res.status === 429) {
            throw new RecipeImageError('AI_QUOTA', res.status === 402
                ? 'The Google AI account is out of prepaid credits, so no photo was generated.'
                : 'The Google AI rate limit was reached. Please wait a minute and try again.');
        }
        throw new RecipeImageError('AI_API_ERROR', `The image service returned an error (${res.status}).`);
    }

    let data: any;
    try {
        data = await res.json();
    } catch {
        throw new RecipeImageError('AI_MALFORMED', 'The image service returned an unreadable response.');
    }
    return extractGeneratedImage(data, model);
}
