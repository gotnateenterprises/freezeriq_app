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
 * BUNDLE LOGIC: Reuses the same assigned-bundle / fallback pattern
 * established in the flyer and packet download routes.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { generateTracker } from '@/lib/generateTracker';
import { buildPublicFundraiserUrl } from '@/lib/fundraiserUrls';

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

        // 1. Fetch campaign + customer (include contact_name for coordinator)
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

        const businessId = (campaign.customer as any)?.business_id;
        const orgName = (campaign.customer as any)?.name || 'Organization';

        // 2. Fetch assigned bundles only (no fallback to all bundles)
        const campaignBundles = await prisma.campaignBundle.findMany({
            where: { campaign_id: campaign.id },
            orderBy: { position: 'asc' },
            include: {
                bundle: {
                    select: { id: true, name: true, price: true, serving_tier: true, is_active: true }
                }
            }
        });
        const bundles = campaignBundles
            .filter(cb => cb.bundle.is_active)
            .map(cb => ({
                id: cb.bundle.id,
                name: cb.bundle.name,
                price: cb.bundle.price,
                serving_tier: cb.bundle.serving_tier
            }));

        // 3. Map to TrackerInput shape
        //    coordinatorName: prefer customer.contact_name, fall back to campaign.name
        const publicUrl = buildPublicFundraiserUrl(req, campaign.public_token!);
        const coordinatorName =
            (campaign.customer as any)?.contact_name || campaign.name;

        const buffer = await generateTracker({
            campaignName: campaign.name,
            organizationName: orgName,
            endDate: campaign.end_date
                ? new Date(campaign.end_date).toISOString()
                : '',
            publicUrl,
            coordinatorName,
            bundles: bundles.map((b: any) => ({
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
