"use client";

import { useState } from 'react';
import { RefreshCw, Printer, ChefHat, CheckSquare, ArrowRight, CheckCircle2 } from 'lucide-react';
import { toFraction } from '@/lib/unit_converter';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';

interface PrepItem {
    bundle_id: string;
    bundle_name: string;
    sku: string;
    total_quantity: number;
    order_count: number;
    status: 'APPROVED' | 'IN_PRODUCTION';
    recipes: { id: string, name: string, quantity: number }[];
}

interface PrepListProps {
    items: any[]; // Raw items from API
    onRefresh: () => void;
}

export default function PrepList({ items, onRefresh }: PrepListProps) {
    const router = useRouter();
    const { data: session } = useSession() as { data: any };
    const [isPrinting, setIsPrinting] = useState(false);

    // Group items by status
    const groups = items.reduce((acc, item) => {
        const s = item.status || 'APPROVED';
        if (!acc[s]) acc[s] = [];
        acc[s].push(item);
        return acc;
    }, {} as Record<string, PrepItem[]>);

    const approvedItems = groups['APPROVED'] || [];
    const productionItems = groups['IN_PRODUCTION'] || [];

    const handlePrint = async () => {
        setIsPrinting(true);
        setTimeout(() => {
            window.print();
            setIsPrinting(false);
        }, 500);
    };

    const handlePrintLabels = (item: PrepItem) => {
        if (!session?.user?.businessId) {
            toast.error("Session not loaded");
            return;
        }

        if (!item.recipes || !Array.isArray(item.recipes)) {
            console.error("❌ Label Print Error: No recipes found for bundle", item);
            toast.error("No recipe data found for this bundle.");
            return;
        }

        const batch = {
            name: `Production: ${item.bundle_name}`,
            items: item.recipes.map(r => ({
                id: r.id,
                name: r.name,
                qty: item.total_quantity * r.quantity,
                unit: 'ea',
                copies: item.total_quantity * r.quantity // This helps the batch print page
            }))
        };

        localStorage.setItem(`${session.user.businessId}_printBatch`, JSON.stringify(batch));
        router.push('/production/print-batch');
    };

    const handleUpdateStatus = async (bundleId: string, currentStatus: string, newStatus: string) => {
        const action = newStatus === 'IN_PRODUCTION' ? 'Start Production' : 'Complete Production';
        if (!confirm(`${action} for this bundle?`)) return;

        try {
            const res = await fetch('/api/orders/batch-update-by-bundle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    bundleId,
                    currentStatus,
                    newStatus
                })
            });

            if (res.ok) {
                toast.success("Status Updated");
                onRefresh();
            } else {
                toast.error("Failed to update");
            }
        } catch (e) {
            toast.error("An error occurred");
        }
    };

    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 text-center animate-in fade-in">
                <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mb-4 text-amber-600">
                    <ChefHat size={32} />
                </div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white">Nothing to Prep</h3>
                <p className="text-slate-500 max-w-xs mt-2">Approve orders from the Holding Area to populate the prep list.</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
            {/* Header / Print */}
            <div className="flex justify-between items-center bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm print:hidden">
                <div>
                    <h2 className="text-2xl font-black text-slate-900 dark:text-white">Kitchen Prep List</h2>
                    <p className="text-slate-500 font-medium">{items.reduce((acc, i) => acc + i.total_quantity, 0)} total units active</p>
                </div>
                <button
                    onClick={handlePrint}
                    className="flex items-center gap-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-3 rounded-2xl font-bold hover:bg-slate-800 transition-colors shadow-lg shadow-slate-200 dark:shadow-none"
                >
                    <Printer size={20} />
                    Print Sheet
                </button>
            </div>

            {/* Section 1: To Prep (APPROVED) */}
            {approvedItems.length > 0 && (
                <div className="space-y-4">
                    <h3 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
                        <div className="w-2 h-6 bg-amber-500 rounded-full" />
                        To Prep
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 print:grid-cols-2 print:gap-4">
                        {approvedItems.map((item: PrepItem) => (
                            <div key={item.bundle_id} className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm relative overflow-hidden group hover:border-amber-200 dark:hover:border-amber-900/50 transition-colors print:break-inside-avoid print:border-slate-300">
                                <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                                    <ChefHat size={64} className="text-amber-500 transform rotate-12" />
                                </div>
                                <div className="relative z-10">
                                    <div className="flex justify-between items-start mb-4">
                                        <span className="px-3 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg text-xs font-black uppercase tracking-widest">
                                            {item.sku}
                                        </span>
                                        <span className="text-xs font-bold text-slate-400">
                                            {item.order_count} Orders
                                        </span>
                                    </div>
                                    <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2 leading-tight">
                                        {item.bundle_name}
                                    </h3>
                                    <div className="flex items-end gap-2 mb-6">
                                        <span className="text-4xl font-black text-amber-600 dark:text-amber-500">
                                            {item.total_quantity}
                                        </span>
                                        <span className="text-lg font-bold text-slate-400 mb-1">units</span>
                                    </div>
                                    <button
                                        onClick={() => handleUpdateStatus(item.bundle_id, 'APPROVED' as any, 'IN_PRODUCTION' as any)}
                                        className="w-full flex items-center justify-center gap-2 bg-slate-100 dark:bg-slate-700 hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-600 text-slate-600 dark:text-slate-300 py-3 rounded-xl font-bold transition-all print:hidden group-hover:bg-emerald-50 dark:group-hover:bg-emerald-900/20 group-hover:text-emerald-600 dark:group-hover:text-emerald-400"
                                    >
                                        <ArrowRight size={18} />
                                        Start Production
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Section 2: In Production */}
            {productionItems.length > 0 && (
                <div className="space-y-4">
                    <h3 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
                        <div className="w-2 h-6 bg-emerald-500 rounded-full" />
                        In Production
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                        {productionItems.map((item: PrepItem) => (
                            <div key={item.bundle_id} className="bg-slate-50 dark:bg-slate-900/50 p-6 rounded-3xl border border-emerald-200 dark:border-emerald-900/30 shadow-sm relative overflow-hidden">
                                <div className="relative z-10">
                                    <div className="flex justify-between items-start mb-4">
                                        <span className="px-3 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg text-xs font-black uppercase tracking-widest">
                                            {item.sku}
                                        </span>
                                        <span className="text-xs font-bold text-emerald-600/60">
                                            Cooking Now
                                        </span>
                                    </div>
                                    <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2 leading-tight">
                                        {item.bundle_name}
                                    </h3>
                                    <div className="flex gap-2 mb-6">
                                        <div className="flex-1">
                                            <span className="text-4xl font-black text-emerald-600 dark:text-emerald-500">
                                                {item.total_quantity}
                                            </span>
                                            <span className="text-lg font-bold text-slate-400 ml-2">units</span>
                                        </div>
                                        <button
                                            onClick={() => handlePrintLabels(item)}
                                            className="p-3 bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all shadow-sm"
                                            title="Print Labels for all meals in this bundle"
                                        >
                                            <Printer size={20} />
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => handleUpdateStatus(item.bundle_id, 'IN_PRODUCTION' as any, 'completed')}
                                        className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white hover:bg-emerald-700 py-3 rounded-xl font-bold transition-all shadow-lg shadow-emerald-200 dark:shadow-none"
                                    >
                                        <CheckCircle2 size={18} />
                                        Mark Done
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
