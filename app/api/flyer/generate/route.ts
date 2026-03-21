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
import { prisma } from '@/lib/db';
import { generateFlyer, type FlyerBundle } from '@/lib/generateFlyer';
import { Prisma } from '@prisma/client';
import { buildPublicFundraiserUrl } from '@/lib/fundraiserUrls';

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

        // 3. Find the most recent active campaign for this customer
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { customer_id: customerId },
            orderBy: { created_at: 'desc' },
            select: {
                id: true,
                name: true,
                end_date: true,
                delivery_date: true,
                pickup_location: true,
                checks_payable: true,
                public_token: true,
            },
        });

        if (!campaign) {
            return NextResponse.json(
                { error: 'No campaign found for this customer. Please create a campaign first.' },
                { status: 404 }
            );
        }

        // 4. Fetch assigned bundles (or fallback to all active bundles for business)
        const campaignBundles: any[] = await prisma.$queryRaw`
            SELECT bundle_id FROM campaign_bundles
            WHERE campaign_id = ${campaign.id}
            ORDER BY position ASC
        `;
        const assignedBundleIds = campaignBundles.map(cb => cb.bundle_id);

        let bundles: any[];
        if (assignedBundleIds.length > 0) {
            bundles = await prisma.$queryRaw`
                SELECT id, name, COALESCE(price, 0) as price, serving_tier FROM bundles
                WHERE id IN(${Prisma.join(assignedBundleIds)})
                AND business_id = ${businessId}
                AND is_active = true
                ORDER BY array_position(${assignedBundleIds}::text[], id::text)
            `;
        } else {
            bundles = await prisma.$queryRaw`
                SELECT id, name, COALESCE(price, 0) as price, serving_tier FROM bundles
                WHERE business_id = ${businessId}
                AND is_active = true
                ORDER BY name ASC
                LIMIT 10
            `;
        }

        // 5. Fetch recipe names for each bundle
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

        // 6. Build FlyerBundle shapes
        const flyerBundles: FlyerBundle[] = bundles.map(b => ({
            name: b.name,
            price: Number(b.price),
            servingTier: b.serving_tier || 'family',
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

        // 8. Fetch business name
        let businessName = 'FreezerIQ';
        let businessSlug: string | null = null;
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { name: true, slug: true },
        });
        if (business) {
            businessName = business.name;
            businessSlug = business.slug;
        }

        // 9. Build public URL → shop order page (not the old scoreboard)
        const origin = new URL(req.url).origin;
        const publicUrl = campaign.public_token
            ? (businessSlug
                ? `${origin}/shop/${businessSlug}/fundraiser/${campaign.id}`
                : buildPublicFundraiserUrl(req, campaign.public_token))
            : '';

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
