
import type { NextAuthConfig } from 'next-auth';
import { applySessionUpdate, applySignIn } from '@/lib/auth/sessionUpdate';

export const authConfig = {
    pages: {
        signIn: '/login',
    },
    callbacks: {
        async jwt({ token, user, trigger, session }) {
            // Sign-in: authority is rebuilt from the database user, never from
            // a request, and any previous view-as context is discarded.
            if (user) {
                applySignIn(token, user);
            }

            // SEC-TENANT-1. `session` here is the browser's `update()` payload —
            // an unvalidated request body, not server state. Every decision about
            // what it may change lives in lib/auth/sessionUpdate.ts so there is
            // exactly one place to audit.
            if (trigger === 'update') {
                await applySessionUpdate(
                    token,
                    session,
                    process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
                );
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

                // SEC-TENANT-1 — view-as context, so the UI can show that this
                // is an impersonated tenant and offer a way back. `businessId`
                // above is the EFFECTIVE tenant; `baseBusinessId` is the real one.
                (session.user as any).baseBusinessId = token.baseBusinessId ?? token.businessId;
                (session.user as any).baseBusinessName = token.baseBusinessName ?? token.businessName;
                (session.user as any).viewAsBusinessId = token.viewAsBusinessId ?? null;
                (session.user as any).isViewingAsTenant = !!token.viewAsBusinessId;
            }
            return session;
        },
        authorized({ auth, request: { nextUrl } }) {
            const isLoggedIn = !!auth?.user;
            const isOnDashboard = nextUrl.pathname === '/' ||
                nextUrl.pathname.startsWith('/orders') ||
                nextUrl.pathname.startsWith('/dashboard') ||
                nextUrl.pathname.startsWith('/settings') ||
                nextUrl.pathname.startsWith('/admin') ||
                nextUrl.pathname.startsWith('/recipes') ||
                nextUrl.pathname.startsWith('/bundles') ||
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
                return Response.redirect(new URL('/', nextUrl)); // Redirect to dashboard if already logged in
            }
            return true;
        },
    },
    providers: [], // Add providers with an empty array for now
} satisfies NextAuthConfig;
