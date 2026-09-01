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
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl } from '@/lib/previousSupporterInvite';
import { resolveMaterialBundles } from '@/lib/coordinatorMaterialBundles';
import { auth } from '@/auth';
import { resolveCoordinatorSession } from '@/lib/coordinatorSession';
import { customerFacingBusinessName } from '@/lib/tenantBrand';

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
        //
        // FR-COORD-123: a campaign that cannot take orders must not produce a
        // flyer either — the previous behavior generated an empty, priceless
        // flyer for pending/misconfigured campaigns and handed it over as if
        // it were fine.
        const orderMode = await resolveCampaignOrderMode(campaign, businessId);
        if (!orderMode.allowed) {
            return NextResponse.json(
                { error: 'safeMessage' in orderMode ? orderMode.safeMessage : 'This campaign cannot generate a flyer right now.' },
                { status: 422 }
            );
        }
        let bundles: any[] = [];

        // Raw price + family_id, and NO COALESCE(price, 0) — a missing price
        // must fail visibly below, never print as $0.00.
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

        // 3. Classify tiers and validate prices through the ONE canonical
        //    authority (FR-COORD-123). This is where "Family Size: $60" died:
        //    the raw serving_tier used to go straight to the renderer, which
        //    only recognized the literal 'couple'.
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
        // TENANT-BRAND-AUTHORITY-2: the printed flyer's tenant identity —
        // display_name-aware, never the raw internal name.
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

        // 7. Build the supporter ordering URL through the SAME authority the
        //    FR-REBOOK-2 invitation email uses: tenant storefront domain when
        //    they have one, pinned platform origin otherwise. The previous
        //    `new URL(req.url).origin` baked whatever host served THIS request
        //    into a printed QR code that outlives every deployment.
        const publicUrl = buildSupporterOrderUrl(
            resolveOutreachOrigin(req),
            { id: campaign.id, public_token: campaign.public_token },
            tenant,
        );
        if (!publicUrl) {
            return NextResponse.json(
                { error: 'No supporter ordering page could be resolved for this campaign, so a flyer would have a dead QR code. Check the storefront configuration.' },
                { status: 422 }
            );
        }

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
