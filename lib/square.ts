
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
        catalog_object_id?: string;
        sku?: string;
        note?: string;
        item_type?: string;
        variation_name?: string;
    }[];
    customer_id?: string;
    fulfillments?: {
        type: string;
        state: string;
        shipment_details?: { recipient?: any };
        pickup_details?: { recipient?: any };
    }[];
    tenders?: {
        card_details?: {
            card?: {
                cardholder_name?: string;
            }
        }
    }[];
}

/**
 * Fetches customer details from Square API
 */
async function fetchSquareCustomer(customerId: string, accessToken: string) {
    try {
        const res = await fetch(`https://connect.squareup.com/v2/customers/${customerId}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Square-Version': '2023-10-20'
            }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.customer;
    } catch (e) {
        console.error("Failed to fetch Square customer", e);
        return null;
    }
}

export async function syncSquareOrders(businessId?: string) {
    console.log(`[SquareSync] Starting sync for business: ${businessId || 'GLOBAL'}`);
    let accessToken = SQUARE_ACCESS_TOKEN;

    // Multi-tenant check: Fetch token from DB if businessId provided
    if (businessId) {
        const integration = await prisma.integration.findUnique({
            where: {
                business_id_provider: {
                    business_id: businessId,
                    provider: 'square'
                }
            }
        });
        if (integration) {
            accessToken = integration.access_token;
        }
    }

    if (!accessToken) {
        throw new Error('Missing Square Credentials. Please connect Square in Settings.');
    }

    // 0. Fetch Locations
    const locRes = await fetch('https://connect.squareup.com/v2/locations', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Square-Version': '2023-10-20'
        }
    });

    if (!locRes.ok) {
        throw new Error('Failed to fetch Square Locations. Token might be invalid or expired.');
    }

    const locData = await locRes.json();
    const locationIds = locData.locations?.map((l: any) => l.id) || [];

    // 1. Fetch Orders from Square (Last 30 days)
    const response = await fetch('https://connect.squareup.com/v2/orders/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'Square-Version': '2023-10-20'
        },
        body: JSON.stringify({
            location_ids: locationIds,
            query: {
                filter: {
                    state_filter: { states: ['COMPLETED', 'OPEN'] },
                    date_time_filter: {
                        created_at: { start_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() }
                    }
                },
                sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
            },
            limit: 50
        })
    });

    if (!response.ok) {
        throw new Error(`Square API Search Failed: ${await response.text()}`);
    }

    const data = await response.json();
    const sqOrders: SquareOrder[] = data.orders || [];
    console.log(`[SquareSync] Found ${sqOrders.length} orders in Square (last 7 days).`);

    if (sqOrders.length > 0) {
        console.log(`[SquareSync] Diagnostic (First Order ID: ${sqOrders[0].id}):`, JSON.stringify({
            keys: Object.keys(sqOrders[0]),
            first_item: sqOrders[0].line_items?.[0] ? Object.keys(sqOrders[0].line_items[0]) : 'none',
            first_item_name: sqOrders[0].line_items?.[0]?.name,
            first_item_note: sqOrders[0].line_items?.[0]?.note,
            tenders: sqOrders[0].tenders?.map(t => Object.keys(t))
        }, null, 2));
    }

    // 2. Pre-fetch Map of Bundles
    const allBundles = await prisma.bundle.findMany({
        where: businessId ? { business_id: businessId } : {}
    });

    let stats = { found: sqOrders.length, new: 0, updated: 0, skipped: 0 };
    const customerCache = new Map<string, any>();

    for (const sqOrder of sqOrders) {
        // Check if exists
        const existing = await prisma.order.findUnique({
            where: { external_id: sqOrder.id },
            include: { customer: true }
        });

        // Resolve Customer Info
        let customerName = 'Walk-in';
        let customerIdStr = sqOrder.customer_id || '';
        let customerEmail = '';
        let customerPhone = '';

        // 1. Try Fulfillments first (often has details even if no ID linked)
        const fulfillmentRecip = sqOrder.fulfillments?.[0]?.shipment_details?.recipient || sqOrder.fulfillments?.[0]?.pickup_details?.recipient;
        if (fulfillmentRecip) {
            customerName = fulfillmentRecip.display_name || `${fulfillmentRecip.given_name || ''} ${fulfillmentRecip.family_name || ''}`.trim() || customerName;
            customerEmail = fulfillmentRecip.email_address || '';
            customerPhone = fulfillmentRecip.phone_number || '';
            console.log(`[SquareSync] Found customer in fulfillment: ${customerName}`);
        }

        // 2. Fetch from Customer API if ID present and name still generic
        if (customerIdStr && (customerName === 'Walk-in' || !customerEmail)) {
            let sqCustomer = customerCache.get(customerIdStr);
            if (!sqCustomer) {
                sqCustomer = await fetchSquareCustomer(customerIdStr, accessToken);
                if (sqCustomer) customerCache.set(customerIdStr, sqCustomer);
            }

            if (sqCustomer) {
                customerName = sqCustomer.given_name || sqCustomer.family_name
                    ? `${sqCustomer.given_name || ''} ${sqCustomer.family_name || ''}`.trim()
                    : sqCustomer.email_address || customerName;
                customerEmail = sqCustomer.email_address || customerEmail;
                customerPhone = sqCustomer.phone_number || customerPhone;
                console.log(`[SquareSync] Fetched customer details for ID ${customerIdStr}: ${customerName}`);
            }
        }

        // 3. Fallback to Tender cardholder name (for POS walk-ins)
        if (customerName === 'Walk-in' && sqOrder.tenders?.[0]?.card_details?.card?.cardholder_name) {
            customerName = sqOrder.tenders[0].card_details.card.cardholder_name;
            console.log(`[SquareSync] Found cardholder name in tender: ${customerName}`);
        }

        // Retroactive update check: Update if name is generic OR if we found a better name
        const isGeneric = !existing?.customer_name || existing.customer_name === 'Walk-in' || existing.customer_name.length < 3;
        const infoChanged = existing && customerName !== 'Walk-in' && existing.customer_name !== customerName;

        if (existing && existing.status === 'completed' && !infoChanged && !isGeneric) {
            stats.skipped++;
            continue;
        }

        // Sync to Customer Table
        let linkedCustomerId: string | null = null;
        if (customerName !== 'Walk-in' || customerIdStr) {
            const customer = await prisma.customer.upsert({
                where: { external_id: customerIdStr || `SQUARE-REF-${sqOrder.id}` },
                create: {
                    external_id: customerIdStr || `SQUARE-REF-${sqOrder.id}`,
                    name: customerName,
                    contact_email: customerEmail,
                    contact_phone: customerPhone,
                    source: 'Square',
                    status: 'LEAD',
                    business_id: businessId
                },
                update: {
                    name: customerName,
                    contact_email: customerEmail,
                    contact_phone: customerPhone
                }
            });
            linkedCustomerId = customer.id;
        }

        // Map Items
        const orderItemsData: { quantity: number; bundle_id: string; variant_size: string }[] = [];
        if (sqOrder.line_items) {
            for (const item of sqOrder.line_items) {
                const variationInclusion = item.variation_name ? `${item.name} (${item.variation_name})` : item.name;
                const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
                const normalizedItem = normalize(variationInclusion);

                // Match Hierarchy: SKU -> Note -> Name Substring
                const match = allBundles.find((b: { name: string; id: string; sku: string }) => {
                    const normalizedBundleSku = b.sku?.toLowerCase();

                    // 1. Direct SKU match (Square line-item SKU)
                    if (item.sku && normalizedBundleSku && item.sku.toLowerCase() === normalizedBundleSku) return true;

                    // 2. Note contains SKU (Common for custom items)
                    if (item.note && normalizedBundleSku && item.note.toLowerCase().includes(normalizedBundleSku)) return true;

                    // 3. Catalog Object ID contains SKU (Some integrations map it here)
                    if (item.catalog_object_id && normalizedBundleSku && item.catalog_object_id.toLowerCase().includes(normalizedBundleSku)) return true;

                    // 4. Bidirectional Name Match
                    const normalizedBundle = normalize(b.name);
                    return normalizedItem.includes(normalizedBundle) || normalizedBundle.includes(normalizedItem);
                });

                if (match) {
                    orderItemsData.push({
                        quantity: Number(item.quantity),
                        bundle_id: match.id,
                        variant_size: variationInclusion.toLowerCase().includes('serves 2') ? 'serves_2' : 'serves_5'
                    });
                }
            }
        }

        // We allow sync even if NO items match, just to get the customer data

        // Transactional Upsert
        await prisma.$transaction(async (tx: any) => {
            // Delete existing items if updating to ensure fresh list
            if (existing) {
                await tx.orderItem.deleteMany({ where: { order_id: existing.id } });
            }

            const statusMap: Record<string, string> = {
                'COMPLETED': 'completed',
                'OPEN': 'pending',
                'CANCELED': 'completed'
            };

            await tx.order.upsert({
                where: { external_id: sqOrder.id },
                create: {
                    external_id: sqOrder.id,
                    source: 'square',
                    status: (statusMap[sqOrder.state] || 'pending') as any,
                    customer_name: customerName,
                    customer_id: linkedCustomerId,
                    created_at: new Date(sqOrder.created_at),
                    business_id: businessId,
                    items: {
                        create: orderItemsData
                    }
                },
                update: {
                    status: (statusMap[sqOrder.state] || 'pending') as any,
                    customer_name: customerName,
                    customer_id: linkedCustomerId,
                    items: {
                        create: orderItemsData
                    }
                }
            });
        });

        if (existing) stats.updated++;
        else stats.new++;
    }

    // Final Statistical cleanup of broken orders with no items
    const brokenCount = await prisma.order.deleteMany({
        where: {
            source: 'square' as any,
            items: { none: {} },
            created_at: { lt: new Date(Date.now() - 48 * 60 * 60 * 1000) } // Older than 48h
        }
    });
    if (brokenCount.count > 0) {
        console.log(`[DashboardCleanup] Removed ${brokenCount.count} Square orders with no items.`);
    }

    return stats;
}
