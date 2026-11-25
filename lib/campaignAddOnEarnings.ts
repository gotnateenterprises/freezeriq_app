/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S2) — the campaign add-on's share, against the database.
 *
 *   recordAddOnShareEarnings   ORDER TIME. Called inside every fundraiser order transaction that writes an
 *                              add-on line (supporter route and coordinator route), AFTER the campaign
 *                              selection lock and the order insert. Splits each add-on line across the
 *                              campaign's share schedule starting at the next PERMANENT tier position and
 *                              records one order_item_add_on_shares row per slice. The lock is what makes
 *                              the numbering deterministic between orders.
 *
 * Three different numbers, each with ONE authority (B1 remediation, owner-approved 2026-11-25):
 *   countCampaignAddOnUnitsSold          ACTIVE add-on quantity sold: item_role = 'addon' units on this
 *                                        campaign's non-cancelled orders (the same orders closeout settles).
 *   countCampaignAddOnPositionsAllocated LIFETIME tier positions allocated: the highest position ever
 *                                        recorded on the campaign, cancelled orders INCLUDED. A cancelled
 *                                        order keeps its recorded slices (and a restore brings them back
 *                                        unchanged), so a position is never handed out twice and a reached
 *                                        tier never unlocks. Drives the next sale's position and tier locks.
 *   loadCampaignAddOnMoney               ACTIVE add-on gross and organization earnings: the recorded slices
 *                                        of non-cancelled orders — never re-derived from the schedule.
 *
 *   assign / remove / update   the tenant's writes. Each caller holds the campaign lock and has rechecked
 *                              that the campaign is still open (app/api/campaigns/[id]/add-on/route.ts).
 *                              B2: remove DISABLES the campaign's add-on (campaign_add_ons.removed_at) and
 *                              keeps its share schedule; offering an add-on again (the same bundle or a
 *                              replacement) resumes that schedule.
 *
 * Every function takes the Prisma client (or transaction) it should use; nothing here opens its own.
 */

import {
    ADD_ON_BUNDLE_TYPE,
    ADD_ON_ITEM_ROLE,
    AddOnChangedError,
    BUNDLE_TYPE_SELECT,
    REMOVED_AT_SELECT,
    SHOW_SHARE_PERCENT_SELECT,
    isOfferedAddOnRow,
    loadCampaignAddOnAuthority,
    normalizeBundleType,
} from './campaignAddOns';
import {
    defaultShareTiers,
    describeShareScheduleForCoordinator,
    describeShareTierRanges,
    describeTierProgressGap,
    isUsableSchedule,
    nextAddOnRate,
    normalizeStoredTiers,
    publicAddOnSupportPercent,
    splitAddOnLineIntoSlices,
    validateShareScheduleEdit,
    type ShareSlice,
    type ShareTier,
    type ShareTierRow,
} from './campaignAddOnShare';

const ADDON_ROLE_WHERE = { item_role: ADD_ON_ITEM_ROLE } as {};

// ── Reads ────────────────────────────────────────────────────────────────────

export interface CampaignAddOnSchedule {
    campaignAddOnId: string;
    bundleId: string;
    tiers: ShareTier[];
}

/**
 * The campaign's OFFERED add-on assignment and its share schedule, tenant-checked; null when none, or when
 * the add-on was removed (B2: the row and schedule are kept, but nothing may be sold or edited against it
 * until an add-on is offered again).
 */
export async function loadCampaignAddOnSchedule(
    db: any,
    params: { campaignId: string; businessId: string },
): Promise<CampaignAddOnSchedule | null> {
    const row = await db.campaignAddOn.findUnique({
        where: { campaign_id: params.campaignId },
        select: {
            id: true,
            business_id: true,
            bundle_id: true,
            ...REMOVED_AT_SELECT,
            share_tiers: { select: { starting_quantity: true, percent: true }, orderBy: { starting_quantity: 'asc' } },
        },
    });
    if (!row || row.business_id !== params.businessId) return null;
    if (!isOfferedAddOnRow(row)) return null;
    return { campaignAddOnId: row.id, bundleId: row.bundle_id, tiers: normalizeStoredTiers(row.share_tiers) };
}

