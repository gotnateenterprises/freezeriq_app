/**
 * Tracker Download API
 *
 * ACCESS MODEL: Token-based (no session auth)
 * - GET gated by `portal_token` on FundraiserCampaign
 * - Returns a populated .xlsx file as a binary download
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from portal_token)
 *
 * TEMPLATE: Uses the same tracking_sheet.xlsx template as the
 * marketing packet email attachment (/api/documents/tracking-sheet).
 * Populates deadline, checks_payable_to, and bundle recipes from
 * campaign data in the database.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import path from 'path';

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

        // 2. Fetch assigned bundles with their recipe contents
        const orderMode = await resolveCampaignOrderMode(campaign, campaign.customer!.business_id!);
        let bundles: { name: string, recipes: string[] }[] = [];

        if (orderMode.mode === 'legacy') {
            const legacyBundles = await prisma.bundle.findMany({
                where: { business_id: campaign.customer!.business_id!, is_active: true, show_on_storefront: true },
                orderBy: { name: 'asc' },
                include: {
                    contents: {
                        orderBy: { position: 'asc' },
                        include: { recipe: { select: { name: true } } }
                    }
                }
            });
            bundles = legacyBundles.map(b => ({
                name: b.name,
                recipes: b.contents.map(c => (c as any).recipe?.name).filter(Boolean)
            }));
        } else if (orderMode.mode === 'selected' && orderMode.activeOrderableBundleIds.length > 0) {
            const selectedBundles = await prisma.bundle.findMany({
                where: { id: { in: orderMode.activeOrderableBundleIds } },
                include: {
                    contents: {
                        orderBy: { position: 'asc' },
                        include: { recipe: { select: { name: true } } }
                    }
                }
            });
            bundles = orderMode.activeOrderableBundleIds
                .map(id => selectedBundles.find(b => b.id === id))
                .filter(Boolean)
                .map(b => ({
                    name: b!.name,
                    recipes: b!.contents.map(c => (c as any).recipe?.name).filter(Boolean)
                }));
        }

        // 3. Load the SAME template used by the marketing packet
        const ExcelJS = (await import('exceljs')).default;
        const templatePath = path.resolve('./templates/tracking_sheet.xlsx');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(templatePath);

        const worksheet = workbook.worksheets[0];

        // 4. Populate deadline (B4) — same logic as /api/documents/tracking-sheet
        let formattedDeadline = '(Insert Date)';
        if (campaign.end_date) {
            const d = new Date(campaign.end_date);
            formattedDeadline = d.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
            });
        }

        const cellB4 = worksheet.getCell('B4');
        if (cellB4.value && typeof cellB4.value === 'string') {
            cellB4.value = cellB4.value.replace('(Insert Date)', formattedDeadline);
        } else {
            cellB4.value = `All orders and money must be submitted by your group's deadline: ${formattedDeadline}`;
        }

        // 5. Populate checks payable (B5)
        const payee = campaign.checks_payable || '_______________________';
        const cellB5 = worksheet.getCell('B5');
        if (cellB5.value && typeof cellB5.value === 'string') {
            cellB5.value = cellB5.value.replace('(insert pay to organization)', payee);
        } else {
            cellB5.value = `All checks should be made payable to:  ${payee}`;
        }

        // 6. Populate bundle recipes (Column B rows 24-28, Column C rows 24-28)
        if (bundles[0]?.recipes) {
            for (let i = 0; i < 5; i++) {
                worksheet.getCell(`B${24 + i}`).value = bundles[0].recipes[i] || '';
            }
        }
        if (bundles[1]?.recipes) {
            for (let i = 0; i < 5; i++) {
                worksheet.getCell(`C${24 + i}`).value = bundles[1].recipes[i] || '';
            }
        }

        // 7. Generate buffer and return
        const buffer = await workbook.xlsx.writeBuffer();
        const orgName = (campaign.customer as any)?.name || 'Organization';
        const safeOrgName = orgName.replace(/[^a-zA-Z0-9_-]/g, '_');

        return new NextResponse(buffer, {
            headers: {
                'Content-Type':
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="${safeOrgName}-order-tracker.xlsx"`,
            },
        });
    } catch (e: any) {
        console.error('Tracker Download Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to generate tracker' },
            { status: 500 }
        );
    }
}
