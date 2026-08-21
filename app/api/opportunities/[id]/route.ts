/**
 * FR-FUNNEL-1 — the smallest mutation surface that makes the pre-campaign
 * lifecycle usable.
 *
 * Four actions, no more: record that we replied, record the dates under
 * discussion, confirm the agreed delivery day, or mark the prospect lost.
 *
 * WHAT THIS ROUTE DELIBERATELY CANNOT DO
 *   - create a FundraiserCampaign (that is FR-FLOW-2's launch flow)
 *   - set status to `converted` (only conversion may, and conversion is deferred)
 *   - touch Customer.type or Customer.source
 *   - reopen a terminal opportunity
 *
 * Every write is scoped by business_id in the WHERE clause, and the underlying
 * compound foreign keys mean a row from another tenant is unreachable even if
 * that scope were ever dropped.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { cleanText } from '@/lib/fundraiserFunnel';

/** Disposition vocabulary. Mirrors the FundraiserLostReason enum exactly. */
const LOST_REASONS = [
    'no_response', 'date_unavailable', 'not_interested', 'postponed',
    'duplicate', 'not_a_fit', 'chose_other_fundraiser', 'other',
] as const;

/** Accepts YYYY-MM-DD and stores it as a calendar date with no timezone drift. */
function parseCalendarDate(value: unknown): Date | null | undefined {
    if (value === null) return null;            // explicit clear
    if (typeof value !== 'string' || !value.trim()) return undefined; // absent
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return undefined;
    const d = new Date(`${value.trim()}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id } = await params;
        const body = await req.json();
        const action = body?.action;

        const current = await prisma.fundraiserOpportunity.findFirst({
            where: { id, business_id: businessId },
            select: { id: true, status: true, first_response_at: true, preferred_delivery_date: true },
        });
        if (!current) {
            // 404 rather than 403: a tenant must not be able to probe for the
            // existence of another tenant's opportunity ids.
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }
        if (current.status === 'converted' || current.status === 'lost') {
            return NextResponse.json(
                { error: 'This opportunity is closed and can no longer be edited.' },
                { status: 409 }
            );
        }

        const data: Record<string, unknown> = {};

        switch (action) {
            case 'mark_responded': {
                // Idempotent: the FIRST reply is the one that counts, so a second
                // click must not move the response-time clock forward.
                if (!current.first_response_at) data.first_response_at = new Date();
                if (current.status === 'new') data.status = 'in_conversation';
                break;
            }

            case 'set_dates': {
                const preferred = parseCalendarDate(body?.preferred_delivery_date);
                const alternate = parseCalendarDate(body?.alternate_delivery_date);
                if (preferred !== undefined) data.preferred_delivery_date = preferred;
                if (alternate !== undefined) data.alternate_delivery_date = alternate;
                if (body?.participant_estimate !== undefined) {
                    const n = Number(body.participant_estimate);
                    data.participant_estimate = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
                }
                if (body?.notes !== undefined) data.notes = cleanText(body.notes, 2000);
                // Discussing dates IS being in conversation.
                if (current.status === 'new' && (preferred || alternate)) data.status = 'in_conversation';
                if (Object.keys(data).length === 0) {
                    return NextResponse.json({ error: 'No date fields supplied.' }, { status: 400 });
                }
                break;
            }

            case 'confirm_date': {
                const confirmed = parseCalendarDate(body?.confirmed_delivery_date);
                if (!confirmed) {
                    return NextResponse.json(
                        { error: 'A confirmed delivery/pickup date is required (YYYY-MM-DD).' },
                        { status: 400 }
                    );
                }
                // This is the DELIVERY/PICKUP day — the date actually negotiated
                // with the organization. At conversion it becomes
                // FundraiserCampaign.delivery_date, never start_date.
                data.confirmed_delivery_date = confirmed;
                data.status = 'date_confirmed';
                // FR-ACCEPTANCE-1C: booking a date is NOT a reply.
                //
                // This branch used to stamp first_response_at, on the reasoning
                // that you cannot agree a date without having talked. But the
                // tenant can confirm a date they were told over a table at a
                // school fair, or one a volunteer left on voicemail. Stamping it
                // here wrote "we replied at 12:20" into permanent CRM history for
                // a reply that may never have happened, and response_hours then
                // reported that fabricated interval as a real response time.
                //
                // first_response_at now has exactly two sources, both of which
                // mean a person actually answered: a real platform email that
                // provably left the building, and the explicit "I replied
                // elsewhere" control. Both arrive as `mark_responded` above.
                //
                // Leaving it null here is safe: date_confirmed is the sole launch
                // gate (lib/fundraiserLaunch.ts), and both triage functions test
                // for date_confirmed BEFORE they test first_response_at, so the
                // lead moves on as normal — it simply stops claiming a reply it
                // cannot vouch for.
                break;
            }

            case 'mark_lost': {
                const reason = body?.lost_reason;
                if (!LOST_REASONS.includes(reason)) {
                    return NextResponse.json(
                        { error: 'A valid lost reason is required.' },
                        { status: 400 }
                    );
                }
                // The lead is never deleted. Understanding why prospects
                // disappear is the entire point of recording a disposition.
                data.status = 'lost';
                data.lost_reason = reason;
                data.lost_at = new Date();
                if (body?.notes !== undefined) data.notes = cleanText(body.notes, 2000);
                break;
            }

            default:
                return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
        }

        if (Object.keys(data).length === 0) {
            // Nothing to do (e.g. mark_responded on an already-answered lead).
            return NextResponse.json({ success: true, changed: false });
        }

        // Conditional on business_id again: defence in depth against a future
        // refactor that drops the lookup above.
        const updated = await prisma.fundraiserOpportunity.updateMany({
            where: { id, business_id: businessId },
            data: data as any,
        });
        if (updated.count !== 1) {
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }

        return NextResponse.json({ success: true, changed: true });
    } catch (error: any) {
        console.error('[OPPORTUNITY_PATCH]', error);
        return NextResponse.json({ error: 'Failed to update opportunity' }, { status: 500 });
    }
}