/**
 * LIFETIME tier positions allocated on the campaign: the highest position any recorded add-on slice
 * occupies, cancelled orders INCLUDED (0 when none). B1 remediation, owner-approved 2026-11-25:
 *   - a cancelled order keeps its recorded slices, so its positions are never handed to a later order;
 *   - a restore re-activates those same slices, so it needs no new positions and creates no new records;
 *   - the next sale therefore always starts at this number + 1, and a tier this number has reached stays
 *     locked whatever is cancelled.
 * Fundraiser orders are never hard-deleted (lib/orderDeletion.ts refuses them; a campaign invoice never
 * carries a fulfilment order), so the recorded slices are a durable source. This is NOT "add-ons sold"
 * (countCampaignAddOnUnitsSold) and must never be shown as active sales.
 */
export async function countCampaignAddOnPositionsAllocated(db: any, campaignId: string): Promise<number> {
    const slices: Array<{ first_unit: unknown; quantity: unknown }> = await db.orderItemAddOnShare.findMany({
        where: { order_item: { order: { campaign_id: campaignId } } },
        select: { first_unit: true, quantity: true },
    });
    let reached = 0;
    for (const s of slices ?? []) {
        const first = Math.floor(Number(s?.first_unit) || 0);
        const qty = Math.floor(Number(s?.quantity) || 0);
        if (first < 1 || qty < 1) continue;
        reached = Math.max(reached, first + qty - 1);
    }
    return reached;
}

/** Add-on units on this campaign's non-cancelled orders, optionally leaving one order out. */
export async function countCampaignAddOnUnitsSold(
    db: any,
    campaignId: string,
    opts: { excludeOrderId?: string } = {},
): Promise<number> {
    const result = await db.orderItem.aggregate({
        where: {
            ...ADDON_ROLE_WHERE,
            order: {
                campaign_id: campaignId,
                canceled_at: null,
                ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}),
            },
        },
        _sum: { quantity: true },
    });
    return Number(result?._sum?.quantity) || 0;
}

export interface CampaignAddOnMoney {
    unitsSold: number;
    grossSales: number;
    earnedShare: number;
}

/** What the campaign's add-on has sold and already earned (non-cancelled orders; recorded slices only). */
export async function loadCampaignAddOnMoney(db: any, campaignId: string): Promise<CampaignAddOnMoney> {
    const items = await db.orderItem.findMany({
        where: { ...ADDON_ROLE_WHERE, order: { campaign_id: campaignId, canceled_at: null } },
        select: { quantity: true, unit_price: true, add_on_shares: { select: { share_amount: true } } },
    });
    let units = 0;
    let grossCents = 0;
    let shareCents = 0;
    for (const it of items ?? []) {
        const qty = Number(it.quantity) || 0;
        units += qty;
        grossCents += qty * Math.round((Number(it.unit_price) || 0) * 100);
        for (const s of it.add_on_shares ?? []) shareCents += Math.round((Number(s.share_amount) || 0) * 100);
    }
    return { unitsSold: units, grossSales: grossCents / 100, earnedShare: shareCents / 100 };
}

// ── Order time ───────────────────────────────────────────────────────────────

/**
 * Records the share earned by the add-on line(s) of `orderId`. MUST run inside the order's transaction,
 * after lockCampaignSelection and the order insert. Throws AddOnChangedError (409 ADDON_CHANGED, nothing
 * written) when the campaign has no usable schedule — an add-on is never sold with an unknown share.
 */
