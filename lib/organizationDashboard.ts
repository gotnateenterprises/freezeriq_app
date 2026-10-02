/**
 * FR-ORG-DASHBOARD-1A — the organization mini-dashboard's read model.
 *
 * PURE. It reads nothing and writes nothing: the loader
 * (lib/organizationDashboardData.ts) hands it rows, and it arranges them into
 * what the page shows. Every number on the page is decided by an authority that
 * already exists; this module only routes rows to them and words the result.
 *
 *   lifetime sales, campaigns run   computeOrganizationImpact (lib/growth/impact)
 *                                   — the Organizations tab's own authority, fed
 *                                   the same rows in the same shape
 *   one campaign's sales            campaignLifetimeContribution — so the history
 *                                   rows add up to the lifetime figure
 *   supporters, email-ready         derivePreviousSupporters over the inputs
 *                                   lib/previousSupporterAudience loads — the
 *                                   Previous Supporters invitation's own path
 *   lifecycle, invoice wording      classifyCampaignLifecycle / describeCampaignInvoice
 *   stage chip                      campaignDisplayStage
 *   physical bundles                bundleSummaryFromInvoiceItems (frozen at
 *                                   closeout) or bundleSummaryFromSupporterOrders
 *                                   (live, the coordinator portal's own rule)
 *   discard eligibility             evaluateDraftDiscard
 *
 * ── HONESTY RULES THIS MODULE KEEPS ─────────────────────────────────────────
 *
 *  · An absent number is not a zero. A campaign with no settlement, no orders
 *    and no invoice lines says "No sales data recorded", never "$0".
 *  · Closed history is read from what was FROZEN — invoice lines first, then
 *    the order lines' own names — never from today's catalog, which can be
 *    renamed, reassigned or deleted after closeout.
 *  · A timing pattern is inferred from fundraiser dates and is labelled as
 *    history. Nothing here is ever called a preference: no such field exists.
 *  · Marketing activity is only what FreezerIQ recorded sending or receiving.
 *    There are no provider delivery/open/click events in this system, so none
 *    are shown.
 */

import {
    computeOrganizationImpact,
    campaignLifetimeContribution,
    computeCampaignGross,
    hasCountableValue,
    isRealCampaign,
    type ImpactCampaignInput,
} from '@/lib/growth/impact';
import {
    derivePreviousSupporters,
    type DerivePreviousSupportersInput,
} from '@/lib/previousSupporters';
import {
    classifyCampaignLifecycle,
    describeCampaignInvoice,
    isCampaignClosedFamily,
    resolveCampaignInvoiceState,
    type CampaignInvoiceDisplay,
} from '@/lib/growth/campaignLifecycle';
import { campaignDisplayStage } from '@/lib/campaignDisplayStage';
import {
    bundleDisplayName,
    bundleSizeLabel,
    bundleSummaryFromInvoiceItems,
    bundleSummaryFromSupporterOrders,
    formatDollars,
    pluralCount,
    type BundleSummary,
} from '@/lib/bundleSummary';
import { formatCalendarDateShortValue } from '@/lib/calendarDate';
import { calendarDateInTimeZone } from '@/lib/tenantTimezone';
import { evaluateDraftDiscard, type DraftDiscardBlocker } from '@/lib/opportunityDraftDiscard';
import { OPEN_OPPORTUNITY_STATUSES } from '@/lib/fundraiserFunnel';

// ─────────────────────────────────────────────────────────────────────────────
// INPUT — rows exactly as the loader read them (Decimals may arrive as strings)
// ─────────────────────────────────────────────────────────────────────────────

type DateLike = Date | string | null;
type NumberLike = number | string | null;

export interface DashboardInvoiceItemInput {
    bundle_id: string | null;
    description: string | null;
    variant_size: string | null;
    quantity: NumberLike;
    total: NumberLike;
}

export interface DashboardInvoiceInput {
    id: string;
    status: string;
    fundraiser_profit_amount: NumberLike;
    items: DashboardInvoiceItemInput[];
}

export interface DashboardOrderItemInput {
    quantity: NumberLike;
    item_name: string | null;
    variant_size: string | null;
    bundle_id: string | null;
}

export interface DashboardOrderInput {
    id: string;
    campaign_id: string | null;
    total_amount: NumberLike;
    canceled_at: DateLike;
    items: DashboardOrderItemInput[];
}

/** One active (sellable) campaign bundle — only consulted for a campaign still running. */
export interface DashboardActiveBundleInput {
    name: string;
    serving_tier: string | null;
}

export interface DashboardCampaignInput {
    id: string;
    name: string;
    status: string;
    closed_at: Date | null;
    created_at: Date;
    start_date: Date | null;
    end_date: Date | null;
    delivery_date: Date | null;
    settlement_total: NumberLike;
    settled_externally: boolean;
    bundle_selection_status: string | null;
    invoices: DashboardInvoiceInput[];
    activeBundles: DashboardActiveBundleInput[];
}

