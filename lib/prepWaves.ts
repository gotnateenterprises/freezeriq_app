/**
 * PREP-WAVES-1 — fundraiser waves in the Kitchen Board's To Prep / In Prep lanes.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §1 (the grouping key is the campaign),
 * §6 (aggregation is allowed; identity must survive it), §11 Rule 8 (reuse, do not re-derive).
 * Audit: PROD-FUNDRAISER-WAVES-AUDIT-1.
 *
 * THE DEFECT THIS REPLACES
 *
 * A Prep card said "Family Friendly (Serves 2) — 30 units", and its button said "Start Prep".
 * The button sent `{ bundleId, currentStatus, newStatus }` and the server advanced EVERY order in
 * the tenant that was at that status and contained that bundle — every fundraiser that happened
 * to share the meal, plus ordinary orders — and the status moves with the WHOLE order. The
 * dashboard had collected the exact order ids behind each number and then deleted them before
 * answering, so the screen could not have said anything more precise. Start Prep for one
 * fundraiser's delivery moved the next fundraiser's food too, and nothing in the app can move an
 * order backwards.
 *
 * THE PRINCIPLE THIS MODULE ENFORCES
 *
 *     aggregate totals MAY span campaigns; the scope of a status action MAY NOT.
 *
 * Three different things, kept apart:
 *   A. Kitchen aggregate  — "how many Family Friendly do we make?" Spans campaigns. Informational.
 *   B. Fundraiser wave    — "which campaign's food are we working now?" Keyed by
 *                           FundraiserCampaign.id. THE UNIT OF A STATUS ACTION.
 *   C. Physical order     — a status belongs to the ORDER, never to one bundle line of it.
 *
 * WHAT A WAVE IS HERE
 *
 * A wave is a name for a set of exact Order IDs in one lane (To Prep or In Prep). The operator
 * ticks waves; this module resolves the ticked waves to those Order IDs; the UI posts them to the
 * existing exact-id route (/api/orders/bulk-status). No new route, no new batch table, no schema.
 * Nothing here decides WHETHER an order may change — the server still re-reads every id, refuses
 * foreign, canceled and illegal ones, and writes all-or-nothing under a per-row compare-and-set.
 *
 * REUSE, NOT RE-DERIVATION
 *
 * Which orders form a fundraiser wave (source + campaign_id, never one signal), the grouping key,
 * labels, date reading, the campaign tag for look-alike names, selection arithmetic and the
 * confirmation scope all come from lib/packedReadyWaves.ts (PACKED-READY-WAVES-1), so the Prep
 * lanes and the Packed & Ready lane can never disagree about what a fundraiser is. Ordinary
 * orders — and any order carrying only ONE fundraiser signal, which the classifier refuses to
 * guess — belong to no wave: they stay in the "other orders" population and keep acting per bundle
 * card, but on THEIR OWN exact ids, never on a fundraiser's.
 *
 * DISPLAY AND SELECTION ONLY. Pure: no Prisma, no React, no I/O, no mutation of its arguments.
 */
import {
    describeLane,
    describeSelectionScope,
    formatScopeLine,
    type FundraiserWave,
    type ScopeLine,
    type WaveOrder,
} from './packedReadyWaves';
import { physicalMealCount } from './mealManifest';
import { servingTierLabel } from './mealLabel';

export type PrepLaneKey = 'ready' | 'inprod';
export type PrepAction = 'start_prep' | 'mark_packed';

/** The lane an order status belongs to — the same bucketing PrepList has always used. */
export function prepLaneOf(status: string | null | undefined): PrepLaneKey {
    const raw = status || 'production_ready';
    if (raw === 'in_production' || raw === 'IN_PRODUCTION') return 'inprod';
    return 'ready'; // production_ready, APPROVED, and (as before) anything unknown
}

/** What each action may write. Exact strings: the exact-id route matches them verbatim. */
export const PREP_ACTION_STATUS: Record<PrepAction, 'in_production' | 'ready_to_ship'> = {
    start_prep: 'in_production',
    mark_packed: 'ready_to_ship',
};
export const PREP_ACTION_LABEL: Record<PrepAction, string> = {
    start_prep: 'Start Prep',
    mark_packed: 'Mark Packed & Ready',
};

