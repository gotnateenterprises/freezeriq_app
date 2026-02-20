"use client";

import { useState, useEffect } from 'react';
import {
    Megaphone,
    Plus,
    Search,
    Filter,
    Calendar,
    Target,
    TrendingUp,
    ChevronRight,
    Building2,
    Users,
    ExternalLink,
    Receipt
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import { useSession } from 'next-auth/react';
import UpgradeRequired from '@/components/UpgradeRequired';

interface Fundraiser {
    id: string;
    name: string;
    status: string;
    start_date: string;
    end_date: string;
    goal_amount: number;
    sales_total: number;
    customer_id: string;
    customer: {
        name: string;
    };
    business_slug: string;
    is_placeholder?: boolean;
    portal_token?: string;
}

export default function FundraisersPage() {
    const { data: session, status } = useSession();
    const searchParams = useSearchParams();
    const [fundraisers, setFundraisers] = useState<Fundraiser[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
    const [filterStatus, setFilterStatus] = useState('all');

    const userPlan = (session?.user as any)?.plan;
    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;
    const hasAccess = userPlan === 'ENTERPRISE' || userPlan === 'ULTIMATE' || userPlan === 'FREE' || isSuperAdmin;

    useEffect(() => {
        fetch('/api/campaigns')
            .then(async res => {
                const text = await res.text();
                try {
                    const data = JSON.parse(text);
                    if (!res.ok) throw new Error(data.error || res.statusText);
                    return data;
                } catch (e) {
                    console.error("API returned non-JSON:", text.slice(0, 500)); // Log first 500 chars
                    throw new Error(`API returned invalid JSON: ${res.status} ${res.statusText}`);
                }
            })
            .then(data => {
                if (Array.isArray(data)) {
                    setFundraisers(data);
                } else {
                    setFundraisers([]);
                }
                setIsLoading(false);
            })
            .catch(err => {
                console.error("Failed to fetch fundraisers", err);
                setIsLoading(false);
            });
    }, []);

    const filtered = fundraisers.filter(f => {
        const matchesSearch = f.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.customer.name.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesFilter = filterStatus === 'all' || f.status.toLowerCase() === filterStatus.toLowerCase();
        return matchesSearch && matchesFilter;
    });

    const activeCount = fundraisers.filter(f => f.status === 'Active').length;
    const pendingCount = fundraisers.filter(f => f.status === 'Lead').length;

    if (status === 'loading') return <div className="p-8 text-center text-slate-400">Loading Session...</div>;

    if (!hasAccess) {
        return (
            <UpgradeRequired
                feature="Fundraiser Toolkit"
                description="Coordinate large-scale campaigns, manage volunteer groups, and track organizational goals with ease."
            />
        );
    }

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-4xl font-black tracking-tight flex items-center gap-3">
                        <Megaphone className="text-indigo-600 dark:text-indigo-400" size={36} />
                        Fundraiser Dashboard
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 font-medium mt-1">
                        Track and manage organization campaigns across your kitchen.
                    </p>
                </div>
                <Link
                    href="/customers?type=ORGANIZATION&action=new"
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-black shadow-lg shadow-indigo-500/20 flex items-center gap-2 transition-all hover:scale-[1.02] active:scale-95"
                >
                    <Plus size={20} /> Launch New Fundraiser
                </Link>
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="glass-panel p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
                    <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-2xl flex items-center justify-center mb-4">
                        <TrendingUp size={24} />
                    </div>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Active Campaigns</p>
                    <p className="text-3xl font-black">{activeCount}</p>
                </div>
                <div className="glass-panel p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
                    <div className="w-12 h-12 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-2xl flex items-center justify-center mb-4">
                        <Target size={24} />
                    </div>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">High Leads</p>
                    <p className="text-3xl font-black text-amber-600">{pendingCount}</p>
                </div>
                <div className="glass-panel p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
                    <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-2xl flex items-center justify-center mb-4">
                        <Calendar size={24} />
                    </div>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">This Month</p>
                    <p className="text-3xl font-black text-emerald-600">{fundraisers.length}</p>
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col md:flex-row gap-4 justify-between bg-white dark:bg-slate-800 p-4 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-700">
                <div className="relative flex-1">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input
                        type="text"
                        placeholder="Search by name or school..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 dark:bg-slate-900 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-medium"
                    />
                </div>
                <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-2xl">
                    {['all', 'active', 'lead', 'completed'].map(status => (
                        <button
                            key={status}
                            onClick={() => setFilterStatus(status)}
                            className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterStatus === status ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            {status}
                        </button>
                    ))}
                </div>
            </div>

            {/* Table */}
            <div className="bg-white dark:bg-slate-800 rounded-[2.5rem] overflow-hidden border border-slate-100 dark:border-slate-700 shadow-xl shadow-slate-200/50 dark:shadow-none">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-700">
                                <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase tracking-widest">Campaign</th>
                                <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase tracking-widest">Partner</th>
                                <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase tracking-widest">Status</th>
                                <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase tracking-widest">Dates</th>
                                <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase tracking-widest text-right">Progress</th>
                                <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase tracking-widest"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                            {isLoading ? (
                                <tr>
                                    <td colSpan={6} className="px-8 py-20 text-center text-slate-400 animate-pulse font-bold">Loading Fundraisers...</td>
                                </tr>
                            ) : filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-8 py-20 text-center text-slate-400 italic">No fundraisers found.</td>
                                </tr>
                            ) : filtered.map(item => (
                                <tr key={item.id} className="group hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                                    <td className="px-8 py-6">
                                        <div className="flex items-center gap-4">
                                            <div className="w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center text-indigo-600 group-hover:scale-110 transition-transform">
                                                <Megaphone size={20} />
                                            </div>
                                            <div>
                                                <p className="font-black text-slate-900 dark:text-white text-lg">{item.name}</p>
                                                <p className="text-xs font-bold text-slate-400 uppercase tracking-tighter">ID: {item.id.slice(0, 8)}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className="flex items-center gap-2">
                                            <Building2 size={16} className="text-slate-400" />
                                            <p className="font-bold text-slate-700 dark:text-slate-300">{item.customer.name}</p>
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest ${item.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
                                            item.status === 'Lead' ? 'bg-amber-100 text-amber-700' :
                                                'bg-slate-100 text-slate-600'
                                            }`}>
                                            {item.status}
                                        </span>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className="space-y-1">
                                            <p className="text-sm font-bold text-slate-600 dark:text-slate-400">
                                                {item.start_date ? format(new Date(item.start_date), 'MMM d, yyyy') : 'No date'}
                                            </p>
                                            {item.end_date && (
                                                <p className="text-[10px] font-black text-slate-300 uppercase">to {format(new Date(item.end_date), 'MMM d, yyyy')}</p>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className="flex flex-col items-end gap-1.5 min-w-[120px]">
                                            <div className="flex justify-between w-full text-[10px] font-black font-mono">
                                                <span className="text-indigo-600">${item.sales_total || 0}</span>
                                                <span className="text-slate-400">Goal: ${item.goal_amount || 0}</span>
                                            </div>
                                            <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-indigo-600 transition-all duration-1000"
                                                    style={{ width: `${Math.min(((item.sales_total || 0) / (item.goal_amount || 1)) * 100, 100)}%` }}
                                                />
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-8 py-6 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            {!item.is_placeholder && (
                                                <Link
                                                    href={`/shop/${item.business_slug}/fundraiser/${item.id}`}
                                                    target="_blank"
                                                    className="p-3 hover:bg-white dark:hover:bg-slate-700 rounded-2xl text-slate-400 hover:text-pink-600 transition-all shadow-sm border border-transparent hover:border-pink-100 dark:hover:border-pink-900/30"
                                                    title="View Public Page"
                                                >
                                                    <ExternalLink size={20} />
                                                </Link>
                                            )}
                                            {!item.is_placeholder && item.portal_token && (
                                                <Link
                                                    href={`/coordinator/${item.portal_token}`}
                                                    target="_blank"
                                                    className="p-3 hover:bg-white dark:hover:bg-slate-700 rounded-2xl text-slate-400 hover:text-purple-600 transition-all shadow-sm border border-transparent hover:border-purple-100 dark:hover:border-purple-900/30 inline-flex items-center gap-2 group/btn"
                                                    title="Coordinator Portal Sneak Peek"
                                                >
                                                    <span className="text-[10px] font-black uppercase tracking-widest opacity-0 group-hover/btn:opacity-100 transition-opacity whitespace-nowrap">Portal</span>
                                                    <Users size={20} />
                                                </Link>
                                            )}
                                            <Link
                                                href={`/customers/${item.customer_id}?tab=fundraisers`}
                                                className="p-3 hover:bg-white dark:hover:bg-slate-700 rounded-2xl text-slate-400 hover:text-indigo-600 transition-all shadow-sm border border-transparent hover:border-slate-100 inline-flex items-center gap-2 group/btn"
                                            >
                                                <span className="text-[10px] font-black uppercase tracking-widest opacity-0 group-hover/btn:opacity-100 transition-opacity">Manage</span>
                                                <ChevronRight size={20} />
                                            </Link>
                                            <Link
                                                href={`/invoices?action=new&customerId=${item.customer_id}`}
                                                className="p-3 hover:bg-white dark:hover:bg-slate-700 rounded-2xl text-slate-400 hover:text-emerald-600 transition-all shadow-sm border border-transparent hover:border-slate-100 inline-flex items-center gap-2 group/btn"
                                                title="Create Invoice"
                                            >
                                                <span className="text-[10px] font-black uppercase tracking-widest opacity-0 group-hover/btn:opacity-100 transition-opacity">Invoice</span>
                                                <Receipt size={20} />
                                            </Link>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
