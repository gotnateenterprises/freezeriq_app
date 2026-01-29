
"use client";

import { useEffect, useState } from 'react';
import StatCard from '@/components/StatCard';
import { ChefHat, DollarSign, TrendingUp, Package, AlertTriangle, Clock } from 'lucide-react';
import Link from 'next/link';

import RevenueModal from '@/components/RevenueModal';
import CalendarWidget from '@/components/CalendarWidget';

export default function Dashboard() {
    const [data, setData] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isRevenueModalOpen, setIsRevenueModalOpen] = useState(false);
    const [realProductionProgress, setRealProductionProgress] = useState<number | null>(null);
    const [startFoodCost, setStartFoodCost] = useState<number | null>(null);

    const updateProductionMetrics = () => {
        try {
            const savedCompleted = localStorage.getItem('productionCompleted');
            const savedResult = localStorage.getItem('productionResult');
            const savedShoppingTotal = localStorage.getItem('shoppingListTotal');

            if (savedCompleted && savedResult) {
                const completedSet = new Set(JSON.parse(savedCompleted));
                const result = JSON.parse(savedResult);

                // Calculate Total Tasks (Prep + Assembly ?? Just Prep for now based on user request)
                const totalTasks = result.prepTasks ? Object.keys(result.prepTasks).length : 0;

                if (totalTasks > 0) {
                    setRealProductionProgress(Math.round((completedSet.size / totalTasks) * 100));
                } else {
                    setRealProductionProgress(0);
                }
            } else if (savedResult && !savedCompleted) {
                // Plan exists but nothing checked
                setRealProductionProgress(0);
            }

            if (savedShoppingTotal) {
                setStartFoodCost(parseFloat(savedShoppingTotal));
            }
        } catch (e) { console.error(e); }
    };

    useEffect(() => {
        // Initial Fetch
        fetch('/api/dashboard')
            .then(res => res.json())
            .then(d => {
                setData(d);
                setIsLoading(false);
            })
            .catch(e => console.error(e));

        // Read Local Storage for Production
        updateProductionMetrics();

        // Listen for storage updates (optional, for cross-tab sync)
        window.addEventListener('storage', updateProductionMetrics);
        return () => window.removeEventListener('storage', updateProductionMetrics);
    }, []);

    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading Dashboard...</div>;

    // Calculate Dynamic Food Cost %
    const foodCostPercentage = (startFoodCost && data?.metrics?.revenue > 0)
        ? ((startFoodCost / data.metrics.revenue) * 100).toFixed(1)
        : (data?.metrics?.foodCost || 0);

    const foodCostSubtitle = startFoodCost
        ? `$${startFoodCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Est. Cost`
        : 'Target: 30%';

    return (
        <div className="space-y-8 pb-32">
            <RevenueModal
                isOpen={isRevenueModalOpen}
                onClose={() => setIsRevenueModalOpen(false)}
                dailyData={data?.weeklyRevenue || []}
            />

            <div>
                <h2 className="text-3xl font-bold text-slate-900 dark:text-indigo-100 text-adaptive">Dashboard</h2>
                <p className="text-slate-500 dark:text-slate-400 mt-1 text-adaptive-subtle">Kitchen Overview</p>
            </div>

            {/* Metrics Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard
                    title="Active Orders"
                    value={data?.metrics?.activeOrders?.toString() || '0'}
                    subtitle="In Queue"
                    icon={Package}
                    trend={{ value: 12, isPositive: true }}
                    href="/orders"
                />
                <StatCard
                    title="Total Revenue"
                    value={`$${(data?.metrics?.revenue || 0).toLocaleString()}`}
                    subtitle="All Time"
                    icon={DollarSign}
                    trend={{ value: 5, isPositive: true }}
                    onClick={() => setIsRevenueModalOpen(true)}
                />
                <StatCard
                    title="Production"
                    value={`${realProductionProgress !== null ? realProductionProgress : (data?.metrics?.productionProgress || 0)}%`}
                    subtitle="Daily Goal"
                    icon={ChefHat}
                    href="/production"
                />
                <StatCard
                    title="Food Cost"
                    value={`${foodCostPercentage}%`}
                    subtitle={foodCostSubtitle}
                    icon={TrendingUp}
                    trend={{ value: 2, isPositive: true }}
                    href="/commercial"
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Recent Activity */}
                <div className="lg:col-span-2 glass-panel rounded-3xl overflow-hidden p-1 dark:bg-slate-800/50 bg-adaptive">
                    <div className="p-6 border-b border-slate-100/50 dark:border-slate-700/50 flex justify-between items-center">
                        <h3 className="text-lg font-black text-slate-900 dark:text-indigo-300 text-adaptive flex items-center gap-2 tracking-tight">
                            <Clock size={20} className="text-indigo-500 dark:text-indigo-400" /> Recent Activity
                        </h3>
                        <Link href="/customers" className="text-indigo-600 text-sm font-bold hover:bg-indigo-50 px-3 py-1 rounded-full transition-colors">View All</Link>
                    </div>
                    <div className="divide-y divide-slate-50">
                        {(!data?.recentActivity || data.recentActivity.length === 0) ? (
                            <p className="p-8 text-slate-400 text-center font-medium">No recent activity.</p>
                        ) : (
                            data.recentActivity.map((order: any, i: number) => (
                                <div key={i} className="p-5 hover:bg-slate-50/80 transition flex items-center justify-between group cursor-default">
                                    <div className="flex items-center gap-4">
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-xs shadow-sm ${order.status === 'production_ready' || order.status === 'Ready' ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'}`}>
                                            {order.type === 'order' ? 'ORD' : order.type?.toUpperCase().slice(0, 3) || 'ACT'}
                                        </div>
                                        <div>
                                            <p className="font-bold text-slate-900 dark:text-slate-100 text-adaptive text-lg">
                                                {order.customerId ? (
                                                    <Link href={`/customers/${order.customerId}`} className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline transition-all">
                                                        {order.customer}
                                                    </Link>
                                                ) : (
                                                    order.customer
                                                )}
                                            </p>
                                            <p className="text-xs text-slate-500 dark:text-slate-400 text-adaptive-subtle font-medium">{order.type === 'order' ? `Order #${order.id}` : order.title} • {new Date(order.date).toLocaleDateString()}</p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="font-black text-slate-900 dark:text-white text-adaptive text-lg tracking-tight">{order.amount || order.content?.slice(0, 15) + '...'}</p>
                                        <p className="text-xs font-bold uppercase tracking-wide text-slate-400 group-hover:text-indigo-500 transition-colors">{(order.status || 'NEW').replace('_', ' ')}</p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Production Demand (Queue) */}
                <div className="bg-white rounded-3xl shadow-soft overflow-hidden border border-slate-100/50 dark:bg-slate-800/50 bg-adaptive">
                    <div className="p-6 border-b border-indigo-100 bg-indigo-50/50 dark:bg-indigo-900/10 dark:border-indigo-900/20">
                        <h3 className="text-lg font-black text-indigo-900 dark:text-indigo-300 flex items-center gap-2 tracking-tight">
                            <Package size={20} className="text-indigo-500" /> Production Demand
                        </h3>
                    </div>

                    <div className="p-8 text-center border-b border-slate-100 dark:border-slate-700/50">
                        <div className="text-5xl font-black text-slate-900 dark:text-white tracking-tighter mb-1">
                            {(() => {
                                const total = data.productionDemand ? data.productionDemand.total : 0;
                                const progress = realProductionProgress || 0;
                                // Simple logic: Reduce demand by % completed
                                // E.g. 25 demand, 20% done -> Show 20
                                const remaining = Math.round(total * (1 - progress / 100));
                                return remaining;
                            })()}
                        </div>
                        <p className="text-sm font-bold text-slate-400 uppercase tracking-wide">
                            {realProductionProgress && realProductionProgress > 0 ? 'Remaining to Pack' : 'Total Bundles Queued'}
                        </p>
                    </div>

                    <div className="p-6 space-y-4">
                        {/* Family Breakdown */}
                        <div className="flex items-center justify-between group">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-purple-100 text-purple-600 flex items-center justify-center font-bold text-lg">
                                    5
                                </div>
                                <div>
                                    <p className="font-bold text-slate-900 dark:text-slate-100">Family Size</p>
                                    <p className="text-xs text-slate-500 font-medium">Serves 5 people</p>
                                </div>
                            </div>
                            <span className="font-black text-xl text-slate-900 dark:text-white">
                                {data.productionDemand?.family || 0}
                            </span>
                        </div>

                        {/* Couple Breakdown */}
                        <div className="flex items-center justify-between group">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-pink-100 text-pink-600 flex items-center justify-center font-bold text-lg">
                                    2
                                </div>
                                <div>
                                    <p className="font-bold text-slate-900 dark:text-slate-100">Couple Size</p>
                                    <p className="text-xs text-slate-500 font-medium">Serves 2 people</p>
                                </div>
                            </div>
                            <span className="font-black text-xl text-slate-900 dark:text-white">
                                {data.productionDemand?.couple || 0}
                            </span>
                        </div>
                    </div>

                    <div className="p-3 bg-slate-50/50 text-center border-t border-slate-100 dark:border-slate-700/50">
                        <Link href="/production" className="text-xs font-bold text-slate-500 hover:text-indigo-600 uppercase tracking-wide">Go to Production Hub &rarr;</Link>
                    </div>
                </div>
            </div>

            {/* Calendar Widget */}
            <div className="mt-8">
                <CalendarWidget />
            </div>
        </div>
    );
}
