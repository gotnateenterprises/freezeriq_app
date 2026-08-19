import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;

        // Verify campaign ownership
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { id },
            include: { customer: { select: { business_id: true } } }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
        }

        if (campaign.customer.business_id !== session.user.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        // Fetch assigned bundle IDs
        const assignments = await (prisma as any).campaignBundle.findMany({
            where: { campaign_id: id, state: 'active' },
            orderBy: { position: 'asc' },
            select: { bundle_id: true, position: true }
        });

        return NextResponse.json({
            campaignId: id,
            bundleIds: assignments.map((a: any) => a.bundle_id)
        });

    } catch (e) {
        console.error("Campaign Bundles GET Error:", e);
        return NextResponse.json({ error: "Server Error" }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;

        // Safe JSON parse — reject malformed request body
        let body: any;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const { bundleIds: rawBundleIds } = body;

        if (!Array.isArray(rawBundleIds)) {
            return NextResponse.json({ error: "bundleIds must be an array" }, { status: 400 });
        }

        // Sanitize: keep only non-empty strings, deduplicate
        const bundleIds = [...new Set(
            rawBundleIds.filter((id: unknown): id is string =>
                typeof id === 'string' && id.trim().length > 0
            )
        )];

        // Verify campaign ownership
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { id },
            include: { customer: { select: { business_id: true } } }
        });

        if (!campaign) {
            return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
        }

        if (campaign.customer.business_id !== session.user.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        // Validate all bundle IDs belong to the same business
        if (bundleIds.length > 0) {
            const validBundles = await prisma.bundle.findMany({
                where: {
                    id: { in: bundleIds },
                    business_id: session.user.businessId
                },
                select: { id: true }
            });

            const validIds = new Set(validBundles.map(b => b.id));
            const invalid = bundleIds.filter((bid: string) => !validIds.has(bid));

            if (invalid.length > 0) {
                return NextResponse.json({
                    error: `Invalid bundle IDs: ${invalid.join(', ')}`
                }, { status: 400 });
            }
        }

        // Replace the ACTIVE assignments in a transaction.
        // Empty bundleIds array = clear all active assignments = storefront falls back
        // to all active bundles.
        //
        // FR-FLOW-2B — `state: 'active'` on BOTH statements is load-bearing, not
        // decoration. CampaignBundle holds two different things in one table:
        // 'candidate' is the tenant's approved bundle-family pool, which the
        // coordinator has not chosen from yet, and 'active' is the concrete
        // sellable assignment. This endpoint edits the sellable list only — its own
        // GET above has always read `state: 'active'`, so that is the contract.
        //
        // Without the filter the delete took the candidate pool with it and the
        // create wrote rows back with the default state ('active'), so a campaign
        // awaiting coordinator setup came out of this route with no pool to choose
        // from and a set of bundles already on sale — while bundle_selection_status
        // still said 'pending'. That was survivable only while nothing in
        // production had a candidate pool. FR-FLOW-2 creates them, so it is not
        // survivable now.
        await prisma.$transaction([
            (prisma as any).campaignBundle.deleteMany({
                where: { campaign_id: id, state: 'active' }
            }),
            ...(bundleIds.length > 0
                ? [(prisma as any).campaignBundle.createMany({
                    data: bundleIds.map((bundleId: string, index: number) => ({
                        campaign_id: id,
                        bundle_id: bundleId,
                        state: 'active',
                        position: index
                    }))
                })]
                : [])
        ]);

        return NextResponse.json({
            campaignId: id,
            bundleIds,
            assigned: bundleIds.length,
            message: bundleIds.length > 0
                ? `${bundleIds.length} bundle(s) assigned`
                : "All assignments cleared — storefront will show all active bundles"
        });

    } catch (e) {
        console.error("Campaign Bundles PUT Error:", e);
        return NextResponse.json({ error: "Server Error" }, { status: 500 });
    }
}
