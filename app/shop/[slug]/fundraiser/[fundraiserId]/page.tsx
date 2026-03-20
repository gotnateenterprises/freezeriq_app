import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import FundraiserClient from './FundraiserClient';

// We need to fetch data on the server
async function getData(slug: string, fundraiserId: string) {
    // 1. Fetch Business
    const business = await prisma.business.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true, logo_url: true }
    });

    if (!business) return null;

    // 2. Fetch Branding (Raw SQL to bypass missing relation)
    const brandingRecords: any[] = await prisma.$queryRaw`
        SELECT b.* 
        FROM tenant_branding b
        JOIN users u ON b.user_id = u.id
        WHERE u.business_id = ${business.id}
        AND u.role = 'ADMIN'
        LIMIT 1
    `;

    // Default branding if missing
    const branding = brandingRecords[0] || {
        business_name: business.name,
        primary_color: '#4f46e5',
        secondary_color: '#818cf8',
        tagline: '',
        logo_url: business.logo_url
    };

    // Attach branding to business object for compatibility
    (business as any).branding = branding;

    // 3. Fetch Campaign
    const campaigns: any[] = await prisma.$queryRaw`
        SELECT fc.*, c.name as organization_name, c.contact_email as coordinator_email 
        FROM fundraiser_campaigns fc
        JOIN customers c ON fc.customer_id = c.id
        WHERE fc.id = ${fundraiserId} 
        LIMIT 1
    `;
    const campaign = campaigns[0];

    if (!campaign) return null;

    // 4. Fetch Orders for goal calculation
    const orders: any[] = await prisma.$queryRaw`
        SELECT total_amount FROM orders WHERE campaign_id = ${fundraiserId}
    `;

    // Calculate total raised
    const raised = orders.reduce((sum: number, order: any) => sum + Number(order.total_amount), 0);
    const progress = campaign.goal_amount ? Math.min((raised / Number(campaign.goal_amount)) * 100, 100) : 0;

    // 5. Check for campaign-specific bundle assignments
    const campaignBundles: any[] = await prisma.$queryRaw`
        SELECT bundle_id FROM campaign_bundles
        WHERE campaign_id = ${fundraiserId}
        ORDER BY position ASC
    `;
    const assignedBundleIds = campaignBundles.map(cb => cb.bundle_id);

    // 6. Fetch Bundles — only assigned bundles if campaign has assignments,
    //    otherwise fall back to all active bundles for this business.
    //    Both paths enforce business_id to prevent cross-tenant leakage.
    let bundles: any[];
    if (assignedBundleIds.length > 0) {
        bundles = await prisma.$queryRaw`
            SELECT * FROM bundles
            WHERE id IN(${Prisma.join(assignedBundleIds)})
            AND business_id = ${business.id}
            AND is_active = true
            ORDER BY array_position(${assignedBundleIds}::text[], id::text)
        `;
    } else {
        bundles = await prisma.$queryRaw`
            SELECT * FROM bundles 
            WHERE business_id = ${business.id} 
            AND is_active = true
            AND show_on_storefront = true
            ORDER BY name ASC
        `;
    }

    const bundleIds = bundles.map(b => b.id);
    let bundleItems: any[] = [];

    if (bundleIds.length > 0) {
        bundleItems = await prisma.$queryRaw`
             SELECT bc.*, r.name as recipe_name, r.description as recipe_description,
                    r.image_url as recipe_image_url, r.cook_time as recipe_cook_time,
                    r.allergens as recipe_allergens, r.macros as recipe_macros
             FROM bundle_contents bc
             JOIN recipes r ON bc.recipe_id = r.id
             WHERE bc.bundle_id IN(${Prisma.join(bundleIds)})
             ORDER BY bc.position ASC NULLS LAST
        `;
    }

    const formattedBundles = bundles.map(b => ({
        ...b,
        price: Number(b.price),
        stock_on_hand: Number(b.stock_on_hand),
        items: bundleItems.filter(i => i.bundle_id === b.id).map(i => ({
            ...i,
            quantity: Number(i.quantity),
            recipe: {
                name: i.recipe_name,
                description: i.recipe_description,
                image_url: i.recipe_image_url,
                cook_time: i.recipe_cook_time,
                allergens: i.recipe_allergens,
                macros: i.recipe_macros
            }
        }))
    }));

    (business as any).bundles = formattedBundles;

    return { business, campaign, raised, progress };
}

export default async function FundraiserPage({ params }: { params: Promise<{ slug: string; fundraiserId: string }> }) {
    const { slug, fundraiserId } = await params;
    const data = await getData(slug, fundraiserId);

    if (!data) notFound();

    const { business, campaign, raised, progress } = data;

    return (
        <FundraiserClient
            business={business}
            campaign={campaign}
            raised={raised}
            progress={progress}
            slug={slug}
            fundraiserId={fundraiserId}
        />
    );
}
