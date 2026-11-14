/**
 * RECIPE-AI-IMAGE-MODEL-1 — recipe photos move from the shut-down Imagen model to native Gemini image
 * generation (`gemini-3.1-flash-image` via generateContent), and a failed generation can never be
 * stored as a recipe photo.
 *
 * Google is never called: `fetch` is replaced per test, storage (`uploadToS3`) and the database are
 * doubles. Recipes and tenants are fictional.
 */
import fs from 'fs';
import path from 'path';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__aiImgPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__aiImgSession) }));
jest.mock('@/lib/s3', () => ({ uploadToS3: jest.fn() }));

import {
    DEFAULT_IMAGE_MODEL, RECIPE_IMAGE_CONFIG, buildRecipeImageRequest, extractGeneratedImage,
    generateRecipeImage, imageModelId, isRecipeImageError, sniffImageType,
} from '@/lib/ai/gemini';
import { uploadToS3 } from '@/lib/s3';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A real 1x1 PNG padded past the 1000-byte floor, and a JPEG header likewise.
const PNG = Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
    Buffer.alloc(1200, 0),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1500, 7)]);
const okBody = (img: Buffer, extraParts: any[] = []) => ({
    candidates: [{
        finishReason: 'STOP',
        content: { parts: [...extraParts, { inlineData: { mimeType: 'image/png', data: img.toString('base64') } }] },
    }],
});

type FetchCall = { url: string; init: any };
let calls: FetchCall[] = [];
const mockFetch = (status: number, body: unknown, opts: { rawText?: string; throws?: boolean } = {}) => {
    calls = [];
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        if (opts.throws) throw new Error('ECONNRESET');
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: String(status),
            json: async () => { if (opts.rawText !== undefined) throw new SyntaxError('bad json'); return body; },
            text: async () => opts.rawText ?? JSON.stringify(body),
        };
    });
};

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { delete process.env.GEMINI_IMAGE_MODEL; });

// ---------------------------------------------------------------------------
describe('model and request', () => {
    it('the recipe-photo model is gemini-3.1-flash-image, overridable only by GEMINI_IMAGE_MODEL', () => {
        expect(DEFAULT_IMAGE_MODEL).toBe('gemini-3.1-flash-image');
        expect(imageModelId({} as any)).toBe('gemini-3.1-flash-image');
        expect(imageModelId({ GEMINI_IMAGE_MODEL: '  ' } as any)).toBe('gemini-3.1-flash-image');
        expect(imageModelId({ GEMINI_IMAGE_MODEL: 'gemini-nano-banana-2.1' } as any)).toBe('gemini-nano-banana-2.1');
    });

    it('no active code references a retired Imagen model or the Imagen :predict endpoint', () => {
        const walk = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
            .flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : []);
        const active = ['app', 'lib', 'components'].flatMap(walk);
        // Comments may name the retired model as labelled history; code may not.
        const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const hits = active.filter((f) => /imagen-\d|:predict\b|callImagen/i.test(code(f)));
        expect(hits).toEqual([]);
        expect(read('lib/ai/gemini.ts')).toMatch(/The old path called Imagen[\s\S]*imagen-4\.0-fast-generate-001[\s\S]*shut down/);
    });

    it('the request: generateContent on the image model, key in the header (not the URL), image output, 1:1 at 1K, no grounding', async () => {
        mockFetch(200, okBody(PNG));
        await generateRecipeImage('fixture-key-not-real', 'A photo of fixture soup. No text, no logos, no people.');
        expect(calls).toHaveLength(1);
        const { url, init } = calls[0];
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
        expect(url).not.toContain('key=');
        expect(init.method).toBe('POST');
        expect(init.headers['x-goog-api-key']).toBe('fixture-key-not-real');
        const body = JSON.parse(init.body);
        expect(body).toEqual(buildRecipeImageRequest('A photo of fixture soup. No text, no logos, no people.'));
        expect(body.generationConfig.responseModalities).toContain('IMAGE');
        expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
        expect(RECIPE_IMAGE_CONFIG).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
        expect(body.tools).toBeUndefined(); // no Search grounding for food photos
        expect(body.contents[0].parts).toEqual([{ text: 'A photo of fixture soup. No text, no logos, no people.' }]);
    });

    it('the recipe prompt is unchanged: same dish inputs, still asks for no text, logos or people', () => {
        const src = read('app/api/recipes/grab-image/route.ts');
        expect(src).toContain('A high-end, professional studio food photograph of "${name}"${contextText}${descText}.');
        expect(src).toContain('No text, no logos, no people.');
        expect(src).toContain("` with ingredients: ${ingredients.join(', ')}`");
    });
});

