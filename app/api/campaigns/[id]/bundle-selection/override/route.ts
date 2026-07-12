/**
 * CB-6: Tenant Bundle Selection Controlled Override
 *
 * POST /api/campaigns/[id]/bundle-selection/override
 *
 * Performs a controlled override of a campaign's bundle selection after
 * orders already exist. Replaces active bundle assignments for future
 * orders only. Existing orders remain byte-for-byte unchanged.
 *
 * ACCESS MODEL: Authenticated tenant session (not coordinator token).
 *
 * REQUEST BODY:
 *   { familyIds: string[], reason: string }
 *
 * HISTORICAL ORDER SAFETY: This endpoint never touches orders or order_items.
 * Existing order items retain their original bundle_id, unit_price, quantity,
 * and item_name.
 *
 * @module api/campaigns/[id]/bundle-selection/override
 */

import { NextResponse } from 'next/server';
import { overrideBundleSelection } from '@/lib/campaignBundleOverride';

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

    // Parse request body
    let body: { familyIds?: unknown; reason?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { familyIds, reason } = body;

    // Type validation
    if (!Array.isArray(familyIds)) {
      return NextResponse.json({ error: 'familyIds must be an array' }, { status: 400 });
    }

    if (typeof reason !== 'string') {
      return NextResponse.json({ error: 'A reason is required for this change' }, { status: 400 });
    }

    // Sanitize: keep only non-empty strings, deduplicate
    const cleanFamilyIds = familyIds.filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    );

    const result = await overrideBundleSelection(id, businessId, cleanFamilyIds, reason, actorId);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      success: true,
      message: 'Bundle selection has been updated for future orders.',
      previousFamilyIds: result.previousFamilyIds,
      previousActiveBundleIds: result.previousActiveBundleIds,
      newFamilyIds: result.newFamilyIds,
      newActiveBundleIds: result.newActiveBundleIds,
      existingOrderCount: result.existingOrderCount,
    });
  } catch (e) {
    console.error('Tenant Bundle Selection Override Error:', e);
    return NextResponse.json({ error: 'Server Error' }, { status: 500 });
  }
}
