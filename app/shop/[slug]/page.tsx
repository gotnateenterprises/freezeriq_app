import { Metadata } from 'next';
import StorefrontClient from './StorefrontClient';

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
        const title = `${business.branding.business_name} | Powered by FreezerIQ`;
        const description = business.branding.tagline || `Order delicious, home-cooked freezer meals from ${business.branding.business_name}.`;

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

export default function StorefrontPage() {
    return <StorefrontClient />;
}
