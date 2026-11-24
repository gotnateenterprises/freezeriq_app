/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S2) — the campaign add-on's organization share: the ONE set of rules.
 *
 * WHAT IT IS
 * A campaign that offers a supporter add-on (lib/campaignAddOns.ts) pays the organization a share of the
 * add-on's sales that the TENANT sets for that campaign — independent of the campaign's meal share
 * (`org_share_percent`), and never a property of the Bundle. The same Sides & Dessert Bundle can pay
 * 10% on one campaign and 15% on another.
 *
 * THE SCHEDULE IS MARGINAL
 * Stored as tiers `{ startingQuantity, percent }` over the campaign's CUMULATIVE add-on units sold:
 *
 *     start 1  -> 10%        the first ten add-ons earn 10%
 *     start 11 -> 15%        the eleventh and later earn 15%
 *
 * Unit u earns the rate of the tier with the greatest start <= u. Reaching a tier never re-rates earlier
 * units — there is no all-or-nothing threshold anywhere in this file.
 *
 * WHY EARNINGS ARE SLICED, NOT STAMPED
 * One order line can cross a threshold: with 9 sold, an order for 3 is unit 10 (10%) and units 11–12
 * (15%). splitAddOnLineIntoSlices returns one slice per tier touched, and the order routes persist each
 * slice (order_item_add_on_shares) in the order's own locked transaction. Closeout sums those rows; it
 * never recomputes old earnings from the (editable) schedule.
 *
 * WHAT IS LOCKED
 * With N add-ons sold, every tier starting at or below N has already been applied to real sales, so it
 * must stay exactly as it is, and a new tier may only start at N + 1 or later (validateShareScheduleEdit).
 * Earned money is snapshotted regardless; the lock keeps the schedule an honest description of it.
 *
 * Pure and import-light (client components render the same ranges and wording the server validates).
 */

import { parseOrgSharePercent } from './fundraiserOrgShare';

export interface ShareTier {
    /** The cumulative add-on unit at which this rate begins; the first tier is always 1. */
    startingQuantity: number;
    /** A percent, 10 = 10% — the same vocabulary and range (0–100, 2 decimals) as org_share_percent. */
    percent: number;
}

export const MAX_SHARE_TIERS = 10;
/** Far beyond any fundraiser; keeps a typo from becoming an unreachable tier. */
export const MAX_TIER_START = 100_000;

export type ShareScheduleCode = 'INVALID_SHARE_TIERS' | 'SHARE_TIER_LOCKED';

export type ShareScheduleResult =
    | { ok: true; tiers: ShareTier[] }
    | { ok: false; status: 400 | 409; code: ShareScheduleCode; error: string };

const invalid = (error: string): ShareScheduleResult => ({ ok: false, status: 400, code: 'INVALID_SHARE_TIERS', error });

function readWholeNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isInteger(value) ? value : null;
    if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value.trim());
    return null;
}

/**
 * Server-authoritative parse of a submitted schedule. Never trusts the browser: every tier is re-read,
 * starts must be positive whole numbers, percents go through the org-share parser (0–100, 2 decimals),
 * starts may not repeat, and the lowest start must be 1. Returns the tiers sorted by start.
 */
export function parseShareTierSchedule(input: unknown): ShareScheduleResult {
    if (!Array.isArray(input)) return invalid('Add at least one share tier.');
    if (input.length === 0) return invalid('Add at least one share tier.');
    if (input.length > MAX_SHARE_TIERS) return invalid(`Use at most ${MAX_SHARE_TIERS} share tiers.`);

    const tiers: ShareTier[] = [];
    for (const raw of input) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('Each share tier needs a starting number and a percent.');
        const r = raw as Record<string, unknown>;
        const start = readWholeNumber(r.startingQuantity);
        if (start === null || start < 1) return invalid('Each tier must start at a whole number of add-ons (1 or more).');
        if (start > MAX_TIER_START) return invalid(`A tier can start at add-on ${MAX_TIER_START.toLocaleString('en-US')} at most.`);
        const pct = parseOrgSharePercent(r.percent);
        if (!pct.ok) return invalid(pct.error.replace('Organization share', 'Add-on share'));
        tiers.push({ startingQuantity: start, percent: pct.percent });
    }

    tiers.sort((a, b) => a.startingQuantity - b.startingQuantity);
    for (let i = 1; i < tiers.length; i++) {
        if (tiers[i].startingQuantity === tiers[i - 1].startingQuantity) {
            return invalid(`Two tiers both start at add-on ${tiers[i].startingQuantity}. Each tier needs its own starting number.`);
        }
    }
    if (tiers[0].startingQuantity !== 1) return invalid('The first tier must start at add-on 1.');
    return { ok: true, tiers };
}

