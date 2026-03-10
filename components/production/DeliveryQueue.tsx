"use client";

import { useState } from 'react';
import { Package, Truck, Printer, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

interface Order {
    id: string;
    customer: {
        name: string;
        type: string;
        delivery_address?: string;
    } | null;
    created_at: string;
    items: {
        quantity: number;
        bundle: { id: string; name: string; sku: string };
    }[];
}

interface DeliveryQueueProps {
    orders: Order[];
    onRefresh: () => void;
}

export default function DeliveryQueue({ orders, onRefresh }: DeliveryQueueProps) {
    const router = useRouter();
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const handleMarkDelivered = async (orderId?: string) => {
        const ids = orderId ? [orderId] : Array.from(selected);
        if (ids.length === 0) return;

        if (!confirm(`Mark ${ids.length} orders as Delivered?`)) return;

        try {
            const res = await fetch('/api/orders/bulk-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderIds: ids,
                    status: 'DELIVERED'
                })
            });

            if (res.ok) {
                toast.success("Orders Marked Delivered");
                setSelected(new Set());
                onRefresh();
            } else {
                toast.error("Failed to update status");
            }
        } catch (e) {
            toast.error("An error occurred");
        }
    };

    const handlePrintLabel = (order: Order) => {
        // Construct label URL - Using existing /labels route or similar logic
        // The /production/page.tsx had specific logic for this.
        // We'll redirect to /labels with params
        // Assuming we print one label per order-bundle? Or a shipping label?
        // Prompt says "Box Label Printing".
        // Let's assume we want to print a label for the order contents.

        // Simple heuristic: Take the first bundle to generate a label preview
        if (order.items.length === 0) return;
        const item = order.items[0];

        const params = new URLSearchParams({
            recipeId: item.bundle.id, // Using bundle ID as recipe ID proxy for label? check /labels
            qty: item.quantity.toString(),
            unit: 'ea',
            bundleHint: item.bundle.name,
            printQty: item.quantity.toString(),
            sku: item.bundle.sku,
            customer: order.customer?.name || 'Unknown',
            address: order.customer?.delivery_address || '',
            orderId: order.id.slice(0, 8)
        });

        router.push(`/labels?${params.toString()}`);
    };

    if (orders.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 text-center animate-in fade-in">
                <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-full flex items-center justify-center mb-4 text-slate-400">
                    <Package size={32} />
                </div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white">Ready to Ship</h3>
                <p className="text-slate-500 max-w-xs mt-2">Orders marked as Completed will appear here for final delivery.</p>
            </div>
        );
    }

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <div className="flex justify-between items-center bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <div>
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">Ready for Delivery</h2>
                    <p className="text-slate-500 font-medium">{orders.length} orders pending shipment</p>
                </div>
                <div className="flex gap-2">
                    {selected.size > 0 && (
                        <button
                            onClick={() => handleMarkDelivered()}
                            className="bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold shadow-lg hover:bg-indigo-700 transition-colors"
                        >
                            Mark {selected.size} Delivered
                        </button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
                {orders.map(order => (
                    <div key={order.id} className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-start gap-4">
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
                                    className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                            </div>
                            <div>
                                <h4 className="font-black text-slate-900 dark:text-white text-lg">{order.customer?.name || 'Unknown Customer'}</h4>
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
                                onClick={() => handlePrintLabel(order)}
                                className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                                title="Print Label"
                            >
                                <Printer size={20} />
                            </button>
                            <button
                                onClick={() => handleMarkDelivered(order.id)}
                                className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl font-bold hover:bg-emerald-500 hover:text-white transition-colors"
                            >
                                <Truck size={18} />
                                Send to Delivery
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
