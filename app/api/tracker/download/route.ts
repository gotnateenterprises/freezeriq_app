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
import { Prisma } from '@prisma/client';
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

        // 2. Fetch assigned bundles (or fallback to active business bundles)
        //    Same pattern as flyer/packet/promo-scripts download routes
        const campaignBundles: any[] = await prisma.$queryRaw`
            SELECT bundle_id FROM campaign_bundles
            WHERE campaign_id = ${campaign.id}
            ORDER BY position ASC
        `;
        const assignedBundleIds = campaignBundles.map(cb => cb.bundle_id);

        let bundles: any[];
        if (assignedBundleIds.length > 0) {
            bundles = await prisma.$queryRaw`
                SELECT id, name, price, serving_tier FROM bundles
                WHERE id IN(${Prisma.join(assignedBundleIds)})
                AND business_id = ${businessId}
                AND is_active = true
                ORDER BY array_position(${assignedBundleIds}::text[], id::text)
            `;
        } else {
            bundles = await prisma.$queryRaw`
                SELECT id, name, price, serving_tier FROM bundles
                WHERE business_id = ${businessId}
                AND is_active = true
                ORDER BY name ASC
                LIMIT 10
            `;
        }

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