export async function recordAddOnShareEarnings(
    tx: any,
    params: { campaignId: string; businessId: string; orderId: string },
): Promise<ShareSlice[]> {
    const items: Array<{ id: string; quantity: number; unit_price: unknown }> = await tx.orderItem.findMany({
        where: { order_id: params.orderId, ...ADDON_ROLE_WHERE },
        select: { id: true, quantity: true, unit_price: true },
        orderBy: { id: 'asc' },
    });
    if (!items || items.length === 0) return [];

    const schedule = await loadCampaignAddOnSchedule(tx, { campaignId: params.campaignId, businessId: params.businessId });
    if (!schedule || !isUsableSchedule(schedule.tiers)) throw new AddOnChangedError();

    // Recorded once, at the order's creation. A second call for the same order would allocate a second set of
    // positions, so it is refused (rolling the transaction back) rather than ever writing duplicate earnings.
    const alreadyRecorded = await tx.orderItemAddOnShare.count({
        where: { order_item_id: { in: items.map((it) => it.id) } },
    });
    if ((Number(alreadyRecorded) || 0) > 0) {
        throw new Error('This order\'s add-on share is already recorded.');
    }

    // B1: the next PERMANENT position — after every position ever allocated here, cancelled orders included.
    let soldBefore = await countCampaignAddOnPositionsAllocated(tx, params.campaignId);
    const rows: Array<Record<string, unknown>> = [];
    const all: ShareSlice[] = [];
    for (const item of items) {
        const quantity = Number(item.quantity) || 0;
        const slices = splitAddOnLineIntoSlices({
            tiers: schedule.tiers,
            soldBefore,
            quantity,
            unitPrice: Number(item.unit_price) || 0,
        });
        for (const s of slices) {
            rows.push({
                order_item_id: item.id,
                first_unit: s.firstUnit,
                quantity: s.quantity,
                percent: s.percent,
                unit_price: s.unitPrice,
                share_amount: s.shareAmount,
            });
            all.push(s);
        }
        soldBefore += quantity;
    }
    if (rows.length > 0) await tx.orderItemAddOnShare.createMany({ data: rows });
    return all;
}

// ── The tenant's add-on writes ───────────────────────────────────────────────

export type AddOnAdminCode =
    | 'ADDON_NOT_ELIGIBLE'
    | 'NO_ADDON_ASSIGNED'
    | 'INVALID_SHARE_TIERS'
    | 'SHARE_TIER_LOCKED'
    | 'ADDON_HISTORY_WITHOUT_SCHEDULE';

export type AddOnAdminResult =
    | { ok: true; changed: boolean }
    | { ok: false; status: 400 | 404 | 409; code: AddOnAdminCode; error: string };

interface EligibilityFacts {
    business_id: string | null;
    is_active: boolean | null;
    bundle_type: unknown;
    price: unknown;
    contentCount: number;
}

/** Same tenant, active, typed 'addon', priced above $0 and with at least one recipe. Null when eligible. */
export function addOnBundleIneligibility(b: EligibilityFacts, businessId: string): string | null {
    if (b.business_id !== businessId) return 'This bundle was not found.';
    if (normalizeBundleType(b.bundle_type) !== ADD_ON_BUNDLE_TYPE) return 'Only a bundle marked "Fundraiser add-on" can be a supporter add-on.';
    if (b.is_active !== true) return 'This add-on bundle is turned off. Turn on "Active" first.';
    if (!(Number(b.price) > 0)) return 'Give this add-on bundle a price above $0.00 first.';
    if (!(b.contentCount > 0)) return 'Add at least one recipe to this add-on bundle first.';
    return null;
}

const ELIGIBILITY_SELECT = {
    id: true,
    name: true,
    price: true,
    is_active: true,
    business_id: true,
    ...BUNDLE_TYPE_SELECT,
    _count: { select: { contents: true } },
};

/**
 * Offer an add-on on the campaign. The campaign has ONE add-on program (one campaign_add_ons row) whose share
 * schedule belongs to the campaign, not to whichever bundle is on offer (B2 remediation):
 *   new      -> no row has ever existed: the row plus ONE share tier, position 1 onward at the campaign's
 *               CURRENT meal share. The only time the meal share is inherited.
 *   replace  -> an offered row, a different bundle: the row points at the new bundle; schedule kept.
 *   resume   -> a REMOVED row, the same bundle or a replacement: the row is offered again pointing at the
 *               chosen bundle; schedule, locked tiers and tier positions continue exactly where they were.
 * The caller holds the campaign lock and has rechecked that the campaign is open.
 */
