
"use client";

import { useState, useEffect } from 'react';
import { Search, BarChart3, Users, Building, ChevronLeft } from 'lucide-react';
import Link from 'next/link';

interface UserProgress {
    id: string;
    name: string | null;
    email: string;
    role: string;
    businessName: string;
    completedCount: number;
    totalCount: number;
    percentage: number;
}

export default function AdminProgressDashboard() {
    const [stats, setStats] = useState<UserProgress[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchStats();
    }, []);

    const fetchStats = async () => {
        try {
            const res = await fetch('/api/admin/training/progress');
            if (res.ok) {
                const data = await res.json();
                setStats(data);
            }
        } catch (error) {
            console.error("Failed to fetch admin stats");
        } finally {
            setLoading(false);
        }
    };

    const filteredStats = stats.filter(user =>
        (user.name?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        user.businessName.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="max-w-6xl mx-auto p-4 md:p-8">
            <div className="mb-6">
                <Link href="/admin/training" className="text-slate-500 hover:text-indigo-600 flex items-center gap-1 text-sm font-medium mb-4">
                    <ChevronLeft size={16} /> Back to Resources
                </Link>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-black text-slate-800 flex items-center gap-3">
                            <BarChart3 className="text-indigo-600" />
                            Tenant Progress Report
                        </h1>
                        <p className="text-slate-500 text-sm">Monitor training completion across all businesses.</p>
                    </div>
                    <div className="relative w-full md:w-64">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                        <input
                            type="text"
                            placeholder="Search users or business..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-200 shadow-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                        />
                    </div>
                </div>
            </div>

            {loading ? (
                <div className="flex justify-center py-20">
                    <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600"></div>
                </div>
            ) : (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                    <table className="w-full text-left border-collapse">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase font-semibold">
                            <tr>
                                <th className="px-6 py-4">User</th>
                                <th className="px-6 py-4">Business</th>
                                <th className="px-6 py-4">Role</th>
                                <th className="px-6 py-4">Progress</th>
                                <th className="px-6 py-4 text-right">Completed</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {filteredStats.map((user) => (
                                <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="font-bold text-slate-800">{user.name || 'Unknown'}</div>
                                        <div className="text-xs text-slate-400">{user.email}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <Building size={14} className="text-slate-400" />
                                            <span className="text-sm font-medium text-slate-600">{user.businessName}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold uppercase ${user.role === 'ADMIN' ? 'bg-indigo-100 text-indigo-700' :
                                                user.role === 'DRIVER' ? 'bg-amber-100 text-amber-700' :
                                                    'bg-slate-100 text-slate-600'
                                            }`}>
                                            {user.role}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 w-48">
                                        <div className="flex items-center gap-3">
                                            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full transition-all duration-500 ${user.percentage === 100 ? 'bg-emerald-500' :
                                                            user.percentage > 50 ? 'bg-indigo-500' :
                                                                'bg-amber-500'
                                                        }`}
                                                    style={{ width: `${user.percentage}%` }}
                                                />
                                            </div>
                                            <span className="text-xs font-bold text-slate-600 w-8 text-right">{user.percentage}%</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right text-sm text-slate-500 font-medium">
                                        {user.completedCount} / {user.totalCount}
                                    </td>
                                </tr>
                            ))}
                            {filteredStats.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                                        No users found matching your search.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
