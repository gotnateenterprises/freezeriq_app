/**
 * FR-TAX-1 — what an organization tax-exemption document is allowed to be.
 *
 * A SEPARATE policy from the existing image-upload rules on purpose. The
 * existing upload path (app/api/upload/route.ts -> lib/s3.ts) accepts images
 * only AND returns a PUBLIC URL from a flat, tenant-unprefixed bucket.
 * Widening that policy to admit PDFs would have quietly routed government tax
 * paperwork into public object storage. This policy governs a different,
 * private path.
 */

/** Practical business-document formats. Nothing executable, nothing exotic. */
export const TAX_DOCUMENT_ALLOWED_TYPES = [
    'application/pdf',
    'image/jpeg',
    'image/png',
] as const;

export type TaxDocumentMimeType = typeof TAX_DOCUMENT_ALLOWED_TYPES[number];

/**
 * 5 MB. An exemption certificate is a page or two; the cap exists because
 * these bytes live in Postgres (see the OrganizationTaxDocument docstring for
 * why that is the provably-private option here) and an unbounded column would
 * be a denial-of-service vector against the database rather than a feature.
 */
export const TAX_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

export const TAX_DOCUMENT_ACCEPT_ATTRIBUTE = '.pdf,.jpg,.jpeg,.png';

export type TaxDocumentValidation =
    | { ok: true; contentType: TaxDocumentMimeType }
    | { ok: false; error: string };

/**
 * Server-authoritative validation. The browser's `accept` attribute and any
 * client-side size check are conveniences; this runs on the server and is the
 * only thing that decides.
 */
export function validateTaxDocument(input: {
    contentType: unknown;
    sizeBytes: unknown;
}): TaxDocumentValidation {
    const type = typeof input.contentType === 'string' ? input.contentType.toLowerCase().trim() : '';

    if (!(TAX_DOCUMENT_ALLOWED_TYPES as readonly string[]).includes(type)) {
        return {
            ok: false,
            error: 'Unsupported file type. Upload the exemption certificate as a PDF, JPG or PNG.',
        };
    }

    const size = Number(input.sizeBytes);
    if (!Number.isFinite(size) || size <= 0) {
        return { ok: false, error: 'That file appears to be empty.' };
    }
    if (size > TAX_DOCUMENT_MAX_BYTES) {
        return {
            ok: false,
            error: `That file is too large. The limit is ${Math.floor(TAX_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB.`,
        };
    }

    return { ok: true, contentType: type as TaxDocumentMimeType };
}

/**
 * A filename safe to echo back in a Content-Disposition header.
 *
 * A raw user-supplied filename in a response header is a header-injection and
 * path-traversal vector, and this value came straight from an upload form.
 */
export function safeDocumentFilename(name: unknown, fallback = 'tax-exemption-document'): string {
    const raw = typeof name === 'string' ? name : '';
    const cleaned = Array.from(raw)
        // Drop control characters (incl. the CR/LF that would split a header).
        .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
        .join('')
        // Quotes, backslash and both path separators.
        .replace(/["'\\/]/g, '')
        // Any remaining traversal attempt.
        .replace(/\.\./g, '')
        .trim();
    return cleaned.length > 0 ? cleaned.slice(0, 180) : fallback;
}
