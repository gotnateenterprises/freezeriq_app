/**
 * Tracker Download API
 *
 * ACCESS MODEL: Coordinator session cookie (see lib/coordinatorSession.ts;
 * FR-COORD-SEC-1B retired the old ?token=<portal_token> query-string design).
 * - GET gated by requireCoordinatorSession(); campaign id comes from the
 *   resolved session row, never from client input.
 * - Returns a populated .xlsx file as a binary download.
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from the coordinator session)
 *
 * TEMPLATE: Uses the same tracking_sheet.xlsx template as the
 * marketing packet email attachment (/api/documents/tracking-sheet).
 * Populates deadline, checks_payable_to, and the campaign's ACTUAL selected
 * Bundle families (name, Serves-5/Serves-2 pricing, canonical meal list)
 * from campaign data in the database — see lib/coordinatorOrderTracker.ts
 * (FR-COORD-ORDER-TRACKER-1) for the family-resolution contract.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';
import path from 'path';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { buildTrackerFamilies, populateTrackerWorksheet, type TrackerBundleRow } from '@/lib/coordinatorOrderTracker';

export async function GET(req: Request) {
    try {
        // FR-COORD-SEC-1B: the coordinator credential used to arrive here as
        // ?token=<secret>, putting it into the query string of a logged request.
        // Authority now comes from the coordinator session cookie.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;

        // 1. Fetch campaign + customer
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: guard.campaignId },
            include: {
                customer: {
                    select: {
                        name: true,
                        contact_name: true,
                        business_id: true,
                    },
                },
            },
        });

        if (!campaign) {
            return NextResponse.json(
                { error: 'Campaign not found' },
                { status: 404 }
            );
        }

        const businessId = campaign.customer!.business_id!;

        // 2. FR-COORD-ORDER-TRACKER-1: refuse rather than fall through to the
        //    template's static sample data for a campaign with no real
        //    selection to show (pending/misconfigured) or one that's closed —
        //    the same gate promo-scripts already applies for the same reason.
        const orderMode = await resolveCampaignOrderMode(campaign, businessId);
        if (!orderMode.allowed) {
            return NextResponse.json(
                { error: 'safeMessage' in orderMode ? orderMode.safeMessage : 'This campaign cannot generate a tracker right now.' },
                { status: 422 }
            );
        }

        // 3. Fetch the campaign's ACTUAL bundles, grouped by family — never a
        //    flat, family-blind, unordered list (that was the defect: see
        //    lib/coordinatorOrderTracker.ts header comment).
        let rows: TrackerBundleRow[] = [];

        if (orderMode.mode === 'legacy') {
            const legacyBundles = await prisma.bundle.findMany({
                where: { business_id: businessId, is_active: true, show_on_storefront: true },
                orderBy: { name: 'asc' },
                take: 10, // bounds resolveMaterialBundles' fail-closed blast radius, matching promo-scripts
                include: {
                    contents: {
                        orderBy: { position: 'asc' },
                        include: { recipe: { select: { name: true } } },
                    },
                },
            });
            rows = legacyBundles.map((b) => ({
                id: b.id,
                name: b.name,
                price: b.price,
                serving_tier: b.serving_tier,
                family_id: b.family_id,
                meals: b.contents.map((c) => c.recipe?.name).filter((n): n is string => Boolean(n)),
            }));
        } else if (orderMode.mode === 'selected') {
            // CB-6's own pattern (app/api/campaigns/[id]/bundle-selection/route.ts):
            // state:'active', ordered by position — the campaign's real, final,
            // deterministically-ordered selection. resolveCampaignOrderMode
            // already proved this campaign's active assignments are structurally
            // sound (tenant-isolated, exactly bundle_selection_limit complete
            // family pairs) before we got here.
            const activeAssignments = await prisma.campaignBundle.findMany({
                where: { campaign_id: campaign.id, state: 'active' },
                orderBy: { position: 'asc' },
                select: {
                    bundle: {
                        select: {
                            id: true,
                            name: true,
                            price: true,
                            serving_tier: true,
                            family_id: true,
                            contents: {
                                orderBy: { position: 'asc' },
                                select: { recipe: { select: { name: true } } },
                            },
                        },
                    },
                },
            });
            rows = activeAssignments.map(({ bundle: b }) => ({
                id: b.id,
                name: b.name,
                price: b.price,
                serving_tier: b.serving_tier,
                family_id: b.family_id,
                meals: b.contents.map((c) => c.recipe?.name).filter((n): n is string => Boolean(n)),
            }));
        }

        const resolved = buildTrackerFamilies(rows);
        if (!resolved.ok) {
            return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: 422 });
        }

        // 4. Load the SAME template used by the marketing packet
        const ExcelJS = (await import('exceljs')).default;
        const templatePath = path.resolve('./templates/tracking_sheet.xlsx');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(templatePath);

        const worksheet = workbook.worksheets[0];

        // 5. Populate every campaign-specific cell — deadline, payee, and the
        //    first two selected families (the template's fixed layout).
        populateTrackerWorksheet(worksheet, resolved.families, {
            endDate: campaign.end_date,
            payee: campaign.checks_payable,
        });

        // 6. Generate buffer and return
        const buffer = await workbook.xlsx.writeBuffer();
        const orgName = (campaign.customer as any)?.name || 'Organization';
        const safeOrgName = orgName.replace(/[^a-zA-Z0-9_-]/g, '_');

        return new NextResponse(buffer, {
            headers: {
                'Content-Type':
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="${safeOrgName}-order-tracker.xlsx"`,
            },
        });
    } catch (e: any) {
        console.error('Tracker Download Error:', e);
        return NextResponse.json(
            { error: e.message || 'Failed to generate tracker' },
            { status: 500 }
        );
    }
}