/** Stored rows (Prisma Decimals) to sorted tiers. Unparseable rows are dropped rather than guessed at. */
export function normalizeStoredTiers(
    rows: Array<{ starting_quantity: unknown; percent: unknown }> | null | undefined,
): ShareTier[] {
    const tiers: ShareTier[] = [];
    for (const row of rows ?? []) {
        const start = Number(row?.starting_quantity);
        const percent = Number(row?.percent);
        if (!Number.isInteger(start) || start < 1 || !Number.isFinite(percent)) continue;
        tiers.push({ startingQuantity: start, percent: Math.round(percent * 100) / 100 });
    }
    return tiers.sort((a, b) => a.startingQuantity - b.startingQuantity);
}

/** A usable schedule: at least one tier, the first at 1. Anything else must never price a sale. */
export function isUsableSchedule(tiers: ShareTier[]): boolean {
    return tiers.length > 0 && tiers[0].startingQuantity === 1;
}

/** The single tier an add-on starts with: unit 1 onward at the campaign's CURRENT meal share. */
export function defaultShareTiers(campaignOrgSharePercent: unknown): ShareTier[] {
    const parsed = parseOrgSharePercent(
        campaignOrgSharePercent === null || campaignOrgSharePercent === undefined
            ? campaignOrgSharePercent
            : String(campaignOrgSharePercent),
    );
    return [{ startingQuantity: 1, percent: parsed.ok ? parsed.percent : 20 }];
}

/** The rate unit `unit` (1-based, campaign-wide) earns: the tier with the greatest start <= unit. */
export function percentForUnit(tiers: ShareTier[], unit: number): number {
    let rate = tiers[0]?.percent ?? 0;
    for (const t of tiers) {
        if (t.startingQuantity <= unit) rate = t.percent;
        else break;
    }
    return rate;
}

export interface ShareSlice {
    /** Campaign-wide position of this slice's first unit (1 = the first add-on ever sold here). */
    firstUnit: number;
    quantity: number;
    percent: number;
    unitPrice: number;
    /** quantity × unitPrice × percent / 100, rounded half-up to the cent (whole-cent integer math). */
    shareAmount: number;
}

/**
 * quantity × price × percent / 100 in whole cents, rounded half-up, without binary floating point:
 * price is held in cents and the percent in hundredths of a percent, so the product is an exact integer.
 */
export function shareAmountCents(quantity: number, unitPrice: number, percent: number): number {
    const priceCents = Math.round(unitPrice * 100);
    const pctHundredths = Math.round(percent * 100);
    const numerator = quantity * priceCents * pctHundredths;
    if (!Number.isSafeInteger(numerator) || numerator < 0) {
        throw new Error('Add-on share is outside the supported range.');
    }
    // numerator is in 1/10,000ths of a cent; +5000 then floor = round half-up.
    return Math.floor((numerator + 5000) / 10000);
}

/**
 * Split ONE add-on order line across the schedule, marginally. `soldBefore` is the campaign's cumulative
 * add-on units already sold before this line, so the line occupies units soldBefore+1 … soldBefore+qty.
 * Every tier the line touches becomes its own slice at its own rate.
 */
export function splitAddOnLineIntoSlices(input: {
    tiers: ShareTier[];
    soldBefore: number;
    quantity: number;
    unitPrice: number;
}): ShareSlice[] {
    const { tiers, quantity, unitPrice } = input;
    if (!isUsableSchedule(tiers)) throw new Error('Add-on share schedule is not usable.');
    if (!Number.isInteger(quantity) || quantity < 1) return [];
    const soldBefore = Math.max(0, Math.floor(Number(input.soldBefore) || 0));

    const first = soldBefore + 1;
    const last = soldBefore + quantity;
    const slices: ShareSlice[] = [];
    for (let i = 0; i < tiers.length; i++) {
        const tierStart = tiers[i].startingQuantity;
        const tierEnd = i + 1 < tiers.length ? tiers[i + 1].startingQuantity - 1 : Number.POSITIVE_INFINITY;
        const from = Math.max(first, tierStart);
        const to = Math.min(last, tierEnd);
        if (from > to) continue;
        const qty = to - from + 1;
        slices.push({
            firstUnit: from,
            quantity: qty,
            percent: tiers[i].percent,
            unitPrice,
            shareAmount: shareAmountCents(qty, unitPrice, tiers[i].percent) / 100,
        });
    }
    return slices;
}

/**
 * May the schedule change from `current` to `next` with `unitsSold` add-ons already sold?
 * Every tier starting at or below unitsSold must survive unchanged (same start, same percent), and no new
 * tier may start at or below unitsSold. Tiers above it are free to add, edit or remove.
 */
