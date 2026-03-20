/**
 * generateFlyer — Server-side utility
 *
 * Builds a 2-page PDF fundraiser flyer using jsPDF.
 * Mirrors the visual structure of MarketingFlyer.tsx but runs
 * entirely server-side (no DOM, no html2canvas, no Google Fonts).
 *
 * ACCESS: Called server-side from /api/flyer/download
 * AUTH:   Token-based (portal_token) — no session required
 * SCOPE:  Single campaign resolved from token
 */

import { jsPDF } from 'jspdf';
import { generateQrCode } from '@/lib/generateQrCode';

// ── Types ────────────────────────────────────────────────────────────

export interface FlyerBundle {
    name: string;
    price: number;
    servingTier: string;
    meals: string[]; // recipe names
}

export interface FlyerInput {
    campaignName: string;
    organizationName: string;
    businessName: string;
    endDate: string;       // ISO or empty
    deliveryDate: string;  // ISO or empty
    pickupLocation: string;
    checksPayable: string;
    publicUrl: string;
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

/** Convert hex #RRGGBB to [r, g, b] */
function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [
        parseInt(h.substring(0, 2), 16),
        parseInt(h.substring(2, 4), 16),
        parseInt(h.substring(4, 6), 16),
    ];
}

/** Draw a filled rounded rectangle */
function roundedRect(
    doc: jsPDF,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    style: 'S' | 'F' | 'FD' = 'F'
) {
    doc.roundedRect(x, y, w, h, r, r, style);
}

// ── Constants ────────────────────────────────────────────────────────

const PAGE_W = 215.9; // Letter width in mm
const PAGE_H = 279.4; // Letter height in mm
const MARGIN = 18;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ── Main Function ────────────────────────────────────────────────────

