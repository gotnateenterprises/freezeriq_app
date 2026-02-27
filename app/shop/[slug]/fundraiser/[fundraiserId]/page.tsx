import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Share2, Heart, ShoppingBag, ArrowLeft, Thermometer, Info, ChevronRight } from 'lucide-react';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import FundraiserClient from './FundraiserClient';
import PurchaseSidebar from '@/components/shop/PurchaseSidebar';

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
        SELECT fc.*, c.name as organization_name 
        FROM fundraiser_campaigns fc
        JOIN customers c ON fc.customer_id = c.id
        WHERE fc.id = ${fundraiserId} 
        LIMIT 1
    `;
    const campaign = campaigns[0];

    if (!campaign) return null;

    // Convert Prisma Decimals to standard Numbers for Client Component serialization
    if (campaign.goal_amount) campaign.goal_amount = Number(campaign.goal_amount);
    if (campaign.total_sales) campaign.total_sales = Number(campaign.total_sales);

    // 4. Fetch Orders for goal calculation
    const orders: any[] = await prisma.$queryRaw`
        SELECT total_amount FROM orders WHERE campaign_id = ${fundraiserId}
    `;

    // Calculate total raised
    const raised = orders.reduce((sum: number, order: any) => sum + Number(order.total_amount), 0);
    const progress = campaign.goal_amount ? Math.min((raised / Number(campaign.goal_amount)) * 100, 100) : 0;

    // 5. Fetch Bundles
    // First, try to get bundles explicitly linked to this campaign via the many-to-many relationship
    let bundles: any[] = await prisma.$queryRaw`
        SELECT b.* 
        FROM bundles b
        JOIN "_BundleToFundraiserCampaign" bfc ON b.id = bfc."A"
        WHERE bfc."B" = ${fundraiserId}
        AND b.is_active = true
    `;

    // Fallback for backwards compatibility: If no bundles are explicitly linked, fetch all active bundles for the business
    if (!bundles || bundles.length === 0) {
        bundles = await prisma.$queryRaw`
            SELECT * FROM bundles 
            WHERE business_id = ${business.id} 
            AND is_active = true
        `;
    }

    const bundleIds = bundles.map((b: any) => b.id);
    let bundleItems: any[] = [];

    if (bundleIds.length > 0) {
        bundleItems = await prisma.$queryRaw`
             SELECT bc.*, r.name as recipe_name
             FROM bundle_contents bc
             JOIN recipes r ON bc.recipe_id = r.id
             WHERE bc.bundle_id IN(${Prisma.join(bundleIds)})
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
                image_url: i.recipe_image_url,
                description: i.recipe_description,
                macros: i.recipe_macros,
                allergens: i.recipe_allergens,
                cook_time: i.recipe_cook_time
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
    // @ts-ignore
    const primaryColor = business.branding?.primary_color || '#4f46e5';

    // Format currency
    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
        }).format(amount);
    };

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
