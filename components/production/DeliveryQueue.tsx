"use client";

import { useMemo, useState } from 'react';
import { Package, Printer, Truck, AlertTriangle, FileText } from 'lucide-react';
import { format } from 'date-fns';
import { useRouter } from 'next/navigation';
import { writeBoxLabelBatch, writePackingSlipBatch, fetchAuthenticatedBusinessId } from '@/lib/printBatchStorage';
// OPS-6A: the ONE physical packing authority. Pure (no Prisma, no I/O), so the
// lane header can consume the exact same rule the printed labels do rather
// than re-deriving a second, divergent box count.
import { summarizeItemPacking } from '@/lib/physicalBoxPacking';
// PROD-PACKED-READY-NAME-1: the ONE rule for whose order a row is — the box label's
// own supporter resolver for a fundraiser order, the long-standing customer name
// for everything else. See lib/orderRecipientName.ts.
import { resolveOrderRecipientName } from '@/lib/orderRecipientName';
// PACKED-READY-WAVES-1: fundraiser quick-select is a SELECTION layer over the lane's
// existing Set<Order.id>; see lib/packedReadyWaves.ts. Nothing imported here mutates.
import {
    describeLane,
    describeSelectionScope,
    formatScopeLine,
    fundraiserOrganizationFor,
    pruneSelection,
    toggleWaves,
    type FundraiserWave,
} from '@/lib/packedReadyWaves';
import FundraiserQuickSelect from '@/components/production/FundraiserQuickSelect';
import FundraiserIdentityLine from '@/components/production/FundraiserIdentityLine';

interface Order {
    id: string;
    customer: {
        name: string;
        type: string;
        delivery_address?: string;
    } | null;
    // KB-1A: identity fallback for orders with no linked Customer relation
    // (manual and imported orders still carry this scalar).
    customer_name?: string | null;
    // PROD-PACKED-READY-NAME-1: order-time identity and the fundraiser signals.
    // All of these are Order scalars the dashboard route already returns
    // (`include` ships every scalar); none is a new query or a new column.
    first_name?: string | null;
    last_name?: string | null;
    source?: string | null;
    campaign_id?: string | null;
    // PACKED-READY-WAVES-1: the campaign the dashboard route now joins for this lane — its
    // name, its delivery DATE and its OWNING organization. Display labels only; the
    // grouping key stays `campaign_id`. Not Order.customer, which may be the organization
    // itself (coordinator-entered) or the supporter (public order).
    campaign?: {
        id?: string;
        name?: string | null;
        delivery_date?: string | null;
        customer?: { name?: string | null } | null;
    } | null;
    created_at: string;
    items: {
        quantity: number;
        // OPS-6: the frozen sale-time tier snapshot, shown per line so the
        // operator can see what each box will claim before printing.
        variant_size?: string | null;
        bundle: { id: string; name: string; sku: string };
    }[];
}

interface DeliveryQueueProps {
    orders: Order[];
    onRefresh: () => void;
}

