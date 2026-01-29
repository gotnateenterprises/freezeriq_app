
"use client";

import { useState, useEffect } from 'react';
import { RefreshCw, Search, User, Building2, ShoppingBag, DollarSign, Trash } from 'lucide-react';
import Link from 'next/link';

interface Customer {
    id: string; // Order External ID can serve as temp ID, but ideally Org ID
    name: string;
    type: 'Individual' | 'Organization';
    total_spend: string;
    last_order: string;
    order_count: number;
    email?: string;
    source?: 'Square' | 'QBO' | 'Manual';
    status?: 'Active' | 'Churned' | 'Lead' | 'At-Risk' | 'Inactive';
    inactive_reason?: string;
}

export default function CustomersPage() {
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');

    const fetchCustomers = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/customers');
            if (res.ok) {
                const data = await res.json();
                // Mocking source/status for now as they might not be in the API yet
                // Use API data directly, fallback only if truly missing
                const enhancedData = data.map((c: any) => ({
                    ...c,
                    source: c.source || 'Square',
                    status: c.status || 'Active',
                    email: c.email || 'customer@example.com'
                }));
                setCustomers(enhancedData);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSync = async () => {
        setIsSyncing(true);
        try {
            const res = await fetch('/api/sync/orders', { method: 'POST' });
            if (res.ok) {
                alert("Sync Complete! New orders and customers imported.");
                fetchCustomers();
            } else {
                const data = await res.json();
                alert(`Sync Failed: ${data.error || "Unknown Error"}`);
            }
        } catch (e: any) {
            alert(`Sync Error: ${e.message}`);
        } finally {
            setIsSyncing(false);
        }
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation(); // Prevent row click
        if (!confirm("Are you sure you want to delete this customer? This action cannot be undone.")) return;

        try {
            const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setCustomers(prev => prev.filter(c => c.id !== id));
            } else {
                const data = await res.json();
                alert(data.error || "Failed to delete");
            }
        } catch (e) {
            alert("Delete failed");
        }
    };

    useEffect(() => {
        fetchCustomers();
    }, []);

    const filtered = customers.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()));

    return (
        <div className="p-8 max-w-7xl mx-auto pb-32">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 mb-8">
                <div>
                    <h1 className="text-4xl font-black text-slate-900 dark:text-white text-adaptive tracking-tight">Customer CRM</h1>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-2 text-lg">Manage relationships and track lifetime value.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleSync}
                        disabled={isSyncing}
                        className="flex items-center gap-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 px-5 py-3 rounded-xl font-bold transition shadow-sm disabled:opacity-50"
                    >
                        <RefreshCw size={18} className={isSyncing ? "animate-spin" : ""} />
                        {isSyncing ? 'Syncing...' : 'Sync Data'}
                    </button>
                    <button className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold transition shadow-lg shadow-indigo-200 dark:shadow-none hover:scale-105 active:scale-95">
                        <User size={20} />
                        New Customer
                    </button>
                </div>
            </div>

            <div className="flex flex-col gap-6">
                {/* Visual Filter Bar */}
                <div className="glass-panel p-2 rounded-2xl flex gap-4 items-center bg-white dark:bg-slate-800 bg-adaptive dark:border-slate-700 shadow-sm border border-slate-200/50">
                    <div className="relative flex-1">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" size={18} />
                        <input
                            placeholder="Search by name, email, or company..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-11 pr-4 py-3 bg-transparent font-medium text-slate-700 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 border-none outline-none"
                        />
                    </div>
                    <div className="h-8 w-px bg-slate-200 dark:bg-slate-700 mx-2"></div>
                    <div className="flex gap-1 pr-2">
                        {['All', 'Active', 'Leads', 'Churned'].map(tab => (
                            <button key={tab} className={`px-4 py-2 rounded-xl text-sm font-bold transition-colors ${tab === 'All' ? 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                                {tab}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Data Table */}
                <div className="glass-panel bg-white dark:bg-slate-800 rounded-3xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm">
                    {isLoading ? (
                        <div className="p-20 text-center space-y-4">
                            <div className="animate-spin text-indigo-500 mx-auto"><RefreshCw size={32} /></div>
                            <p className="text-slate-400 font-medium">Loading your CRM...</p>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="p-20 text-center space-y-4">
                            <div className="w-16 h-16 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto text-slate-300">
                                <User size={32} />
                            </div>
                            <p className="text-slate-500 dark:text-slate-400 text-lg font-bold">No customers found.</p>
                            <p className="text-slate-400">Try syncing order data or adding a customer manually.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="border-b border-slate-100 dark:border-slate-700/50">
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Customer</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Status</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Source</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 text-right">Orders</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 text-right">LTV</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 text-right">LTV</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 text-right">Last Active</th>
                                        <th className="py-5 px-6 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((c, i) => (
                                        <tr
                                            key={i}
                                            className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors border-b last:border-0 border-slate-50 dark:border-slate-800"
                                            onClick={() => window.location.href = `/customers/${c.type === 'Organization' ? c.id : encodeURIComponent(c.name)}`}
                                        >
                                            <td className="py-4 px-6">
                                                <div className="flex items-center gap-4">
                                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-sm font-bold text-sm ${c.type === 'Organization' ? 'bg-gradient-to-br from-purple-500 to-indigo-600' : 'bg-gradient-to-br from-emerald-400 to-teal-500'}`}>
                                                        {c.name.charAt(0)}
                                                    </div>
                                                    <div>
                                                        <div className="font-bold text-slate-900 dark:text-white text-adaptive group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{c.name}</div>
                                                        <div className="text-xs text-slate-400 dark:text-slate-500 font-medium">{c.email || 'No email'}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="py-4 px-6">
                                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold capitalize ${c.status === 'Active' ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' :
                                                        c.status === 'Churned' ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400' :
                                                            c.status === 'At-Risk' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400' :
                                                                c.status === 'Lead' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' :
                                                                    'bg-slate-100 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400' // Inactive
                                                    }`}>
                                                    {c.status}
                                                </span>
                                            </td>
                                            <td className="py-4 px-6">
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-2 h-2 rounded-full ${c.source === 'Square' ? 'bg-slate-900' : c.source === 'QBO' ? 'bg-green-600' : 'bg-indigo-500'}`}></div>
                                                    <span className="text-sm font-bold text-slate-600 dark:text-slate-300">{c.source}</span>
                                                </div>
                                            </td>
                                            <td className="py-4 px-6 text-right">
                                                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                                                    <ShoppingBag size={12} className="text-slate-400" />
                                                    <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{c.order_count}</span>
                                                </div>
                                            </td>
                                            <td className="py-4 px-6 text-right">
                                                <span className="font-black text-slate-900 dark:text-white">{c.total_spend}</span>
                                            </td>
                                            <td className="py-4 px-6 text-right">
                                                <span className="text-sm font-bold text-slate-500 dark:text-slate-400">{new Date(c.last_order).toLocaleDateString()}</span>
                                            </td>
                                            <td className="py-4 px-6 text-right">
                                                {c.type === 'Organization' && (
                                                    <button
                                                        onClick={(e) => handleDelete(e, c.id)}
                                                        className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                                        title="Delete Customer"
                                                    >
                                                        <Trash size={18} />
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
