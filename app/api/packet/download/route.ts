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
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl } from '@/lib/previousSupporterInvite';
import { resolveMaterialBundles } from '@/lib/coordinatorMaterialBundles';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { customerFacingBusinessName } from '@/lib/tenantBrand';

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
        //
        // FR-COORD-123: pending/misconfigured/closed campaigns used to yield a
        // 200 ZIP whose flyer had no menus and no prices — refuse instead.
        const orderMode = await resolveCampaignOrderMode(campaign, businessId);
        if (!orderMode.allowed) {
            return NextResponse.json(
                { error: 'safeMessage' in orderMode ? orderMode.safeMessage : 'This campaign cannot generate a packet right now.' },
                { status: 422 }
            );
        }
        let bundles: any[] = [];

        if (orderMode.mode === 'legacy') {
            bundles = await prisma.$queryRaw`
                SELECT id, name, price, serving_tier, family_id FROM bundles
                WHERE business_id = ${businessId}
                AND is_active = true
                AND show_on_storefront = true
                ORDER BY name ASC
                LIMIT 10
            `;
        } else if (orderMode.mode === 'selected' && orderMode.activeOrderableBundleIds.length > 0) {
            bundles = await prisma.$queryRaw`
                SELECT id, name, price, serving_tier, family_id FROM bundles
                WHERE id IN(${Prisma.join(orderMode.activeOrderableBundleIds)})
                AND business_id = ${businessId}
                AND is_active = true
                ORDER BY array_position(${orderMode.activeOrderableBundleIds}::text[], id::text)
            `;
        }

        // 3. Canonical tier + price validation (FR-COORD-123) — the packet's
        //    flyer.pdf carried the same Family-Size-at-Serves-2-price defect
        //    as /api/flyer/download, from the same raw passthrough.
        const resolved = resolveMaterialBundles(bundles);
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: 422 });
        }

        // 4. Fetch recipe names for each bundle
        const bundleIds = resolved.bundles.map(b => b.id);
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

        const flyerBundles: FlyerBundle[] = resolved.bundles.map(b => ({
            name: b.name,
            price: b.price,
            servingTier: b.servingTier,
            familyId: b.familyId,
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

        // 6. Fetch business name + storefront identity
        // TENANT-BRAND-AUTHORITY-2: the packet's tenant identity — display_name-
        // aware, never the raw internal name.
        let businessName = 'FreezerIQ';
        let tenant: { slug: string | null; customDomain: string | null } = { slug: null, customDomain: null };
        if (businessId) {
            const business = await prisma.business.findUnique({
                where: { id: businessId },
                select: { name: true, display_name: true, slug: true, custom_domain: true },
            });
            if (business) {
                businessName = customerFacingBusinessName(business);
                tenant = { slug: business.slug, customDomain: business.custom_domain };
            }
        }

        // 7. Supporter ordering URL through the canonical FR-REBOOK-2
        //    authority (FR-COORD-123). This URL lands in FOUR durable
        //    artifacts — flyer QR, tracker cell, qr-code.png, quick-start
        //    guide — so the request host must never decide it.
        const publicUrl = buildSupporterOrderUrl(
            resolveOutreachOrigin(req),
            { id: campaign.id, public_token: campaign.public_token },
            tenant,
        );
        if (!publicUrl) {
            return NextResponse.json(
                { error: 'No supporter ordering page could be resolved for this campaign, so the packet would carry a dead QR code. Check the storefront configuration.' },
                { status: 422 }
            );
        }

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
