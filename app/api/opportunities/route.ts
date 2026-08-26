/**
 * FR-FUNNEL-1 — tenant-facing read surface for the pre-campaign funnel.
 *
 * Returns this tenant's opportunities with their derived bucket and next action.
 * NOTHING here is stored: `bucket` and `action` are computed per request from
 * lib/growth/opportunityNextAction.ts, so they cannot go stale the moment a date
 * changes. That is the same rule campaign triage already follows.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    triageOpportunity,
    funnelBucket,
    OPPORTUNITY_PRIORITY_RANK,
} from '@/lib/growth/opportunityNextAction';
import { resolveInquiryResponse } from '@/lib/growth/inquiryResponseState';
import { OPEN_OPPORTUNITY_STATUSES } from '@/lib/fundraiserFunnel';
import {
    evaluateRebookingEligibility,
    openOpportunityWhere,
} from '@/lib/fundraiserRebooking';

export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { searchParams } = new URL(req.url);
        const openOnly = searchParams.get('open') === '1';

        const rows = await prisma.fundraiserOpportunity.findMany({
            // Tenant scope is applied here AND enforced by the compound foreign
            // keys underneath, so a bug in this line cannot leak another tenant.
            where: {
                business_id: businessId,
                ...(openOnly ? { status: { in: [...OPEN_OPPORTUNITY_STATUSES] as any } } : {}),
            },
            select: {
                id: true,
                status: true,
                first_response_at: true,
                preferred_delivery_date: true,
                alternate_delivery_date: true,
                confirmed_delivery_date: true,
                participant_estimate: true,
                notes: true,
                lost_reason: true,
                lost_at: true,
                campaign_id: true,
                converted_at: true,
                created_at: true,
                updated_at: true,
                customer: { select: { id: true, name: true, contact_name: true, contact_email: true, contact_phone: true } },
                // The earliest inquiry starts the response-time clock; the count
                // is how a tenant sees "they have asked us three times".
                inquiries: {
                    orderBy: { received_at: 'asc' },
                    select: {
                        id: true, received_at: true, source_channel: true, source_detail: true,
                        // FR-ACCEPTANCE-2A.1 — the per-inquiry response facts.
                        // Loaded for EVERY inquiry, not just the first: the CRM
                        // asks about the NEWEST one, and an older inquiry's
                        // acknowledgement or reply must never answer for a newer
                        // one.
                        ack_claimed_at: true, ack_sent_at: true, human_response_at: true,
                        // FR-ACCEPTANCE-2A.2 — the latest manual follow-up, which
                        // advances on repeat contact while human_response_at stays
                        // fixed at the first.
                        last_human_followup_at: true,
                    },
                },
            },
            orderBy: { created_at: 'desc' },
        });

        const now = new Date();
        const opportunities = rows.map((o) => {
            const firstInquiry = o.inquiries[0] ?? null;
            const forTriage = {
                status: o.status as string,
                received_at: firstInquiry?.received_at ?? o.created_at,
                first_response_at: o.first_response_at,
                preferred_delivery_date: o.preferred_delivery_date,
                confirmed_delivery_date: o.confirmed_delivery_date,
                updated_at: o.updated_at,
                inquiries: o.inquiries,
            };
            const triage = triageOpportunity(forTriage, now);
            // FR-ACCEPTANCE-2A.1 — derived here so the list, the drawer and the
            // next action all read the SAME answer rather than each re-deriving
            // it from raw timestamps and drifting apart.
            const response = resolveInquiryResponse(o.first_response_at, o.inquiries);
            return {
                ...o,
                inquiry_count: o.inquiries.length,
                first_inquiry_at: firstInquiry?.received_at ?? null,
                latest_inquiry_at: response.latestInquiryAt,
                response_state: response.state,
                auto_ack_sent_at: response.autoAckSentAt,
                manual_response_applies: response.manualResponseApplies,
                // The reply that actually applies to the NEWEST inquiry. Not
                // first_response_at: in the spring/autumn case that column holds
                // the reply to the spring inquiry, and showing it beside an
                // autumn conversation would misdate the tenant's own history by
                // months.
                manual_response_at: response.outreachAt && response.state === 'manual_response'
                    ? response.outreachAt
                    : null,
                // FR-ACCEPTANCE-2A.2 — what the CRM renders as "Followed up
                // [date]". Null until a follow-up is actually recorded, and read
                // from the newest inquiry only, so an older inquiry's follow-up
                // can never be displayed against a newer one.
                last_human_followup_at: response.lastHumanFollowUpAt,
                // Median/aggregate reporting is a later phase; per-row response
                // time is cheap and immediately useful in the CRM list.
                response_hours: o.first_response_at && firstInquiry
                    ? (new Date(o.first_response_at).getTime() - new Date(firstInquiry.received_at).getTime()) / 36e5
                    : null,
                bucket: funnelBucket(forTriage, now),
                priority: triage.priority,
                rank: triage.rank,
                action: triage.action,
            };
        });

        opportunities.sort((a, b) => a.rank - b.rank);

        return NextResponse.json({
            opportunities,
            priority_rank: OPPORTUNITY_PRIORITY_RANK,
        });
    } catch (error: any) {
        console.error('[OPPORTUNITIES_GET]', error);
        return NextResponse.json({ error: 'Failed to load opportunities' }, { status: 500 });
    }
}

/**
 * FR-REBOOK-1 — start (or resume) a fundraiser cycle for an organization the
 * tenant already knows.
 *
 * WHY THIS EXISTS
 *
 * A FundraiserOpportunity could previously only be born in
 * app/api/public/fundraiser-request/route.ts — the public website form. Every
 * step after it is organization-agnostic and already works for a returning group,
 * so the only thing standing between Edgar County Farm Bureau and their next
 * fundraiser was a door that opened from the outside. This is the same door,
 * opened from the inside by the tenant.
 *
 * WHAT IT DOES NOT DO
 *
 *   - It does NOT create a Customer. The organization must already exist, and it
 *     is looked up by id within the tenant. A returning fundraiser that invented
 *     a second Edgar would be worse than no feature at all.
 *   - It does NOT create a FundraiserInquiry. An inquiry is the immutable record
 *     that somebody filled in the public form; nobody did. Fabricating one would
 *     put a false event in the organization's history — and because
 *     attemptInquiryAcknowledgement() is keyed on an inquiry id and called only
 *     from the public route, not creating one is also what structurally
 *     guarantees no acknowledgement or intro email can fire here.
 *   - It does NOT create a campaign. Launch remains
 *     POST /api/opportunities/[id]/launch, from a date-confirmed opportunity,
 *     exactly as for a brand-new lead.
 *   - It does NOT touch the organization's CustomerStatus. That is CRM
 *     relationship truth shared with ordinary customers, and resetting it to LEAD
 *     because a new fundraiser is being considered is precisely the conflation
 *     FR-HISTORY-1 removed.
 *
 * IDEMPOTENT BY REUSE: an organization with an open cycle gets that cycle back
 * rather than a second one, mirroring the public route's own behaviour.
 */
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        let body: any = {};
        try { body = await req.json(); } catch { /* validated below */ }

        const customerId = typeof body?.customerId === 'string' ? body.customerId.trim() : '';
        if (!customerId) {
            return NextResponse.json({ error: 'An organization is required.' }, { status: 400 });
        }

        // ── The organization, resolved server-side within this tenant. The client
        //    sends an id and nothing else; the name, contact and history all come
        //    from the stored row, so a returning fundraiser cannot be pointed at
        //    another tenant's organization or carry spoofed details.
        const organization = await prisma.customer.findFirst({
            where: { id: customerId, business_id: businessId },
            select: {
                id: true,
                name: true,
                archived: true,
                contact_name: true,
                contact_email: true,
                contact_phone: true,
                campaigns: {
                    select: {
                        id: true,
                        status: true,
                        closed_at: true,
                        settlement_total: true,
                        settled_externally: true,
                        invoices: { select: { status: true } },
                        // Non-canceled orders only, matching what FR-HISTORY-1
                        // means by held_order_count. A raw total would count
                        // cancellations as sales — harmless for THIS decision
                        // (whether a campaign is operationally open depends only
                        // on closed_at and status) but wrong the moment anyone
                        // reads it as a gross.
                        _count: { select: { orders: { where: { canceled_at: null } } } },
                    },
                },
            },
        });

        if (!organization) {
            // Same answer for "not yours" as for "does not exist".
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
        }

        const openOpportunity = await prisma.fundraiserOpportunity.findFirst({
            where: openOpportunityWhere(businessId, customerId) as any,
            select: { id: true, status: true, confirmed_delivery_date: true },
        });

        const eligibility = evaluateRebookingEligibility({
            archived: organization.archived,
            openOpportunityId: openOpportunity?.id ?? null,
            campaigns: organization.campaigns.map((c) => ({
                id: c.id,
                status: c.status,
                closed_at: c.closed_at,
                settlement_total: c.settlement_total as any,
                settled_externally: c.settled_externally,
                invoice_statuses: c.invoices.map((i) => String(i.status)),
                held_order_count: c._count.orders,
            })),
        });

        if (!eligibility.ok) {
            return NextResponse.json(
                { error: eligibility.error, code: eligibility.code },
                { status: 409 },
            );
        }

        // Resume: hand back the cycle already in flight rather than opening a second.
        if (eligibility.action === 'resume') {
            return NextResponse.json({
                opportunity: {
                    id: eligibility.opportunityId,
                    status: openOpportunity?.status ?? null,
                    confirmed_delivery_date: openOpportunity?.confirmed_delivery_date ?? null,
                },
                organization: {
                    id: organization.id,
                    name: organization.name,
                    contact_name: organization.contact_name,
                    contact_email: organization.contact_email,
                    contact_phone: organization.contact_phone,
                },
                resumed: true,
            });
        }

        // Start: the minimum truthful record — this tenant, this organization, a
        // cycle that has begun. Dates are the owner's next conversation, not an
        // assumption made here.
        //
        // ── THE RACE THIS RECOVERS FROM ─────────────────────────────────────
        // migration 20260817000000 carries a partial unique index that Prisma
        // cannot see:
        //
        //   CREATE UNIQUE INDEX fundraiser_opportunities_one_open_per_org
        //     ON fundraiser_opportunities (business_id, customer_id)
        //     WHERE status IN ('new','in_conversation','date_confirmed');
        //
        // The read above and this write are not atomic, so two clicks — a
        // double-tap, a retried request, two admins — can both find no open cycle
        // and both try to open one. The database correctly refuses the second.
        // Reporting that as a failure would be a lie: the caller asked for an open
        // cycle and an open cycle exists. So P2002 is resolved by reading back the
        // winner and reporting it as resumed, which is what the caller wanted.
        let created;
        try {
            created = await prisma.fundraiserOpportunity.create({
                data: { business_id: businessId, customer_id: customerId, status: 'new' as any },
                select: { id: true, status: true, confirmed_delivery_date: true },
            });
        } catch (e: any) {
            if (e?.code !== 'P2002') throw e;
            const winner = await prisma.fundraiserOpportunity.findFirst({
                where: openOpportunityWhere(businessId, customerId) as any,
                select: { id: true, status: true, confirmed_delivery_date: true },
            });
            if (!winner) throw e;
            return NextResponse.json({
                opportunity: winner,
                organization: {
                    id: organization.id,
                    name: organization.name,
                    contact_name: organization.contact_name,
                    contact_email: organization.contact_email,
                    contact_phone: organization.contact_phone,
                },
                resumed: true,
            });
        }

        return NextResponse.json({
            opportunity: created,
            organization: {
                id: organization.id,
                name: organization.name,
                contact_name: organization.contact_name,
                contact_email: organization.contact_email,
                contact_phone: organization.contact_phone,
            },
            resumed: false,
        }, { status: 201 });
    } catch (error: any) {
        console.error('[OPPORTUNITIES_POST]', error);
        return NextResponse.json({ error: 'Failed to start the fundraiser' }, { status: 500 });
    }
}
