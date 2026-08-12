/**
 * GE-4 — organization fundraiser impact (READ-ONLY).
 *
 * WHY THIS IS ITS OWN ROUTE. The result is one row per ORGANIZATION, not per
 * campaign, so it does not belong on `/api/campaigns` — that resource is
 * campaign-shaped and GE-3 already extends it. `/api/customers` is the generic
 * customer list covering individuals as well as groups, and hanging fundraiser
 * lifetime aggregation off it would blur that boundary too. A small dedicated
 * read-only route keeps each resource honest about what it returns.
 *
 * ACCESS MODEL: session-authenticated, tenant-scoped through
 * `Customer.business_id`. A campaign carries no `business_id` of its own — its
 * tenant is its customer's — so scoping the customer query is what enforces
 * isolation, and no business identifier is ever read from the client.
 *
 * This handler performs no writes.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    computeOrganizationImpact,
    sortOrganizationImpacts,
    type ImpactSort,
    type OrganizationImpact,
} from '@/lib/growth/impact';

const SORTS: ImpactSort[] = ['lifetime_sales', 'most_recent', 'campaign_count'];

export interface OrganizationImpactRow extends Omit<
    OrganizationImpact, 'firstCampaignAt' | 'lastCampaignAt'
> {
    firstCampaignAt: string | null;
    lastCampaignAt: string | null;
}

export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const requested = new URL(req.url).searchParams.get('sort');
        const sort: ImpactSort = SORTS.includes(requested as ImpactSort)
            ? (requested as ImpactSort)
            : 'lifetime_sales';

        // Fundraising groups for THIS tenant only. `type` mirrors the existing
        // campaigns route so GE-4 sees the same population the CRM calls a
        // fundraiser organization.
        const organizations = await prisma.customer.findMany({
            where: {
                business_id: businessId,
                type: { in: ['fundraiser_org', 'organization'] as never },
            },
            select: {
                id: true,
                name: true,
                archived: true,
                campaigns: {
                    select: {
                        id: true,
                        status: true,
                        closed_at: true,
                        created_at: true,
                        settlement_total: true,
                        // Eligible gross for campaigns closeout has not frozen
                        // yet. `canceled_at` is selected rather than filtered in
                        // the query so the ONE eligibility rule lives in
                        // `isEligibleOrder`, next to the settled-value rule,
                        // instead of being split between Prisma and TypeScript.
                        orders: {
                            select: { total_amount: true, canceled_at: true },
                        },
                    },
                },
            },
        });

        // One clock for the whole response, so two rows cannot disagree about
        // how long ago "recently" was.
        const now = new Date();

        const impacts = organizations.map((o) => computeOrganizationImpact({
            organizationId: o.id,
            organizationName: o.name,
            campaigns: o.campaigns.map((c) => ({
                id: c.id,
                status: String(c.status),
                closed_at: c.closed_at,
                created_at: c.created_at,
                settlement_total: c.settlement_total === null ? null : Number(c.settlement_total),
                orders: c.orders.map((ord) => ({
                    total_amount: ord.total_amount === null ? null : Number(ord.total_amount),
                    canceled_at: ord.canceled_at,
                })),
            })),
        }, now));

        const archivedById = new Map(organizations.map((o) => [o.id, o.archived]));

        const rows: (OrganizationImpactRow & { archived: boolean })[] =
            sortOrganizationImpacts(impacts, sort).map((r) => ({
                ...r,
                firstCampaignAt: r.firstCampaignAt ? r.firstCampaignAt.toISOString() : null,
                lastCampaignAt: r.lastCampaignAt ? r.lastCampaignAt.toISOString() : null,
                archived: archivedById.get(r.organizationId) ?? false,
            }));

        // Tenant roll-up, derived from the same rows so a total can never
        // disagree with the list it summarises.
        const totals = {
            organizationCount: rows.length,
            organizationsWithHistory: rows.filter((r) => r.campaignCount > 0).length,
            /** Groups that have actually generated money, not merely a record. */
            organizationsWithSales: rows.filter((r) => r.lifetimeFundraiserSales > 0).length,
            repeatOrganizations: rows.filter((r) => r.isRepeatOrganization).length,
            lifetimeFundraiserSales: rows.reduce((sum, r) => sum + r.lifetimeFundraiserSales, 0),
            settledSales: rows.reduce((sum, r) => sum + r.settledSales, 0),
        };

        return NextResponse.json({ organizations: rows, totals, sort });
    } catch (e: unknown) {
        console.error('[growth/organizations]', e);
        return NextResponse.json({ error: 'Failed to load organization impact' }, { status: 500 });
    }
}
