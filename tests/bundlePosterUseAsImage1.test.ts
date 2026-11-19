/**
 * BUNDLE-POSTER-USE-AS-IMAGE-1 — a generated poster becomes the bundle's official image only through
 * "Use as Bundle Image", only for the bundle it was made for, and only as the exact bytes the poster
 * route produced.
 *
 * The REAL poster route, publish route, receipt signing, fingerprinting, model, layout, fonts and sharp
 * image work run. Faked: the database (an in-memory bundle store), the session, the network (recipe
 * photos), the rasteriser (next/og) and the media storage helper (lib/s3: uploadToS3 + the S3 client).
 * Bundles, tenants and secrets are fictional.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__uaPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__uaSession) }));
jest.mock('next/og', () => ({
    ImageResponse: class {
        constructor() { /* tree not needed here */ }
        async arrayBuffer() {
            const b: Buffer = (global as any).__uaPng;
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        }
    },
}));
jest.mock('@/lib/s3', () => ({
    uploadToS3: jest.fn((...a: any[]) => (global as any).__uaUpload(...a)),
    s3Client: { send: jest.fn((cmd: any) => (global as any).__uaS3Send(cmd)) },
}));

import {
    POSTER_PUBLISH_MAX_BYTES, POSTER_RECEIPT_TTL_SECONDS, posterBundleFingerprint, posterNotesDigest, posterObjectName,
    posterSigningSecret, sha256Hex, signPosterReceipt, uploadedPosterKey, verifyPosterReceipt,
} from '@/lib/poster/posterPublish';
import { removeUnattachedPoster } from '@/lib/poster/posterStorage';

jest.setTimeout(120000);

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECRET = 'fixture-signing-secret-NOT-REAL-7d21';
const BIZ = 'biz-fixture-a';
const BIZ_B = 'biz-fixture-b';
const MEDIA = 'https://media.example.test';
const OLD_S5 = `${MEDIA}/old/keto-s5-cover.jpg`;
const OLD_S2 = `${MEDIA}/old/keto-s2-cover.jpg`;

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
const PHOTOS = [`${MEDIA}/p/roast.jpg`, `${MEDIA}/p/chicken.jpg`, `${MEDIA}/p/soup.jpg`, `${MEDIA}/p/roast-s2.jpg`, `${MEDIA}/p/other.jpg`];
const PHOTO_BYTES: Record<string, Buffer> = {};
const recipe = (id: string, name: string, image_url: string | null) => ({ id, name, image_url });

interface StoredBundle {
    id: string; business_id: string; name: string; serving_tier: string; description: string | null;
    family_id: string | null; image_url: string | null;
    contents: { position: number; recipe: { id: string; name: string; image_url: string | null } }[];
}
let STORE: Record<string, StoredBundle>;
const freshStore = (): Record<string, StoredBundle> => ({
    'b-keto-s5': {
        id: 'b-keto-s5', business_id: BIZ, name: 'Keto - Winter 27', serving_tier: 'family', description: null,
        family_id: 'fam-keto', image_url: OLD_S5,
        contents: [
            { position: 0, recipe: recipe('r1', 'Garlic Pork Roast - Keto', `${MEDIA}/p/roast.jpg`) },
            { position: 1, recipe: recipe('r2', 'Creamy Chicken (Keto)', `${MEDIA}/p/chicken.jpg`) },
            { position: 2, recipe: recipe('r3', 'Broccoli Cheese Soup - Keto', `${MEDIA}/p/soup.jpg`) },
        ],
    },
    'b-keto-s2': {
        id: 'b-keto-s2', business_id: BIZ, name: 'Keto (Serves 2) - Winter 27', serving_tier: 'serves_2', description: null,
        family_id: 'fam-keto', image_url: OLD_S2,
        contents: [
            { position: 0, recipe: recipe('r1-2', 'Garlic Pork Roast - Keto (Serves 2)', `${MEDIA}/p/roast-s2.jpg`) },
            { position: 1, recipe: recipe('r2', 'Creamy Chicken (Keto)', `${MEDIA}/p/chicken.jpg`) },
        ],
    },
    'b-other-tenant': {
        id: 'b-other-tenant', business_id: BIZ_B, name: 'Someone Else Keto', serving_tier: 'family', description: null,
        family_id: null, image_url: null,
        contents: [{ position: 0, recipe: recipe('rx', 'Other Meal', `${MEDIA}/p/other.jpg`) }],
    },
});

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────
let fetchCalls: string[] = [];
let findCalls: any[] = [];
let updateCalls: any[] = [];
let uploads: { buf: Buffer; name: string; type: string }[] = [];
let deletes: any[] = [];
let failUpload: 'throw' | 'empty' | null = null;
let failUpdate: 'throw' | 'vanish' | null = null;
const logs: string[] = [];
const ENV_KEYS = ['AUTH_SECRET', 'NEXTAUTH_SECRET', 'S3_PUBLIC_DOMAIN', 'S3_BUCKET_NAME', 'GEMINI_API_KEY', 'GEMINI_IMAGE_MODEL'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const [i, url] of PHOTOS.entries()) {
        PHOTO_BYTES[url] = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 40 * i, g: 120, b: 200 - 30 * i } } }).jpeg().toBuffer();
    }
    (global as any).__uaPng = await sharp({ create: { width: 160, height: 200, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
    for (const k of ['log', 'error', 'warn', 'info'] as const) {
        jest.spyOn(console, k).mockImplementation((...a: any[]) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); });
    }
});

