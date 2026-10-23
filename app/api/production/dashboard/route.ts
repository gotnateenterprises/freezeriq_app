import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
// Phase 5H-0: ORDER_STATUS_COMPAT removed; all queries now use toDbOrderStatusReadCandidates.
import { toDbOrderStatusReadCandidates } from '@/lib/orderStatus';
// OPS-3: pure campaign-level aggregation for the fundraiser waiting lane.
import { buildFundraiserBatches } from '@/lib/fundraiserProductionBatch';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const businessId = session.user.businessId;

        // 1. Fetch PENDING orders (New Orders lane)
        // KB-1A: production_ready/APPROVED were previously included here as well, which
        // put an approved order in BOTH New Orders and To Prep and left it stuck in the
        // New Orders lane after approval. This lane is now unapproved orders only;
        // production_ready/APPROVED belong to the To Prep query below.
        const pendingOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                // KB-1B: soft-canceled orders never appear on the Kitchen Board.
                canceled_at: null,
                // Phase 5H-0: use helper so legacy PENDING rows are still matched
                // alongside canonical pending rows.
                status: { in: [
                    ...toDbOrderStatusReadCandidates('pending'),
                ] as any },
                // DD-0.1: held fundraiser orders stay out; released ones flow in.
                AND: [
                    { NOT: { status: 'fundraiser_hold' as any } },
                    { NOT: { source: 'storefront', status: 'pending' } },
                ]
            },
            include: {
                customer: {
                    select: { name: true, type: true }
                },
                items: {
                    include: {
                        bundle: {
                            select: { name: true, sku: true }
                        }
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        // 2. Fetch KITCHEN-APPROVED orders (Prep List)
        // Phase 5F: derive DB candidates via toDbOrderStatusReadCandidates so the
        // helper owns the mapping and no un-migrated enum values reach Prisma.
        //   production_ready → ['production_ready', 'APPROVED']
        //   in_production    → ['in_production', 'IN_PRODUCTION']  (Phase 5G-1: both forms exist)
        const prepListStatuses = [
            ...toDbOrderStatusReadCandidates('production_ready'),
            ...toDbOrderStatusReadCandidates('in_production'),
        ];
        const productionOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                // KB-1B: soft-canceled orders never appear on the Kitchen Board.
                canceled_at: null,
                status: { in: prepListStatuses as any },
                NOT: { status: 'fundraiser_hold' as any }
            },
            include: {
                // PREP-WAVES-1: which fundraiser each prep order belongs to, and when that
                // fundraiser delivers. The SAME explicit select the Packed & Ready lane
                // uses (PACKED-READY-WAVES-1): the campaign's own name and DATE and its
                // OWNING organization's name, nothing else of the campaign or the
                // organization. Null for an ordinary order. The WHERE above is untouched,
                // so which orders reach the kitchen cannot change. These orders are only
                // aggregated below; none of their other columns leave this route.
                campaign: {
                    select: {
                        id: true,
                        name: true,
                        delivery_date: true,
                        customer: { select: { name: true } },
                    }
                },
                items: {
                    include: {
                        bundle: {
                            select: {
                                id: true,
                                name: true,
                                sku: true,
                                contents: {
                                    include: {
                                        recipe: {
                                            select: { id: true, name: true, label_text: true }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        // 3. Fetch COMPLETED / READY-TO-SHIP orders (Delivery Queue)
        // Phase 5H-0: include both completed and ready_to_ship candidates.
        //   completed     → ['completed', 'COMPLETED']
        //   ready_to_ship → ['ready_to_ship', 'completed']  (old rows stored as 'completed')
        // Deduplicated: final set covers completed, COMPLETED, and ready_to_ship.
        const deliveryQueueStatuses = [
            ...new Set([
                ...toDbOrderStatusReadCandidates('completed'),
                ...toDbOrderStatusReadCandidates('ready_to_ship'),
            ])
        ];
        const completedOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                // KB-1B: soft-canceled orders never appear on the Kitchen Board.
                canceled_at: null,
                // OPS-6B: the lane's EXIT. Before this, nothing could ever leave
                // Packed & Ready — printing writes nothing, so orders accumulated
                // here forever while Delivery showed them too. An order leaves
                // only when someone deliberately clicks Send to Delivery, which
                // is the sole writer of this column
                // (app/api/delivery/handoff/route.ts). NULL means still in
                // Production's custody, which is true of every historical row.
                released_to_delivery_at: null,
                status: { in: deliveryQueueStatuses as any },
                NOT: { status: 'fundraiser_hold' as any }
            },
            include: {
                customer: {
                    select: { name: true, type: true, delivery_address: true }
                },
                // PACKED-READY-WAVES-1: which fundraiser is this order FOR, and when does
                // it deliver? The campaign's own name and DATE, and its OWNING
                // organization (`campaign.customer`, the same relation the outer-box label
                // and the Fundraisers Waiting lane read) — a different row from the
                // order's own `customer` above. Explicit select: nothing else of the
                // campaign or organization (contacts, notes, finances) rides along. Null
                // for an ordinary order. READ-ONLY and additive: the WHERE above is
                // untouched, so lane membership cannot change.
                campaign: {
                    select: {
                        id: true,
                        name: true,
                        delivery_date: true,
                        customer: { select: { name: true } },
                    }
                },
                items: {
                    include: {
                        bundle: {
                            select: { id: true, name: true, sku: true }
                        }
                    }
                }
            },
            orderBy: { created_at: 'asc' } // Oldest first for delivery
        });

        // Aggregate for Prep List - Group by Bundle AND Status
        //
        // PREP-WAVES-1 — THE AGGREGATE IS FOR THE KITCHEN; IT IS NOT AN ACTION SCOPE.
        // A row is still "this bundle, at this status and tier, across every order", because
        // combined demand is what the kitchen plans food from. What it used to do next was
        // throw away WHICH orders made that number (`order_ids` was collected here and
        // deleted from the response), so the screen could only say "start this bundle" and
        // the server matched every tenant order at that status containing the bundle —
        // every fundraiser that happened to share it. Each row now keeps its exact
        // `sources`: one entry per ORDER, with the campaign it belongs to and the
        // quantities and OrderItem ids it contributed (contract §6.2: campaign -> order ->
        // order item must survive aggregation). The client decides what may move, by order
        // id, through the existing exact-id route; nothing here widens what is returned
        // beyond ids, quantities and the campaign's own label fields.
        const prepCampaigns: Record<string, {
            id: string;
            name: string | null;
            delivery_date: Date | string | null;
            customer: { name: string | null } | null;
        }> = {};
        const prepMap = new Map<string, {
            bundle_id: string;
            bundle_name: string;
            sku: string;
            total_quantity: number;
            sources: Map<string, {
                order_id: string;
                source: string | null;
                campaign_id: string | null;
                quantity: number;
                order_item_ids: string[];
            }>;
            status: string;
            // OPS-5A: the sold tier this prep row was ordered at. Carried so the
            // meal labels PrepList prints can name it truthfully.
            variant_size: string | null;
            recipes: { id: string, name: string, quantity: number, label_text?: string | null }[];
        }>();

        productionOrders.forEach(order => {
            order.items.forEach(item => {
                if (!item.bundle) return;
                const bid = item.bundle.id;
                const status = order.status; // Group by usage status
                // OPS-5A: group by the SOLD TIER as well. OrderItem.variant_size
                // is the frozen snapshot of what was actually sold; two orders
                // of the same bundle at different tiers are different physical
                // meals and must not share a prep row, or the labels printed
                // from that row could not name a tier truthfully.
                //
                // In practice this splits nothing: CB-1 made Serves-2 and
                // Serves-5 separate Bundle rows paired by family_id, so one
                // bundle_id normally carries exactly one tier. It only splits
                // where the data genuinely disagrees -- which is precisely the
                // case where a merged row would have been a lie.
                const variantSize = (item as any).variant_size ?? null;
                const key = `${bid}-${status}-${variantSize ?? 'unknown'}`;

                if (!prepMap.has(key)) {
                    prepMap.set(key, {
                        bundle_id: bid,
                        bundle_name: item.bundle.name,
                        sku: item.bundle.sku,
                        total_quantity: 0,
                        sources: new Map(),
                        status: status,
                        variant_size: variantSize,
                        recipes: (item.bundle.contents || []).map(c => ({
                            id: c.recipe?.id || 'unknown',
                            name: c.recipe?.name || 'Unknown Recipe',
                            quantity: c.quantity || 1,
                            label_text: (c.recipe as any)?.label_text
                        }))
                    });
                }

                const entry = prepMap.get(key)!;
                entry.total_quantity += item.quantity;

                // The order's identity survives the aggregate. Two lines of the same bundle and
                // tier on one order are ONE source (its quantities add; both item ids are kept).
                // `source` and `campaign_id` are passed through raw: whether this is a
                // fundraiser order is the canonical classifier's question and is answered on
                // the client from exactly these two signals, never guessed here.
                const existing = entry.sources.get(order.id);
                if (existing) {
                    existing.quantity += item.quantity;
                    existing.order_item_ids.push(item.id);
                } else {
                    entry.sources.set(order.id, {
                        order_id: order.id,
                        source: (order.source as string | null) ?? null,
                        campaign_id: order.campaign_id ?? null,
                        quantity: item.quantity,
                        order_item_ids: [item.id],
                    });
                }
            });

            if (order.campaign_id && order.campaign && !prepCampaigns[order.campaign_id]) {
                prepCampaigns[order.campaign_id] = {
                    id: order.campaign.id,
                    name: order.campaign.name ?? null,
                    delivery_date: order.campaign.delivery_date ?? null,
                    customer: order.campaign.customer ? { name: order.campaign.customer.name ?? null } : null,
                };
            }
        });

        // ── OPS-3: the FUNDRAISER WAITING lane. ──────────────────────────────
        //
        //    Purely ADDITIVE. The three queries above are untouched, and they
        //    each already carry `NOT: { status: 'fundraiser_hold' }`. This query
        //    is `status: 'fundraiser_hold'` ONLY. The two sets are therefore
        //    mutually exclusive BY CONSTRUCTION on the same column — a held
        //    fundraiser order cannot appear in a customer lane, and a released
        //    one cannot appear here. There is no double-counting to police.
        //
        //    Held fundraiser orders were previously invisible everywhere: the
        //    kitchen board excluded them and nothing else showed them, so a
        //    tenant had no way to see committed fundraiser work that was waiting
        //    on payment. This lane is that view, grouped into ONE entry per
        //    campaign by lib/fundraiserProductionBatch.ts.
        //
        //    campaign_id is required, so an order that is somehow held without a
        //    campaign is left out rather than invented into a batch.
        const fundraiserHeldOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                canceled_at: null,
                status: 'fundraiser_hold' as any,
                campaign_id: { not: null },
            },
            select: {
                id: true,
                campaign_id: true,
                total_amount: true,
                items: {
                    select: {
                        id: true,
                        bundle_id: true,
                        quantity: true,
                        variant_size: true,
                        item_name: true,
                        bundle: { select: { id: true, name: true } },
                    },
                },
                campaign: {
                    select: {
                        id: true,
                        name: true,
                        delivery_date: true,
                        end_date: true,
                        customer: { select: { name: true } },
                        // INV-A: at most one per campaign (invoices_one_per_campaign).
                        invoices: { select: { id: true, status: true, paid_at: true } },
                    },
                },
            },
            orderBy: { created_at: 'desc' },
        });

        return NextResponse.json({
            pending: pendingOrders,
            prep: Array.from(prepMap.values()).map(({ sources, ...e }) => ({
                ...e,
                order_count: sources.size,
                // PREP-WAVES-1: the exact orders behind this row's number (see the aggregate's header).
                sources: Array.from(sources.values()),
            })),
            // PREP-WAVES-1: label data for the campaigns behind those sources, keyed by
            // FundraiserCampaign.id. Display only; the client never treats a name or date as a key.
            prepCampaigns,
            completed: completedOrders,
            fundraiserWaiting: buildFundraiserBatches(fundraiserHeldOrders as any),
        });

    } catch (e) {
        console.error("Dashboard API Error:", e);
        return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
    }
}
