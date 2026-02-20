"use client";

import { useState, useEffect } from 'react';
import { ChefHat, Calculator, LayoutDashboard, RefreshCcw } from 'lucide-react';
import HoldingArea from '@/components/production/HoldingArea';
import PrepList from '@/components/production/PrepList';
import ProductionCalculator from '@/components/production/ProductionCalculator';
import DeliveryQueue from '@/components/production/DeliveryQueue';

export default function ProductionPage() {
    const [activeTab, setActiveTab] = useState<'dashboard' | 'planner'>('dashboard');
    const [data, setData] = useState<{ pending: any[], prep: any[], completed: any[] } | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const refreshData = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/production/dashboard');
            if (res.ok) {
                const json = await res.json();
                setData(json);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        refreshData();
    }, []);

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pb-20">
            {/* Header */}
            <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-20">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between h-16 items-center">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-200 dark:shadow-none">
                                <ChefHat size={20} />
                            </div>
                            <h1 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                                Production Control
                            </h1>
                        </div>

                        <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                            <button
                                onClick={() => setActiveTab('dashboard')}
                                className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${activeTab === 'dashboard'
                                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                                    }`}
                            >
                                <LayoutDashboard size={16} />
                                Dashboard
                            </button>
                            <button
                                onClick={() => setActiveTab('planner')}
                                className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${activeTab === 'planner'
                                        ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                        : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                                    }`}
                            >
                                <Calculator size={16} />
                                Manual Planner
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {activeTab === 'dashboard' ? (
                    <div className="space-y-8">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                            {/* Left Column: Holding Area (Pending) */}
                            <div className="lg:col-span-1 space-y-6">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                        <div className="w-2 h-8 bg-indigo-500 rounded-full" />
                                        Holding Area
                                    </h2>
                                    <button
                                        onClick={refreshData}
                                        className="p-2 text-slate-400 hover:text-indigo-600 transition-colors"
                                    >
                                        <RefreshCcw size={16} className={isLoading ? 'animate-spin' : ''} />
                                    </button>
                                </div>

                                {isLoading && !data ? (
                                    <div className="space-y-4">
                                        {[1, 2, 3].map(i => (
                                            <div key={i} className="h-32 bg-slate-200 dark:bg-slate-800 rounded-2xl animate-pulse" />
                                        ))}
                                    </div>
                                ) : (
                                    <HoldingArea
                                        orders={data?.pending || []}
                                        onRefresh={refreshData}
                                    />
                                )}
                            </div>

                            {/* Right Column: Prep List (Approved/Production) */}
                            <div className="lg:col-span-2 space-y-6">
                                <div className="flex items-center justify-between">
                                    <h2 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                        <div className="w-2 h-8 bg-amber-500 rounded-full" />
                                        Production Queue
                                    </h2>
                                </div>

                                {isLoading && !data ? (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        {[1, 2, 3, 4].map(i => (
                                            <div key={i} className="h-48 bg-slate-200 dark:bg-slate-800 rounded-3xl animate-pulse" />
                                        ))}
                                    </div>
                                ) : (
                                    <PrepList
                                        items={data?.prep || []}
                                        onRefresh={refreshData}
                                    />
                                )}
                            </div>
                        </div>

                        {/* Bottom Row: Delivery Queue */}
                        <div>
                            {isLoading && !data ? (
                                <div className="h-48 bg-slate-200 dark:bg-slate-800 rounded-3xl animate-pulse" />
                            ) : (
                                <DeliveryQueue
                                    orders={data?.completed || []}
                                    onRefresh={refreshData}
                                />
                            )}
                        </div>
                    </div>
                ) : (
                    <ProductionCalculator />
                )}
            </div>
        </div>
    );
}
