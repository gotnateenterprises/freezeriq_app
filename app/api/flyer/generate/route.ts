/**
 * Flyer Generate API (CRM-facing)
 *
 * ACCESS MODEL: Session-authenticated (tenant user)
 * - POST gated by NextAuth session + businessId
 * - Returns flyer PDF as base64 JSON (for email attachment) or binary (for download)
 *
 * ACTOR: Tenant business user (CRM)
 * SCOPE: Customer scoped to session's businessId
 *
 * Reuses the server-side generateFlyer() — the same function
 * powering /api/flyer/download (coordinator portal).
 */

import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import { generateFlyer, type FlyerBundle } from '@/lib/generateFlyer';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl } from '@/lib/previousSupporterInvite';
import { resolveMaterialBundles } from '@/lib/coordinatorMaterialBundles';
import { CLOSED_STATUSES } from '@/lib/campaignBundleSelection';

export async function POST(req: Request) {
    try {
        // 1. Session auth
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const body = await req.json();
        const { customerId } = body;

        if (!customerId) {
            return NextResponse.json(
                { error: 'Missing customerId parameter' },
                { status: 400 }
            );
        }

        // 2. Fetch customer (scoped to business)
        const customer = await prisma.customer.findFirst({
            where: { id: customerId, business_id: businessId },
            select: { id: true, name: true, business_id: true },
        });

        if (!customer) {
            return NextResponse.json(
                { error: 'Customer not found' },
                { status: 404 }
            );
        }

        const orgName = customer.name || 'Organization';

        // 3. Find the CURRENT campaign for this customer.
        //
        // FR-COORD-123, two fixes here:
        //  - The comment used to say "most recent active" while the query took
        //    the most recently CREATED of ANY status — a closed campaign, or a
        //    Lead row created by a bulk import, silently shadowed the live one.
        //    Now: the newest Active campaign, falling back to the newest
        //    not-yet-closed one (a pre-launch flyer is legitimate), never a
        //    closed one.
        //  - The select omitted the lifecycle fields resolveCampaignOrderMode
        //    branches on (status, closed_at, bundle_selection_*), so the
        //    resolver fell through to fail-closed 'invalid' on EVERY request
        //    and this route only ever produced zero-menu flyers.
        const campaignSelect = {
            id: true,
            name: true,
            status: true,
            closed_at: true,
            bundle_selection_status: true,
            bundle_selection_limit: true,
            end_date: true,
            delivery_date: true,
            pickup_location: true,
            checks_payable: true,
            public_token: true,
        } as const;

        const campaign =
            await prisma.fundraiserCampaign.findFirst({
                where: { customer_id: customerId, status: 'Active' },
                orderBy: { created_at: 'desc' },
                select: campaignSelect,
            })
            ?? await prisma.fundraiserCampaign.findFirst({
                where: {
                    customer_id: customerId,
                    status: { notIn: [...CLOSED_STATUSES] },
                    closed_at: null,
                },
                orderBy: { created_at: 'desc' },
                select: campaignSelect,
            });

        if (!campaign) {
            return NextResponse.json(
                { error: 'No open campaign found for this customer. Please create a campaign first.' },
                { status: 404 }
            );
        }

        // 4. Fetch assigned bundles (or fallback to all active bundles for business)
        const orderMode = await resolveCampaignOrderMode(campaign, businessId);
        if (!orderMode.allowed) {
            return NextResponse.json(
                { error: 'safeMessage' in orderMode ? orderMode.safeMessage : 'This campaign cannot generate a flyer right now.' },
                { status: 422 }
            );
        }
        let bundles: any[] = [];

        // Raw price + family_id, no COALESCE — a missing price fails visibly.
        if (orderMode.mode === 'legacy') {
            bundles = await prisma.$queryRaw`
                SELECT id, name, price, serving_tier, family_id FROM bundles
                WHERE business_id = ${businessId}
                AND is_active = true
                AND show_on_storefront = true
                ORDER BY name ASC
                LIMIT 4
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

        // 5. Canonical tier + price validation (FR-COORD-123) — same authority
        //    as the supporter ordering path, fail closed on anything it would
        //    refuse to sell.
        const resolved = resolveMaterialBundles(bundles);
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: 422 });
        }

        // 6. Fetch recipe names for each bundle
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

        // 7. Fetch tenant branding
        let branding: { primary_color?: string; secondary_color?: string; accent_color?: string } | undefined;
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

        // 8. Fetch business name + storefront identity
        let businessName = 'FreezerIQ';
        let tenant: { slug: string | null; customDomain: string | null } = { slug: null, customDomain: null };
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { name: true, slug: true, custom_domain: true },
        });
        if (business) {
            businessName = business.name;
            tenant = { slug: business.slug, customDomain: business.custom_domain };
        }

        // 9. Supporter ordering URL through the canonical FR-REBOOK-2
        //    authority — tenant storefront domain preferred, platform origin
        //    pinned, never the request host (FR-COORD-123).
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

        // 10. Generate PDF
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

        // 11. Return as base64 JSON (matches the shape CRM expects for email attachments)
        const base64 = Buffer.from(buffer).toString('base64');
        const safeOrgName = orgName.replace(/[^a-zA-Z0-9_-]/g, '_');

        return NextResponse.json({
            filename: `Marketing Packet - ${customer.name}.pdf`,
            content: base64,
            contentType: 'application/pdf',
        });
    } catch (e: any) {
        console.error('Flyer Generate Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to generate flyer' },
            { status: 500 }
        );
    }
}
