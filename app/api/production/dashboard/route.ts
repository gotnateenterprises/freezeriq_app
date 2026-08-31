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
                status: { in: deliveryQueueStatuses as any },
                NOT: { status: 'fundraiser_hold' as any }
            },
            include: {
                customer: {
                    select: { name: true, type: true, delivery_address: true }
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
        const prepMap = new Map<string, {
            bundle_id: string;
            bundle_name: string;
            sku: string;
            total_quantity: number;
            order_ids: Set<string>;
            status: string;
            recipes: { id: string, name: string, quantity: number, label_text?: string | null }[];
        }>();

        productionOrders.forEach(order => {
            order.items.forEach(item => {
                if (!item.bundle) return;
                const bid = item.bundle.id;
                const status = order.status; // Group by usage status
                const key = `${bid}-${status}`;

                if (!prepMap.has(key)) {
                    prepMap.set(key, {
                        bundle_id: bid,
                        bundle_name: item.bundle.name,
                        sku: item.bundle.sku,
                        total_quantity: 0,
                        order_ids: new Set<string>(),
                        status: status,
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
                entry.order_ids.add(order.id);
            });
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
            prep: Array.from(prepMap.values()).map(({ order_ids, ...e }) => ({ ...e, order_count: order_ids.size })),
            completed: completedOrders,
            fundraiserWaiting: buildFundraiserBatches(fundraiserHeldOrders as any),
        });

    } catch (e) {
        console.error("Dashboard API Error:", e);
        return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
    }
}
