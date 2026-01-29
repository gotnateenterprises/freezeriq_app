
"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Package, Plus, ChevronRight, Search, Copy } from 'lucide-react';

export default function BundlesPage() {
    const [bundles, setBundles] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        fetchBundles();
    }, []);

    const fetchBundles = async () => {
        try {
            const res = await fetch('/api/bundles');
            if (res.ok) {
                const data = await res.json();
                setBundles(data);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8">
            <div className="flex justify-between items-end">
                <div>
                    <h1 className="text-3xl font-bold text-slate-900 dark:text-white text-adaptive">Bundle Builder</h1>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-1">Manage product bundles and meal kits.</p>
                </div>
                <Link
                    href="/bundles/new"
                    className="flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-600 text-white px-5 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/40 hover:-translate-y-0.5"
                >
                    <Plus size={18} />
                    New Bundle
                </Link>
            </div>

            {/* Actions Bar */}
            <div className="flex gap-4 items-center bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                <button
                    onClick={async () => {
                        const res = await fetch('/api/bundles?full=true');
                        const data = await res.json();
                        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `bundles_export_${new Date().toISOString().split('T')[0]}.json`;
                        a.click();
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg text-sm font-bold text-slate-700 dark:text-slate-300 transition-colors"
                >
                    Export JSON
                </button>
                <label className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg text-sm font-bold text-slate-700 dark:text-slate-300 transition-colors cursor-pointer">
                    Import JSON
                    <input
                        type="file"
                        accept=".json"
                        className="hidden"
                        onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;

                            if (!confirm("Importing will add new bundles. Existing SKUs will be skipped. Continue?")) return;

                            setIsLoading(true);
                            const reader = new FileReader();
                            reader.onload = async (event) => {
                                try {
                                    const json = JSON.parse(event.target?.result as string);
                                    const items = Array.isArray(json) ? json : [json];
                                    let success = 0;
                                    let skipped = 0;

                                    for (const item of items) {
                                        const res = await fetch('/api/bundles', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify(item)
                                        });
                                        if (res.ok) success++;
                                        else skipped++;
                                    }

                                    alert(`Import Complete!\nAdded: ${success}\nSkipped (Duplicate SKU): ${skipped}`);
                                    fetchBundles(); // Refresh
                                } catch (err) {
                                    alert("Invalid JSON File");
                                } finally {
                                    setIsLoading(false);
                                }
                            };
                            reader.readAsText(file);
                        }}
                    />
                </label>
            </div>

            {/* List */}
            <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="p-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 bg-adaptive flex items-center gap-3">
                    <Search size={18} className="text-slate-400 dark:text-slate-500" />
                    <input
                        className="bg-transparent outline-none text-sm w-full text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500"
                        placeholder="Search bundles by name or SKU..."
                    />
                </div>

                {isLoading ? (
                    <div className="p-8 text-center text-slate-500 dark:text-slate-400">Loading bundles...</div>
                ) : bundles.length === 0 ? (
                    <div className="p-12 text-center">
                        <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Package size={32} />
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white">No Bundles Found</h3>
                        <p className="text-slate-500 dark:text-slate-400 mb-6">Create your first bundle to get started.</p>
                        <Link
                            href="/bundles/new"
                            className="inline-flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-medium hover:underline"
                        >
                            Create Bundle <ChevronRight size={16} />
                        </Link>
                    </div>
                ) : (
                    <table className="w-full">
                        <thead className="bg-slate-50 dark:bg-slate-900 bg-adaptive text-slate-500 dark:text-slate-400 text-xs font-semibold uppercase tracking-wider text-left border-b border-slate-200 dark:border-slate-700">
                            <tr>
                                <th className="px-6 py-3 pl-6">Name</th>
                                <th className="px-6 py-3">SKU</th>
                                <th className="px-6 py-3 text-right">Recipes</th>
                                <th className="px-6 py-3 text-right">Price</th>
                                <th className="px-6 py-3 text-right">Cost</th>
                                <th className="px-6 py-3 text-right">Margin</th>
                                <th className="px-6 py-3 text-right">FC %</th>
                                <th className="px-6 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                            {bundles.map((bundle) => {
                                const price = bundle.menu_price || 0;
                                const cost = bundle.total_food_cost || 0;
                                const margin = bundle.margin || 0;
                                const fcPct = bundle.food_cost_pct || 0;

                                return (
                                    <tr key={bundle.id} className="group hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                                        <td className="px-6 py-4">
                                            <div className={`flex items-center gap-3 ${bundle.is_active === false ? 'opacity-60' : ''}`}>
                                                <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                                                    <Package size={20} />
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <div className="font-medium text-slate-900 dark:text-white text-adaptive">{bundle.name}</div>
                                                        {bundle.is_active === false && (
                                                            <span className="px-2 py-0.5 rounded text-[10px] uppercase font-bold bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                                                                Inactive
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-slate-500 dark:text-slate-400 text-adaptive-subtle truncate max-w-xs">{bundle.description || 'No description'}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2 group/sku">
                                                <span className="font-mono text-sm text-slate-600 dark:text-slate-400">{bundle.sku}</span>
                                                <button
                                                    onClick={() => navigator.clipboard.writeText(bundle.sku)}
                                                    className="text-slate-300 hover:text-indigo-500 opacity-0 group-hover/sku:opacity-100 transition-opacity"
                                                    title="Copy SKU"
                                                >
                                                    <Copy size={14} />
                                                </button>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-right text-sm text-slate-600 dark:text-slate-400">
                                            {bundle._count?.contents || 0} items
                                        </td>
                                        <td className="px-6 py-4 text-right text-sm font-medium text-slate-900 dark:text-white">
                                            ${price.toFixed(2)}
                                        </td>
                                        <td className="px-6 py-4 text-right text-sm text-slate-600 dark:text-slate-400">
                                            ${cost.toFixed(2)}
                                        </td>
                                        <td className="px-6 py-4 text-right text-sm font-medium text-green-600 dark:text-green-400">
                                            ${margin.toFixed(2)}
                                        </td>
                                        <td className="px-6 py-4 text-right text-sm text-slate-600 dark:text-slate-400">
                                            <span className={`px-2 py-1 rounded ${fcPct > 35 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'}`}>
                                                {fcPct.toFixed(1)}%
                                            </span>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <Link
                                                href={`/bundles/${bundle.id}`}
                                                className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-medium text-sm inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all"
                                            >
                                                Edit <ChevronRight size={14} />
                                            </Link>
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