export async function assignCampaignAddOn(
    tx: any,
    params: {
        campaign: { id: string; customer_id: string; org_share_percent: unknown };
        businessId: string;
        bundleId: unknown;
        userId: string | null;
    },
): Promise<AddOnAdminResult> {
    if (typeof params.bundleId !== 'string' || params.bundleId.trim() === '') {
        return { ok: false, status: 400, code: 'ADDON_NOT_ELIGIBLE', error: 'Choose an add-on bundle.' };
    }
    const bundle = await tx.bundle.findFirst({
        where: { id: params.bundleId, business_id: params.businessId },
        select: ELIGIBILITY_SELECT,
    });
    if (!bundle) return { ok: false, status: 404, code: 'ADDON_NOT_ELIGIBLE', error: 'This bundle was not found.' };
    const reason = addOnBundleIneligibility(
        { ...bundle, contentCount: Number(bundle._count?.contents) || 0 },
        params.businessId,
    );
    if (reason) return { ok: false, status: 400, code: 'ADDON_NOT_ELIGIBLE', error: reason };

    const existing = await tx.campaignAddOn.findUnique({
        where: { campaign_id: params.campaign.id },
        select: { id: true, business_id: true, bundle_id: true, ...REMOVED_AT_SELECT },
    });
    if (existing && existing.business_id !== params.businessId) {
        return { ok: false, status: 404, code: 'NO_ADDON_ASSIGNED', error: 'Campaign not found.' };
    }
    if (existing) {
        const offered = isOfferedAddOnRow(existing);
        if (offered && existing.bundle_id === bundle.id) return { ok: true, changed: false };
        // Replace or resume: only the bundle and the offered state change — never the schedule.
        await tx.campaignAddOn.update({
            where: { id: existing.id },
            data: { bundle_id: bundle.id, removed_at: null } as {},
        });
        return { ok: true, changed: true };
    }

    // A genuinely new program. If add-on positions were already recorded on this campaign without a saved
    // schedule (impossible once removals keep the row; possible only for data from before B2), a fresh
    // meal-share schedule would misstate how those positions were earned — so refuse rather than guess.
    const positions = await countCampaignAddOnPositionsAllocated(tx, params.campaign.id);
    if (positions > 0) {
        return {
            ok: false, status: 409, code: 'ADDON_HISTORY_WITHOUT_SCHEDULE',
            error: 'This fundraiser already has add-on sales recorded but no saved add-on share schedule, so a new schedule can\'t be started without misstating them. Please contact support.',
        };
    }

    const [tier] = defaultShareTiers(params.campaign.org_share_percent);
    await tx.campaignAddOn.create({
        data: {
            business_id: params.businessId,
            customer_id: params.campaign.customer_id,
            campaign_id: params.campaign.id,
            bundle_id: bundle.id,
            created_by: params.userId,
            share_tiers: { create: [{ starting_quantity: tier.startingQuantity, percent: tier.percent }] },
        },
    });
    return { ok: true, changed: true };
}

/**
 * Remove the campaign's add-on: it stops being OFFERED (supporter page, coordinator paper orders, flyers),
 * and nothing is deleted. B2 remediation: the row, its share schedule, its locked tiers and the campaign's
 * tier positions all stay, so offering an add-on again resumes them. Money already earned stays on its
 * orders, as before. A repeat remove changes nothing.
 */
export async function removeCampaignAddOn(
    tx: any,
    params: { campaignId: string; businessId: string },
): Promise<AddOnAdminResult> {
    const result = await tx.campaignAddOn.updateMany({
        where: { campaign_id: params.campaignId, business_id: params.businessId, removed_at: null } as {},
        data: { removed_at: new Date() } as {},
    });
    return { ok: true, changed: (Number(result?.count) || 0) > 0 };
}

/**
 * Replace the schedule with `next` (already parsed by parseShareTierSchedule), refusing any change to a
 * tier the campaign's tier progress has already reached. Unchanged tiers are not rewritten. B1: "reached"
 * is the LIFETIME positions allocated (cancelled orders included), so a cancellation never unlocks a tier.
 */
