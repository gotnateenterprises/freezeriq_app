"use client";

import { useState } from 'react';
import { Package, Truck, Printer, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

interface Order {
    id: string;
    customer?: {
        name?: string;
        type?: string;
        address?: string;
        city?: string;
        match_zip?: string;
        delivery_address?: string;
    };
    created_at: string;
    items: {
        quantity: number;
        variant_size?: string;
        production_status?: string;
        bundle?: { id: string; name: string; sku: string };
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

    const handleManifestAndComplete = async (orderId: string) => {
        if (!confirm('Mark order as COMPLETED and print manifest?')) return;

        try {
            const res = await fetch('/api/orders/bulk-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderIds: [orderId],
                    status: 'COMPLETED'
                })
            });

            if (res.ok) {
                onRefresh(); // Refresh before routing so it's gone when user hits back
                router.push(`/delivery/print-manifest?orderId=${orderId}`);
            } else {
                toast.error("Failed to update status");
            }
        } catch (e) {
            toast.error("An error occurred");
        }
    };

    const handlePrintLabel = (order: Order) => {
        // Construct label URL - Using existing /labels route or similar logic
        // Simple heuristic: Take the first bundle to generate a label preview
        if (!order.items || order.items.length === 0) return;
        const item = order.items.find(i => i.bundle);
        if (!item || !item.bundle) return;

        const params = new URLSearchParams({
            recipeId: item.bundle.id,
            qty: item.quantity.toString(),
            unit: 'ea',
            bundleHint: item.bundle.name,
            printQty: item.quantity.toString(),
            sku: item.bundle.sku,
            customer: order.customer?.name || 'Unknown',
            address: order.customer?.delivery_address || order.customer?.address || '',
            orderId: order.id.slice(0, 8)
        });

        router.push(`/labels?${params.toString()}`);
    };

    if (!orders || orders.length === 0) {
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
                                    className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                            </div>
                            <div className="flex-1">
                                <div className="flex justify-between items-start">
                                    <h4 className="font-black text-slate-900 dark:text-white text-lg">{order.customer?.name || "Unknown Customer"}</h4>

                                    {/* Box Calculator Badges */}
                                    <div className="flex gap-2">
                                        {(() => {
                                            let familyCount = 0;
                                            let smallCount = 0;
                                            (order.items || []).forEach(item => {
                                                const bundleName = item.bundle?.name || '';
                                                const isSmall = item.variant_size === 'serves_2' || bundleName.toLowerCase().includes('serves 2');
                                                if (isSmall) {
                                                    smallCount += item.quantity;
                                                } else {
                                                    familyCount += item.quantity;
                                                }
                                            });
                                            const largeBoxes = familyCount;
                                            const smallBoxes = smallCount;

                                            return (
                                                <>
                                                    {largeBoxes > 0 && (
                                                        <span className="px-2 py-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 rounded-md text-xs font-bold whitespace-nowrap">
                                                            📦 {largeBoxes} Large Box{largeBoxes > 1 ? 'es' : ''}
                                                        </span>
                                                    )}
                                                    {smallBoxes > 0 && (
                                                        <span className="px-2 py-1 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 rounded-md text-xs font-bold whitespace-nowrap">
                                                            📦 {smallBoxes} Small Box{smallBoxes > 1 ? 'es' : ''}
                                                        </span>
                                                    )}
                                                </>
                                            );
                                        })()}
                                    </div>
                                </div>
                                <div className="text-sm text-slate-500 flex flex-col">
                                    <span>#{order.id.slice(0, 8)} • {order.created_at ? format(new Date(order.created_at), 'MMM d') : ''}</span>
                                    {(order.customer?.delivery_address || order.customer?.address) && (
                                        <span className="font-medium text-slate-600 dark:text-slate-400 mt-1">
                                            {order.customer?.delivery_address || order.customer?.address}{order.customer?.city ? `, ${order.customer.city}` : ''} {order.customer?.match_zip || ''}
                                        </span>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2 mt-3">
                                    {(order.items || []).map((item, i) => (
                                        <div key={i} className="flex justify-between items-center bg-slate-50 dark:bg-slate-900/50 p-2 rounded-lg border border-slate-100 dark:border-slate-700/50">
                                            <span className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                                {item.quantity}x {item.bundle?.name || 'Unknown Bundle'}
                                                {item.bundle?.sku && <span className="ml-2 text-xs text-slate-400 font-normal">({item.bundle.sku})</span>}
                                            </span>
                                            <span className={`text-[10px] uppercase font-black px-2 py-1 rounded-md ${item.production_status === 'DELIVERED'
                                                ? 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                                                : item.production_status === 'READY_TO_SHIP'
                                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                                }`}>
                                                {(item.production_status === 'DELIVERED' || item.production_status === 'READY_TO_SHIP') ? 'STAGED' : (item.production_status?.replace(/_/g, ' ') || 'PENDING')}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col items-center gap-2 self-end md:self-stretch md:justify-end md:pl-4 md:border-l border-slate-100 dark:border-slate-700">
                            {/* Updated buttons for phase 3 */}
                            <button
                                onClick={() => router.push(`/delivery/print-packing-slips?orderId=${order.id}`)}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2 text-slate-600 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600 rounded-xl font-bold transition-colors"
                            >
                                <Printer size={16} />
                                Packing Slip
                            </button>
                            <button
                                onClick={() => handleManifestAndComplete(order.id)}
                                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white dark:bg-indigo-900/20 dark:hover:bg-indigo-600 rounded-xl font-bold transition-colors whitespace-nowrap"
                            >
                                <Truck size={18} />
                                Print Manifest & Complete
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
