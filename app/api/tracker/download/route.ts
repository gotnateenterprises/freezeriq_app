/**
 * Tracker Download API
 *
 * ACCESS MODEL: Token-based (no session auth)
 * - GET gated by `portal_token` on FundraiserCampaign
 * - Returns a populated .xlsx file as a binary download
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from portal_token)
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { generateTracker } from '@/lib/generateTracker';

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

        // 1. Fetch campaign + customer + bundles
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            include: {
                customer: {
                    select: {
                        name: true,
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

        const businessId = (campaign.customer as any)?.business_id;

        // 2. Fetch active bundles for this business
        const bundles = await prisma.bundle.findMany({
            where: {
                business_id: businessId,
                is_active: true,
            },
            select: {
                name: true,
                price: true,
            },
            take: 2, // Template supports up to 2 bundles (A10, A11)
        });

        // 3. Map to TrackerInput shape
        const orgName = (campaign.customer as any)?.name || 'Organization';
        const publicUrl = `https://freezeriq-app.vercel.app/fundraiser/${campaign.public_token}`;

        const buffer = await generateTracker({
            campaignName: campaign.name,
            organizationName: orgName,
            endDate: campaign.end_date
                ? new Date(campaign.end_date).toISOString()
                : '',
            publicUrl,
            coordinatorName: campaign.name, // fallback — no dedicated field
            bundles: bundles.map((b) => ({
                name: b.name,
                price: Number(b.price),
            })),
        });

        // 4. Sanitise filename
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
