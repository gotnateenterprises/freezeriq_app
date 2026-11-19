import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { uploadToS3 } from '@/lib/s3';
import { normalizeBackgroundInstructions } from '@/lib/poster/backgroundPrompt';
import {
    BUNDLE_IMAGE_UPDATED_MESSAGE, POSTER_BUNDLE_SELECT, POSTER_PUBLISH_MAX_BYTES, posterBundleFingerprint, posterNotesDigest, posterObjectName,
    posterSigningSecret, sha256Hex, verifyPosterReceipt,
} from '@/lib/poster/posterPublish';
import { removeUnattachedPoster } from '@/lib/poster/posterStorage';
import { resolvePosterTheme } from '@/lib/poster/posterThemes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const REGENERATE = 'Regenerate the poster before using it as the bundle image.';
const UNCHANGED = 'Your bundle image was not changed.';

const refuse = (status: number, code: string, error: string) => NextResponse.json({ error, code }, { status });

/**
 * BUNDLE-POSTER-USE-AS-IMAGE-1 — POST /api/bundles/[id]/poster/publish: make a poster this server just
 * generated the bundle's official image (`bundles.image_url`, the field the bundle editor, the
 * storefront, the supporter fundraiser pages and the coordinator's bundle selection already read).
 *
 * multipart/form-data:
 *   poster                  the JPEG exactly as the poster route returned it
 *   receipt                 that response's X-Poster-Receipt
 *   theme, backgroundInstructions, showBadge   the settings the panel shows NOW
 *
 * Never a URL: nothing is fetched on the caller's say-so. The bytes are accepted only when the signed
 * receipt verifies and binds them (SHA-256) to the caller's tenant, this bundle, the current settings
 * and the bundle exactly as it is now (lib/poster/posterPublish.ts). Then, in order:
 *   1. store the JPEG with the existing media storage (lib/s3.ts uploadToS3 — the same bucket, public
 *      domain and Preview `preview/` folder as every other bundle and recipe image);
 *   2. write that URL to THIS bundle only, with the caller's tenant in the WHERE clause.
 * A storage failure never reaches step 2. A failed step 2 reports failure (never success) and removes
 * the just-stored poster when it can. The sibling Serves 5 / Serves 2 bundle is never touched.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    const businessId = session?.user?.businessId;
    if (!businessId) return refuse(401, 'UNAUTHORIZED', 'Unauthorized');

    const { id } = await params;

    const secret = posterSigningSecret();
    if (!secret) return refuse(503, 'POSTER_PUBLISH_UNAVAILABLE', `Posters cannot be used as the bundle image right now. ${UNCHANGED}`);

    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > POSTER_PUBLISH_MAX_BYTES + 64 * 1024) return refuse(413, 'POSTER_TOO_LARGE', 'That poster is too large to use.');

    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return refuse(400, 'BAD_REQUEST', 'Generate a poster first, then use it as the bundle image.');
    }
    const poster = form.get('poster');
    const receiptRaw = form.get('receipt');
    if (!(poster instanceof Blob) || poster.size === 0 || typeof receiptRaw !== 'string') {
        return refuse(400, 'BAD_REQUEST', 'Generate a poster first, then use it as the bundle image.');
    }
    if (poster.size > POSTER_PUBLISH_MAX_BYTES) return refuse(413, 'POSTER_TOO_LARGE', 'That poster is too large to use.');

    // The settings the panel shows now. They must be the ones the poster was made with.
    const themeResult = resolvePosterTheme(form.get('theme'));
    if (!themeResult.ok) return refuse(400, 'INVALID_POSTER_THEME', 'Please choose a season / theme.');
    const notes = normalizeBackgroundInstructions(form.get('backgroundInstructions') ?? undefined);
    if (!notes.ok) return refuse(400, notes.code, notes.message);
    const badgeRaw = form.get('showBadge');
    if (badgeRaw !== 'true' && badgeRaw !== 'false') return refuse(400, 'BAD_REQUEST', 'Invalid request.');

    const check = verifyPosterReceipt(receiptRaw, secret);
    if (!check.ok) {
        return check.reason === 'expired'
            ? refuse(409, 'POSTER_EXPIRED', `This poster was made too long ago. ${REGENERATE}`)
            : refuse(400, 'POSTER_NOT_RECOGNISED', `This poster can't be used as the bundle image. ${REGENERATE}`);
    }
    const receipt = check.receipt;

    // Tenant-scoped read: another tenant's bundle is a 404, indistinguishable from a missing one.
    const bundle = await prisma.bundle.findFirst({ where: { id, business_id: businessId }, select: POSTER_BUNDLE_SELECT });
    if (!bundle) return refuse(404, 'BUNDLE_NOT_FOUND', 'Bundle not found');

    if (receipt.biz !== businessId || receipt.bundle !== bundle.id) {
        return refuse(403, 'POSTER_NOT_FOR_THIS_BUNDLE', `This poster was made for a different bundle. ${UNCHANGED}`);
    }
    if (receipt.theme !== themeResult.theme.id || receipt.notes !== posterNotesDigest(notes.value) || receipt.badge !== (badgeRaw === 'true')) {
        return refuse(409, 'POSTER_SETTINGS_CHANGED', REGENERATE);
    }
    const bytes = Buffer.from(await poster.arrayBuffer());
    if (sha256Hex(bytes) !== receipt.sha) {
        return refuse(400, 'POSTER_NOT_RECOGNISED', `This poster can't be used as the bundle image. ${REGENERATE}`);
    }
    if (posterBundleFingerprint(bundle) !== receipt.fp) {
        return refuse(409, 'POSTER_BUNDLE_CHANGED', `This bundle has changed since the poster was made. ${REGENERATE}`);
    }

    // 1 · durable storage, through the existing media helper.
    let imageUrl: string;
    try {
        imageUrl = await uploadToS3(bytes, posterObjectName(businessId), 'image/jpeg');
    } catch (e) {
        console.error(`[BundlePoster] Publish failed: storage error (${(e as any)?.name ?? 'Error'}); bundle image unchanged.`);
        return refuse(502, 'POSTER_STORAGE_FAILED', `The poster could not be saved. ${UNCHANGED}`);
    }
    if (typeof imageUrl !== 'string' || !imageUrl) {
        console.error('[BundlePoster] Publish failed: storage returned no URL; bundle image unchanged.');
        return refuse(502, 'POSTER_STORAGE_FAILED', `The poster could not be saved. ${UNCHANGED}`);
    }

    // 2 · this bundle's existing image field, and only this bundle's.
    let updated: number;
    try {
        const result = await prisma.bundle.updateMany({ where: { id: bundle.id, business_id: businessId }, data: { image_url: imageUrl } });
        updated = result.count;
    } catch (e) {
        console.error(`[BundlePoster] Publish failed: bundle update error (${(e as any)?.name ?? 'Error'}).`);
        await removeUnattachedPoster(imageUrl, businessId);
        return refuse(500, 'POSTER_SAVE_FAILED', `The bundle image could not be updated. ${UNCHANGED}`);
    }
    if (updated !== 1) {
        console.error(`[BundlePoster] Publish failed: bundle no longer found (updated=${updated}).`);
        await removeUnattachedPoster(imageUrl, businessId);
        return refuse(404, 'BUNDLE_NOT_FOUND', 'Bundle not found');
    }

    console.log(`[BundlePoster] Published as bundle image: theme=${receipt.theme} bytes=${bytes.length}`);
    return NextResponse.json({ imageUrl, bundleId: bundle.id, message: BUNDLE_IMAGE_UPDATED_MESSAGE });
}
