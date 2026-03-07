"use client";

import { useState } from 'react';
import { ChefHat, Printer, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

interface Order {
    id: string;
    customer?: {
        name?: string;
        type?: string;
    };
    created_at: string;
    items: {
        quantity: number;
        production_status?: string;
        bundle?: { id: string; name: string; sku: string };
    }[];
}

interface InProductionAreaProps {
    orders: Order[];
    onRefresh: () => void;
}

export default function InProductionArea({ orders, onRefresh }: InProductionAreaProps) {
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const handleMarkReady = async (orderId?: string) => {
        const ids = orderId ? [orderId] : Array.from(selected);
        if (ids.length === 0) return;

        if (!confirm(`Mark ${ids.length} orders as Ready to Ship?`)) return;

        try {
            const res = await fetch('/api/orders/bulk-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderIds: ids,
                    status: 'READY_TO_SHIP'
                })
            });

            if (res.ok) {
                toast.success("Orders Marked Ready to Ship");
                setSelected(new Set());
                onRefresh();
            } else {
                toast.error("Failed to update status");
            }
        } catch (e) {
            toast.error("An error occurred");
        }
    };

    if (!orders || orders.length === 0) {
        return null;
    }

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <div className="flex justify-between items-center bg-white dark:bg-slate-800 p-6 rounded-3xl border border-emerald-200 dark:border-emerald-900/30 shadow-sm">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 rounded-xl flex items-center justify-center">
                        <ChefHat size={20} />
                    </div>
                    <div>
                        <h2 className="text-xl font-black text-slate-900 dark:text-white">In Production</h2>
                        <p className="text-slate-500 font-medium">{orders.length} orders cooking right now</p>
                    </div>
                </div>
                <div className="flex gap-2">
                    {selected.size > 0 && (
                        <button
                            onClick={() => handleMarkReady()}
                            className="bg-emerald-600 text-white px-4 py-2 rounded-xl font-bold shadow-lg hover:bg-emerald-700 transition-colors"
                        >
                            Mark {selected.size} Ready
                        </button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
                {orders.map(order => (
                    <div key={order.id} className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-emerald-200 dark:border-emerald-800/50 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-start gap-4 flex-1">
                            <div className="pt-1">
                                <input
                                    type="checkbox"
                                    checked={selected.has(order.id)}
                                    onChange={() => {
                                        const next = new Set(selected);
                                        if (next.has(order.id)) next.delete(order.id);
                                        else next.add(order.id);
                                        setSelected(next);
                                    }}
                                    className="w-5 h-5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                />
                            </div>
                            <div className="flex-1">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h4 className="font-black text-slate-900 dark:text-white text-lg">
                                                {order.customer?.name || "Retail Order"}
                                            </h4>
                                            <span className="text-xs uppercase font-bold text-slate-400 bg-slate-100 dark:bg-slate-700/50 px-2 py-1 rounded-md">
                                                {order.customer?.type || 'N/A'}
                                            </span>
                                        </div>
                                        <p className="text-xs font-bold text-slate-400">
                                            Started {format(new Date(order.created_at), 'MMM d')} • {order.id.slice(0, 8)}
                                        </p>
                                    </div>
                                </div>

                                <div className="mt-3 flex flex-wrap gap-2">
                                    {order.items.filter(i => i.production_status === 'IN_PRODUCTION').map((item, idx) => (
                                        <span key={idx} className="px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-2 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                                            {item.quantity}x {item.bundle?.name || 'Unknown Bundle'}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="flex gap-2 w-full md:w-auto mt-4 md:mt-0 pt-4 md:pt-0 border-t border-slate-100 dark:border-slate-700 md:border-t-0">
                            <button
                                onClick={() => handleMarkReady(order.id)}
                                className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl font-bold transition-colors"
                            >
                                <CheckCircle2 size={16} />
                                Ready to Ship
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
