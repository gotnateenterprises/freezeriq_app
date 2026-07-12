/**
 * CB-6: Tenant Bundle Selection Reset
 *
 * POST /api/campaigns/[id]/bundle-selection/reset
 *
 * Resets a campaign's bundle selection to 'pending', allowing the coordinator
 * to select bundles again. Only permitted when zero non-canceled orders exist.
 *
 * ACCESS MODEL: Authenticated tenant session (not coordinator token).
 *
 * HISTORICAL ORDER SAFETY: This endpoint never touches orders or order_items.
 *
 * @module api/campaigns/[id]/bundle-selection/reset
 */

import { NextResponse } from 'next/server';
import { resetBundleSelection } from '@/lib/campaignBundleOverride';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { auth } = await import('@/auth');
    const session = await auth();

    if (!session?.user?.businessId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const businessId = session.user.businessId;
    const actorId = session.user.id ?? null;

    const result = await resetBundleSelection(id, businessId, actorId);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      message: 'Bundle selection has been reset. The coordinator can now select bundles again.',
      previousActiveBundleIds: result.previousActiveBundleIds,
    });
  } catch (e) {
    console.error('Tenant Bundle Selection Reset Error:', e);
    return NextResponse.json({ error: 'Server Error' }, { status: 500 });
  }
}