// ---------------------------------------------------------------------------
describe('response handling', () => {
    it('finds the image even when text and thought parts come first; the type comes from the bytes', () => {
        const img = extractGeneratedImage(okBody(JPEG, [
            { text: 'Here is your photo.' },
            { thought: true, inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } },
        ]), 'gemini-3.1-flash-image');
        expect(img.mimeType).toBe('image/jpeg'); // the JPEG part, not the thought draft, despite mimeType claims
        expect(img.extension).toBe('jpg');
        expect(img.bytes.equals(JPEG)).toBe(true);
        expect(img.model).toBe('gemini-3.1-flash-image');
    });

    it('recognises PNG, JPEG and WebP signatures and nothing else', () => {
        expect(sniffImageType(PNG)?.mimeType).toBe('image/png');
        expect(sniffImageType(JPEG)?.mimeType).toBe('image/jpeg');
        const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(10)]);
        expect(sniffImageType(webp)?.mimeType).toBe('image/webp');
        expect(sniffImageType(Buffer.from('<html>not an image</html>'))).toBeNull();
        expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    });

    const failCases: [string, number, unknown, string, { rawText?: string; throws?: boolean }][] = [
        ['402 credits depleted', 402, { error: { code: 402 } }, 'AI_QUOTA', {}],
        ['429 rate limit', 429, { error: { code: 429 } }, 'AI_QUOTA', {}],
        ['404 model gone', 404, { error: { code: 404 } }, 'AI_API_ERROR', {}],
        ['500 server error', 500, { error: {} }, 'AI_API_ERROR', {}],
        ['network failure', 200, {}, 'AI_API_ERROR', { throws: true }],
        ['non-JSON 200', 200, null, 'AI_MALFORMED', { rawText: '<html>' }],
        ['prompt blocked', 200, { promptFeedback: { blockReason: 'SAFETY' } }, 'AI_BLOCKED', {}],
        ['image blocked', 200, { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }, 'AI_BLOCKED', {}],
        ['prohibited content', 200, { candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] }, 'AI_BLOCKED', {}],
        ['no candidates', 200, { candidates: [] }, 'AI_NO_IMAGE', {}],
        ['text only, no image', 200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Sorry' }] } }] }, 'AI_NO_IMAGE', {}],
        ['only a thought image', 200, { candidates: [{ content: { parts: [{ thought: true, inlineData: { data: PNG.toString('base64') } }] } }] }, 'AI_NO_IMAGE', {}],
        ['empty image data', 200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: '' } }] } }] }, 'AI_NO_IMAGE', {}],
        ['bytes are not an image', 200, okBody(Buffer.alloc(3000, 65)), 'AI_INVALID_IMAGE', {}],
        ['image too small', 200, okBody(PNG.subarray(0, 40)), 'AI_INVALID_IMAGE', {}],
    ];
    it.each(failCases)('%s → %s, with no image returned', async (_label, status, body, code, opts) => {
        mockFetch(status, body, opts);
        let err: unknown;
        try { await generateRecipeImage('fixture-key-not-real', 'p'); } catch (e) { err = e; }
        expect(isRecipeImageError(err)).toBe(true);
        expect((err as any).code).toBe(code);
        // The error never carries the key.
        expect(String((err as any).message)).not.toContain('fixture-key-not-real');
    });
});

// ---------------------------------------------------------------------------
// The route: POST /api/recipes/grab-image
// ---------------------------------------------------------------------------
const TENANT = 'biz-aiimg-a';
const OTHER = 'biz-aiimg-b';
const RECIPE = 'rcp-aiimg-0001';
const FOREIGN = 'rcp-aiimg-9999';

