/**
 * Campaign Closeout API
 *
 * ACCESS MODEL: Session-authenticated (tenant/admin only)
 * ACTOR: Business owner / tenant user
 * SCOPE: Single campaign by ID, tenant-scoped via business_id
 *
 * PURPOSE: Officially closes a fundraiser campaign. In a single transaction:
 *   1. Freezes settlement_total from active non-canceled orders
 *   2. Sets status to 'Closed', records closed_at and closed_by
 *   3. Batch-promotes fundraiser_hold orders to production_ready
 *
 * IDEMPOTENT: Re-calling on an already-closed campaign returns success
 * without re-promoting orders or overwriting an existing settlement_total.
 *
 * DOES NOT: process payments, create invoices, send emails, or touch
 * storefront/billing logic.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        // ── Auth: mirror pattern from app/api/campaigns/[id]/route.ts ──
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: campaignId } = await params;
        const businessId = (session.user as any).businessId;
        const userId = (session.user as any).id || (session.user as any).email || null;

        // ── Ownership check: campaign must belong to this tenant ──
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { id: campaignId },
            include: { customer: { select: { business_id: true } } }
        });

        if (!campaign) {
            return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
        }

        if (campaign.customer.business_id !== businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // ── Idempotency: already closed → return success without re-promoting ──
        if (campaign.closed_at || campaign.status === 'Closed') {
            return NextResponse.json({
                success: true,
                idempotent: true,
                campaign_id: campaignId,
                status: campaign.status,
                closed_at: campaign.closed_at,
                settlement_total: campaign.settlement_total
                    ? Number(campaign.settlement_total)
                    : null,
                promoted_order_count: 0
            });
        }

        // ── Execute closeout in a transaction ──
        const result = await prisma.$transaction(async (tx) => {
            // 1. Compute settlement total from active, non-canceled orders.
            //    Uses order.total_amount (the canonical per-order total) rather
            //    than the denormalized campaign.total_sales which may drift.
            const activeOrders = await tx.order.findMany({
                where: {
                    campaign_id: campaignId,
                    canceled_at: null
                },
                select: { total_amount: true }
            });

            const settlementTotal = activeOrders.reduce(
                (sum, o) => sum + Number(o.total_amount || 0),
                0
            );

            // 2. Update campaign to Closed state
            const closedCampaign = await tx.fundraiserCampaign.update({
                where: { id: campaignId },
                data: {
                    status: 'Closed',
                    closed_at: new Date(),
                    closed_by: userId,
                    settlement_total: settlementTotal
                } as any
            });

            // 3. Batch-promote fundraiser_hold orders to production_ready.
            //    Only targets:
            //      - orders belonging to this campaign
            //      - source = 'fundraiser' (coordinator-entered)
            //      - status = 'fundraiser_hold' (not yet promoted)
            //      - not canceled
            //    Orders already in production_ready, in_production, completed,
            //    delivered, or canceled are untouched.
            const promoted = await tx.order.updateMany({
                where: {
                    campaign_id: campaignId,
                    source: 'fundraiser' as any,
                    status: 'fundraiser_hold' as any,
                    canceled_at: null
                },
                data: {
                    status: 'production_ready' as any
                }
            });

            return {
                closedCampaign,
                promotedCount: promoted.count
            };
        });

        return NextResponse.json({
            success: true,
            idempotent: false,
            campaign_id: campaignId,
            status: result.closedCampaign.status,
            closed_at: result.closedCampaign.closed_at,
            settlement_total: result.closedCampaign.settlement_total
                ? Number(result.closedCampaign.settlement_total)
                : 0,
            promoted_order_count: result.promotedCount
        });

    } catch (e: any) {
        console.error('Campaign Closeout Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to close campaign' },
            { status: 500 }
        );
    }
}
