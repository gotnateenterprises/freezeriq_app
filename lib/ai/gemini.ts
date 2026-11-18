
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

/** The text model. GEMINI_TEXT_MODEL may override it without a code change. */
export const DEFAULT_TEXT_MODEL = 'gemini-3.5-flash-lite';
export function textModelId(env: NodeJS.ProcessEnv = process.env): string {
    return env.GEMINI_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
}

export async function callGemini(apiKey: string, prompt: string, options: { temperature?: number, maxTokens?: number, responseMimeType?: string } = {}) {
    const model = textModelId();
    // RECIPE-AI-RECOVERY-1: the key travels in the documented x-goog-api-key header, never in the
    // URL — a URL is the part of a request most likely to be logged or echoed in an error.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
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
    /** RECIPE-AI-RECOVERY-1: non-sensitive context for logs — which model, which HTTP status. */
    model?: string;
    httpStatus?: number;
    constructor(public readonly code: RecipeImageErrorCode, message: string, meta: { model?: string; httpStatus?: number } = {}) {
        super(message);
        this.name = 'RecipeImageError';
        this.model = meta.model;
        this.httpStatus = meta.httpStatus;
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
        throw new RecipeImageError('AI_API_ERROR', 'Could not reach the image service.', { model });
    }

    if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        // RECIPE-AI-RECOVERY-1: log the provider's error STATUS and a bounded message — enough to
        // tell a retired model (404 NOT_FOUND) from quota (429) from a bad request — never the key,
        // the prompt or the recipe.
        console.error(`[Gemini Image] API Error: model=${model} http=${res.status} ${providerErrorSummary(errorText)}`);
        if (res.status === 402 || res.status === 429) {
            throw new RecipeImageError('AI_QUOTA', res.status === 402
                ? 'The Google AI account is out of prepaid credits, so no photo was generated.'
                : 'The Google AI rate limit was reached. Please wait a minute and try again.', { model, httpStatus: res.status });
        }
        throw new RecipeImageError('AI_API_ERROR', `The image service returned an error (${res.status}).`, { model, httpStatus: res.status });
    }

    let data: any;
    try {
        data = await res.json();
    } catch {
        throw new RecipeImageError('AI_MALFORMED', 'The image service returned an unreadable response.', { model, httpStatus: res.status });
    }
    try {
        return extractGeneratedImage(data, model);
    } catch (e) {
        if (isRecipeImageError(e)) { e.model = e.model ?? model; e.httpStatus = e.httpStatus ?? res.status; }
        throw e;
    }
}

/**
 * "status=NOT_FOUND message=…" from a Google error body, bounded to 300 characters. Google's error
 * bodies carry a status and a human message, not credentials; anything unparseable is reported
 * only by its length.
 */
export function providerErrorSummary(errorText: string): string {
    try {
        const err = JSON.parse(errorText)?.error;
        if (err && typeof err === 'object') {
            const status = typeof err.status === 'string' ? err.status : 'unknown';
            const message = typeof err.message === 'string' ? err.message.slice(0, 300) : '';
            return `status=${status} message=${JSON.stringify(message)}`;
        }
    } catch { /* not JSON */ }
    return `body_length=${errorText.length}`;
}

// ---------------------------------------------------------------------------
// RECIPE-AI-RECOVERY-1 — structured (schema-constrained) JSON from the text model.
//
// callGemini above returns parts[0].text and never looks at finishReason. For a JSON answer that is
// unsafe on a Gemini 3 model: thinking is on by default and thinking tokens count against
// maxOutputTokens, so a small budget can end the answer mid-object (finishReason MAX_TOKENS), and
// the text is not guaranteed to be a single part. This call joins every non-thought text part,
// reports finishReason, and asks the API to constrain the output with `responseJsonSchema`.
// ---------------------------------------------------------------------------

export interface StructuredTextResult {
    text: string;
    finishReason: string;
    model: string;
    /** False when the API refused the schema field and the call was retried with JSON mode only. */
    schemaEnforced: boolean;
}

