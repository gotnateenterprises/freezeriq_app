/**
 * PACKED-READY-WAVES-1 — fundraiser "waves" in the Packed & Ready lane.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §1 (the grouping key is the
 * campaign), §11 (reuse the canonical authorities, never re-derive them). Audit:
 * PROD-FUNDRAISER-WAVES-AUDIT-1.
 *
 * THE PROBLEM
 *
 * Several fundraisers sit in Packed & Ready together, each with its own delivery date.
 * The lane listed every order with no sign of which fundraiser it belonged to, "Box
 * Labels — All Orders" ignored any selection, and an empty selection meant "send every
 * fundraiser". The owner needs to say "the first fundraiser delivers this week", select
 * exactly that fundraiser's orders, and have Box Labels, Packing Slips and Send to
 * Delivery use only those.
 *
 * WHAT THIS MODULE IS: A SELECTION LAYER, NOTHING MORE
 *
 * A wave is a name for a set of Order IDs the lane already holds. Selecting a wave puts
 * exactly those ids into the SAME `Set<Order.id>` the per-order checkboxes already use,
 * and the existing exact-id mechanisms consume it unchanged:
 *
 *     wave -> Set<Order.id> -> writeBoxLabelBatch / writePackingSlipBatch -> print pages
 *                           -> POST /api/delivery/handoff   (the one mutation authority)
 *
 * There is no new route, no new batch type, no campaign-level mutation. The server never
 * learns that a wave existed: it still receives opaque Order IDs and re-checks tenant and
 * eligibility on every one.
 *
 * THE GROUPING KEY IS FundraiserCampaign.id — NOTHING ELSE
 *
 * Not the organization, not the organization's name, not the campaign's name, not the
 * delivery date, not Order.customer_id. One organization can run several campaigns (the
 * live data already has two organizations with a second, empty campaign), and those are
 * separate waves. Names and dates here are LABELS: nothing in this module, and nothing a
 * caller does with its output, treats text as authority. When two waves would read
 * identically their campaign-id tag is shown so the operator can still tell them apart.
 *
 * WHICH ORDERS FORM A WAVE is `isFundraiserFulfillmentOrder` (source === 'fundraiser' AND
 * a non-blank campaign_id), the one canonical conjunction. An order carrying only one of
 * the two signals is "ambiguous" by that module's own ruling and is deliberately NOT
 * sorted into a wave on a guess; it stays with the ordinary orders. (Production has zero
 * such rows; this only decides what the code does if one ever appears.)
 *
 * THE DISPLAYED ORGANIZATION is `resolveOrganizationName` — the exact resolver the outer
 * box label calls — so the lane can never name a different fundraiser than the label
 * prints for the same order.
 *
 * DISPLAY AND SELECTION ONLY. Pure: no Prisma, no React, no I/O, no mutation of its
 * arguments. Client-safe (it imports only other pure modules).
 */
import { isFundraiserFulfillmentOrder } from './delivery/orderClassification';
import { resolveOrganizationName } from './supporterBoxManifest';
import { formatCalendarDateShortValue, toCalendarInputValue } from './calendarDate';

/** What a Packed & Ready order must expose for this module. All optional: absent = unknown. */
export interface WaveOrder {
    id: string;
    source?: string | null;
    campaign_id?: string | null;
    campaign?: {
        name?: string | null;
        /** Campaign.delivery_date — a DATE column; arrives from JSON as an ISO string. */
        delivery_date?: string | Date | null;
        /** The campaign's OWNING organization — never Order.customer. */
        customer?: { name?: string | null } | null;
    } | null;
}

export interface FundraiserWave {
    /** FundraiserCampaign.id — the ONLY grouping key. */
    campaignId: string;
    /** Display only: organization name, else campaign name, else a neutral fallback. */
    label: string;
    /** Calendar date of Campaign.delivery_date as "YYYY-MM-DD", or null when unset. */
    deliveryDate: string | null;
    /** "Oct 21, 2026" — read from the stored UTC calendar fields, never a local zone. */
    deliveryDateLabel: string | null;
    /** The exact Order IDs of this campaign currently in the lane, in lane order. */
    orderIds: string[];
    /** Short campaign tag, set ONLY when another wave would otherwise read identically. */
    disambiguator: string | null;
}

export interface DateGroup {
    /** "YYYY-MM-DD", or null for campaigns with no delivery date on record. */
    dateKey: string | null;
    dateLabel: string | null;
    waves: FundraiserWave[];
}

export interface LaneComposition {
    waves: FundraiserWave[];
    /** Orders that belong to no wave: ordinary orders and any ambiguous row. */
    otherOrderIds: string[];
    /** Distinct populations: each wave counts once, and "other orders" counts once. */
    groupCount: number;
    /** True when more than one population is present, so "all" would be ambiguous. */
    mixed: boolean;
}

