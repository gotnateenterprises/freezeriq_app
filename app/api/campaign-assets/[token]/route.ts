/**
 * Campaign Assets API
 *
 * GET /api/campaign-assets/[token]
 *
 * Returns normalized asset metadata for the coordinator portal Sales Toolkit.
 * Token-based access (portal_token) — no session required.
 * Matches the same access model as the coordinator portal.
 */

import { NextResponse } from 'next/server';
import { getCampaignAssetsByToken } from '@/lib/campaignAssets';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    // 1. Validate token
    if (!token || token.trim().length === 0) {
      return NextResponse.json(
        { error: 'Missing campaign token' },
        { status: 400 }
      );
    }

    // 2. Fetch asset metadata
    const result = await getCampaignAssetsByToken(token);

    // 3. Campaign not found
    if (!result) {
      return NextResponse.json(
        { error: 'Campaign not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[campaign-assets] Error:', error?.message);
    return NextResponse.json(
      { error: error?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
