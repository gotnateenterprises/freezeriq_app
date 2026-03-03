
import type { NextAuthConfig } from 'next-auth';

export const authConfig = {
    pages: {
        signIn: '/login',
    },
    callbacks: {
        async jwt({ token, user, trigger, session }) {
            if (user) {
                token.role = user.role;
                token.permissions = user.permissions;
                token.businessId = (user as any).businessId; // Store business in token

                // SaaS Fields
                token.plan = (user as any).plan;
                token.subscriptionStatus = (user as any).subscriptionStatus;
                token.isSuperAdmin = (user as any).isSuperAdmin;
                token.businessLogo = (user as any).businessLogo;
                token.businessName = (user as any).businessName;
            }

            // Handle session updates (e.g., Tenant Switcher)
            if (trigger === 'update' && session?.businessId) {
                token.businessId = session.businessId;
                if (session.businessName) token.businessName = session.businessName;
                if (session.plan) token.plan = session.plan;
            }

            return token;
        },
        async session({ session, token }) {
            if (token && session.user) {
                session.user.id = token.sub as string;
                session.user.role = token.role;
                session.user.permissions = token.permissions;
                (session.user as any).businessId = token.businessId; // Expose business in session

                // SaaS Fields
                (session.user as any).plan = token.plan;
                (session.user as any).subscriptionStatus = token.subscriptionStatus;

                // CRITICAL FIX: Ensure isSuperAdmin is passed even if user object isn't present
                (session.user as any).isSuperAdmin = token.isSuperAdmin;

                (session.user as any).businessLogo = token.businessLogo as string;
                (session.user as any).businessName = token.businessName as string;
            }
            return session;
        },
        authorized({ auth, request: { nextUrl } }) {
            const isLoggedIn = !!auth?.user;
            const isOnDashboard = nextUrl.pathname.startsWith('/dashboard') ||
                nextUrl.pathname.startsWith('/orders') ||
                nextUrl.pathname.startsWith('/settings') ||
                nextUrl.pathname.startsWith('/admin') ||
                nextUrl.pathname.startsWith('/recipes') ||
                nextUrl.pathname.startsWith('/commercial') ||
                nextUrl.pathname.startsWith('/customers') ||
                nextUrl.pathname.startsWith('/campaigns') ||
                nextUrl.pathname.startsWith('/calendar') ||
                nextUrl.pathname.startsWith('/labels') ||
                nextUrl.pathname.startsWith('/suppliers') ||
                nextUrl.pathname.startsWith('/training');

            if (isOnDashboard) {
                if (isLoggedIn) return true;
                return false; // Redirect unauthenticated users to login page
            } else if (isLoggedIn && nextUrl.pathname === '/login') {
                return Response.redirect(new URL('/dashboard', nextUrl)); // Redirect to dashboard if already logged in
            }
            return true;
        },
    },
    providers: [], // Add providers with an empty array for now
} satisfies NextAuthConfig;