afterAll(() => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

beforeEach(() => {
    STORE = freshStore();
    fetchCalls = []; findCalls = []; updateCalls = []; uploads = []; deletes = [];
    failUpload = null; failUpdate = null;
    logs.length = 0;
    process.env.AUTH_SECRET = SECRET;
    delete process.env.NEXTAUTH_SECRET;
    process.env.S3_PUBLIC_DOMAIN = MEDIA;
    process.env.S3_BUCKET_NAME = 'fixture-bucket';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_IMAGE_MODEL;
    (global as any).__uaSession = { user: { email: 'owner@example.invalid', businessId: BIZ } };
    (global as any).__uaPrisma = {
        bundle: {
            findFirst: async (args: any) => {
                findCalls.push(args);
                const b = STORE[args.where.id];
                if (!b || b.business_id !== args.where.business_id) return null;
                // Only the selected poster columns, like the real select.
                return JSON.parse(JSON.stringify({ id: b.id, name: b.name, serving_tier: b.serving_tier, description: b.description, contents: b.contents }));
            },
            updateMany: async (args: any) => {
                updateCalls.push(JSON.parse(JSON.stringify(args)));
                if (failUpdate === 'throw') throw Object.assign(new Error('connection reset'), { name: 'PrismaClientKnownRequestError' });
                if (failUpdate === 'vanish') return { count: 0 };
                let count = 0;
                for (const b of Object.values(STORE)) {
                    if (b.id === args.where.id && b.business_id === args.where.business_id) { Object.assign(b, args.data); count++; }
                }
                return { count };
            },
        },
        integration: { findUnique: async () => null }, // no Gemini key → the drawn backdrop, no AI call
    };
    (global as any).__uaUpload = async (buf: Buffer, name: string, type: string) => {
        uploads.push({ buf: Buffer.from(buf), name, type });
        if (failUpload === 'throw') throw Object.assign(new Error('bucket unavailable'), { name: 'S3ServiceException' });
        if (failUpload === 'empty') return '';
        return `${MEDIA}/preview/${1795000000000 + uploads.length}-${name}`;
    };
    (global as any).__uaS3Send = async (cmd: any) => { deletes.push({ name: cmd?.constructor?.name, input: cmd?.input }); return {}; };
    (global as any).fetch = jest.fn(async (url: string) => {
        fetchCalls.push(String(url));
        const bytes = PHOTO_BYTES[String(url)];
        if (!bytes) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } };
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers: { get: () => String(bytes.length) } };
    });
});

