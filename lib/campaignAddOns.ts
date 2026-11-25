/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S1) — the ONE authority for fundraiser add-on order rules.
 *
 * WHAT AN ADD-ON IS
 * A real tenant Bundle with `bundle_type = 'addon'` (e.g. a Sides & Dessert Bundle) that a campaign
 * offers supporters as an optional extra beside its normal meal bundles. A campaign offers at most ONE,
 * assigned by the tenant through the `campaign_add_ons` table — never as a CampaignBundle row, so the
 * campaign's main lineup (families, selection limit, reselection and its locks) never sees it.
 *
 * THE RULES (every fundraiser order path calls this module; none re-implements it)
 *   1. `'manual_upsell'` is refused on any campaign order. It was a tenant-wide storefront sentinel that
 *      slipped past the campaign lineup checks; fundraiser add-ons are real bundles instead.
 *   2. A line is an ADD-ON when its tenant-scoped bundle row says `bundle_type = 'addon'`. Every other
 *      line is a MAIN line and goes through the existing lineup, active-bundle and pricing checks
 *      exactly as before (an unknown or foreign id is still refused there).
 *   3. An add-on line must be THIS campaign's currently assigned add-on — same tenant, active, typed
 *      'addon'. Anything else (another campaign's add-on, an unassigned add-on, an add-on the tenant has
 *      since changed or removed) is refused with 409 so a stale page reloads rather than being
 *      silently given a different product.
 *   4. Outside a campaign (storefront, staff manual orders) an add-on bundle is never sellable.
 *   5. The add-on may appear on ONE line (its quantity may be > 1).
 *   6. An order with an add-on must also contain at least one meal-bundle line. Serving size plays no
 *      part: a Serves 5 line and a Serves 2 line qualify equally (owner decision D11).
 *
 * The server decides each line's `item_role` ('main' | 'addon') here and persists it as a historical
 * snapshot; a client never supplies it. Price comes from the existing server price path (lib/pricing.ts),
 * and the add-on's stored name comes from its bundle row, not from the request.
 *
 * GOAL MATH: an `item_role = 'addon'` line is real money (subtotal, tax, gross sales, org share, closeout,
 * invoice) but contributes ZERO bundle-goal units — see computeBundleUnitsFromItems in
 * lib/fundraiserMetrics.ts, which imports isAddOnItemRole from here.
 *
 * This file has no imports and reads the database only through the client passed in, so it is safe to
 * import from client components (lib/fundraiserMetrics.ts is one).
 */

export type BundleType = 'meal' | 'addon';
export type OrderItemRole = 'main' | 'addon';

export const MEAL_BUNDLE_TYPE: BundleType = 'meal';
export const ADD_ON_BUNDLE_TYPE: BundleType = 'addon';
export const MAIN_ITEM_ROLE: OrderItemRole = 'main';
export const ADD_ON_ITEM_ROLE: OrderItemRole = 'addon';

/** The storefront sentinel line id that rule 1 refuses on campaign orders. */
export const MANUAL_UPSELL_SENTINEL = 'manual_upsell';

/**
 * Prisma `select` fragments for the S1 columns. Spread them (`...BUNDLE_TYPE_SELECT`) rather than writing
 * `bundle_type: true`, so code still type-checks against a Prisma client generated before S1.
 */
export const BUNDLE_TYPE_SELECT = { bundle_type: true } as {};
export const ITEM_ROLE_SELECT = { item_role: true } as {};
/** S4: campaign_add_ons.show_share_percent — the tenant's per-fundraiser "show the share %" choice. */
export const SHOW_SHARE_PERCENT_SELECT = { show_share_percent: true } as {};
/**
 * B2 remediation: campaign_add_ons.removed_at — null while the add-on is offered, a timestamp once the tenant
 * removed it. A removed row is KEPT (with its share schedule) so offering an add-on again resumes it; every
 * reader of "the campaign's add-on" must treat a removed row exactly like no row.
 */
export const REMOVED_AT_SELECT = { removed_at: true } as {};

/**
 * True when the campaign_add_ons row is present and NOT removed — the add-on is CONFIGURED (the tenant's
 * program is live: its schedule can be edited, earnings are recorded against it). Whether SUPPORTERS are
 * offered it is the narrower isSupporterOfferedAddOnRow below (FR-ADDON-LAUNCH-FLOW-1 1B).
 */
