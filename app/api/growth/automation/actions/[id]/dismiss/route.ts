/**
 * GE-5A — dismiss one recommendation.
 *
 * Dismissal is terminal and always available to the tenant, from either
 * `candidate` or `approved` — withdrawing an approval before GE-7 can act on it
 * has to be possible, or approval would be a one-way door.
 *
 * Dismissing does not free the slot: the unique tuple still holds, so the same
 * organization does not get a fresh recommendation for the same offering. A new
 * SeasonalOffering is what legitimately starts a new lifecycle.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { AUTOMATION_ACTION_TYPE } from '@/lib/growth/automation';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const userId = (session.user as { id?: string }).id ?? null;
        const { id } = await params;
        const now = new Date();

        const action = await prisma.automationAction.findFirst({
            where: { id, business_id: businessId, action_type: AUTOMATION_ACTION_TYPE as never },
            select: { id: true, status: true },
        });
        if (!action) return NextResponse.json({ error: 'Action not found' }, { status: 404 });

        const current = String(action.status);
        if (current !== 'candidate' && current !== 'approved') {
            return NextResponse.json({
                error: `Only a candidate or approved action can be dismissed. This action is ${current}.`,
            }, { status: 409 });
        }

        // Guarded: a concurrent suppress/expire sweep wins and this no-ops,
        // rather than overwriting a terminal state that was already recorded.
        const updated = await prisma.automationAction.updateMany({
            where: {
                id,
                business_id: businessId,
                status: { in: ['candidate', 'approved'] as never },
            },
            data: { status: 'dismissed' as never, dismissed_at: now, dismissed_by_user_id: userId },
        });

        if (updated.count === 0) {
            return NextResponse.json({ error: 'Action changed before dismissal completed' }, { status: 409 });
        }

        return NextResponse.json({ id, status: 'dismissed', dismissed_at: now });
    } catch (e: unknown) {
        console.error('[growth/automation/actions dismiss]', e);
        return NextResponse.json({ error: 'Failed to dismiss action' }, { status: 500 });
    }
}
