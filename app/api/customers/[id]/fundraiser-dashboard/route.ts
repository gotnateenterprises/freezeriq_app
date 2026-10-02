/**
 * FR-ORG-DASHBOARD-1A — the organization mini-dashboard (READ ONLY).
 *
 * WHY A NEW ROUTE. GET /api/customers/[id] is the generic customer profile the
 * People page also reads, and it returns only the five newest campaigns. The
 * dashboard needs every campaign, its frozen invoice lines, the previous-
 * supporter audience and the recorded outreach history — a different resource,
 * so it gets its own handler rather than a heavier profile for every caller.
 *
 * ACCESS: session-authenticated, tenant-scoped. The organization is looked up by
 * `{ id, business_id: session }` before anything else is read, and a foreign or
 * missing id answers the same 404.
 *
 * This handler performs no writes.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { loadOrganizationDashboardInput, type OrganizationDashboardDb } from '@/lib/organizationDashboardData';
import { buildOrganizationDashboard } from '@/lib/organizationDashboard';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;

        // Organization ids are UUIDs. Anything else cannot be one of this
        // tenant's organizations, and answers like any other miss.
        if (typeof id !== 'string' || !UUID.test(id)) {
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
        }

        const now = new Date();
        const loaded = await loadOrganizationDashboardInput(prisma as unknown as OrganizationDashboardDb, {
            businessId,
            organizationId: id,
            now,
        });
        if (!loaded.ok) {
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
        }

        // No route-level Cache-Control: next.config.js pins one policy for every /api/*
        // response, and tests/secIntuitAttest1 keeps route literals from drifting from it.
        return NextResponse.json(buildOrganizationDashboard(loaded.input, now));
    } catch (e: unknown) {
        console.error('[FUNDRAISER_DASHBOARD_GET]', e);
        return NextResponse.json({ error: 'Failed to load the organization dashboard' }, { status: 500 });
    }
}
