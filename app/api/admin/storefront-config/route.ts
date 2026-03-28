import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { geocodeAddress } from '@/lib/delivery/zones';

// GET /api/admin/storefront-config
export async function GET(request: Request) {
    const session = await auth();
    if (!session?.user?.email) return new NextResponse('Unauthorized', { status: 401 });

    try {
        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: { business: true }
        });

        if (!user?.business) return new NextResponse('Business not found', { status: 404 });

        // Fetch business slug for preview links
        const business = await prisma.business.findUnique({
            where: { id: user.business.id },
            select: { slug: true, custom_domain: true } as any
        }) as any;

        const storefrontConfigs: any[] = await prisma.$queryRaw`
            SELECT hero_headline, hero_subheadline, hero_image_url, our_story_headline, our_story_content,
                   how_it_works_content, footer_text, marketing_video_url, trust_badges, testimonials,
                   upsell_bundle_id, upsell_title, upsell_description, upsell_discount_percent,
                   upsell_type, manual_upsell_name, manual_upsell_price, manual_upsell_image,
                   tax_percent, delivery_fee, is_delivery_enabled, is_pickup_enabled,
                   origin_address, origin_lat, origin_lng, id
            FROM storefront_configs
            WHERE business_id = ${user.business.id}
            LIMIT 1
        `;

        const config = storefrontConfigs[0] || null;

        // Fetch delivery zones if config exists
        let delivery_zones: any[] = [];
        if (config?.id) {
            delivery_zones = await prisma.$queryRaw`
                SELECT id, name, max_radius_miles, fee, sort_order
                FROM delivery_zones
                WHERE storefront_config_id = ${config.id}
                ORDER BY sort_order ASC
            `;
        }

        return NextResponse.json({
            ...config,
            delivery_zones,
            business_slug: business?.slug,
            custom_domain: business?.custom_domain
        });
    } catch (error) {
        console.error("Error fetching storefront config:", error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}

// POST /api/admin/storefront-config
export async function POST(request: Request) {
    const session = await auth();
    if (!session?.user?.email) return new NextResponse('Unauthorized', { status: 401 });

    try {
        const body = await request.json();
        const {
            hero_headline,
            hero_subheadline,
            hero_image_url,
            our_story_headline,
            our_story_content,
            how_it_works_content,
            footer_text,
            marketing_video_url,
            trust_badges,
            testimonials,
            upsell_bundle_id,
            upsell_title,
            upsell_description,
            upsell_discount_percent,
            upsell_type,
            manual_upsell_name,
            manual_upsell_price,
            manual_upsell_image,
            tax_percent,
            delivery_fee,
            is_delivery_enabled,
            is_pickup_enabled,
            origin_address,
            delivery_zones: rawDeliveryZones
        } = body;

        const user = await prisma.user.findUnique({
            where: { email: session.user.email },
            include: { business: true }
        });

        if (!user?.business) return new NextResponse('Business not found', { status: 404 });

        if (body.custom_domain !== undefined) {
            const cleanDomain = body.custom_domain ? body.custom_domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').trim().toLowerCase() : null;
            try {
                await prisma.business.update({
                    where: { id: user.business.id },
                    data: { custom_domain: cleanDomain } as any
                });
            } catch (domainError: any) {
                if (domainError.code === 'P2002') {
                    return NextResponse.json({ error: "Domain already in use by another business." }, { status: 400 });
                }
                console.error("Domain update failed", domainError);
            }
        }

        // Geocode origin address if provided
        let originLat: Prisma.Decimal | null = null;
        let originLng: Prisma.Decimal | null = null;
        if (origin_address && origin_address.trim()) {
            const geo = await geocodeAddress(origin_address.trim());
            if (geo) {
                originLat = new Prisma.Decimal(geo.lat.toFixed(7));
                originLng = new Prisma.Decimal(geo.lng.toFixed(7));
            }
        }

        const upsertQuery = `
            INSERT INTO storefront_configs (
                id, business_id, hero_headline, hero_subheadline, hero_image_url, 
                our_story_headline, our_story_content, how_it_works_content, 
                footer_text, marketing_video_url, trust_badges, testimonials,
                upsell_bundle_id, upsell_title, upsell_description, 
                upsell_discount_percent, upsell_type, manual_upsell_name, 
                manual_upsell_price, manual_upsell_image, 
                tax_percent, delivery_fee, is_delivery_enabled, is_pickup_enabled,
                origin_address, origin_lat, origin_lng,
                "updatedAt"
            ) VALUES (
                gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, NOW()
            )
            ON CONFLICT (business_id) DO UPDATE SET
                hero_headline = EXCLUDED.hero_headline,
                hero_subheadline = EXCLUDED.hero_subheadline,
                hero_image_url = EXCLUDED.hero_image_url,
                our_story_headline = EXCLUDED.our_story_headline,
                our_story_content = EXCLUDED.our_story_content,
                how_it_works_content = EXCLUDED.how_it_works_content,
                footer_text = EXCLUDED.footer_text,
                marketing_video_url = EXCLUDED.marketing_video_url,
                trust_badges = EXCLUDED.trust_badges,
                testimonials = EXCLUDED.testimonials,
                upsell_bundle_id = EXCLUDED.upsell_bundle_id,
                upsell_title = EXCLUDED.upsell_title,
                upsell_description = EXCLUDED.upsell_description,
                upsell_discount_percent = EXCLUDED.upsell_discount_percent,
                upsell_type = EXCLUDED.upsell_type,
                manual_upsell_name = EXCLUDED.manual_upsell_name,
                manual_upsell_price = EXCLUDED.manual_upsell_price,
                manual_upsell_image = EXCLUDED.manual_upsell_image,
                tax_percent = EXCLUDED.tax_percent,
                delivery_fee = EXCLUDED.delivery_fee,
                is_delivery_enabled = EXCLUDED.is_delivery_enabled,
                is_pickup_enabled = EXCLUDED.is_pickup_enabled,
                origin_address = EXCLUDED.origin_address,
                origin_lat = EXCLUDED.origin_lat,
                origin_lng = EXCLUDED.origin_lng,
                "updatedAt" = NOW()
            RETURNING *
        `;

        const values = [
            user.business.id,
            hero_headline,
            hero_subheadline,
            hero_image_url,
            our_story_headline,
            our_story_content,
            how_it_works_content,
            footer_text,
            marketing_video_url,
            JSON.stringify(trust_badges || {}),
            JSON.stringify(testimonials || []),
            upsell_bundle_id || null,
            upsell_title,
            upsell_description,
            Number(upsell_discount_percent),
            upsell_type,
            manual_upsell_name,
            manual_upsell_price ? new Prisma.Decimal(manual_upsell_price) : null,
            manual_upsell_image,
            tax_percent ? new Prisma.Decimal(tax_percent) : new Prisma.Decimal(0),
            delivery_fee ? new Prisma.Decimal(delivery_fee) : new Prisma.Decimal(0),
            is_delivery_enabled ?? true,
            is_pickup_enabled ?? true,
            origin_address?.trim() || null,
            originLat,
            originLng
        ];

        const results: any[] = await prisma.$queryRawUnsafe(upsertQuery, ...values);
        const savedConfig = results[0];

        // Handle delivery zones CRUD (delete-all + re-insert)
        if (rawDeliveryZones !== undefined && savedConfig?.id) {
            // Delete existing zones for this config
            await prisma.$executeRaw`
                DELETE FROM delivery_zones WHERE storefront_config_id = ${savedConfig.id}
            `;

            // Re-insert zones if provided
            const zonesArray = Array.isArray(rawDeliveryZones) ? rawDeliveryZones : [];
            for (let idx = 0; idx < zonesArray.length; idx++) {
                const z = zonesArray[idx];
                const zoneName = z.name || `Zone ${idx + 1}`;
                const maxRadius = Number(z.max_radius_miles) || 0;
                const zoneFee = Number(z.fee) || 0;
                await prisma.$executeRaw`
                    INSERT INTO delivery_zones (id, storefront_config_id, name, max_radius_miles, fee, sort_order)
                    VALUES (gen_random_uuid()::text, ${savedConfig.id}, ${zoneName}, ${maxRadius}, ${zoneFee}, ${idx})
                `;
            }
        }

        return NextResponse.json(savedConfig);
    } catch (error: any) {
        console.error("Error saving storefront config:", error?.message || error);
        return NextResponse.json(
            { error: error?.message || 'Internal Server Error' },
            { status: 500 }
        );
    }
}
