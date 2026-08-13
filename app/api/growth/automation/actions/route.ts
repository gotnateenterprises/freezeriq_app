/**
 * GE-5A — read this tenant's automation actions.
 *
 * Read-only. Scoped to the session's business, so a tenant cannot see another
 * tenant's recommendations even by guessing an id — the filter is on the query,
 * not on the response.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { AUTOMATION_ACTION_TYPE } from '@/lib/growth/automation';

const READABLE_STATUSES = ['candidate', 'approved', 'dismissed', 'suppressed', 'expired'];

export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const url = new URL(req.url);
        const requested = url.searchParams.get('status');
        const offeringId = url.searchParams.get('seasonal_offering_id');

        const actions = await prisma.automationAction.findMany({
            where: {
                business_id: businessId,
                action_type: AUTOMATION_ACTION_TYPE as never,
                ...(requested && READABLE_STATUSES.includes(requested)
                    ? { status: requested as never }
                    : {}),
                ...(offeringId ? { seasonal_offering_id: offeringId } : {}),
            },
            select: {
                id: true,
                status: true,
                seasonal_offering_id: true,
                customer_id: true,
                reasons: true,
                evidence_at: true,
                expires_at: true,
                approved_by_user_id: true,
                approved_at: true,
                dismissed_by_user_id: true,
                dismissed_at: true,
                suppressed_at: true,
                suppressed_reason: true,
                expired_at: true,
                expired_reason: true,
                created_at: true,
                customer: { select: { name: true } },
                offering: { select: { name: true } },
            },
            orderBy: [{ created_at: 'desc' }],
        });

        return NextResponse.json({
            actions: actions.map(a => ({
                ...a,
                status: String(a.status),
                organization_name: a.customer?.name ?? null,
                offering_name: a.offering?.name ?? null,
                // GE-5A cannot send. Say so explicitly rather than leaving the
                // caller to infer it from the absence of a field.
                email_sent: false,
                customer: undefined,
                offering: undefined,
            })),
        });
    } catch (e: unknown) {
        console.error('[growth/automation/actions GET]', e);
        return NextResponse.json({ error: 'Failed to load automation actions' }, { status: 500 });
    }
}
