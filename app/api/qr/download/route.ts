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
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl } from '@/lib/previousSupporterInvite';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';

export async function GET(req: Request) {
    try {
        // FR-COORD-SEC-1B: the coordinator credential used to arrive here as
        // ?token=<secret>, putting it into the query string of a logged request.
        // Authority now comes from the coordinator session cookie.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;

        // 1. Fetch campaign to validate token and get data for URL
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: guard.campaignId },
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

        // Build the supporter ordering URL through the canonical FR-REBOOK-2
        // authority (FR-COORD-123): tenant storefront domain preferred, pinned
        // platform origin otherwise — never the request host. A printed QR
        // outlives every deployment; the previous `new URL(req.url).origin`
        // baked whatever host happened to serve this request into paper.
        const businessId = campaign.customer?.business_id;
        let tenant: { slug: string | null; customDomain: string | null } = { slug: null, customDomain: null };
        if (businessId) {
            const business = await prisma.business.findUnique({
                where: { id: businessId },
                select: { slug: true, custom_domain: true },
            });
            if (business) tenant = { slug: business.slug, customDomain: business.custom_domain };
        }
        const publicUrl = buildSupporterOrderUrl(
            resolveOutreachOrigin(req),
            { id: campaign.id, public_token: campaign.public_token },
            tenant,
        );
        if (!publicUrl) {
            return NextResponse.json(
                { error: 'No supporter ordering page could be resolved for this campaign, so the QR code would be a dead end. Check the storefront configuration.' },
                { status: 422 }
            );
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
