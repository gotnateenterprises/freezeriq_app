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
import { OPEN_OPPORTUNITY_STATUSES } from '@/lib/fundraiserFunnel';

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
                    select: { id: true, received_at: true, source_channel: true, source_detail: true },
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
            };
            const triage = triageOpportunity(forTriage, now);
            return {
                ...o,
                inquiry_count: o.inquiries.length,
                first_inquiry_at: firstInquiry?.received_at ?? null,
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
