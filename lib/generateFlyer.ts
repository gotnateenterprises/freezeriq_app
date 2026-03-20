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

    // ── Deduplicate bundles into "menus" ──
    // Each menu may have a family and couple variant in the bundles table.
    // Group by base name (strip " (Serves 2)" suffix) so each menu shows once.
    interface Menu {
        baseName: string;
        familyPrice: number | null;
        couplePrice: number | null;
        meals: string[];  // from whichever variant has meals (prefer family)
    }

    const menuMap = new Map<string, Menu>();
    for (const b of input.bundles) {
        // Normalise name: strip trailing "(Serves 2)" or "(serves 2)" etc.
        const baseName = b.name
            .replace(/\s*\(serves\s*2\)$/i, '')
            .trim();
        let menu = menuMap.get(baseName);
        if (!menu) {
            menu = { baseName, familyPrice: null, couplePrice: null, meals: [] };
            menuMap.set(baseName, menu);
        }
        if (b.servingTier === 'couple') {
            menu.couplePrice = b.price;
            // Use couple meals only if we don't have any yet
            if (menu.meals.length === 0) menu.meals = b.meals;
        } else {
            // family (default)
            menu.familyPrice = b.price;
            menu.meals = b.meals;  // prefer family meals
        }
    }
    const menus = Array.from(menuMap.values()).slice(0, 2);

    // Global pricing — pick from first menu that has each tier
    const globalFamilyPrice = menus.find(m => m.familyPrice !== null)?.familyPrice ?? 0;
    const globalCouplePrice = menus.find(m => m.couplePrice !== null)?.couplePrice ?? 0;

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
    doc.text(`Stock your freezer with ready-to-cook meals from ${input.businessName}!`, PAGE_W / 2, y + 3, { align: 'center' });
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

    // Right column: Pricing (each bundle available in both sizes)
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...hexToRgb(secondary));
    doc.text('PRICING (per bundle)', rightCol, detailsY);

    let priceY = detailsY + 9;
    if (globalFamilyPrice > 0) {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text('Family Size:', rightCol, priceY);
        doc.setTextColor(...hexToRgb(primary));
        doc.text(`$${globalFamilyPrice.toFixed(2)}`, rightCol + 28, priceY);
        priceY += 9;
    }
    if (globalCouplePrice > 0) {
        doc.setFontSize(10);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text('Serves 2:', rightCol, priceY);
        doc.setTextColor(...hexToRgb(primary));
        doc.text(`$${globalCouplePrice.toFixed(2)}`, rightCol + 28, priceY);
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

    // ── BUNDLE MEAL CARDS (Family Size meals only) ──
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textDark);
    doc.text("What's Included", PAGE_W / 2, y + 4, { align: 'center' });

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textLight);
    doc.text('(Family Size shown  -  also available in Serves 2)', PAGE_W / 2, y + 9, { align: 'center' });
    y += 14;

    const bundleColW = menus.length === 1
        ? CONTENT_W
        : (CONTENT_W - 8) / 2;

    // Pre-calculate card heights so both cards can be the same height
    const mealLineH = 4.5;
    const headerH = 14;
    const paddingH = 6;
    const cardHeights = menus.map(menu => {
        let totalLines = 0;
        menu.meals.forEach(meal => {
            const lines = doc.splitTextToSize(`-  ${meal}`, bundleColW - 14);
            totalLines += lines.length;
        });
        return headerH + totalLines * mealLineH + paddingH;
    });
    const uniformCardH = Math.max(...cardHeights, 40);

    menus.forEach((menu, i) => {
        const bx = menus.length === 1
            ? MARGIN
            : MARGIN + i * (bundleColW + 8);
        const by = y;

        // Card background
        doc.setFillColor(248, 250, 252); // slate-50
        doc.setDrawColor(...hexToRgb(secondary));
        doc.setLineWidth(0.6);
        roundedRect(doc, bx, by, bundleColW, uniformCardH, 4, 'FD');

        // Card title: "BUNDLE 1" / "BUNDLE 2" (or base name if only 1)
        const cardTitle = menus.length === 1
            ? menu.baseName.toUpperCase()
            : `BUNDLE ${i + 1}`;
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(secondary));
        doc.text(cardTitle, bx + bundleColW / 2, by + 7, { align: 'center' });

        // Divider line
        doc.setDrawColor(...hexToRgb(primary));
        doc.setLineWidth(0.4);
        doc.line(bx + 6, by + 11, bx + bundleColW - 6, by + 11);

        // Meal list
        let my = by + 16;
        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(30, 41, 59);
        if (menu.meals.length > 0) {
            menu.meals.forEach((meal) => {
                const mealText = `-  ${meal}`;
                const lines = doc.splitTextToSize(mealText, bundleColW - 14);
                doc.text(lines, bx + 7, my);
                my += lines.length * mealLineH;
            });
        } else {
            doc.setTextColor(...textLight);
            doc.text('Meals to be announced', bx + 7, my);
        }
    });

    y += uniformCardH + 6;

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
    const formTitle = `${input.organizationName} - Fundraiser Order Form`;
    const formTitleLines = doc.splitTextToSize(formTitle, CONTENT_W);
    doc.text(formTitleLines, PAGE_W / 2, y + 6, { align: 'center' });
    y += formTitleLines.length * 7 + 4;
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

    // ── Order Table ──
    // Header row
    doc.setFillColor(...hexToRgb(secondary));
    roundedRect(doc, MARGIN, y, CONTENT_W, 10, 3, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('Bundle', MARGIN + 6, y + 7);
    doc.text('Size', MARGIN + 68, y + 7);
    doc.text('Price', MARGIN + 108, y + 7);
    doc.text('Qty', MARGIN + 135, y + 7);
    doc.text('Total', MARGIN + 155, y + 7);
    y += 12;

    // One section per menu, with sub-rows for Family Size and Serves 2
    doc.setFontSize(9);
    menus.forEach((menu, mi) => {
        const menuLabel = menus.length === 1 ? menu.baseName : `Bundle ${mi + 1}`;

        // Family Size row
        if (mi % 2 === 0) {
            doc.setFillColor(248, 250, 252);
            doc.rect(MARGIN, y - 3, CONTENT_W, 12, 'F');
        }
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textDark);
        doc.text(menuLabel, MARGIN + 6, y + 4);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textLight);
        doc.text('Family Size', MARGIN + 68, y + 4);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        const fp = menu.familyPrice ?? globalFamilyPrice ?? 0;
        doc.text(`$${fp.toFixed(2)}`, MARGIN + 108, y + 4);
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.3);
        doc.line(MARGIN + 132, y + 5, MARGIN + 148, y + 5);
        doc.line(MARGIN + 152, y + 5, MARGIN + CONTENT_W - 6, y + 5);
        y += 12;

        // Serves 2 row
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textDark);
        doc.text('', MARGIN + 6, y + 4); // blank bundle name for sub-row
        doc.setTextColor(...textLight);
        doc.text('Serves 2', MARGIN + 68, y + 4);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb(primary));
        const cp = menu.couplePrice ?? globalCouplePrice ?? 0;
        doc.text(`$${cp.toFixed(2)}`, MARGIN + 108, y + 4);
        doc.setDrawColor(203, 213, 225);
        doc.line(MARGIN + 132, y + 5, MARGIN + 148, y + 5);
        doc.line(MARGIN + 152, y + 5, MARGIN + CONTENT_W - 6, y + 5);
        y += 14;
    });

    y += 4;

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
