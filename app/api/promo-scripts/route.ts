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
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import { Prisma } from '@prisma/client';
import { generatePromoScripts, type BundleSummary } from '@/lib/generatePromoScripts';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl } from '@/lib/previousSupporterInvite';
import { resolveMaterialBundles, groupMaterialMenus } from '@/lib/coordinatorMaterialBundles';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';

export async function GET(req: Request) {
    try {
        // FR-COORD-SEC-1B: was /api/promo-scripts/[token]; the credential is no
        // longer in the URL. Authority comes from the coordinator session.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;

        // 1. Fetch Campaign + Org Name
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: guard.campaignId },
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
        //
        // FR-COORD-123: pending/misconfigured/closed campaigns used to get a
        // 200 with full promotional copy for a fundraiser nobody could order
        // from — refuse instead.
        const orderMode = await resolveCampaignOrderMode(campaign, businessId);
        if (!orderMode.allowed) {
            return NextResponse.json(
                { error: 'safeMessage' in orderMode ? orderMode.safeMessage : 'This campaign cannot generate promo scripts right now.' },
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

        // 3. Canonical tier + price validation, then ONE entry per menu
        //    (FR-COORD-123). Both size variants used to enter the scripts as
        //    separate bundles, so every menu was advertised twice — and a
        //    null price rendered as "$0".
        const resolved = resolveMaterialBundles(bundles);
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: 422 });
        }
        const menus = groupMaterialMenus(resolved.bundles);

        // 4. Supporter ordering URL through the canonical FR-REBOOK-2
        //    authority — coordinators paste these scripts everywhere, so the
        //    link must be the tenant's durable storefront URL, never whatever
        //    host served this request.
        let tenant: { slug: string | null; customDomain: string | null } = { slug: null, customDomain: null };
        if (businessId) {
            const business = await prisma.business.findUnique({
                where: { id: businessId },
                select: { slug: true, custom_domain: true },
            });
            if (business) tenant = { slug: business.slug, customDomain: business.custom_domain };
        }
        const publicUrl = buildSupporterOrderUrl(
            resolveOutreachOrigin(req),
            { id: campaign.id, public_token: campaign.public_token },
            tenant,
        );
        if (!publicUrl) {
            return NextResponse.json(
                { error: 'No supporter ordering page could be resolved for this campaign. Check the storefront configuration.' },
                { status: 422 }
            );
        }

        // 5. Generate scripts — one line per menu, both sizes when both exist.
        //    Every menu has at least one validated positive price by
        //    construction (groupMaterialMenus only sees resolved bundles), so
        //    the assertion cannot introduce the $0 this route used to print.
        const bundleSummaries: BundleSummary[] = menus.map(m => ({
            name: m.baseName,
            // The family price is the headline; the Serves-2 price rides
            // along so the copy stays truthful for the smaller size.
            price: (m.familyPrice ?? m.couplePrice)!,
            couplePrice: m.familyPrice !== null ? m.couplePrice : null,
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