export async function generateFlyer(input: FlyerInput): Promise<Buffer> {
    const primary = input.branding?.primary_color || '#10b981';
    const secondary = input.branding?.secondary_color || '#6366f1';
    const accent = input.branding?.accent_color || '#f59e0b';
    const textDark: [number, number, number] = [15, 23, 42];   // slate-900
    const textLight: [number, number, number] = [100, 116, 139]; // slate-500

    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    let y = MARGIN;

    // ═══════════════════════════════════════════════════════════════
    // PAGE 1: Marketing & Bundles
    // ═══════════════════════════════════════════════════════════════

    // ── Header ──
    doc.setFontSize(22);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...hexToRgb(primary));
    doc.text('RAISING FUNDS. FEEDING FAMILIES.', MARGIN, y + 7);
    y += 12;

    doc.setFontSize(13);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textLight);
    doc.text(`Support `, MARGIN, y + 5, { baseline: 'top' });
    const supportW = doc.getTextWidth('Support ');
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text(input.organizationName, MARGIN + supportW, y + 5, { baseline: 'top' });
    const orgW = doc.getTextWidth(input.organizationName);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textLight);
    doc.text(' with Delicious Meals!', MARGIN + supportW + orgW, y + 5, { baseline: 'top' });
    y += 14;

    // ── Primary color bar ──
    doc.setFillColor(...hexToRgb(primary));
    doc.rect(MARGIN, y, CONTENT_W, 1.5, 'F');
    y += 6;

    // ── Intro text ──
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 41, 59); // slate-800
    const intro1 = `We're partnering with ${input.businessName} to bring you delicious, homemade-style meals that bring comfort to your table while supporting our cause!`;
    const intro1Lines = doc.splitTextToSize(intro1, CONTENT_W);
    doc.text(intro1Lines, MARGIN, y);
    y += intro1Lines.length * 4.5 + 2;

    const intro2 = `By purchasing a meal bundle, you aren't just solving the "What's for dinner?" dilemma — you are directly supporting ${input.organizationName}. We earn 20% of every sale!`;
    const intro2Lines = doc.splitTextToSize(intro2, CONTENT_W);
    doc.text(intro2Lines, MARGIN, y);
    y += intro2Lines.length * 4.5 + 4;

    // ── Why You'll Love It ──
    doc.setFillColor(241, 245, 249); // slate-100
    roundedRect(doc, MARGIN, y, CONTENT_W, 28, 4, 'F');

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...hexToRgb(secondary));
    doc.text('WHY YOU\'LL LOVE IT', PAGE_W / 2, y + 6, { align: 'center' });

    const reasons = [
        ['Healthy & Fresh', 'Locally prepared fresh ingredients.'],
        ['Affordable', 'Better value than eating out.'],
        ['Comfort & Convenience', 'Oven & Slow-cooker ready.'],
        ['Support Local', 'Help our community goals.'],
    ];
    doc.setFontSize(8.5);
    const colW = CONTENT_W / 2 - 4;
    reasons.forEach(([label, detail], i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const rx = MARGIN + 6 + col * (colW + 8);
        const ry = y + 11 + row * 7;
        doc.setTextColor(...hexToRgb(primary));
        doc.text('✓', rx, ry);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text(`${label}:`, rx + 5, ry);
        const labelW = doc.getTextWidth(`${label}: `);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textLight);
        doc.text(detail, rx + 5 + labelW, ry);
    });
    y += 32;

    // ── "Easy as 1..2..3" ──
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text("It's as Easy as 1..2..3..!!", PAGE_W / 2, y + 5, { align: 'center' });
    y += 12;

    // ── Step 1: Choose Your Serving Size ──
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...hexToRgb(secondary));
    doc.text('1. CHOOSE YOUR SERVING SIZE...', PAGE_W / 2, y, { align: 'center' });
    y += 6;

    const cardW = (CONTENT_W - 12) / 2;
    const cardH = 28;

    // Draw bundle pricing cards (up to 2)
    input.bundles.slice(0, 2).forEach((bundle, i) => {
        const cx = MARGIN + i * (cardW + 12);
        doc.setDrawColor(...hexToRgb(secondary));
        doc.setLineWidth(0.7);
        roundedRect(doc, cx, y, cardW, cardH, 4, 'S');

        // Bundle label
        const servingLabel = bundle.servingTier === 'couple'
            ? 'Serves 2 Bundle'
            : 'Family Size Bundle';
        const servingDetail = bundle.servingTier === 'couple'
            ? 'Serves 2 People'
            : 'Serves 5-6 People';

        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text(servingLabel.toUpperCase(), cx + cardW / 2, y + 7, { align: 'center' });

        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textLight);
        doc.text(servingDetail, cx + cardW / 2, y + 12, { align: 'center' });

        doc.setFontSize(22);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(secondary));
        doc.text(`$${bundle.price.toFixed(2)}`, cx + cardW / 2, y + 23, { align: 'center' });
    });

    // "OR" separator between cards
    if (input.bundles.length >= 2) {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(203, 213, 225); // slate-300
        doc.text('OR', MARGIN + cardW + 6, y + cardH / 2 + 2, { align: 'center' });
    }

    y += cardH + 8;

    // ── Step 2: Choose Your Bundle(s) ──
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...hexToRgb(primary));
    doc.text('2. CHOOSE YOUR BUNDLE(S)...', PAGE_W / 2, y, { align: 'center' });
    y += 6;

    // Meal listings side-by-side
    const mealColW = (CONTENT_W - 6) / 2;
    const mealStartY = y;

    input.bundles.slice(0, 2).forEach((bundle, i) => {
        const mx = MARGIN + i * (mealColW + 6);
        let my = mealStartY;

        // Bundle header
        const headerLabel = bundle.name || `Bundle ${i + 1}`;
        doc.setFontSize(9);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        doc.text(headerLabel.toUpperCase(), mx, my);
        my += 2;
        doc.setDrawColor(...hexToRgb(primary));
        doc.setLineWidth(0.6);
        doc.line(mx, my, mx + mealColW, my);
        my += 4;

        // Recipe list
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(30, 41, 59);
        bundle.meals.forEach((meal) => {
            const lines = doc.splitTextToSize(`• ${meal}`, mealColW - 4);
            doc.text(lines, mx + 2, my);
            my += lines.length * 3.8;
        });
        if (bundle.meals.length === 0) {
            doc.setTextColor(...textLight);
            doc.text('No meals selected', mx + 2, my);
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PAGE 2: Logistics & Order Form
    // ═══════════════════════════════════════════════════════════════

    doc.addPage('letter');
    y = MARGIN;

    // ── Step 3 Header ──
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...hexToRgb(accent));
    doc.text('3. PAY AND PICK-UP ON DELIVERY DAY!', PAGE_W / 2, y + 5, { align: 'center' });
    y += 10;
    doc.setFillColor(...hexToRgb(primary));
    doc.rect(MARGIN, y, CONTENT_W, 1, 'F');
    y += 8;

    // ── Logistics Box ──
    doc.setFillColor(255, 251, 235); // amber-50
    doc.setDrawColor(...hexToRgb(accent));
    doc.setLineWidth(0.7);
    roundedRect(doc, MARGIN, y, CONTENT_W, 46, 5, 'FD');

    const logY = y + 8;
    const labelX = MARGIN + 10;
    const valueX = MARGIN + 60;
    const logItems = [
        ['🗓️  Order Deadline:', formatDate(input.endDate)],
        ['🚛  Delivery Date:', formatDate(input.deliveryDate)],
        ['📍  Pickup Location:', input.pickupLocation || 'TBD'],
        ['💳  Checks Payable To:', input.checksPayable || input.organizationName],
    ];

    doc.setFontSize(11);
    logItems.forEach(([label, value], i) => {
        const ly = logY + i * 9;
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(30, 41, 59);
        doc.text(label, labelX, ly);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(180, 83, 9); // amber-700
        doc.text(value, valueX, ly);
    });

    y += 54;

    // ── QR Code Section ──
    // Generate QR code for the public fundraiser URL
    try {
        const qr = await generateQrCode(input.publicUrl);
        const qrSize = 30; // mm — large enough to scan when printed
        const qrX = MARGIN + CONTENT_W - qrSize - 2; // right-aligned
        const qrLabelX = MARGIN;

        // "Scan to Order Online" label
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        doc.text('ORDER ONLINE', qrLabelX, y + 8);

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textDark);
        doc.text('Scan this QR code or visit:', qrLabelX, y + 14);

        // URL text (truncated if needed)
        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(secondary));
        const maxUrlW = CONTENT_W - qrSize - 12;
        const urlLines = doc.splitTextToSize(input.publicUrl, maxUrlW);
        doc.text(urlLines, qrLabelX, y + 20);

        // QR code image
        doc.addImage(qr.dataUrl, 'PNG', qrX, y, qrSize, qrSize);

        // "Scan to order" caption under QR
        doc.setFontSize(7);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        doc.text('SCAN TO ORDER', qrX + qrSize / 2, y + qrSize + 4, { align: 'center' });

        y += qrSize + 10;
    } catch (qrErr) {
        // QR generation failure is non-fatal — flyer still works without it
        console.warn('QR code generation failed, skipping QR section:', qrErr);
    }

    // ── Cut Line ──
    doc.setLineDashPattern([3, 2], 0);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.5);
    doc.line(MARGIN, y, MARGIN + CONTENT_W, y);
    doc.setLineDashPattern([], 0);

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(148, 163, 184); // slate-400
    doc.text('✂️  CUT & RETURN WITH PAYMENT  ✂️', PAGE_W / 2, y + 4, { align: 'center' });
    y += 14;

    // ── Order Form ──
    doc.setFillColor(248, 250, 252); // slate-50
    roundedRect(doc, MARGIN, y, CONTENT_W, 100, 5, 'F');

    // Due date
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38); // red-600
    const dueText = `ORDERS DUE BY: ${formatDate(input.endDate)}`;
    doc.text(dueText, PAGE_W / 2, y + 8, { align: 'center' });

    // Form fields
    const formX = MARGIN + 8;
    let fy = y + 18;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);

    // Name
    doc.text('NAME:', formX, fy);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.line(formX + 16, fy + 1, MARGIN + CONTENT_W - 8, fy + 1);
    fy += 12;

    // Phone + Email
    doc.text('PHONE:', formX, fy);
    doc.line(formX + 18, fy + 1, formX + 65, fy + 1);
    doc.text('EMAIL:', formX + 75, fy);
    doc.line(formX + 93, fy + 1, MARGIN + CONTENT_W - 8, fy + 1);
    fy += 14;

    // Bundle order boxes
    const boxW = (CONTENT_W - 24) / 2;
    input.bundles.slice(0, 2).forEach((bundle, i) => {
        const bx = formX + i * (boxW + 8);

        doc.setDrawColor(...hexToRgb(secondary));
        doc.setLineWidth(0.5);
        roundedRect(doc, bx, fy, boxW, 28, 3, 'S');

        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(secondary));
        doc.text(`${bundle.name.toUpperCase()} ($${bundle.price.toFixed(2)})`, bx + 4, fy + 7);

        doc.setDrawColor(248, 250, 252);
        doc.line(bx + 4, fy + 10, bx + boxW - 4, fy + 10);

        doc.setFontSize(9);
        doc.setTextColor(...textDark);
        doc.text('Qty: ________', bx + 4, fy + 18);
        doc.text('Total $: ________', bx + boxW / 2 + 4, fy + 18);
    });

    // ── Footer ──
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text('Generated by FreezerIQ Fundraising System', PAGE_W / 2, PAGE_H - 10, { align: 'center' });

    // ── Return buffer ──
    const arrayBuffer = doc.output('arraybuffer');
    return Buffer.from(arrayBuffer);
}