const makeDb = () => {
    const recipes = [
        { id: RECIPE, business_id: TENANT, image_url: 'https://media.example.test/old.png', base_yield_qty: 5 },
        { id: FOREIGN, business_id: OTHER, image_url: null, base_yield_qty: 2 },
    ];
    const writes: any[] = [];
    const db = {
        recipes, writes,
        client: {
            integration: { findUnique: jest.fn(async () => null) }, // no tenant key → platform key
            user: { findUnique: jest.fn(async () => null) },
            recipe: {
                findFirst: jest.fn(async ({ where }: any) =>
                    recipes.find((r) => r.id === where.id && r.business_id === where.business_id) ? { id: where.id } : null),
                updateMany: jest.fn(async ({ where, data }: any) => {
                    writes.push({ where, data });
                    const rows = recipes.filter((r) => r.id === where.id && r.business_id === where.business_id);
                    rows.forEach((r) => Object.assign(r, data));
                    return { count: rows.length };
                }),
            },
        },
    };
    (global as any).__aiImgPrisma = db.client;
    return db;
};
const signIn = (businessId: string | null) => {
    (global as any).__aiImgSession = businessId === null ? null : { user: { email: 'owner@example.test', businessId } };
};
const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/recipes/grab-image/route');
    const res = await POST(new Request('http://localhost/api/recipes/grab-image', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) as any);
    return { status: res.status, body: await res.json() };
};
const upload = uploadToS3 as jest.Mock;

describe('route', () => {
    beforeEach(() => {
        process.env.GEMINI_API_KEY = 'fixture-platform-key-not-real';
        signIn(TENANT);
        upload.mockReset();
        upload.mockImplementation(async (_b: Buffer, name: string) => `https://media.example.test/preview/${name}`);
    });
    afterAll(() => { delete process.env.GEMINI_API_KEY; });

    it('editor (no recipeId): returns the stored URL, stores the bytes with their real type, writes no recipe', async () => {
        const db = makeDb();
        mockFetch(200, okBody(JPEG));
        const r = await post({ name: 'Fixture Chili', ingredients: ['beans'], description: 'Smoky.' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ source: 'gemini-image', model: 'gemini-3.1-flash-image', saved: false });
        expect(r.body.url).toMatch(/^https:\/\/media\.example\.test\/preview\/recipe-ai-gen-.+\.jpg$/);
        expect(upload).toHaveBeenCalledTimes(1);
        const [bytes, name, type] = upload.mock.calls[0];
        expect(Buffer.isBuffer(bytes) && bytes.equals(JPEG)).toBe(true);
        expect(name).toMatch(/\.jpg$/);
        expect(type).toBe('image/jpeg');
        expect(db.writes).toEqual([]);
        // The prompt carries the recipe's own name, ingredients and description.
        const prompt = JSON.parse(calls[0].init.body).contents[0].parts[0].text;
        expect(prompt).toContain('"Fixture Chili" with ingredients: beans. Smoky.');
    });

    it('a failed generation returns an error and NO url (the placeholder is never offered for saving)', async () => {
        for (const [status, body, code, http] of [
            [404, { error: {} }, 'AI_API_ERROR', 502],
            [402, { error: {} }, 'AI_QUOTA', 429],
            [200, { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }, 'AI_BLOCKED', 422],
            [200, { candidates: [{ content: { parts: [{ text: 'no' }] } }] }, 'AI_NO_IMAGE', 502],
        ] as const) {
            const db = makeDb();
            mockFetch(status, body);
            const r = await post({ name: 'Fixture Chili', recipeId: RECIPE });
            expect(r.status).toBe(http);
            expect(r.body.code).toBe(code);
            expect(r.body.url).toBeUndefined();
            expect(JSON.stringify(r.body)).not.toContain('food-placeholder');
            expect(upload).not.toHaveBeenCalled();
            expect(db.writes).toEqual([]);
            expect(db.recipes[0].image_url).toBe('https://media.example.test/old.png'); // existing photo kept
        }
    });

    it('a storage failure returns STORAGE_FAILED, no url, and leaves the recipe untouched', async () => {
        const db = makeDb();
        mockFetch(200, okBody(PNG));
        upload.mockRejectedValueOnce(new Error('bucket unreachable'));
        const r = await post({ name: 'Fixture Chili', recipeId: RECIPE });
        expect(r.status).toBe(502);
        expect(r.body).toEqual({ error: expect.any(String), code: 'STORAGE_FAILED' });
        expect(db.writes).toEqual([]);
        expect(db.recipes[0].image_url).toBe('https://media.example.test/old.png');
    });

    it('Auto-Grab (recipeId): saves ONLY image_url, tenant-scoped, and reports saved', async () => {
        const db = makeDb();
        mockFetch(200, okBody(PNG));
        const r = await post({ name: 'Fixture Chili', recipeId: RECIPE });
        expect(r.status).toBe(200);
        expect(r.body.saved).toBe(true);
        expect(db.writes).toEqual([{ where: { id: RECIPE, business_id: TENANT }, data: { image_url: r.body.url } }]);
        expect(db.recipes[0]).toMatchObject({ image_url: r.body.url, base_yield_qty: 5 }); // yield untouched
    });

    it("another tenant's recipe: 404 BEFORE any billable call or upload", async () => {
        const db = makeDb();
        mockFetch(200, okBody(PNG));
        const r = await post({ name: 'Fixture Chili', recipeId: FOREIGN });
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('RECIPE_NOT_FOUND');
        expect(calls).toHaveLength(0);
        expect(upload).not.toHaveBeenCalled();
        expect(db.writes).toEqual([]);
        expect(db.recipes[1].image_url).toBeNull();
    });

    it('signed out: 401 and no call; a bad recipeId or missing name: 400 and no call', async () => {
        makeDb();
        mockFetch(200, okBody(PNG));
        signIn(null);
        expect((await post({ name: 'x' })).status).toBe(401);
        signIn(TENANT);
        expect((await post({ name: 'x', recipeId: 42 })).status).toBe(400);
        expect((await post({ recipeId: RECIPE })).status).toBe(400);
        expect(calls).toHaveLength(0);
        expect(upload).not.toHaveBeenCalled();
    });

    it('no API key anywhere: AI_KEY_MISSING, nothing called or stored', async () => {
        makeDb();
        delete process.env.GEMINI_API_KEY;
        mockFetch(200, okBody(PNG));
        const r = await post({ name: 'x', recipeId: RECIPE });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('AI_KEY_MISSING');
        expect(calls).toHaveLength(0);
        process.env.GEMINI_API_KEY = 'fixture-platform-key-not-real';
    });
});

