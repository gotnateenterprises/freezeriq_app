/**
 * Pickup Sheet Download API
 *
 * ACCESS MODEL: coordinator SESSION cookie.
 * - GET gated by requireCoordinatorSession; the campaign comes from the session
 *   row, never from a URL. (The old header here still described the retired
 *   portal_token-in-the-query model that FR-COORD-SEC-1B removed.)
 * - Returns a populated .xlsx file as a binary download
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from the coordinator session)
 *
 * PURPOSE: a spreadsheet view of the same day-of pickup data — one row per
 * order, with per-bundle quantity columns and totals, which is what makes it
 * useful for counting boxes. This is a DATA EXPORT, not a blank template
 * (unlike /api/tracker/download).
 *
 * COORD-FULFILLMENT-2: for a per-supporter sheet you can print and tick off,
 * see /coordinator/portal/pickup-tracker. Both list the same orders, from the
 * same shared rule — see the orders query below.
 *
 * COORD-CLOSEOUT-PICKUP-1 (owner ruling 2026-10-01): closeout unlocks this
 * sheet; invoice payment still unlocks production. A CLOSED campaign's sheet
 * lists every non-canceled order — the final list the organization's invoice
 * was computed from — even while the orders are still held, because the
 * coordinator reconciles it before that invoice is paid. An OPEN campaign's
 * sheet keeps listing released work only and says it is not final.
 *
 * The sheet stays ONE ROW PER ORDER. Each row now also carries the order's
 * amount due (lib/fundraiserTax supporterAmountDue: pre-tax total + the tax
 * persisted on the order, never recomputed) and the coordinator's own payment
 * mark (lib/supporterPayment). A supporter with two orders keeps two rows, so
 * neither order's payment state is merged away.
 *
 * Read-only: downloading writes nothing and releases nothing.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { isCampaignClosed } from '@/lib/campaignBundleSelection';
import {
    isPickupDocumentOrder,
    pickupDocumentOrderWhere,
    pickupDocumentState,
    PICKUP_DOCUMENT_STATUS_COPY,
} from '@/lib/coordinatorSupporterOrders';
import { supporterAmountDue } from '@/lib/fundraiserTax';
import { roundCents } from '@/lib/fundraiserCloseoutMath';
import { PAYMENT_NOT_MARKED_LABEL, PAYMENT_PAID_LABEL, supporterPaymentState } from '@/lib/supporterPayment';

export async function GET(req: Request) {
    try {
        // FR-COORD-SEC-1B: the coordinator credential used to arrive here as
        // ?token=<secret>, putting it into the query string of a logged request.
        // Authority now comes from the coordinator session cookie.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;

        // 1. Fetch campaign + customer
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: guard.campaignId },
            include: {
                customer: {
                    select: {
                        name: true,
                        contact_name: true,
                        business_id: true,
                    },
                },
            },
        });

        if (!campaign) {
            return NextResponse.json(
                { error: 'Campaign not found' },
                { status: 404 }
            );
        }

        // 2. Fetch assigned bundles (for column headers)
        const orderMode = await resolveCampaignOrderMode(campaign, campaign.customer!.business_id!);
        let bundles: { id: string, name: string }[] = [];

        if (orderMode.mode === 'legacy') {
            bundles = await prisma.bundle.findMany({
                where: { business_id: campaign.customer!.business_id!, is_active: true, show_on_storefront: true },
                orderBy: { name: 'asc' },
                select: { id: true, name: true }
            });
        } else if (orderMode.mode === 'selected' && orderMode.activeOrderableBundleIds.length > 0) {
            const selectedBundles = await prisma.bundle.findMany({
                where: { id: { in: orderMode.activeOrderableBundleIds } },
                select: { id: true, name: true }
            });
            bundles = orderMode.activeOrderableBundleIds
                .map(id => selectedBundles.find(b => b.id === id))
                .filter(Boolean)
                .map(b => ({ id: b!.id, name: b!.name }));
        }

        // 3. Fetch the orders this sheet lists, with items.
        //
        // COORD-FULFILLMENT-2 made this released-only, so an unpaid fundraiser
        // never listed boxes nobody had cooked. COORD-CLOSEOUT-PICKUP-1 keeps
        // that for OPEN campaigns and, once a campaign is CLOSED, lists its final
        // locked order set instead — held orders included — because the
        // coordinator reconciles it before the invoice is paid. Never a canceled
        // order. One shared where-clause with the printable tracker, so the two
        // pickup documents cannot disagree about who is on the list.
        const closed = isCampaignClosed({ closed_at: (campaign as any).closed_at ?? null, status: String(campaign.status) });
        const fetched = await prisma.order.findMany({
            where: pickupDocumentOrderWhere(campaign.id, { closed }),
            include: {
                items: {
                    include: {
                        bundle: { select: { id: true, name: true } }
                    }
                }
            },
            orderBy: { created_at: 'asc' }
        });
        // Second line of defence over the where-clause, as in the tracker.
        const orders = fetched.filter((o) => isPickupDocumentOrder(o as any, { closed }));
        const documentState = pickupDocumentState({ closed }, orders as any);

        // COORD-CLOSED-PORTAL-1: once a campaign is closed it is no longer orderable,
        // so orderMode names no bundles and the sheet had no quantity columns — every
        // supporter counted zero boxes on exactly the day the sheet is used. Each
        // bundle a released order actually contains gets its own column (by name),
        // so a released line is never dropped from the counts.
        const knownBundleIds = new Set(bundles.map((b) => b.id));
        const orderedBundles = new Map<string, string>();
        for (const order of orders) {
            for (const item of order.items) {
                if (item.bundle && !knownBundleIds.has(item.bundle.id)) orderedBundles.set(item.bundle.id, item.bundle.name);
            }
        }
        bundles = [
            ...bundles,
            ...[...orderedBundles].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        ];

        // --- Helper: shorten a bundle name for column headers ---
        const shortenBundleName = (name: string): string => {
            // e.g. "Q1 - Comfort Foods (Serves a Family of 4)" → "Q1 - Comfort Foods\n(Family)"
            // e.g. "Q1 - Clean Eating/Paleo (Serves 2)" → "Q1 - Clean Eating/Paleo\n(Serves 2)"
            const match = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
            if (match) {
                const label = match[1].trim();
                let size = match[2].trim();
                // Shorten "Serves a Family of 4" → "Family"
                if (/family/i.test(size)) size = 'Family';
                return `${label}\n(${size})`;
            }
            return name;
        };

        // 4. Build the Excel workbook
        const ExcelJS = (await import('exceljs')).default;
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Pickup Sheet');

        // --- Campaign title rows ---
        const campaignTitle = campaign.name || 'Fundraiser';
        const orgName = (campaign.customer as any)?.name || 'Organization';

        // Row 1: Campaign title
        worksheet.mergeCells('A1:H1');
        const titleCell = worksheet.getCell('A1');
        titleCell.value = campaignTitle;
        titleCell.font = { bold: true, size: 16, color: { argb: 'FF1E293B' } };
        titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
        worksheet.getRow(1).height = 28;

        // Row 2: Subtitle
        worksheet.mergeCells('A2:H2');
        const subtitleCell = worksheet.getCell('A2');
        subtitleCell.value = orgName ? `${orgName} — Pickup Sheet` : 'Pickup Sheet';
        subtitleCell.font = { size: 11, color: { argb: 'FF64748B' } };
        subtitleCell.alignment = { horizontal: 'left', vertical: 'middle' };
        worksheet.getRow(2).height = 20;

        // Row 3 (formerly a spacer): what this sheet is. COORD-CLOSEOUT-PICKUP-1 —
        // the final list or not, and the production-release state, in the same
        // words as the printable tracker.
        worksheet.mergeCells('A3:H3');
        const statusCell = worksheet.getCell('A3');
        statusCell.value = PICKUP_DOCUMENT_STATUS_COPY[documentState];
        statusCell.font = { italic: true, size: 10, color: { argb: 'FF475569' } };
        statusCell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        worksheet.getRow(3).height = 30;

        // --- Build header columns (row 4) ---
        const bundleColumns: { header: string; key: string; width: number }[] = [];
        for (const b of bundles) {
            bundleColumns.push({
                header: shortenBundleName(b.name),
                key: `bundle_${b.id}`,
                width: 20
            });
        }

        const allColumns = [
            { header: '#', key: 'rowNum', width: 6 },
            { header: 'Customer', key: 'customerName', width: 26 },
            { header: 'Phone', key: 'phone', width: 16 },
            ...bundleColumns,
            { header: 'Total\nBundles', key: 'totalBundles', width: 12 },
            // COORD-CLOSEOUT-PICKUP-1: what this order owes (pre-tax total + its
            // persisted tax) and the coordinator's own payment mark.
            { header: 'Amount\nDue', key: 'amountDue', width: 13 },
            { header: 'Payment', key: 'payment', width: 20 },
        ];

        // Manually set headers in row 4 since we used rows 1-3 for the title
        const HEADER_ROW = 4;
        allColumns.forEach((col, idx) => {
            const cell = worksheet.getCell(HEADER_ROW, idx + 1);
            cell.value = col.header;
            cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = {
                bottom: { style: 'thin', color: { argb: 'FF3730A3' } },
            };
            // Set column width
            worksheet.getColumn(idx + 1).width = col.width;
        });
        worksheet.getRow(HEADER_ROW).height = 36;

        // Bundle total accumulators (unchanged math)
        const bundleTotals: Record<string, number> = {};
        for (const b of bundles) {
            bundleTotals[b.id] = 0;
        }
        let grandTotal = 0;
        // COORD-CLOSEOUT-PICKUP-1: collection figures, per order.
        let amountDueTotal = 0;
        let paidMarks = 0;
        const amountDueColumn = 3 + bundles.length + 2;
        const paymentColumn = amountDueColumn + 1;
        const MONEY_FORMAT = '$#,##0.00';

        // Populate data rows (starting at row 5)
        orders.forEach((order, idx) => {
            const rowValues: any[] = [
                idx + 1,
                order.customer_name || '(unknown)',
                (order as any).phone || '',
            ];

            let orderTotal = 0;
            for (const b of bundles) {
                const matchingItems = order.items.filter(
                    item => item.bundle_id === b.id
                );
                const qty = matchingItems.reduce((sum, item) => sum + item.quantity, 0);
                rowValues.push(qty || '');
                orderTotal += qty;
                bundleTotals[b.id] += qty;
            }

            rowValues.push(orderTotal);
            grandTotal += orderTotal;

            // The one derivation of what a supporter owes, and the one meaning of
            // a recorded payment. Never "Unpaid": no order carries evidence that
            // a supporter did not pay — only whether the coordinator marked it.
            const amountDue = supporterAmountDue(order as any);
            const paid = supporterPaymentState(order as any) === 'paid';
            amountDueTotal = roundCents(amountDueTotal + amountDue);
            if (paid) paidMarks += 1;
            rowValues.push(amountDue, paid ? PAYMENT_PAID_LABEL : PAYMENT_NOT_MARKED_LABEL);

            const dataRow = worksheet.addRow(rowValues);
            // Alternate row shading for scannability
            if (idx % 2 === 1) {
                dataRow.eachCell((cell) => {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
                });
            }
            // Center-align quantity columns
            for (let c = 4; c <= 3 + bundles.length + 1; c++) {
                dataRow.getCell(c).alignment = { horizontal: 'center' };
            }
            dataRow.getCell(amountDueColumn).numFmt = MONEY_FORMAT;
            dataRow.getCell(amountDueColumn).alignment = { horizontal: 'right' };
            dataRow.getCell(paymentColumn).alignment = { horizontal: 'left' };
        });

        // Add totals row
        const totalsValues: any[] = ['', 'TOTALS', ''];
        for (const b of bundles) {
            totalsValues.push(bundleTotals[b.id]);
        }
        totalsValues.push(grandTotal);
        totalsValues.push(amountDueTotal, `${paidMarks} of ${orders.length} marked paid`);

        const totalsRow = worksheet.addRow(totalsValues);
        totalsRow.font = { bold: true, size: 11 };
        totalsRow.eachCell((cell, colNumber) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
            cell.border = { top: { style: 'medium', color: { argb: 'FF4F46E5' } } };
            if (colNumber >= 4) cell.alignment = { horizontal: 'center' };
        });
        totalsRow.getCell(amountDueColumn).numFmt = MONEY_FORMAT;
        totalsRow.getCell(amountDueColumn).alignment = { horizontal: 'right' };

        // 5. Generate buffer and return
        const buffer = await workbook.xlsx.writeBuffer();
        const safeOrgName = orgName.replace(/[^a-zA-Z0-9_-]/g, '_');

        return new NextResponse(buffer, {
            headers: {
                'Content-Type':
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="${safeOrgName}-pickup-sheet.xlsx"`,
            },
        });
    } catch (e: any) {
        console.error('Pickup Sheet Download Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to generate pickup sheet' },
            { status: 500 }
        );
    }
}
