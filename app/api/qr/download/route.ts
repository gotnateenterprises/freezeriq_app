/**
 * QR Code Download API
 *
 * ACCESS MODEL: Token-based (no session auth)
 * - GET gated by `portal_token` on FundraiserCampaign
 * - Returns a PNG image of the campaign's QR code
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from portal_token)
 *
 * Mirrors the auth/data pattern of /api/flyer/download.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { generateQrCode } from '@/lib/generateQrCode';
import { buildPublicFundraiserUrl } from '@/lib/fundraiserUrls';

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const token = searchParams.get('token');

        if (!token) {
            return NextResponse.json(
                { error: 'Missing token parameter' },
                { status: 400 }
            );
        }

        // 1. Fetch campaign to validate token and get data for URL
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            select: {
                id: true,
                public_token: true,
                customer: {
                    select: { name: true, business_id: true },
                },
            },
        });

        if (!campaign) {
            return NextResponse.json(
                { error: 'Campaign not found' },
                { status: 404 }
            );
        }

        const orgName = campaign.customer?.name || 'Organization';

        // Build public URL → shop order page (not the old scoreboard)
        const businessId = campaign.customer?.business_id;
        let publicUrl: string;
        if (businessId) {
            const business = await prisma.business.findUnique({
                where: { id: businessId },
                select: { slug: true },
            });
            if (business?.slug) {
                const origin = new URL(req.url).origin;
                publicUrl = `${origin}/shop/${business.slug}/fundraiser/${campaign.id}`;
            } else {
                publicUrl = buildPublicFundraiserUrl(req, campaign.public_token!);
            }
        } else {
            publicUrl = buildPublicFundraiserUrl(req, campaign.public_token!);
        }

        // 2. Generate QR code
        const qr = await generateQrCode(publicUrl);

        // 3. Return PNG download
        const safeOrgName = orgName.replace(/[^a-zA-Z0-9_-]/g, '_');

        return new NextResponse(new Uint8Array(qr.pngBuffer), {
            headers: {
                'Content-Type': 'image/png',
                'Content-Disposition': `attachment; filename="${safeOrgName}-qr-code.png"`,
            },
        });
    } catch (e: any) {
        console.error('QR Download Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to generate QR code' },
            { status: 500 }
        );
    }
}
