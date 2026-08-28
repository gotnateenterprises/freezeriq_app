/**
 * BUNDLE-MEDIA-1. The single format/size policy for every local-file image
 * upload in the product — Recipe photos, Bundle covers, and any future media
 * surface. Extracted from app/api/recipes/upload-image/route.ts (the
 * canonical, already-shipped policy) so Bundle uploads reuse it exactly
 * rather than a second, hand-copied standard that could quietly drift from
 * the original.
 */

/** Same four formats the Recipe upload endpoint has accepted since launch. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** Same 5MB ceiling the Recipe upload endpoint has enforced since launch. */
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageUploadValidation =
    | { ok: true }
    | { ok: false; status: 400; error: string };

/**
 * Validates a submitted file against the shared policy BEFORE any upload is
 * attempted, so an oversized or invalid file is refused immediately rather
 * than accepted and failing later in storage.
 */
export function validateImageUpload(file: { size: number; type: string } | null | undefined): ImageUploadValidation {
    if (!file || file.size === 0) {
        return { ok: false, status: 400, error: 'No file uploaded' };
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
        return { ok: false, status: 400, error: `File too large (max ${MAX_IMAGE_UPLOAD_BYTES / (1024 * 1024)}MB)` };
    }
    if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
        return { ok: false, status: 400, error: 'Invalid file type. Only JPEG, PNG, WEBP, and GIF are allowed.' };
    }
    return { ok: true };
}
