/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0 — the server half of "invite previous supporters to
 * THIS fundraiser": is there a fundraiser to invite them to, what does it say, who
 * has already been emailed for it, and which of the coordinator's ticks may be sent.
 *
 * Both the coordinator GET (what the card shows) and the send POST (what actually
 * goes out) call these, so the preview and the send cannot drift apart.
 *
 * ── AUTHORITIES REUSED, NOT RE-DERIVED ──────────────────────────────────────
 *
 *   open for orders?   resolveCampaignOrderMode(campaign, businessId, tenant tz) —
 *                      the supporter-facing rule the public page and the public
 *                      order route use, deadline included
 *   ordering URL       resolveCanonicalSupporterUrl — FR-SUPPORTER-SHARE-INTEGRITY-1
 *   bundle lineup      the order mode's activeOrderableBundleIds, in CampaignBundle
 *                      position order, grouped into menus by the FR-SHARE-COPY-1
 *                      material authority (one line per family, not per size)
 *   deadline / pickup  the campaign's own end_date / delivery_date / delivery_time /
 *                      pickup_location — never the organization-level
 *                      fundraiser_info blob, which is shared by every campaign that
 *                      organization has ever run and can hold a previous round's date
 *   who was emailed    EmailDeliveryAttempt rows under this campaign's one
 *                      outreach batch — the same rows the send engine claims
 */
import { prisma } from '@/lib/db';
import { resolveCampaignOrderMode, type CampaignOrderBundleMode } from '@/lib/campaignOrderBundles';
import { resolveCanonicalSupporterUrl } from '@/lib/fundraiserCanonicalUrl';
import { formatOrderDeadline } from '@/lib/previousSupporterInvite';
import { resolveMaterialBundles, groupMaterialMenus } from '@/lib/coordinatorMaterialBundles';
import { maskSupporterEmail, type PreviousSupporter, type PreviousSupporterAudience } from '@/lib/previousSupporters';
import {
    isPreviousSupporterRef,
    isSendableSupporterAddress,
    previousSupporterRef,
    PREVIOUS_SUPPORTER_SELECTION_MAX,
    type InvitationFacts,
} from '@/lib/previousSupporterEmail';
import type { SupporterEmailStatus, SupporterRow } from '@/lib/previousSupporterSelection';

/** The campaign columns the invitation needs. Explicit; nothing arrives by default. */
export const INVITATION_CAMPAIGN_SELECT = {
    id: true,
    name: true,
    status: true,
    closed_at: true,
    end_date: true,
    delivery_date: true,
    delivery_time: true,
    pickup_location: true,
    bundle_selection_status: true,
    bundle_selection_limit: true,
    public_token: true,
    customer_id: true,
    customer: {
        select: {
            id: true,
            name: true,
            business_id: true,
            business: {
                select: {
                    id: true, name: true, display_name: true,
                    custom_domain: true, contact_email: true, slug: true, timezone: true,
                },
            },
        },
    },
} as const;

// ── Is there a fundraiser to invite anyone to? ──────────────────────────────

export type InvitationAvailabilityCode =
    | 'open' | 'ordering_closed' | 'not_open_yet' | 'menu_pending' | 'menu_unavailable' | 'no_order_link';

export interface InvitationAvailability {
    open: boolean;
    code: InvitationAvailabilityCode;
    reason: string;
}

/**
 * Pure. Invitations exist only while supporters can actually order, and only when
 * there is a canonical ordering page to send them to — otherwise every email
 * would be a dead end.
 */
export function describeInvitationAvailability(
    mode: Pick<CampaignOrderBundleMode, 'mode' | 'allowed'> & { reasonCode?: string },
    orderUrl: string | null,
): InvitationAvailability {
    if (mode.mode === 'closed') {
        return { open: false, code: 'ordering_closed', reason: 'Ordering for this fundraiser has closed, so there is nothing to invite previous supporters to.' };
    }
    if (mode.mode === 'invalid' && mode.reasonCode === 'not_launched') {
        return { open: false, code: 'not_open_yet', reason: 'This fundraiser is not open for orders yet. Once it is, you can invite previous supporters from here.' };
    }
    if (mode.mode === 'pending') {
        return { open: false, code: 'menu_pending', reason: "Choose this fundraiser's meals first — supporters cannot order until the menu is set." };
    }
    if (!mode.allowed || (mode.mode !== 'selected' && mode.mode !== 'legacy')) {
        return { open: false, code: 'menu_unavailable', reason: "This fundraiser's ordering page is not available right now, so invitations are paused." };
    }
    if (!orderUrl) {
        return { open: false, code: 'no_order_link', reason: 'This fundraiser has no online ordering page yet, so there is nowhere to send supporters.' };
    }
    return { open: true, code: 'open', reason: 'Ordering is open.' };
}

