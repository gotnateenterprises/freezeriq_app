/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S4) — the supporter page's add-on offer, as one small pure state machine.
 *
 * The public fundraiser page offers the campaign's add-on (e.g. a Sides & Dessert Bundle) as an INLINE card
 * inside "Your order" — never a pop-up, never forced. This module owns every rule about when that card is a
 * full card, a quiet link, an order line or nothing, so the rules are testable without a page and the page
 * (FundraiserClient) only dispatches events and renders the view.
 *
 *   QUALIFYING    the basket holds at least one MAIN meal-bundle line. Serving size is never consulted:
 *                 a Serves 5 line and a Serves 2 line qualify equally (owner decision D11).
 *   FULL CARD     a qualifying basket, the add-on not in it, and the supporter has never acted on the offer
 *                 (or used the quiet link to reopen it). Quantity changes never re-open or re-emphasise it.
 *   QUIET LINK    after "No thanks", after removing the add-on, or after the add-on was removed with the
 *                 last meal. Never re-opens by itself during the page session.
 *   IN ORDER      an ordinary order line with − / + / ✕ — no special cap.
 *   LAST MEAL     removing the last main line takes the add-on out of the basket too, with a quiet,
 *                 announced explanation. (The server refuses an add-on-only order regardless.)
 *   STALE         the order route answered 409 ADDON_CHANGED (removed, reassigned or deactivated while the
 *                 page was open): the add-on leaves the basket, the meals stay, and the offer is hidden for
 *                 the rest of the session — a different add-on is never swapped in silently.
 *
 * Display only: prices, tax, goal units and the add-on's authority are all decided elsewhere (the order
 * route; lib/fundraiserTax.ts; lib/fundraiserMetrics.ts; lib/campaignAddOns.ts). Pure and React-free.
 */

export type AddOnOfferInteraction = 'none' | 'declined' | 'added' | 'removed';

export interface AddOnOfferState {
    /** Add-on units in the basket (0 = not in the order). */
    quantity: number;
    /** Whether, and how, the supporter has acted on the offer this page session. */
    interaction: AddOnOfferInteraction;
    /** The quiet link was used to show the full card again. */
    reopened: boolean;
    /** The server said this add-on is no longer offered (409 ADDON_CHANGED). Hidden for the session. */
    unavailable: boolean;
    /** A quiet, announced explanation of an automatic change, or null. */
    notice: string | null;
}

export const INITIAL_ADD_ON_OFFER: AddOnOfferState = Object.freeze({
    quantity: 0,
    interaction: 'none',
    reopened: false,
    unavailable: false,
    notice: null,
}) as AddOnOfferState;

export type AddOnOfferEvent =
    | { type: 'add' }
    | { type: 'increase' }
    | { type: 'decrease' }
    | { type: 'remove' }
    | { type: 'decline' }
    | { type: 'reopen' }
    /** After every change to the MAIN lines, with the count of main lines that remain. */
    | { type: 'mainLinesChanged'; mainLineCount: number; addOnName: string }
    /** The order route refused the add-on as no longer this campaign's (409 ADDON_CHANGED). */
    | { type: 'serverRejected' }
    | { type: 'orderPlaced' };

/** Shown (as the submit error) when the order route answers 409 ADDON_CHANGED. */
export const ADD_ON_NO_LONGER_AVAILABLE_MESSAGE =
    'That add-on is no longer available. Your meal bundle selections are still in your order.';

/** The quiet explanation when the add-on leaves with the last meal bundle. */
export function addOnRemovedWithLastMealMessage(addOnName: string): string {
    const name = (addOnName ?? '').trim() || 'add-on';
    return `We removed the ${name} — it can only be ordered with a meal bundle.`;
}