export async function updateCampaignAddOnShareTiers(
    tx: any,
    params: { campaignId: string; businessId: string; next: ShareTier[] },
): Promise<AddOnAdminResult> {
    const schedule = await loadCampaignAddOnSchedule(tx, { campaignId: params.campaignId, businessId: params.businessId });
    if (!schedule) {
        return { ok: false, status: 409, code: 'NO_ADDON_ASSIGNED', error: 'Choose a supporter add-on for this fundraiser first.' };
    }
    const positionsReached = await countCampaignAddOnPositionsAllocated(tx, params.campaignId);
    const decision = validateShareScheduleEdit({ current: schedule.tiers, next: params.next, positionsReached });
    if (!decision.ok) return { ok: false, status: decision.status, code: decision.code, error: decision.error };

    const nextByStart = new Map(params.next.map((t) => [t.startingQuantity, t]));
    const currentByStart = new Map(schedule.tiers.map((t) => [t.startingQuantity, t]));
    let changed = false;

    const removedStarts = schedule.tiers.filter((t) => !nextByStart.has(t.startingQuantity)).map((t) => t.startingQuantity);
    if (removedStarts.length > 0) {
        await tx.campaignAddOnShareTier.deleteMany({
            where: { campaign_add_on_id: schedule.campaignAddOnId, starting_quantity: { in: removedStarts } },
        });
        changed = true;
    }
    for (const t of params.next) {
        const cur = currentByStart.get(t.startingQuantity);
        if (!cur) {
            await tx.campaignAddOnShareTier.create({
                data: { campaign_add_on_id: schedule.campaignAddOnId, starting_quantity: t.startingQuantity, percent: t.percent },
            });
            changed = true;
        } else if (cur.percent !== t.percent) {
            await tx.campaignAddOnShareTier.updateMany({
                where: { campaign_add_on_id: schedule.campaignAddOnId, starting_quantity: t.startingQuantity },
                data: { percent: t.percent },
            });
            changed = true;
        }
    }
    return { ok: true, changed };
}

/**
 * S4: the tenant's per-fundraiser choice to show the add-on share % on the supporter page. Display only —
 * no tier, rate or earned share changes. The caller holds the campaign lock and has rechecked that the
 * campaign is open (the same write path as every other add-on change).
 */
export async function updateCampaignAddOnShareDisplay(
    tx: any,
    params: { campaignId: string; businessId: string; showSharePercent: boolean },
): Promise<AddOnAdminResult> {
    const row = await tx.campaignAddOn.findUnique({
        where: { campaign_id: params.campaignId },
        select: { id: true, business_id: true, ...SHOW_SHARE_PERCENT_SELECT, ...REMOVED_AT_SELECT },
    });
    if (!row || row.business_id !== params.businessId || !isOfferedAddOnRow(row)) {
        return { ok: false, status: 409, code: 'NO_ADDON_ASSIGNED', error: 'Choose a supporter add-on for this fundraiser first.' };
    }
    if ((row as any).show_share_percent === params.showSharePercent) return { ok: true, changed: false };
    await tx.campaignAddOn.update({
        where: { id: row.id },
        data: { show_share_percent: params.showSharePercent } as {},
    });
    return { ok: true, changed: true };
}

// ── The coordinator's view (read-only) ───────────────────────────────────────

export interface CoordinatorAddOnView {
    bundleId: string;
    name: string;
    price: number;
    /** Plain language, e.g. "Your organization earns 10% on the first 10 add-ons and 15% beginning with add-on 11." */
    shareSummary: string;
    /** The same schedule as ranges, for an optional detail list. No editing affordance exists for a coordinator. */
    shareTiers: Array<{ rangeLabel: string; percent: number }>;
    /** ACTIVE add-on quantity sold (non-cancelled orders). */
    unitsSold: number;
    /** B1: LIFETIME tier positions allocated (cancelled orders keep theirs). Never shown as sales. */
    tierPositionsReached: number;
    /** B1: plain words when cancellations make tier progress differ from active sales; null when they agree. */
    tierProgressNote: string | null;
    /** Add-on sales and the share they already earned — so "raised for" counts the add-on at its own rate. */
    grossSales: number;
    earnedShare: number;
}

/**
 * What the coordinator portal shows about the campaign's add-on: name, price, how the organization earns
 * on it, and how many have sold. Null when the campaign has no sellable add-on (none assigned, or the
 * tenant turned the bundle off), in which case the portal shows nothing about add-ons at all.
 */
