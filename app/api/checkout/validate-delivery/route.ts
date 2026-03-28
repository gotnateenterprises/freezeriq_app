/**
 * Pre-Checkout Delivery Validation Endpoint
 * 
 * POST /api/checkout/validate-delivery
 * 
 * Called from the checkout UI to check if a customer address
 * is within a delivery zone before submitting the order.
 * 
 * Public endpoint (no auth required) — scoped by business slug.
 * Does NOT create or modify any data.
 * 
 * Storefront-only. Not used by fundraiser checkout.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { geocodeAddress, resolveDeliveryZone } from '@/lib/delivery/zones';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { slug, address, city, state, zip } = body;

        if (!slug || !address || !city || !state || !zip) {
            return NextResponse.json(
                { error: 'Missing required fields: slug, address, city, state, zip' },
                { status: 400 }
            );
        }

        // Resolve business from slug
        const business = await prisma.business.findFirst({
            where: { slug },
            select: { id: true },
        });

        if (!business) {
            return NextResponse.json({ error: 'Store not found' }, { status: 404 });
        }

        // Load storefront config with delivery zones
        const config = await prisma.storefrontConfig.findUnique({
            where: { business_id: business.id },
            include: {
                delivery_zones: {
                    orderBy: { sort_order: 'asc' },
                },
            },
        });

        if (!config || !config.is_delivery_enabled) {
            return NextResponse.json(
                { deliverable: false, error: 'This store is not currently offering delivery.' },
                { status: 200 }
            );
        }

        // If no zones configured, use flat fee (backward compatible)
        if (config.delivery_zones.length === 0) {
            return NextResponse.json({
                deliverable: true,
                zoneName: 'Standard',
                fee: Number(config.delivery_fee),
                distanceMiles: null, // no distance calc without origin
            });
        }

        // Zones exist — need origin address
        if (!config.origin_lat || !config.origin_lng) {
            console.warn('[VALIDATE_DELIVERY] Zones configured but no origin coordinates for business:', business.id);
            // Fallback to flat fee rather than blocking checkout
            return NextResponse.json({
                deliverable: true,
                zoneName: 'Standard',
                fee: Number(config.delivery_fee),
                distanceMiles: null,
            });
        }

        // Geocode customer address
        const fullAddress = `${address}, ${city}, ${state} ${zip}`;
        const geo = await geocodeAddress(fullAddress);

        if (!geo) {
            return NextResponse.json(
                { deliverable: false, error: 'We couldn\'t verify this address. Please check and try again.' },
                { status: 200 }
            );
        }

        // Resolve zone
        const zones = config.delivery_zones.map(z => ({
            id: z.id,
            name: z.name,
            max_radius_miles: Number(z.max_radius_miles),
            fee: Number(z.fee),
            sort_order: z.sort_order,
        }));

        const result = resolveDeliveryZone(
            Number(config.origin_lat),
            Number(config.origin_lng),
            geo.lat,
            geo.lng,
            zones
        );

        return NextResponse.json(result);

    } catch (error) {
        console.error('[VALIDATE_DELIVERY] Error:', error);
        return NextResponse.json(
            { error: 'Failed to validate delivery address' },
            { status: 500 }
        );
    }
}
