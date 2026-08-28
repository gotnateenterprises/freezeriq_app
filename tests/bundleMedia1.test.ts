/**
 * BUNDLE-MEDIA-1 — local-file Bundle cover image upload.
 *
 * The defect this phase closes: BundleEditor already sent `image_url` on
 * every save, but neither POST /api/bundles nor PUT /api/bundles/[id] ever
 * wrote it — BUNDLE-AUDIT-1 found 0 of 42 Production bundles with an image.
 * There was also no local-file upload path at all: only a manual URL field
 * and an AI-generate button.
 *
 * These tests cover, behaviorally wherever practical:
 *  - the shared size/type policy (lib/imageUploadPolicy.ts), reused by both
 *    the Recipe and Bundle upload routes rather than a second standard;
 *  - the new Bundle upload route (auth, validation-before-upload, success,
 *    upload-failure handling);
 *  - that the refactored Recipe upload route is behaviorally unchanged;
 *  - that POST/PUT /api/bundles now persist image_url, including the
 *    create / replace / clear / leave-untouched contract (Acceptance A-E);
 *  - that BUNDLE-SECURITY-1 and BUNDLE-PERSISTENCE-FIX guarantees are not
 *    weakened by any of the above (Acceptance I).
 */

import { validateImageUpload, ALLOWED_IMAGE_TYPES, MAX_IMAGE_UPLOAD_BYTES } from '@/lib/imageUploadPolicy';

const TENANT = 'biz-aaaa-1111';
const OTHER = 'biz-bbbb-2222';

// ===========================================================================
describe('shared image upload policy (lib/imageUploadPolicy.ts)', () => {
    it('accepts every currently-supported format', () => {
        for (const type of ALLOWED_IMAGE_TYPES) {
            expect(validateImageUpload({ size: 1024, type })).toEqual({ ok: true });
        }
    });

    it('F. rejects an unsupported file type with a clear message', () => {
        const result = validateImageUpload({ size: 1024, type: 'application/pdf' });
        expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/invalid file type/i) });
    });

    it('G. rejects a file over the size ceiling before any upload is attempted', () => {
        const result = validateImageUpload({ size: MAX_IMAGE_UPLOAD_BYTES + 1, type: 'image/png' });
        expect(result).toEqual({ ok: false, status: 400, error: expect.stringMatching(/too large/i) });
    });

    it('accepts a file exactly at the ceiling', () => {
        expect(validateImageUpload({ size: MAX_IMAGE_UPLOAD_BYTES, type: 'image/png' })).toEqual({ ok: true });
    });

    it('rejects a missing or empty file', () => {
        expect(validateImageUpload(null)).toEqual({ ok: false, status: 400, error: expect.stringMatching(/no file/i) });
        expect(validateImageUpload({ size: 0, type: 'image/png' })).toEqual({ ok: false, status: 400, error: expect.stringMatching(/no file/i) });
    });

    it('the 5MB ceiling matches the Recipe endpoint\'s established policy exactly', () => {
        expect(MAX_IMAGE_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
        expect([...ALLOWED_IMAGE_TYPES].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp'].sort());
    });
});

// ===========================================================================
const mockAuth = jest.fn();
const mockUploadToS3 = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/s3', () => ({ uploadToS3: (...args: any[]) => mockUploadToS3(...args) }));

const makeFile = (name: string, type: string, size: number) => {
    const file = new File([new Uint8Array(size)], name, { type });
    return file;
};

const uploadTo = async (path: string, file: File | null) => {
    const mod = path === 'bundles'
        ? require('@/app/api/bundles/upload-image/route')
        : require('@/app/api/recipes/upload-image/route');
    const fd = new FormData();
    if (file) fd.append('file', file);
    return mod.POST(new Request('https://x/api/upload', { method: 'POST', body: fd }));
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
    mockUploadToS3.mockResolvedValue('https://images.example.com/uploaded.png');
});

