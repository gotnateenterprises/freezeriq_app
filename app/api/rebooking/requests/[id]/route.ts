/**
 * FR-RETENTION-4 — acting on one rebooking request.
 *
 * PATCH { action, opportunityIds } → change the STATUS of one or more
 * organizations on this request.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, and the boundary matters:
 *   · It never creates a FundraiserCampaign. Approving marks an organization as
 *     ready; creating the fundraiser is Checkpoint 5 and happens one at a time
 *     through the wizard, because a bulk action that silently created several
 *     live campaigns would be the single most dangerous thing on this screen.
 *   · It never creates a CampaignContact or any access grant. A named
 *     replacement coordinator is recorded evidence, not a portal login.
 *   · It never writes to FundraiserContact. A contact correction from a public
 *     form is shown for the tenant to act on in the contact record itself.
 *   · It never schedules or sends anything.
 *
 * `converted` is immutable here: once a fundraiser exists, this screen is no
 * longer the place that governs it.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

type Action = 'approve' | 'not_this_season' | 'leave_pending';

const ACTIONS: Action[] = ['approve', 'not_this_season', 'leave_pending'];

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const { id } = await ctx.params;

        const body = await req.json().catch(() => ({} as Record<string, unknown>));
        const action = body.action as Action;
        if (!ACTIONS.includes(action)) {
            return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
        }

        const ids: string[] = Array.isArray(body.opportunityIds)
            ? body.opportunityIds.filter((v: unknown): v is string => typeof v === 'string')
            : [];
        if (ids.length === 0) {
            return NextResponse.json({ error: 'Choose at least one organization.' }, { status: 400 });
        }

        const submission = await prisma.rebookingSubmission.findFirst({
            where: { id, business_id: businessId },
            select: { id: true },
        });
        if (!submission) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

        // Scoped to the tenant AND to this request, so an id from another
        // request — or another tenant — simply is not found.
        const targets = await prisma.rebookingOpportunity.findMany({
            where: { business_id: businessId, submission_id: submission.id, id: { in: ids } },
            select: { id: true, status: true, organization_name: true },
        });
        if (targets.length !== ids.length) {
            return NextResponse.json({ error: 'Some organizations could not be found on this request.' }, { status: 400 });
        }

        const now = new Date();
        const skippedConverted: string[] = [];
        let changed = 0;

        for (const t of targets) {
            if (t.status === 'converted') {
                skippedConverted.push(t.organization_name);
                continue;
            }

            if (action === 'approve') {
                await prisma.rebookingOpportunity.update({
                    where: { id: t.id },
                    // canceled_at must be cleared alongside the status, or the
                    // CHECK constraint refuses the write — which is exactly what
                    // that constraint is for.
                    data: { status: 'approved', canceled_at: null },
                });
            } else if (action === 'not_this_season') {
                await prisma.rebookingOpportunity.update({
                    where: { id: t.id },
                    data: { status: 'canceled', canceled_at: now },
                });
            } else {
                await prisma.rebookingOpportunity.update({
                    where: { id: t.id },
                    data: { status: 'interested', canceled_at: null },
                });
            }
            changed += 1;
        }

        return NextResponse.json({
            ok: true,
            changed,
            // Reported rather than silently ignored.
            skippedConverted,
        });
    } catch (e) {
        console.error('[Rebooking requests] PATCH failed:', e);
        return NextResponse.json({ error: 'Could not update this request' }, { status: 500 });
    }
}