export async function loadCoordinatorAddOnView(
    db: any,
    params: { campaignId: string; businessId: string },
): Promise<CoordinatorAddOnView | null> {
    const assignment = await db.campaignAddOn.findUnique({
        where: { campaign_id: params.campaignId },
        select: {
            business_id: true,
            ...REMOVED_AT_SELECT,
            bundle: { select: { id: true, name: true, price: true, is_active: true, business_id: true, ...BUNDLE_TYPE_SELECT } },
            share_tiers: { select: { starting_quantity: true, percent: true }, orderBy: { starting_quantity: 'asc' } },
        },
    });
    if (!assignment || assignment.business_id !== params.businessId) return null;
    if (!isOfferedAddOnRow(assignment)) return null;
    const b = assignment.bundle;
    if (!b || b.business_id !== params.businessId || b.is_active !== true) return null;
    if (normalizeBundleType(b.bundle_type) !== ADD_ON_BUNDLE_TYPE) return null;
    const tiers = normalizeStoredTiers(assignment.share_tiers);
    if (!isUsableSchedule(tiers)) return null;
    const [money, positionsReached] = await Promise.all([
        loadCampaignAddOnMoney(db, params.campaignId),
        countCampaignAddOnPositionsAllocated(db, params.campaignId),
    ]);
    return {
        bundleId: b.id,
        name: b.name,
        price: Number(b.price) || 0,
        shareSummary: describeShareScheduleForCoordinator(tiers),
        shareTiers: describeShareTierRanges(tiers, positionsReached).map((t) => ({ rangeLabel: t.rangeLabel, percent: t.percent })),
        unitsSold: money.unitsSold,
        tierPositionsReached: positionsReached,
        tierProgressNote: describeTierProgressGap({ activeSold: money.unitsSold, positionsReached }),
        grossSales: money.grossSales,
        earnedShare: money.earnedShare,
    };
}

// ── Printed materials (S3) ───────────────────────────────────────────────────

export interface MaterialAddOn {
    bundleId: string;
    name: string;
    /** The bundle's own price. */
    basePrice: number;
    /** What a supporter pays per unit, under the campaign's FROZEN tax settings — the same rule the
     *  flyer and tracker apply to meal prices (lib/supporterMaterialPricing.supporterBundlePrice). */
    supporterPrice: number;
}

/**
 * The campaign's sellable add-on for the flyer's order form and the paper order tracker, or null. Same
 * authority as an order (lib/campaignAddOns.loadCampaignAddOnAuthority: same tenant, active, typed add-on)
 * plus a price above $0 — an unpriced add-on is never printed.
 */
export async function loadCampaignAddOnForMaterials(
    db: any,
    params: {
        campaign: { id: string; tax_status?: string | null; tax_rate_percent?: unknown };
        businessId: string;
        supporterPrice: (basePrice: number) => number;
    },
): Promise<MaterialAddOn | null> {
    // Never blocks a flyer, packet or tracker: the add-on row is optional, so a failed lookup prints the
    // material without it (logged) rather than failing the whole document.
    try {
        const authority = await loadCampaignAddOnAuthority(db, { campaignId: params.campaign.id, businessId: params.businessId });
        if (!authority) return null;
        const row = await db.bundle.findFirst({
            where: { id: authority.bundleId, business_id: params.businessId },
            select: { price: true, name: true },
        });
        const basePrice = Number(row?.price);
        if (!(basePrice > 0)) return null;
        return {
            bundleId: authority.bundleId,
            name: (authority.name ?? row?.name ?? '').trim() || 'Add-On',
            basePrice,
            supporterPrice: params.supporterPrice(basePrice),
        };
    } catch (err) {
        console.error('[campaign add-on] materials lookup failed; printing without the add-on row:', err);
        return null;
    }
}

// ── The tenant's view ────────────────────────────────────────────────────────

export interface CampaignAddOnAdminView {
    campaignId: string;
    closed: boolean;
    /** The campaign's meal share, shown for reference beside the add-on's own schedule. */
    mealSharePercent: number;
    addOn: null | {
        bundleId: string;
        name: string;
        price: number;
        /** False when the bundle was later turned off or retyped: supporters cannot be sold it. */
        sellable: boolean;
        tiers: ShareTierRow[];
        next: ReturnType<typeof nextAddOnRate>;
        /** S4: the tenant's "show the share % on the supporter page" choice (off by default). */
        showSharePercent: boolean;
        /** S4: what the supporter page shows right now — the percent, or null (toggle off, or a tiered schedule). */
        publicSupportPercent: number | null;
    };
    /**
     * B2: the campaign's add-on was REMOVED (not offered now) — its share schedule is kept, read-only here,
     * and resumes when an add-on is offered again. Null when an add-on is offered or none was ever set up.
     */
    removedAddOn: null | {
        /** The bundle that was on offer when it was removed. */
        name: string;
        removedAt: string | null;
        tiers: ShareTierRow[];
        next: ReturnType<typeof nextAddOnRate>;
    };
    /** ACTIVE add-on quantity sold (non-cancelled orders). */
    unitsSold: number;
    /** B1: LIFETIME tier positions allocated (cancelled orders keep theirs). Drives locks and the next rate. */
    tierPositionsReached: number;
    /** B1: plain words when cancellations make tier progress differ from active sales; null when they agree. */
    tierProgressNote: string | null;
    grossSales: number;
    earnedShare: number;
    eligibleBundles: Array<{ id: string; name: string; price: number }>;
    /** Add-on bundles that exist but cannot be assigned yet, with the reason — so the picker can explain. */
    unavailableBundles: Array<{ id: string; name: string; reason: string }>;
}

