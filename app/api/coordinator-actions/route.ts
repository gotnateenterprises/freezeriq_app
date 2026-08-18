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
import { requireCoordinatorSession } from '@/lib/coordinatorSession';

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
        // FR-COORD-SEC-1B: this used to take the coordinator credential in the
        // request body. Authority now comes from the session cookie, and the
        // guard also enforces the same-origin check this mutation needs.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;

        const body = await req.json();
        const { action_type, source, metadata } = body;

        // ── Validate ────────────────────────────────
        if (!action_type || !VALID_ACTION_TYPES.has(action_type)) {
            return NextResponse.json({ error: 'Invalid action_type' }, { status: 400 });
        }

        // ── Write event ─────────────────────────────
        await prisma.coordinatorActionEvent.create({
            data: {
                campaign_id: guard.campaignId,
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