// ---------------------------------------------------------------------------
// Auto-Grab (components/RecipePageClient.tsx) — source pins; no DOM environment in this repo.
// ---------------------------------------------------------------------------
describe('Auto-Grab Photos', () => {
    const SRC = read('components/RecipePageClient.tsx');
    const batch = SRC.slice(SRC.indexOf('const handleBatchAutoGrab'), SRC.indexOf('const handleSaveGeneratedRecipe'));

    it('stays an explicit, confirmed, sequential tenant action over the listed recipes (overwrite warning kept)', () => {
        expect(batch).toContain('overwriting any current photos. Continue?');
        expect(batch).toMatch(/for \(const recipe of recipes\)/);
        expect(batch).toMatch(/await fetch\('\/api\/recipes\/grab-image'/);
        expect(SRC).toContain('Auto-Grab Photos');
    });

    it('sends the recipe id and never PUTs the list row back through the full recipe update', () => {
        expect(batch).toContain('JSON.stringify({ recipeId: recipe.id, name: recipe.name })');
        expect(batch).not.toMatch(/\/api\/recipes\/\$\{recipe\.id\}/);
        expect(batch).not.toMatch(/method: 'PUT'/);
        expect(batch).not.toContain('...recipe');
    });

    it('counts only server-confirmed saves; a failure keeps the photo; quota / no key / signed out stops the batch', () => {
        expect(batch).toContain('grabRes.ok && grabData.saved');
        expect(batch).toContain("['AI_QUOTA', 'AI_KEY_MISSING'].includes(grabData.code)");
        expect(batch).toContain('grabRes.status === 401');
        expect(batch).toContain('if (stoppedEarly) break;');
        expect(batch).toContain('failed and kept their current photo');
        expect(batch).not.toContain('Successfully processed');
    });
});