// ── the dashboard's Prep payload, as this module reads it ───────────────────────────

/** One ORDER's contribution to one Prep row (see app/api/production/dashboard/route.ts). */
export interface PrepSource {
    order_id: string;
    source?: string | null;
    campaign_id?: string | null;
    /** Bundle units this order contributes to this row (its lines for this bundle + tier, summed). */
    quantity: number;
    order_item_ids?: string[];
}

export interface PrepRow {
    bundle_id: string;
    bundle_name: string;
    sku?: string | null;
    total_quantity: number;
    order_count?: number;
    variant_size?: string | null;
    /** Raw Order.status shared by every order in this row. */
    status: string;
    recipes?: { id: string; name: string; quantity: number }[];
    sources?: PrepSource[];
}

/** Label data keyed by FundraiserCampaign.id. Display only — never a key, never sent anywhere. */
export type PrepCampaigns = Record<string, {
    id?: string;
    name?: string | null;
    delivery_date?: string | Date | null;
    customer?: { name?: string | null } | null;
}>;

/** React key for a row. The old key (bundle id alone) collided when a bundle had two tiers or two statuses. */
export function prepRowKey(row: Pick<PrepRow, 'bundle_id' | 'status' | 'variant_size'>): string {
    return `${row.bundle_id}-${row.status}-${row.variant_size ?? 'unknown'}`;
}

// ── the model ────────────────────────────────────────────────────────────────────────

export interface PrepOrderLine {
    bundleId: string;
    bundleName: string;
    sku: string | null;
    variantSize: string | null;
    units: number;
}

/**
 * One kitchen ORDER, once — however many bundles it holds. A multi-bundle order appears on several
 * Prep cards but is ONE order here, because the status belongs to the order: moving it moves every
 * bundle in it. Extends WaveOrder, so the Packed & Ready grouping applies to it unchanged.
 */
export interface PrepOrder extends WaveOrder {
    lane: PrepLaneKey;
    status: string;
    lines: PrepOrderLine[];
    itemIds: string[];
}

export interface PrepLane {
    key: PrepLaneKey;
    /** Every distinct order in this lane, in row order. */
    orders: PrepOrder[];
    /** Fundraiser waves, keyed by FundraiserCampaign.id (delivery date, then label). */
    waves: FundraiserWave[];
    /** Orders in no wave: ordinary orders and any one-signal (ambiguous) row. */
    otherOrderIds: string[];
}

export interface PrepModel {
    ready: PrepLane;
    inprod: PrepLane;
    /** Orders whose rows disagree about their lane. Impossible for real data; never actionable if it happens. */
    conflicted: string[];
}

/**
 * Turn the dashboard's Prep rows into lanes of distinct orders and fundraiser waves.
 *
 * An order that shows up in rows of two different lanes would have two statuses, which cannot be
 * true; if it ever appears it is left out of every actionable group (fail closed) rather than
 * guessed into one.
 */
