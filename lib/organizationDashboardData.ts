/**
 * FR-ORG-DASHBOARD-1A — reads the rows the organization dashboard is built from.
 *
 * READ ONLY. Every call is a find or a groupBy. The database client is injected
 * so the route's tenant scoping can be proven by recording the queries.
 *
 * ── TENANCY ─────────────────────────────────────────────────────────────────
 * The organization is resolved with `{ id, business_id }` from the SESSION, and
 * every other read hangs off rows that lookup returned (its campaigns, their
 * orders) or carries `business_id` itself. Campaigns have no business_id of
 * their own; their tenant is their customer's, which is why the organization is
 * proven first and nothing is read for an organization that failed that proof.
 *
 * ── COMPLETENESS ────────────────────────────────────────────────────────────
 * Campaigns are read WITHOUT a `take`. GET /api/customers/[id] returns the five
 * newest only, which is why the previous page's campaign count and history were
 * silently truncated; the dashboard does not read campaigns from there.
 */

import { loadPreviousSupporterAudienceInputs, type PreviousSupporterAudienceDb } from '@/lib/previousSupporterAudience';
import { openOpportunityWhere } from '@/lib/fundraiserRebooking';
import type {
    DashboardCampaignInput,
    DashboardDeliveryAttemptInput,
    DashboardMarketingInput,
    DashboardOpportunityInput,
    DashboardOrderInput,
    OrganizationDashboardInput,
} from '@/lib/organizationDashboard';

type FindMany = { findMany: (args: any) => Promise<any[]> };
type FindFirst = { findFirst: (args: any) => Promise<any | null> };

/** The Prisma surface this loader reads. */
export interface OrganizationDashboardDb extends PreviousSupporterAudienceDb {
    customer: FindFirst;
    business: { findUnique: (args: any) => Promise<any | null> };
    fundraiserCampaign: FindMany;
    order: FindMany;
    fundraiserOpportunity: FindFirst;
    outreachRecipientOrg: FindMany;
    outreachBatch: FindMany;
    emailDeliveryAttempt: FindMany & { groupBy: (args: any) => Promise<any[]> };
    rebookingSubmissionRevisionOrg: FindMany;
    seasonalOffering: FindMany;
}

export type OrganizationDashboardLoad =
    | { ok: true; input: OrganizationDashboardInput }
    | { ok: false; reason: 'not_found' };

