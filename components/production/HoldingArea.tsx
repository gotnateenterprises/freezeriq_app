"use client";

import { useState } from 'react';
import { CheckCircle2, Clock, Truck, ChevronDown, ChevronRight, AlertCircle, Trash2, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface Order {
    id: string;
    customer: { name: string; type: string };
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

export default function HoldingArea({ orders, onRefresh }: HoldingAreaProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [isUpdating, setIsUpdating] = useState(false);
    const [isDeleting, setIsDeleting] = useState<string | null>(null);

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

    const handleBulkAction = async (action: 'APPROVE' | 'ARCHIVE') => {
        if (selected.size === 0) return;

        setIsUpdating(true);
        try {
            const res = await fetch('/api/orders/bulk-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderIds: Array.from(selected),
                    status: action === 'APPROVE' ? 'APPROVED' : 'ARCHIVED'
                })
            });

            if (res.ok) {
                toast.success(`${selected.size} orders updated`);
                setSelected(new Set());
                onRefresh();
            } else {
                toast.error("Failed to update orders");
            }
        } catch (e) {
            toast.error("An error occurred");
        } finally {
            setIsUpdating(false);
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
                        onClick={() => handleBulkAction('APPROVE')}
                        disabled={selected.size === 0 || isUpdating}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-sm shadow-sm transition-all disabled:opacity-50 disabled:scale-100 hover:scale-105"
                    >
                        {isUpdating ? 'Updating...' : `Approve & Send to Kitchen`}
                    </button>
                </div>
            </div>

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
                                                {order.customer.name}
                                            </h4>
                                            <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 text-[10px] font-bold uppercase rounded-md">
                                                {order.customer.type}
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
