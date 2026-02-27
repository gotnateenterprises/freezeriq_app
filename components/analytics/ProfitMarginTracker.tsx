"use client";

import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

interface MarginData {
    id: string;
    name: string;
    sku: string;
    serving_tier: string;
    price: number;
    totalCogs: number;
    marginPercentage: number;
    is_active: boolean;
}

export default function ProfitMarginTracker() {
    const [data, setData] = useState<MarginData[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
    const TARGET_MARGIN = 35.0; // 35% margin threshold

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/analytics/margins');
            if (res.ok) {
                const json = await res.json();
                setData(json);
                setLastRefresh(new Date());
            } else {
                toast.error('Failed to load margin analytics');
            }
        } catch (error) {
            console.error(error);
            toast.error('Network error loading margins');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, []);

    // Filter to show active bundles primarily
    const activeBundles = data.filter(d => d.is_active);

    return (
        <div className="glass-panel p-6 sm:p-8 rounded-[2rem] bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 shadow-xl shadow-slate-200/50 dark:shadow-none animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
                <div>
                    <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                        <TrendingUp className="text-emerald-500 w-6 h-6" />
                        Live Profit Margins
                    </h3>
                    <p className="text-sm font-medium text-slate-500 mt-1 flex items-center gap-2">
                        Target Margin: <span className="text-slate-700 dark:text-slate-300 font-bold">{TARGET_MARGIN}%</span>
                        <span className="text-slate-300 dark:text-slate-600">|</span>
                        Updated: {lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                </div>
                <button
                    onClick={fetchData}
                    disabled={isLoading}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-50 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
                >
                    <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-y border-slate-100 dark:border-slate-700">
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest rounded-tl-xl whitespace-nowrap">Bundle / Product</th>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">SKU</th>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest text-right whitespace-nowrap">Retail Price</th>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest text-right whitespace-nowrap">COGS (Base Cost)</th>
                            <th className="px-6 py-4 text-xs font-black text-slate-400 uppercase tracking-widest text-right rounded-tr-xl whitespace-nowrap">Gross Margin %</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                        {isLoading && data.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                                    <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-indigo-400" />
                                    <p className="font-bold animate-pulse">Calculating live multi-level recipe costs...</p>
                                </td>
                            </tr>
                        ) : activeBundles.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-slate-400 italic font-medium">No active bundles found.</td>
                            </tr>
                        ) : (
                            activeBundles.map((bundle) => {
                                const isWarning = bundle.marginPercentage < TARGET_MARGIN;

                                return (
                                    <tr key={bundle.id} className="group hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                                        <td className="px-6 py-4">
                                            <p className="font-black text-slate-900 dark:text-white line-clamp-1">{bundle.name}</p>
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">{bundle.serving_tier}</p>
                                        </td>
                                        <td className="px-6 py-4 text-sm font-bold text-slate-500 font-mono">
                                            {bundle.sku}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <p className="font-black text-slate-900 dark:text-white">${bundle.price.toFixed(2)}</p>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <p className="font-bold text-slate-600 dark:text-slate-400">${bundle.totalCogs.toFixed(2)}</p>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                {isWarning && (
                                                    <AlertCircle className="w-4 h-4 text-red-500 -mt-0.5" />
                                                )}
                                                <span className={`px-3 py-1 rounded-lg text-sm font-black ${isWarning
                                                        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                    }`}>
                                                    {bundle.marginPercentage.toFixed(1)}%
                                                </span>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

        </div>
    );
}
