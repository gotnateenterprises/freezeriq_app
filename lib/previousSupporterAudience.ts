/**
 * FR-ORG-DASHBOARD-1A — the ONE place a previous-supporter audience is loaded.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 *
 * The coordinator's Previous Supporters card (FR-REBOOK-2) assembled its audience
 * inside its own route: the organization's campaigns, every organization in the
 * tenant (an organization is never a supporter), the non-canceled orders, and the
 * email-address opt-outs decided by evaluateSuppression. The tenant's
 * organization dashboard needs the same two numbers — supporters on file and how
 * many of them can currently be invited by email — and the owner's rule is that
 * the dashboard may not invent a second definition of either.
 *
 * So the assembly moved here, unchanged, and both surfaces call it:
 *
 *   coordinator route   excludeCampaignId = the coordinator's own campaign
 *                       (someone who ordered today is a CURRENT supporter)
 *   organization page   excludeCampaignId = null — every campaign this
 *                       organization has run, which is exactly the audience its
 *                       NEXT fundraiser's invitation would read
 *
 * ── WHAT "EMAIL-READY" MEANS, AND WHAT IT DOES NOT ─────────────────────────
 *
 * derivePreviousSupporters decides it, per person: a usable address (see
 * normalizeSupporterEmail) that no email-address-scoped preference currently
 * suppresses. The exclusions it knows are exactly three — no_email,
 * invalid_email and unsubscribed — and `unsubscribed` there covers every row
 * evaluateSuppression treats as suppressing (an unsubscribe, or a pause /
 * not-interested that has not elapsed). Contact-scope preferences, shared-inbox
 * review and needs-review belong to the SEASONAL contact audience
 * (lib/seasonalAudience.ts), not to supporters, and are deliberately not
 * borrowed here: widening the meaning would make the dashboard disagree with the
 * invitation it describes.
 *
 * Whether an invitation can actually go out right now also depends on the
 * campaign (an online ordering page) and the environment (an unsubscribe
 * secret). Those are send-time capabilities of one campaign, decided by
 * resolveSendCapability in the coordinator route; they are not properties of a
 * supporter, so they are not part of this count.
 *
 * READ ONLY. Every call here is a find; nothing is created or changed.
 */

import {
    derivePreviousSupporters,
    normalizeSupporterEmail,
    type DerivePreviousSupportersInput,
    type PreviousSupporterAudience,
} from '@/lib/previousSupporters';
import { evaluateSuppression } from '@/lib/outreachSend';

/** The Prisma surface this module reads — injected so tests can record the queries. */
export interface PreviousSupporterAudienceDb {
    fundraiserCampaign: { findMany: (args: any) => Promise<any[]> };
    order: { findMany: (args: any) => Promise<any[]> };
    marketingPreference: { findMany: (args: any) => Promise<any[]> };
}

export interface LoadPreviousSupporterAudienceArgs {
    businessId: string;
    /** The organization whose supporters are being counted. */
    organizationCustomerId: string;
    /**
     * A campaign to leave out, or null for none. The coordinator passes its own
     * campaign; the organization dashboard passes null.
     */
    excludeCampaignId: string | null;
    /** One clock for the whole read, so an elapsing pause cannot split a request. */
    now: Date;
}

/**
 * Everything derivePreviousSupporters needs, read from the database.
 *
 * Exported separately from the derivation so a caller that needs the same
 * audience per campaign (the dashboard's history rows) can re-derive from the
 * SAME inputs instead of reading them a second time.
 */
export async function loadPreviousSupporterAudienceInputs(
    db: PreviousSupporterAudienceDb,
    args: LoadPreviousSupporterAudienceArgs,
): Promise<DerivePreviousSupportersInput> {
    const { businessId, organizationCustomerId, excludeCampaignId, now } = args;

    // ── This organization's campaigns, minus the excluded one ───────────────
    const priorCampaigns = await db.fundraiserCampaign.findMany({
        where: {
            customer_id: organizationCustomerId,
            ...(excludeCampaignId ? { id: { not: excludeCampaignId } } : {}),
        },
        select: { id: true },
    });
    const priorCampaignIds = priorCampaigns.map((c) => c.id);

    // Every organization in this tenant. An organization is never a supporter.
    const organizationRows = await db.fundraiserCampaign.findMany({
        where: { customer: { business_id: businessId } },
        select: { customer_id: true },
        distinct: ['customer_id'],
    });
    const organizationCustomerIds = new Set<string>(organizationRows.map((r) => r.customer_id));

    const orders = priorCampaignIds.length
        ? await db.order.findMany({
            where: { campaign_id: { in: priorCampaignIds }, canceled_at: null },
            select: {
                id: true, campaign_id: true, canceled_at: true, customer_id: true,
                customer_name: true, phone: true, email: true,
                customer: {
                    select: {
                        id: true, business_id: true, contact_email: true,
                        contact_phone: true, name: true,
                    },
                },
            },
        })
        : [];

    // ── Durable opt-out truth, re-read every time ───────────────────────────
    // Decided by evaluateSuppression — the SAME rule checkSuppressionAtSend
    // applies — rather than by any caller's own guess.
    const prefs = await db.marketingPreference.findMany({
        where: { business_id: businessId, scope: 'email_address', normalized_email: { not: null } },
        select: { scope: true, status: true, effective_until: true, normalized_email: true },
    });
    const byEmail = new Map<string, typeof prefs>();
    for (const pr of prefs) {
        const key = normalizeSupporterEmail(pr.normalized_email);
        if (!key) continue;
        if (!byEmail.has(key)) byEmail.set(key, []);
        byEmail.get(key)!.push(pr);
    }
    const suppressedEmails = new Set(
        [...byEmail.entries()]
            .filter(([, rows]) => evaluateSuppression(rows, now).suppressed)
            .map(([email]) => email),
    );

    return {
        businessId,
        organizationCustomerId,
        priorCampaignIds,
        organizationCustomerIds,
        orders,
        suppressedEmails,
    };
}

/** The audience itself, recomputed from durable data every time it is asked for. */
export async function loadPreviousSupporterAudience(
    db: PreviousSupporterAudienceDb,
    args: LoadPreviousSupporterAudienceArgs,
): Promise<PreviousSupporterAudience> {
    return derivePreviousSupporters(await loadPreviousSupporterAudienceInputs(db, args));
}
