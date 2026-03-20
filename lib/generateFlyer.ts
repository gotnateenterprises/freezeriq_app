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

    // Determine serving tier labels + prices for the details box
    const familyBundle = input.bundles.find(b => b.servingTier === 'family');
    const coupleBundle = input.bundles.find(b => b.servingTier === 'couple');

    // ═══════════════════════════════════════════════════════════════
    // PAGE 1: Fundraiser Details + Bundle Meals
    // ═══════════════════════════════════════════════════════════════

    // ── HEADLINE ──
    doc.setFontSize(24);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    const headline = `Support ${input.organizationName}`;
    const headlineLines = doc.splitTextToSize(headline, CONTENT_W);
    doc.text(headlineLines, PAGE_W / 2, y + 7, { align: 'center' });
    y += headlineLines.length * 9 + 2;

    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textLight);
    doc.text('Stock your freezer with ready-to-cook meals!', PAGE_W / 2, y + 3, { align: 'center' });
    y += 10;

    // ── Primary color bar ──
    doc.setFillColor(...hexToRgb(primary));
    doc.rect(MARGIN, y, CONTENT_W, 1.5, 'F');
    y += 6;

    // ── FUNDRAISER DETAILS BOX ──
    const detailsBoxH = 40;
    doc.setFillColor(241, 245, 249); // slate-100
    doc.setDrawColor(...hexToRgb(primary));
    doc.setLineWidth(0.6);
    roundedRect(doc, MARGIN, y, CONTENT_W, detailsBoxH, 4, 'FD');

    const detailsY = y + 7;
    const leftCol = MARGIN + 6;
    const rightCol = MARGIN + CONTENT_W / 2 + 6;
    doc.setFontSize(9);

    // Left column: Dates & location
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text('Order Deadline:', leftCol, detailsY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 83, 9); // amber-700
    doc.text(formatDate(input.endDate), leftCol + 35, detailsY);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text('Delivery Date:', leftCol, detailsY + 8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 83, 9);
    doc.text(formatDate(input.deliveryDate), leftCol + 35, detailsY + 8);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text('Pickup Location:', leftCol, detailsY + 16);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 83, 9);
    const locLines = doc.splitTextToSize(input.pickupLocation || 'TBD', CONTENT_W / 2 - 50);
    doc.text(locLines, leftCol + 35, detailsY + 16);

    // Right column: Pricing
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...hexToRgb(secondary));
    doc.text('PRICING', rightCol, detailsY);

    let priceY = detailsY + 8;
    if (familyBundle) {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text(`Family Size:`, rightCol, priceY);
        doc.setTextColor(...hexToRgb(primary));
        doc.text(`$${familyBundle.price.toFixed(2)}`, rightCol + 28, priceY);
        priceY += 8;
    }
    if (coupleBundle) {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text(`Serves 2:`, rightCol, priceY);
        doc.setTextColor(...hexToRgb(primary));
        doc.text(`$${coupleBundle.price.toFixed(2)}`, rightCol + 28, priceY);
        priceY += 8;
    }
    // If bundles don't match standard tiers, show them generically
    if (!familyBundle && !coupleBundle) {
        input.bundles.slice(0, 2).forEach((b, i) => {
            doc.setFontSize(10);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(...textDark);
            doc.text(`${b.name}:`, rightCol, priceY + i * 8);
            doc.setTextColor(...hexToRgb(primary));
            doc.text(`$${b.price.toFixed(2)}`, rightCol + 28, priceY + i * 8);
        });
    }

    y += detailsBoxH + 6;

    // ── HOW IT WORKS (3-step row) ──
    doc.setFillColor(...hexToRgb(primary));
    roundedRect(doc, MARGIN, y, CONTENT_W, 16, 3, 'F');

    const stepW = CONTENT_W / 3;
    const steps = [
        '1. Order Online or Through Coordinator',
        '2. We Prep Your Meals',
        '3. You Pick Up & Enjoy',
    ];
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    steps.forEach((step, i) => {
        doc.text(step, MARGIN + stepW * i + stepW / 2, y + 10, { align: 'center' });
    });
    y += 22;

    // ── BUNDLE MEAL SECTIONS (side-by-side) ──
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text("What's Included", PAGE_W / 2, y + 4, { align: 'center' });
    y += 10;

    const displayBundles = input.bundles.slice(0, 2);
    const bundleColW = displayBundles.length === 1
        ? CONTENT_W
        : (CONTENT_W - 8) / 2;

    displayBundles.forEach((bundle, i) => {
        const bx = displayBundles.length === 1
            ? MARGIN
            : MARGIN + i * (bundleColW + 8);
        let by = y;

        // Bundle card background
        doc.setFillColor(248, 250, 252); // slate-50
        doc.setDrawColor(...hexToRgb(secondary));
        doc.setLineWidth(0.6);

        // Calculate card height based on meals – each meal line ~4mm, header ~14mm, padding ~6mm
        const mealLineH = 4;
        const headerH = 16;
        const paddingH = 6;
        const cardHeight = headerH + bundle.meals.length * mealLineH + paddingH;
        roundedRect(doc, bx, by, bundleColW, Math.max(cardHeight, 40), 4, 'FD');

        // Bundle name + serving tier + price header
        const servingLabel = bundle.servingTier === 'couple'
            ? 'Serves 2'
            : bundle.servingTier === 'family'
                ? 'Family Size'
                : bundle.servingTier;

        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(secondary));
        doc.text(bundle.name.toUpperCase(), bx + bundleColW / 2, by + 6, { align: 'center' });

        doc.setFontSize(8);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textLight);
        doc.text(`${servingLabel}  •  $${bundle.price.toFixed(2)}`, bx + bundleColW / 2, by + 11, { align: 'center' });

        // Divider line
        doc.setDrawColor(...hexToRgb(primary));
        doc.setLineWidth(0.4);
        doc.line(bx + 6, by + 14, bx + bundleColW - 6, by + 14);

        // Meal list — show ALL meals
        let my = by + 18;
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(30, 41, 59);
        if (bundle.meals.length > 0) {
            bundle.meals.forEach((meal) => {
                const mealText = `✔  ${meal}`;
                const lines = doc.splitTextToSize(mealText, bundleColW - 12);
                doc.text(lines, bx + 6, my);
                my += lines.length * mealLineH;
            });
        } else {
            doc.setTextColor(...textLight);
            doc.text('Meals to be announced', bx + 6, my);
        }
    });

    // Advance past the tallest bundle card
    const maxMealCount = Math.max(...displayBundles.map(b => b.meals.length), 0);
    const tallestCard = 16 + maxMealCount * 4 + 6;
    y += Math.max(tallestCard, 40) + 6;

    // ── QR CODE + CTA ──
    try {
        const qr = await generateQrCode(input.publicUrl);
        const qrSize = 28;

        // CTA box
        doc.setFillColor(241, 245, 249);
        roundedRect(doc, MARGIN, y, CONTENT_W, qrSize + 10, 4, 'F');

        const qrX = MARGIN + CONTENT_W - qrSize - 8;
        const ctaX = MARGIN + 8;

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        doc.text('Order Here', ctaX, y + 10);

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textDark);
        doc.text('Scan with your phone or visit the link:', ctaX, y + 17);

        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(secondary));
        const maxUrlW = CONTENT_W - qrSize - 24;
        const urlLines = doc.splitTextToSize(input.publicUrl, maxUrlW);
        doc.text(urlLines, ctaX, y + 23);

        // QR code image
        doc.addImage(qr.dataUrl, 'PNG', qrX, y + 4, qrSize, qrSize);

        doc.setFontSize(7);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        doc.text('SCAN TO ORDER', qrX + qrSize / 2, y + qrSize + 7, { align: 'center' });

        y += qrSize + 14;
    } catch (qrErr) {
        console.warn('QR code generation failed, skipping QR section:', qrErr);
    }

    // ═══════════════════════════════════════════════════════════════
    // PAGE 2: Tear-off Order Form
    // ═══════════════════════════════════════════════════════════════

    doc.addPage('letter');
    y = MARGIN;

    // ── Header ──
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text(`${input.organizationName} — Fundraiser Order Form`, PAGE_W / 2, y + 6, { align: 'center' });
    y += 12;
    doc.setFillColor(...hexToRgb(primary));
    doc.rect(MARGIN, y, CONTENT_W, 1, 'F');
    y += 8;

    // ── Due Date ──
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38); // red-600
    doc.text(`ORDERS DUE BY: ${formatDate(input.endDate)}`, PAGE_W / 2, y + 2, { align: 'center' });
    y += 10;

    // ── Customer Info Fields ──
    const formX = MARGIN + 6;
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);

    doc.text('Customer Name:', formX, y);
    doc.line(formX + 36, y + 1, MARGIN + CONTENT_W - 6, y + 1);
    y += 10;

    doc.text('Phone:', formX, y);
    doc.line(formX + 16, y + 1, formX + 70, y + 1);
    doc.text('Email:', formX + 80, y);
    doc.line(formX + 96, y + 1, MARGIN + CONTENT_W - 6, y + 1);
    y += 14;

    // ── Bundle Order Table ──
    // Table header
    doc.setFillColor(...hexToRgb(secondary));
    roundedRect(doc, MARGIN, y, CONTENT_W, 10, 3, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('Bundle', MARGIN + 6, y + 7);
    doc.text('Serving Size', MARGIN + 60, y + 7);
    doc.text('Price', MARGIN + 110, y + 7);
    doc.text('Qty', MARGIN + 135, y + 7);
    doc.text('Total', MARGIN + 155, y + 7);
    y += 12;

    // Table rows — one row per bundle
    doc.setFontSize(9);
    displayBundles.forEach((bundle, i) => {
        const rowY = y + i * 14;
        const servLabel = bundle.servingTier === 'couple'
            ? 'Serves 2'
            : bundle.servingTier === 'family'
                ? 'Family Size (5-6)'
                : bundle.servingTier;

        // Alternating row bg
        if (i % 2 === 0) {
            doc.setFillColor(248, 250, 252);
            doc.rect(MARGIN, rowY - 3, CONTENT_W, 12, 'F');
        }

        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text(bundle.name, MARGIN + 6, rowY + 4);

        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textLight);
        doc.text(servLabel, MARGIN + 60, rowY + 4);

        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        doc.text(`$${bundle.price.toFixed(2)}`, MARGIN + 110, rowY + 4);

        // Qty and Total blanks
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.3);
        doc.line(MARGIN + 132, rowY + 5, MARGIN + 148, rowY + 5);
        doc.line(MARGIN + 152, rowY + 5, MARGIN + CONTENT_W - 6, rowY + 5);
    });

    y += displayBundles.length * 14 + 6;

    // Grand total line
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text('GRAND TOTAL:  $ _______________', MARGIN + CONTENT_W - 6, y + 4, { align: 'right' });
    y += 14;

    // ── Payment Notes ──
    doc.setFillColor(255, 251, 235); // amber-50
    doc.setDrawColor(...hexToRgb(accent));
    doc.setLineWidth(0.5);
    roundedRect(doc, MARGIN, y, CONTENT_W, 22, 4, 'FD');

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(180, 83, 9);
    doc.text(`Make checks payable to: ${input.checksPayable || input.organizationName}`, PAGE_W / 2, y + 9, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textLight);
    doc.text('Return this form with payment to your coordinator.', PAGE_W / 2, y + 16, { align: 'center' });
    y += 28;

    // ── Logistics reminder ──
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textDark);
    const logReminders = [
        `Delivery Date: ${formatDate(input.deliveryDate)}`,
        `Pickup Location: ${input.pickupLocation || 'TBD'}`,
    ];
    logReminders.forEach((line, i) => {
        doc.text(line, MARGIN + 6, y + i * 6);
    });
    y += logReminders.length * 6 + 6;

    // ── QR on page 2 as well (small) ──
    try {
        const qr = await generateQrCode(input.publicUrl);
        const qrSize = 22;
        const qrX = MARGIN + CONTENT_W - qrSize - 4;

        doc.setFontSize(8);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        doc.text('Or order online:', qrX - 2, y + 4, { align: 'right' });
        doc.addImage(qr.dataUrl, 'PNG', qrX, y - 2, qrSize, qrSize);

        doc.setFontSize(7);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...hexToRgb(secondary));
        const smallUrlLines = doc.splitTextToSize(input.publicUrl, qrSize + 10);
        doc.text(smallUrlLines, qrX, y + qrSize + 2);
    } catch {
        // Non-fatal
    }

    // ── Footer ──
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text('Generated by FreezerIQ Fundraising System', PAGE_W / 2, PAGE_H - 10, { align: 'center' });

    // ── Return buffer ──
    const arrayBuffer = doc.output('arraybuffer');
    return Buffer.from(arrayBuffer);
}
