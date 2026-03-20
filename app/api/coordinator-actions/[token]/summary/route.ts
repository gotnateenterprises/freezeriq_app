/**
 * Coordinator Action Summary — Read Route
 *
 * GET /api/coordinator-actions/[token]/summary
 *
 * Returns aggregate action counts and metadata for the Coordinator Portal
 * engagement insight block. Uses Prisma groupBy for efficient aggregation.
 *
 * ACCESS MODEL: Token-based (same as coordinator portal).
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export type CoordinatorActionSummary = {
    totalActions: number;
    lastActionAt: string | null;
    mostUsedAction: string | null;
    counts: {
        share_fundraiser: number;
        send_text_blast: number;
        share_facebook: number;
        copy_text_message: number;
        copy_facebook_post: number;
        copy_email_blurb: number;
        download_flyer: number;
        download_tracker: number;
        download_qr: number;
        download_packet: number;
    };
};

const DEFAULT_COUNTS: CoordinatorActionSummary['counts'] = {
    share_fundraiser: 0,
    send_text_blast: 0,
    share_facebook: 0,
    copy_text_message: 0,
    copy_facebook_post: 0,
    copy_email_blurb: 0,
    download_flyer: 0,
    download_tracker: 0,
    download_qr: 0,
    download_packet: 0,
};

// Human-friendly labels for the "most used" display
const ACTION_LABELS: Record<string, string> = {
    share_fundraiser: 'Share Fundraiser',
    send_text_blast: 'Text Blast',
    share_facebook: 'Facebook Share',
    copy_text_message: 'Copy Text',
    copy_facebook_post: 'Copy Facebook',
    copy_email_blurb: 'Copy Email',
    download_flyer: 'Download Flyer',
    download_tracker: 'Download Tracker',
    download_qr: 'Download QR',
    download_packet: 'Download Packet',
};

export async function GET(
    req: Request,
    { params }: { params: Promise<{ token: string }> }
) {
    try {
        const { token } = await params;

        // ── Resolve campaign ────────────────────────
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            select: { id: true },
        });
        if (!campaign) {
            return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
        }

        // ── Aggregate counts by action_type ─────────
        const grouped = await prisma.coordinatorActionEvent.groupBy({
            by: ['action_type'],
            where: { campaign_id: campaign.id },
            _count: { action_type: true },
        });

        // ── Get last action time ────────────────────
        const lastEvent = await prisma.coordinatorActionEvent.findFirst({
            where: { campaign_id: campaign.id },
            orderBy: { created_at: 'desc' },
            select: { created_at: true },
        });

        // ── Build response ──────────────────────────
        const counts = { ...DEFAULT_COUNTS };
        let totalActions = 0;
        let mostUsedAction: string | null = null;
        let mostUsedCount = 0;

        for (const row of grouped) {
            const key = row.action_type as keyof typeof DEFAULT_COUNTS;
            const count = row._count.action_type;
            if (key in counts) {
                counts[key] = count;
            }
            totalActions += count;
            if (count > mostUsedCount) {
                mostUsedCount = count;
                mostUsedAction = ACTION_LABELS[key] || key;
            }
        }

        const summary: CoordinatorActionSummary = {
            totalActions,
            lastActionAt: lastEvent?.created_at?.toISOString() ?? null,
            mostUsedAction,
            counts,
        };

        return NextResponse.json(summary);
    } catch (err) {
        console.error('[coordinator-actions] summary error:', err);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
