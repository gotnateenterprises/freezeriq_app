"use client";

import React, { useState, useMemo } from 'react';
import { CheckCircle2, Circle, Mail, Phone, Loader2, Expand, Shrink } from 'lucide-react';
import { toast } from 'sonner';

export default function LiveTallySheet({ orders, availableBundles, token, onUpdate }: { orders: any[], availableBundles: any[], token: string, onUpdate: () => void }) {
    const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
    const [isExpanded, setIsExpanded] = useState(false);

    // Filter available bundles to unique serving tiers if needed, or by name
    const groupedBundles = React.useMemo(() => {
        const unique = new Map<string, any>();
        availableBundles.forEach(b => {
            // Basic deduplication if needed
            if (!unique.has(b.id)) unique.set(b.id, b);
        });
        return Array.from(unique.values()).sort((a, b) => b.price - a.price);
    }, [availableBundles]);

    const handlePatch = async (orderId: string, field: string, value: any) => {
        setUpdatingIds(prev => new Set(prev).add(orderId));
        try {
            const res = await fetch(`/api/coordinator/${token}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderId,
                    updates: { [field]: value }
                })
            });

            if (res.ok) {
                toast.success('Updated successfully', { id: `tally-${orderId}`, duration: 2000 });
                onUpdate(); // Trigger a data refresh from parent
            } else {
                toast.error('Failed to update');
            }
        } catch (e) {
            toast.error('Network error');
        } finally {
            setUpdatingIds(prev => {
                const next = new Set(prev);
                next.delete(orderId);
                return next;
            });
        }
    };

    return (
        <div className={`bg-white shadow-xl shadow-indigo-500/5 overflow-hidden print:shadow-none print:border-none transition-all duration-300 ${isExpanded
                ? 'fixed inset-0 z-50 rounded-none overflow-y-auto w-full h-full'
                : 'rounded-[2rem] border border-slate-100'
            }`}>
            <div className="p-6 border-b border-slate-100 flex justify-between items-center print:hidden sticky top-0 bg-white z-20">
                <div>
                    <h2 className="text-xl font-black text-slate-900">Live Tally Spreadsheet</h2>
                    <p className="text-sm font-medium text-slate-500">Track incoming orders, check off payments, and manage pickups.</p>
                </div>
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="p-3 bg-slate-50 hover:bg-slate-100 text-slate-500 rounded-xl transition-colors shrink-0"
                    title={isExpanded ? "Collapse View" : "Expand to Full Screen"}
                >
                    {isExpanded ? <Shrink size={20} /> : <Expand size={20} />}
                </button>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead>
                        <tr className="bg-slate-50 border-b border-slate-100 text-[10px] uppercase font-black tracking-widest text-slate-500">
                            <th className="py-4 px-4 sticky left-0 bg-slate-50 z-10 w-48">Purchaser Name</th>
                            <th className="py-4 px-4">Contact Info</th>
                            {/* Dynamic Bundle Columns */}
                            {groupedBundles.map(bundle => (
                                <th key={bundle.id} className="py-4 px-4 text-center">
                                    <div className="truncate max-w-[120px] text-indigo-700">{bundle.name}</div>
                                    <div className="text-[9px] opacity-70">({bundle.serving_tier === 'family' ? 'Family Size' : 'Serves 2'})</div>
                                </th>
                            ))}
                            <th className="py-4 px-4 text-center border-l border-slate-200">Total Sets</th>
                            <th className="py-4 px-4 text-right">Total Cost</th>
                            <th className="py-4 px-4 text-center border-l border-slate-200">Paid (Y/N)</th>
                            <th className="py-4 px-4 w-32">Check #</th>
                            <th className="py-4 px-4 text-center">Picked Up</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-medium">
                        {(!orders || orders.length === 0) && (
                            <tr>
                                <td colSpan={6 + groupedBundles.length} className="py-12 px-4 text-center">
                                    <p className="text-slate-400 font-bold italic">No orders yet. Add your first offline order, or wait for sales to roll in!</p>
                                </td>
                            </tr>
                        )}
                        {orders.map(order => {
                            const isUpdating = updatingIds.has(order.id);

                            // Calculate total sets across all items for this order
                            const totalSets = (order.items || []).reduce((sum: number, item: any) => sum + item.quantity, 0);

                            return (
                                <tr key={order.id} className={`hover:bg-slate-50/50 transition-colors ${isUpdating ? 'opacity-50' : ''}`}>
                                    <td className="py-3 px-4 font-bold text-slate-900 sticky left-0 bg-inherit z-10">
                                        {order.customer_name || 'Anonymous'}
                                        {order.source === 'manual' && <span className="ml-2 text-[9px] bg-amber-100 text-amber-700 font-black px-1.5 py-0.5 rounded-full uppercase">Offline</span>}
                                    </td>

                                    <td className="py-3 px-4 text-xs text-slate-500">
                                        {order.customer_phone && (
                                            <div className="flex items-center gap-1.5 mb-1"><Phone size={12} className="text-slate-400" /> {order.customer_phone}</div>
                                        )}
                                        {order.customer_email && (
                                            <div className="flex items-center gap-1.5"><Mail size={12} className="text-slate-400" /> {order.customer_email}</div>
                                        )}
                                        {!order.customer_phone && !order.customer_email && <span className="italic opacity-50">N/A</span>}
                                    </td>

                                    {/* Dynamic Bundle Quantity Cells */}
                                    {groupedBundles.map(bundle => {
                                        // Find if this order has this specific bundle
                                        const matchingItem = (order.items || []).find((i: any) => i.bundle_id === bundle.id);
                                        const qty = matchingItem ? matchingItem.quantity : 0;

                                        return (
                                            <td key={bundle.id} className="py-3 px-4 text-center font-black">
                                                {qty > 0 ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-indigo-50 text-indigo-700">{qty}</span> : <span className="text-slate-200">-</span>}
                                            </td>
                                        );
                                    })}

                                    <td className="py-3 px-4 text-center font-black border-l border-slate-200 text-slate-700">
                                        {totalSets > 0 ? totalSets : '-'}
                                    </td>

                                    <td className="py-3 px-4 text-right font-black text-slate-900">
                                        ${Number(order.total_amount).toFixed(2)}
                                    </td>

                                    {/* Coordinator Tracking Toggles */}
                                    <td className="py-3 px-4 text-center border-l border-slate-200">
                                        <button
                                            onClick={() => handlePatch(order.id, 'coordinator_paid', !order.coordinator_paid)}
                                            disabled={isUpdating}
                                            className="focus:outline-none disabled:opacity-50"
                                        >
                                            {order.coordinator_paid
                                                ? <CheckCircle2 className="text-emerald-500 fill-emerald-50 inline-block" size={24} />
                                                : <Circle className="text-slate-300 hover:text-emerald-500 transition-colors inline-block" size={24} />}
                                        </button>
                                    </td>

                                    <td className="py-3 px-4">
                                        <input
                                            type="text"
                                            defaultValue={order.coordinator_check || ''}
                                            placeholder="Check #"
                                            onBlur={(e) => {
                                                if (e.target.value !== (order.coordinator_check || '')) {
                                                    handlePatch(order.id, 'coordinator_check', e.target.value);
                                                }
                                            }}
                                            disabled={isUpdating}
                                            className="w-full bg-transparent border-b border-slate-200 focus:border-indigo-500 outline-none px-1 py-1 text-xs font-bold text-slate-700 disabled:opacity-50"
                                        />
                                    </td>

                                    <td className="py-3 px-4 text-center">
                                        <button
                                            onClick={() => handlePatch(order.id, 'coordinator_picked_up', !order.coordinator_picked_up)}
                                            disabled={isUpdating}
                                            className="focus:outline-none disabled:opacity-50"
                                        >
                                            {order.coordinator_picked_up
                                                ? <CheckCircle2 className="text-indigo-600 fill-indigo-50 inline-block" size={24} />
                                                : <Circle className="text-slate-300 hover:text-indigo-600 transition-colors inline-block" size={24} />}
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Aggregated Totals Row */}
            <div className="bg-slate-50 border-t border-slate-200 p-4 font-black flex items-center justify-between print:bg-transparent print:border-slate-800">
                <div className="text-sm uppercase tracking-widest text-slate-500">Campaign Totals</div>
                <div className="flex gap-8 text-lg">
                    <span>{orders.length} <span className="text-sm font-medium text-slate-400">Orders</span></span>
                    <span className="text-emerald-600">${orders.reduce((sum, o) => sum + Number(o.total_amount), 0).toFixed(2)} <span className="text-sm font-medium text-emerald-600/50">Revenue</span></span>
                </div>
            </div>
        </div>
    );
}
