"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Truck, ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';

interface OrderItem {
    bundle: {
        name: string;
        serving_tier: string;
    };
    quantity: number;
}

interface Order {
    id: string;
    customer_name: string;
    organization?: { name: string };
    delivery_sequence: number;
    items: OrderItem[];
    // ... other fields
}

export default function PrintManifestPage() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [loading, setLoading] = useState(true);
    const [logo, setLogo] = useState<string | null>(null);
    const date = new Date().toLocaleDateString();

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch Orders
                const ordersRes = await fetch('/api/orders?status=pending,production_ready');
                const ordersData = await ordersRes.json();
                const sorted = ordersData.sort((a: any, b: any) =>
                    (a.delivery_sequence || 999) - (b.delivery_sequence || 999)
                );
                setOrders(sorted);

                // Fetch Logo
                const bizRes = await fetch('/api/business');
                if (bizRes.ok) {
                    const bizData = await bizRes.json();
                    if (bizData.logo_url) setLogo(bizData.logo_url);
                }
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, []);

    if (loading) return <div className="p-12 text-center">Loading manifest...</div>;

    // Calculate Totals
    let totalLarge = 0;
    let totalSmall = 0;

    const manifestRows = orders.map((order, index) => {
        const customerName = order.customer_name || order.organization?.name || 'Unknown';
        const largeCount = order.items.reduce((acc, item) => {
            const isLarge = item.bundle?.name.toLowerCase().includes('family') || item.bundle?.serving_tier?.toLowerCase() === 'family';
            return acc + (isLarge ? item.quantity : 0);
        }, 0);
        const smallCount = order.items.reduce((acc, item) => {
            const isLarge = item.bundle?.name.toLowerCase().includes('family') || item.bundle?.serving_tier?.toLowerCase() === 'family';
            return acc + (isLarge ? 0 : item.quantity);
        }, 0);

        totalLarge += largeCount;
        totalSmall += smallCount;

        const bundlesText = order.items.map(i => `${i.quantity}x ${i.bundle?.name}`).join(', ');

        return {
            index: index + 1,
            customer: customerName,
            details: bundlesText,
            large: largeCount,
            small: smallCount
        };
    });

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 print:bg-white p-8">
            {/* No-Print Header */}
            <div className="print:hidden flex justify-between items-center mb-8 max-w-5xl mx-auto">
                <Link href="/delivery" className="flex items-center gap-2 text-slate-500 hover:text-slate-700">
                    <ArrowLeft size={16} /> Back to Dashboard
                </Link>
                <button
                    onClick={() => window.print()}
                    className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-indigo-700 flex items-center gap-2"
                >
                    <Printer size={18} /> Print Manifest
                </button>
            </div>

            {/* Print Sheet */}
            <div className="bg-white shadow-xl print:shadow-none max-w-5xl mx-auto p-8 min-h-[11in] relative">
                <div className="flex justify-between items-end border-b-4 border-black pb-4 mb-6">
                    <div className="flex flex-col gap-4">
                        {logo && (
                            <div className="h-16 relative w-48">
                                <img src={logo} alt="Logo" className="h-full w-full object-contain object-left" />
                            </div>
                        )}
                        <div>
                            <h1 className="text-4xl font-black uppercase tracking-tighter">Shipping Manifest</h1>
                            <p className="text-xl font-bold text-slate-500 mt-1">Delivery Run: {date}</p>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="font-bold text-lg">Total Boxes</div>
                        <div className="text-sm">Large (Family): <span className="font-bold text-lg">{totalLarge}</span></div>
                        <div className="text-sm">Small (Std): <span className="font-bold text-lg">{totalSmall}</span></div>
                    </div>
                </div>

                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="border-b-2 border-black text-sm uppercase">
                            <th className="py-2 w-12 text-center">#</th>
                            <th className="py-2 w-1/4">Customer</th>
                            <th className="py-2">Bundles (Contents)</th>
                            <th className="py-2 w-20 text-center">Lg Box</th>
                            <th className="py-2 w-20 text-center">Sm Box</th>
                        </tr>
                    </thead>
                    <tbody className="text-sm">
                        {manifestRows.map((row) => (
                            <tr key={row.index} className="border-b border-slate-300">
                                <td className="py-3 text-center font-bold text-slate-500">{row.index}</td>
                                <td className="py-3 font-bold">{row.customer}</td>
                                <td className="py-3 text-slate-600">{row.details}</td>
                                <td className="py-3 text-center font-mono font-bold text-lg">{row.large || '-'}</td>
                                <td className="py-3 text-center font-mono font-bold text-lg">{row.small || '-'}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-black">
                            <td colSpan={3} className="py-3 text-right font-black uppercase text-sm">Totals:</td>
                            <td className="py-3 text-center font-mono font-black text-xl">{totalLarge}</td>
                            <td className="py-3 text-center font-mono font-black text-xl">{totalSmall}</td>
                        </tr>
                    </tfoot>
                </table>

                <div className="absolute bottom-8 left-8 right-8 pt-8 border-t-2 border-black flex justify-between items-end">
                    <div className="flex gap-16">
                        <div>
                            <p className="font-bold">Driver Signature:</p>
                            <div className="border-b border-black w-64 h-8 mt-2"></div>
                        </div>
                        <div>
                            <p className="font-bold">Fundraiser Manager Signature:</p>
                            <div className="border-b border-black w-64 h-8 mt-2"></div>
                        </div>
                        <div>
                            <p className="font-bold">Date:</p>
                            <div className="border-b border-black w-32 h-8 mt-2"></div>
                        </div>
                    </div>
                    <div className="text-right text-xs text-slate-400 pb-2">
                        Delivery Manifest
                    </div>
                </div>
            </div>
        </div>
    );
}
