"use client";

import { useEffect, useState } from 'react';
import { Building2, Users, DollarSign, TrendingUp, ShieldAlert, Activity } from 'lucide-react';

interface AdminStats {
    metrics: {
        totalBusinesses: number;
        totalUsers: number;
        newBusinesses: number;
        mrr: number;
    };
    recentBusinesses: any[];
}

export default function SuperAdminDashboard() {
    const [data, setData] = useState<AdminStats | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        fetch('/api/admin/stats')
            .then(res => res.json())
            .then(setData)
            .catch(console.error)
            .finally(() => setIsLoading(false));
    }, []);

    if (isLoading) {
        return <div className="p-8 text-center text-slate-500">Loading Super Admin Dashboard...</div>;
    }

    return (
        <div className="max-w-7xl mx-auto p-6 space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                        <ShieldAlert className="text-red-600" size={32} />
                        Super Admin
                    </h1>
                    <p className="text-slate-500 font-medium">Platform Overview & Health</p>
                </div>
                <div className="bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1">
                    <Activity size={14} /> System Operational
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Total Tenants */}
                <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <p className="text-slate-500 text-xs font-bold uppercase tracking-wider">Active Tenants</p>
                            <h3 className="text-3xl font-black text-slate-900 dark:text-white mt-1">
                                {data?.metrics.totalBusinesses || 0}
                            </h3>
                        </div>
                        <div className="bg-blue-100 dark:bg-blue-900/30 p-2 rounded-lg text-blue-600 dark:text-blue-400">
                            <Building2 size={24} />
                        </div>
                    </div>
                    <p className="text-xs text-slate-400 flex items-center gap-1">
                        <TrendingUp size={12} className="text-emerald-500" />
                        <span className="text-emerald-500 font-bold">+{data?.metrics.newBusinesses}</span> this month
                    </p>
                </div>

                {/* Total Users */}
                <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <p className="text-slate-500 text-xs font-bold uppercase tracking-wider">Total Users</p>
                            <h3 className="text-3xl font-black text-slate-900 dark:text-white mt-1">
                                {data?.metrics.totalUsers || 0}
                            </h3>
                        </div>
                        <div className="bg-purple-100 dark:bg-purple-900/30 p-2 rounded-lg text-purple-600 dark:text-purple-400">
                            <Users size={24} />
                        </div>
                    </div>
                    <p className="text-xs text-slate-400">Across all accounts</p>
                </div>

                {/* ARR / MRR */}
                <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                    <div className="flex justify-between items-start mb-4">
                        <div>
                            <p className="text-slate-500 text-xs font-bold uppercase tracking-wider">Monthly Revenue (Est)</p>
                            <h3 className="text-3xl font-black text-slate-900 dark:text-white mt-1">
                                ${(data?.metrics.mrr || 0).toLocaleString()}
                            </h3>
                        </div>
                        <div className="bg-emerald-100 dark:bg-emerald-900/30 p-2 rounded-lg text-emerald-600 dark:text-emerald-400">
                            <DollarSign size={24} />
                        </div>
                    </div>
                    <p className="text-xs text-slate-400">Based on $99/mo standard plan</p>
                </div>
            </div>

            {/* Recent Tenants Table */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center">
                    <h3 className="font-bold text-lg text-slate-900 dark:text-white">Recent Business Signups</h3>
                </div>
                <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 dark:bg-slate-900/50 text-slate-500 text-xs uppercase font-bold">
                        <tr>
                            <th className="p-4">Business Name</th>
                            <th className="p-4">Owner Email</th>
                            <th className="p-4">Joined</th>
                            <th className="p-4 text-right">Status</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {data?.recentBusinesses.map((biz) => (
                            <tr key={biz.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                <td className="p-4 font-bold text-slate-700 dark:text-slate-300">
                                    {biz.name}
                                </td>
                                <td className="p-4 text-slate-500 text-sm">
                                    {biz.users[0]?.email || 'No Owner'}
                                </td>
                                <td className="p-4 text-slate-500 text-sm">
                                    {new Date(biz.created_at).toLocaleDateString()}
                                </td>
                                <td className="p-4 text-right">
                                    <span className="bg-emerald-100 text-emerald-700 px-2 py-1 rounded text-xs font-bold">
                                        Active
                                    </span>
                                </td>
                            </tr>
                        ))}
                        {(!data?.recentBusinesses || data.recentBusinesses.length === 0) && (
                            <tr>
                                <td colSpan={4} className="p-8 text-center text-slate-400 italic">
                                    No businesses found.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
