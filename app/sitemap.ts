import { MetadataRoute } from 'next';
import { prisma } from '@/lib/db';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const baseUrl = 'https://freezeriq.com';

    // 1. Static Routes
    const routes = [
        '',
        '/start-a-business' // Upcoming
    ].map((route) => ({
        url: `${baseUrl}${route}`,
        lastModified: new Date(),
        changeFrequency: 'monthly' as const,
        priority: 1,
    }));

    // 2. Dynamic Shop Routes
    // Fetch only businesses that are not 'canceled' or 'unpaid'
    const businesses = await prisma.business.findMany({
        where: {
            subscription_status: {
                notIn: ['canceled', 'unpaid']
            }
        },
        select: {
            slug: true,
            created_at: true,
        }
    });

    const shopRoutes = businesses.map((business) => ({
        url: `${baseUrl}/shop/${business.slug}`,
        lastModified: business.created_at,
        changeFrequency: 'weekly' as const,
        priority: 0.8,
    }));

    return [...routes, ...shopRoutes];
}
