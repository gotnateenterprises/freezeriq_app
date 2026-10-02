/**
 * FR-ORG-DASHBOARD-1A — discard an EMPTY, tenant-created planning draft.
 *
 * NOT a generic delete. There is deliberately no DELETE /api/opportunities/[id]:
 * a real prospect is closed with PATCH `mark_lost`, which keeps the row because
 * "understanding why prospects disappear is the entire point of recording a
 * disposition". This route exists for one case only — an accidental Start Next
 * Fundraiser click that never became anything — and it can remove nothing else.
 *
 * GUARDS, in order:
 *   1. a tenant session                          (401 before any query)
 *   2. an explicit `{ "confirm": true }` body     (400 — the dialog sends it)
 *   3. the opportunity, inside THIS tenant        (404 for foreign or missing)
 *   4. evaluateDraftDiscard: status new, no inquiry, no reply, no dates, no
 *      campaign, no disposition, no planning notes or estimate   (409 + reason)
 *   5. the delete's own WHERE re-asserts every one of those facts
 *      (draftDiscardWhere), so a row that changed after step 3 matches nothing
 *      and is left alone                                         (409)
 *
 * It never writes `lost`, never touches the organization, a campaign, an
 * inquiry or an order. The only foreign key into fundraiser_opportunities is
 * fundraiser_inquiries (ON DELETE RESTRICT), so if an inquiry slipped in
 * concurrently the database refuses the delete rather than orphaning it.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    evaluateDraftDiscard,
    draftDiscardWhere,
    draftDiscardRefusal,
} from '@/lib/opportunityDraftDiscard';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;

        let body: any = null;
        try { body = await req.json(); } catch { /* refused below */ }
        if (body?.confirm !== true) {
            return NextResponse.json(
                { error: 'Discarding a draft needs an explicit confirmation.', code: 'confirmation_required' },
                { status: 400 },
            );
        }

        const current = await prisma.fundraiserOpportunity.findFirst({
            where: { id, business_id: businessId },
            select: {
                id: true,
                customer_id: true,
                status: true,
                first_response_at: true,
                preferred_delivery_date: true,
                alternate_delivery_date: true,
                confirmed_delivery_date: true,
                campaign_id: true,
                converted_at: true,
                lost_at: true,
                lost_reason: true,
                notes: true,
                participant_estimate: true,
                _count: { select: { inquiries: true } },
            },
        });
        if (!current) {
            // Same answer for "not yours" as for "does not exist".
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }

        const verdict = evaluateDraftDiscard({
            status: String(current.status),
            first_response_at: current.first_response_at,
            preferred_delivery_date: current.preferred_delivery_date,
            alternate_delivery_date: current.alternate_delivery_date,
            confirmed_delivery_date: current.confirmed_delivery_date,
            campaign_id: current.campaign_id,
            converted_at: current.converted_at,
            lost_at: current.lost_at,
            lost_reason: current.lost_reason ? String(current.lost_reason) : null,
            notes: current.notes,
            participant_estimate: current.participant_estimate,
            inquiry_count: Number(current._count?.inquiries ?? 0),
        });
        if (!verdict.eligible) {
            return NextResponse.json(
                { error: draftDiscardRefusal(verdict.blockers), code: 'not_discardable', blockers: verdict.blockers },
                { status: 409 },
            );
        }

        let deleted: { count: number };
        try {
            deleted = await prisma.fundraiserOpportunity.deleteMany({
                where: draftDiscardWhere(id, businessId) as any,
            });
        } catch (e: any) {
            // P2003: an inquiry was attached between the read and the delete, and
            // the foreign key refused. The draft is no longer empty — keep it.
            if (e?.code === 'P2003') {
                return NextResponse.json(
                    { error: 'This plan just received activity, so it can’t be discarded. Refresh to see it.', code: 'changed' },
                    { status: 409 },
                );
            }
            throw e;
        }
        if (deleted.count !== 1) {
            return NextResponse.json(
                { error: 'This plan changed while you were looking at it, so it can’t be discarded. Refresh to see it.', code: 'changed' },
                { status: 409 },
            );
        }

        // Ids only — enough to trace the action, no personal data.
        console.info('[OPPORTUNITY_DISCARD_DRAFT]', JSON.stringify({
            businessId, opportunityId: id, organizationId: current.customer_id,
        }));
        return NextResponse.json({ discarded: true, opportunityId: id, organizationId: current.customer_id });
    } catch (e: unknown) {
        console.error('[OPPORTUNITY_DISCARD_DRAFT]', e);
        return NextResponse.json({ error: 'Failed to discard the draft' }, { status: 500 });
    }
}
