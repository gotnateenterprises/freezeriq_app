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

/**
 * FR-ACCEPTANCE-2A.1 — the opportunity vanished between the read and the write.
 *
 * Thrown to roll the transaction back, then mapped to the same 404 the
 * pre-flight lookup returns. Identified by a own-property tag rather than
 * `instanceof`: a class identity can differ across module instances, and a
 * mis-identified sentinel here would silently downgrade a 404 into a 500.
 */
const OPPORTUNITY_NOT_FOUND = 'OPPORTUNITY_NOT_FOUND';
class OpportunityNotFound extends Error {
    readonly tag = OPPORTUNITY_NOT_FOUND;
    constructor() { super(OPPORTUNITY_NOT_FOUND); }
}
const isOpportunityNotFound = (e: unknown): boolean =>
    typeof e === 'object' && e !== null && (e as { tag?: unknown }).tag === OPPORTUNITY_NOT_FOUND;

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
        /**
         * FR-ACCEPTANCE-2A.1 — whether this reply closes outstanding inquiries.
         *
         * The inquiries are resolved on the SERVER from the opportunity, never
         * taken from the request body. A client-supplied inquiry id would let one
         * tenant stamp a human response onto another tenant's inquiry, and even
         * within one tenant would let the wrong conversation be marked answered.
         */
        let respondsToInquiries = false;

        switch (action) {
            case 'mark_responded': {
                // Idempotent: the FIRST reply is the one that counts, so a second
                // click must not move the response-time clock forward. This
                // column is the opportunity's first-ever-response METRIC and is
                // deliberately write-once.
                if (!current.first_response_at) data.first_response_at = new Date();
                if (current.status === 'new') data.status = 'in_conversation';

                // ── THE PER-INQUIRY FACT ────────────────────────────────────
                //
                // The metric above cannot answer "has this inquiry been replied
                // to". Being write-once, answering a SECOND inquiry on the same
                // opportunity writes nothing at all — which left the newest
                // inquiry reading as unanswered forever while the control that
                // offered to answer it silently did nothing.
                //
                // EVERY outstanding inquiry, not just the newest.
                //
                // A tenant replying to an organization answers the conversation,
                // not one message in it — if two inquiries are both waiting, one
                // reply addresses both. Targeting only the newest looked right
                // and was not: a second click would then find the NEXT-oldest
                // unanswered inquiry and stamp `now()` onto it, inventing a reply
                // to a months-old message that nobody ever sent.
                //
                // Answering all of them also makes this naturally idempotent.
                // After the first click nothing is outstanding, so a second one
                // matches zero rows and correctly reports no change.
                const outstanding = await prisma.fundraiserInquiry.count({
                    where: { opportunity_id: id, business_id: businessId, human_response_at: null },
                });
                respondsToInquiries = outstanding > 0;
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

        if (Object.keys(data).length === 0 && !respondsToInquiries) {
            // Nothing to do — every inquiry on this opportunity already carries a
            // human response.
            //
            // FR-ACCEPTANCE-2A.1 added the second half of this condition, and it
            // is the whole fix. Answering a SECOND inquiry produces an empty
            // `data` (first_response_at is already set, status is already
            // in_conversation), so this early return used to fire and the reply
            // was never recorded anywhere. The tenant got a success toast for a
            // write that did not happen.
            return NextResponse.json({ success: true, changed: false });
        }

        // Both writes or neither. A reply recorded on the opportunity but not on
        // the inquiry — or the reverse — is exactly the split-brain state this
        // phase exists to remove.
        await prisma.$transaction(async (tx) => {
            if (Object.keys(data).length > 0) {
                // Every predicate that the pre-flight read checked is RE-ASSERTED
                // here, because that read happened outside this transaction and
                // another request can have changed the row since.
                //
                //   business_id — defence in depth if the lookup above is ever
                //     refactored away.
                //   status      — the route documents that it cannot reopen a
                //     terminal opportunity, but the terminal check ran against
                //     the earlier snapshot. Without this, a concurrent
                //     "mark lost" and "I replied elsewhere" would both pass
                //     their pre-flight and the reply would quietly revive a lost
                //     lead.
                //   first_response_at — only when this request is the one
                //     setting it. The column is write-once, and two concurrent
                //     requests both reading null would otherwise both write,
                //     moving a response-time metric that is supposed to be
                //     fixed at the first reply.
                const guard: Record<string, unknown> = {
                    id,
                    business_id: businessId,
                    status: { notIn: ['converted', 'lost'] },
                };
                if (data.first_response_at) guard.first_response_at = null;

                const updated = await tx.fundraiserOpportunity.updateMany({
                    where: guard as any,
                    data: data as any,
                });
                if (updated.count !== 1) {
                    // Lost a race, or the row moved. Roll back rather than
                    // leaving the inquiry stamped against an opportunity whose
                    // own update never applied.
                    throw new OpportunityNotFound();
                }
            }
            if (respondsToInquiries) {
                // Every outstanding inquiry on this opportunity. Scoped by tenant
                // AND opportunity at the point of the write, and conditional on
                // human_response_at being null so a concurrent second request
                // matches zero rows instead of moving a timestamp that has
                // already passed.
                await tx.fundraiserInquiry.updateMany({
                    where: {
                        business_id: businessId,
                        opportunity_id: id,
                        human_response_at: null,
                    },
                    data: { human_response_at: new Date() },
                });
            }
        });

        return NextResponse.json({ success: true, changed: true });
    } catch (error: any) {
        if (isOpportunityNotFound(error)) {
            // Same answer as the pre-flight lookup, so a row deleted mid-request
            // cannot be told apart from one that never existed.
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }
        console.error('[OPPORTUNITY_PATCH]', error);
        return NextResponse.json({ error: 'Failed to update opportunity' }, { status: 500 });
    }
}
