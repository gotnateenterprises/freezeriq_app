/**
 * Full Packet Download API
 *
 * ACCESS MODEL: Token-based (no session auth)
 * - GET gated by `portal_token` on FundraiserCampaign
 * - Returns a ZIP archive containing flyer, tracker, and quick-start guide
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from portal_token)
 *
 * Mirrors the data-fetching pattern of /api/flyer/download.
 * Delegates all file generation to generateFullPacket() which
 * reuses existing generateFlyer() and generateTracker() utilities.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { generateFullPacket } from '@/lib/generateFullPacket';
import type { FlyerBundle } from '@/lib/generateFlyer';
import { Prisma } from '@prisma/client';
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

        const businessId = (campaign.customer as any)?.business_id;
        const orgName = (campaign.customer as any)?.name || 'Organization';

        // 2. Fetch assigned bundles (or fallback to all active bundles for business)
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

        // 3. Fetch recipe names for each bundle
        const bundleIds = bundles.map(b => b.id);
        let bundleItems: any[] = [];
        if (bundleIds.length > 0) {
            bundleItems = await prisma.$queryRaw`
                SELECT bc.bundle_id, r.name as recipe_name
                FROM bundle_contents bc
                JOIN recipes r ON bc.recipe_id = r.id
                WHERE bc.bundle_id IN(${Prisma.join(bundleIds)})
                ORDER BY bc.position ASC NULLS LAST
            `;
        }

        // 4. Build FlyerBundle shapes
        const flyerBundles: FlyerBundle[] = bundles.map(b => ({
            name: b.name,
            price: Number(b.price),
            servingTier: b.serving_tier || 'family',
            meals: bundleItems
                .filter(i => i.bundle_id === b.id)
                .map(i => i.recipe_name),
        }));

        // 5. Fetch tenant branding (via any user with same business_id)
        let branding: { primary_color?: string; secondary_color?: string; accent_color?: string } | undefined;
        if (businessId) {
            const brandingRow = await prisma.tenantBranding.findFirst({
                where: {
                    user: { business_id: businessId },
                },
                select: {
                    primary_color: true,
                    secondary_color: true,
                    accent_color: true,
                },
            });
            if (brandingRow) {
                branding = brandingRow;
            }
        }

        // 6. Fetch business name
        let businessName = 'FreezerIQ';
        if (businessId) {
            const business = await prisma.business.findUnique({
                where: { id: businessId },
                select: { name: true },
            });
            if (business) businessName = business.name;
        }

        // 7. Build public URL from request origin
        const publicUrl = buildPublicFundraiserUrl(req, campaign.public_token!);

        // 8. Generate full packet ZIP
        //    coordinatorName: prefer customer.contact_name, fall back to campaign.name
        const coordinatorName =
            (campaign.customer as any)?.contact_name || campaign.name;

        const zipBuffer = await generateFullPacket({
            campaignName: campaign.name,
            organizationName: orgName,
            businessName,
            endDate: campaign.end_date
                ? new Date(campaign.end_date).toISOString().split('T')[0]
                : '',
            deliveryDate: campaign.delivery_date
                ? new Date(campaign.delivery_date).toISOString().split('T')[0]
                : '',
            pickupLocation: campaign.pickup_location || '',
            checksPayable: campaign.checks_payable || '',
            publicUrl,
            coordinatorName,
            bundles: flyerBundles,
            branding,
        });

        // 9. Return ZIP download
        const safeOrgName = orgName.replace(/[^a-zA-Z0-9_-]/g, '_');

        return new NextResponse(new Uint8Array(zipBuffer), {
            headers: {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${safeOrgName}-fundraiser-packet.zip"`,
            },
        });
    } catch (e: any) {
        console.error('Packet Download Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to generate packet' },
            { status: 500 }
        );
    }
}
