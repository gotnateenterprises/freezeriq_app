"use client";

import { useState } from 'react';
import { Package, Printer } from 'lucide-react';
import { format } from 'date-fns';
import { useRouter } from 'next/navigation';
import { writeBoxLabelBatch, fetchAuthenticatedBusinessId } from '@/lib/printBatchStorage';
// OPS-6A: the ONE physical packing authority. Pure (no Prisma, no I/O), so the
// lane header can consume the exact same rule the printed labels do rather
// than re-deriving a second, divergent box count.
import { summarizeItemPacking } from '@/lib/physicalBoxPacking';

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
                {/* Part M: printing a whole lane must not mean clicking every
                    supporter in turn. */}
                <button
                    onClick={() => queueBoxLabels(orders, 'Box Labels — Packed & Ready')}
                    disabled={queueing || orders.length === 0}
                    className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center gap-2"
                >
                    <Package size={18} />
                    {queueing ? 'Preparing…' : 'Box Labels — All Orders'}
                </button>
            </div>

            {/* OPS-6: a label click must never end in silence (the OPS-5E
                rule). Every refusal reason surfaces here. */}
            {labelError && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-300 dark:border-amber-800 rounded-2xl p-4 text-sm font-bold text-amber-800 dark:text-amber-300">
                    {labelError}
                </div>
            )}

            <div className="grid grid-cols-1 gap-4">
                {orders.map(order => (
                    <div key={order.id} className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-start gap-4">
                            <div>
                                <h4 className="font-black text-slate-900 dark:text-white text-lg">{order.customer?.name || order.customer_name || 'Unknown Customer'}</h4>
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
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
