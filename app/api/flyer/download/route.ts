/**
 * Flyer Download API
 *
 * ACCESS MODEL: TWO authenticated modes, no bearer credential in any URL.
 *
 *   1. Coordinator — the coordinator session cookie. Campaign comes from the
 *      session; nothing is read from the request.
 *   2. Tenant staff — a signed-in NextAuth session plus ?campaignId=. The
 *      campaign is re-checked against the caller's own business, so the id is
 *      an argument, never an authorisation.
 *
 * FR-COORD-SEC-1B — this route previously accepted ?token=<portal_token>, which
 * put the coordinator credential into the query string of a logged request. The
 * tenant mode exists because the CRM's StartFundraiserWizard also downloads the
 * flyer; removing the bearer without it would have broken that flow.
 *
 * ACTOR: Fundraiser Coordinator, or authenticated tenant staff
 * SCOPE: Single campaign
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import { generateFlyer, type FlyerBundle } from '@/lib/generateFlyer';
import { Prisma } from '@prisma/client';
import { buildPublicFundraiserUrl } from '@/lib/fundraiserUrls';
import { auth } from '@/auth';
import { resolveCoordinatorSession } from '@/lib/coordinatorSession';

/**
 * Resolve which campaign this caller may have, from authentication alone.
 * Returns null when neither mode authorises anything — the caller cannot tell
 * which mode failed, or whether the campaign exists.
 */
async function resolveAuthorizedCampaignId(req: Request): Promise<string | null> {
    // Mode 1 — coordinator session.
    const coordinator = await resolveCoordinatorSession();
    if (coordinator) return coordinator.campaignId;

    // Mode 2 — authenticated tenant staff, scoped to their own business.
    const session = await auth();
    const businessId = (session as any)?.user?.businessId as string | undefined;
    if (!businessId) return null;

    const campaignId = new URL(req.url).searchParams.get('campaignId');
    if (!campaignId) return null;

    // The id is checked against the caller's business, so supplying another
    // tenant's campaign id resolves to nothing.
    const owned = await prisma.fundraiserCampaign.findFirst({
        where: { id: campaignId, customer: { business_id: businessId } },
        select: { id: true },
    });
    return owned?.id ?? null;
}

export async function GET(req: Request) {
    try {
        const campaignId = await resolveAuthorizedCampaignId(req);
        if (!campaignId) {
            return NextResponse.json({ error: 'Not authorized' }, { status: 401 });
        }

        // 1. Fetch campaign + customer
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
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

        // 2. Fetch assigned bundles (or fallback to all active bundles for business)
        const orderMode = await resolveCampaignOrderMode(campaign, businessId);
        let bundles: any[] = [];

        if (orderMode.mode === 'legacy') {
            bundles = await prisma.$queryRaw`
                SELECT id, name, COALESCE(price, 0) as price, serving_tier FROM bundles
                WHERE business_id = ${businessId}
                AND is_active = true
                AND show_on_storefront = true
                ORDER BY name ASC
                LIMIT 10
            `;
        } else if (orderMode.mode === 'selected' && orderMode.activeOrderableBundleIds.length > 0) {
            bundles = await prisma.$queryRaw`
                SELECT id, name, COALESCE(price, 0) as price, serving_tier FROM bundles
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

        // 8. Generate PDF
        const buffer = await generateFlyer({
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
            bundles: flyerBundles,
            branding,
        });

        // 9. Return PDF download
        const safeOrgName = orgName.replace(/[^a-zA-Z0-9_-]/g, '_');

        return new NextResponse(new Uint8Array(buffer), {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `attachment; filename="${safeOrgName}-fundraiser-flyer.pdf"`,
            },
        });
    } catch (e: any) {
        console.error('Flyer Download Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to generate flyer' },
            { status: 500 }
        );
    }
}