export interface DashboardOpportunityInput {
    id: string;
    status: string;
    created_at: Date;
    first_response_at: DateLike;
    preferred_delivery_date: DateLike;
    alternate_delivery_date: DateLike;
    confirmed_delivery_date: DateLike;
    participant_estimate: number | null;
    notes: string | null;
    lost_at: DateLike;
    lost_reason: string | null;
    campaign_id: string | null;
    converted_at: DateLike;
    /** Oldest first. */
    inquiries: { received_at: Date; source_channel: string; contact_name: string | null }[];
}

export interface DashboardDeliveryAttemptInput {
    status: string;
    accepted_at: DateLike;
    failed_at: DateLike;
    skipped_at: DateLike;
    created_at: DateLike;
}

export interface DashboardMarketingInput {
    /** Seasonal lineup emails that reached an address representing this organization. */
    seasonal: { batchId: string; offeringName: string; attempts: DashboardDeliveryAttemptInput[] }[];
    /** Previous Supporters invitations sent for this organization's campaigns. */
    previousSupporters: {
        batchId: string;
        campaignName: string;
        accepted: number;
        failed: number;
        skipped: number;
        queued: number;
        lastActivityAt: DateLike;
    }[];
    /** This organization's state in the latest revision of each rebooking response thread. */
    rebookingResponses: {
        submissionId: string;
        offeringName: string;
        selected: boolean;
        respondedAt: Date;
        revisionNumber: number;
    }[];
}

