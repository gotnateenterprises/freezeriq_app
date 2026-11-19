/**
 * BUNDLE-POSTER-USE-AS-IMAGE-1 — best-effort removal of a poster that was stored but could not be
 * attached to its bundle (the database update failed or the bundle vanished in between).
 *
 * Uses the existing media client from lib/s3.ts. It deletes only the exact key this request just
 * uploaded, recovered from the URL and checked against the poster object-name shape for the caller's
 * own tenant (uploadedPosterKey). Anything else — a key it cannot recover exactly, no bucket
 * configured, a delete error — leaves the object in place and logs that fact (no key, no URL).
 * Replaced bundle images are never deleted: an earlier image may still be referenced elsewhere.
 */

import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '@/lib/s3';
import { uploadedPosterKey } from '@/lib/poster/posterPublish';

export async function removeUnattachedPoster(
    url: string,
    businessId: string,
    deps: { send?: (cmd: DeleteObjectCommand) => Promise<unknown>; env?: Record<string, string | undefined> } = {},
): Promise<'removed' | 'left_in_storage'> {
    const env = deps.env ?? process.env;
    const bucket = env.S3_BUCKET_NAME;
    const key = uploadedPosterKey(url, businessId, env);
    if (!bucket || !key) {
        console.warn('[BundlePoster] Unattached poster left in storage (its key could not be confirmed).');
        return 'left_in_storage';
    }
    try {
        const send = deps.send ?? ((cmd: DeleteObjectCommand) => s3Client.send(cmd));
        await send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        console.warn('[BundlePoster] Unattached poster removed from storage.');
        return 'removed';
    } catch (e) {
        console.error(`[BundlePoster] Unattached poster left in storage: delete failed (${(e as any)?.name ?? 'Error'}).`);
        return 'left_in_storage';
    }
}