export function isOfferedAddOnRow(row: unknown): boolean {
    if (!row || typeof row !== 'object') return false;
    const removedAt = (row as { removed_at?: unknown }).removed_at;
    return removedAt === null || removedAt === undefined;
}

// ── FR-ADDON-LAUNCH-FLOW-1 (1B): the coordinator's participation ──────────────────────────────────────
//
// Two separate facts, owned by two different people (the B2 removal state is NOT reused — a coordinator must
// never be able to undo a tenant's removal, and the tenant must be able to configure tiers before the
// coordinator answers):
//   offer_mode            the TENANT's authorization: 'included' (default) | 'coordinator_choice'
//   coordinator_decision  the COORDINATOR's answer:   null | 'accepted' | 'declined'
// Supporters (supporter page, every order path, flyer/packet/tracker, the coordinator's offline orders and
// panel) are offered the add-on only when it is configured AND (included OR accepted).

export type AddOnOfferMode = 'included' | 'coordinator_choice';
export type CoordinatorAddOnDecision = 'accepted' | 'declined';
export const ADDON_OFFER_INCLUDED: AddOnOfferMode = 'included';
export const ADDON_OFFER_COORDINATOR_CHOICE: AddOnOfferMode = 'coordinator_choice';
export const COORDINATOR_ADDON_ACCEPTED: CoordinatorAddOnDecision = 'accepted';
export const COORDINATOR_ADDON_DECLINED: CoordinatorAddOnDecision = 'declined';

/**
 * Everything the "offered to supporters" decision reads. Spread it (as with REMOVED_AT_SELECT) so the code
 * type-checks against a Prisma client generated before the 1B migration.
 */
export const OFFER_STATE_SELECT = { removed_at: true, offer_mode: true, coordinator_decision: true } as {};
/** OFFER_STATE_SELECT plus when the coordinator answered — for the tenant's and the coordinator's views. */
export const OFFER_STATE_WITH_DECIDED_AT_SELECT = {
    removed_at: true, offer_mode: true, coordinator_decision: true, coordinator_decided_at: true,
} as {};

/** Only the exact value 'coordinator_choice' asks the coordinator; the column defaults to 'included'. */
export function normalizeAddOnOfferMode(value: unknown): AddOnOfferMode {
    return value === ADDON_OFFER_COORDINATOR_CHOICE ? ADDON_OFFER_COORDINATOR_CHOICE : ADDON_OFFER_INCLUDED;
}

export function normalizeCoordinatorAddOnDecision(value: unknown): CoordinatorAddOnDecision | null {
    if (value === COORDINATOR_ADDON_ACCEPTED) return COORDINATOR_ADDON_ACCEPTED;
    if (value === COORDINATOR_ADDON_DECLINED) return COORDINATOR_ADDON_DECLINED;
    return null;
}

/** True when SUPPORTERS may be offered (and sold) this row's add-on: configured AND (included OR accepted). */
export function isSupporterOfferedAddOnRow(row: unknown): boolean {
    if (!isOfferedAddOnRow(row)) return false;
    const r = row as { offer_mode?: unknown; coordinator_decision?: unknown };
    if (normalizeAddOnOfferMode(r.offer_mode) === ADDON_OFFER_INCLUDED) return true;
    return normalizeCoordinatorAddOnDecision(r.coordinator_decision) === COORDINATOR_ADDON_ACCEPTED;
}

/** A stored classification. Only the exact value 'addon' is an add-on; the column defaults to 'meal'. */
export function normalizeBundleType(value: unknown): BundleType {
    return value === ADD_ON_BUNDLE_TYPE ? ADD_ON_BUNDLE_TYPE : MEAL_BUNDLE_TYPE;
}

/** True only for a line whose stored role is exactly 'addon'. */
export function isAddOnItemRole(role: unknown): boolean {
    return role === ADD_ON_ITEM_ROLE;
}

// ── Database reads ───────────────────────────────────────────────────────────

export interface OrderBundleFact {
    id: string;
    name: string | null;
    bundleType: BundleType;
}

interface BundleReader {
    bundle: { findMany(args: any): Promise<any[]> };
}