export default function DeliveryQueue({ orders, onRefresh }: DeliveryQueueProps) {
    const router = useRouter();
    /** OPS-6: why a label click did not proceed. A click never ends in silence. */
    const [labelError, setLabelError] = useState<string | null>(null);
    const [queueing, setQueueing] = useState(false);

    // OPS-6A: truthful physical carton counts for this lane, from the shared
    // packing authority. Identity-free — a count is not a label, so it must
    // not depend on whether every order has a printable supporter name.
    const packing = summarizeItemPacking(orders as any);

    // KB-1A: the Kitchen Board stops at ready_to_ship. Delivery completion moved to
    // the guarded delivery workflow (DD-1); the mark-delivered handler, its
    // bulk-status call to 'delivered', and the selection it drove were removed here.

    /**
     * OPS-6B — which orders the operator has picked to hand over.
     *
     * Part D: a batch action must never release an unrelated order, so the set
     * is explicit and the confirmation names its exact size. Nothing is
     * pre-selected.
     */
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [sending, setSending] = useState(false);
    /** OPS-6B: the outcome of the last handoff. Never ends in silence. */
    const [handoffNotice, setHandoffNotice] = useState<
        { tone: 'ok' | 'warn'; message: string; shortages?: { name: string; needed: number; available: number }[] } | null
    >(null);

    /**
     * PACKED-READY-WAVES-1 — what is the operator actually working on?
     *
     * `selected` is the ONE selection set. Per-order checkboxes edit it, and so does the
     * fundraiser quick-select (which only adds or removes a campaign's own Order IDs). It
     * can hold an id for an order that has since left the lane (a refresh after Send to
     * Delivery, another tab), so every consumer below reads `visibleSelected` — the same
     * set restricted to orders on screen — and a stale id is never counted or sent.
     *
     * `lane.mixed` is true when the lane holds more than one population: two or more
     * fundraisers, or a fundraiser beside ordinary orders. With a mixed lane and nothing
     * selected, "all" would silently mean "every fundraiser at once", so the batch actions
     * below require an explicit choice instead. A single population keeps today's
     * convenient "All" buttons exactly as they were.
     */
    const lane = useMemo(() => describeLane(orders), [orders]);
    const visibleSelected = useMemo(() => pruneSelection(selected, orders), [selected, orders]);
    const selectedOrders = orders.filter(o => visibleSelected.has(o.id));
    const hasSelection = visibleSelected.size > 0;
    const needsExplicitSelection = lane.mixed && !hasSelection;

    const toggleOne = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };
    const allSelected = orders.length > 0 && visibleSelected.size === orders.length;
    const toggleAll = () => {
        setSelected(allSelected ? new Set() : new Set(orders.map(o => o.id)));
    };
    /** Quick-select: add or remove exactly these fundraisers' Order IDs. Touches no other id. */
    const toggleFundraisers = (waves: FundraiserWave[]) => {
        setSelected(prev => toggleWaves(prev, waves));
    };
    const clearSelection = () => setSelected(new Set());

    /**
     * OPS-6B.2 — PRIMARY packing slips, printed BEFORE the handoff.
     *
     * A packing slip is the customer-facing paper that goes INSIDE the box, so
     * it has to be printable while the order is still in Production's hands.
     * The normal sequence is:
     *
     *     Packed & Ready -> Box Labels -> Packing Slips
     *                    -> put the slip in the box -> Send to Delivery
     *
     * Queuing slips is NOT a lifecycle transition and never releases anything:
     * it writes opaque Order IDs to a per-browser batch and navigates. The
     * server re-checks every id against genuine Packed & Ready eligibility
     * (app/api/production/packing-slips), and that route contains no write of
     * any kind, so printing cannot move an order.
     *
     * Distinct storage key from the box-label batch on purpose — the operator
     * prints labels AND slips for the same orders, so both must coexist.
     */
    const queuePackingSlips = async (targetOrders: Order[], name: string) => {
        setLabelError(null);

        const orderIds = targetOrders.map(o => o.id).filter(Boolean);
        if (orderIds.length === 0) {
            setLabelError('There are no orders here to make packing slips for.');
            return;
        }

        setQueueing(true);
        try {
            const ownerBusinessId = await fetchAuthenticatedBusinessId();
            if (!ownerBusinessId) {
                setLabelError('Your business could not be confirmed, so no packing slips were prepared. Please reload and sign in again.');
                return;
            }

            const written = writePackingSlipBatch({ orderIds, businessId: ownerBusinessId, name });
            if (!written.ok) {
                setLabelError(written.reason);
                return;
            }

            router.push('/delivery/print-packing-slips?source=packed-ready');
        } finally {
            setQueueing(false);
        }
    };

    /**
     * OPS-6B — SEND TO DELIVERY: the explicit release of physical custody.
     *
     * This is the ONLY way an order leaves the Packed & Ready lane. It is
     * deliberately NOT wired to printing: printing a box label or a packing
     * slip writes nothing at all (both of those routes are read-only), so no
     * amount of printing or REPRINTING can release an order or consume
     * packaging stock. That separation is structural, not a matter of care.
     *
     * The client sends order IDs and nothing else — no counts, no business id.
     * Eligibility is re-checked server-side at mutation time, so a stale tab
     * cannot release an order that has since moved, and the release is a
     * compare-and-set on a NULL timestamp, so clicking twice is a no-op rather
     * than a double consumption.
     *
     * It does NOT mark anything delivered. Delivery confirmation belongs to a
     * later phase, with the recipient in the loop.
     */
    const sendToDelivery = async (targetOrders: Order[]) => {
        setHandoffNotice(null);

        const orderIds = targetOrders.map(o => o.id).filter(Boolean);
        if (orderIds.length === 0) {
            setHandoffNotice({ tone: 'warn', message: 'There are no orders selected to send to Delivery.' });
            return;
        }

        const noun = orderIds.length === 1 ? 'order' : 'orders';
        // PACKED-READY-WAVES-1: when fundraiser orders are going, say WHICH fundraisers and
        // how many orders each, so the operator confirms the actual scope. The counts come
        // from the very ids in the request below, so they always sum to its size. An
        // ordinary-only send has no lines and keeps its original wording exactly.
        const scope = describeSelectionScope(orderIds, orders);
        const scopeText = scope.lines.length > 0
            ? scope.lines.map(line => `  • ${formatScopeLine(line)}`).join('\n') + '\n\n'
            : '';
        if (!confirm(
            `Send ${orderIds.length} ${noun} to Delivery?\n\n`
            + scopeText
            + `They will leave Packed & Ready and appear in the Delivery queue.\n`
            + `This does NOT mark them delivered.`
        )) return;

        setSending(true);
        try {
            const res = await fetch('/api/delivery/handoff', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderIds }),
            });

            if (!res.ok) {
                const problem = await res.json().catch(() => null);
                setHandoffNotice({
                    tone: 'warn',
                    message: res.status === 401
                        ? 'Your session has expired, so nothing was sent to Delivery. Please sign in again.'
                        : (problem?.error || 'These orders could not be sent to Delivery. Please try again.'),
                });
                return;
            }

            const data = await res.json();
            const parts: string[] = [];
            if (data.released > 0) parts.push(`${data.released} sent to Delivery`);
            if (data.unchanged > 0) parts.push(`${data.unchanged} already sent`);

            setSelected(new Set());
            setHandoffNotice({
                tone: (data.shortages || []).length > 0 ? 'warn' : 'ok',
                message: parts.join(' · ') || 'Nothing changed.',
                shortages: data.shortages || [],
            });

            onRefresh();
        } catch {
            setHandoffNotice({
                tone: 'warn',
                message: 'These orders could not be sent to Delivery (the request failed). Please try again.',
            });
        } finally {
            setSending(false);
        }
    };

    /**
     * OPS-6 — queue supporter OUTER-BOX labels for these orders.
     *
     * WHAT THIS REPLACES, AND WHY IT WAS UNSAFE
     *
     * The previous handler built a /labels URL by hand and its own comments
     * admitted it was guessing ("Assuming we print one label per order-bundle?
     * Or a shipping label?", "Simple heuristic: Take the first bundle"). It:
     *
     *   - read `order.items[0]` ONLY, so a supporter who bought three bundles
     *     across two lines got one label, not three;
     *   - had no box numbering at all;
     *   - never read variant_size, so no sold serving tier appeared;
     *   - passed a BUNDLE id as `recipeId`, a category error the /labels page
     *     would have looked up as a Recipe;
     *   - took the name from `order.customer?.name` — the MUTABLE CRM record,
     *     which for a fundraiser order is the ORGANIZATION, not the supporter —
     *     falling back to the literal string 'Unknown';
     *   - and put that supporter name AND their home delivery address into the
     *     URL query string, where they persist in browser history, server
     *     logs, analytics and referrers. /labels never read either parameter
     *     (OPS-5 added a guard test pinning that), so this was pure leakage
     *     with no function.
     *
     * Now: only opaque Order IDs are handed over, and the label content is
     * resolved server-side from the authenticated session. No supporter data
     * reaches a URL or browser storage.
     *
     * Printing a label is NOT a lifecycle transition. Nothing here marks an
     * order packed or delivered (§8) — those are later phases.
     */
    const queueBoxLabels = async (targetOrders: Order[], name: string) => {
        setLabelError(null);

        const orderIds = targetOrders.map(o => o.id).filter(Boolean);
        if (orderIds.length === 0) {
            setLabelError('There are no orders here to make box labels for.');
            return;
        }

        setQueueing(true);
        try {
            // The tenant comes from the SERVER, not useSession(): OPS-5B/5C/5E
            // each traced a production failure to that client value being
            // absent in Production components, and a falsy id there used to
            // swallow the whole click in silence.
            const ownerBusinessId = await fetchAuthenticatedBusinessId();
            if (!ownerBusinessId) {
                setLabelError('Your business could not be confirmed, so no box labels were prepared. Please reload and sign in again.');
                return;
            }

            const written = writeBoxLabelBatch({ orderIds, businessId: ownerBusinessId, name });
            if (!written.ok) {
                setLabelError(written.reason);
                return;
            }

            router.push('/production/box-labels');
        } finally {
            setQueueing(false);
        }
    };

    if (orders.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 text-center animate-in fade-in">
                <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-full flex items-center justify-center mb-4 text-slate-400">
                    <Package size={32} />
                </div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white">Packed &amp; Ready</h3>
                <p className="text-slate-500 max-w-xs mt-2">Orders marked Packed &amp; Ready will appear here for delivery.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <div className="flex flex-wrap gap-4 justify-between items-center bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <div>
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">Packed &amp; Ready</h2>
                    {/* OPS-6A: orders, purchased BUNDLES and physical BOXES are
                        three different numbers, and the operational one for
                        delivery is BOXES. OPS-6 counted one box per purchased
                        bundle, which overstated the truck load: two Serves-2
                        bundles travel in ONE large carton. The count now comes
                        from the same packing authority the printed labels use,
                        so the header and the sheet count can never disagree. */}
                    <p className="text-slate-500 font-medium">
                        {orders.length} order{orders.length === 1 ? '' : 's'}
                        {' · '}
                        {packing.purchasedBundleCount} bundle{packing.purchasedBundleCount === 1 ? '' : 's'}
                        {' · '}
                        {packing.physicalBoxCount} physical box{packing.physicalBoxCount === 1 ? '' : 'es'}
                        {packing.physicalBoxCount > 0 && ` (${packing.largeBoxCount} large · ${packing.smallBoxCount} small)`}
                    </p>
                    {/* Never silently dropped: a line whose sold tier cannot be
                        proven is not packable, and an operator who is short a
                        carton needs to know why rather than discover it at the
                        truck. */}
                    {packing.unpackable > 0 && (
                        <p className="text-xs font-bold text-amber-600 dark:text-amber-400 mt-1">
                            {packing.unpackable} bundle{packing.unpackable === 1 ? '' : 's'} could not be
                            packed automatically (no provable sold serving size) and {packing.unpackable === 1 ? 'is' : 'are'} not
                            included in the box count.
                        </p>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {/* Part M: printing a whole lane must not mean clicking every
                        supporter in turn.
                        PACKED-READY-WAVES-1: Box Labels now follows the SAME explicit
                        selection Packing Slips and Send to Delivery do — it used to
                        print the whole lane whatever was ticked. With nothing ticked it
                        is still "All Orders", but only when the lane is ONE population;
                        in a mixed lane an accidental all-fundraiser print is not
                        offered, a choice is required. Queuing labels writes Order IDs
                        to a per-browser batch and navigates; it never changes an order. */}
                    <button
                        onClick={() => queueBoxLabels(
                            hasSelection ? selectedOrders : needsExplicitSelection ? [] : orders,
                            hasSelection ? 'Box Labels — Selected' : 'Box Labels — Packed & Ready',
                        )}
                        disabled={queueing || orders.length === 0 || needsExplicitSelection}
                        className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center gap-2"
                    >
                        <Package size={18} />
                        {queueing
                            ? 'Preparing…'
                            : hasSelection
                                ? `Box Labels — ${visibleSelected.size}`
                                : needsExplicitSelection
                                    ? 'Box Labels — choose orders'
                                    : 'Box Labels — All Orders'}
                    </button>

                    {/* OPS-6B.2: the slip that goes INSIDE the box, printed
                        before the order is handed over. Printing releases
                        nothing — Send to Delivery below is still the only
                        action that does. */}
                    <button
                        onClick={() => queuePackingSlips(
                            hasSelection ? selectedOrders : needsExplicitSelection ? [] : orders,
                            'Packing Slips — Packed & Ready',
                        )}
                        disabled={queueing || orders.length === 0 || needsExplicitSelection}
                        className="bg-slate-700 text-white px-6 py-3 rounded-xl font-bold hover:bg-slate-800 transition-colors shadow-lg shadow-slate-500/20 disabled:opacity-50 flex items-center gap-2"
                    >
                        <FileText size={18} />
                        {queueing
                            ? 'Preparing…'
                            : hasSelection
                                ? `Packing Slips — ${visibleSelected.size}`
                                : needsExplicitSelection
                                    ? 'Packing Slips — choose orders'
                                    : 'Packing Slips — All Orders'}
                    </button>

                    {/* OPS-6B: the deliberate handoff. Printing above never does
                        this — only this button does. */}
                    {/* PACKED-READY-WAVES-1: "Send All" used to be the meaning of an empty
                        selection. With several fundraisers (or a fundraiser beside
                        ordinary orders) in the lane that would release every one of them
                        from a single click, so a mixed lane must be told WHAT to send.
                        The per-row "Send to Delivery" buttons stay: each names one order.
                        The route is untouched — it still takes exact Order IDs. */}
                    <button
                        onClick={() => sendToDelivery(hasSelection ? selectedOrders : needsExplicitSelection ? [] : orders)}
                        disabled={sending || orders.length === 0 || needsExplicitSelection}
                        className="bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-emerald-700 transition-colors shadow-lg shadow-emerald-500/20 disabled:opacity-50 flex items-center gap-2"
                    >
                        <Truck size={18} />
                        {sending
                            ? 'Sending…'
                            : hasSelection
                                ? `Send ${visibleSelected.size} to Delivery`
                                : needsExplicitSelection
                                    ? 'Send to Delivery — choose orders'
                                    : 'Send All to Delivery'}
                    </button>
                </div>
            </div>

            {/* OPS-6: a label click must never end in silence (the OPS-5E
                rule). Every refusal reason surfaces here. */}
            {labelError && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-300 dark:border-amber-800 rounded-2xl p-4 text-sm font-bold text-amber-800 dark:text-amber-300">
                    {labelError}
                </div>
            )}

            {/* OPS-6B: a handoff click never ends in silence either. A packaging
                shortage is REPORTED, not silently absorbed and not a refusal —
                stale bookkeeping must never strand physically-packed boxes. */}
            {handoffNotice && (
                <div className={
                    handoffNotice.tone === 'ok'
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-2 border-emerald-300 dark:border-emerald-800 rounded-2xl p-4 text-sm font-bold text-emerald-800 dark:text-emerald-300'
                        : 'bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-300 dark:border-amber-800 rounded-2xl p-4 text-sm font-bold text-amber-800 dark:text-amber-300'
                }>
                    <div>{handoffNotice.message}</div>
                    {(handoffNotice.shortages || []).length > 0 && (
                        <ul className="mt-2 space-y-1 font-medium">
                            {handoffNotice.shortages!.map((s, i) => (
                                <li key={i} className="flex items-center gap-2">
                                    <AlertTriangle size={14} className="shrink-0" />
                                    Packaging short: {s.name} — needed {s.needed}, had {s.available}.
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* PACKED-READY-WAVES-1: pick a whole fundraiser. Only edits the selection
                below; renders nothing for a lane with no fundraiser orders. */}
            <FundraiserQuickSelect
                waves={lane.waves}
                selected={visibleSelected}
                onToggle={toggleFundraisers}
            />

            {/* In a mixed lane the batch buttons wait for a choice rather than guess. */}
            {needsExplicitSelection && (
                <div className="bg-slate-50 dark:bg-slate-900/40 border-2 border-slate-200 dark:border-slate-700 rounded-2xl p-4 text-sm font-bold text-slate-600 dark:text-slate-300">
                    This lane holds {lane.groupCount} separate groups of orders. Choose a fundraiser above, or tick the
                    orders you want. Box Labels, Packing Slips and Send to Delivery only ever use what you choose.
                </div>
            )}

            {/* OPS-6B: select exactly what will move. Part D — no unrelated
                order is ever released because another one was. */}
            <div className="flex items-center gap-3 px-1">
                <input
                    type="checkbox"
                    id="dq-select-all"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <label htmlFor="dq-select-all" className="text-sm font-bold text-slate-500 dark:text-slate-400 cursor-pointer">
                    {hasSelection ? `${visibleSelected.size} selected` : 'Select all'}
                </label>
                {hasSelection && (
                    <button
                        type="button"
                        onClick={clearSelection}
                        className="text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        Clear selection
                    </button>
                )}
            </div>

            <div className="grid grid-cols-1 gap-4">
                {orders.map(order => (
                    <div key={order.id} className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-start gap-4">
                            <input
                                type="checkbox"
                                checked={visibleSelected.has(order.id)}
                                onChange={() => toggleOne(order.id)}
                                className="mt-1.5 w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                aria-label={`Select order ${order.id.slice(0, 8)}`}
                            />
                            <div>
                                {/* PROD-PACKED-READY-NAME-1: a fundraiser order is titled by the
                                    SUPPORTER (the same resolver the box label uses). The linked
                                    Customer can be the ORGANIZATION on a coordinator-entered
                                    order, so it must not decide the title. Ordinary orders are
                                    titled exactly as before. */}
                                <h4 className="font-black text-slate-900 dark:text-white text-lg">{resolveOrderRecipientName(order)}</h4>
                                {/* PACKED-READY-WAVES-1: WHICH fundraiser this order belongs to,
                                    from the campaign's owning organization (the label's own
                                    resolver) — never Order.customer. The supporter above stays
                                    primary. Null for an ordinary order, which gets no line. */}
                                <FundraiserIdentityLine organizationName={fundraiserOrganizationFor(order)} variant="row" />
                                <div className="text-sm text-slate-500 flex flex-col">
                                    <span>#{order.id.slice(0, 8)} • {format(new Date(order.created_at), 'MMM d')}</span>
                                    {order.customer?.delivery_address && (
                                        <span className="font-medium text-slate-600 dark:text-slate-400 mt-1">
                                            {order.customer.delivery_address}
                                        </span>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-2 mt-2">
                                    {order.items.map((item, i) => (
                                        <span key={i} className="px-2 py-1 bg-slate-100 dark:bg-slate-700 rounded text-xs font-bold text-slate-600 dark:text-slate-300">
                                            {item.quantity}x {item.bundle.sku}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2 self-end md:self-center">
                            <button
                                onClick={() => queueBoxLabels([order], 'Box Labels')}
                                disabled={queueing}
                                className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-50"
                                title="Box labels for this order"
                            >
                                <Printer size={20} />
                            </button>
                            <button
                                onClick={() => queuePackingSlips([order], 'Packing Slips')}
                                disabled={queueing}
                                className="p-2 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
                                title="Packing slips for this order"
                            >
                                <FileText size={20} />
                            </button>
                            <button
                                onClick={() => sendToDelivery([order])}
                                disabled={sending}
                                className="flex items-center gap-1.5 px-3 py-2 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg font-bold text-xs transition-colors disabled:opacity-50"
                                title="Send this order to Delivery"
                            >
                                <Truck size={16} />
                                Send to Delivery
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