export async function loadOrganizationDashboardInput(
    db: OrganizationDashboardDb,
    args: { businessId: string; organizationId: string; now: Date },
): Promise<OrganizationDashboardLoad> {
    const { businessId, organizationId, now } = args;

    // ── 1. The organization, inside THIS tenant, or nothing at all ──────────
    const organization = await db.customer.findFirst({
        where: { id: organizationId, business_id: businessId },
        select: { id: true, name: true, archived: true },
    });
    if (!organization) return { ok: false, reason: 'not_found' };

    const business = await db.business.findUnique({
        where: { id: businessId },
        select: { timezone: true },
    });

    // ── 2. EVERY campaign — no take ─────────────────────────────────────────
    const campaignRows = await db.fundraiserCampaign.findMany({
        where: { customer_id: organization.id },
        orderBy: { created_at: 'desc' },
        select: {
            id: true,
            name: true,
            status: true,
            closed_at: true,
            created_at: true,
            start_date: true,
            end_date: true,
            delivery_date: true,
            settlement_total: true,
            settled_externally: true,
            bundle_selection_status: true,
            // Frozen at closeout: what was sold, under the name it had then.
            invoices: {
                select: {
                    id: true,
                    status: true,
                    fundraiser_profit_amount: true,
                    items: {
                        select: { bundle_id: true, description: true, variant_size: true, quantity: true, total: true },
                    },
                },
            },
            // Only read for a campaign still running, where the active selection
            // IS the current offer. Closed history never consults it.
            campaign_bundles: {
                where: { state: 'active' },
                select: { bundle: { select: { name: true, serving_tier: true } } },
            },
        },
    });
    const campaigns: DashboardCampaignInput[] = campaignRows.map((c: any) => ({
        id: c.id,
        name: c.name,
        status: String(c.status),
        closed_at: c.closed_at ?? null,
        created_at: c.created_at,
        start_date: c.start_date ?? null,
        end_date: c.end_date ?? null,
        delivery_date: c.delivery_date ?? null,
        settlement_total: c.settlement_total === null || c.settlement_total === undefined ? null : String(c.settlement_total),
        settled_externally: Boolean(c.settled_externally),
        bundle_selection_status: c.bundle_selection_status ?? null,
        invoices: (c.invoices ?? []).map((i: any) => ({
            id: i.id,
            status: String(i.status),
            fundraiser_profit_amount: i.fundraiser_profit_amount === null || i.fundraiser_profit_amount === undefined
                ? null : String(i.fundraiser_profit_amount),
            items: (i.items ?? []).map((it: any) => ({
                bundle_id: it.bundle_id ?? null,
                description: it.description ?? null,
                variant_size: it.variant_size ?? null,
                quantity: it.quantity === null || it.quantity === undefined ? null : String(it.quantity),
                total: it.total === null || it.total === undefined ? null : String(it.total),
            })),
        })),
        activeBundles: (c.campaign_bundles ?? [])
            .map((cb: any) => cb?.bundle)
            .filter(Boolean)
            .map((b: any) => ({ name: String(b.name ?? ''), serving_tier: b.serving_tier ?? null })),
    }));
    const campaignIds = campaigns.map((c) => c.id);

    // ── 3. Every order on those campaigns — canceled included; the builder and
    //       computeOrganizationImpact decide what counts, in one place ────────
    const orderRows = campaignIds.length
        ? await db.order.findMany({
            where: { campaign_id: { in: campaignIds } },
            select: {
                id: true,
                campaign_id: true,
                total_amount: true,
                canceled_at: true,
                items: { select: { quantity: true, item_name: true, variant_size: true, bundle_id: true } },
            },
        })
        : [];
    const orders: DashboardOrderInput[] = orderRows.map((o: any) => ({
        id: o.id,
        campaign_id: o.campaign_id ?? null,
        total_amount: o.total_amount === null || o.total_amount === undefined ? null : String(o.total_amount),
        canceled_at: o.canceled_at ?? null,
        items: (o.items ?? []).map((it: any) => ({
            quantity: it.quantity ?? null,
            item_name: it.item_name ?? null,
            variant_size: it.variant_size ?? null,
            bundle_id: it.bundle_id ?? null,
        })),
    }));

    // ── 4. Supporters — the Previous Supporters invitation's own loader ─────
    const audience = await loadPreviousSupporterAudienceInputs(db, {
        businessId,
        organizationCustomerId: organization.id,
        excludeCampaignId: null,
        now,
    });

    // ── 5. The open planning cycle, if there is one ─────────────────────────
    const opp = await db.fundraiserOpportunity.findFirst({
        where: openOpportunityWhere(businessId, organization.id) as any,
        orderBy: { created_at: 'desc' },
        select: {
            id: true,
            status: true,
            created_at: true,
            first_response_at: true,
            preferred_delivery_date: true,
            alternate_delivery_date: true,
            confirmed_delivery_date: true,
            participant_estimate: true,
            notes: true,
            lost_at: true,
            lost_reason: true,
            campaign_id: true,
            converted_at: true,
            inquiries: {
                orderBy: { received_at: 'asc' },
                select: { received_at: true, source_channel: true, contact_name: true },
            },
        },
    });
    const openOpportunity: DashboardOpportunityInput | null = opp
        ? {
            id: opp.id,
            status: String(opp.status),
            created_at: opp.created_at,
            first_response_at: opp.first_response_at ?? null,
            preferred_delivery_date: opp.preferred_delivery_date ?? null,
            alternate_delivery_date: opp.alternate_delivery_date ?? null,
            confirmed_delivery_date: opp.confirmed_delivery_date ?? null,
            participant_estimate: opp.participant_estimate ?? null,
            notes: opp.notes ?? null,
            lost_at: opp.lost_at ?? null,
            lost_reason: opp.lost_reason ?? null,
            campaign_id: opp.campaign_id ?? null,
            converted_at: opp.converted_at ?? null,
            inquiries: (opp.inquiries ?? []).map((i: any) => ({
                received_at: i.received_at,
                source_channel: String(i.source_channel ?? ''),
                contact_name: i.contact_name ?? null,
            })),
        }
        : null;

    // ── 6. Marketing activity — recorded sends and responses only ───────────
    const marketing = await loadMarketingActivity(db, businessId, organization.id);

    return {
        ok: true,
        input: {
            organization: { id: organization.id, name: organization.name, archived: Boolean(organization.archived) },
            timeZone: business?.timezone ?? null,
            campaigns,
            orders,
            audience,
            openOpportunity,
            marketing,
        },
    };
}

/**
 * The organization's outreach history, from the rows the send engine and the
 * rebooking form actually write. Test sends (`is_test`) are never activity.
 */