export function validateShareScheduleEdit(input: {
    current: ShareTier[];
    next: ShareTier[];
    unitsSold: number;
}): ShareScheduleResult {
    const sold = Math.max(0, Math.floor(Number(input.unitsSold) || 0));
    const nextByStart = new Map(input.next.map((t) => [t.startingQuantity, t]));
    const currentByStart = new Map(input.current.map((t) => [t.startingQuantity, t]));

    for (const t of input.current) {
        if (t.startingQuantity > sold) continue;
        const kept = nextByStart.get(t.startingQuantity);
        if (!kept || kept.percent !== t.percent) {
            return {
                ok: false, status: 409, code: 'SHARE_TIER_LOCKED',
                error: `${sold} add-on${sold === 1 ? ' has' : 's have'} already sold, so the tier starting at add-on ${t.startingQuantity} (${formatPercent(t.percent)}) is locked. Add a new tier starting at add-on ${sold + 1} or later instead.`,
            };
        }
    }
    for (const t of input.next) {
        if (t.startingQuantity <= sold && !currentByStart.has(t.startingQuantity)) {
            return {
                ok: false, status: 409, code: 'SHARE_TIER_LOCKED',
                error: `${sold} add-on${sold === 1 ? ' has' : 's have'} already sold. A new tier has to start at add-on ${sold + 1} or later.`,
            };
        }
    }
    return { ok: true, tiers: input.next };
}

// ── Display ──────────────────────────────────────────────────────────────────

/** 10 -> "10%", 12.5 -> "12.5%", 12.25 -> "12.25%". */
export function formatPercent(percent: number): string {
    return `${parseFloat(Number(percent).toFixed(2))}%`;
}

export type ShareTierLock = 'locked' | 'locked_for_sold' | 'editable';

export interface ShareTierRow extends ShareTier {
    /** The last unit this tier covers, or null for the open-ended last tier. */
    endQuantity: number | null;
    /** "1–10 sold", "11+ sold", "11 sold" — plain language, never "starting quantity". */
    rangeLabel: string;
    /**
     * locked          — every unit in this tier has already sold.
     * locked_for_sold — some units have sold under it; it cannot be changed.
     * editable        — not reached yet.
     */
    lock: ShareTierLock;
}

export function describeShareTierRanges(tiers: ShareTier[], unitsSold: number): ShareTierRow[] {
    const sold = Math.max(0, Math.floor(Number(unitsSold) || 0));
    return tiers.map((t, i) => {
        const endQuantity = i + 1 < tiers.length ? tiers[i + 1].startingQuantity - 1 : null;
        const rangeLabel = endQuantity === null
            ? `${t.startingQuantity}+ sold`
            : endQuantity === t.startingQuantity
                ? `${t.startingQuantity} sold`
                : `${t.startingQuantity}–${endQuantity} sold`;
        const lock: ShareTierLock = t.startingQuantity > sold
            ? 'editable'
            : endQuantity !== null && endQuantity <= sold ? 'locked' : 'locked_for_sold';
        return { ...t, endQuantity, rangeLabel, lock };
    });
}

/** The rate the NEXT add-on sold will earn, and where the next change happens (null when none). */
export function nextAddOnRate(tiers: ShareTier[], unitsSold: number): {
    nextUnit: number;
    percent: number;
    nextTierStart: number | null;
    nextTierPercent: number | null;
} {
    const nextUnit = Math.max(0, Math.floor(Number(unitsSold) || 0)) + 1;
    const upcoming = tiers.find((t) => t.startingQuantity > nextUnit) ?? null;
    return {
        nextUnit,
        percent: percentForUnit(tiers, nextUnit),
        nextTierStart: upcoming ? upcoming.startingQuantity : null,
        nextTierPercent: upcoming ? upcoming.percent : null,
    };
}

/**
 * The coordinator's read-only sentence. No tier vocabulary:
 *   one tier    "Your organization earns 10% on this add-on."
 *   two tiers   "Your organization earns 10% on the first 10 add-ons and 15% beginning with add-on 11."
 *   more        "… 10% on the first 10 add-ons, 15% on add-ons 11–20 and 20% beginning with add-on 21."
 */
export function describeShareScheduleForCoordinator(tiers: ShareTier[]): string {
    if (tiers.length === 0) return '';
    if (tiers.length === 1) return `Your organization earns ${formatPercent(tiers[0].percent)} on this add-on.`;
    const parts = tiers.map((t, i) => {
        const end = i + 1 < tiers.length ? tiers[i + 1].startingQuantity - 1 : null;
        const pct = formatPercent(t.percent);
        if (i === 0) return end === 1 ? `${pct} on the first add-on` : `${pct} on the first ${end} add-ons`;
        if (end === null) return `${pct} beginning with add-on ${t.startingQuantity}`;
        if (end === t.startingQuantity) return `${pct} on add-on ${t.startingQuantity}`;
        return `${pct} on add-ons ${t.startingQuantity}–${end}`;
    });
    const list = parts.length === 2
        ? `${parts[0]} and ${parts[1]}`
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return `Your organization earns ${list}.`;
}
