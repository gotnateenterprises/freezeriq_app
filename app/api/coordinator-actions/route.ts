/**
 * Coordinator Action Event — Write Route
 *
 * POST /api/coordinator-actions
 *
 * Writes a lightweight event when the coordinator performs a trackable action
 * (share, copy, download) in the Coordinator Portal.
 *
 * ACCESS MODEL: Token-based (same as coordinator portal).
 * The coordinator portal_token is passed in the body to resolve the campaign.
 *
 * This route is fire-and-forget from the client; failures must not block UX.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

const VALID_ACTION_TYPES = new Set([
    'share_fundraiser',
    'send_text_blast',
    'share_facebook',
    'copy_text_message',
    'copy_facebook_post',
    'copy_email_blurb',
    'download_flyer',
    'download_tracker',
    'download_qr',
    'download_packet',
]);

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { token, action_type, source, metadata } = body;

        // ── Validate ────────────────────────────────
        if (!token || typeof token !== 'string') {
            return NextResponse.json({ error: 'Missing token' }, { status: 400 });
        }
        if (!action_type || !VALID_ACTION_TYPES.has(action_type)) {
            return NextResponse.json({ error: 'Invalid action_type' }, { status: 400 });
        }

        // ── Resolve campaign from portal_token ──────
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            select: { id: true },
        });
        if (!campaign) {
            return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
        }

        // ── Write event ─────────────────────────────
        await prisma.coordinatorActionEvent.create({
            data: {
                campaign_id: campaign.id,
                action_type,
                source: source || null,
                metadata: metadata || null,
            },
        });

        return NextResponse.json({ ok: true }, { status: 201 });
    } catch (err) {
        console.error('[coordinator-actions] write error:', err);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
