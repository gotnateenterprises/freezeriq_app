/**
 * RECIPE-AI-RECOVERY-1 — recipe photos report honestly, and the AI allergen answer is schema-
 * constrained and strictly validated.
 *
 * Google is never called: `fetch` is replaced per test and returns the documented generateContent
 * shapes. The REAL route handlers run. Every console line is captured so a test can prove the API key
 * never reaches a log. Recipes and keys are fictional.
 */
import fs from 'fs';
import path from 'path';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__aiRecPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__aiRecSession) }));
jest.mock('@/lib/s3', () => ({ uploadToS3: jest.fn() }));

import {
    ALLERGEN_RESPONSE_SCHEMA, normalizeAllergenCategory, parseAllergenResponse,
} from '@/lib/ai/allergenClassification';
import { ALLERGEN_CATEGORIES } from '@/lib/allergens';
import {
    buildStructuredTextRequest, callGemini, callGeminiStructured, joinAnswerText, providerErrorSummary, textModelId,
} from '@/lib/ai/gemini';
import { uploadToS3 } from '@/lib/s3';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const KEY = 'fixture-key-NOT-REAL-9f3a';
const upload = uploadToS3 as jest.Mock;

const PNG = Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
    Buffer.alloc(1200, 0),
]);

// ── fetch double + log capture ───────────────────────────────────────────────
type Reply = { status: number; body?: unknown; rawText?: string };
let calls: { url: string; init: any }[] = [];
let replies: Reply[] = [];
const queue = (...r: Reply[]) => {
    calls = []; replies = [...r];
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        const reply = replies.length > 1 ? replies.shift()! : replies[0];
        return {
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            statusText: String(reply.status),
            json: async () => { if (reply.rawText !== undefined) throw new SyntaxError('bad json'); return reply.body; },
            text: async () => reply.rawText ?? JSON.stringify(reply.body),
        };
    });
};
const logs: string[] = [];
beforeAll(() => {
    for (const k of ['log', 'error', 'warn', 'info'] as const) {
        jest.spyOn(console, k).mockImplementation((...a: any[]) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
});
beforeEach(() => {
    logs.length = 0;
    upload.mockReset();
    (global as any).__aiRecSession = { user: { email: 'owner@example.invalid', businessId: 'biz-fixture' } };
    (global as any).__aiRecPrisma = {
        integration: { findUnique: async () => ({ access_token: KEY }) },
        recipe: { findFirst: async () => ({ id: 'r1' }), updateMany: async () => ({ count: 1 }) },
        user: { findUnique: async () => null },
    };
    delete process.env.GEMINI_TEXT_MODEL;
    delete process.env.GEMINI_IMAGE_MODEL;
});
afterEach(() => {
    // NO SECRET LOGGED — checked after every test in this file, including every failure path.
    expect(logs.join('\n')).not.toContain(KEY);
});

const textAnswer = (text: string, finishReason = 'STOP', extraParts: any[] = []) => ({
    candidates: [{ finishReason, content: { parts: [...extraParts, { text }] } }],
});

async function grab(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/recipes/grab-image/route');
    const res = await POST(new Request('http://localhost/api/recipes/grab-image', { method: 'POST', body: JSON.stringify(body) }) as any);
    return { status: res.status, body: await res.json() };
}
async function detect(ingredients: string[]) {
    const { POST } = await import('@/app/api/recipes/detect-allergens/route');
    const res = await POST(new Request('http://localhost/api/recipes/detect-allergens', { method: 'POST', body: JSON.stringify({ ingredients }) }) as any);
    return { status: res.status, body: await res.json() };
}

// ═════════════════════════════════════════════════════════════════════════════
// IMAGE
// ═════════════════════════════════════════════════════════════════════════════
describe('image · status the caller can rely on', () => {
    const imageOk = { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] };

    it('success: generated:true, the S3 url, model named, uploaded exactly once; never the placeholder', async () => {
        queue({ status: 200, body: imageOk });
        upload.mockResolvedValueOnce('https://media.example.test/recipe-ai-gen-x.png');
        const r = await grab({ name: 'Fixture Chili', ingredients: ['beans', 'tomatoes'] });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ generated: true, source: 'gemini-image', model: 'gemini-3.1-flash-image', url: 'https://media.example.test/recipe-ai-gen-x.png' });
        expect(JSON.stringify(r.body)).not.toContain('food-placeholder');
        expect(upload).toHaveBeenCalledTimes(1);
        expect(upload.mock.calls[0][2]).toBe('image/png');
        expect(Buffer.compare(upload.mock.calls[0][0], PNG)).toBe(0); // the decoded bytes, unaltered
        expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
    });

    it('GEMINI_IMAGE_MODEL is the model actually called', async () => {
        process.env.GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
        queue({ status: 200, body: imageOk });
        upload.mockResolvedValueOnce('https://media.example.test/a.png');
        const r = await grab({ name: 'Fixture Chili' });
        expect(calls[0].url).toContain('/models/gemini-3.1-flash-lite-image:generateContent');
        expect(r.body.model).toBe('gemini-3.1-flash-lite-image');
    });

    it.each([
        ['provider 404 (retired / unknown model)', { status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'models/x is not found for API version v1beta' } } }, 502, 'AI_API_ERROR'],
        ['provider 429 (rate limit)', { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } } }, 429, 'AI_QUOTA'],
        ['malformed provider response (not JSON)', { status: 200, rawText: '<html>oops' }, 502, 'AI_MALFORMED'],
        ['2xx with no image part', { status: 200, body: textAnswer('I cannot draw that') }, 502, 'AI_NO_IMAGE'],
    ] as const)('%s → generated:false, placeholder only as fallbackUrl, nothing stored', async (_l, reply, http, code) => {
        queue(reply as Reply);
        const r = await grab({ name: 'Fixture Chili', recipeId: 'r1' });
        expect(r.status).toBe(http);
        expect(r.body).toMatchObject({ generated: false, source: 'placeholder', fallbackUrl: '/images/food-placeholder.png', code });
        expect(r.body.url).toBeUndefined(); // RecipeEditor would save any `url` and say "Success!"
        expect(upload).not.toHaveBeenCalled();
        expect(JSON.stringify(r.body)).not.toMatch(/v1beta|NOT_FOUND|RESOURCE_EXHAUSTED|<html/); // no raw provider text to the tenant
    });

    it('the 404 is logged with model, HTTP status and the provider status — and nothing secret', async () => {
        queue({ status: 404, body: { error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-3.1-flash-image is not found' } } });
        await grab({ name: 'Fixture Chili' });
        const line = logs.find((l) => l.includes('[Gemini Image] API Error'))!;
        expect(line).toContain('model=gemini-3.1-flash-image');
        expect(line).toContain('http=404');
        expect(line).toContain('status=NOT_FOUND');
        expect(logs.find((l) => l.includes('[GrabImage] Image generation failed'))).toMatch(/code=AI_API_ERROR model=gemini-3\.1-flash-image status=404/);
    });

    it('an S3 failure → STORAGE_FAILED, generated:false, no url', async () => {
        queue({ status: 200, body: imageOk });
        upload.mockRejectedValueOnce(new Error(`bucket unreachable for ${KEY}`)); // even a hostile message
        const r = await grab({ name: 'Fixture Chili' });
        expect(r.status).toBe(502);
        expect(r.body).toMatchObject({ generated: false, code: 'STORAGE_FAILED' });
        expect(r.body.url).toBeUndefined();
    });

    it('providerErrorSummary bounds and structures the provider body', () => {
        expect(providerErrorSummary(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'm'.repeat(900) } })))
            .toBe(`status=NOT_FOUND message=${JSON.stringify('m'.repeat(300))}`);
        expect(providerErrorSummary('<html>gateway</html>')).toBe('body_length=20');
    });
});