export async function loadCampaignAddOnAdminView(
    db: any,
    params: { campaign: { id: string; org_share_percent: unknown; closed: boolean }; businessId: string },
): Promise<CampaignAddOnAdminView> {
    const { campaign, businessId } = params;
    const [assignment, money, positionsReached, candidates] = await Promise.all([
        db.campaignAddOn.findUnique({
            where: { campaign_id: campaign.id },
            select: {
                business_id: true,
                bundle_id: true,
                ...SHOW_SHARE_PERCENT_SELECT,
                ...REMOVED_AT_SELECT,
                bundle: { select: { id: true, name: true, price: true, is_active: true, business_id: true, ...BUNDLE_TYPE_SELECT } },
                share_tiers: { select: { starting_quantity: true, percent: true }, orderBy: { starting_quantity: 'asc' } },
            },
        }),
        loadCampaignAddOnMoney(db, campaign.id),
        countCampaignAddOnPositionsAllocated(db, campaign.id),
        db.bundle.findMany({
            where: { business_id: businessId, ...({ bundle_type: ADD_ON_BUNDLE_TYPE } as {}) },
            select: ELIGIBILITY_SELECT,
            orderBy: { name: 'asc' },
        }),
    ]);

    let addOn: CampaignAddOnAdminView['addOn'] = null;
    let removedAddOn: CampaignAddOnAdminView['removedAddOn'] = null;
    if (assignment && assignment.business_id === businessId && assignment.bundle) {
        const tiers = normalizeStoredTiers(assignment.share_tiers);
        const b = assignment.bundle;
        if (isOfferedAddOnRow(assignment)) {
            addOn = {
                bundleId: b.id,
                name: b.name,
                price: Number(b.price) || 0,
                sellable: b.is_active === true && normalizeBundleType(b.bundle_type) === ADD_ON_BUNDLE_TYPE && b.business_id === businessId,
                tiers: describeShareTierRanges(tiers, positionsReached),
                next: nextAddOnRate(tiers, positionsReached),
                showSharePercent: (assignment as any).show_share_percent === true,
                publicSupportPercent: publicAddOnSupportPercent(tiers, (assignment as any).show_share_percent),
            };
        } else {
            const removedAt = (assignment as any).removed_at;
            removedAddOn = {
                name: b.name,
                removedAt: removedAt instanceof Date ? removedAt.toISOString() : (typeof removedAt === 'string' ? removedAt : null),
                tiers: describeShareTierRanges(tiers, positionsReached),
                next: nextAddOnRate(tiers, positionsReached),
            };
        }
    }

    const eligibleBundles: CampaignAddOnAdminView['eligibleBundles'] = [];
    const unavailableBundles: CampaignAddOnAdminView['unavailableBundles'] = [];
    for (const b of candidates ?? []) {
        const reason = addOnBundleIneligibility({ ...b, contentCount: Number(b._count?.contents) || 0 }, businessId);
        if (reason) unavailableBundles.push({ id: b.id, name: b.name, reason });
        else eligibleBundles.push({ id: b.id, name: b.name, price: Number(b.price) || 0 });
    }

    return {
        campaignId: campaign.id,
        closed: campaign.closed,
        mealSharePercent: Number(campaign.org_share_percent) || 0,
        addOn,
        removedAddOn,
        unitsSold: money.unitsSold,
        tierPositionsReached: positionsReached,
        tierProgressNote: describeTierProgressGap({ activeSold: money.unitsSold, positionsReached }),
        grossSales: money.grossSales,
        earnedShare: money.earnedShare,
        eligibleBundles,
        unavailableBundles,
    };
}
