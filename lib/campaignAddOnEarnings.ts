/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S2) — the campaign add-on's share, against the database.
 *
 *   recordAddOnShareEarnings   ORDER TIME. Called inside every fundraiser order transaction that writes an
 *                              add-on line (supporter route and coordinator route), AFTER the campaign
 *                              selection lock and the order insert. Splits each add-on line across the
 *                              campaign's share schedule by the cumulative add-on count at that moment and
 *                              records one order_item_add_on_shares row per slice. The lock is what makes
 *                              the count — and so the unit numbering — deterministic between orders.
 *   countCampaignAddOnUnitsSold  the ONE definition of "add-ons sold": item_role = 'addon' units on this
 *                              campaign's non-cancelled orders (the same orders closeout settles).
 *   loadCampaignAddOnMoney     units sold, add-on gross and the share already earned — for display.
 *   assign / remove / update   the tenant's writes. Each caller holds the campaign lock and has rechecked
 *                              that the campaign is still open (app/api/campaigns/[id]/add-on/route.ts).
 *
 * Every function takes the Prisma client (or transaction) it should use; nothing here opens its own.
 */

import {
    ADD_ON_BUNDLE_TYPE,
    ADD_ON_ITEM_ROLE,
    AddOnChangedError,
    BUNDLE_TYPE_SELECT,
    normalizeBundleType,
} from './campaignAddOns';
import {
    defaultShareTiers,
    describeShareScheduleForCoordinator,
    describeShareTierRanges,
    isUsableSchedule,
    nextAddOnRate,
    normalizeStoredTiers,
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

/** The campaign's add-on assignment and its share schedule, tenant-checked; null when none. */
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
            share_tiers: { select: { starting_quantity: true, percent: true }, orderBy: { starting_quantity: 'asc' } },
        },
    });
    if (!row || row.business_id !== params.businessId) return null;
    return { campaignAddOnId: row.id, bundleId: row.bundle_id, tiers: normalizeStoredTiers(row.share_tiers) };
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

    let soldBefore = await countCampaignAddOnUnitsSold(tx, params.campaignId, { excludeOrderId: params.orderId });
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
    | 'SHARE_TIER_LOCKED';

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
 * Assign (no add-on yet) or replace (a different bundle) the campaign's add-on.
 *   assign  -> the assignment row plus ONE share tier: unit 1 onward at the campaign's CURRENT meal share.
 *   replace -> the same row points at the new bundle; its share schedule is kept as the tenant left it.
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
        select: { id: true, business_id: true, bundle_id: true },
    });
    if (existing && existing.business_id !== params.businessId) {
        return { ok: false, status: 404, code: 'NO_ADDON_ASSIGNED', error: 'Campaign not found.' };
    }
    if (existing) {
        if (existing.bundle_id === bundle.id) return { ok: true, changed: false };
        await tx.campaignAddOn.update({ where: { id: existing.id }, data: { bundle_id: bundle.id } });
        return { ok: true, changed: true };
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

/** Remove the campaign's add-on (its schedule cascades). Money already earned stays on its orders. */
export async function removeCampaignAddOn(
    tx: any,
    params: { campaignId: string; businessId: string },
): Promise<AddOnAdminResult> {
    const result = await tx.campaignAddOn.deleteMany({
        where: { campaign_id: params.campaignId, business_id: params.businessId },
    });
    return { ok: true, changed: (Number(result?.count) || 0) > 0 };
}

/**
 * Replace the schedule with `next` (already parsed by parseShareTierSchedule), refusing any change to a
 * tier the campaign's sold add-ons have already reached. Unchanged tiers are not rewritten.
 */
export async function updateCampaignAddOnShareTiers(
    tx: any,
    params: { campaignId: string; businessId: string; next: ShareTier[] },
): Promise<AddOnAdminResult> {
    const schedule = await loadCampaignAddOnSchedule(tx, { campaignId: params.campaignId, businessId: params.businessId });
    if (!schedule) {
        return { ok: false, status: 409, code: 'NO_ADDON_ASSIGNED', error: 'Choose a supporter add-on for this fundraiser first.' };
    }
    const unitsSold = await countCampaignAddOnUnitsSold(tx, params.campaignId);
    const decision = validateShareScheduleEdit({ current: schedule.tiers, next: params.next, unitsSold });
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

// ── The coordinator's view (read-only) ───────────────────────────────────────

export interface CoordinatorAddOnView {
    bundleId: string;
    name: string;
    price: number;
    /** Plain language, e.g. "Your organization earns 10% on the first 10 add-ons and 15% beginning with add-on 11." */
    shareSummary: string;
    /** The same schedule as ranges, for an optional detail list. No editing affordance exists for a coordinator. */
    shareTiers: Array<{ rangeLabel: string; percent: number }>;
    unitsSold: number;
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
            bundle: { select: { id: true, name: true, price: true, is_active: true, business_id: true, ...BUNDLE_TYPE_SELECT } },
            share_tiers: { select: { starting_quantity: true, percent: true }, orderBy: { starting_quantity: 'asc' } },
        },
    });
    if (!assignment || assignment.business_id !== params.businessId) return null;
    const b = assignment.bundle;
    if (!b || b.business_id !== params.businessId || b.is_active !== true) return null;
    if (normalizeBundleType(b.bundle_type) !== ADD_ON_BUNDLE_TYPE) return null;
    const tiers = normalizeStoredTiers(assignment.share_tiers);
    if (!isUsableSchedule(tiers)) return null;
    const money = await loadCampaignAddOnMoney(db, params.campaignId);
    return {
        bundleId: b.id,
        name: b.name,
        price: Number(b.price) || 0,
        shareSummary: describeShareScheduleForCoordinator(tiers),
        shareTiers: describeShareTierRanges(tiers, money.unitsSold).map((t) => ({ rangeLabel: t.rangeLabel, percent: t.percent })),
        unitsSold: money.unitsSold,
        grossSales: money.grossSales,
        earnedShare: money.earnedShare,
    };
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
    };
    unitsSold: number;
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
    const [assignment, money, candidates] = await Promise.all([
        db.campaignAddOn.findUnique({
            where: { campaign_id: campaign.id },
            select: {
                business_id: true,
                bundle_id: true,
                bundle: { select: { id: true, name: true, price: true, is_active: true, business_id: true, ...BUNDLE_TYPE_SELECT } },
                share_tiers: { select: { starting_quantity: true, percent: true }, orderBy: { starting_quantity: 'asc' } },
            },
        }),
        loadCampaignAddOnMoney(db, campaign.id),
        db.bundle.findMany({
            where: { business_id: businessId, ...({ bundle_type: ADD_ON_BUNDLE_TYPE } as {}) },
            select: ELIGIBILITY_SELECT,
            orderBy: { name: 'asc' },
        }),
    ]);

    let addOn: CampaignAddOnAdminView['addOn'] = null;
    if (assignment && assignment.business_id === businessId && assignment.bundle) {
        const tiers = normalizeStoredTiers(assignment.share_tiers);
        const b = assignment.bundle;
        addOn = {
            bundleId: b.id,
            name: b.name,
            price: Number(b.price) || 0,
            sellable: b.is_active === true && normalizeBundleType(b.bundle_type) === ADD_ON_BUNDLE_TYPE && b.business_id === businessId,
            tiers: describeShareTierRanges(tiers, money.unitsSold),
            next: nextAddOnRate(tiers, money.unitsSold),
        };
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
        unitsSold: money.unitsSold,
        grossSales: money.grossSales,
        earnedShare: money.earnedShare,
        eligibleBundles,
        unavailableBundles,
    };
}
