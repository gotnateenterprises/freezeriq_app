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

        // 4. Build the Excel workbook
        const ExcelJS = (await import('exceljs')).default;
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Pickup Sheet');

        // Define columns: #, Customer Name, Phone, [one per bundle], Total Bundles
        const columns: { header: string; key: string; width: number }[] = [
            { header: '#', key: 'rowNum', width: 6 },
            { header: 'Customer Name', key: 'customerName', width: 28 },
            { header: 'Phone', key: 'phone', width: 18 },
        ];

        for (const b of bundles) {
            columns.push({
                header: b.name,
                key: `bundle_${b.id}`,
                width: 16
            });
        }

        columns.push({ header: 'Total Bundles', key: 'totalBundles', width: 14 });

        worksheet.columns = columns;

        // Style header row
        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true, size: 11 };
        headerRow.alignment = { horizontal: 'center' };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4F46E5' }
        };
        headerRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };

        // Bundle total accumulators
        const bundleTotals: Record<string, number> = {};
        for (const b of bundles) {
            bundleTotals[b.id] = 0;
        }
        let grandTotal = 0;

        // Populate rows
        orders.forEach((order, idx) => {
            const rowData: Record<string, any> = {
                rowNum: idx + 1,
                customerName: order.customer_name || '(unknown)',
                phone: (order as any).phone || '',
            };

            let orderTotal = 0;
            for (const b of bundles) {
                const matchingItems = order.items.filter(
                    item => item.bundle_id === b.id
                );
                const qty = matchingItems.reduce((sum, item) => sum + item.quantity, 0);
                rowData[`bundle_${b.id}`] = qty || '';
                orderTotal += qty;
                bundleTotals[b.id] += qty;
            }

            rowData.totalBundles = orderTotal;
            grandTotal += orderTotal;

            worksheet.addRow(rowData);
        });

        // Add totals row
        const totalsRowData: Record<string, any> = {
            rowNum: '',
            customerName: 'TOTALS',
            phone: '',
        };
        for (const b of bundles) {
            totalsRowData[`bundle_${b.id}`] = bundleTotals[b.id];
        }
        totalsRowData.totalBundles = grandTotal;

        const totalsRow = worksheet.addRow(totalsRowData);
        totalsRow.font = { bold: true, size: 11 };
        totalsRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF1F5F9' }
        };

        // 5. Generate buffer and return
        const buffer = await workbook.xlsx.writeBuffer();
        const orgName = (campaign.customer as any)?.name || 'Organization';
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