type InvitationCampaign = {
    id: string;
    name: string;
    status: string;
    closed_at: Date | null;
    end_date: Date | string | null;
    delivery_date: Date | string | null;
    delivery_time: string | null;
    pickup_location: string | null;
    bundle_selection_status: string;
    bundle_selection_limit: number;
    public_token: string | null;
    customer: {
        name: string | null;
        business_id: string | null;
        business: { slug: string | null; custom_domain: string | null; timezone: string | null } | null;
    } | null;
};

/**
 * The CURRENT campaign's invitation facts, or null when invitations are not open.
 * Nothing here reads a previous campaign.
 */
export async function loadInvitationFacts(campaign: InvitationCampaign): Promise<{
    availability: InvitationAvailability;
    facts: InvitationFacts | null;
}> {
    const businessId = campaign.customer?.business_id ?? '';
    const business = campaign.customer?.business ?? null;

    // The supporter-facing rule, with the tenant's zone, exactly as the public
    // fundraiser page evaluates it — so "open" here means "a supporter clicking
    // the link right now can order".
    const mode = await resolveCampaignOrderMode(campaign, businessId, business?.timezone ?? null);
    const orderUrl = resolveCanonicalSupporterUrl({
        campaignId: campaign.id,
        publicToken: campaign.public_token,
        slug: business?.slug ?? null,
        customDomain: business?.custom_domain ?? null,
    });
    const availability = describeInvitationAvailability(mode, orderUrl);
    if (!availability.open || !orderUrl) return { availability, facts: null };

    // A legacy campaign sells the tenant's whole storefront catalog; listing all of
    // it would not be "this round's" lineup, so the line is omitted, as the
    // coordinator share copy does.
    let bundleNames: string[] = [];
    if (mode.mode === 'selected' && mode.activeOrderableBundleIds.length > 0) {
        const rows = await prisma.campaignBundle.findMany({
            where: { campaign_id: campaign.id, state: 'active', bundle_id: { in: mode.activeOrderableBundleIds } },
            orderBy: { position: 'asc' },
            select: { bundle: { select: { id: true, name: true, price: true, serving_tier: true, family_id: true } } },
        });
        const resolved = resolveMaterialBundles(rows.map(({ bundle: b }) => ({
            id: b.id, name: b.name, price: b.price, serving_tier: b.serving_tier, family_id: b.family_id,
        })));
        if (resolved.ok) bundleNames = groupMaterialMenus(resolved.bundles).map((m) => m.baseName);
    }

    return {
        availability,
        facts: {
            organizationName: campaign.customer?.name ?? '',
            bundleNames,
            deadlineLabel: formatOrderDeadline(campaign.end_date),
            pickup: {
                dateLabel: formatOrderDeadline(campaign.delivery_date),
                time: (campaign.delivery_time ?? '').trim() || null,
                location: (campaign.pickup_location ?? '').trim() || null,
            },
            orderUrl,
        },
    };
}

// ── Who has already been emailed for THIS fundraiser? ───────────────────────

export interface CampaignEmailHistoryEntry {
    status: 'emailed' | 'sending' | 'opted_out' | 'failed';
    at: Date | null;
}

export interface CampaignEmailHistoryDb {
    outreachBatch: { findFirst: (args: any) => Promise<any> };
    emailDeliveryAttempt: { findMany: (args: any) => Promise<any[]> };
}

const HISTORY_RANK: Record<CampaignEmailHistoryEntry['status'], number> = {
    emailed: 4, sending: 3, opted_out: 2, failed: 1,
};

/**
 * Per normalized address, the furthest any real (non-test) attempt for THIS
 * campaign got. Previous campaigns have their own batches and are never read, so
 * last spring's invitation does not make anyone "already emailed" this fall.
 */
export async function loadCampaignEmailHistory(
    db: CampaignEmailHistoryDb,
    owner: { businessId: string; customerId: string; campaignId: string },
): Promise<Map<string, CampaignEmailHistoryEntry>> {
    const out = new Map<string, CampaignEmailHistoryEntry>();
    const batch = await db.outreachBatch.findFirst({
        where: { business_id: owner.businessId, customer_id: owner.customerId, campaign_id: owner.campaignId },
        select: { id: true },
    });
    if (!batch) return out;

    const attempts = await db.emailDeliveryAttempt.findMany({
        where: { business_id: owner.businessId, outreach_batch_id: batch.id, is_test: false },
        select: {
            status: true, created_at: true, accepted_at: true, failed_at: true, skipped_at: true,
            recipient: { select: { normalized_email: true } },
        },
        orderBy: { created_at: 'asc' },
    });

    for (const a of attempts) {
        const email = a.recipient?.normalized_email;
        if (!email) continue;
        const entry: CampaignEmailHistoryEntry | null =
            a.status === 'accepted' ? { status: 'emailed', at: a.accepted_at ?? a.created_at }
                : a.status === 'queued' ? { status: 'sending', at: a.created_at }
                    : a.status === 'skipped_suppressed' ? { status: 'opted_out', at: a.skipped_at ?? a.created_at }
                        : a.status === 'failed' ? { status: 'failed', at: a.failed_at ?? a.created_at }
                            : null;
        if (!entry) continue;
        const prev = out.get(email);
        // Strongest outcome wins; among equals the later attempt does.
        if (!prev || HISTORY_RANK[entry.status] >= HISTORY_RANK[prev.status]) out.set(email, entry);
    }
    return out;
}

