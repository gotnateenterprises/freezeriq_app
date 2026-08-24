
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { signViewAsGrant, VIEW_AS_GRANT_TTL_SECONDS } from '@/lib/auth/viewAsGrant';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const businesses = await prisma.business.findMany({
            select: {
                id: true,
                name: true,
                slug: true
            },
            orderBy: {
                name: 'asc'
            }
        });

        return NextResponse.json(businesses);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { businessId } = body;

        if (!businessId || typeof businessId !== 'string') {
            return NextResponse.json({ error: "Business ID is required" }, { status: 400 });
        }

        // SEC-TENANT-1 — CURRENT super-admin check.
        //
        // The check above reads token.isSuperAdmin, which is a claim in a JWE
        // cookie whose expiry is refreshed on every session call
        // (@auth/core/lib/actions/session.js:46). An administrator demoted in the
        // database therefore keeps that claim until they go idle past the session
        // maxAge. Reading a stale claim is tolerable for continuing to act; it is
        // NOT tolerable for MINTING NEW cross-tenant authority, which is exactly
        // what this endpoint does when it signs a grant.
        //
        // So grant issuance re-reads the row. This deliberately does not attempt
        // to solve rolling-JWT staleness generally — that is recorded as
        // AUTH-SESSION-REVOCATION-1 for the pre-multi-tenant audit.
        const actor = await prisma.user.findUnique({
            where: { id: session.user.id as string },
            select: { is_super_admin: true },
        });

        if (!actor?.is_super_admin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // SEC-TENANT-1. This used to write users.business_id, which PERMANENTLY
        // reassigned the super admin's own row to the tenant being inspected.
        // Two consequences: their real home tenant was unrecoverable after the
        // first switch, and because sign-in reads business_id from the database,
        // logging out and back in silently resumed the impersonation.
        //
        // View As is now session context, not an identity rewrite — see
        // lib/auth/sessionUpdate.ts. This endpoint's job is to VALIDATE the
        // target and hand back the tenant's real display values, so the client
        // never invents them.
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { id: true, name: true, plan: true, subscription_status: true },
        });

        if (!business) {
            return NextResponse.json({ error: "Business not found" }, { status: 404 });
        }

        // This endpoint is the ONLY issuer of view-as authority. The grant binds
        // the target and its real attributes together, signed, so the browser
        // relays them without being trusted to compose them — and so the jwt
        // callback cannot be handed an unvalidated or nonexistent tenant.
        // See lib/auth/viewAsGrant.ts.
        const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
        if (!secret) {
            return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
        }

        const grant = await signViewAsGrant({
            sub: session.user.id as string,
            bid: business.id,
            name: business.name,
            plan: String(business.plan),
            status: String(business.subscription_status),
            exp: Math.floor(Date.now() / 1000) + VIEW_AS_GRANT_TTL_SECONDS,
        }, secret);

        return NextResponse.json({
            success: true,
            grant,
            business: {
                id: business.id,
                name: business.name,
                plan: business.plan,
                subscriptionStatus: business.subscription_status,
            },
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
