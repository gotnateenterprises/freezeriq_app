import { Metadata } from 'next';
import StorefrontClient from '../shop/[slug]/StorefrontClient';
import { prisma } from '@/lib/db';
import { notFound } from 'next/navigation';

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }): Promise<Metadata> {
    const { domain } = await params;

    // Attempt to decode the domain just in case
    const decodedDomain = decodeURIComponent(domain);

    const business = await prisma.business.findFirst({
        where: { custom_domain: decodedDomain } as any
    });

    if (!business) {
        return { title: 'Not Found | FreezerIQ' };
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

    const business = await prisma.business.findFirst({
        where: { custom_domain: decodedDomain } as any
    });

    if (!business) {
        notFound();
    }

    return <StorefrontClient overrideSlug={business.slug} />;
}