describe('image · no retired model, no key in a URL', () => {
    it('no active code path names an Imagen model or :predict', () => {
        const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
            .flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : []);
        const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(['app', 'lib', 'components'].flatMap(walk).filter((f) => /imagen-\d|:predict\b|callImagen|imagen-3-generation/i.test(code(f)))).toEqual([]);
    });

    it('the text path now sends the key in x-goog-api-key, not ?key=', async () => {
        queue({ status: 200, body: textAnswer('hello') });
        await callGemini(KEY, 'say hello');
        expect(calls[0].url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${textModelId()}:generateContent`);
        expect(calls[0].url).not.toContain(KEY);
        expect(calls[0].init.headers['x-goog-api-key']).toBe(KEY);
        const src = read('lib/ai/gemini.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        expect(src).not.toMatch(/\?key=|key=\$\{apiKey\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ALLERGENS · the structured request
// ═════════════════════════════════════════════════════════════════════════════
describe('allergens · structured output request', () => {
    it('asks for JSON constrained by an explicit schema, with room past thinking tokens', async () => {
        queue({ status: 200, body: textAnswer('{"confirmed":[],"reviewRequired":[]}') });
        await detect(['carrots']);
        const body = JSON.parse(calls[0].init.body);
        expect(body.generationConfig.responseMimeType).toBe('application/json');
        expect(body.generationConfig.responseJsonSchema).toEqual(ALLERGEN_RESPONSE_SCHEMA);
        expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(2048); // was 500
        expect(calls[0].init.headers['x-goog-api-key']).toBe(KEY);
        expect(calls[0].url).not.toContain('key=');
    });

    it('the schema allows only the nine categories and requires both arrays', () => {
        const s: any = ALLERGEN_RESPONSE_SCHEMA;
        expect(s.required).toEqual(['confirmed', 'reviewRequired']);
        expect(s.properties.confirmed.items.enum).toEqual([...ALLERGEN_CATEGORIES]);
        expect(s.properties.reviewRequired.items.properties.possibleAllergens.items.enum).toEqual([...ALLERGEN_CATEGORIES]);
        expect(s.properties.reviewRequired.items.required).toEqual(['ingredient', 'possibleAllergens', 'reason']);
        expect(JSON.stringify(s)).not.toMatch(/Gluten|Milk/);
    });

    it('if the API refuses the schema field, it retries ONCE in JSON mode and still validates strictly', async () => {
        queue(
            { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload received. Unknown name "responseJsonSchema"' } } },
            { status: 200, body: textAnswer('{"confirmed":["Milk","Gluten"],"reviewRequired":[]}') },
        );
        const r = await detect(['milk', 'wheat flour']);
        expect(calls).toHaveLength(2);
        expect(JSON.parse(calls[1].init.body).generationConfig.responseJsonSchema).toBeUndefined();
        expect(JSON.parse(calls[1].init.body).generationConfig.responseMimeType).toBe('application/json');
        expect(r.body.confirmed).toEqual(['Dairy']); // Milk→Dairy, Gluten dropped
    });

    it('any other 400 is not retried', async () => {
        queue({ status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'contents is empty' } } });
        const r = await detect(['milk']);
        expect(calls).toHaveLength(1);
        expect(r.status).toBe(502);
        expect(r.body.allergens).toBeUndefined();
    });

    it('joins every non-thought text part (an answer split across parts still parses)', () => {
        expect(joinAnswerText({ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"confirmed":' }, { text: '["Soy"],"reviewRequired":[]}' }] } }))
            .toBe('{"confirmed":["Soy"],"reviewRequired":[]}');
        expect(buildStructuredTextRequest('p', null).generationConfig).not.toHaveProperty('responseJsonSchema');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ALLERGENS · the brief's cases A–H, through the real route
// ═════════════════════════════════════════════════════════════════════════════
describe('allergens · cases A–H', () => {
    const run = async (answer: object, ingredients: string[]) => {
        queue({ status: 200, body: textAnswer(JSON.stringify(answer)) });
        return detect(ingredients);
    };

    it('A · butter + heavy cream → Dairy', async () => {
        const r = await run({ confirmed: ['Dairy', 'Dairy'], reviewRequired: [] }, ['butter', 'heavy cream']);
        expect(r.body).toMatchObject({ allergens: 'Dairy', confirmed: ['Dairy'], reviewRequired: [] });
    });
    it('B · eggs → Eggs', async () => {
        expect((await run({ confirmed: ['Eggs'], reviewRequired: [] }, ['eggs'])).body.confirmed).toEqual(['Eggs']);
    });
    it('C · wheat flour → Wheat, never Gluten', async () => {
        const r = await run({ confirmed: ['Wheat', 'Gluten'], reviewRequired: [] }, ['wheat flour']);
        expect(r.body.confirmed).toEqual(['Wheat']);
        expect(JSON.stringify(r.body)).not.toContain('Gluten');
    });
    it('D · soy sauce → Soy', async () => {
        expect((await run({ confirmed: ['Soy'], reviewRequired: [] }, ['soy sauce'])).body.confirmed).toEqual(['Soy']);
    });
    it('E · peanut butter → Peanuts', async () => {
        expect((await run({ confirmed: ['Peanuts'], reviewRequired: [] }, ['peanut butter'])).body.confirmed).toEqual(['Peanuts']);
    });
    it('F · ranch dressing → reviewRequired, NOT confirmed', async () => {
        const r = await run({ confirmed: [], reviewRequired: [{ ingredient: 'ranch dressing', possibleAllergens: ['Dairy', 'Eggs'], reason: 'Compound dressing; sub-ingredients unknown' }] }, ['ranch dressing']);
        expect(r.body.confirmed).toEqual([]);
        expect(r.body.allergens).toBe('None Confirmed');
        expect(r.body.reviewRequired).toEqual([{ ingredient: 'ranch dressing', possibleAllergens: ['Dairy', 'Eggs'], reason: 'Compound dressing; sub-ingredients unknown' }]);
    });
    it('G · chicken breast, carrots, potatoes → None Confirmed', async () => {
        const r = await run({ confirmed: [], reviewRequired: [] }, ['chicken breast', 'carrots', 'potatoes']);
        expect(r.body).toEqual({ allergens: 'None Confirmed', confirmed: [], reviewRequired: [] });
    });
    it('H · mixed recipe de-duplicates categories and review items', async () => {
        const r = await run({
            confirmed: ['Dairy', 'Wheat', 'dairy', 'Milk', 'Eggs', 'Wheat'],
            reviewRequired: [
                { ingredient: 'BBQ Sauce', possibleAllergens: ['Soy', 'Wheat'], reason: 'Compound sauce' },
                { ingredient: 'bbq sauce', possibleAllergens: ['Soy', 'Sesame'], reason: 'Duplicate' },
            ],
        }, ['butter', 'milk', 'wheat flour', 'eggs', 'BBQ Sauce']);
        expect(r.body.confirmed).toEqual(['Dairy', 'Eggs', 'Wheat']);
        expect(r.body.allergens).toBe('Dairy, Eggs, Wheat');
        expect(r.body.reviewRequired).toEqual([{ ingredient: 'BBQ Sauce', possibleAllergens: ['Soy', 'Wheat', 'Sesame'], reason: 'Compound sauce' }]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ALLERGENS · case I — what the model might send back
// ═════════════════════════════════════════════════════════════════════════════
describe('allergens · case I: hostile or broken model output', () => {
    const fallbackFor = async (text: string, finishReason = 'STOP') => {
        queue({ status: 200, body: textAnswer(text, finishReason) });
        return detect(['butter']);
    };
    const isSafeFallback = (b: any) => {
        expect(b.allergens).toBeUndefined(); // nothing for the editor to write into the allergen field
        expect(b).toMatchObject({ parseError: true, confirmed: [], reviewRequired: [], structured: { confirmed: [], reviewRequired: [], parseError: true } });
        expect(typeof b.error).toBe('string');
    };

    it('a single ```json fence around the whole answer is accepted', async () => {
        const r = await fallbackFor('```json\n{"confirmed":["Dairy"],"reviewRequired":[]}\n```');
        expect(r.body.confirmed).toEqual(['Dairy']);
    });
    it.each([
        ['malformed JSON', '{"confirmed": ["Dairy",'],
        ['extra prose around a valid object', 'Sure! Here you go: {"confirmed":["Dairy"],"reviewRequired":[]} Hope that helps.'],
        ['prose after a fence', '```json\n{"confirmed":["Dairy"],"reviewRequired":[]}\n```\nLet me know!'],
        ['two objects', '{"confirmed":[],"reviewRequired":[]}{"confirmed":["Dairy"],"reviewRequired":[]}'],
        ['escaped JSON (a JSON string)', JSON.stringify(JSON.stringify({ confirmed: ['Dairy'], reviewRequired: [] }))],
        ['missing reviewRequired', '{"confirmed":["Dairy"]}'],
        ['missing confirmed', '{"reviewRequired":[]}'],
        ['confirmed is a string', '{"confirmed":"Dairy","reviewRequired":[]}'],
        ['a non-string category', '{"confirmed":["Dairy", 7],"reviewRequired":[]}'],
        ['review item without ingredient', '{"confirmed":[],"reviewRequired":[{"possibleAllergens":["Soy"],"reason":"x"}]}'],
        ['review item with string possibleAllergens', '{"confirmed":[],"reviewRequired":[{"ingredient":"ranch","possibleAllergens":"Dairy","reason":"x"}]}'],
        ['an array at the top', '[{"confirmed":["Dairy"],"reviewRequired":[]}]'],
        ['empty text', '   '],
    ])('%s → safe review fallback, nothing confirmed', async (_label, text) => {
        isSafeFallback((await fallbackFor(text)).body);
    });

    it('an answer cut off by the token limit (finishReason MAX_TOKENS) is never trusted, even if it parses', async () => {
        const r = await fallbackFor('{"confirmed":["Dairy"],"reviewRequired":[]}', 'MAX_TOKENS');
        isSafeFallback(r.body);
        expect(r.body.reason).toBe('truncated');
        expect(logs.find((l) => l.includes('Structured answer rejected'))).toMatch(/reason=truncated finishReason=MAX_TOKENS model=gemini-3\.5-flash-lite schemaEnforced=true textLength=\d+/);
    });

    it('the rejection log carries no recipe content', async () => {
        await fallbackFor('Sure! secret-family-recipe-ingredient-xyz');
        expect(logs.join('\n')).not.toContain('secret-family-recipe-ingredient-xyz');
    });

    it('unexpected categories are dropped; Milk → Dairy; Gluten never survives (confirmed or review)', async () => {
        queue({ status: 200, body: textAnswer(JSON.stringify({
            confirmed: ['Milk', 'Gluten', 'Mustard', 'Celery', 'Sesame'],
            reviewRequired: [
                { ingredient: 'mystery spice', possibleAllergens: ['Gluten', 'Mustard'], reason: 'unknown' },
                { ingredient: 'cream sauce', possibleAllergens: ['milk', 'Gluten'], reason: 'compound' },
            ],
        })) });
        const r = await detect(['milk', 'flour', 'mystery spice', 'cream sauce']);
        expect(r.body.confirmed).toEqual(['Dairy', 'Sesame']);
        expect(r.body.reviewRequired).toEqual([{ ingredient: 'cream sauce', possibleAllergens: ['Dairy'], reason: 'compound' }]);
        expect(JSON.stringify(r.body)).not.toMatch(/Gluten|Mustard|Celery|"Milk"/);
    });

    it('a blocked or empty AI answer is a review fallback, and quota is a 429 with no allergens', async () => {
        queue({ status: 200, body: { promptFeedback: { blockReason: 'OTHER' } } });
        isSafeFallback((await detect(['butter'])).body);
        queue({ status: 200, body: { candidates: [] } });
        isSafeFallback((await detect(['butter'])).body);
        queue({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } });
        const q = await detect(['butter']);
        expect(q.status).toBe(429);
        expect(q.body.allergens).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ALLERGENS · the normalizer itself
// ═════════════════════════════════════════════════════════════════════════════
describe('allergens · normalizeAllergenCategory', () => {
    it('keeps the nine, maps milk-derived names to Dairy, rejects Gluten and unknowns', () => {
        for (const c of ALLERGEN_CATEGORIES) expect(normalizeAllergenCategory(c.toUpperCase())).toBe(c);
        for (const m of ['Milk', 'milk', 'cream', 'butter', 'cheese', 'whey', 'casein', 'yogurt', 'dry milk']) expect(normalizeAllergenCategory(m)).toBe('Dairy');
        expect(normalizeAllergenCategory('egg')).toBe('Eggs');
        expect(normalizeAllergenCategory('shellfish')).toBe('Crustacean Shellfish');
        for (const bad of ['Gluten', 'gluten', 'Mustard', '', '  ', 'Lupin', null, 3, undefined]) expect(normalizeAllergenCategory(bad as any)).toBeNull();
    });

    it('parseAllergenResponse refuses anything not STOP-complete before parsing', () => {
        expect(parseAllergenResponse('{"confirmed":[],"reviewRequired":[]}', 'MAX_TOKENS')).toEqual({ ok: false, reason: 'truncated' });
        expect(parseAllergenResponse('{"confirmed":[],"reviewRequired":[]}')).toEqual({ ok: true, confirmed: [], reviewRequired: [], droppedCategories: 0 });
    });

    it('callGeminiStructured reports finishReason and model', async () => {
        queue({ status: 200, body: textAnswer('{"a":1}', 'MAX_TOKENS') });
        const r = await callGeminiStructured(KEY, 'p', { type: 'object' });
        expect(r).toEqual({ text: '{"a":1}', finishReason: 'MAX_TOKENS', model: 'gemini-3.5-flash-lite', schemaEnforced: true });
    });
});