/** Shortest campaign-id prefix used to tell two identically named fundraisers apart. */
const MIN_TAG_LENGTH = 6;

/** Neutral text for a campaign whose organization and own name are both blank. */
export const UNNAMED_FUNDRAISER_LABEL = 'Unnamed fundraiser';
/** The label for the population that belongs to no wave. */
export const OTHER_ORDERS_LABEL = 'Other orders';

/**
 * Is this a fundraiser fulfillment order? Asks the canonical classifier about the TWO
 * signals it is defined on (source, campaign_id) and nothing else, so the joined campaign
 * object — a display label here — can never influence membership.
 */
function isWaveOrder(order: WaveOrder): boolean {
    return isFundraiserFulfillmentOrder({ source: order.source, campaign_id: order.campaign_id });
}

/**
 * The fundraiser organization to DISPLAY for an order, or null for a non-fundraiser.
 *
 * Calls the box label's own resolver (campaign.customer.name, else campaign.name) the
 * way lib/orderRecipientName.ts calls the label's supporter resolver: with a minimal
 * BoxManifestOrder that carries only the two fields it reads. Order.customer is not
 * even accepted here.
 */
export function fundraiserOrganizationFor(order: WaveOrder | null | undefined): string | null {
    if (!order || !isWaveOrder(order)) return null;
    return resolveOrganizationName({
        id: order.id ?? '',
        first_name: null,
        last_name: null,
        customer_name: null,
        campaign_organization_name: order.campaign?.customer?.name ?? null,
        campaign_name: order.campaign?.name ?? null,
        items: [],
    });
}

/** Normalises a Campaign.delivery_date value to "YYYY-MM-DD", or null when unusable. */
function calendarKey(value: string | Date | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : toCalendarInputValue(d);
}

/**
 * Group the lane's fundraiser orders into waves, keyed by FundraiserCampaign.id.
 *
 * Sorted by delivery date (earliest first, undated last), then by label, then by campaign
 * id, so the order is stable and independent of how the rows arrived.
 */
export function groupFundraiserWaves(orders: readonly WaveOrder[] | null | undefined): FundraiserWave[] {
    const byCampaign = new Map<string, FundraiserWave>();

    for (const order of orders || []) {
        if (!order || typeof order.id !== 'string' || order.id === '') continue;
        if (!isWaveOrder(order)) continue;

        // isFundraiserFulfillmentOrder guarantees a non-blank campaign_id.
        const campaignId = String(order.campaign_id).trim();
        const existing = byCampaign.get(campaignId);
        if (existing) {
            existing.orderIds.push(order.id);
            continue;
        }

        const deliveryDate = calendarKey(order.campaign?.delivery_date);
        byCampaign.set(campaignId, {
            campaignId,
            label: fundraiserOrganizationFor(order) ?? UNNAMED_FUNDRAISER_LABEL,
            deliveryDate,
            deliveryDateLabel: formatCalendarDateShortValue(order.campaign?.delivery_date),
            orderIds: [order.id],
            disambiguator: null,
        });
    }

    const waves = [...byCampaign.values()].sort((a, z) => {
        if (a.deliveryDate !== z.deliveryDate) {
            if (a.deliveryDate === null) return 1;
            if (z.deliveryDate === null) return -1;
            return a.deliveryDate < z.deliveryDate ? -1 : 1;
        }
        const byLabel = a.label.localeCompare(z.label);
        if (byLabel !== 0) return byLabel;
        return a.campaignId.localeCompare(z.campaignId);
    });

    // Two campaigns that read identically (same organization, e.g. a second campaign) must
    // stay tellable apart. The tag is a prefix of the REAL key, shown only when needed, and it
    // is lengthened just enough to be unique within its group — so two chips can never end
    // up looking the same, whatever their ids happen to share.
    const byLabel = new Map<string, FundraiserWave[]>();
    for (const w of waves) {
        const key = w.label.toLowerCase();
        byLabel.set(key, [...(byLabel.get(key) ?? []), w]);
    }
    for (const group of byLabel.values()) {
        if (group.length < 2) continue;
        let length = MIN_TAG_LENGTH;
        const longest = Math.max(...group.map((w) => w.campaignId.length));
        while (length < longest && new Set(group.map((w) => w.campaignId.slice(0, length))).size < group.length) length += 1;
        for (const w of group) w.disambiguator = w.campaignId.slice(0, length);
    }

    return waves;
}

/** Waves grouped under their delivery date, in date order. Undated campaigns come last. */
export function groupWavesByDate(waves: readonly FundraiserWave[]): DateGroup[] {
    const groups: DateGroup[] = [];
    for (const wave of waves) {
        const last = groups[groups.length - 1];
        if (last && last.dateKey === wave.deliveryDate) {
            last.waves.push(wave);
        } else {
            groups.push({ dateKey: wave.deliveryDate, dateLabel: wave.deliveryDateLabel, waves: [wave] });
        }
    }
    return groups;
}

