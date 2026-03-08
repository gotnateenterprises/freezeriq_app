import NextAuth from 'next-auth';
import { authConfig } from './auth.config';
import { NextResponse } from 'next/server';

const { auth } = NextAuth(authConfig);

export default auth((req) => {
    const url = req.nextUrl;

    // Get hostname of request (e.g. demo.vercel.pub, demo.localhost:3000)
    let hostname = req.headers
        .get('host')

    if (!hostname) {
        return NextResponse.next();
    }

    hostname = hostname.replace('.localhost:3000', `.${process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000'}`);

    // special case for Vercel preview deployment URLs
    if (
        hostname.includes('---') &&
        hostname.endsWith(`.${process.env.NEXT_PUBLIC_VERCEL_DEPLOYMENT_SUFFIX}`)
    ) {
        hostname = `${hostname.split('---')[0]}.${process.env.NEXT_PUBLIC_ROOT_DOMAIN}`;
    }

    const searchParams = req.nextUrl.searchParams.toString();
    const path = `${url.pathname}${searchParams.length > 0 ? `?${searchParams}` : ''}`;

    // Standardize localhost for testing and handle `www.` stripping for production
    const isLocalhost = hostname === 'localhost:3000';
    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'freezeriq.com';
    const isRootDomain = hostname === rootDomain || hostname === `www.${rootDomain}`;

    // rewrites for app pages
    if (isLocalhost || isRootDomain || hostname.includes('freezeriq.com') || hostname.includes('vercel.app')) {
        return NextResponse.next();
    }

    // rewrite everything else to `/[domain]/[slug] dynamic route
    return NextResponse.rewrite(new URL(`/${hostname}${path}`, req.url));
});

export const config = {
    matcher: ['/((?!api/|_next/|_static/|_vercel|[\\w-]+\\.\\w+).*)'],
};
