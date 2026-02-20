"use client";

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { ArrowLeft, ShoppingCart, CheckCircle, ExternalLink, Printer, Trash2, RefreshCw } from 'lucide-react';

interface ShoppingItem {
    id: string; // key
    name: string;
    qty: number;
    unit: string;
    onHand: number;
    toBuy: number;
    costPerUnit: number;
    supplier?: string;
    supplierUrl?: string;
    isChecked: boolean;
    purchaseCost?: number;
    purchaseUnit?: string;
    purchaseQuantity?: number; // Quantity per purchase unit (e.g. 32 oz per Case)
    casesNeeded?: number;
}

export default function ShoppingList() {
    const { data: session } = useSession() as { data: any };
    const businessId = session?.user?.businessId;

    const [items, setItems] = useState<ShoppingItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all');

    // Load Data
    useEffect(() => {
        if (!businessId) return;

        const loadList = () => {
            try {
                const savedResult = localStorage.getItem(`${businessId}_productionResult`);
                const savedChecked = localStorage.getItem(`${businessId}_shoppingChecked`);
                const checkedSet = new Set(savedChecked ? JSON.parse(savedChecked) : []);

                if (savedResult) {
                    const result = JSON.parse(savedResult);
                    const rawIngredients = result.rawIngredients || {};

                    const list: ShoppingItem[] = Object.entries(rawIngredients).map(([key, val]: [string, any]) => {
                        const needed = val.qty || 0;
                        const onHand = val.onHand || 0;
                        const toBuy = Math.max(0, needed - onHand);
                        const purchaseQuantity = val.purchaseQuantity;
                        const casesNeeded = (purchaseQuantity && purchaseQuantity > 0) ? (toBuy / purchaseQuantity) : undefined;

                        return {
                            id: key,
                            name: val.displayName || key,
                            qty: needed,
                            unit: val.unit,
                            onHand: onHand,
                            toBuy: toBuy,
                            costPerUnit: val.costPerUnit || 0,
                            supplier: val.supplier || 'Unknown',
                            supplierUrl: val.supplierUrl,
                            isChecked: checkedSet.has(key),
                            purchaseCost: val.purchaseCost,
                            purchaseUnit: val.purchaseUnit,
                            purchaseQuantity: purchaseQuantity,
                            casesNeeded: casesNeeded
                        };
                    }).filter(i => i.toBuy > 0); // Only show what we need to buy? Or show all? Usually just to buy.

                    // Group/Sort?
                    list.sort((a, b) => (a.supplier || '').localeCompare(b.supplier || '') || a.name.localeCompare(b.name));

                    setItems(list);
                }
            } catch (e) {
                console.error("Failed to load shopping list", e);
            } finally {
                setIsLoading(false);
            }
        };

        loadList();
    }, [businessId]);

    // Handle Check
    const toggleCheck = (id: string) => {
        const newItems = items.map(i => i.id === id ? { ...i, isChecked: !i.isChecked } : i);
        setItems(newItems);

        // Update Local Storage
        const checked = newItems.filter(i => i.isChecked).map(i => i.id);
        if (businessId) {
            localStorage.setItem(`${businessId}_shoppingChecked`, JSON.stringify(checked));

            // Update Total for Dashboard
            // Logic: Total Cost of *Pending* items? or Total Cost of *All* items?
            // Dashboard says "Est. Cost". Usually implies total cost of the plan.
            // Let's sum up total "To Buy" cost.
            const totalCost = newItems.reduce((sum, i) => sum + (i.toBuy * i.costPerUnit), 0);
            localStorage.setItem(`${businessId}_shoppingListTotal`, totalCost.toString());

            // Trigger storage event for Dashboard to pick up
            window.dispatchEvent(new Event('storage'));
        }
    };

    // Calculate Totals
    const totalEstCost = items.reduce((sum, i) => sum + (i.toBuy * i.costPerUnit), 0);
    const checkedCount = items.filter(i => i.isChecked).length;

    // Filter
    const filteredItems = items.filter(i => {
        if (filter === 'todo') return !i.isChecked;
        if (filter === 'done') return i.isChecked;
        return true;
    });

    // Group by Supplier
    const groupedItems: Record<string, ShoppingItem[]> = {};
    filteredItems.forEach(i => {
        const supplier = i.supplier || 'Unassigned';
        if (!groupedItems[supplier]) groupedItems[supplier] = [];
        groupedItems[supplier].push(i);
    });

    if (isLoading) return <div className="p-12 text-center">Loading Shopping List...</div>;

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pb-20 print:bg-white">
            <div className="max-w-5xl mx-auto p-4 md:p-8">
                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8 print:hidden">
                    <div className="flex items-center gap-4">
                        <Link href="/production" className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                            <ArrowLeft size={20} className="text-slate-500" />
                        </Link>
                        <div>
                            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
                                <ShoppingCart className="text-indigo-600" />
                                Shopping List
                            </h1>
                            <p className="text-slate-500 font-medium">{items.length} Items to Buy • Est. Cost: ${totalEstCost.toFixed(2)}</p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={() => window.print()}
                            className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-300 transition-colors"
                        >
                            <Printer size={18} /> Print
                        </button>
                    </div>
                </div>

                {/* Filters */}
                <div className="flex gap-2 mb-6 print:hidden">
                    {(['all', 'todo', 'done'] as const).map(f => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={`px-4 py-1.5 rounded-full text-sm font-bold capitalize transition-colors ${filter === f
                                ? 'bg-indigo-600 text-white'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700'
                                }`}
                        >
                            {f} {f === 'done' ? `(${checkedCount})` : ''}
                        </button>
                    ))}
                </div>

                {/* List Content */}
                {items.length === 0 ? (
                    <div className="text-center py-20 bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 border-dashed">
                        <ShoppingCart size={48} className="mx-auto text-slate-300 mb-4" />
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white">List is Empty</h3>
                        <p className="text-slate-500">Go to Production to generate a plan based on orders.</p>
                        <Link href="/production" className="inline-block mt-4 text-indigo-600 font-bold hover:underline">
                            Go to Production Plan
                        </Link>
                    </div>
                ) : (
                    <div className="space-y-6">
                        {Object.entries(groupedItems).map(([supplier, groupItems]) => (
                            <div key={supplier} className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden break-inside-avoid">
                                <div className="bg-slate-50 dark:bg-slate-800/50 p-4 border-b border-slate-100 dark:border-slate-700/50 flex justify-between items-center">
                                    <h3 className="font-black text-lg text-slate-800 dark:text-slate-200">{supplier}</h3>
                                    <span className="text-xs font-bold bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-2 py-1 rounded">
                                        {groupItems.length} items
                                    </span>
                                </div>
                                <div className="divide-y divide-slate-50 dark:divide-slate-700/50">
                                    {groupItems.map(item => (
                                        <div
                                            key={item.id}
                                            className={`p-4 flex items-center gap-4 group transition-colors ${item.isChecked ? 'bg-slate-50/50 dark:bg-slate-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-700/20'
                                                }`}
                                        >
                                            <button
                                                onClick={() => toggleCheck(item.id)}
                                                className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${item.isChecked
                                                    ? 'bg-emerald-500 border-emerald-500 text-white'
                                                    : 'border-slate-300 dark:border-slate-600 hover:border-indigo-500'
                                                    }`}
                                            >
                                                {item.isChecked && <CheckCircle size={14} className="fill-current" />}
                                            </button>

                                            <div className="flex-1 min-w-0">
                                                <div className={`font-bold text-slate-900 dark:text-white truncate ${item.isChecked ? 'line-through text-slate-400' : ''}`}>
                                                    {item.name}
                                                </div>
                                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 font-mono mt-0.5">
                                                    <span className={item.toBuy > 0 ? "font-bold text-indigo-600 dark:text-indigo-400" : ""}>
                                                        Need: {item.toBuy.toFixed(2)} {item.unit}
                                                    </span>

                                                    {/* Case Calculator */}
                                                    {item.purchaseQuantity && item.purchaseQuantity > 0 && (
                                                        <span className="bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded border border-indigo-100 dark:border-indigo-800">
                                                            Avg: {(item.toBuy / item.purchaseQuantity).toFixed(2)} {item.purchaseUnit || 'cases'}
                                                        </span>
                                                    )}

                                                    {item.onHand > 0 && <span className="text-amber-600">• Have: {item.onHand} {item.unit}</span>}
                                                    {item.costPerUnit > 0 && <span>• ~${(item.toBuy * item.costPerUnit).toFixed(2)}</span>}
                                                </div>
                                            </div>

                                            {item.supplierUrl && (
                                                <a
                                                    href={item.supplierUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity print:hidden"
                                                    title="Open Supplier Link"
                                                >
                                                    <ExternalLink size={16} />
                                                </a>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Print Styles */}
            <style jsx global>{`
                @media print {
                    @page { margin: 0.5in; }
                    body { background: white; }
                    .print\\:hidden { display: none !important; }
                    .shadow-sm { box-shadow: none !important; }
                }
            `}</style>
        </div>
    );
}