describe('POST /api/bundles/upload-image', () => {
    it('an unauthenticated caller is rejected before any upload is attempted', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await uploadTo('bundles', makeFile('cover.png', 'image/png', 1024));

        expect(res.status).toBe(401);
        expect(mockUploadToS3).not.toHaveBeenCalled();
    });

    it('F. an invalid file type never reaches storage', async () => {
        const res = await uploadTo('bundles', makeFile('cover.pdf', 'application/pdf', 1024));

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/invalid file type/i);
        expect(mockUploadToS3).not.toHaveBeenCalled();
    });

    it('G. an oversized file never reaches storage', async () => {
        const res = await uploadTo('bundles', makeFile('cover.png', 'image/png', MAX_IMAGE_UPLOAD_BYTES + 1));

        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/too large/i);
        expect(mockUploadToS3).not.toHaveBeenCalled();
    });

    it('a valid upload returns the storage URL, keyed with the caller\'s own business', async () => {
        const res = await uploadTo('bundles', makeFile('cover.png', 'image/png', 2048));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.url).toBe('https://images.example.com/uploaded.png');
        expect(mockUploadToS3).toHaveBeenCalledTimes(1);
        const [, safeName] = mockUploadToS3.mock.calls[0];
        expect(safeName).toContain(TENANT);
        expect(safeName.startsWith('bundle_')).toBe(true);
    });

    it('H. a storage failure returns an error, never a false success', async () => {
        mockUploadToS3.mockRejectedValue(new Error('S3 unreachable'));
        const res = await uploadTo('bundles', makeFile('cover.png', 'image/png', 2048));
        const body = await res.json();

        expect(res.status).toBe(500);
        expect(body.url).toBeUndefined();
        expect(body.error).toBeTruthy();
    });

    it('tenant safety: two different tenants uploading get distinctly-keyed objects', async () => {
        await uploadTo('bundles', makeFile('a.png', 'image/png', 100));
        mockAuth.mockResolvedValue({ user: { id: 'u2', businessId: OTHER } });
        await uploadTo('bundles', makeFile('b.png', 'image/png', 100));

        const keys = mockUploadToS3.mock.calls.map((c) => c[1]);
        expect(keys[0]).toContain(TENANT);
        expect(keys[1]).toContain(OTHER);
        expect(keys[0]).not.toBe(keys[1]);
    });
});

describe('POST /api/recipes/upload-image — refactor is behavior-preserving', () => {
    it('still rejects the same way for an invalid type', async () => {
        const res = await uploadTo('recipes', makeFile('x.pdf', 'application/pdf', 10));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/invalid file type/i);
    });

    it('still rejects the same way when oversized', async () => {
        const res = await uploadTo('recipes', makeFile('x.png', 'image/png', MAX_IMAGE_UPLOAD_BYTES + 1));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/too large/i);
    });

    it('still returns { url } on success, keyed with recipe_ not bundle_', async () => {
        const res = await uploadTo('recipes', makeFile('x.png', 'image/png', 100));
        expect(res.status).toBe(200);
        const [, safeName] = mockUploadToS3.mock.calls[0];
        expect(safeName.startsWith('recipe_')).toBe(true);
    });

    it('still requires authentication', async () => {
        mockAuth.mockResolvedValue(null);
        const res = await uploadTo('recipes', makeFile('x.png', 'image/png', 100));
        expect(res.status).toBe(401);
    });
});

// ===========================================================================
// Bundle create/edit persistence — Acceptance A-E, I
// ===========================================================================
type Row = Record<string, any>;
const store: { bundles: Row[]; contents: Row[]; recipes: Row[] } = { bundles: [], contents: [], recipes: [] };
let seq = 0;

const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && Array.isArray((v as any).in)) return (v as any).in.includes(row[k]);
        return row[k] === v;
    });

const makeTx = () => ({
    bundle: {
        findUnique: async ({ where, select }: any) => {
            const r = store.bundles.find((x) => matches(x, where));
            if (!r) return null;
            if (!select) return { ...r };
            const out: Row = {}; for (const k of Object.keys(select)) out[k] = r[k];
            return out;
        },
        create: async ({ data }: any) => {
            const row = { id: `b-${++seq}`, ...data };
            store.bundles.push(row);
            return { ...row };
        },
        update: async ({ where, data }: any) => {
            const row = store.bundles.find((x) => matches(x, where));
            if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
            for (const [k, v] of Object.entries(data)) if (v !== undefined) (row as any)[k] = v;
            return { ...row };
        },
    },
    bundleContent: {
        deleteMany: async ({ where }: any) => {
            const removed = store.contents.filter((c) => matches(c, where));
            store.contents = store.contents.filter((c) => !matches(c, where));
            return { count: removed.length };
        },
        createMany: async ({ data }: any) => {
            for (const d of data) store.contents.push({ id: `bc-${++seq}`, ...d });
            return { count: data.length };
        },
    },
    recipe: {
        findMany: async ({ where }: any) => store.recipes.filter((r) => matches(r, where)),
    },
});

