/**
 * Bundle Totals API
 *
 * ACCESS MODEL: Session-authenticated (tenant only)
 * ACTOR: Business owner / tenant user
 * SCOPE: Single campaign by ID, tenant-scoped via business_id
 *
 * PURPOSE: Aggregates order item quantities per bundle for a given campaign.
 * Used by the tenant fundraiser overview to show how many of each bundle
 * have been ordered.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: campaignId } = await params;
        const businessId = (session.user as any).businessId;

        if (!businessId) {
            return NextResponse.json({ error: 'No business context' }, { status: 403 });
        }

        // Verify campaign belongs to this tenant
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: {
                id: campaignId,
                customer: { business_id: businessId }
            },
            select: { id: true }
        });

        if (!campaign) {
            return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
        }

        // Aggregate order items by bundle for this campaign
        const items = await prisma.orderItem.findMany({
            where: {
                order: { campaign_id: campaignId }
            },
            select: {
                bundle_id: true,
                quantity: true,
                bundle: { select: { id: true, name: true } }
            }
        });

        // Group by bundle
        const bundleMap = new Map<string, { bundleId: string; bundleName: string; totalQuantity: number }>();
        let grandTotal = 0;

        for (const item of items) {
            if (!item.bundle_id) continue;
            const key = item.bundle_id;
            if (!bundleMap.has(key)) {
                bundleMap.set(key, {
                    bundleId: item.bundle_id,
                    bundleName: item.bundle?.name || 'Unknown Bundle',
                    totalQuantity: 0
                });
            }
            bundleMap.get(key)!.totalQuantity += item.quantity;
            grandTotal += item.quantity;
        }

        return NextResponse.json({
            bundleTotals: Array.from(bundleMap.values()),
            grandTotal
        });

    } catch (e: any) {
        console.error('Bundle Totals Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to fetch bundle totals' },
            { status: 500 }
        );
    }
}
