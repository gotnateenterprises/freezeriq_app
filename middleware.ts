
import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

const { auth } = NextAuth(authConfig);

export default auth((req) => {
    const url = req.nextUrl;
    // Get hostname (e.g., 'freezeriq.com', 'myfreezerchef.com', 'localhost:3000')
    const hostname = req.headers.get("host") || "";

    // Define what constitutes our core SaaS platform
    const isLocalhost = hostname.includes("localhost");
    const isVercel = hostname.includes("vercel.app");
    const isSaaSApp = hostname === "freezeriq.com" || hostname === "www.freezeriq.com" || isLocalhost || isVercel;

    // For local testing, we can simulate custom domains by using local subdomains
    // But for now, localhost resolves as the SaaS app.

    // We want to skip middleware for API routes, Next internal files, public assets
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/_next') || url.pathname.match(/\.(.*)$/)) {
        return NextResponse.next();
    }

    // 1. Core SaaS Marketing Page
    if (isSaaSApp && url.pathname === "/") {
        // Rewrite the root to the /home folder where the marketing landing page lives
        return NextResponse.rewrite(new URL("/home", req.url));
    }

    // 2. Tenant Shop Custom Domain Routing (e.g. myfreezerchef.com)
    if (!isSaaSApp) {
        // This is a custom domain hit!
        // We rewrite the request to a hidden folder `/[domain]` where Next.js will 
        // dynamically query the DB for the business with this custom_domain.
        return NextResponse.rewrite(new URL(`/${hostname}${url.pathname}`, req.url));
    }

    // Allow NextAuth to naturally protect all other routes like /dashboard, /inventory, etc.
    return NextResponse.next();
});

export const config = {
    matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
