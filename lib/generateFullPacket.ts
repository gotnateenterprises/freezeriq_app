/**
 * generateFullPacket — Server-side utility
 *
 * Assembles a ZIP archive containing the campaign's core materials:
 *   1. Flyer PDF        — via existing generateFlyer()
 *   2. Printable Tracker — via existing generateTracker()
 *   3. Quick-Start Guide — plain-text, server-generated
 *
 * Returns a Buffer containing the ZIP file bytes.
 * All generation is in-memory — no temp files written to disk.
 *
 * ACCESS: Called server-side from /api/packet/download
 * AUTH:   Token-based (portal_token) — no session required
 * SCOPE:  Single campaign resolved from token
 */

import archiver from 'archiver';
import { PassThrough } from 'stream';
import { generateFlyer, type FlyerInput, type FlyerBundle } from '@/lib/generateFlyer';
import { generateTracker, type TrackerInput } from '@/lib/generateTracker';
import { generateQrCode } from '@/lib/generateQrCode';

// ── Types ────────────────────────────────────────────────────────────

export interface PacketInput {
    campaignName: string;
    organizationName: string;
    businessName: string;
    endDate: string;
    deliveryDate: string;
    pickupLocation: string;
    checksPayable: string;
    publicUrl: string;
    coordinatorName?: string;
    bundles: FlyerBundle[];
    branding?: {
        primary_color?: string;
        secondary_color?: string;
        accent_color?: string;
    };
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatDate(iso: string): string {
    if (!iso) return 'TBD';
    try {
        return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return 'TBD';
    }
}

function generateQuickStartGuide(input: PacketInput): string {
    const deadline = formatDate(input.endDate);
    const delivery = formatDate(input.deliveryDate);

    return [
        `========================================`,
        `  COORDINATOR QUICK-START GUIDE`,
        `========================================`,
        ``,
        `Campaign:     ${input.campaignName}`,
        `Organization: ${input.organizationName}`,
        `Partner:      ${input.businessName}`,
        ``,
        `Order Deadline: ${deadline}`,
        `Delivery Date:  ${delivery}`,
        input.pickupLocation ? `Pickup Location: ${input.pickupLocation}` : null,
        ``,
        `PUBLIC ORDER LINK:`,
        `${input.publicUrl}`,
        ``,
        `----------------------------------------`,
        `  5 STEPS TO FUNDRAISER SUCCESS`,
        `----------------------------------------`,
        ``,
        `1. SHARE YOUR LINK`,
        `   Send the order link above to parents,`,
        `   friends, and community members.`,
        ``,
        `2. POST ON FACEBOOK`,
        `   Share the link with a personal message`,
        `   explaining why this fundraiser matters.`,
        ``,
        `3. TEXT 5 FRIENDS`,
        `   A quick personal text goes a long way.`,
        `   "Hey! We're raising funds with delicious`,
        `    freezer meals — check it out!"`,
        ``,
        `4. PRINT THE FLYER & TRACKER`,
        `   Use the included flyer for bulletin boards`,
        `   and the tracker to collect paper orders.`,
        ``,
        `5. CHECK PROGRESS DAILY`,
        `   Visit your coordinator portal to see`,
        `   incoming orders and total raised.`,
        ``,
        `----------------------------------------`,
        `  WHAT'S IN THIS PACKET`,
        `----------------------------------------`,
        ``,
        `• flyer.pdf            — Hand out or post`,
        `• printable-tracker.xlsx — Collect paper orders`,
        `• qr-code.png          — Print or share the QR code`,
        `• quick-start-guide.txt — You're reading it!`,
        ``,
        `Good luck with your fundraiser!`,
        `— The FreezerIQ Team`,
        ``,
    ].filter(line => line !== null).join('\n');
}

// ── Main Function ────────────────────────────────────────────────────

export async function generateFullPacket(input: PacketInput): Promise<Buffer> {
    // 1. Generate flyer PDF (reuses existing generator — sync)
    const flyerInput: FlyerInput = {
        campaignName: input.campaignName,
        organizationName: input.organizationName,
        businessName: input.businessName,
        endDate: input.endDate,
        deliveryDate: input.deliveryDate,
        pickupLocation: input.pickupLocation,
        checksPayable: input.checksPayable,
        publicUrl: input.publicUrl,
        bundles: input.bundles,
        branding: input.branding,
    };
    const flyerBuffer = await generateFlyer(flyerInput);

    // 2. Generate tracker XLSX (reuses existing generator — async)
    const trackerInput: TrackerInput = {
        campaignName: input.campaignName,
        organizationName: input.organizationName,
        endDate: input.endDate,
        publicUrl: input.publicUrl,
        coordinatorName: input.coordinatorName || input.campaignName,
        bundles: input.bundles.map(b => ({
            name: b.name,
            price: b.price,
        })),
    };
    const trackerArrayBuffer = await generateTracker(trackerInput);
    const trackerBuffer = Buffer.from(trackerArrayBuffer);

    // 3. Generate QR code PNG (reuses existing utility — async)
    const qr = await generateQrCode(input.publicUrl);
    const qrBuffer = qr.pngBuffer;

    // 4. Generate quick-start guide (plain text — sync)
    const guideText = generateQuickStartGuide(input);
    const guideBuffer = Buffer.from(guideText, 'utf-8');

    // 5. Assemble ZIP in memory using archiver
    return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const passthrough = new PassThrough();

        passthrough.on('data', (chunk: Buffer) => chunks.push(chunk));
        passthrough.on('end', () => resolve(Buffer.concat(chunks)));
        passthrough.on('error', reject);

        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', reject);
        archive.pipe(passthrough);

        archive.append(flyerBuffer, { name: 'flyer.pdf' });
        archive.append(trackerBuffer, { name: 'printable-tracker.xlsx' });
        archive.append(qrBuffer, { name: 'qr-code.png' });
        archive.append(guideBuffer, { name: 'quick-start-guide.txt' });

        archive.finalize();
    });
}