afterEach(() => {
    const all = logs.join('\n');
    expect(all).not.toContain(SECRET);
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
type Settings = { theme: string; backgroundInstructions?: string; showBadge?: boolean };

async function generate(id: string, settings: Settings = { theme: 'winter' }) {
    const { POST } = await import('@/app/api/bundles/[id]/poster/route');
    const res = await POST(new Request(`http://localhost/api/bundles/${id}/poster`, { method: 'POST', body: JSON.stringify(settings) }), { params: Promise.resolve({ id }) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    return { res, bytes: Buffer.from(await res.arrayBuffer()), receipt: res.headers.get('X-Poster-Receipt') };
}

function posterForm(p: { bytes?: Buffer | null; receipt?: string | null; theme?: string; backgroundInstructions?: string; showBadge?: string; extra?: Record<string, string> }) {
    const form = new FormData();
    if (p.bytes) form.append('poster', new Blob([new Uint8Array(p.bytes)], { type: 'image/jpeg' }), 'poster.jpg');
    if (p.receipt !== null && p.receipt !== undefined) form.append('receipt', p.receipt);
    form.append('theme', p.theme ?? 'winter');
    form.append('backgroundInstructions', p.backgroundInstructions ?? '');
    form.append('showBadge', p.showBadge ?? 'true');
    for (const [k, v] of Object.entries(p.extra ?? {})) form.append(k, v);
    return form;
}

async function publish(id: string, body: FormData | string) {
    const { POST } = await import('@/app/api/bundles/[id]/poster/publish/route');
    const init: RequestInit = typeof body === 'string'
        ? { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }
        : { method: 'POST', body };
    return POST(new Request(`http://localhost/api/bundles/${id}/poster/publish`, init), { params: Promise.resolve({ id }) });
}

const nothingStoredOrWritten = () => {
    expect(uploads).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
};

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('generation still stores nothing, and now signs what it made', () => {
    it('the poster carries a receipt bound to the tenant, the bundle, the exact bytes and the settings', async () => {
        const note = 'Snowy farmhouse window';
        const { bytes, receipt } = await generate('b-keto-s5', { theme: 'winter', backgroundInstructions: note, showBadge: false });
        const check = verifyPosterReceipt(receipt, SECRET);
        expect(check.ok).toBe(true);
        const r = (check as any).receipt;
        expect(r).toMatchObject({ v: 1, biz: BIZ, bundle: 'b-keto-s5', theme: 'winter', badge: false });
        expect(r.sha).toBe(sha256Hex(bytes));
        expect(r.notes).toBe(posterNotesDigest(note));
        expect(r.fp).toBe(posterBundleFingerprint(STORE['b-keto-s5'] as any));
        expect(r.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(POSTER_RECEIPT_TTL_SECONDS - 60);
        // The instructions themselves never travel in the receipt.
        expect(Buffer.from(receipt!.split('.')[0], 'base64url').toString('utf8')).not.toContain('farmhouse');
    });

    it('generating and regenerating never touch the bundle image or storage', async () => {
        await generate('b-keto-s5');
        await generate('b-keto-s5', { theme: 'fall' });
        nothingStoredOrWritten();
        expect(STORE['b-keto-s5'].image_url).toBe(OLD_S5);
    });

    it('without a signing secret the poster is still made, with no receipt, and publishing is unavailable (503)', async () => {
        delete process.env.AUTH_SECRET;
        const { bytes, receipt } = await generate('b-keto-s5');
        expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // a JPEG all the same
        expect(receipt).toBeNull();
        const res = await publish('b-keto-s5', posterForm({ bytes, receipt: 'x.y' }));
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('POSTER_PUBLISH_UNAVAILABLE');
        nothingStoredOrWritten();
        expect(posterSigningSecret({ NEXTAUTH_SECRET: 'n' })).toBe('n');
        expect(posterSigningSecret({})).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('2–5, 12 · Use as Bundle Image stores the poster and sets THIS bundle\'s image', () => {
    it('stores the exact poster bytes with the existing media storage, then writes that durable URL to bundles.image_url', async () => {
        const { bytes, receipt } = await generate('b-keto-s5');
        const res = await publish('b-keto-s5', posterForm({ bytes, receipt }));
        expect(res.status).toBe(200);
        const body = await res.json();

        // 2 · persisted through lib/s3 uploadToS3: the same bytes, as a JPEG, named like other bundle images.
        expect(uploads).toHaveLength(1);
        expect(uploads[0].buf.equals(bytes)).toBe(true);
        expect(uploads[0].type).toBe('image/jpeg');
        expect(uploads[0].name).toBe(`bundle_${BIZ}_poster.jpg`);

        // 3 · the canonical field, through one tenant-scoped write.
        expect(updateCalls).toEqual([{ where: { id: 'b-keto-s5', business_id: BIZ }, data: { image_url: body.imageUrl } }]);
        expect(STORE['b-keto-s5'].image_url).toBe(body.imageUrl);

        // 12 · the durable URL comes back: the media host, never a browser-only or inline URL.
        expect(body).toEqual({ imageUrl: `${MEDIA}/preview/1795000000001-bundle_${BIZ}_poster.jpg`, bundleId: 'b-keto-s5', message: 'Bundle image updated successfully.' });
        expect(body.imageUrl).toMatch(/^https:\/\/media\.example\.test\//);
        expect(body.imageUrl).not.toMatch(/^(blob|data):/);
    });

    it('4 · 5 · only the current bundle changes — the Serves 2 sibling keeps its own image, and vice versa', async () => {
        const s5 = await generate('b-keto-s5');
        const r5 = await (await publish('b-keto-s5', posterForm(s5))).json();
        expect(STORE['b-keto-s5'].image_url).toBe(r5.imageUrl);
        expect(STORE['b-keto-s2'].image_url).toBe(OLD_S2);
        expect(updateCalls.every((c) => c.where.id === 'b-keto-s5' && !('family_id' in c.where))).toBe(true);

        const s2 = await generate('b-keto-s2');
        const r2 = await (await publish('b-keto-s2', posterForm(s2))).json();
        expect(STORE['b-keto-s2'].image_url).toBe(r2.imageUrl);
        expect(STORE['b-keto-s5'].image_url).toBe(r5.imageUrl); // untouched by the Serves 2 publish
        expect(r2.imageUrl).not.toBe(r5.imageUrl);
        expect(updateCalls.map((c) => c.where.id)).toEqual(['b-keto-s5', 'b-keto-s2']);
    });

    it('5 · a Serves 5 poster cannot be put on the Serves 2 bundle (and the reverse)', async () => {
        const s5 = await generate('b-keto-s5');
        const s2 = await generate('b-keto-s2');
        for (const [target, poster] of [['b-keto-s2', s5], ['b-keto-s5', s2]] as const) {
            const res = await publish(target, posterForm(poster));
            expect(res.status).toBe(403);
            expect((await res.json()).code).toBe('POSTER_NOT_FOR_THIS_BUNDLE');
        }
        nothingStoredOrWritten();
        expect([STORE['b-keto-s5'].image_url, STORE['b-keto-s2'].image_url]).toEqual([OLD_S5, OLD_S2]);
    });

    it('the bundle\'s own image is not part of the poster: publishing again after an image change is allowed', async () => {
        const p = await generate('b-keto-s5');
        STORE['b-keto-s5'].image_url = `${MEDIA}/old/uploaded-in-between.jpg`;
        expect((await publish('b-keto-s5', posterForm(p))).status).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('6–8 · who can publish, and what', () => {
    it('6 · signed out → 401 before anything is read, stored or written', async () => {
        const p = await generate('b-keto-s5');
        findCalls = [];
        (global as any).__uaSession = null;
        const res = await publish('b-keto-s5', posterForm(p));
        expect(res.status).toBe(401);
        expect(findCalls).toHaveLength(0);
        nothingStoredOrWritten();
    });

    it('7 · another tenant\'s bundle → 404, read with the caller\'s tenant in the WHERE clause; nothing stored', async () => {
        const p = await generate('b-keto-s5');
        findCalls = [];
        const res = await publish('b-other-tenant', posterForm(p));
        expect(res.status).toBe(404);
        expect(findCalls[0].where).toEqual({ id: 'b-other-tenant', business_id: BIZ });
        nothingStoredOrWritten();
        expect(STORE['b-other-tenant'].image_url).toBeNull();
    });

    it('7 · a poster another tenant made cannot be published on your bundle, nor yours on theirs', async () => {
        (global as any).__uaSession = { user: { businessId: BIZ_B } };
        const theirs = await generate('b-other-tenant');
        (global as any).__uaSession = { user: { businessId: BIZ } };
        const mine = await generate('b-keto-s5');

        const a = await publish('b-keto-s5', posterForm(theirs)); // their poster, my bundle
        expect(a.status).toBe(403);
        (global as any).__uaSession = { user: { businessId: BIZ_B } };
        const b = await publish('b-keto-s5', posterForm(mine)); // my poster, my bundle, their session
        expect(b.status).toBe(404);
        nothingStoredOrWritten();
    });

    it('8 · a URL is never accepted as the poster — nothing is fetched, stored or written', async () => {
        const p = await generate('b-keto-s5');
        fetchCalls = [];
        const evil = 'https://evil.example.test/not-our-poster.jpg';
        for (const body of [
            posterForm({ receipt: p.receipt, extra: { imageUrl: evil, url: evil, poster: evil } }),
            JSON.stringify({ imageUrl: evil, receipt: p.receipt, theme: 'winter', showBadge: true }),
        ]) {
            const res = await publish('b-keto-s5', body);
            expect(res.status).toBe(400);
            expect((await res.json()).code).toBe('BAD_REQUEST');
        }
        expect(fetchCalls).toHaveLength(0);
        nothingStoredOrWritten();
        expect(read('app/api/bundles/[id]/poster/publish/route.ts')).not.toMatch(/\bfetch\(/);
    });

    it('8 · bytes the server did not make are refused, even with a genuine receipt', async () => {
        const p = await generate('b-keto-s5');
        const other = await sharp({ create: { width: 1600, height: 2000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
        const res = await publish('b-keto-s5', posterForm({ bytes: other, receipt: p.receipt }));
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('POSTER_NOT_RECOGNISED');
        nothingStoredOrWritten();
    });

    it('8 · a forged, tampered or re-targeted receipt is refused', async () => {
        const p = await generate('b-keto-s5');
        const [body, sig] = p.receipt!.split('.');
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        const retarget = Buffer.from(JSON.stringify({ ...payload, bundle: 'b-keto-s2' })).toString('base64url');
        const forged = signPosterReceipt({ biz: BIZ, bundle: 'b-keto-s5', sha: sha256Hex(p.bytes), fp: payload.fp, theme: 'winter', notes: payload.notes, badge: true }, 'a-guessed-secret');
        for (const receipt of [`${retarget}.${sig}`, forged, 'garbage', `${body}.`, `${body}.${sig}.x`, '']) {
            const res = await publish('b-keto-s5', posterForm({ bytes: p.bytes, receipt }));
            expect([400]).toContain(res.status);
        }
        nothingStoredOrWritten();
    });

    it('an oversized upload is refused before the receipt is even read', async () => {
        const p = await generate('b-keto-s5');
        const res = await publish('b-keto-s5', posterForm({ bytes: Buffer.alloc(POSTER_PUBLISH_MAX_BYTES + 1, 1), receipt: p.receipt }));
        expect(res.status).toBe(413);
        nothingStoredOrWritten();
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('9–10 · a failure never claims success and never half-changes the bundle', () => {
    it.each([['throws', 'throw'], ['returns no URL', 'empty']] as const)('9 · storage %s → 502, the bundle image is unchanged, nothing written', async (_l, mode) => {
        const p = await generate('b-keto-s5');
        failUpload = mode;
        const res = await publish('b-keto-s5', posterForm(p));
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.code).toBe('POSTER_STORAGE_FAILED');
        expect(body.error).toContain('Your bundle image was not changed.');
        expect(body.imageUrl).toBeUndefined();
        expect(updateCalls).toHaveLength(0);
        expect(STORE['b-keto-s5'].image_url).toBe(OLD_S5);
    });

    it('10 · the bundle update fails after storage → 500, no success, and the just-stored poster is removed', async () => {
        const p = await generate('b-keto-s5');
        failUpdate = 'throw';
        const res = await publish('b-keto-s5', posterForm(p));
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.code).toBe('POSTER_SAVE_FAILED');
        expect(body.imageUrl).toBeUndefined();
        expect(body.message).toBeUndefined();
        expect(STORE['b-keto-s5'].image_url).toBe(OLD_S5);
        expect(deletes).toEqual([{ name: 'DeleteObjectCommand', input: { Bucket: 'fixture-bucket', Key: `preview/1795000000001-bundle_${BIZ}_poster.jpg` } }]);
    });

    it('10 · the bundle disappears between the check and the write → 404, poster removed, no success', async () => {
        const p = await generate('b-keto-s5');
        failUpdate = 'vanish';
        const res = await publish('b-keto-s5', posterForm(p));
        expect(res.status).toBe(404);
        expect((await res.json()).imageUrl).toBeUndefined();
        expect(deletes).toHaveLength(1);
    });

    it('cleanup deletes only a key it can confirm is this tenant\'s just-stored poster', async () => {
        const env = { S3_PUBLIC_DOMAIN: `${MEDIA}/`, S3_BUCKET_NAME: 'fixture-bucket' };
        expect(uploadedPosterKey(`${MEDIA}/preview/1795000000001-bundle_${BIZ}_poster.jpg`, BIZ, env)).toBe(`preview/1795000000001-bundle_${BIZ}_poster.jpg`);
        expect(uploadedPosterKey(`${MEDIA}/1795000000001-bundle_${BIZ}_poster.jpg`, BIZ, env)).toBe(`1795000000001-bundle_${BIZ}_poster.jpg`);
        for (const url of [
            `${MEDIA}/preview/1795000000001-bundle_${BIZ_B}_poster.jpg`, // another tenant's
            `${MEDIA}/preview/1795000000001-bundle_${BIZ}_1795000000001.png`, // an uploaded cover, not a poster
            `https://elsewhere.example.test/preview/1795000000001-bundle_${BIZ}_poster.jpg`,
            `${MEDIA}/preview/../1795000000001-bundle_${BIZ}_poster.jpg`,
            OLD_S5,
        ]) {
            expect(uploadedPosterKey(url, BIZ, env)).toBeNull();
            const send = jest.fn();
            expect(await removeUnattachedPoster(url, BIZ, { send, env })).toBe('left_in_storage');
            expect(send).not.toHaveBeenCalled();
        }
        const failing = jest.fn(async () => { throw new Error('AccessDenied'); });
        expect(await removeUnattachedPoster(`${MEDIA}/1795000000001-bundle_${BIZ}_poster.jpg`, BIZ, { send: failing, env })).toBe('left_in_storage');
        expect(await removeUnattachedPoster(`${MEDIA}/1795000000001-bundle_${BIZ}_poster.jpg`, BIZ, { send: failing, env: { S3_PUBLIC_DOMAIN: MEDIA } })).toBe('left_in_storage');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('11 · an out-of-date poster cannot be published', () => {
    it.each([
        ['the theme changed', { theme: 'fall' }],
        ['the background instructions changed', { backgroundInstructions: 'Bright spring table' }],
        ['the badge was switched off', { showBadge: 'false' }],
    ])('%s since the poster was made → 409, nothing stored', async (_l, now) => {
        const p = await generate('b-keto-s5', { theme: 'winter', showBadge: true });
        const res = await publish('b-keto-s5', posterForm({ ...p, ...now }));
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('POSTER_SETTINGS_CHANGED');
        expect(body.error).toBe('Regenerate the poster before using it as the bundle image.');
        nothingStoredOrWritten();
    });

    it('instructions that only differ by what cleaning removes still match', async () => {
        const p = await generate('b-keto-s5', { theme: 'custom', backgroundInstructions: 'Bright spring table' });
        expect((await publish('b-keto-s5', posterForm({ ...p, theme: 'custom', backgroundInstructions: '  Bright spring table  ' }))).status).toBe(200);
    });

    it.each([
        ['a recipe photo changed', (b: StoredBundle) => { b.contents[0].recipe.image_url = `${MEDIA}/p/chicken.jpg`; }],
        ['the meal order changed', (b: StoredBundle) => { b.contents[0].position = 5; }],
        ['a meal was removed', (b: StoredBundle) => { b.contents.pop(); }],
        ['the bundle was renamed', (b: StoredBundle) => { b.name = 'Keto - Spring 28'; }],
        ['the serving size changed', (b: StoredBundle) => { b.serving_tier = 'serves_2'; }],
    ])('%s after generating → 409 POSTER_BUNDLE_CHANGED, nothing stored', async (_l, change) => {
        const p = await generate('b-keto-s5');
        change(STORE['b-keto-s5']);
        const res = await publish('b-keto-s5', posterForm(p));
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('POSTER_BUNDLE_CHANGED');
        nothingStoredOrWritten();
    });

    it('an expired receipt → 409 POSTER_EXPIRED', async () => {
        const p = await generate('b-keto-s5');
        const r = (verifyPosterReceipt(p.receipt, SECRET) as any).receipt;
        const old = signPosterReceipt({ biz: r.biz, bundle: r.bundle, sha: r.sha, fp: r.fp, theme: r.theme, notes: r.notes, badge: r.badge }, SECRET, Math.floor(Date.now() / 1000) - POSTER_RECEIPT_TTL_SECONDS - 5);
        const res = await publish('b-keto-s5', posterForm({ bytes: p.bytes, receipt: old }));
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('POSTER_EXPIRED');
        nothingStoredOrWritten();
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('logs', () => {
    it('publishing logs the theme and size only — never the receipt, the URL or the bundle name', async () => {
        const p = await generate('b-keto-s5');
        const res = await publish('b-keto-s5', posterForm(p));
        const { imageUrl } = await res.json();
        const all = logs.join('\n');
        expect(all).toContain(`[BundlePoster] Published as bundle image: theme=winter bytes=${p.bytes.length}`);
        for (const s of [p.receipt!, imageUrl, 'Keto - Winter', BIZ]) expect(all).not.toContain(s);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('downstream pages read the same canonical field (unchanged)', () => {
    it('the storefront, supporter fundraiser pages and the coordinator\'s bundle selection already read bundles.image_url', () => {
        expect(read('lib/publicFundraiserPayload.ts')).toContain("PUBLIC_SUPPORTER_BUNDLE_FIELDS = ['id', 'name', 'description', 'serving_tier', 'price', 'image_url']");
        expect(read('components/fundraiser/SupporterBundleDetail.tsx')).toContain('publicImageUrl(bundle.image_url)');
        expect(read('app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx')).toContain('publicImageUrl(bundle.image_url)');
        expect(read('app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx')).toContain('SELECT bu.image_url');
        expect(read('lib/campaignBundleSelection.ts')).toContain('imageUrl: b.image_url');
        expect(read('components/storefront/BundleCard.tsx')).toContain('b.image_url || firstRecipeImage');
        expect(read('app/shop/[slug]/raise-funds/page.tsx')).toContain('imageUrl: serves5.image_url ?? serves2?.image_url ?? null');
    });

    it('the publish route writes one column of one bundle, with the tenant in the WHERE clause', () => {
        const src = read('app/api/bundles/[id]/poster/publish/route.ts');
        const writes = src.match(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/g);
        expect(writes).toEqual(['prisma.bundle.updateMany(']);
        expect(src).toContain('prisma.bundle.updateMany({ where: { id: bundle.id, business_id: businessId }, data: { image_url: imageUrl } })');
        expect(src).not.toMatch(/family_id|\$executeRaw|\$queryRaw/);
        expect(src).toContain("uploadToS3(bytes, posterObjectName(businessId), 'image/jpeg')");
        expect(posterObjectName('x')).toBe('bundle_x_poster.jpg');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('16 · files this task must not touch are byte-identical to Production 29b1f27', () => {
    // sha256 at 29b1f27, line endings normalized to LF.
    const PINNED: Record<string, string> = {
        // downstream readers of the bundle image
        'lib/publicFundraiserPayload.ts': 'ab49439872b3f3e69ccbcaee5ade04ba87294780f3bcc1cae6adaaab71cdb9a7',
        'lib/supporterBundleDetail.ts': '6263c7ddc075a9844540a954bf2424aaf4687cca50e0e961af51f0029e68e639',
        'lib/campaignBundleSelection.ts': 'ce1847ee9cd6317650b3f4378e1d091a1761c9ed60e4000006794d5d4109cf5d',
        'components/fundraiser/SupporterBundleDetail.tsx': '0aa15aaac82a1cb54a09b4d4d27f0181fa90a10c879c90a019182c9dad42a3ec',
        'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx': '648e9dbd035e6346b45d49ea6d8601830b96fc1060bab95a6bfeebba9aebdda0',
        'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx': 'b343f4a7a54ba5be4c57b99ca50ed73436980bca5005f0d791942891a66286f8',
        'app/shop/[slug]/raise-funds/page.tsx': 'bed22798f5fde86a37377fcde4d5359a94e1faa22da34ce94a1a13834f124de4',
        'app/shop/[slug]/StorefrontClient.tsx': '06260aa32966b03396c59e7ad4cc24a3395dad5687b20659eee19696f8a84adc',
        'components/storefront/BundleCard.tsx': '4834775f4fd4070ca57f846812a3547a5fea4eb836df2d2e1891352268e3d9b8',
        'app/api/public/tenant/[slug]/route.ts': '39b29aa51f384f1fe158f9bb52ca938d554c070dcf3daf030017b01d5a9c531d',
        'app/api/coordinator/bundle-selection/route.ts': '2607289a537443271e10d4589f8052783986d158263427ec8425b3f1d2c3d301',
        // the existing bundle write paths and media storage, reused not changed
        'app/api/bundles/[id]/route.ts': '55aec66a7613e620cc9640831fdfa2743082c945042620a2a18fad846ae80814',
        'app/api/bundles/route.ts': 'bc7f967232cd1869d0e3f6c63906d620428aa11bcc9c221c4d511e4ad60b5b22',
        'app/api/bundles/upload-image/route.ts': 'b67695f29111eabcce9176fb35791d07cb6a5e19084bbc6c62138f80a8302f16',
        'lib/bundleUpdate.ts': '4199ce3916d75af1d3040a0aec15f58f6393455babd104f38f50707e565ef0e2',
        'lib/s3.ts': 'c15bbb9f6fe5cef32efc7bc53ee0ddab832fcf55dc503f25c4842c184d729bde',
        'lib/imageUploadPolicy.ts': 'd262215b658b7127b8c56c2eadc561f50803e8a8093e740081e85305f7916dda',
        // recipe AI and allergens
        'lib/ai/gemini.ts': '12d231b93f54e675561156330791fdde1ac047cf26de7cc2e99b4eb5e0dd3613',
        'lib/ai/recipeImagePrompt.ts': 'c3422f154ae7d3aa82f93661beb1d8a261c5d6764ac6e894017768ab4a48a798',
        'app/api/recipes/grab-image/route.ts': 'b4f6a17d3998ad96ac015cc6ebcbbebfdf4e065c18305a6e3b952b6bf443b0d8',
        'components/RecipeEditor.tsx': '0b82a23a55aefae75b6c5691592e0c6d6b9c48dad5e956abf811fb6bde47cf9a',
        'app/api/recipes/detect-allergens/route.ts': '04664aa40d92a82cfe173552fdc323fcabe4bac77b35e8ceec958050d5ef26dd',
        'lib/ai/allergenClassification.ts': '3d56d1c6bd105c5aadf46f0426045a4580b169d037606cec6092f6d0688b3797',
        // fundraiser / coordinator channel, flyer, QuickBooks, schema
        'app/coordinator/[token]/page.tsx': '766b0065d505ef1ddde1ab7d9f101f8cf88bfbc0e97d0b6db2e6869e146a7fbb',
        'app/fundraiser/[token]/page.tsx': 'fc4b041e8da10c5765758902568c571226d4b50fee8992490de7aeafc6ac0fb3',
        'app/api/fundraiser/[token]/route.ts': '1d7dcdb3e5bf2245d1b8789ae73363bb45bccfcd9cbbe58f0ae139cf502445ca',
        'lib/generateFlyer.ts': '8596e5a02613f6b0738a7d47ac57ffff4130c92bd3216e25a553c08b94faada5',
        'lib/quickbooks/config.ts': '6beb0e4019b21c0abaf702849db5d244d247a9697c2110ad619e89722b32fa15',
        'prisma/schema.prisma': 'e42d3e5b9858344fc49e48a00e15e621227446191633caa713af25cee4e99ffd',
    };
    it.each(Object.entries(PINNED))('%s', (rel, digest) => {
        expect(crypto.createHash('sha256').update(read(rel).replace(/\r\n/g, '\n')).digest('hex')).toBe(digest);
    });

    it('no migration was added', () => {
        const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        expect(dirs.filter((d) => /poster|bundle_image/i.test(d))).toEqual([]);
    });
});