/** Which populations the lane holds, and whether an unqualified "all" would be ambiguous. */
export function describeLane(orders: readonly WaveOrder[] | null | undefined): LaneComposition {
    const waves = groupFundraiserWaves(orders);
    const inWave = new Set<string>();
    for (const w of waves) for (const id of w.orderIds) inWave.add(id);

    const otherOrderIds: string[] = [];
    for (const o of orders || []) {
        if (o && typeof o.id === 'string' && o.id !== '' && !inWave.has(o.id)) otherOrderIds.push(o.id);
    }

    const groupCount = waves.length + (otherOrderIds.length > 0 ? 1 : 0);
    return { waves, otherOrderIds, groupCount, mixed: groupCount >= 2 };
}

// ── selection: pure set operations over Order IDs ────────────────────────────────────

export type WaveSelectionState = 'none' | 'some' | 'all';

/** How much of these waves' orders is currently selected. */
export function waveSelectionState(
    waves: readonly FundraiserWave[],
    selected: ReadonlySet<string>,
): WaveSelectionState {
    let total = 0;
    let chosen = 0;
    for (const w of waves) {
        for (const id of w.orderIds) {
            total += 1;
            if (selected.has(id)) chosen += 1;
        }
    }
    if (total === 0 || chosen === 0) return 'none';
    return chosen === total ? 'all' : 'some';
}

/**
 * Toggle whole waves in the selection and return a NEW set.
 *
 *   all of these waves' orders selected  -> remove exactly those ids
 *   none / some selected                 -> add exactly those ids
 *
 * Only the named waves' ids are ever added or removed; every other id in `selected`
 * (another fundraiser's, an ordinary order's, a hand-ticked one) is left exactly as it was.
 */
export function toggleWaves(
    selected: ReadonlySet<string>,
    waves: readonly FundraiserWave[],
): Set<string> {
    const next = new Set(selected);
    const everyOneSelected = waveSelectionState(waves, selected) === 'all';
    for (const w of waves) {
        for (const id of w.orderIds) {
            if (everyOneSelected) next.delete(id); else next.add(id);
        }
    }
    return next;
}

/** The selection restricted to orders actually in the lane, so a stale id is never used. */
export function pruneSelection(
    selected: ReadonlySet<string>,
    orders: readonly { id: string }[] | null | undefined,
): Set<string> {
    const live = new Set((orders || []).map((o) => o.id));
    const out = new Set<string>();
    for (const id of selected) if (live.has(id)) out.add(id);
    return out;
}

// ── scope: what exactly is about to move, in words ───────────────────────────────────

export interface ScopeLine {
    /** FundraiserCampaign.id, or null for the "Other orders" line. */
    campaignId: string | null;
    label: string;
    deliveryDateLabel: string | null;
    disambiguator: string | null;
    count: number;
}

/** "Alpha County Farm Bureau (delivery Oct 27, 2026) — 26 orders" */
export function formatScopeLine(line: ScopeLine): string {
    const tag = line.disambiguator ? ` [#${line.disambiguator}]` : '';
    const when = line.deliveryDateLabel ? ` (delivery ${line.deliveryDateLabel})` : '';
    return `${line.label}${tag}${when} — ${line.count} ${line.count === 1 ? 'order' : 'orders'}`;
}

/**
 * Break a set of target Order IDs into per-fundraiser counts for a confirmation.
 *
 * `lines` is EMPTY when no target belongs to a fundraiser, so an ordinary-only action keeps
 * its original, unembellished confirmation. Counts are computed from the ids themselves, so
 * the listed numbers always sum to the number of orders the request carries.
 */
export function describeSelectionScope(
    targetIds: readonly string[],
    orders: readonly WaveOrder[] | null | undefined,
): { total: number; lines: ScopeLine[] } {
    const targets = new Set(targetIds);
    const { waves, otherOrderIds } = describeLane(orders);

    const lines: ScopeLine[] = [];
    for (const w of waves) {
        const count = w.orderIds.filter((id) => targets.has(id)).length;
        if (count > 0) {
            lines.push({
                campaignId: w.campaignId, label: w.label, deliveryDateLabel: w.deliveryDateLabel,
                disambiguator: w.disambiguator, count,
            });
        }
    }
    if (lines.length === 0) return { total: targets.size, lines: [] };

    const otherCount = otherOrderIds.filter((id) => targets.has(id)).length;
    if (otherCount > 0) {
        lines.push({
            campaignId: null, label: OTHER_ORDERS_LABEL, deliveryDateLabel: null, disambiguator: null, count: otherCount,
        });
    }
    return { total: targets.size, lines };
}