async function loadMarketingActivity(
    db: OrganizationDashboardDb,
    businessId: string,
    organizationId: string,
): Promise<DashboardMarketingInput> {
    // ── Seasonal lineup emails: an address that represented this organization ─
    const recipientOrgs = await db.outreachRecipientOrg.findMany({
        where: { business_id: businessId, customer_id: organizationId },
        select: {
            outreach_recipient_id: true,
            recipient: {
                select: {
                    outreach_batch_id: true,
                    batch: { select: { id: true, seasonal_offering_id: true, offering: { select: { name: true } } } },
                },
            },
        },
    });
    const seasonalRecipients = recipientOrgs.filter((r: any) => r?.recipient?.batch?.seasonal_offering_id);
    const recipientIds = [...new Set<string>(seasonalRecipients.map((r: any) => r.outreach_recipient_id))];
    const seasonalAttempts = recipientIds.length
        ? await db.emailDeliveryAttempt.findMany({
            where: { business_id: businessId, outreach_recipient_id: { in: recipientIds }, is_test: false },
            select: {
                outreach_recipient_id: true, outreach_batch_id: true, status: true,
                accepted_at: true, failed_at: true, skipped_at: true, created_at: true,
            },
        })
        : [];
    const offeringByBatch = new Map<string, string>();
    for (const r of seasonalRecipients as any[]) {
        offeringByBatch.set(r.recipient.batch.id, r.recipient.batch.offering?.name ?? 'Seasonal lineup');
    }
    const attemptsByBatch = new Map<string, DashboardDeliveryAttemptInput[]>();
    for (const a of seasonalAttempts as any[]) {
        if (!offeringByBatch.has(a.outreach_batch_id)) continue;
        if (!attemptsByBatch.has(a.outreach_batch_id)) attemptsByBatch.set(a.outreach_batch_id, []);
        attemptsByBatch.get(a.outreach_batch_id)!.push({
            status: String(a.status),
            accepted_at: a.accepted_at ?? null,
            failed_at: a.failed_at ?? null,
            skipped_at: a.skipped_at ?? null,
            created_at: a.created_at ?? null,
        });
    }
    const seasonal = [...attemptsByBatch.entries()].map(([batchId, attempts]) => ({
        batchId,
        offeringName: offeringByBatch.get(batchId) ?? 'Seasonal lineup',
        attempts,
    }));

    // ── Previous Supporters invitations for this organization's campaigns ───
    const supporterBatches = await db.outreachBatch.findMany({
        where: { business_id: businessId, customer_id: organizationId, campaign_id: { not: null } },
        select: { id: true, campaign_id: true, campaign: { select: { name: true } } },
    });
    const batchIds = supporterBatches.map((b: any) => b.id);
    const grouped = batchIds.length
        ? await db.emailDeliveryAttempt.groupBy({
            by: ['outreach_batch_id', 'status'],
            where: { business_id: businessId, outreach_batch_id: { in: batchIds }, is_test: false },
            _count: { _all: true },
            _max: { accepted_at: true, failed_at: true, skipped_at: true, created_at: true },
        })
        : [];
    const previousSupporters = (supporterBatches as any[]).map((b) => {
        const rows = (grouped as any[]).filter((g) => g.outreach_batch_id === b.id);
        const count = (status: string) => rows
            .filter((g) => String(g.status) === status)
            .reduce((sum, g) => sum + Number(g?._count?._all ?? 0), 0);
        // When it was SENT (or failed, or was skipped) — the outcome timestamps. A row's
        // created_at is only the claim, so it dates the entry only when no outcome exists.
        const latestOf = (keys: string[]) => rows
            .flatMap((g) => keys.map((k) => g?._max?.[k]))
            .filter(Boolean)
            .map((d: any) => new Date(d))
            .filter((d) => !Number.isNaN(d.getTime()))
            .sort((x, y) => y.getTime() - x.getTime())[0] ?? null;
        const lastActivity = latestOf(['accepted_at', 'failed_at', 'skipped_at']) ?? latestOf(['created_at']);
        return {
            batchId: b.id,
            campaignName: b.campaign?.name ?? 'Fundraiser',
            accepted: count('accepted'),
            failed: count('failed'),
            skipped: count('skipped_suppressed'),
            queued: count('queued'),
            lastActivityAt: lastActivity,
        };
    });

    // ── Rebooking responses: this organization's row in each thread's newest revision ─
    const revisionOrgs = await db.rebookingSubmissionRevisionOrg.findMany({
        where: { business_id: businessId, customer_id: organizationId },
        select: {
            selected: true,
            revision: {
                select: {
                    revision_number: true,
                    created_at: true,
                    submission_id: true,
                    submission: { select: { seasonal_offering_id: true } },
                },
            },
        },
    });
    const newestBySubmission = new Map<string, any>();
    for (const ro of revisionOrgs as any[]) {
        const rev = ro?.revision;
        if (!rev?.submission_id) continue;
        const prev = newestBySubmission.get(rev.submission_id);
        if (!prev || Number(rev.revision_number) > Number(prev.revision.revision_number)) {
            newestBySubmission.set(rev.submission_id, ro);
        }
    }
    const offeringIds = [...new Set<string>(
        [...newestBySubmission.values()].map((ro) => ro.revision.submission?.seasonal_offering_id).filter(Boolean),
    )];
    const offerings = offeringIds.length
        ? await db.seasonalOffering.findMany({
            where: { business_id: businessId, id: { in: offeringIds } },
            select: { id: true, name: true },
        })
        : [];
    const offeringName = new Map<string, string>((offerings as any[]).map((o) => [o.id, o.name]));
    const rebookingResponses = [...newestBySubmission.entries()].map(([submissionId, ro]) => ({
        submissionId,
        offeringName: offeringName.get(ro.revision.submission?.seasonal_offering_id) ?? 'Seasonal lineup',
        selected: Boolean(ro.selected),
        respondedAt: ro.revision.created_at,
        revisionNumber: Number(ro.revision.revision_number) || 1,
    }));

    return { seasonal, previousSupporters, rebookingResponses };
}
