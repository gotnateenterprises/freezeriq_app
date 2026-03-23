/**
 * Pickup Sheet Download API
 *
 * ACCESS MODEL: Token-based (no session auth)
 * - GET gated by `portal_token` on FundraiserCampaign
 * - Returns a populated .xlsx file as a binary download
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from portal_token)
 *
 * PURPOSE: Generates a delivery-day pickup sheet with one row per order,
 * showing customer name, phone, per-bundle quantities, and total bundles.
 * This is a DATA EXPORT, not a blank template (unlike /api/tracker/download).
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const token = searchParams.get('token');

        if (!token) {
            return NextResponse.json(
                { error: 'Missing token parameter' },
                { status: 400 }
            );
        }

        // 1. Fetch campaign + customer
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
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
        const campaignBundles = await prisma.campaignBundle.findMany({
            where: { campaign_id: campaign.id },
            orderBy: { position: 'asc' },
            include: {
                bundle: {
                    select: { id: true, name: true, is_active: true }
                }
            }
        });

        const bundles = campaignBundles
            .filter(cb => cb.bundle.is_active)
            .map(cb => ({
                id: cb.bundle.id,
                name: cb.bundle.name
            }));

        // 3. Fetch all orders for this campaign with items
        const orders = await prisma.order.findMany({
            where: { campaign_id: campaign.id },
            include: {
                items: {
                    include: {
                        bundle: { select: { id: true, name: true } }
                    }
                }
            },
            orderBy: { created_at: 'asc' }
        });

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

        // Row 3: Spacer
        worksheet.getRow(3).height = 8;

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
        });

        // Add totals row
        const totalsValues: any[] = ['', 'TOTALS', ''];
        for (const b of bundles) {
            totalsValues.push(bundleTotals[b.id]);
        }
        totalsValues.push(grandTotal);

        const totalsRow = worksheet.addRow(totalsValues);
        totalsRow.font = { bold: true, size: 11 };
        totalsRow.eachCell((cell, colNumber) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
            cell.border = { top: { style: 'medium', color: { argb: 'FF4F46E5' } } };
            if (colNumber >= 4) cell.alignment = { horizontal: 'center' };
        });

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
