import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';

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
                   upsell_type, manual_upsell_name, manual_upsell_price, manual_upsell_image
            FROM storefront_configs
            WHERE business_id = ${user.business.id}
            LIMIT 1
        `;

        const config = storefrontConfigs[0] || null;

        return NextResponse.json({
            ...config,
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
            manual_upsell_image
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

        const upsertQuery = `
            INSERT INTO storefront_configs (
                business_id, hero_headline, hero_subheadline, hero_image_url, 
                our_story_headline, our_story_content, how_it_works_content, 
                footer_text, marketing_video_url, trust_badges, testimonials,
                upsell_bundle_id, upsell_title, upsell_description, 
                upsell_discount_percent, upsell_type, manual_upsell_name, 
                manual_upsell_price, manual_upsell_image, "updatedAt"
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
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
            manual_upsell_image
        ];

        const results: any[] = await prisma.$queryRawUnsafe(upsertQuery, ...values);

        return NextResponse.json(results[0]);
    } catch (error) {
        console.error("Error saving storefront config:", error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