export function buildPrepModel(
    rows: readonly PrepRow[] | null | undefined,
    campaigns?: PrepCampaigns | null,
): PrepModel {
    const byOrder = new Map<string, PrepOrder>();
    const conflicted = new Set<string>();

    for (const row of rows || []) {
        if (!row) continue;
        const lane = prepLaneOf(row.status);
        for (const s of row.sources || []) {
            if (!s || typeof s.order_id !== 'string' || s.order_id === '') continue;

            let order = byOrder.get(s.order_id);
            if (!order) {
                const campaignId = s.campaign_id ?? null;
                const label = campaignId ? campaigns?.[campaignId] ?? null : null;
                order = {
                    id: s.order_id,
                    source: s.source ?? null,
                    campaign_id: campaignId,
                    // Label fields only; membership is decided by source + campaign_id, never by this object.
                    campaign: label
                        ? { name: label.name ?? null, delivery_date: label.delivery_date ?? null, customer: label.customer ?? null }
                        : null,
                    lane,
                    status: row.status,
                    lines: [],
                    itemIds: [],
                };
                byOrder.set(s.order_id, order);
            } else if (order.lane !== lane) {
                conflicted.add(s.order_id);
            }

            order.lines.push({
                bundleId: row.bundle_id,
                bundleName: row.bundle_name,
                sku: row.sku ?? null,
                variantSize: row.variant_size ?? null,
                units: Number(s.quantity) || 0,
            });
            for (const id of s.order_item_ids || []) order.itemIds.push(id);
        }
    }

    const build = (key: PrepLaneKey): PrepLane => {
        const orders = [...byOrder.values()].filter((o) => o.lane === key && !conflicted.has(o.id));
        const composition = describeLane(orders);
        return { key, orders, waves: composition.waves, otherOrderIds: composition.otherOrderIds };
    };
    return { ready: build('ready'), inprod: build('inprod'), conflicted: [...conflicted] };
}

// ── what the cards say about who is behind a number ─────────────────────────────────

export interface PrepBreakdownPart {
    /** FundraiserCampaign.id, or null for the "other orders" part. */
    campaignId: string | null;
    label: string;
    deliveryDateLabel: string | null;
    disambiguator: string | null;
    units: number;
    orders: number;
}

/**
 * The campaign contributions behind one Prep card's total.
 *
 * Computed from the card's own sources every time it renders, so after a refresh it cannot show
 * arithmetic the server no longer agrees with. The parts always sum to the card's quantity.
 */
export function rowBreakdown(row: PrepRow, model: PrepModel): PrepBreakdownPart[] {
    const lane = model[prepLaneOf(row.status)];
    const waveOf = new Map<string, FundraiserWave>();
    for (const w of lane.waves) for (const id of w.orderIds) waveOf.set(id, w);

    const parts = new Map<string | null, { wave: FundraiserWave | null; units: number; orders: Set<string> }>();
    for (const s of row.sources || []) {
        if (!s || typeof s.order_id !== 'string') continue;
        const wave = waveOf.get(s.order_id) ?? null;
        const key = wave ? wave.campaignId : null;
        const part = parts.get(key) ?? { wave, units: 0, orders: new Set<string>() };
        part.units += Number(s.quantity) || 0;
        part.orders.add(s.order_id);
        parts.set(key, part);
    }

    const order = (p: { wave: FundraiserWave | null }) => (p.wave ? lane.waves.indexOf(p.wave) : Number.MAX_SAFE_INTEGER);
    return [...parts.values()]
        .sort((a, z) => order(a) - order(z))
        .map((p) => p.wave
            ? { campaignId: p.wave.campaignId, label: p.wave.label, deliveryDateLabel: p.wave.deliveryDateLabel, disambiguator: p.wave.disambiguator, units: p.units, orders: p.orders.size }
            : { campaignId: null, label: 'Other orders', deliveryDateLabel: null, disambiguator: null, units: p.units, orders: p.orders.size });
}

/** The ids of this card's NON-fundraiser orders — what its own button may act on, and nothing more. */
export function rowOrdinaryOrderIds(row: PrepRow, model: PrepModel): string[] {
    const lane = model[prepLaneOf(row.status)];
    const other = new Set(lane.otherOrderIds);
    const ids: string[] = [];
    for (const s of row.sources || []) {
        if (s && other.has(s.order_id) && !ids.includes(s.order_id)) ids.push(s.order_id);
    }
    return ids;
}

// ── what a wave contains ─────────────────────────────────────────────────────────────

export interface PrepWaveLine {
    bundleId: string;
    bundleName: string;
    variantSize: string | null;
    tierLabel: string | null;
    units: number;
    orders: number;
}

/**
 * The bundles inside one wave's orders. The status action moves whole ORDERS, so this is the honest
 * answer to "what exactly will move": every bundle in every one of these orders, not one line of it.
 */
