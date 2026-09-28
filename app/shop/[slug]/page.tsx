import { Metadata } from 'next';
import StorefrontClient from './StorefrontClient';
import { getCustomerSession } from '@/lib/customerAuth';
import { prisma } from '@/lib/db';
import { findBusinessBySlug } from '@/lib/publicIdentity';
import { customerFacingBusinessName } from '@/lib/tenantBrand';

/** The columns generateMetadata needs — nothing the page body already owns. */
interface StorefrontMetadataBusiness {
    id: string;
    name: string;
    display_name: string | null;
    logo_url: string | null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const { slug } = await params;

    // PREVIEW-METADATA-ISOLATION-1: resolve the tenant and its branding
    // DIRECTLY from this deployment's own database — never by fetching this
    // application's OWN public API over HTTP. The self-fetch this replaced
    // (`fetch(NEXT_PUBLIC_APP_URL + '/api/public/tenant/' + slug)`) hit
    // PRODUCTION's live API from every environment, because NEXT_PUBLIC_APP_URL
    // is one value shared by Production, Preview and local dev — so a Preview
    // deployment rendered a REAL tenant's name and branding in its <title> and
    // OpenGraph tags even when that tenant does not exist in the Preview
    // database. The storefront BODY was never affected: StorefrontClient below
    // fetches the RELATIVE path '/api/public/tenant/<slug>', which the browser
    // resolves against whichever origin actually served the page.
    //
    // Same shape already used by the two sibling storefront metadata
    // functions — app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx and
    // app/[domain]/page.tsx — neither of which ever had this defect.
    try {
        // FR-PUBLIC-IDENTITY-1: the SAME literal-slug helper the page component
        // below uses, so metadata and body can never resolve two different
        // tenants for one URL.
        const business = await findBusinessBySlug<StorefrontMetadataBusiness>(prisma, slug, {
            id: true, name: true, display_name: true, logo_url: true,
        });

        if (!business) {
            return {
                title: 'Shop Not Found | FreezerIQ',
                description: 'The requested storefront could not be found.'
            };
        }

        // Same "last edit wins" branding lookup as
        // app/api/public/tenant/[slug]/route.ts (the route StorefrontClient
        // fetches) and the sibling metadata functions above — an inline query
        // per page is the existing convention here, not a shared helper.
        const brandingRecords: Array<{ tagline: string | null; logo_url: string | null }> = await prisma.$queryRaw`
            SELECT b.tagline, b.logo_url
            FROM tenant_branding b
            JOIN users u ON b.user_id = u.id
            WHERE u.business_id = ${business.id}
            AND u.role IN ('ADMIN', 'CHEF')
            ORDER BY b.updated_at DESC
            LIMIT 1
        `;
        // No row → the SAME defaults app/api/public/tenant/[slug]/route.ts uses.
        const branding = brandingRecords[0] || {
            tagline: 'Intelligence for your Kitchen.',
            logo_url: business.logo_url,
        };

        // TENANT-BRAND-AUTHORITY-2: the ONE customer-facing name authority —
        // never TenantBranding.business_name, whose schema default is the
        // literal 'Freezer Chef', which would misname every unconfigured tenant.
        const tenantName = customerFacingBusinessName(business);
        // Historical guard, preserved: a tenant whose own resolved name IS the
        // platform's name still gets the generic fallback, rather than
        // presenting the platform's name as if it were the tenant's brand.
        const finalName = (tenantName && tenantName !== 'FreezerIQ' && tenantName !== 'Freezer IQ') ? tenantName : 'Freezer Chef';

        const title = `${finalName} | Fresh Meals Delivered`;
        const description = branding.tagline || `Order delicious, home-cooked freezer meals from ${finalName}.`;

        return {
            title,
            description,
            openGraph: {
                title,
                description,
                type: 'website',
                images: branding.logo_url ? [branding.logo_url] : [],
            },
        };
    } catch (e) {
        return {
            title: 'FreezerIQ Storefront',
            description: 'Order fresh freezer meals online.'
        };
    }
}

export default async function StorefrontPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;

    // SF-2: authenticated returning detection. The existing customer session
    // carries businessId, so tenant ownership is PROVEN by comparing it to the
    // business resolved from this slug — a session from another tenant's shop
    // never counts as returning here. Only a boolean crosses to the client:
    // no email, customer id, token, or balance.
    let hasCustomerSession = false;
    try {
        const session = await getCustomerSession();
        if (session?.businessId) {
            // FR-PUBLIC-IDENTITY-1: literal slug.
            const business = await findBusinessBySlug(prisma, slug, { id: true });
            hasCustomerSession = Boolean(business && business.id === session.businessId);
        }
    } catch {
        hasCustomerSession = false;
    }

    return <StorefrontClient hasCustomerSession={hasCustomerSession} />;
}
