/**
 * generateQrCode — Server-side QR code utility
 *
 * Generates a QR code for a given URL and returns both a base64
 * data URL (for embedding in PDFs) and a raw PNG Buffer (for
 * file downloads and ZIP inclusion).
 *
 * Uses the `qrcode` npm package which works server-side (no DOM).
 *
 * ACCESS: Called server-side only
 */

import QRCode from 'qrcode';

export interface QrCodeResult {
    /** Base64 data URL suitable for jsPDF addImage() */
    dataUrl: string;
    /** Raw PNG bytes for file downloads or ZIP inclusion */
    pngBuffer: Buffer;
}

/**
 * Generate a QR code image for a public fundraiser URL.
 *
 * @param url - The full public fundraiser URL to encode
 * @returns QR code as both data URL and PNG buffer
 */
export async function generateQrCode(url: string): Promise<QrCodeResult> {
    if (!url || typeof url !== 'string') {
        throw new Error('generateQrCode requires a non-empty URL string');
    }

    // Generate base64 data URL (PNG format, high error correction)
    const dataUrl = await QRCode.toDataURL(url, {
        type: 'image/png',
        width: 400,             // px — large enough for print
        margin: 2,              // quiet zone modules
        errorCorrectionLevel: 'H', // highest — survives 30% damage
        color: {
            dark: '#0f172a',    // slate-900 — matches flyer text
            light: '#ffffff',   // white background
        },
    });

    // Generate raw PNG buffer for file download / ZIP inclusion
    const pngBuffer = await QRCode.toBuffer(url, {
        type: 'png',
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'H',
        color: {
            dark: '#0f172a',
            light: '#ffffff',
        },
    });

    return { dataUrl, pngBuffer };
}
