import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { uploadToS3 } from '@/lib/s3';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    try {
        const session = await auth();
        const userId = session?.user?.id;

        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 1. Get current user's business context
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { business_id: true }
        });

        if (!user?.business_id) {
            return NextResponse.json({ error: 'No business context found' }, { status: 400 });
        }

        // 2. Resolve branding for this business
        // We find the branding record linked to the business admin or any user in this business
        const business = await prisma.business.findUnique({
            where: { id: user.business_id },
            select: { slug: true, name: true }
        });

        const branding = await prisma.tenantBranding.findFirst({
            where: {
                user: { business_id: user.business_id }
            },
            include: {
                user: {
                    select: {
                        email: true,
                        phone: true,
                        address: true
                    }
                }
            },
            orderBy: { created_at: 'asc' }
        });

        if (!branding) {
            return NextResponse.json({
                business_name: business?.name || 'FreezerIQ',
                business_slug: business?.slug,
                tagline: 'Intelligence for your Kitchen.',
                logo_url: null,
                primary_color: '#10b981',
                secondary_color: '#6366f1',
                accent_color: '#f59e0b'
            });
        }

        return NextResponse.json({
            ...branding,
            business_slug: business?.slug
        });
    } catch (error) {
        console.error('Error fetching branding:', error);
        return NextResponse.json({ error: 'Failed to fetch branding' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    console.log('[API] POST /api/tenant/branding - Started');
    try {
        const session = await auth();
        const userId = session?.user?.id;

        if (!userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 1. Resolve business context
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { business_id: true }
        });

        if (!user?.business_id) {
            return NextResponse.json({ error: 'No business context' }, { status: 400 });
        }

        // 2. Find the branding record to update for this business
        // If Nate (SuperAdmin) is viewed as Tenant B, he should update Tenant B's branding
        let existingBranding = await prisma.tenantBranding.findFirst({
            where: {
                user: { business_id: user.business_id }
            },
            orderBy: { created_at: 'asc' }
        });

        const formData = await req.formData();
        const businessName = formData.get('business_name') as string;
        const tagline = formData.get('tagline') as string;
        const primaryColor = formData.get('primary_color') as string;
        const secondaryColor = formData.get('secondary_color') as string;
        const accentColor = formData.get('accent_color') as string;
        const thankYouNote = formData.get('thank_you_note') as string;
        const reviewPrompt = formData.get('review_prompt') as string;
        const signOff = formData.get('sign_off') as string;

        const logoFile = formData.get('logo') as File | null;
        const reviewQrFile = formData.get('review_qr') as File | null;

        let logoUrl: string | undefined;
        let reviewQrUrl: string | undefined;

        // Upload Logo
        if (logoFile && logoFile.size > 0) {
            const buffer = Buffer.from(await logoFile.arrayBuffer());
            const ext = logoFile.name.split('.').pop() || 'png';
            const safeName = `logo_${user.business_id}_${Date.now()}.${ext}`;
            logoUrl = await uploadToS3(buffer, safeName, logoFile.type || 'image/png');
        }

        // Upload QR
        if (reviewQrFile && reviewQrFile.size > 0) {
            const buffer = Buffer.from(await reviewQrFile.arrayBuffer());
            const ext = reviewQrFile.name.split('.').pop() || 'png';
            const safeName = `qr_${user.business_id}_${Date.now()}.${ext}`;
            reviewQrUrl = await uploadToS3(buffer, safeName, reviewQrFile.type || 'image/png');
        }

        // 3. Upsert Branding using business context
        // If we found an existing record for the business, update it.
        // Otherwise, create one for the current user.
        const branding = await prisma.tenantBranding.upsert({
            where: { user_id: existingBranding?.user_id || userId },
            create: {
                user_id: userId,
                business_name: businessName,
                tagline,
                primary_color: primaryColor,
                secondary_color: secondaryColor,
                accent_color: accentColor,
                thank_you_note: thankYouNote,
                review_prompt: reviewPrompt,
                sign_off: signOff,
                logo_url: logoUrl,
                review_qr_url: reviewQrUrl
            },
            update: {
                business_name: businessName,
                tagline,
                primary_color: primaryColor,
                secondary_color: secondaryColor,
                accent_color: accentColor,
                thank_you_note: thankYouNote,
                review_prompt: reviewPrompt,
                sign_off: signOff,
                ...(logoUrl && { logo_url: logoUrl }),
                ...(reviewQrUrl && { review_qr_url: reviewQrUrl }),
            }
        });

        return NextResponse.json(branding);

    } catch (error: any) {
        console.error('[BrandingAPI] Error:', error);
        return NextResponse.json({ error: 'Server Error', details: error.message }, { status: 500 });
    }
}
