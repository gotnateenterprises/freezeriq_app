
"use client";

import { useEffect, useState } from 'react';
import StatCard from '@/components/StatCard';
import { ChefHat, DollarSign, TrendingUp, Package, AlertTriangle, Clock } from 'lucide-react';
import Link from 'next/link';

import RevenueModal from '@/components/RevenueModal';
import CalendarWidget from '@/components/CalendarWidget';

function ActivityItem({ activity, onRefresh }: { activity: any; onRefresh: () => void }) {
    const [isReplying, setIsReplying] = useState(false);
    const [replyText, setReplyText] = useState('');
    const [isSending, setIsSending] = useState(false);

    const handleSendReply = async () => {
        if (!replyText.trim()) return;
        setIsSending(true);
        try {
            const res = await fetch('/api/integrations/meta/reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recipientId: activity.metadata?.senderId,
                    message: replyText,
                    activityId: activity.id
                })
            });
            if (res.ok) {
                setIsReplying(false);
                setReplyText('');
                onRefresh();
            } else {
                const err = await res.json();
                alert(`Failed to send: ${err.error}`);
            }
        } catch (e) {
            alert("Failed to send reply");
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="group">
            <div className="p-5 hover:bg-slate-50/80 dark:hover:bg-slate-700/30 transition flex items-center justify-between cursor-default">
                <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-xs shadow-sm ${activity.status === 'production_ready' || activity.status === 'Ready' || activity.status === 'replied' ? 'bg-emerald-100 text-emerald-700' : 'bg-orange-100 text-orange-700'}`}>
                        {activity.type === 'order' ? 'ORD' : activity.type?.toUpperCase().slice(0, 3) || 'ACT'}
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <p className="font-bold text-slate-900 dark:text-slate-100 text-adaptive text-lg">
                                {activity.customerId ? (
                                    <Link href={`/customers/${activity.customerId}`} className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline transition-all">
                                        {activity.customer}
                                    </Link>
                                ) : (
                                    activity.customer
                                )}
                            </p>
                            {activity.type === 'message' && activity.status !== 'replied' && (
                                <button
                                    onClick={() => setIsReplying(!isReplying)}
                                    className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors"
                                    title="Quick Reply"
                                >
                                    <ChefHat size={14} />
                                </button>
                            )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 text-adaptive-subtle font-medium">{activity.type === 'order' ? `Order #${activity.id}` : activity.title} • {new Date(activity.date).toLocaleDateString()}</p>
                    </div>
                </div>
                <div className="text-right">
                    <p className="font-black text-xl text-slate-900 dark:text-white text-adaptive tracking-tight">
                        {activity.amount || (activity.content?.length > 30 ? activity.content.slice(0, 30) + '...' : activity.content)}
                    </p>
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-400 group-hover:text-indigo-500 transition-colors">{(activity.status || 'NEW').replace('_', ' ')}</p>
                </div>
            </div>

            {isReplying && (
                <div className="px-5 pb-5 animate-in slide-in-from-top-2 duration-200">
                    <div className="bg-slate-50 dark:bg-slate-900/50 rounded-2xl p-3 border border-slate-200 dark:border-slate-700">
                        <textarea
                            placeholder="Type your reply..."
                            className="w-full bg-transparent border-none focus:ring-0 text-sm font-medium text-slate-700 dark:text-slate-300 placeholder-slate-400 resize-none h-20"
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                        />
                        <div className="flex justify-end gap-2 mt-2">
                            <button
                                onClick={() => setIsReplying(false)}
                                className="px-3 py-1.5 text-xs font-bold text-slate-500 hover:text-slate-700 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                disabled={isSending || !replyText.trim()}
                                onClick={handleSendReply}
                                className="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center gap-2"
                            >
                                {isSending ? <div className="w-3 h-3 border-2 border-white border-t-transparent animate-spin rounded-full" /> : 'Send Reply'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default function DashboardClient({ session }: { session: any }) {
    const [data, setData] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isRevenueModalOpen, setIsRevenueModalOpen] = useState(false);
    const [realProductionProgress, setRealProductionProgress] = useState<number | null>(null);
    const [startFoodCost, setStartFoodCost] = useState<number | null>(null);

    const updateProductionMetrics = () => {
        const businessId = session?.user?.businessId;
        if (!businessId) return;

        try {
            const savedCompleted = localStorage.getItem(`${businessId}_productionCompleted`);
            const savedResult = localStorage.getItem(`${businessId}_productionResult`);
            const savedShoppingTotal = localStorage.getItem(`${businessId}_shoppingListTotal`);

            if (savedCompleted && savedResult) {
                const completedSet = new Set(JSON.parse(savedCompleted));
                const result = JSON.parse(savedResult);

                // Calculate Total Tasks (Prep + Assembly)
                const prepTasksCount = result.prepTasks ? Object.keys(result.prepTasks).length : 0;
                const assemblyTasksCount = result.assemblyTasks ? Object.keys(result.assemblyTasks).length : 0;
                const totalTasks = prepTasksCount + assemblyTasksCount;

                if (totalTasks > 0) {
                    setRealProductionProgress(Math.round((completedSet.size / totalTasks) * 100));
                } else {
                    setRealProductionProgress(0);
                }
            } else if (savedResult && !savedCompleted) {
                // Plan exists but nothing checked
                setRealProductionProgress(0);
            } else {
                setRealProductionProgress(null);
            }

            if (savedShoppingTotal) {
                setStartFoodCost(parseFloat(savedShoppingTotal));
            } else {
                setStartFoodCost(null);
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
    }, [session]);

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
                <div className="flex justify-between items-end mb-1">
                    <div>
                        <h2 className="text-3xl font-bold text-slate-900 dark:text-indigo-100 text-adaptive">Dashboard</h2>
                        <p className="text-slate-500 dark:text-slate-400 mt-1 text-adaptive-subtle">Kitchen Overview</p>
                    </div>
                </div>
            </div>

            {/* Metrics Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard
                    title="Weekly In Progress"
                    value={data?.metrics?.activeOrders?.toString() || '0'}
                    subtitle="Last 7 Days"
                    icon={Package}
                    trend={{
                        value: Math.abs(data?.metrics?.activeOrdersGrowth || 0),
                        isPositive: (data?.metrics?.activeOrdersGrowth || 0) >= 0
                    }}
                    href="/orders"
                />
                <StatCard
                    title={`${data?.metrics?.currentMonth || 'Monthly'} Revenue`}
                    value={`$${(data?.metrics?.revenue || 0).toLocaleString()}`}
                    subtitle="Current Month"
                    icon={DollarSign}
                    trend={{
                        value: Math.abs(data?.metrics?.revenueGrowth || 0),
                        isPositive: (data?.metrics?.revenueGrowth || 0) >= 0
                    }}
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
                    trend={{
                        value: Math.abs(data?.metrics?.foodCostGrowth || 0),
                        isPositive: (data?.metrics?.foodCostGrowth || 0) <= 0 // Lower food cost is "positive" for business
                    }}
                    href="/production/shopping-list"
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
                            <div className="divide-y divide-slate-50 dark:divide-slate-700/50">
                                {data.recentActivity.map((activity: any, i: number) => (
                                    <ActivityItem key={activity.id || i} activity={activity} onRefresh={() => {
                                        fetch('/api/dashboard')
                                            .then(res => res.json())
                                            .then(d => setData(d));
                                    }} />
                                ))}
                            </div>
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
                <CalendarWidget initialUrl={data?.calendarUrl} hideSettings={true} />
            </div>
        </div>
    );
}
