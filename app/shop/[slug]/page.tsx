import { Metadata } from 'next';
import StorefrontClient from './StorefrontClient';
import { getCustomerSession } from '@/lib/customerAuth';
import { prisma } from '@/lib/db';
import { findBusinessBySlug } from '@/lib/publicIdentity';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
    const { slug } = await params;

    // Fetch data for metadata (cache-friendly in Next.js 13+)
    try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'https://freezeriq.com'}/api/public/tenant/${slug}`, { cache: 'no-store' });
        const data = await res.json();

        if (!data || !data.business) {
            return {
                title: 'Shop Not Found | FreezerIQ',
                description: 'The requested storefront could not be found.'
            };
        }

        const { business } = data;
        const bName = business.branding?.business_name;
        const finalName = (bName && bName !== 'FreezerIQ' && bName !== 'Freezer IQ') ? bName : 'Freezer Chef';

        const title = `${finalName} | Fresh Meals Delivered`;
        const description = business.branding?.tagline || `Order delicious, home-cooked freezer meals from ${finalName}.`;

        return {
            title,
            description,
            openGraph: {
                title,
                description,
                type: 'website',
                images: business.branding.logo_url ? [business.branding.logo_url] : [],
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
