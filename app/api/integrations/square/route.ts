
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const payload = await req.json();
        console.log(`Processing Square Order: ${payload.order_id}`);

        // 1. Transaction to Create Order & Link Items
        const result = await prisma.$transaction(async (tx) => {

            // Create the Order Record
            const order = await tx.order.create({
                data: {
                    external_id: payload.order_id,
                    source: 'square',
                    customer_name: payload.customer_name || 'Walk-in Customer',
                    status: 'pending',
                    total_amount: payload.total_money?.amount ? (payload.total_money.amount / 100) : 0,
                    created_at: payload.created_at ? new Date(payload.created_at) : new Date()
                }
            });

            const stats = {
                matched: 0,
                failed: 0
            };

            // Process Line Items
            for (const item of payload.line_items) {
                // Try to find Bundle by SKU
                let bundle = null;

                if (item.catalog_object_id) {
                    // In real Square this is an ID, but we map it to our SKU for simulation
                    // Or we assume the payload includes the SKU in 'item.sku' if simplified
                    // For this simulation, let's try to match SKU
                    bundle = await tx.bundle.findUnique({ where: { sku: item.catalog_object_id } });
                }

                // Fallback: Fuzzy Name Match if no SKU or SKU failed
                if (!bundle) {
                    // Try exact name match first
                    bundle = await tx.bundle.findFirst({
                        where: {
                            name: { equals: item.name, mode: 'insensitive' }
                        }
                    });
                }

                // Fallback: Try SKU as name (common in simulations)
                if (!bundle) {
                    bundle = await tx.bundle.findUnique({ where: { sku: item.name } });
                }

                if (bundle) {
                    // Detect Variant (Family vs Couple) - Logic could be improved with dedicated variants
                    // For now, if the item name contains specific keywords, we override?
                    // Or we just trust the Bundle's default size.

                    // Simple logic: We matched a Bundle.
                    await tx.orderItem.create({
                        data: {
                            order_id: order.id,
                            bundle_id: bundle.id,
                            quantity: Number(item.quantity),
                            variant_size: bundle.serving_tier === 'couple' ? 'serves_2' : 'serves_5' // Default to bundle's setting
                        }
                    });
                    stats.matched++;
                } else {
                    console.warn(`FAILED TO MATCH: ${item.name}`);
                    stats.failed++;
                }
            }

            return { order, stats };
        });

        return NextResponse.json({ success: true, ...result });

    } catch (e: any) {
        console.error(e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
