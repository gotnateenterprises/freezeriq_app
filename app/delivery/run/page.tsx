"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Truck, MapPin, CheckCircle, ChevronDown, ChevronUp, AlertCircle, ArrowLeft } from 'lucide-react';
import SignaturePad from '@/components/SignaturePad';

interface OrderItem {
    bundle: {
        name: string;
        serving_tier: string;
    };
    quantity: number;
}

interface Order {
    id: string;
    external_id: string;
    customer_name: string;
    customer_phone?: string;
    delivery_address: string;
    delivery_sequence: number;
    status: string;
    items: OrderItem[];
    // @ts-ignore
    organization?: { name: string };
}

export default function MobileDeliveryRunPage() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
    const [signatureOrderId, setSignatureOrderId] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchOrders = async () => {
        try {
            setLoading(true);
            const res = await fetch('/api/orders?status=production_ready,READY_TO_SHIP');
            if (!res.ok) throw new Error("Failed to load delivery queue");
            const data = await res.json();

            // Sort by delivery sequence
            const sorted = data.sort((a: any, b: any) =>
                (a.delivery_sequence || 999) - (b.delivery_sequence || 999)
            );
            setOrders(sorted);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchOrders();
    }, []);

    const handleSaveSignature = async (orderId: string, signatureDataUrl: string) => {
        try {
            setSubmitting(true);
            const res = await fetch(`/api/orders`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: orderId,
                    status: 'delivered',
                    delivery_signature: signatureDataUrl
                })
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to mark delivered");
            }

            // Remove from list after successful delivery
            setOrders(prev => prev.filter(o => o.id !== orderId));
            setSignatureOrderId(null);
            setExpandedOrderId(null);
        } catch (err: any) {
            alert(err.message);
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-6 text-center text-rose-500 font-medium flex flex-col items-center gap-4">
                <AlertCircle size={48} />
                <p>{error}</p>
                <button onClick={fetchOrders} className="text-indigo-600 underline">Try Again</button>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-100 dark:bg-slate-900 pb-24">
            {/* Header */}
            <header className="bg-indigo-600 text-white p-4 sticky top-0 z-10 shadow-md">
                <div className="container mx-auto max-w-lg flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Link href="/delivery" className="p-2 -ml-2 hover:bg-white/10 rounded-full transition-colors">
                            <ArrowLeft size={24} />
                        </Link>
                        <h1 className="text-xl font-bold flex items-center gap-2">
                            <Truck size={24} />
                            Delivery Run
                        </h1>
                    </div>
                    <div className="bg-white/20 px-3 py-1 rounded-full text-sm font-bold">
                        {orders.length} Stops
                    </div>
                </div>
            </header>

            {/* List */}
            <main className="container mx-auto max-w-lg p-4 space-y-4">
                {orders.length === 0 ? (
                    <div className="text-center p-12 bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700">
                        <CheckCircle size={48} className="mx-auto text-emerald-500 mb-4" />
                        <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Run Complete!</h2>
                        <p className="text-slate-500">There are no remaining deliveries in your queue.</p>
                    </div>
                ) : (
                    orders.map((order, index) => {
                        const isExpanded = expandedOrderId === order.id;
                        const isSigning = signatureOrderId === order.id;
                        const customerName = order.customer_name || order.organization?.name || 'Unknown';

                        // Calc boxes
                        const largeCount = order.items.reduce((acc, item) => {
                            const isLarge = item.bundle?.name.toLowerCase().includes('family') || item.bundle?.serving_tier?.toLowerCase() === 'family';
                            return acc + (isLarge ? item.quantity : 0);
                        }, 0);
                        const smallCount = order.items.reduce((acc, item) => {
                            const isLarge = item.bundle?.name.toLowerCase().includes('family') || item.bundle?.serving_tier?.toLowerCase() === 'family';
                            return acc + (isLarge ? 0 : item.quantity);
                        }, 0);

                        return (
                            <div key={order.id} className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                                {/* Accordion Header */}
                                <div
                                    onClick={() => !isSigning && setExpandedOrderId(isExpanded ? null : order.id)}
                                    className={`p-4 flex items-start gap-4 cursor-pointer transition-colors ${isExpanded ? 'bg-indigo-50/50 dark:bg-indigo-900/10' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
                                >
                                    <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 flex items-center justify-center font-bold text-sm shrink-0 mt-1">
                                        {index + 1}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-bold text-lg text-slate-900 dark:text-white truncate">{customerName}</h3>
                                        <div className="text-slate-500 dark:text-slate-400 text-sm mt-1 line-clamp-2 pr-4">
                                            {order.delivery_address || 'No Address Provided'}
                                        </div>
                                    </div>
                                    <div className="shrink-0 pt-2 text-slate-400">
                                        {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                                    </div>
                                </div>

                                {/* Accordion Body */}
                                {isExpanded && (
                                    <div className="p-4 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80">

                                        {/* Address Link */}
                                        {order.delivery_address && (
                                            <a
                                                href={`https://maps.google.com/?q=${encodeURIComponent(order.delivery_address)}`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="mb-4 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-3 flex items-center justify-center gap-2 text-indigo-600 dark:text-indigo-400 font-bold hover:bg-indigo-50 transition-colors"
                                            >
                                                <MapPin size={18} /> Open in Maps
                                            </a>
                                        )}

                                        {/* Box Counts */}
                                        <div className="flex gap-4 mb-4">
                                            <div className="flex-1 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-700 text-center">
                                                <div className="text-2xl font-black text-slate-800 dark:text-white">{largeCount}</div>
                                                <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Lg Boxes</div>
                                            </div>
                                            <div className="flex-1 bg-white dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-700 text-center">
                                                <div className="text-2xl font-black text-slate-800 dark:text-white">{smallCount}</div>
                                                <div className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Sm Boxes</div>
                                            </div>
                                        </div>

                                        {/* Signature Pad OR Deliver Button */}
                                        <div className="mt-6">
                                            {isSigning ? (
                                                <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
                                                    <div className="text-sm font-bold text-slate-500 mb-2 uppercase tracking-wide">Customer Signature</div>
                                                    <SignaturePad
                                                        onSave={(sig) => handleSaveSignature(order.id, sig)}
                                                        onCancel={() => setSignatureOrderId(null)}
                                                    />
                                                    {submitting && <p className="text-center text-sm text-indigo-600 mt-3 font-medium animate-pulse">Saving delivery...</p>}
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => setSignatureOrderId(order.id)}
                                                    className="w-full bg-emerald-500 hover:bg-emerald-600 text-white p-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 shadow-sm transition-transform active:scale-95"
                                                >
                                                    <CheckCircle size={24} /> Mark as Delivered
                                                </button>
                                            )}
                                        </div>

                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </main>
        </div>
    );
}