const prismaDouble: any = {
    ...makeTx(),
    $transaction: async (fn: any) => fn(makeTx()),
};

jest.mock('@/lib/db', () => ({ prisma: prismaDouble }));

const post = async (body: any) => {
    const { POST } = require('@/app/api/bundles/route');
    return POST(new Request('https://x/api/bundles', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
};
const put = async (id: string, body: any) => {
    const { PUT } = require('@/app/api/bundles/[id]/route');
    return PUT(new Request(`https://x/api/bundles/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });
};

beforeEach(() => {
    store.bundles = []; store.contents = []; store.recipes = [];
    seq = 0;
    mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: TENANT } });
});

describe('A. create with an uploaded image persists it', () => {
    it('a create carrying image_url saves it on the row', async () => {
        const res = await post({ name: 'Comfort Food', sku: 'CF-1', image_url: 'https://images.example.com/cover.png' });
        expect(res.status).toBe(200);
        const created = (await res.json());
        expect(store.bundles.find((b) => b.id === created.id).image_url).toBe('https://images.example.com/cover.png');
    });

    it('a create with no image_url stores null, not undefined or an empty string', async () => {
        const res = await post({ name: 'No Cover', sku: 'NC-1' });
        const created = await res.json();
        expect(store.bundles.find((b) => b.id === created.id).image_url).toBeNull();
    });
});

describe('B. existing bundle: uploading and saving persists the image', () => {
    it('a PUT that sets image_url on a bundle that had none writes it', async () => {
        store.bundles.push({ id: 'b1', business_id: TENANT, name: 'Q2', sku: 'Q2-1', image_url: null });

        const res = await put('b1', { name: 'Q2', sku: 'Q2-1', image_url: 'https://images.example.com/new.png' });

        expect(res.status).toBe(200);
        expect(store.bundles[0].image_url).toBe('https://images.example.com/new.png');
    });
});

describe('C. replacing an image persists the NEW one, not both', () => {
    it('a second upload+save overwrites the first URL', async () => {
        store.bundles.push({ id: 'b1', business_id: TENANT, name: 'Q2', sku: 'Q2-1', image_url: 'https://images.example.com/old.png' });

        const res = await put('b1', { name: 'Q2', sku: 'Q2-1', image_url: 'https://images.example.com/replacement.png' });

        expect(res.status).toBe(200);
        expect(store.bundles[0].image_url).toBe('https://images.example.com/replacement.png');
        expect(store.bundles[0].image_url).not.toBe('https://images.example.com/old.png');
    });
});

describe('D. clearing the image restores the fallback (null)', () => {
    it('submitting an empty image_url clears an existing one', async () => {
        store.bundles.push({ id: 'b1', business_id: TENANT, name: 'Q2', sku: 'Q2-1', image_url: 'https://images.example.com/old.png' });

        const res = await put('b1', { name: 'Q2', sku: 'Q2-1', image_url: '' });

        expect(res.status).toBe(200);
        expect(store.bundles[0].image_url).toBeNull();
    });
});

describe('E. editing other fields without touching the image leaves it alone', () => {
    it('BundleEditor always resends the loaded image_url unchanged — round-trips correctly', async () => {
        store.bundles.push({ id: 'b1', business_id: TENANT, name: 'Old Name', sku: 'Q2-1', image_url: 'https://images.example.com/keep.png' });

        // Exactly what the editor sends: the whole form, image_url included but unedited.
        const res = await put('b1', { name: 'New Name', sku: 'Q2-1', image_url: 'https://images.example.com/keep.png' });

        expect(res.status).toBe(200);
        expect(store.bundles[0].name).toBe('New Name');
        expect(store.bundles[0].image_url).toBe('https://images.example.com/keep.png');
    });

    it('defensive: a caller that omits image_url entirely does not erase an existing one', async () => {
        store.bundles.push({ id: 'b1', business_id: TENANT, name: 'Old Name', sku: 'Q2-1', image_url: 'https://images.example.com/keep.png' });

        // No image_url key at all — unlike '', this must be left untouched.
        const res = await put('b1', { name: 'New Name', sku: 'Q2-1' });

        expect(res.status).toBe(200);
        expect(store.bundles[0].image_url).toBe('https://images.example.com/keep.png');
    });

    it('saving contents alongside an unedited image touches neither incorrectly', async () => {
        store.recipes.push({ id: 'r1', name: 'Taco Casserole', business_id: TENANT });
        store.bundles.push({ id: 'b1', business_id: TENANT, name: 'Q2', sku: 'Q2-1', image_url: 'https://images.example.com/keep.png' });
        store.contents.push({ id: 'bc1', bundle_id: 'b1', recipe_id: 'r1', position: 0, quantity: 1 });

        const res = await put('b1', {
            name: 'Q2', sku: 'Q2-1', image_url: 'https://images.example.com/keep.png',
            contents: [{ recipe_id: 'r1' }],
        });

        expect(res.status).toBe(200);
        expect(store.bundles[0].image_url).toBe('https://images.example.com/keep.png');
        expect(store.contents).toHaveLength(1);
    });
});

describe('I. existing Bundle security and persistence guarantees are untouched', () => {
    it('editing another tenant\'s bundle is still forbidden — image_url cannot bypass ownership', async () => {
        store.bundles.push({ id: 'b1', business_id: OTHER, name: 'Rival', sku: 'RV-1', image_url: null });

        const res = await put('b1', { name: 'Hijack', sku: 'RV-1', image_url: 'https://images.example.com/hijack.png' });

        expect(res.status).toBe(403);
        expect(store.bundles[0].image_url).toBeNull();
    });

    it('creating with a foreign recipe_id is still refused, image_url notwithstanding', async () => {
        store.recipes.push({ id: 'r-foreign', name: 'Foreign', business_id: OTHER });

        const res = await post({
            name: 'Sneaky', sku: 'SN-1',
            image_url: 'https://images.example.com/cover.png',
            contents: [{ recipe_id: 'r-foreign' }],
        });

        expect(res.status).toBe(403);
        expect(store.bundles).toHaveLength(0);
    });

    it('the resolveBundleContents call in both routes is untouched by this phase', () => {
        const create = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app/api/bundles/route.ts'), 'utf8');
        const edit = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app/api/bundles/[id]/route.ts'), 'utf8');
        expect(create).toContain('resolveBundleContents(');
        expect(edit).toContain('resolveBundleContents(');
    });

    /**
     * Source-level on purpose. jest runs with testEnvironment 'node' — no DOM,
     * so BundleEditor cannot be rendered here and this phase may not add
     * tooling to change that. The upload API is proven behaviorally above;
     * this pins the client handler that turns a successful/failed response
     * into form state.
     */
    it('the upload handler posts to the Bundle-specific endpoint, not the Recipe one', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components/BundleEditor.tsx'), 'utf8');
        const handler = src.slice(src.indexOf('const handleUploadBundleImage'), src.indexOf('const onSubmit'));
        expect(handler).toContain("fetch('/api/bundles/upload-image'");
    });

    it('H. image_url is set ONLY on a successful response — a failure never shows a false image', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components/BundleEditor.tsx'), 'utf8');
        const handler = src.slice(src.indexOf('const handleUploadBundleImage'), src.indexOf('const onSubmit'));
        expect(handler).toMatch(/if \(res\.ok && data\.url\)\s*\{\s*\n\s*setValue\('image_url', data\.url/);
        // The success branch must have a real else that surfaces the error —
        // not a bare setValue that runs regardless of res.ok.
        const successIdx = handler.indexOf("if (res.ok && data.url)");
        const elseIdx = handler.indexOf('} else {', successIdx);
        expect(elseIdx).toBeGreaterThan(successIdx);
    });

    it('the visible upload control is labeled "Upload Image" / "Replace Image", not a generic icon-only affordance', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components/BundleEditor.tsx'), 'utf8');
        expect(src).toContain("'Replace Image' : 'Upload Image'");
        expect(src).toContain('bundleImageInputRef.current?.click()');
    });

    it('no schema or migration change accompanies this phase', () => {
        const { execSync } = require('child_process');
        const changed = execSync('git status --porcelain prisma/', { cwd: process.cwd(), encoding: 'utf8' });
        expect(changed).not.toContain('migrations/');
    });
});
