/**
 * Campaign Closeout API
 *
 * ACCESS MODEL: Session-authenticated, tenant-scoped, ADMIN or super-admin.
 * ACTOR: Business owner / tenant administrator
 * SCOPE: Single campaign by ID, tenant-scoped via business_id
 *
 * PURPOSE: Officially closes a fundraiser campaign. In a single transaction:
 *   1. Freezes settlement_total from active non-canceled orders
 *   2. Claims the campaign into 'Closed', recording closed_at and closed_by
 *   3. Batch-promotes fundraiser_hold orders to production_ready
 *
 * IDEMPOTENT: Re-calling on an already-closed campaign returns success
 * without re-promoting orders or overwriting an existing settlement_total.
 *
 * DOES NOT: process payments, create invoices, send emails, or touch
 * storefront/billing logic. INV-B is what will generate the draft invoice here.
 *
 * ── INV-A HARDENING ──────────────────────────────────────────────────────────
 * AUTHORIZATION: closeout freezes money, releases held orders, and records the
 * responsible actor — so it is ADMIN-or-super-admin, not merely
 * "any authenticated tenant user". The rule itself lives in
 * lib/campaignCloseout.ts so it can be unit-tested directly; this introduces no
 * permission framework and no change to how any other route authorizes.
 *
 * closed_by: stores a persisted User.id ONLY. It previously fell back to the
 * session email, which produced a column holding two different identifier types
 * that could not be joined to User. A closeout that cannot resolve a real user
 * id now fails rather than writing an unusable actor.
 *
 * CONCURRENCY: the pre-transaction read-then-check was a TOCTOU window — two
 * concurrent requests could both pass it and the second would overwrite
 * closed_at/closed_by/settlement_total. The authoritative guard is now a
 * conditional updateMany inside the transaction (the house pattern: see the
 * one-campaign opportunity claim in app/api/campaigns/route.ts and the
 * ConcurrentChangeError shape in app/api/orders/bulk-status). Order promotion —
 * and, later, INV-B's invoice creation — run only after count === 1 proves this
 * request won the claim.
 *
 * KNOWN, DELIBERATELY UNCLOSED — PRE-INV-B FINANCIAL CORRECTNESS GATE:
 * a fundraiser order committed between this transaction's settlement read and
 * its commit is promoted but not counted in settlement_total. Making ONLY this
 * transaction Serializable does NOT fix it: PostgreSQL SSI detects the phantom
 * only if every participant is Serializable, and the racing writer
 * (app/api/public/order/route.ts) runs at Read Committed and takes no lock on
 * the campaign row. Closing it requires that writer to participate in a shared
 * lock — a Channel-1-locked path INV-A is not authorized to touch. Before INV-B
 * reaches Production this must be resolved.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { CLOSED_STATUSES, isCampaignClosed } from '@/lib/campaignBundleSelection';
import { mayCloseOutCampaign } from '@/lib/campaignCloseout';

/** Thrown inside the transaction when the conditional claim is not won. */
class CampaignAlreadyClosedError extends Error {
    constructor() {
        super('Campaign was closed by another request');
        this.name = 'CampaignAlreadyClosedError';
    }
}

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

        // ── INV-A: role gate. Authenticated but insufficient → 403. ──
        if (!mayCloseOutCampaign({
            role: (session.user as any).role,
            isSuperAdmin: (session.user as any).isSuperAdmin === true,
        })) {
            return NextResponse.json(
                { error: 'Only an administrator can close out a fundraiser.' },
                { status: 403 }
            );
        }

        // ── INV-A: closed_by must be a persisted User.id, never an email. ──
        // session.user.id comes from token.sub; confirm it resolves to a real
        // user in THIS tenant before writing it as the financial actor.
        const sessionUserId = (session.user as any).id as string | undefined;
        const sessionEmail = session.user.email ?? undefined;

        const actor = sessionUserId
            ? await prisma.user.findFirst({
                where: { id: sessionUserId, business_id: businessId },
                select: { id: true },
            })
            : sessionEmail
                ? await prisma.user.findFirst({
                    where: { email: sessionEmail, business_id: businessId },
                    select: { id: true },
                })
                : null;

        if (!actor) {
            return NextResponse.json(
                { error: 'Could not identify the acting user. Please sign in again.' },
                { status: 403 }
            );
        }
        const userId = actor.id;

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

        // ── Fast-path idempotency: already closed → success, nothing promoted.
        //    This is a courtesy short-circuit only; the authoritative guard is
        //    the conditional claim inside the transaction below.
        if (isCampaignClosed(campaign)) {
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
        let result: { settlementTotal: number; closedAt: Date; promotedCount: number };
        try {
            result = await prisma.$transaction(async (tx) => {
                // 1. Compute settlement total from active, non-canceled orders.
                //    Uses order.total_amount (the canonical per-order total) rather
                //    than the denormalized campaign.total_sales which may drift.
                //    This figure is GROSS: no share, no fee, no deduction.
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

                const closedAt = new Date();

                // 2. CLAIM the campaign. The WHERE clause is the concurrency
                //    guarantee: only a campaign that is still open matches, so
                //    exactly one concurrent request can get count === 1.
                const claimed = await tx.fundraiserCampaign.updateMany({
                    where: {
                        id: campaignId,
                        closed_at: null,
                        status: { notIn: [...CLOSED_STATUSES] },
                    },
                    data: {
                        status: 'Closed',
                        closed_at: closedAt,
                        closed_by: userId,
                        settlement_total: settlementTotal
                    } as any
                });

                if (claimed.count !== 1) {
                    // Someone else won. Roll everything back — including any
                    // promotion — and let the caller re-read the truth.
                    throw new CampaignAlreadyClosedError();
                }

                // 3. Batch-promote fundraiser_hold orders to production_ready.
                //    Runs ONLY after the claim is won, so a losing request can
                //    never release held orders.
                //    Only targets:
                //      - orders belonging to this campaign
                //      - source = 'fundraiser' (coordinator-entered)
                //      - status = 'fundraiser_hold' (not yet promoted)
                //      - not canceled
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
                    settlementTotal,
                    closedAt,
                    promotedCount: promoted.count
                };
            });
        } catch (txErr) {
            if (txErr instanceof CampaignAlreadyClosedError) {
                // Re-read and answer with what is now true, rather than a 500.
                const current = await prisma.fundraiserCampaign.findUnique({
                    where: { id: campaignId },
                    select: { status: true, closed_at: true, settlement_total: true },
                });
                return NextResponse.json({
                    success: true,
                    idempotent: true,
                    campaign_id: campaignId,
                    status: current?.status ?? 'Closed',
                    closed_at: current?.closed_at ?? null,
                    settlement_total: current?.settlement_total != null
                        ? Number(current.settlement_total)
                        : null,
                    promoted_order_count: 0
                });
            }
            throw txErr;
        }

        return NextResponse.json({
            success: true,
            idempotent: false,
            campaign_id: campaignId,
            status: 'Closed',
            closed_at: result.closedAt,
            settlement_total: result.settlementTotal,
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
