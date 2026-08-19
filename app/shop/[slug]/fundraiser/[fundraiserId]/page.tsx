import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import FundraiserClient from './FundraiserClient';
import { computeFundraiserProgress } from '@/lib/fundraiserMetrics';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import { toPublicCampaign } from '@/lib/publicFundraiserPayload';
import type { Metadata } from 'next';

// ── OG Metadata (controls the Facebook/Twitter link preview) ───────────
// FR-LAUNCH-1B share polish: campaign-specific title/description, canonical
// public fundraiser URL, and the best available existing public image.
// Site URL follows the repo's authoritative pattern (NEXT_PUBLIC_BASE_URL, as
// used by the auth callback routes) → Vercel deployment URL → omit
// canonical/URL/image fields when no reliable absolute base exists.
// No domain is hardcoded and no localhost URL is ever emitted explicitly.
export async function generateMetadata({ params }: { params: Promise<{ slug: string; fundraiserId: string }> }): Promise<Metadata> {
    const { slug, fundraiserId } = await params;

    const business = await prisma.business.findUnique({
        where: { slug },
        select: { id: true, name: true, logo_url: true },
    });

    if (!business) return { title: 'Fundraiser Not Found' };

    // Tenant branding (display name + shareable logo)
    const brandingRecords: any[] = await prisma.$queryRaw`
        SELECT b.business_name, b.logo_url FROM tenant_branding b
        JOIN users u ON b.user_id = u.id
        WHERE u.business_id = ${business.id} AND u.role = 'ADMIN'
        LIMIT 1
    `;
    const tenantName = brandingRecords[0]?.business_name
        && brandingRecords[0].business_name !== 'FreezerIQ'
        && brandingRecords[0].business_name !== 'Freezer IQ'
        ? brandingRecords[0].business_name
        : business.name || 'Freezer Chef';

    // Campaign org name — TENANT-SCOPED. The campaign must belong to the business
    // resolved from the slug, so a mismatched slug/fundraiserId URL can never leak
    // another tenant's organization name, title, description, or image. A campaign
    // owned by a different tenant is indistinguishable from one that doesn't exist.
    const campaigns: any[] = await prisma.$queryRaw`
        SELECT fc.id, fc.name, c.name as organization_name
        FROM fundraiser_campaigns fc
        JOIN customers c ON fc.customer_id = c.id
        WHERE fc.id = ${fundraiserId} AND c.business_id = ${business.id}
        LIMIT 1
    `;
    const campaign = campaigns[0];
    if (!campaign) return { title: 'Fundraiser Not Found' };
    const orgName = campaign.organization_name || 'Fundraiser';

    // Best existing public image, in the required preference order:
    // 1. a campaign-selected bundle photo (campaign-specific public image)
    // 2. tenant branding logo   3. business logo   4. public FreezerIQ fallback.
    // The bundle query is keyed on the tenant-owned campaign id and additionally
    // requires the campaign's customer AND the bundle to belong to this business.
    let ogImage: string = '/freezer-chef-logo.png';
    let ogImageIsPhoto = false;
    const bundleImages: any[] = await prisma.$queryRaw`
        SELECT bu.image_url
        FROM campaign_bundles cb
        JOIN bundles bu ON cb.bundle_id = bu.id
        JOIN fundraiser_campaigns fc ON cb.campaign_id = fc.id
        JOIN customers c ON fc.customer_id = c.id
        WHERE cb.campaign_id = ${campaign.id}
          AND c.business_id = ${business.id}
          AND bu.business_id = ${business.id}
          AND cb.state = 'active'
          AND bu.image_url IS NOT NULL
        LIMIT 1
    `;
    if (bundleImages[0]?.image_url) {
        ogImage = bundleImages[0].image_url;
        ogImageIsPhoto = true;
    } else if (brandingRecords[0]?.logo_url) {
        ogImage = brandingRecords[0].logo_url;
    } else if (business.logo_url) {
        ogImage = business.logo_url;
    }

    // Base URL follows the repo's existing convention (NEXT_PUBLIC_BASE_URL, as used
    // by the auth callback routes) → VERCEL_URL → none. Trailing slashes are stripped
    // so paths can never compose as "https://example.com//shop/...". No production
    // domain is hardcoded.
    const rawSiteUrl = process.env.NEXT_PUBLIC_BASE_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    const siteUrl = rawSiteUrl ? rawSiteUrl.replace(/\/+$/, '') : null;
    const canonicalUrl = siteUrl ? `${siteUrl}/shop/${slug}/fundraiser/${fundraiserId}` : null;
    const absoluteOgImage = ogImage.startsWith('http')
        ? ogImage
        : (siteUrl ? `${siteUrl}${ogImage.startsWith('/') ? '' : '/'}${ogImage}` : null);

    const title = `Support ${orgName} | ${tenantName}`;
    const description = `Help ${orgName} reach its bundle goal. Choose freezer meal bundles, support the fundraiser, and pay the coordinator directly.`;

    // The app defines no metadataBase, so a relative URL cannot be resolved into the
    // absolute form these fields require. When no base URL is configured (local dev),
    // title/description are still emitted but canonical/url/images are omitted rather
    // than emitting a relative or falsely production-looking value.
    return {
        title,
        description,
        ...(canonicalUrl ? { alternates: { canonical: canonicalUrl } } : {}),
        openGraph: {
            title,
            description,
            ...(canonicalUrl ? { url: canonicalUrl } : {}),
            siteName: tenantName,
            type: 'website',
            ...(absoluteOgImage ? { images: [{ url: absoluteOgImage }] } : {}),
        },
        twitter: {
            // summary_large_image only when the image is a real photo — a small
            // logo must not be claimed as a 1200×630 sharing image.
            card: ogImageIsPhoto ? 'summary_large_image' : 'summary',
            title,
            description,
            ...(absoluteOgImage ? { images: [absoluteOgImage] } : {}),
        },
    };
}
// We need to fetch data on the server
async function getData(slug: string, fundraiserId: string) {
    // 1. Fetch Business
    const business = await prisma.business.findUnique({
        where: { slug },
        // FR-ORDERABILITY-1-R: timezone is the tenant's authoritative zone for
        // the supporter ordering deadline. It stays server-side — it is used to
        // compute orderMode and is never passed across the client boundary.
        select: { id: true, name: true, slug: true, logo_url: true, timezone: true }
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

    // 3. Fetch Campaign — EXPLICIT COLUMN ALLOWLIST, TENANT-SCOPED.
    //
    // FR-FLOW-1: this previously read `SELECT fc.*` and was not scoped to the
    // business resolved from the slug. Two consequences, both fixed here:
    //
    //   1. `fc.*` returned every campaign column — including `portal_token`,
    //      the coordinator's ONLY credential for the private setup/portal page,
    //      plus settlement_total, org_share_percent, checks_payable, closed_by
    //      and the other tenant-internal fields. The whole row was then handed
    //      to a Client Component, so it was serialized into the RSC payload
    //      embedded in the public HTML of a page anyone can load.
    //   2. Without `c.business_id`, a campaign id belonging to Tenant A rendered
    //      under Tenant B's storefront slug.
    //
    // The generateMetadata() query above already did both correctly; this is the
    // same predicate. A campaign owned by another tenant is indistinguishable
    // from one that does not exist (both fall through to notFound()).
    //
    // Columns below are split into two groups: those the supporter page renders,
    // and those consumed SERVER-SIDE ONLY (order-mode resolution and progress).
    // The server-only group is stripped before the client boundary — see the
    // publicCampaign projection near the end of this function.
    const campaigns: any[] = await prisma.$queryRaw`
        SELECT fc.id, fc.name, fc.about_text, fc.participant_label,
               fc.end_date, fc.delivery_date, fc.pickup_location,
               fc.payment_instructions, fc.external_payment_link,
               fc.bundle_goal, fc.total_sales,
               fc.status, fc.closed_at,
               fc.bundle_selection_status, fc.bundle_selection_limit,
               c.name as organization_name,
               c.fundraiser_info as customer_fundraiser_info
        FROM fundraiser_campaigns fc
        JOIN customers c ON fc.customer_id = c.id
        WHERE fc.id = ${fundraiserId} AND c.business_id = ${business.id}
        LIMIT 1
    `;
    const campaign = campaigns[0];

    if (!campaign) return null;

    // 4. Fetch Orders with items for weighted bundle progress.
    // FR-LAUNCH-1C-1: canceled orders must never count toward public progress
    // (cancellation is the soft canceled_at timestamp, not an OrderStatus).
    const orders: any[] = await prisma.$queryRaw`
        SELECT o.id, o.total_amount FROM orders o
        WHERE o.campaign_id = ${fundraiserId} AND o.canceled_at IS NULL
    `;
    const orderIds = orders.map((o: any) => o.id);

    let orderItems: any[] = [];
    if (orderIds.length > 0) {
        orderItems = await prisma.$queryRaw`
            SELECT oi.order_id, oi.quantity, oi.variant_size,
                   b.serving_tier
            FROM order_items oi
            LEFT JOIN bundles b ON oi.bundle_id = b.id
            WHERE oi.order_id IN(${Prisma.join(orderIds)})
        `;
    }

    // Group items by order for the shared metric utility
    const ordersWithItems = orders.map((o: any) => ({
        total_amount: o.total_amount,
        items: orderItems
            .filter((oi: any) => oi.order_id === o.id)
            .map((oi: any) => ({
                quantity: Number(oi.quantity) || 0,
                variant_size: oi.variant_size,
                serving_tier: oi.serving_tier,
            })),
    }));

    // Use the shared weighted-bundle utility (single source of truth)
    const bundleProgress = computeFundraiserProgress(
        campaign.bundle_goal,
        campaign.total_sales,
        ordersWithItems
    );

    // 5. Fetch Bundles based on the authoritative orderMode

    // Supporter-facing, so the ordering deadline applies: pass the tenant's
    // durable timezone so the final day is evaluated in the tenant's calendar.
    const orderMode = await resolveCampaignOrderMode(campaign, business.id, business.timezone);

    // 6. Fetch Bundles based on the authoritative orderMode
    let bundles: any[] = [];
    if (orderMode.mode === 'legacy') {
        bundles = await prisma.$queryRaw`
            SELECT * FROM bundles 
            WHERE business_id = ${business.id} 
            AND is_active = true
            AND show_on_storefront = true
            ORDER BY name ASC
        `;
    } else if (orderMode.mode === 'selected' && orderMode.activeOrderableBundleIds.length > 0) {
        bundles = await prisma.$queryRaw`
            SELECT * FROM bundles
            WHERE id IN(${Prisma.join(orderMode.activeOrderableBundleIds)})
            AND business_id = ${business.id}
            AND is_active = true
            ORDER BY array_position(${orderMode.activeOrderableBundleIds}::text[], id::text)
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

    // FR-FLOW-1: PUBLIC PROJECTION — the second half of the allowlist.
    //
    // The query above still selects a few tenant-internal columns because the
    // server needs them (status/closed_at/bundle_selection_* drive
    // resolveCampaignOrderMode; bundle_goal/total_sales drive progress). None of
    // them may cross to the Client Component, because anything passed to a
    // Client Component is serialized into the public HTML.
    //
    // The allowlist itself lives in lib/publicFundraiserPayload.ts so the
    // boundary is unit-testable. It is an explicit include-list, not a
    // delete-list: a column added to the query later cannot leak by being
    // forgotten here. It also narrows customer_fundraiser_info, a free-form org
    // JSON blob that carries internal keys such as checks_payable_to.
    const publicCampaign = toPublicCampaign(campaign);

    // Serialize the full return value to plain objects before the Server→Client boundary.
    // $queryRaw returns TIMESTAMP(3) columns as Date objects and any DECIMAL columns as
    // strings/numbers — all of which must be plain primitives before being passed to a
    // Client Component (Next.js "Only plain objects" constraint).
    // JSON.stringify converts Date → ISO string; JSON.parse produces a plain object.
    // This is the same approach as safeJSON() in /api/campaigns/route.ts.
    return JSON.parse(JSON.stringify({ business, campaign: publicCampaign, bundleProgress, orderMode }));

}

export default async function FundraiserPage({ params }: { params: Promise<{ slug: string; fundraiserId: string }> }) {
    const { slug, fundraiserId } = await params;
    const data = await getData(slug, fundraiserId);

    if (!data) notFound();

    const { business, campaign, bundleProgress, orderMode } = data;

    return (
        <FundraiserClient
            business={business}
            campaign={campaign}
            bundleProgress={bundleProgress}
            orderMode={orderMode}
            slug={slug}
            fundraiserId={fundraiserId}
        />
    );
}
