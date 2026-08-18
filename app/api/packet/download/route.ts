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
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import { generateFullPacket } from '@/lib/generateFullPacket';
import type { FlyerBundle } from '@/lib/generateFlyer';
import { buildPublicFundraiserUrl } from '@/lib/fundraiserUrls';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';

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

        const businessId = (campaign.customer as any)?.business_id;
        const orgName = (campaign.customer as any)?.name || 'Organization';

        // 2. Fetch assigned bundles (or fallback to all active bundles for business)
        const orderMode = await resolveCampaignOrderMode(campaign, businessId);
        let bundles: any[] = [];

        if (orderMode.mode === 'legacy') {
            bundles = await prisma.$queryRaw`
                SELECT id, name, price, serving_tier FROM bundles
                WHERE business_id = ${businessId}
                AND is_active = true
                AND show_on_storefront = true
                ORDER BY name ASC
                LIMIT 10
            `;
        } else if (orderMode.mode === 'selected' && orderMode.activeOrderableBundleIds.length > 0) {
            bundles = await prisma.$queryRaw`
                SELECT id, name, price, serving_tier FROM bundles
                WHERE id IN(${Prisma.join(orderMode.activeOrderableBundleIds)})
                AND business_id = ${businessId}
                AND is_active = true
                ORDER BY array_position(${orderMode.activeOrderableBundleIds}::text[], id::text)
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

        // 6. Fetch business name + slug
        let businessName = 'FreezerIQ';
        let businessSlug: string | null = null;
        if (businessId) {
            const business = await prisma.business.findUnique({
                where: { id: businessId },
                select: { name: true, slug: true },
            });
            if (business) {
                businessName = business.name;
                businessSlug = business.slug;
            }
        }

        // 7. Build public URL → shop order page (not the old scoreboard)
        const origin = new URL(req.url).origin;
        const publicUrl = businessSlug
            ? `${origin}/shop/${businessSlug}/fundraiser/${campaign.id}`
            : buildPublicFundraiserUrl(req, campaign.public_token!);

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