// ── One previous supporter, as this fundraiser sees them ────────────────────

function statusFor(s: PreviousSupporter, history: Map<string, CampaignEmailHistoryEntry>): {
    status: SupporterEmailStatus; at: Date | null;
} {
    if (!s.email) return { status: s.exclusionReason === 'invalid_email' ? 'invalid_email' : 'no_email', at: null };
    if (s.exclusionReason === 'unsubscribed') return { status: 'opted_out', at: null };
    if (!isSendableSupporterAddress(s.email)) return { status: 'invalid_email', at: null };
    const h = history.get(s.email);
    if (h) return { status: h.status, at: h.at };
    return { status: 'ready', at: null };
}

const SELECTABLE: ReadonlySet<SupporterEmailStatus> = new Set(['ready', 'failed']);

/**
 * The rows the card shows: masked addresses and opaque references only. Rows the
 * coordinator can act on come first, so a long history never pushes the people
 * who can be emailed off the page.
 */
export function buildSupporterRows(input: {
    campaignId: string;
    audience: PreviousSupporterAudience;
    history: Map<string, CampaignEmailHistoryEntry>;
    invitationsOpen: boolean;
    limit: number;
}): SupporterRow[] {
    const rows = input.audience.supporters.map((s): SupporterRow => {
        const { status, at } = statusFor(s, input.history);
        const selectable = input.invitationsOpen && SELECTABLE.has(status);
        return {
            ref: selectable ? previousSupporterRef(input.campaignId, s.email as string) : null,
            name: s.displayName,
            emailMasked: s.email ? maskSupporterEmail(s.email) : null,
            orderCount: s.orderCount,
            reachable: s.reachable,
            exclusionReason: s.exclusionReason,
            status,
            statusAt: at ? at.toISOString() : null,
            selectable,
        };
    });
    const order = (r: SupporterRow) => (r.selectable ? (r.status === 'ready' ? 0 : 1) : r.status === 'emailed' || r.status === 'sending' ? 2 : 3);
    return rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => order(a.r) - order(b.r) || a.i - b.i)
        .map(({ r }) => r)
        .slice(0, input.limit);
}

export interface ResolvedSelection {
    /** The supporters to write to — always a subset of the recomputed audience. */
    toSend: PreviousSupporter[];
    /** How many distinct references the coordinator sent. */
    selected: number;
    notSent: {
        noLongerEligible: number;
        optedOut: number;
        noUsableEmail: number;
        alreadyEmailed: number;
    };
}

/**
 * The coordinator's ticks, resolved against the audience the SERVER just
 * recomputed. A reference that matches nobody here — forged, stale, or belonging
 * to another campaign, organization or tenant — sends nothing. The selection can
 * only ever narrow the server's audience; it cannot add a single address to it.
 */
export function resolveSelection(input: {
    campaignId: string;
    refs: unknown;
    audience: PreviousSupporterAudience;
    history: Map<string, CampaignEmailHistoryEntry>;
}): ResolvedSelection | null {
    if (!Array.isArray(input.refs)) return null;
    const refs = [...new Set(input.refs.filter(isPreviousSupporterRef))];
    if (refs.length === 0 || refs.length > PREVIOUS_SUPPORTER_SELECTION_MAX) return null;

    const byRef = new Map<string, PreviousSupporter>();
    for (const s of input.audience.supporters) {
        if (s.email) byRef.set(previousSupporterRef(input.campaignId, s.email), s);
    }

    const out: ResolvedSelection = {
        toSend: [], selected: refs.length,
        notSent: { noLongerEligible: 0, optedOut: 0, noUsableEmail: 0, alreadyEmailed: 0 },
    };
    for (const ref of refs) {
        const s = byRef.get(ref);
        if (!s) { out.notSent.noLongerEligible += 1; continue; }
        const { status } = statusFor(s, input.history);
        if (status === 'ready' || status === 'failed') out.toSend.push(s);
        else if (status === 'opted_out') out.notSent.optedOut += 1;
        else if (status === 'emailed' || status === 'sending') out.notSent.alreadyEmailed += 1;
        else out.notSent.noUsableEmail += 1;
    }
    return out;
}
