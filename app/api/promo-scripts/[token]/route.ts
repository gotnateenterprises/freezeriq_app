/**
 * Promo Scripts API
 *
 * ACCESS MODEL: Token-based (no auth session required)
 * - GET gated by `portal_token` on FundraiserCampaign
 * - Returns deterministic, campaign-specific promotional copy
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
import { generatePromoScripts, type BundleSummary } from '@/lib/generatePromoScripts';
import { buildPublicFundraiserUrl } from '@/lib/fundraiserUrls';

export async function GET(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;

        if (!token || token.length < 8) {
            return NextResponse.json(
                { error: 'Invalid token' },
                { status: 400 }
            );
        }

        // 1. Fetch Campaign + Org Name
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
        const orgName = (campaign.customer as any)?.name || 'Organization';

        // 2. Fetch assigned bundles (or fallback to active business bundles)
        //    Same pattern as flyer/packet download routes
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
                LIMIT 4
            `;
        }

        // 3. Build public fundraiser URL
        const publicUrl = buildPublicFundraiserUrl(req, campaign.public_token!);

        // 4. Generate scripts
        const bundleSummaries: BundleSummary[] = bundles.map(b => ({
            name: b.name,
            price: Number(b.price),
        }));

        const result = generatePromoScripts({
            campaignName: campaign.name,
            organizationName: orgName,
            publicUrl,
            endDate: campaign.end_date ? campaign.end_date.toISOString() : null,
            bundles: bundleSummaries,
        });

        return NextResponse.json(result);

    } catch (e: any) {
        console.error('Promo Scripts API Error:', e);
        return NextResponse.json(
            { error: 'Failed to generate promo scripts' },
            { status: 500 }
        );
    }
}
