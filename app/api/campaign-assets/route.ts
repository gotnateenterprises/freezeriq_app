/**
 * GET /api/campaign-assets
 *
 * Returns the coordinator's downloadable asset metadata for the campaign their
 * session is bound to.
 *
 * FR-COORD-SEC-1B — ACCESS MODEL CHANGED. This route used to be
 * /api/campaign-assets/[token] and authenticated from the coordinator
 * credential in the URL path, which Vercel records. It now authenticates from
 * the coordinator session cookie and carries no credential at all.
 */
import { NextResponse } from 'next/server';
import { getCampaignAssetsByCampaignId } from '@/lib/campaignAssets';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';

export async function GET(req: Request) {
    try {
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;

        const result = await getCampaignAssetsByCampaignId(guard.campaignId);
        if (!result) {
            return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
        }

        return NextResponse.json(result);
    } catch (err) {
        console.error('[campaign-assets] error:', err);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
