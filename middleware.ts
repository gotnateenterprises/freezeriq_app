import NextAuth from 'next-auth';
import { authConfig } from './auth.config';
import { NextResponse } from 'next/server';
import { isPlatformHost } from './lib/platformHosts';

const { auth } = NextAuth(authConfig);

export default async function middleware(req: any) {
    const url = req.nextUrl;
    let hostname = req.headers.get('host');

    if (!hostname) {
        return NextResponse.next();
    }

    // Bypass middleware for direct static asset requests like /images/ or /favicon.ico 
    // that might bypass the next.config matcher on the edge.
    if (url.pathname.startsWith('/images') || url.pathname.includes('.')) {
        return NextResponse.next();
    }

    hostname = hostname.replace('.localhost:3000', `.${process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000'}`);

    if (
        hostname.includes('---') &&
        hostname.endsWith(`.${process.env.NEXT_PUBLIC_VERCEL_DEPLOYMENT_SUFFIX}`)
    ) {
        hostname = `${hostname.split('---')[0]}.${process.env.NEXT_PUBLIC_ROOT_DOMAIN}`;
    }

    const searchParams = req.nextUrl.searchParams.toString();

    // DOMAIN-ROUTING-1: platform identity is an exact/suffix decision made in
    // one place. The former substring pair rejected the real SaaS domain
    // (`freezeriqapp.com` does not contain `freezeriq.com`) and accepted any
    // host that merely contained a trusted string.
    if (isPlatformHost(hostname, process.env.NEXT_PUBLIC_ROOT_DOMAIN)) {
        // Run auth middleware manually since we need it for platform pages
        const authResult = await auth(req as any);
        return authResult || NextResponse.next();
    }

    // Prevent trailing slash redirects from exposing the internal domain folder structure
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
        const cleanPath = url.pathname.slice(0, -1);
        return NextResponse.redirect(new URL(`${cleanPath}${searchParams.length > 0 ? `?${searchParams}` : ''}`, req.url), 308);
    }

    // Bypass rewrite for known root paths so they resolve to standard NextJS app/ folders
    if (url.pathname.startsWith('/shop/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/fundraiser/') || url.pathname.startsWith('/login') || url.pathname.startsWith('/dashboard')) {
        const authResult = await auth(req as any);
        return authResult || NextResponse.next();
    }

    // Rewrite custom domain requests directly without NextAuth interference
    const finalPath = url.pathname === '/' ? '' : url.pathname;
    const finalSearch = searchParams.length > 0 ? `?${searchParams}` : '';

    return NextResponse.rewrite(new URL(`/${hostname}${finalPath}${finalSearch}`, req.url));
}

export const config = {
    matcher: ['/((?!api/|_next/|_static/|_vercel|[\\w-]+\\.\\w+).*)'],
};
