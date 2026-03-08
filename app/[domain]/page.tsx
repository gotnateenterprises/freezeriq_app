import { Metadata } from 'next';
import StorefrontClient from '../shop/[slug]/StorefrontClient';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }): Promise<Metadata> {
    const { domain } = await params;

    const decodedDomain = decodeURIComponent(domain);

    // Multi-Tenant Custom Domain Routing
    // Check if the domain has a www. prefix and get the root domain as well
    const isWww = decodedDomain.startsWith('www.');
    const rootDomainString = isWww ? decodedDomain.replace('www.', '') : decodedDomain;
    const wwwDomainString = isWww ? decodedDomain : `www.${decodedDomain}`;

    // Query database for any matching custom domains
    let business = await prisma.business.findFirst({
        where: {
            OR: [
                { custom_domain: decodedDomain },
                { custom_domain: rootDomainString },
                { custom_domain: wwwDomainString }
            ]
        }
    });

    // Hardcoded fallback for the founding tenant during launch
    if (!business && (decodedDomain.includes('myfreezerchef.com'))) {
        business = await prisma.business.findFirst({
            where: { slug: 'my-freezer-chef' }
        });
    }

    if (!business) {
        return { title: 'FreezerIQ' };
    }

    const brandingRecords: any[] = await prisma.$queryRaw`
        SELECT b.* 
        FROM tenant_branding b
        JOIN users u ON b.user_id = u.id
        WHERE u.business_id = ${business.id}
        LIMIT 1
    `;

    const branding = brandingRecords[0];
    const title = branding ? `${branding.business_name} | Powered by FreezerIQ` : `${business.name} | Powered by FreezerIQ`;
    return { title, description: branding?.tagline || '' };
}

export default async function CustomDomainPage({ params }: { params: Promise<{ domain: string }> }) {
    const { domain } = await params;
    const decodedDomain = decodeURIComponent(domain);

    const isWww = decodedDomain.startsWith('www.');
    const rootDomainString = isWww ? decodedDomain.replace('www.', '') : decodedDomain;
    const wwwDomainString = isWww ? decodedDomain : `www.${decodedDomain}`;

    let business = await prisma.business.findFirst({
        where: {
            OR: [
                { custom_domain: decodedDomain },
                { custom_domain: rootDomainString },
                { custom_domain: wwwDomainString }
            ]
        }
    });

    if (!business && (decodedDomain.includes('myfreezerchef.com'))) {
        business = await prisma.business.findFirst({
            where: { slug: 'my-freezer-chef' }
        });
    }

    if (!business) {
        // We'll redirect to the main login or dashboard instead of 404ing the whole app
        // since [domain] acts as a catch-all on the root depending on middleware.
        // For now, let's just render the default storefront if possible or 404.
        notFound();
    }

    return <StorefrontClient overrideSlug={business.slug} />;
}
