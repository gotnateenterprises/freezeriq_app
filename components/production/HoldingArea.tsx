"use client";

import { useState } from 'react';
import { CheckCircle2, Clock, Truck, ChevronDown, ChevronRight, AlertCircle, Trash2, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface Order {
    id: string;
    customer: { name: string; type: string } | null;
    // KB-1A: dashboard payload scalars used as identity fallbacks. A manual order
    // carries customer_name even when no Customer relation was linked, so relying on
    // the relation alone renders a named customer as "Unknown Customer / GUEST".
    customer_name?: string | null;
    source?: string | null;
    created_at: string;
    total_amount: number;
    items: {
        quantity: number;
        bundle: { name: string; sku: string };
    }[];
    status: string;
    delivery_date?: string;
}

interface HoldingAreaProps {
    orders: Order[];
    onRefresh: () => void;
}

// KB-1A: per-order approval failure detail so the operator can see which order
// failed and why.
interface ApprovalFailure {
    id: string;
    httpStatus: number;
    code?: string;
    message?: string;
}

// KB-1A identity fallbacks. An order may carry a usable name on the customer_name
// scalar without a linked Customer relation (manual and imported orders), so the
// relation alone must not decide the display.
const displayCustomerName = (order: Order): string =>
    order.customer?.name || order.customer_name || 'Unknown Customer';

// Badge precedence: relation type → source (when a related name OR customer_name
// exists) → 'customer' (named but sourceless) → 'guest' (genuinely unidentified).
const displayCustomerBadge = (order: Order): string => {
    if (order.customer?.type) return order.customer.type;
    if (order.customer?.name || order.customer_name) {
        return order.source || 'customer';
    }
    return 'guest';
};

export default function HoldingArea({ orders, onRefresh }: HoldingAreaProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [isUpdating, setIsUpdating] = useState(false);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);
    const [failures, setFailures] = useState<ApprovalFailure[]>([]);

    const handleDeleteOrder = async (e: React.MouseEvent, orderId: string) => {
        e.stopPropagation();
        if (!confirm('Are you sure you want to remove this order from Holding?')) return;

        setIsDeleting(orderId);
        try {
            const res = await fetch(`/api/orders?id=${orderId}`, { method: 'DELETE' });
            if (res.ok) {
                toast.success("Order removed");
                onRefresh();
            } else {
                toast.error("Failed to remove order");
            }
        } catch (e) {
            toast.error("An error occurred");
        } finally {
            setIsDeleting(null);
        }
    };

    const toggleSelect = (id: string) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelected(next);
    };

    const toggleAll = () => {
        if (selected.size === orders.length) setSelected(new Set());
        else setSelected(new Set(orders.map(o => o.id)));
    };

    // KB-1A: approval now runs one guarded PATCH per order instead of a single
    // bulk-status call, so each order passes the DD-0.5 transition guard, the
    // canceled-order guard, and (while LOY-P0 is active) the paused loyalty gate.
    // This is intentionally PER-ORDER and may partially succeed — it is not atomic.
    const APPROVAL_CONCURRENCY = 5;

    const approveOne = async (orderId: string): Promise<ApprovalFailure | null> => {
        try {
            const res = await fetch('/api/orders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: orderId, status: 'production_ready' })
            });

            // 200 = approved. An idempotent same-status 200 counts as already approved.
            if (res.ok) return null;

            let code: string | undefined;
            let message: string | undefined;
            try {
                const body = await res.json();
                code = body?.code;
                message = body?.error;
            } catch {
                // Non-JSON error body — fall back to the HTTP status alone.
            }
            return { id: orderId, httpStatus: res.status, code, message };
        } catch (e: any) {
            return { id: orderId, httpStatus: 0, code: 'NETWORK_ERROR', message: e?.message };
        }
    };

    const handleApprove = async () => {
        if (selected.size === 0 || isUpdating) return;

        // Preserve the selected IDs for the duration of the run.
        const orderIds = Array.from(selected);
        setIsUpdating(true);
        setFailures([]);

        try {
            const collected: ApprovalFailure[] = [];

            // Bounded concurrency: at most APPROVAL_CONCURRENCY requests in flight.
            for (let i = 0; i < orderIds.length; i += APPROVAL_CONCURRENCY) {
                const chunk = orderIds.slice(i, i + APPROVAL_CONCURRENCY);
                const settled = await Promise.allSettled(chunk.map(approveOne));

                settled.forEach((result, idx) => {
                    if (result.status === 'fulfilled') {
                        if (result.value) collected.push(result.value);
                    } else {
                        collected.push({
                            id: chunk[idx],
                            httpStatus: 0,
                            code: 'REQUEST_FAILED',
                            message: String(result.reason)
                        });
                    }
                });
            }

            const total = orderIds.length;
            const failed = collected.length;
            const approved = total - failed;

            setFailures(collected);

            if (failed === 0) {
                toast.success(`${approved} order${approved === 1 ? '' : 's'} approved and sent to prep.`);
                setSelected(new Set());
            } else if (approved === 0) {
                toast.error(`No orders were approved. ${failed} require attention.`);
            } else {
                toast.warning(`${approved} of ${total} orders approved. ${failed} require attention.`);
                // Keep only the still-failing orders selected so the operator can retry.
                setSelected(new Set(collected.map(f => f.id)));
            }
        } finally {
            // Refresh exactly once, after every request has settled.
            setIsUpdating(false);
            onRefresh();
        }
    };

    if (orders.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 text-center animate-in fade-in">
                <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-full flex items-center justify-center mb-4 text-slate-400">
                    <CheckCircle2 size={32} />
                </div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white">All Caught Up!</h3>
                <p className="text-slate-500 max-w-xs mt-2">No pending orders found. New orders will appear here for approval.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-2xl border border-indigo-100 dark:border-indigo-800/50">
                <div className="flex items-center gap-3">
                    <input
                        type="checkbox"
                        checked={selected.size === orders.length && orders.length > 0}
                        onChange={toggleAll}
                        className="w-5 h-5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="font-bold text-indigo-900 dark:text-indigo-200 text-sm">
                        {selected.size} Selected
                    </span>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={handleApprove}
                        disabled={selected.size === 0 || isUpdating}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-sm shadow-sm transition-all disabled:opacity-50 disabled:scale-100 hover:scale-105"
                    >
                        {isUpdating ? 'Approving…' : `Approve & Send to Prep`}
                    </button>
                </div>
            </div>

            {/* KB-1A: per-order approval failures — approval is per-order and may
                partially succeed, so surface exactly which orders need attention. */}
            {failures.length > 0 && (
                <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/50 rounded-2xl p-4 space-y-2">
                    <div className="flex items-center gap-2 text-rose-700 dark:text-rose-300 font-black text-sm">
                        <AlertCircle size={16} />
                        {failures.length} order{failures.length === 1 ? '' : 's'} require attention
                    </div>
                    <ul className="space-y-1">
                        {failures.map(f => (
                            <li key={f.id} className="text-xs font-medium text-rose-800 dark:text-rose-200">
                                <span className="font-mono font-bold">{f.id.slice(0, 8)}</span>
                                {' — '}
                                {f.message || 'Approval failed'}
                                {f.code ? ` (${f.code})` : ''}
                                {f.httpStatus ? ` [HTTP ${f.httpStatus}]` : ''}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* List */}
            <div className="space-y-3">
                {orders.map(order => (
                    <div
                        key={order.id}
                        className={`group bg-white dark:bg-slate-800 p-4 rounded-2xl border transition-all hover:shadow-md cursor-pointer
                            ${selected.has(order.id) ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-slate-200 dark:border-slate-700 hover:border-indigo-300'}
                        `}
                        onClick={() => toggleSelect(order.id)}
                    >
                        <div className="flex items-start gap-4">
                            <div className="pt-1">
                                <input
                                    type="checkbox"
                                    checked={selected.has(order.id)}
                                    onChange={() => { }} // Handled by parent div
                                    className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 pointer-events-none"
                                />
                            </div>
                            <div className="flex-1">
                                <div className="flex justify-between items-start mb-2">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h4 className="font-black text-slate-900 dark:text-white text-lg">
                                                {displayCustomerName(order)}
                                            </h4>
                                            <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 text-[10px] font-bold uppercase rounded-md">
                                                {displayCustomerBadge(order)}
                                            </span>
                                        </div>
                                        <p className="text-xs font-bold text-slate-400">
                                            {format(new Date(order.created_at), 'MMM d, h:mm a')} • {order.id.slice(0, 8)}
                                        </p>
                                    </div>
                                    <div className="text-right flex flex-col items-end gap-2">
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={(e) => handleDeleteOrder(e, order.id)}
                                                disabled={isDeleting === order.id}
                                                className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl transition-all"
                                                title="Remove Order"
                                            >
                                                {isDeleting === order.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                                            </button>
                                        </div>
                                        {order.delivery_date && (
                                            <div className="flex items-center gap-1 text-xs text-amber-600 font-bold justify-end">
                                                <Truck size={12} />
                                                Due: {format(new Date(order.delivery_date), 'MM/dd')}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3 text-sm">
                                    {order.items.map((item, i) => (
                                        <div key={i} className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
                                            <span className="text-slate-700 dark:text-slate-300 font-medium">
                                                <span className="font-bold text-slate-900 dark:text-white mr-2">{item.quantity}x</span>
                                                {item.bundle?.name || 'Unknown Bundle'}
                                            </span>
                                            <span className="text-slate-400 font-mono text-xs">{item.bundle?.sku}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
