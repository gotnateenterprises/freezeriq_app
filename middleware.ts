import NextAuth from 'next-auth';
import { authConfig } from './auth.config';
import { NextResponse } from 'next/server';

const { auth } = NextAuth(authConfig);

export default async function middleware(req: any) {
    const url = req.nextUrl;
    let hostname = req.headers.get('host');

    if (!hostname) {
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
    const isLocalhost = hostname === 'localhost:3000';
    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'freezeriq.com';
    const isRootDomain = hostname === rootDomain || hostname === `www.${rootDomain}`;

    if (isLocalhost || isRootDomain || hostname.includes('freezeriq.com') || hostname.includes('vercel.app')) {
        // Run auth middleware manually since we need it for platform pages
        const authResult = await auth(req as any);
        return authResult || NextResponse.next();
    }

    // Prevent trailing slash redirects from exposing the internal domain folder structure
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
        const cleanPath = url.pathname.slice(0, -1);
        return NextResponse.redirect(new URL(`${cleanPath}${searchParams.length > 0 ? `?${searchParams}` : ''}`, req.url), 308);
    }

    // Rewrite custom domain requests directly without NextAuth interference
    const finalPath = url.pathname === '/' ? '' : url.pathname;
    const finalSearch = searchParams.length > 0 ? `?${searchParams}` : '';

    return NextResponse.rewrite(new URL(`/${hostname}${finalPath}${finalSearch}`, req.url));
}

export const config = {
    matcher: ['/((?!api/|_next/|_static/|_vercel|[\\w-]+\\.\\w+).*)'],
};
