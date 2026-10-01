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
 * WHAT IT LISTS (COORD-CLOSEOUT-PICKUP-1, owner ruling 2026-10-01): closeout
 * unlocks the pickup documents; invoice payment still unlocks production.
 *   closed campaign  every non-canceled order — the final, locked list the
 *                    organization's invoice was computed from, held or not. The
 *                    coordinator reconciles it BEFORE the invoice is paid.
 *   open campaign    released work only, as before: there is no final list yet,
 *                    and the portal's live order list covers ordering in flight.
 * The rule is isPickupDocumentOrder / pickupDocumentOrderWhere in
 * lib/coordinatorSupporterOrders.ts, shared with the XLSX sheet. Listing a held
 * order does not release it: this route only reads.
 *
 * Every field a supporter row carries, and the rule deciding whether an email
 * is truthfully theirs, is owned by lib/coordinatorSupporterOrders.ts and shared
 * with the live tracker and the XLSX sheet. This route re-derives none of it.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { isCampaignClosed } from '@/lib/campaignBundleSelection';
import {
    SUPPORTER_ORDER_SELECT,
    groupSupporterRows,
    isPickupDocumentOrder,
    pickupDocumentOrderWhere,
    pickupDocumentState,
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
                // COORD-CLOSEOUT-PICKUP-1: closeout is what makes this list final.
                status: true,
                closed_at: true,
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

        // The canonical closed-campaign authority (contract §11), from the
        // campaign row itself: closed_at, or a closed-family status.
        const closed = isCampaignClosed({ closed_at: campaign.closed_at, status: String(campaign.status) });

        // Never a canceled order. Closed: the final locked set, held or not.
        // Open: released work only — the shared production exclusions, composed
        // rather than restated. One where-clause for both pickup documents.
        const rows = await prisma.order.findMany({
            where: pickupDocumentOrderWhere(campaign.id, { closed }),
            orderBy: { created_at: 'asc' },
            select: SUPPORTER_ORDER_SELECT,
        });

        // Second line of defence. The where clause above is the primary gate;
        // re-checking each row in memory means a future change to that clause
        // cannot silently put a canceled order — or, before closeout, unreleased
        // food — on a pickup sheet.
        const listed = rows.filter((r) => isPickupDocumentOrder(r as any, { closed }));

        const groups = groupSupporterRows(listed as any, campaign.customer_id);

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
            // COORD-CLOSEOUT-PICKUP-1: what this document is — not final, or the
            // final list with its production-release state, derived from the
            // listed orders' own statuses (no invoice is read).
            document: {
                final: closed,
                state: pickupDocumentState({ closed }, listed as any),
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