export function waveLines(lane: PrepLane, wave: FundraiserWave): PrepWaveLine[] {
    const inWave = new Set(wave.orderIds);
    const lines = new Map<string, PrepWaveLine & { orderSet: Set<string> }>();
    for (const order of lane.orders) {
        if (!inWave.has(order.id)) continue;
        for (const l of order.lines) {
            const key = `${l.bundleId}|${l.variantSize ?? ''}`;
            const line = lines.get(key) ?? {
                bundleId: l.bundleId, bundleName: l.bundleName, variantSize: l.variantSize,
                tierLabel: servingTierLabel(l.variantSize), units: 0, orders: 0, orderSet: new Set<string>(),
            };
            line.units += l.units;
            line.orderSet.add(order.id);
            line.orders = line.orderSet.size;
            lines.set(key, line);
        }
    }
    return [...lines.values()]
        .map(({ orderSet, ...l }) => l)
        .sort((a, z) => a.bundleName.localeCompare(z.bundleName) || String(a.variantSize).localeCompare(String(z.variantSize)));
}

/** Total bundle units across a wave's orders (informational; the action is counted in ORDERS). */
export function waveUnitCount(lane: PrepLane, wave: FundraiserWave): number {
    return waveLines(lane, wave).reduce((n, l) => n + l.units, 0);
}

// ── selection → exact order ids ──────────────────────────────────────────────────────

export interface ResolvedPrepSelection {
    /** The EXACT orders the action will carry, deduplicated, in lane order. */
    orderIds: string[];
    /** The waves those orders belong to (at least one selected order each). */
    waves: FundraiserWave[];
}

/**
 * Resolve the operator's selection to the exact orders a status action carries.
 *
 * `selected` is a set of ORDER ids (the same shape the Packed & Ready lane uses). Only ids that
 * belong to a fundraiser wave of THIS lane are honoured, so a stale tick, a hidden id or an
 * ordinary order is never actionable from here. An empty selection resolves to NOTHING: it never
 * means "everything".
 */
export function resolveWaveSelection(lane: PrepLane, selected: ReadonlySet<string>): ResolvedPrepSelection {
    const waves: FundraiserWave[] = [];
    const orderIds: string[] = [];
    for (const w of lane.waves) {
        // Membership in a wave of THIS lane is the pruning: a stale id (its order left the lane),
        // a hidden one (not on the board) and an ordinary or one-signal order (in no wave) can
        // never be returned, because none of them is in any `w.orderIds`.
        const chosen = w.orderIds.filter((id) => selected.has(id));
        if (chosen.length === 0) continue;
        waves.push(w);
        for (const id of chosen) if (!orderIds.includes(id)) orderIds.push(id);
    }
    return { orderIds, waves };
}

// ── the request, and the words that precede it ───────────────────────────────────────

/**
 * The body for POST /api/orders/bulk-status. Exact order ids and the target status — nothing that
 * could widen the scope (no bundle id, no "current status" predicate, no campaign). Null when there
 * are no ids, so an empty selection cannot become a request at all.
 */
export function buildPrepStatusRequest(
    action: PrepAction,
    orderIds: readonly string[],
): { orderIds: string[]; status: 'in_production' | 'ready_to_ship' } | null {
    const unique = [...new Set((orderIds || []).filter((id) => typeof id === 'string' && id.trim() !== ''))];
    if (unique.length === 0) return null;
    return { orderIds: unique, status: PREP_ACTION_STATUS[action] };
}

/** Codes the exact-id route answers with when the screen's picture of an order is out of date. */
const STALE_SELECTION_CODES: ReadonlySet<string> = new Set([
    'STATUS_CHANGED_CONCURRENTLY',   // 409: another writer moved a row mid-batch
    'ILLEGAL_STATUS_TRANSITION',     // 400: an order is already past this step
    'ORDER_NOT_FOUND',               // 404: an id is gone (or foreign — never distinguished)
    'ORDER_CANCELED',                // 400: an order was canceled since the screen loaded
]);

/**
 * What to tell the operator when the exact-id route refuses.
 *
 * The route is all-or-nothing, so a refusal means NOTHING moved. The honest response is "an order
 * changed since you looked; here is a fresh list" — never a retry against a broader query. `stale`
 * tells the caller to reload the lanes.
 */
