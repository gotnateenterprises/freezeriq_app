'use client';

/**
 * COORD-LIVE-TRACKER-1 — the coordinator's in-portal order list.
 *
 * Reads only what app/api/coordinator/route.ts's GET already returns (the
 * SAME session-scoped, privacy-filtered response the rest of the portal
 * trusts) and the SAME 30-second poll (FR-COORD-123, app/coordinator/portal/page.tsx)
 * already keeps fresh — this component adds no data source and no refresh
 * mechanism of its own.
 *
 * WHAT CHANGED FROM THE PRIOR VERSION: each order used to render only a
 * supporter name and an item COUNT ("3 items"), discarding the real Bundle
 * name, serving tier, quantity, participant association, and order time
 * that the API response already carries. This renders that data instead of
 * throwing it away — no new fields were added to the API for this.
 *
 * PRIVACY BOUNDARY (COORD-FULFILLMENT-1): the API now returns supporter email
 * and phone for the session's OWN campaign, matching the supporter-facing
 * disclosure ("name, email, and phone ... shared with your fundraiser
 * coordinator"), and this component renders them as actionable links. Home
 * address is still never fetched and never rendered: fundraiser supporters are
 * not delivered to individually. Enforced behaviourally by
 * tests/coordFulfillment1.test.ts against the real GET handler.
 */

/** Mirrors lib/email.ts's private formatVariantLabel (not imported — that
 *  module is server-oriented and this component is 'use client'; the
 *  transformation is a one-line string format with nothing to drift). */
function formatServingTierLabel(variantSize: string | null | undefined): string {
    const raw = (variantSize || '').trim();
    if (!raw) return '';
    const spaced = raw.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatOrderTimestamp(createdAt: string | null | undefined): string {
    if (!createdAt) return '';
    const d = new Date(createdAt);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
}

interface OrderLineItem {
    quantity: number;
    variant_size?: string | null;
    item_name?: string | null;
}

export interface TrackerOrder {
    id: string;
    customer_name?: string | null;
    participant_name?: string | null;
    /** COORD-FULFILLMENT-1: supporter contact for this campaign only. Either may
     *  be null — a coordinator-entered order captures no email, and a supporter
     *  may have left phone blank. Null renders nothing rather than a placeholder. */
    email?: string | null;
    phone?: string | null;
    total_amount?: number | string | null;
    created_at?: string | null;
    canceled_at?: string | null;
    items?: OrderLineItem[];
}

/** Digits only, so a formatted number still produces a dialable tel: href. */
function telHref(phone: string): string {
    const cleaned = phone.replace(/[^\d+]/g, '');
    return cleaned ? `tel:${cleaned}` : '';
}

export function RecentOrders({
    orders,
    onCancel,
    onViewAll,
    limit = 3,
    isClosed = false,
    /** COORD-LIVE-TRACKER-1: a single, campaign-level, truthful collection
     *  note — never a per-order status, because no per-order payment field
     *  exists to state one truthfully (Order carries no "paid" concept; see
     *  OrderStatus in prisma/schema.prisma, which is fulfillment lifecycle
     *  only). Mirrors the exact same hasExternalPaymentLink framing
     *  lib/email.ts's sendFundraiserCoordinatorNotification already uses,
     *  not a new definition of it. Omit the prop to render no note at all. */
    hasExternalPaymentLink,
}: {
    orders: TrackerOrder[];
    onCancel: (id: string) => void;
    onViewAll?: () => void;
    limit?: number;
    /** Phase 7E-4: when true, hides cancel button so closed campaigns are read-only */
    isClosed?: boolean;
    hasExternalPaymentLink?: boolean;
}) {
    const active = (orders || []).filter((o: any) => !o.canceled_at);
    const shown = active.slice(0, limit);
    return (
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900 mb-1">Recent orders</h3>
            {hasExternalPaymentLink !== undefined && shown.length > 0 && (
                <p className="text-[11px] font-medium text-slate-400 mb-2">
                    {hasExternalPaymentLink
                        ? 'Supporters may have paid through your payment link — verify before counting as paid.'
                        : 'Payment for these orders is collected by you directly.'}
                </p>
            )}
            <div className="divide-y divide-slate-100">
                {shown.length === 0 && (
                    <p className="py-3 text-xs text-slate-500">No orders yet — your first one shows up here.</p>
                )}
                {shown.map((o) => {
                    const items = o.items || [];
                    return (
                        <div key={o.id} className="flex flex-col gap-1 py-2.5 text-sm">
                            <div className="flex items-start gap-2">
                                <span className="min-w-0 flex-1">
                                    <span className="font-medium text-slate-800">{o.customer_name || 'Supporter'}</span>
                                    {o.participant_name && (
                                        <span className="text-slate-400"> · for {o.participant_name}</span>
                                    )}
                                    {formatOrderTimestamp(o.created_at) && (
                                        <span className="block text-[11px] text-slate-400">{formatOrderTimestamp(o.created_at)}</span>
                                    )}
                                </span>
                                <span className="font-bold tabular-nums text-slate-900 whitespace-nowrap">
                                    ${Number(o.total_amount ?? 0).toFixed(0)}
                                </span>
                                {/* Phase 7E-4: hide cancel button when campaign is closed */}
                                {!isClosed && (
                                    <button onClick={() => onCancel(o.id)} aria-label="Cancel order"
                                        className="text-slate-300 hover:text-red-500">✕</button>
                                )}
                            </div>
                            {items.length > 0 && (
                                <ul className="pl-0.5 text-[12px] text-slate-500 space-y-0.5">
                                    {items.map((it, idx) => {
                                        const tier = formatServingTierLabel(it.variant_size);
                                        return (
                                            <li key={idx} className="truncate">
                                                {it.quantity}× {it.item_name || 'Item'}{tier ? ` — ${tier}` : ''}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                            {/* COORD-FULFILLMENT-1: one compact wrapping row rather
                                than two stacked lines, so a long order list stays
                                scannable on a phone. Each contact is actionable —
                                tapping calls or opens mail — because the coordinator
                                uses this list to chase payment and pickup. Nothing
                                renders when neither is present. */}
                            {(o.email || o.phone) && (
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-0.5 text-[11px]">
                                    {o.email && (
                                        <a
                                            href={`mailto:${o.email}`}
                                            className="max-w-full truncate text-indigo-600 hover:underline"
                                            title={o.email}
                                        >
                                            {o.email}
                                        </a>
                                    )}
                                    {o.phone && telHref(o.phone) && (
                                        <a
                                            href={telHref(o.phone)}
                                            className="whitespace-nowrap text-indigo-600 hover:underline"
                                        >
                                            {o.phone}
                                        </a>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            {active.length > limit && onViewAll && (
                <button onClick={onViewAll} className="w-full pt-2 text-center text-xs font-bold text-indigo-600">
                    View all {active.length} orders →
                </button>
            )}
        </section>
    );
}

export default RecentOrders;