/**
 * The tenant-scoped classification of every submitted bundle id. Ids the tenant does not own are simply
 * absent, exactly as they are from the price map.
 */
export async function loadOrderBundleFacts(
    db: BundleReader,
    businessId: string,
    bundleIds: unknown[],
): Promise<Map<string, OrderBundleFact>> {
    const ids = Array.from(new Set(bundleIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
    const facts = new Map<string, OrderBundleFact>();
    if (ids.length === 0) return facts;
    const rows = await db.bundle.findMany({
        where: { id: { in: ids }, business_id: businessId },
        select: { id: true, name: true, ...BUNDLE_TYPE_SELECT },
    });
    for (const row of rows || []) {
        if (!row || typeof row.id !== 'string') continue;
        facts.set(row.id, {
            id: row.id,
            name: typeof row.name === 'string' ? row.name : null,
            bundleType: normalizeBundleType(row.bundle_type),
        });
    }
    return facts;
}

export interface CampaignAddOnAuthority {
    bundleId: string;
    /** The add-on's own bundle name — the name stored on its order line. */
    name: string | null;
}

/**
 * The campaign's CURRENTLY authorized add-on, or null. Authorized means: an assignment row for this
 * campaign in this tenant that is not removed (B2) and is offered to supporters (1B: included by the tenant,
 * or accepted by the coordinator), pointing at a bundle of this tenant that is active and typed 'addon'.
 * (Postgres already guarantees the tenant agreement through composite keys; it is re-checked here so a
 * caller can never be handed another tenant's bundle.)
 */
export async function loadCampaignAddOnAuthority(
    db: any,
    params: { campaignId: string; businessId: string },
): Promise<CampaignAddOnAuthority | null> {
    const row = await db.campaignAddOn.findUnique({
        where: { campaign_id: params.campaignId },
        select: {
            business_id: true,
            bundle_id: true,
            ...OFFER_STATE_SELECT,
            bundle: { select: { id: true, name: true, business_id: true, is_active: true, bundle_type: true } },
        },
    });
    if (!row || row.business_id !== params.businessId) return null;
    // B2: a removed add-on keeps its row (and schedule) but is not offered — no order may carry it.
    // 1B: nor one the coordinator has not accepted (coordinator_choice awaiting an answer, or declined).
    if (!isSupporterOfferedAddOnRow(row)) return null;
    const bundle = row.bundle;
    if (!bundle || bundle.id !== row.bundle_id || bundle.business_id !== params.businessId) return null;
    if (bundle.is_active !== true || bundle.bundle_type !== ADD_ON_BUNDLE_TYPE) return null;
    return { bundleId: bundle.id, name: typeof bundle.name === 'string' ? bundle.name : null };
}

// ── The line rules ───────────────────────────────────────────────────────────

/** True when any submitted line is an add-on-typed bundle, i.e. the campaign's add-on must be looked up. */
export function orderLinesNeedAddOnAuthority(
    lineBundleIds: Array<string | null | undefined>,
    bundleFacts: Map<string, OrderBundleFact>,
): boolean {
    return lineBundleIds.some((id) => typeof id === 'string' && bundleFacts.get(id)?.bundleType === ADD_ON_BUNDLE_TYPE);
}

export type AddOnRuleCode =
    | 'MANUAL_UPSELL_NOT_ALLOWED'
    | 'ADDON_NOT_AVAILABLE'
    | 'ADDON_CHANGED'
    | 'DUPLICATE_ADDON_LINE'
    | 'ADDON_REQUIRES_MEAL';

export const ADDON_CHANGED_MESSAGE =
    'This fundraiser\'s add-on just changed. Please refresh and place your order again.';

export type ClassifiedOrderLines =
    | {
        ok: true;
        /** One role per submitted line, in request order. */
        roles: OrderItemRole[];
        /** The add-on bundle id(s) on this order: empty, or exactly the campaign's authorized add-on. */
        addOnBundleIds: string[];
    }
    | { ok: false; status: 400 | 409; code: AddOnRuleCode; error: string };

/**
 * Applies rules 1–6 to the submitted lines. Pure: the caller loads the tenant-scoped bundle facts and,
 * only when a line is add-on-typed, the campaign's authority.
 *
 * @param lineBundleIds   one entry per submitted line, in order (null when the line names no bundle)
 * @param isCampaignOrder true only for an order the SERVER resolved to a campaign
 */
export function classifyFundraiserOrderLines(input: {
    lineBundleIds: Array<string | null | undefined>;
    isCampaignOrder: boolean;
    bundleFacts: Map<string, OrderBundleFact>;
    authorizedAddOn: CampaignAddOnAuthority | null;
}): ClassifiedOrderLines {
    const { lineBundleIds, isCampaignOrder, bundleFacts, authorizedAddOn } = input;

    // Rule 1 — before any lineup check, price, inventory, write or email.
    if (isCampaignOrder && lineBundleIds.some((id) => id === MANUAL_UPSELL_SENTINEL)) {
        return {
            ok: false, status: 400, code: 'MANUAL_UPSELL_NOT_ALLOWED',
            error: 'This item is not available on a fundraiser order.',
        };
    }

    const isAddOnTyped = (id: string | null | undefined): id is string =>
        typeof id === 'string' && bundleFacts.get(id)?.bundleType === ADD_ON_BUNDLE_TYPE;

    const addOnLines = lineBundleIds.filter(isAddOnTyped);

    if (addOnLines.length > 0) {
        // Rule 4.
        if (!isCampaignOrder) {
            return {
                ok: false, status: 400, code: 'ADDON_NOT_AVAILABLE',
                error: 'This item is only available as an add-on to a fundraiser order.',
            };
        }
        // Rule 3 — the line must be THIS campaign's current add-on. Never substituted.
        if (!authorizedAddOn || addOnLines.some((id) => id !== authorizedAddOn.bundleId)) {
            return { ok: false, status: 409, code: 'ADDON_CHANGED', error: ADDON_CHANGED_MESSAGE };
        }
        // Rule 5.
        if (addOnLines.length > 1) {
            return {
                ok: false, status: 400, code: 'DUPLICATE_ADDON_LINE',
                error: 'The add-on can only appear once in an order. Change its quantity instead.',
            };
        }
        // Rule 6 — at least one meal-bundle line the tenant owns. Serving size is never consulted.
        const hasMealLine = lineBundleIds.some((id) =>
            typeof id === 'string' && bundleFacts.get(id)?.bundleType === MEAL_BUNDLE_TYPE);
        if (!hasMealLine) {
            return {
                ok: false, status: 400, code: 'ADDON_REQUIRES_MEAL',
                error: 'An add-on must be ordered with at least one meal bundle.',
            };
        }
    }

    return {
        ok: true,
        roles: lineBundleIds.map((id) => (isAddOnTyped(id) ? ADD_ON_ITEM_ROLE : MAIN_ITEM_ROLE)),
        addOnBundleIds: Array.from(new Set(addOnLines)),
    };
}

// ── The transaction-time recheck ─────────────────────────────────────────────

/**
 * The campaign's add-on changed (or was removed or deactivated) between the preflight and the write.
 * Identified by a marker field rather than `instanceof`: this repository compiles at an ES5 target, where
 * a subclassed Error loses its prototype link (same reason as BundleSelectionChangedError).
 */
export class AddOnChangedError extends Error {
    readonly isAddOnChanged = true as const;
    constructor() {
        super('ADDON_CHANGED');
        this.name = 'AddOnChangedError';
    }
}

export function isAddOnChanged(e: unknown): e is AddOnChangedError {
    return typeof e === 'object' && e !== null && (e as any).isAddOnChanged === true;
}

/**
 * Called INSIDE the order transaction, after the campaign selection lock, by every path that writes an
 * add-on line. Throws AddOnChangedError unless the campaign's current authorized add-on is still exactly
 * the one the preflight accepted. (S2's assignment writer takes the same campaign lock.)
 */
export async function assertCampaignAddOnUnchanged(
    tx: any,
    params: { campaignId: string; businessId: string; expectedBundleIds: string[] },
): Promise<void> {
    if (params.expectedBundleIds.length === 0) return;
    const current = await loadCampaignAddOnAuthority(tx, { campaignId: params.campaignId, businessId: params.businessId });
    if (!current || params.expectedBundleIds.some((id) => id !== current.bundleId)) {
        throw new AddOnChangedError();
    }
}
