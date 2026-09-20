
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
                // ONE effective Cache-Control header, always — never two, never a contradiction.
                //
                // WHICH LAYER WINS DEPENDS ON THE PLATFORM, so do not rely on one of them alone. This
                // was measured, not assumed, on Next.js 16.1.1:
                //   - On Vercel (where this ships), a route handler that sets its own Cache-Control
                //     OVERRIDES the value below for that response. The handler wins.
                //   - Locally under `next start`, the opposite happened: the config value won.
                // Neither platform ever appended a second header; only the winner differs.
                //
                // Because the winner is not stable across platforms, the 14 route-level Cache-Control
                // literals under app/api (app/api/integrations/quickbooks/*, app/api/auth/qbo*,
                // app/api/integrations/square, app/api/customers/[id]/tax-document) are DELIBERATELY
                // ALIGNED to the exact string below. Whichever layer wins, the client sees the same
                // policy. Keep them aligned: tests/secIntuitAttest1.test.ts sweeps every route file and
                // fails if any explicit Cache-Control under app/api differs from this value by one
                // character.
                //
                // Pragma is never set by a handler, so it always comes from here.
                //
                // Scoped to /api/* on purpose: pages and static assets keep their existing caching.
                // Verified unchanged on the deployed candidate — /login still returns its own
                // `private, no-cache, no-store, max-age=0, must-revalidate`, and /legal/disconnect still
                // returns exactly what it returned before this policy existed.
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
