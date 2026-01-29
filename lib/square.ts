
import { prisma } from './db';

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

interface SquareOrder {
    id: string;
    created_at: string;
    state: string;
    line_items?: {
        uid: string;
        name: string;
        quantity: string;
        catalog_object_id?: string; // Square Item ID
        item_type?: string;
        variation_name?: string;
    }[];
    tenders?: { customer_id?: string }[];
    customer_id?: string;
}

export async function syncSquareOrders() {
    if (!SQUARE_ACCESS_TOKEN) {
        throw new Error('Internal Error: Missing Square Credentials');
    }

    // 0. Fetch Locations (Required for Order Search)
    const locRes = await fetch('https://connect.squareup.com/v2/locations', {
        headers: {
            'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
            'Square-Version': '2023-10-20'
        }
    });

    if (!locRes.ok) {
        throw new Error('Failed to fetch Square Locations');
    }

    const locData = await locRes.json();
    const locationIds = locData.locations?.map((l: any) => l.id) || [];

    if (locationIds.length === 0) {
        throw new Error('No Square Locations found.');
    }

    // 1. Fetch Orders from Square
    const response = await fetch('https://connect.squareup.com/v2/orders/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
            'Square-Version': '2023-10-20'
        },
        body: JSON.stringify({
            location_ids: locationIds, // Required field
            query: {
                filter: {
                    state_filter: { states: ['COMPLETED', 'OPEN'] },
                    date_time_filter: {
                        created_at: { start_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() } // Last 30 days
                    }
                },
                sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
            },
            limit: 50
        })
    });

    if (!response.ok) {
        const txt = await response.text();
        throw new Error(`Square API Failed: ${txt}`);
    }

    const data = await response.json();
    const sqOrders: SquareOrder[] = data.orders || [];

    // 2. Pre-fetch Map of Bundles (SKU -> ID)
    // We assume the Square Item Name or Variation Name might match our Bundle Name/SKU
    // Actually, SKU is best. Ideally we fetch Square Catalog to get SKUs, but that's an extra call.
    // ORDER items in Square usually have the name/variation name snapshot.
    // For this MVP, we will fuzzy match Name to Bundle Name.
    const allBundles = await prisma.bundle.findMany();

    let stats = { found: sqOrders.length, new: 0, skipped: 0 };

    for (const sqOrder of sqOrders) {

        // Check if exists
        const existing = await prisma.order.findUnique({ where: { external_id: sqOrder.id } });
        if (existing && existing.status === 'completed') {
            stats.skipped++;
            continue; // Already syncd and final
        }

        // Map Items
        // We need to transform Square Line Items into OrderItems
        // Expected Schema: OrderItem { quantity, bundle_id? }
        const orderItemsData: { quantity: number; bundle_id: string; variant_size: string }[] = [];

        if (sqOrder.line_items) {
            for (const item of sqOrder.line_items) {
                // Try to find matching Bundle by Name
                // Normalize names: "Family Bundle" vs "Family Pizza Bundle"
                const match = allBundles.find((b: { name: string; id: string }) =>
                    item.name.toLowerCase().includes(b.name.toLowerCase()) ||
                    b.name.toLowerCase().includes(item.name.toLowerCase())
                );

                if (match) {
                    orderItemsData.push({
                        quantity: Number(item.quantity),
                        bundle_id: match.id,
                        variant_size: 'serves_5' // Default for now
                    });
                }
            }
        }

        // If no recognizable bundles, we might still want to record the order?
        // For Production Hub, unrelated orders (like "Coffee") are noise.
        // Let's only save orders that have at least one matched Bundle.
        if (orderItemsData.length === 0) {
            stats.skipped++;
            continue;
        }

        const customerName = sqOrder.customer_id || 'Walk-in';

        // Transactional Upsert
        await prisma.$transaction(async (tx: any) => {
            // Delete existing items if updating
            if (existing) {
                await tx.orderItem.deleteMany({ where: { order_id: existing.id } });
            }

            const statusMap: Record<string, string> = {
                'COMPLETED': 'completed',
                'OPEN': 'pending',
                'CANCELED': 'completed' // treat canceled as done/ignored?
            };

            await tx.order.upsert({
                where: { external_id: sqOrder.id },
                create: {
                    external_id: sqOrder.id,
                    source: 'square',
                    status: (statusMap[sqOrder.state] || 'pending') as any,
                    customer_name: customerName,
                    created_at: new Date(sqOrder.created_at),
                    items: {
                        create: orderItemsData.map(i => ({
                            quantity: i.quantity,
                            bundle_id: i.bundle_id,
                            variant_size: 'serves_5'
                        }))
                    }
                },
                update: {
                    status: (statusMap[sqOrder.state] || 'pending') as any,
                    items: {
                        create: orderItemsData.map(i => ({
                            quantity: i.quantity,
                            bundle_id: i.bundle_id,
                            variant_size: 'serves_5'
                        }))
                    }
                }
            });
        });

        stats.new++;
    }

    return stats;
}
