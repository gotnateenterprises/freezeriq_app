import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { findBusinessBySlug } from '@/lib/publicIdentity';
import { customerFacingBusinessName } from '@/lib/tenantBrand';
import {
    buildSampleCampaign,
    SAMPLE_BUNDLE_PROGRESS,
    SAMPLE_FUNDRAISER_ID,
    SAMPLE_ORDER_MODE,
} from '@/lib/sampleFundraiser';
import FundraiserClient from '../../fundraiser/[fundraiserId]/FundraiserClient';

/**
 * RAISE-FUNDS-MARKETING-1 — "See a sample ordering page".
 *
 * Shows a prospective organizer what THEIR supporters will see, by rendering
 * the REAL supporter component (FundraiserClient) so the demo can never drift
 * visually from the live experience.
 *
 * REAL tenant data: name, logo, brand color, and the current public bundle
 * lineup (names, photos, prices, recipes) — read exactly the way the real
 * supporter page reads them for a campaign in 'legacy' mode.
 *
 * FAKE fundraiser data: the organization, title, goal/progress, dates and
 * pickup details all come from lib/sampleFundraiser.ts. No real campaign,
 * organization, customer, or order is read, so this works for every tenant
 * whether or not it has ever run a fundraiser.
 *
 * READ-ONLY: this file performs no writes. FundraiserClient receives
 * sampleMode, whose first effect is an early return at the top of submitOrder
 * — before the submission key and before fetch('/api/public/order') — so the
 * demo cannot create an order, customer, CRM lead, email, or payment.
 */

type SampleBusiness = {
    id: string;
    name: string;
    display_name: string | null;
    slug: string;
    logo_url: string | null;
};

async function loadTenant(slug: string) {
    const business = await findBusinessBySlug<SampleBusiness>(prisma, slug, {
        id: true, name: true, display_name: true, slug: true, logo_url: true,
    });
    if (!business) return null;

    // Same branding read and defaults as the real supporter page.
    const brandingRecords: any[] = await prisma.$queryRaw`
        SELECT b.*
        FROM tenant_branding b
        JOIN users u ON b.user_id = u.id
        WHERE u.business_id = ${business.id}
        AND u.role = 'ADMIN'
        LIMIT 1
    `;
    const branding = brandingRecords[0] || {
        business_name: business.name,
        primary_color: '#4f46e5',
        secondary_color: '#818cf8',
        tagline: '',
        logo_url: business.logo_url,
    };

    // Same lineup as the real supporter page's 'legacy' branch: this tenant's
    // active, storefront-visible bundles, with their recipes.
    const bundles: any[] = await prisma.$queryRaw`
        SELECT * FROM bundles
        WHERE business_id = ${business.id}
        AND is_active = true
        AND show_on_storefront = true
        ORDER BY name ASC
    `;
    const bundleIds = bundles.map((b) => b.id);
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
    const formattedBundles = bundles.map((b) => ({
        ...b,
        price: Number(b.price),
        stock_on_hand: Number(b.stock_on_hand),
        items: bundleItems.filter((i) => i.bundle_id === b.id).map((i) => ({
            ...i,
            quantity: Number(i.quantity),
            recipe: {
                name: i.recipe_name,
                description: i.recipe_description,
                image_url: i.recipe_image_url,
                cook_time: i.recipe_cook_time,
                allergens: i.recipe_allergens,
                macros: i.recipe_macros,
            },
        })),
    }));

    // Plain objects only across the Server→Client boundary, as the real page does.
    return JSON.parse(JSON.stringify({ ...business, branding, bundles: formattedBundles }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const { slug } = await params;
    const business = await findBusinessBySlug<SampleBusiness>(prisma, slug, {
        id: true, name: true, display_name: true, slug: true, logo_url: true,
    });
    if (!business) return { title: 'Fundraiser Not Found', robots: { index: false, follow: false } };
    return {
        title: `Sample fundraiser ordering page | ${customerFacingBusinessName(business)}`,
        // A demo, not a real fundraiser: keep it out of search results.
        robots: { index: false, follow: false },
    };
}

export default async function SampleFundraiserPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const business = await loadTenant(slug);
    if (!business) notFound();

    const tenantName = customerFacingBusinessName(business);

    return (
        <div style={{ background: '#faf5ef' }}>
            <div style={{ maxWidth: '36rem', margin: '0 auto', paddingBottom: '.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.75rem', flexWrap: 'wrap', background: '#fdf3ee', border: '1px solid #eee2d6', borderRadius: 14, padding: '.6rem .85rem', fontSize: '.74rem', color: '#7a6258' }}>
                    <span>
                        <b style={{ color: '#3b2a2f' }}>Sample fundraiser ordering page.</b>{' '}
                        This is an example of what your supporters will see.
                    </span>
                    <Link href={`/shop/${slug}/raise-funds`} style={{ fontWeight: 800, color: '#3b2a2f', whiteSpace: 'nowrap' }}>
                        ← Back to {tenantName} Fundraisers
                    </Link>
                </div>
            </div>
            <FundraiserClient
                business={business}
                campaign={buildSampleCampaign()}
                bundleProgress={SAMPLE_BUNDLE_PROGRESS}
                orderMode={SAMPLE_ORDER_MODE}
                slug={slug}
                fundraiserId={SAMPLE_FUNDRAISER_ID}
                sampleMode
            />
        </div>
    );
}
