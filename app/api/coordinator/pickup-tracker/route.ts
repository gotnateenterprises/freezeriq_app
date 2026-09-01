/**
 * COORD-FULFILLMENT-2 — the coordinator's day-of pickup tracker data.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md.
 *
 * ACCESS MODEL: coordinator session cookie only. There is deliberately NO
 * campaign identifier in this route's path or query — the campaign comes from
 * requireCoordinatorSession, so there is nothing for a browser to tamper with.
 *
 * ACTOR: fundraiser coordinator
 * SCOPE: the ONE campaign their session is bound to
 *
 * WHAT THIS IS NOT: the live order tracker. That surface shows every supporter
 * COMMITMENT, including orders still held while the organisation's invoice is
 * unpaid. This one is a FULFILMENT document — it answers "what food is here to
 * hand over today" — so it shows only work the paid-invoice release has let
 * through. The two sets differ on purpose while a fundraiser is still held; see
 * isPickupEligibleOrder in lib/coordinatorSupporterOrders.ts.
 *
 * Every field a supporter row carries, and the rule deciding whether an email
 * is truthfully theirs, is owned by lib/coordinatorSupporterOrders.ts and shared
 * with the live tracker and the XLSX sheet. This route re-derives none of it.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { PRODUCTION_ORDER_EXCLUSIONS } from '@/lib/productionIntake';
import {
    SUPPORTER_ORDER_SELECT,
    groupSupporterRows,
    isPickupEligibleOrder,
} from '@/lib/coordinatorSupporterOrders';
import { planAllowsCoordinatorPortal } from '@/app/api/coordinator/route';

export async function GET(req: Request) {
    try {
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;

        // Explicit allowlist: only what the printed header shows. portal_token,
        // settlement notes and tax fields are never fetched.
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: guard.campaignId },
            select: {
                id: true,
                name: true,
                customer_id: true,
                delivery_date: true,
                delivery_time: true,
                pickup_location: true,
                payment_instructions: true,
                customer: {
                    select: {
                        name: true,
                        business_id: true,
                        business: { select: { name: true, display_name: true, plan: true } },
                    },
                },
            },
        });

        if (!campaign) {
            return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
        }

        // Same plan gate as the portal itself, from the same single definition —
        // a second surface must not become a way around it.
        const plan = (campaign.customer as any)?.business?.plan || 'FREE';
        if (!planAllowsCoordinatorPortal(plan)) {
            return NextResponse.json({ error: 'Portal unavailable (Plan Restriction)' }, { status: 403 });
        }

        const rows = await prisma.order.findMany({
            where: {
                campaign_id: campaign.id,
                canceled_at: null,
                // The shared production/fulfilment exclusions: never a held
                // order, never a canceled one, never an abandoned pre-payment
                // checkout. Composed, not restated.
                AND: [...PRODUCTION_ORDER_EXCLUSIONS],
            },
            orderBy: { created_at: 'asc' },
            select: SUPPORTER_ORDER_SELECT,
        });

        // Second line of defence. The where clause above is the primary gate;
        // re-checking each row in memory means a future change to that clause
        // cannot silently put unreleased food on a pickup sheet.
        const eligible = rows.filter((r) => isPickupEligibleOrder(r as any));

        const groups = groupSupporterRows(eligible as any, campaign.customer_id);

        const totalBundles = groups.reduce(
            (sum, g) => sum + g.items.reduce((n, i) => n + Number(i.quantity || 0), 0),
            0,
        );

        return NextResponse.json({
            campaign: {
                name: campaign.name,
                organization_name: (campaign.customer as any)?.name ?? null,
                tenant_name:
                    (campaign.customer as any)?.business?.display_name
                    || (campaign.customer as any)?.business?.name
                    || null,
                delivery_date: campaign.delivery_date,
                delivery_time: campaign.delivery_time,
                pickup_location: campaign.pickup_location,
                payment_instructions: campaign.payment_instructions,
            },
            groups,
            supporterCount: groups.length,
            totalBundles,
            generatedAt: new Date().toISOString(),
        });
    } catch (e: any) {
        console.error('Pickup tracker error:', e);
        return NextResponse.json({ error: 'Failed to build pickup tracker' }, { status: 500 });
    }
}
