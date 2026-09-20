
/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'images.unsplash.com',
            },
        ],
    },
    experimental: {
    },
    typescript: {
        ignoreBuildErrors: true,
    },
    eslint: {
        ignoreDuringBuilds: true,
    },
    // Re-enable Turbopack or keep disabled as per stability preference
    async headers() {
        return [
            {
                source: '/(.*)',
                headers: [
                    {
                        key: 'X-Frame-Options',
                        value: 'DENY',
                    },
                    {
                        key: 'X-Content-Type-Options',
                        value: 'nosniff',
                    },
                    {
                        key: 'Referrer-Policy',
                        value: 'strict-origin-when-cross-origin',
                    }
                ],
            },
            {
                // Intuit security requirement (App Assessment, app server configuration): a response
                // carrying sensitive data must not be cacheable. Next.js's default for a dynamic route
                // is `public, max-age=0, must-revalidate` — the `public` token invites a shared cache to
                // store an authenticated response, so every /api/* response is pinned here instead.
                //
                // ONE effective policy, not two. Measured against a real `next build` + `next start` on
                // Next.js 16.1.1: a route that sets its own `Cache-Control: no-store` (every QuickBooks
                // route does) returns exactly ONE Cache-Control header, and it is the value below — the
                // config layer wins, it does not append a second header. Nothing is weakened by that:
                // `no-store, no-cache, must-revalidate` is a strict superset of a bare `no-store`, and
                // `no-store` already forbids storage by shared and private caches alike, so a route that
                // said `private, no-store, max-age=0` loses no protection either.
                //
                // Scoped to /api/* on purpose: pages and static assets keep their existing caching.
                // Verified unchanged by the same run — /login still returns its own
                // `private, no-cache, no-store, max-age=0, must-revalidate`, and a static page still
                // returns `s-maxage=31536000`.
                source: '/api/:path*',
                headers: [
                    {
                        key: 'Cache-Control',
                        value: 'no-store, no-cache, must-revalidate',
                    },
                    {
                        key: 'Pragma',
                        value: 'no-cache',
                    },
                ],
            },
        ];
    },
};

module.exports = nextConfig;