export interface OrganizationDashboardInput {
    organization: { id: string; name: string; archived: boolean };
    /** The tenant's IANA timezone, for dating timestamps (not date-only columns). */
    timeZone: string | null;
    campaigns: DashboardCampaignInput[];
    /** Every order on these campaigns, canceled included — filtering happens here. */
    orders: DashboardOrderInput[];
    /** lib/previousSupporterAudience, excludeCampaignId = null. */
    audience: DerivePreviousSupportersInput;
    openOpportunity: DashboardOpportunityInput | null;
    marketing: DashboardMarketingInput;
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT — what the page renders
// ─────────────────────────────────────────────────────────────────────────────

export type Tone = 'good' | 'pending' | 'warn' | 'neutral';

export interface DashboardKpis {
    lifetimeSales: number;
    lifetimeSalesLabel: string;
    lifetimeSalesHelper: string | null;
    campaignsRun: number;
    campaignsHelper: string | null;
    supportersOnFile: number;
    supportersHelper: string | null;
    emailReady: number;
    emailReadyHelper: string | null;
    noUsableEmail: number;
    optedOut: number;
}

export interface CurrentCampaignCard {
    id: string;
    name: string;
    stageLabel: string;
    stageKey: string;
    status: string;
    closedAt: string | null;
    bundleSelectionStatus: string | null;
    dateLine: string;
    figuresLine: string;
}

export interface CurrentOpportunityCard {
    id: string;
    kind: 'planning' | 'inquiry';
    status: string;
    title: string;
    chipLabel: string;
    chipTone: 'sky' | 'amber' | 'emerald';
    lines: string[];
    discard: { eligible: boolean; blockers: DraftDiscardBlocker[] };
}

export interface InvoiceFollowUp {
    campaignId: string;
    campaignName: string;
    label: string;
    tone: Tone;
}

export interface HistoryRow {
    id: string;
    name: string;
    stageLabel: string;
    stageKey: string;
    status: string;
    closedAt: string | null;
    bundleSelectionStatus: string | null;
    isOpen: boolean;
    dateLabel: string;
    /** Null renders as "No sales data recorded". */
    metricsLabel: string | null;
    bundleFamilies: string[];
    bundleNote: string | null;
    shareLabel: string | null;
    invoiceLabel: string | null;
    invoiceTone: Tone | null;
    // Raw facts behind the words, for tests and future surfaces.
    supporterCount: number;
    orderCount: number;
    physicalBundles: number | null;
    gross: number | null;
    grossSource: 'settlement' | 'live_orders' | 'none';
    organizationShare: number | null;
    bundleSource: 'invoice' | 'orders' | 'selection' | 'none';
}

export interface DashboardIntelligence {
    lastFundraiser: null | {
        campaignId: string;
        name: string;
        dateLabel: string;
        resultLabel: string;
        bundleFamilies: string[];
        supporterCount: number;
    };
    timing: { label: string; muted: boolean; datedCount: number };
    supportersOnFile: number;
    emailReady: number;
    emailReadyBreakdown: string | null;
}

export interface MarketingEntry {
    id: string;
    kind: 'seasonal_update' | 'previous_supporters' | 'rebooking_response';
    title: string;
    stateLabel: string;
    tone: Tone;
    detail: string | null;
    at: string | null;
    dateLabel: string | null;
}

/** The shape lib/fundraiserRebooking's eligibility rule reads, for every campaign. */
export interface RebookingCampaignSummary {
    id: string;
    status: string;
    closed_at: string | null;
    settlement_total: number | null;
    settled_externally: boolean;
    invoice_statuses: string[];
    held_order_count: number;
}

export interface OrganizationDashboard {
    organization: { id: string; name: string; archived: boolean };
    kpis: DashboardKpis;
    current: {
        campaigns: CurrentCampaignCard[];
        opportunity: CurrentOpportunityCard | null;
        invoiceFollowUps: InvoiceFollowUp[];
    };
    intelligence: DashboardIntelligence;
    history: HistoryRow[];
    marketing: MarketingEntry[];
    rebooking: { archived: boolean; campaigns: RebookingCampaignSummary[] };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

const num = (v: NumberLike | undefined): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const toDate = (v: DateLike | undefined): Date | null => {
    if (v === null || v === undefined || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
};

const isoOrNull = (v: DateLike | undefined): string | null => toDate(v)?.toISOString() ?? null;

/** A DATE-ONLY column ("Oct 14, 2026"), never shifted by a timezone. */
export const formatDateOnly = (v: DateLike | undefined): string | null => formatCalendarDateShortValue(toDate(v));

/**
 * A TIMESTAMP, dated in the tenant's own timezone. An instant at 9 pm Central is
 * still that day for the tenant, even though it is already tomorrow in UTC.
 */
export function formatTimestampDate(v: DateLike | undefined, timeZone: string | null): string | null {
    const d = toDate(v);
    if (!d) return null;
    const ymd = timeZone ? calendarDateInTimeZone(timeZone, d) : null;
    return formatCalendarDateShortValue(ymd ? new Date(`${ymd}T00:00:00.000Z`) : d);
}

const plural = (n: number, singular: string, pluralWord: string) => pluralCount(n, singular, pluralWord);

/** Case-insensitive de-duplication, keeping the first spelling seen. */
function uniqueNames(names: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names) {
        const n = raw.trim();
        if (!n) continue;
        const k = n.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(n);
    }
    return out;
}

/**
 * Customer-facing family names from already-summarised bundle rows: the
 * "(Serves N)" marker that only repeats the size is already stripped by
 * bundleDisplayName, so a Serves-5 and a Serves-2 sibling collapse into one
 * family. Most-ordered first.
 */
function familiesFromSummary(summary: BundleSummary): string[] {
    const byName = new Map<string, { name: string; quantity: number }>();
    for (const row of summary.rows) {
        const k = row.bundleName.trim().toLowerCase();
        if (!k) continue;
        const prev = byName.get(k);
        if (prev) prev.quantity += row.quantity;
        else byName.set(k, { name: row.bundleName.trim(), quantity: row.quantity });
    }
    return [...byName.values()]
        .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
        .map((f) => f.name);
}

/** The date that best says WHEN a fundraiser happened: the pickup day, else the order deadline, else its start. */
function credibleFundraiserDate(c: DashboardCampaignInput): Date | null {
    return toDate(c.delivery_date) ?? toDate(c.end_date) ?? toDate(c.start_date);
}

/** Newest first. Undated history sorts by when it closed, then when it was created. */
function historySortTime(c: DashboardCampaignInput): number {
    const d = credibleFundraiserDate(c) ?? toDate(c.closed_at) ?? toDate(c.created_at);
    return d ? d.getTime() : 0;
}

/** Owner-facing name of an inquiry's source channel (lib/fundraiserFunnel FUNDRAISER_SOURCE_CHANNELS). */
export function sourceChannelLabel(channel: string | null | undefined): string {
    switch (channel) {
        case 'tenant_website': return 'your website';
        case 'freezeriq_site': return 'the FreezerIQ site';
        case 'meta_lead': return 'a Meta lead form';
        case 'instagram': return 'Instagram';
        case 'paid_ad': return 'a paid ad';
        case 'organic_social': return 'social media';
        case 'referral': return 'a referral';
        case 'email': return 'email';
        case 'phone': return 'phone';
        case 'manual': return 'a manual entry';
        case 'returning_org': return 'a returning-organization form';
        default: return 'another channel';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-CAMPAIGN FACTS
// ─────────────────────────────────────────────────────────────────────────────

interface CampaignFacts {
    c: DashboardCampaignInput;
    impact: ImpactCampaignInput;
    closed: boolean;
    lifecycle: ReturnType<typeof classifyCampaignLifecycle>;
    liveOrders: DashboardOrderInput[];
    orderCount: number;
    supporterCount: number;
    gross: number | null;
    grossSource: HistoryRow['grossSource'];
    physicalBundles: number | null;
    families: string[];
    bundleSource: HistoryRow['bundleSource'];
    bundleNote: string | null;
    organizationShare: number | null;
    invoice: CampaignInvoiceDisplay & { state: ReturnType<typeof resolveCampaignInvoiceState> };
    hasSalesData: boolean;
}

function toImpactCampaign(c: DashboardCampaignInput, orders: readonly DashboardOrderInput[]): ImpactCampaignInput {
    // Exactly the mapping GET /api/growth/organizations applies, so the two
    // surfaces cannot disagree about one organization's lifetime sales.
    return {
        id: c.id,
        status: String(c.status),
        name: c.name ?? null,
        closed_at: c.closed_at,
        created_at: c.created_at,
        settlement_total: num(c.settlement_total),
        orders: orders.map((o) => ({
            total_amount: num(o.total_amount),
            canceled_at: toDate(o.canceled_at),
        })),
    };
}

function campaignFacts(
    c: DashboardCampaignInput,
    orders: readonly DashboardOrderInput[],
    audience: DerivePreviousSupportersInput,
): CampaignFacts {
    const impact = toImpactCampaign(c, orders);
    const liveOrders = orders.filter((o) => !toDate(o.canceled_at));
    const orderCount = liveOrders.length;
    const closed = isCampaignClosedFamily(c);
    const invoiceStatuses = c.invoices.map((i) => String(i.status));

    // ── Who supported THIS campaign — the invitation's own identity rule ────
    const supporterCount = derivePreviousSupporters({ ...audience, priorCampaignIds: [c.id] }).supporterCount;

    // ── Money — the same contribution the lifetime figure sums ──────────────
    const settled = hasCountableValue(impact);
    const gross = settled
        ? Number(impact.settlement_total)
        : orderCount > 0 ? computeCampaignGross(impact) : null;
    const grossSource: CampaignFacts['grossSource'] = settled ? 'settlement' : orderCount > 0 ? 'live_orders' : 'none';

    // ── Bundles — frozen truth first, never today's catalog for history ─────
    const liveInvoice = c.invoices.find((i) => String(i.status) !== 'CANCELED') ?? null;
    const frozenItems = liveInvoice?.items ?? [];
    let physicalBundles: number | null = null;
    let families: string[] = [];
    let bundleSource: CampaignFacts['bundleSource'] = 'none';
    let bundleNote: string | null = null;

    const orderSummary = orderCount > 0
        ? bundleSummaryFromSupporterOrders(liveOrders.map((o) => ({
            canceled_at: null,
            items: o.items.map((it) => ({
                quantity: it.quantity,
                variant_size: it.variant_size,
                item_name: it.item_name,
                bundle_id: it.bundle_id,
            })),
        })))
        : null;

    if (closed && frozenItems.length > 0) {
        const frozen = bundleSummaryFromInvoiceItems(frozenItems);
        physicalBundles = frozen.totalQuantity;
        families = familiesFromSummary(frozen);
        bundleSource = 'invoice';
    } else if (orderSummary && orderSummary.rows.length > 0) {
        physicalBundles = orderSummary.totalQuantity;
        families = familiesFromSummary(orderSummary);
        bundleSource = 'orders';
    }

    if (!closed) {
        // A running fundraiser's OFFER is its active selection — the one place
        // the live assignment is genuinely authoritative.
        const offered = uniqueNames(c.activeBundles.map((b) => bundleDisplayName(b.name, bundleSizeLabel(b.serving_tier))));
        if (offered.length > 0) {
            families = offered;
            bundleSource = 'selection';
        } else if (families.length === 0) {
            bundleNote = c.bundle_selection_status === 'pending'
                ? 'Waiting for the coordinator to choose bundles'
                : 'Bundles not recorded';
        }
    } else if (families.length === 0) {
        bundleNote = 'Bundles not recorded';
    }

    // ── Organization share — only an invoice's frozen figure is authoritative ─
    const organizationShare = closed && liveInvoice ? num(liveInvoice.fundraiser_profit_amount) : null;

    // ── Invoice / payment state, through the one describer ──────────────────
    const lifecycleInput = {
        status: c.status,
        closed_at: c.closed_at,
        settled_externally: c.settled_externally,
        invoice_statuses: invoiceStatuses,
        settlement_total: num(c.settlement_total),
        held_order_count: orderCount,
    };
    const state = resolveCampaignInvoiceState(lifecycleInput);
    let invoice: CampaignFacts['invoice'] = { ...describeCampaignInvoice(lifecycleInput), state };
    if (state === 'none' && !(gross !== null && gross > 0)) {
        // Nothing was sold, so nothing is owed: "Not yet invoiced" would imply an
        // invoice is expected. The neutral truth is that none exists.
        invoice = { ...invoice, label: 'No invoice on record', canCreateInvoice: false };
    }

    return {
        c,
        impact,
        closed,
        lifecycle: classifyCampaignLifecycle(lifecycleInput),
        liveOrders,
        orderCount,
        supporterCount,
        gross,
        grossSource,
        physicalBundles,
        families,
        bundleSource,
        bundleNote,
        organizationShare,
        invoice,
        hasSalesData: grossSource !== 'none' || frozenItems.length > 0,
    };
}

function dateLabelFor(c: DashboardCampaignInput, closed: boolean, timeZone: string | null): string {
    const delivery = formatDateOnly(c.delivery_date);
    if (delivery) return `Delivery ${delivery}`;
    const deadline = formatDateOnly(c.end_date);
    if (deadline) return closed ? `Orders closed ${deadline}` : `Orders close ${deadline}`;
    const closedOn = formatTimestampDate(c.closed_at, timeZone);
    if (closedOn) return `Closed ${closedOn}`;
    return 'No delivery date recorded';
}

function metricsLabelFor(f: CampaignFacts): string | null {
    // A running fundraiser with nothing sold yet has data — it is zero so far.
    // Only CLOSED history can be missing its record.
    if (!f.hasSalesData) return f.closed ? null : 'No orders yet';
    const parts: string[] = [plural(f.supporterCount, 'supporter', 'supporters')];
    if (f.physicalBundles !== null) parts.push(plural(f.physicalBundles, 'bundle', 'bundles'));
    if (f.gross !== null) parts.push(`${formatDollars(f.gross)} sales${f.closed ? '' : ' so far'}`);
    return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMING — inferred from history, never called a preference
// ─────────────────────────────────────────────────────────────────────────────

export function describeTimingPattern(dates: readonly Date[], realCampaignCount: number): DashboardIntelligence['timing'] {
    const n = dates.length;
    if (n === 0) {
        return { label: realCampaignCount === 0 ? 'No fundraisers yet' : 'No fundraiser dates recorded', muted: true, datedCount: 0 };
    }
    if (n === 1) {
        return {
            label: realCampaignCount <= 1 ? 'Not enough history (1 fundraiser)' : 'Not enough history (1 dated fundraiser)',
            muted: true,
            datedCount: 1,
        };
    }
    const counts = new Array(12).fill(0) as number[];
    for (const d of dates) counts[d.getUTCMonth()] += 1;
    const max = Math.max(...counts);
    const join = (names: string[]) =>
        names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    if (max >= 2) {
        const months = counts.map((cnt, i) => (cnt === max ? MONTHS_LONG[i] : null)).filter((m): m is string => !!m);
        const share = months.length === 1 ? `${max} of ${n} fundraisers` : `${max} each of ${n} fundraisers`;
        return { label: `${join(months)} (${share})`, muted: false, datedCount: n };
    }
    const months = counts.map((cnt, i) => (cnt > 0 ? MONTHS_LONG[i] : null)).filter((m): m is string => !!m);
    return { label: `No repeating month yet (${join(months)})`, muted: false, datedCount: n };
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKETING — only what FreezerIQ recorded
// ─────────────────────────────────────────────────────────────────────────────

function latest(...values: DateLike[]): Date | null {
    const ds = values.map((v) => toDate(v)).filter((d): d is Date => !!d);
    return ds.length ? new Date(Math.max(...ds.map((d) => d.getTime()))) : null;
}

function earliest(...values: DateLike[]): Date | null {
    const ds = values.map((v) => toDate(v)).filter((d): d is Date => !!d);
    return ds.length ? new Date(Math.min(...ds.map((d) => d.getTime()))) : null;
}

export function buildMarketingEntries(m: DashboardMarketingInput, timeZone: string | null): MarketingEntry[] {
    const entries: MarketingEntry[] = [];

    for (const s of m.seasonal) {
        // Real attempts only arrive here (the loader excludes test sends). An
        // address that was in an audience but never attempted is not activity.
        const accepted = s.attempts.filter((a) => a.status === 'accepted');
        const failed = s.attempts.filter((a) => a.status === 'failed');
        const skipped = s.attempts.filter((a) => a.status === 'skipped_suppressed');
        if (s.attempts.length === 0) continue;
        let stateLabel: string;
        let tone: Tone;
        let at: Date | null;
        if (accepted.length > 0) {
            stateLabel = 'Sent'; tone = 'good';
            at = earliest(...accepted.map((a) => a.accepted_at ?? a.created_at));
        } else if (failed.length > 0) {
            stateLabel = 'Not sent — the email failed'; tone = 'warn';
            at = latest(...failed.map((a) => a.failed_at ?? a.created_at));
        } else if (skipped.length > 0) {
            stateLabel = 'Not sent — opted out'; tone = 'neutral';
            at = latest(...skipped.map((a) => a.skipped_at ?? a.created_at));
        } else {
            stateLabel = 'Send not confirmed'; tone = 'pending';
            at = latest(...s.attempts.map((a) => a.created_at));
        }
        const dateLabel = formatTimestampDate(at, timeZone);
        entries.push({
            id: `seasonal:${s.batchId}`,
            kind: 'seasonal_update',
            title: `Seasonal update · ${s.offeringName}`,
            stateLabel,
            tone,
            detail: null,
            at: at?.toISOString() ?? null,
            dateLabel,
        });
    }

    for (const p of m.previousSupporters) {
        const total = p.accepted + p.failed + p.skipped + p.queued;
        if (total === 0) continue;
        let stateLabel: string;
        let tone: Tone;
        if (p.accepted > 0 && p.failed === 0) { stateLabel = 'Sent'; tone = 'good'; }
        else if (p.accepted > 0) { stateLabel = 'Sent with issues'; tone = 'pending'; }
        else if (p.failed > 0) { stateLabel = 'Not sent — every email failed'; tone = 'warn'; }
        else if (p.skipped > 0) { stateLabel = 'Not sent — everyone opted out'; tone = 'neutral'; }
        else { stateLabel = 'Send not confirmed'; tone = 'pending'; }
        const bits: string[] = [];
        if (p.accepted > 0) bits.push(`${p.accepted} sent`);
        if (p.failed > 0) bits.push(`${p.failed} failed`);
        if (p.skipped > 0) bits.push(`${p.skipped} skipped (opted out)`);
        if (p.queued > 0) bits.push(`${p.queued} not confirmed`);
        const at = toDate(p.lastActivityAt);
        entries.push({
            id: `previous_supporters:${p.batchId}`,
            kind: 'previous_supporters',
            title: `Previous supporters invitation · ${p.campaignName}`,
            stateLabel,
            tone,
            detail: bits.join(' · ') || null,
            at: at?.toISOString() ?? null,
            dateLabel: formatTimestampDate(at, timeZone),
        });
    }

    for (const r of m.rebookingResponses) {
        entries.push({
            id: `rebooking:${r.submissionId}`,
            kind: 'rebooking_response',
            title: `Rebooking response · ${r.offeringName}`,
            stateLabel: r.selected ? 'Responded — interested' : 'Responded — not this season',
            tone: r.selected ? 'good' : 'neutral',
            detail: r.revisionNumber > 1 ? 'They updated their response' : null,
            at: toDate(r.respondedAt)?.toISOString() ?? null,
            dateLabel: formatTimestampDate(r.respondedAt, timeZone),
        });
    }

    return entries.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// CURRENT WORK
// ─────────────────────────────────────────────────────────────────────────────

export function buildOpportunityCard(o: DashboardOpportunityInput | null, timeZone: string | null): CurrentOpportunityCard | null {
    if (!o || !(OPEN_OPPORTUNITY_STATUSES as readonly string[]).includes(o.status)) return null;
    const inquiries = Array.isArray(o.inquiries) ? o.inquiries : [];
    const kind: CurrentOpportunityCard['kind'] = inquiries.length === 0 ? 'planning' : 'inquiry';
    const discard = evaluateDraftDiscard({
        status: o.status,
        first_response_at: o.first_response_at,
        preferred_delivery_date: o.preferred_delivery_date,
        alternate_delivery_date: o.alternate_delivery_date,
        confirmed_delivery_date: o.confirmed_delivery_date,
        campaign_id: o.campaign_id,
        converted_at: o.converted_at,
        lost_at: o.lost_at,
        lost_reason: o.lost_reason,
        notes: o.notes,
        participant_estimate: o.participant_estimate,
        inquiry_count: inquiries.length,
    });

    const confirmed = formatDateOnly(o.confirmed_delivery_date);
    const preferred = formatDateOnly(o.preferred_delivery_date);
    const alternate = formatDateOnly(o.alternate_delivery_date);
    const dateLine = o.status === 'date_confirmed' && confirmed
        ? `Delivery date confirmed: ${confirmed} — ready to launch`
        : preferred
            ? `Preferred delivery ${preferred}${alternate ? ` · alternate ${alternate}` : ''} — not confirmed yet`
            : 'No delivery date confirmed yet';

    const lines: string[] = [dateLine];
    if (kind === 'planning') {
        const started = formatTimestampDate(o.created_at, timeZone);
        lines.push(`Started by you${started ? ` on ${started}` : ''} · no website inquiry`);
    } else {
        const newest = inquiries[inquiries.length - 1];
        const received = formatTimestampDate(newest.received_at, timeZone);
        const who = newest.contact_name?.trim();
        lines.push(`Inquiry received${received ? ` ${received}` : ''}${who ? ` from ${who}` : ''} via ${sourceChannelLabel(newest.source_channel)}`
            + (inquiries.length > 1 ? ` · ${inquiries.length} inquiries in all` : ''));
    }

    const chip: Pick<CurrentOpportunityCard, 'chipLabel' | 'chipTone'> = o.status === 'date_confirmed'
        ? { chipLabel: 'Date confirmed', chipTone: 'emerald' }
        : kind === 'planning'
            ? { chipLabel: 'Planning', chipTone: 'sky' }
            : { chipLabel: 'Inquiry', chipTone: 'amber' };

    return {
        id: o.id,
        kind,
        status: o.status,
        title: kind === 'planning' ? 'Planning next fundraiser' : 'Fundraiser inquiry',
        ...chip,
        lines,
        discard,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

export function buildOrganizationDashboard(input: OrganizationDashboardInput, now: Date): OrganizationDashboard {
    const { organization, timeZone } = input;
    const campaigns = Array.isArray(input.campaigns) ? input.campaigns : [];
    const ordersByCampaign = new Map<string, DashboardOrderInput[]>();
    for (const o of input.orders ?? []) {
        if (!o.campaign_id) continue;
        if (!ordersByCampaign.has(o.campaign_id)) ordersByCampaign.set(o.campaign_id, []);
        ordersByCampaign.get(o.campaign_id)!.push(o);
    }
    const ordersOf = (id: string) => ordersByCampaign.get(id) ?? [];

    // ── Lifetime figures: the Organizations tab's own authority ─────────────
    const impact = computeOrganizationImpact({
        organizationId: organization.id,
        organizationName: organization.name,
        campaigns: campaigns.map((c) => toImpactCampaign(c, ordersOf(c.id))),
    }, now);

    // ── Supporters: the invitation's own path, every campaign included ──────
    const audience = derivePreviousSupporters(input.audience);

    // ── One fact sheet per REAL campaign (never-started Lead rows excluded,
    //    exactly as impact.campaignCount excludes them) ───────────────────────
    const real = campaigns.filter((c) => isRealCampaign(c));
    const facts = real
        .map((c) => campaignFacts(c, ordersOf(c.id), input.audience))
        .sort((a, b) => historySortTime(b.c) - historySortTime(a.c));

    // ── KPIs ────────────────────────────────────────────────────────────────
    // Closed history with no settlement, no orders and no invoice lines adds
    // nothing to the lifetime figure — say so, rather than let the total look
    // complete. A running fundraiser with no orders yet is not missing data.
    const missingHistory = facts.filter((f) => f.closed && !f.hasSalesData).length;
    const running = facts.filter((f) => f.lifecycle === 'open');
    const kpis: DashboardKpis = {
        lifetimeSales: impact.lifetimeFundraiserSales,
        lifetimeSalesLabel: impact.campaignCount === 0 ? '—' : formatDollars(impact.lifetimeFundraiserSales),
        lifetimeSalesHelper: impact.campaignCount === 0
            ? 'No fundraisers yet'
            : missingHistory > 0
                ? `${missingHistory} past ${missingHistory === 1 ? 'campaign has' : 'campaigns have'} no sales data recorded`
                : running.some((f) => f.grossSource === 'live_orders')
                    ? 'Includes sales from the fundraiser running now'
                    : null,
        campaignsRun: impact.campaignCount,
        campaignsHelper: running.length > 0 ? `${running.length} running now` : null,
        supportersOnFile: audience.supporterCount,
        supportersHelper: audience.supporterCount === 0 ? 'Supporters are added as orders come in' : null,
        emailReady: audience.reachableCount,
        emailReadyHelper: audience.supporterCount > 0
            ? `${audience.reachableCount} of ${audience.supporterCount} previous ${audience.supporterCount === 1 ? 'supporter' : 'supporters'} can currently be invited by email.`
            : null,
        noUsableEmail: audience.noEmailCount,
        optedOut: audience.suppressedCount,
    };

    // ── History: every real campaign, newest first ───────────────────────────
    const history: HistoryRow[] = facts.map((f) => {
        const stage = campaignDisplayStage({
            status: f.c.status,
            closed_at: f.c.closed_at,
            bundle_selection_status: f.c.bundle_selection_status,
        });
        return {
            id: f.c.id,
            name: f.c.name,
            stageLabel: stage.label,
            stageKey: stage.key,
            status: f.c.status,
            closedAt: isoOrNull(f.c.closed_at),
            bundleSelectionStatus: f.c.bundle_selection_status,
            isOpen: !f.closed,
            dateLabel: dateLabelFor(f.c, f.closed, timeZone),
            metricsLabel: metricsLabelFor(f),
            bundleFamilies: f.families,
            bundleNote: f.bundleNote,
            shareLabel: f.organizationShare !== null ? formatDollars(f.organizationShare) : null,
            invoiceLabel: f.closed ? f.invoice.label : null,
            invoiceTone: f.closed ? f.invoice.tone : null,
            supporterCount: f.supporterCount,
            orderCount: f.orderCount,
            physicalBundles: f.physicalBundles,
            gross: f.gross,
            grossSource: f.grossSource,
            organizationShare: f.organizationShare,
            bundleSource: f.bundleSource,
        };
    });

    // ── Current work ────────────────────────────────────────────────────────
    const currentCampaigns: CurrentCampaignCard[] = running
        .slice()
        .sort((a, b) => historySortTime(a.c) - historySortTime(b.c))
        .map((f) => {
            const stage = campaignDisplayStage({
                status: f.c.status,
                closed_at: f.c.closed_at,
                bundle_selection_status: f.c.bundle_selection_status,
            });
            const delivery = formatDateOnly(f.c.delivery_date);
            const deadline = formatDateOnly(f.c.end_date);
            return {
                id: f.c.id,
                name: f.c.name,
                stageLabel: stage.label,
                stageKey: stage.key,
                status: f.c.status,
                closedAt: isoOrNull(f.c.closed_at),
                bundleSelectionStatus: f.c.bundle_selection_status,
                dateLine: [
                    delivery ? `Delivery ${delivery}` : 'No delivery date set',
                    deadline ? `Orders close ${deadline}` : null,
                ].filter(Boolean).join(' · '),
                figuresLine: f.orderCount > 0
                    ? `${formatDollars(f.gross ?? 0)} sales so far · ${plural(f.orderCount, 'order', 'orders')}`
                    : 'No orders yet',
            };
        });

    const invoiceFollowUps: InvoiceFollowUp[] = facts
        .filter((f) => f.closed && (f.invoice.state === 'draft' || f.invoice.state === 'sent' || f.invoice.state === 'overdue'))
        .map((f) => ({ campaignId: f.c.id, campaignName: f.c.name, label: f.invoice.label, tone: f.invoice.tone }));

    // ── Relationship intelligence ───────────────────────────────────────────
    const lastClosed = facts.find((f) => f.closed) ?? null;
    const timing = describeTimingPattern(
        real.map(credibleFundraiserDate).filter((d): d is Date => !!d),
        real.length,
    );
    const breakdown: string[] = [];
    if (audience.noEmailCount > 0) breakdown.push(`${audience.noEmailCount} without a usable email`);
    if (audience.suppressedCount > 0) breakdown.push(`${audience.suppressedCount} opted out`);

    const intelligence: DashboardIntelligence = {
        lastFundraiser: lastClosed
            ? {
                campaignId: lastClosed.c.id,
                name: lastClosed.c.name,
                dateLabel: dateLabelFor(lastClosed.c, true, timeZone),
                resultLabel: lastClosed.hasSalesData
                    ? [
                        lastClosed.physicalBundles !== null ? plural(lastClosed.physicalBundles, 'bundle', 'bundles') : null,
                        lastClosed.gross !== null ? formatDollars(lastClosed.gross) : null,
                    ].filter(Boolean).join(' · ') || 'No sales data recorded'
                    : 'No sales data recorded',
                bundleFamilies: lastClosed.families,
                supporterCount: lastClosed.supporterCount,
            }
            : null,
        timing,
        supportersOnFile: audience.supporterCount,
        emailReady: audience.reachableCount,
        emailReadyBreakdown: breakdown.length ? breakdown.join(' · ') : null,
    };

    return {
        organization: { id: organization.id, name: organization.name, archived: organization.archived },
        kpis,
        current: {
            campaigns: currentCampaigns,
            opportunity: buildOpportunityCard(input.openOpportunity, timeZone),
            invoiceFollowUps,
        },
        intelligence,
        history,
        marketing: buildMarketingEntries(input.marketing, timeZone),
        rebooking: {
            archived: organization.archived,
            // EVERY campaign, Lead rows included — the same population
            // POST /api/opportunities evaluates, so the button and the route agree.
            campaigns: campaigns.map((c) => ({
                id: c.id,
                status: c.status,
                closed_at: isoOrNull(c.closed_at),
                settlement_total: num(c.settlement_total),
                settled_externally: c.settled_externally,
                invoice_statuses: c.invoices.map((i) => String(i.status)),
                held_order_count: ordersOf(c.id).filter((o) => !toDate(o.canceled_at)).length,
            })),
        },
    };
}
