import { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
    const baseUrl = 'https://freezeriq.com'; // Production URL

    return {
        rules: {
            userAgent: '*',
            allow: ['/', '/shop/*'],
            disallow: ['/admin/', '/coordinator/', '/api/'],
        },
        sitemap: `${baseUrl}/sitemap.xml`,
    };
}
