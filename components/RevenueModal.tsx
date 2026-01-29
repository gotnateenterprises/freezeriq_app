
"use client";

import { X, TrendingUp, DollarSign } from 'lucide-react';

interface RevenueModalProps {
    isOpen: boolean;
    onClose: () => void;
    dailyData: { day: string; amount: number; orders: number }[];
}

export default function RevenueModal({ isOpen, onClose, dailyData }: RevenueModalProps) {
    if (!isOpen) return null;

    const data = dailyData.length > 0 ? dailyData : [];
    const max = Math.max(...data.map(d => d.amount), 1); // Avoid div/0
    const total = data.reduce((acc, curr) => acc + curr.amount, 0);
    // Y-Axis Markers (5 Steps)
    const step = Math.ceil(max / 5);
    const yLabels = Array.from({ length: 6 }, (_, i) => max - (step * i)).filter(v => v >= 0);

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}></div>
            <div className="relative bg-white dark:bg-slate-900 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-slate-100 dark:border-slate-800">

                {/* Header */}
                <div className="p-8 pb-4 flex justify-between items-start">
                    <div>
                        <h2 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                            <div className="p-3 bg-emerald-100 text-emerald-600 rounded-2xl">
                                <DollarSign size={24} strokeWidth={3} />
                            </div>
                            Weekly Revenue
                        </h2>
                        <p className="text-slate-500 dark:text-slate-400 mt-2 font-medium">Breakdown by day for the current period.</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                        <X size={24} className="text-slate-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-8 pt-0">
                    <div className="mb-8">
                        <p className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-1">Total Revenue</p>
                        <p className="text-4xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                            ${total.toLocaleString()}
                            <span className="text-sm bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full flex items-center gap-1">
                                <TrendingUp size={14} /> Last 7 Days
                            </span>
                        </p>
                    </div>

                    <div className="flex gap-4 h-64">
                        {/* Y-Axis Column */}
                        <div className="flex flex-col justify-between text-right text-xs font-bold text-slate-400 dark:text-slate-500 py-6">
                            {yLabels.map((val, i) => (
                                <span key={i}>
                                    ${val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val}
                                </span>
                            ))}
                        </div>

                        {/* Chart Area */}
                        <div className="flex-1 flex items-end justify-between gap-2 md:gap-4 relative border-l border-b border-slate-100 dark:border-slate-800 pl-4 pb-6">
                            {/* Grid Lines */}
                            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none pb-6">
                                {yLabels.map((_, i) => (
                                    <div key={i} className="w-full h-px bg-slate-50 dark:bg-slate-800/50 dashed"></div>
                                ))}
                            </div>

                            {/* Bars */}
                            {data.map((d, i) => (
                                <div key={i} className="flex-1 flex flex-col items-center gap-2 group relative h-full justify-end z-10">
                                    {/* Tooltip */}
                                    <div className="absolute bottom-full mb-2 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 text-white text-xs font-bold px-3 py-2 rounded-lg whitespace-nowrap z-20 pointer-events-none shadow-xl">
                                        ${d.amount.toLocaleString()}
                                        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800"></div>
                                    </div>

                                    {/* Bar */}
                                    <div
                                        className="w-full bg-slate-100 dark:bg-slate-800 rounded-t-lg relative overflow-hidden group-hover:bg-indigo-50 dark:group-hover:bg-indigo-900/20 transition-all duration-300"
                                        style={{ height: `${(d.amount / max) * 100}%`, minHeight: '4px' }}
                                    >
                                        <div className="absolute inset-x-0 bottom-0 bg-indigo-500 h-full opacity-80 group-hover:opacity-100 transition-opacity rounded-t-lg">
                                            <div className="absolute inset-0 bg-gradient-to-t from-black/10 to-transparent"></div>
                                        </div>
                                    </div>

                                    {/* X-Axis Label */}
                                    <div className="absolute top-full mt-2 w-full text-center">
                                        <span className="text-[10px] md:text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{d.day}</span>
                                    </div>
                                </div>
                            ))}
                            {data.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-slate-400">No Data</div>}
                        </div>
                    </div>

                    <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-800 flex justify-between text-xs text-slate-400 font-medium uppercase tracking-wide">
                        <span>Daily Breakdown</span>
                        <span>$ (USD)</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
