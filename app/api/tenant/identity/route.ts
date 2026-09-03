import { NextResponse } from 'next/server';

/**
 * OPS-5F — the SERVER-AUTHENTICATED current-tenant identity.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11.
 *
 * WHY THIS EXISTS
 *
 * The print batch is handed between two pages through localStorage, which is
 * per-BROWSER, not per-tenant. Before multi-tenant launch a stale batch built
 * by Tenant A must never render for Tenant B after a logout/login in the same
 * browser, so the batch carries its owning Business id and the print page
 * verifies it before rendering anything.
 *
 * That comparison is only worth as much as the identity on both sides.
 * OPS-5B, OPS-5C and OPS-5E each proved that `useSession().user.businessId`
 * is NOT reliably present in these components -- three separate production
 * failures traced to exactly that value. It therefore cannot be the authority
 * for a security decision: an absent client id would silently degrade the
 * check to "no opinion", which is precisely the failure mode this endpoint
 * exists to prevent.
 *
 * No existing authenticated response exposed the immutable Business.id
 * (/api/tenant/branding returns name/colors/slug, deliberately), so this is
 * the narrowest possible read-only endpoint that does: one field, derived
 * ONLY from the server session, 401 before anything else. It matches the
 * self-defending route shape proven in OPS-5C.
 */
export async function GET() {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        // The EFFECTIVE tenant, exactly as every other tenant-scoped route
        // resolves it (SEC-TENANT-1: a super admin viewing as a tenant is
        // that tenant for the duration). Never read from the request.
        const businessId = (session?.user as any)?.businessId as string | undefined;

        if (!businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        return NextResponse.json({ businessId });
    } catch (e: any) {
        return NextResponse.json({ error: 'Failed to resolve tenant identity' }, { status: 500 });
    }
}