export function describePrepFailure(
    httpStatus: number,
    code?: string | null,
): { message: string; stale: boolean } {
    if (httpStatus === 401) {
        return { message: 'Your session has expired, so nothing was changed. Please sign in again.', stale: false };
    }
    if (code && STALE_SELECTION_CODES.has(code)) {
        return {
            message: 'Some of these orders changed since this screen loaded, so nothing was changed. The list has been refreshed.',
            stale: true,
        };
    }
    return { message: 'Failed to update. Nothing was changed.', stale: false };
}

export interface PrepActionScope {
    action: PrepAction;
    orderIds: string[];
    total: number;
    /** One line per fundraiser (plus "Other orders") with its count; empty for an ordinary-only action. */
    lines: ScopeLine[];
}

/** Break the ids an action carries into per-fundraiser counts. The counts sum to `orderIds.length`. */
export function describePrepAction(action: PrepAction, orderIds: readonly string[], lane: PrepLane): PrepActionScope {
    const unique = [...new Set(orderIds)];
    const scope = describeSelectionScope(unique, lane.orders);
    return { action, orderIds: unique, total: unique.length, lines: scope.lines };
}

/**
 * The confirmation text. States the exact scope — how many orders, which fundraisers — and the one
 * thing an operator can otherwise get wrong: a status belongs to the whole order.
 */
export function prepConfirmMessage(scope: PrepActionScope): string {
    const n = scope.total;
    const orders = n === 1 ? 'order' : 'orders';
    // With exactly one fundraiser in the action, name it in the question itself.
    const only = scope.lines.length === 1 && scope.lines[0].campaignId !== null ? scope.lines[0].label : null;
    const subject = `${n} ${only ? `${only} ` : ''}${orders}`;
    const question = scope.action === 'start_prep' ? `Start Prep for ${subject}?` : `Mark ${subject} Packed & Ready?`;
    const listing = scope.lines.length > 0 ? scope.lines.map((l) => `  • ${formatScopeLine(l)}`).join('\n') + '\n\n' : '';
    return `${question}\n\n${listing}Each order moves as a whole, including every bundle in it.\nNothing outside these orders is changed.`;
}

// ── meal labels for ONE wave ─────────────────────────────────────────────────────────

export interface WaveMealLabelItem {
    id: string;
    name: string;
    qty: number;
    unit: 'ea';
    copies: number;
    servingTier: string | null;
}

/**
 * The meal-label batch for one fundraiser's orders in a lane.
 *
 * The SAME arithmetic the per-card print uses — `physicalMealCount(units, bundle-content quantity)` —
 * applied to the units THAT FUNDRAISER'S orders contribute to each bundle, instead of the card's
 * cross-campaign total. The label engine, the serving-tier label and the print page are untouched.
 * Like the manifest, the same recipe at the same tier from two bundles sums into one item.
 */
export function waveMealLabelItems(
    rows: readonly PrepRow[] | null | undefined,
    wave: FundraiserWave,
    laneKey: PrepLaneKey,
): WaveMealLabelItem[] {
    const inWave = new Set(wave.orderIds);
    const merged = new Map<string, WaveMealLabelItem>();
    for (const row of rows || []) {
        if (!row || prepLaneOf(row.status) !== laneKey) continue;
        const units = (row.sources || []).reduce((n, s) => (inWave.has(s.order_id) ? n + (Number(s.quantity) || 0) : n), 0);
        if (units <= 0) continue;
        const tier = servingTierLabel(row.variant_size);
        for (const r of row.recipes || []) {
            const count = physicalMealCount(units, r.quantity);
            if (count <= 0) continue;
            const key = `${r.id}|${tier ?? ''}`;
            const existing = merged.get(key);
            if (existing) { existing.qty += count; existing.copies += count; }
            else merged.set(key, { id: r.id, name: r.name, qty: count, unit: 'ea', copies: count, servingTier: tier });
        }
    }
    return [...merged.values()];
}