export type StructuredTextErrorCode = 'AI_QUOTA' | 'AI_API_ERROR' | 'AI_BLOCKED' | 'AI_EMPTY' | 'AI_MALFORMED';

export class StructuredTextError extends Error {
    readonly kind = 'StructuredTextError' as const;
    constructor(public readonly code: StructuredTextErrorCode, message: string, public readonly httpStatus?: number) {
        super(message);
        this.name = 'StructuredTextError';
    }
}
export const isStructuredTextError = (e: unknown): e is StructuredTextError =>
    !!e && typeof e === 'object' && (e as any).kind === 'StructuredTextError';

/** The exact request body (exported so tests pin its shape). */
export function buildStructuredTextRequest(prompt: string, schema: object | null, options: { temperature?: number; maxTokens?: number } = {}) {
    const generationConfig: Record<string, unknown> = {
        temperature: options.temperature ?? 0.1,
        // Room for the model's (minimal) thinking AND the whole JSON object. A truncated object is
        // still caught below (finishReason MAX_TOKENS), but it should not be the normal outcome.
        maxOutputTokens: options.maxTokens ?? 4096,
        responseMimeType: 'application/json',
    };
    if (schema) generationConfig.responseJsonSchema = schema;
    return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
}

/** Every non-thought text part, joined in order. */
export function joinAnswerText(candidate: any): string {
    const parts: any[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    return parts.filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
}

const SCHEMA_REJECTION = /responseJsonSchema|response_json_schema|json schema|Unknown name/i;

/**
 * Ask the text model for JSON constrained by `schema`. If the API rejects the schema field itself
 * (400 naming it), retry ONCE in plain JSON mode — the caller validates strictly either way, so the
 * retry can only lose the server-side constraint, never the client-side check.
 */
export async function callGeminiStructured(
    apiKey: string,
    prompt: string,
    schema: object,
    options: { temperature?: number; maxTokens?: number } = {},
): Promise<StructuredTextResult> {
    const model = textModelId();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const attempt = async (withSchema: boolean): Promise<Response> => {
        try {
            return await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify(buildStructuredTextRequest(prompt, withSchema ? schema : null, options)),
            });
        } catch {
            throw new StructuredTextError('AI_API_ERROR', 'Could not reach the AI service.');
        }
    };

    let schemaEnforced = true;
    let res = await attempt(true);
    if (res.status === 400) {
        const errorText = await res.text().catch(() => '');
        if (SCHEMA_REJECTION.test(errorText)) {
            console.warn(`[Gemini Structured] model=${model} rejected responseJsonSchema; retrying in JSON mode with client-side validation only`);
            schemaEnforced = false;
            res = await attempt(false);
        } else {
            console.error(`[Gemini Structured] API Error: model=${model} http=400 ${providerErrorSummary(errorText)}`);
            throw new StructuredTextError('AI_API_ERROR', 'The AI service rejected the request (400).', 400);
        }
    }
    if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        console.error(`[Gemini Structured] API Error: model=${model} http=${res.status} ${providerErrorSummary(errorText)}`);
        if (res.status === 402 || res.status === 429) {
            throw new StructuredTextError('AI_QUOTA', res.status === 402
                ? 'The Google AI account is out of prepaid credits.'
                : 'The Google AI rate limit was reached. Please wait a minute and try again.', res.status);
        }
        throw new StructuredTextError('AI_API_ERROR', `The AI service returned an error (${res.status}).`, res.status);
    }

    let data: any;
    try {
        data = await res.json();
    } catch {
        throw new StructuredTextError('AI_MALFORMED', 'The AI service returned an unreadable response.', res.status);
    }
    if (data?.promptFeedback?.blockReason) {
        throw new StructuredTextError('AI_BLOCKED', `The request was blocked (${data.promptFeedback.blockReason}).`);
    }
    const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
    if (!candidate) throw new StructuredTextError('AI_EMPTY', 'The AI service returned no answer.');
    return {
        text: joinAnswerText(candidate),
        finishReason: String(candidate.finishReason ?? 'UNKNOWN'),
        model,
        schemaEnforced,
    };
}