export function reduceAddOnOffer(state: AddOnOfferState, event: AddOnOfferEvent): AddOnOfferState {
    switch (event.type) {
        case 'add':
            if (state.unavailable) return state;
            return { ...state, quantity: Math.max(1, state.quantity), interaction: 'added', reopened: false, notice: null };
        case 'increase':
            if (state.unavailable || state.quantity < 1) return state;
            return { ...state, quantity: state.quantity + 1 };
        case 'decrease':
            if (state.quantity < 1) return state;
            return state.quantity === 1
                ? { ...state, quantity: 0, interaction: 'removed', reopened: false }
                : { ...state, quantity: state.quantity - 1 };
        case 'remove':
            if (state.quantity < 1) return state;
            return { ...state, quantity: 0, interaction: 'removed', reopened: false };
        case 'decline':
            return { ...state, interaction: 'declined', reopened: false };
        case 'reopen':
            if (state.unavailable) return state;
            return { ...state, reopened: true };
        case 'mainLinesChanged': {
            const count = Math.max(0, Math.floor(Number(event.mainLineCount) || 0));
            if (count === 0 && state.quantity > 0) {
                return {
                    ...state,
                    quantity: 0,
                    interaction: 'removed',
                    reopened: false,
                    notice: addOnRemovedWithLastMealMessage(event.addOnName),
                };
            }
            // A meal is back in the basket: the explanation has done its job.
            if (count > 0 && state.notice) return { ...state, notice: null };
            return state;
        }
        case 'serverRejected':
            return { ...state, quantity: 0, unavailable: true, reopened: false, notice: null };
        case 'orderPlaced':
            return { ...INITIAL_ADD_ON_OFFER, unavailable: state.unavailable };
        default:
            return state;
    }
}

export type AddOnOfferView = 'hidden' | 'card' | 'quiet' | 'inOrder';

/**
 * What the page shows for the add-on right now. `mainLineCount` is the number of MAIN meal-bundle lines —
 * the one qualifying test. Serving size never enters it.
 */
export function addOnOfferView(
    state: AddOnOfferState,
    context: { hasAddOn: boolean; mainLineCount: number },
): AddOnOfferView {
    if (!context.hasAddOn || state.unavailable) return 'hidden';
    if (!(context.mainLineCount > 0)) return 'hidden';
    if (state.quantity > 0) return 'inOrder';
    if (state.interaction === 'none' || state.reopened) return 'card';
    return 'quiet';
}

/** The add-on units that actually go into the order: none without a meal line, whatever the state says. */
export function addOnQuantityInOrder(state: AddOnOfferState, context: { hasAddOn: boolean; mainLineCount: number }): number {
    return addOnOfferView(state, context) === 'inOrder' ? state.quantity : 0;
}

// ── Copy ─────────────────────────────────────────────────────────────────────
// Benefit-led and truthful: never "free", "bonus", "discount", "full bundle", "Family Size" or "Serves 5".

export const ADD_ON_OFFER_HEADING = 'Complete your meals';

export function addOnOfferBody(addOnName: string, organizationName: string | null | undefined): string {
    const name = (addOnName ?? '').trim() || 'add-on';
    const org = (organizationName ?? '').trim() || 'this fundraiser';
    return `Add our ${name} to round out your freezer meals and help ${org} raise even more.`;
}

/**
 * The optional percentage line — only when the page was given a single-tier percent (the tenant's toggle
 * on, one tier: lib/campaignAddOnShare.publicAddOnSupportPercent). Otherwise null; the body already carries
 * the general support message.
 */
export function addOnSupportLine(organizationName: string | null | undefined, supportPercent: unknown): string | null {
    const pct = typeof supportPercent === 'number' && Number.isFinite(supportPercent) && supportPercent > 0 ? supportPercent : null;
    if (pct === null) return null;
    const org = (organizationName ?? '').trim() || 'this fundraiser';
    return `Your purchase also helps ${org} earn ${parseFloat(pct.toFixed(2))}% on this add-on.`;
}

export function addOnPriceText(price: unknown): string {
    const n = Number(price);
    return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}
