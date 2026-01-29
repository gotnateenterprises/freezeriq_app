
"use client";

import { useState, useEffect } from 'react';
import { RefreshCw, Search, Truck, Building2, Package, Phone, Mail, Trash, Plus } from 'lucide-react';
import Link from 'next/link';

interface Supplier {
    id: string;
    name: string;
    contact_email?: string;
    phone_number?: string;
    account_number?: string;
    logo_url?: string;
    _count: {
        ingredients: number;
    }
}

export default function SuppliersPage() {
    const [suppliers, setSuppliers] = useState<Supplier[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [isCreating, setIsCreating] = useState(false);
    const [newSupplierName, setNewSupplierName] = useState('');

    const fetchSuppliers = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/suppliers');
            if (res.ok) {
                const data = await res.json();
                setSuppliers(data);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreate = async () => {
        if (!newSupplierName.trim()) return;
        try {
            const res = await fetch('/api/suppliers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newSupplierName })
            });
            if (res.ok) {
                const newSupplier = await res.json();
                // Redirect to detail page to fill in the rest
                window.location.href = `/suppliers/${newSupplier.id}`;
            }
        } catch (e) {
            alert('Failed to create supplier');
        }
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (!confirm("Are you sure? This will not delete ingredients but will unlink them.")) return;

        try {
            const res = await fetch(`/api/suppliers/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setSuppliers(prev => prev.filter(s => s.id !== id));
            }
        } catch (e) {
            alert("Delete failed");
        }
    };

    useEffect(() => {
        fetchSuppliers();
    }, []);

    const filtered = suppliers.filter(s => s.name.toLowerCase().includes(searchTerm.toLowerCase()));

    return (
        <div className="p-8 max-w-7xl mx-auto pb-32">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 mb-8">
                <div>
                    <h1 className="text-4xl font-black text-slate-900 dark:text-white text-adaptive tracking-tight">Supplier CRM</h1>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-2 text-lg">Manage vendors, account details, and contacts.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => setIsCreating(true)}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold transition shadow-lg shadow-indigo-200 dark:shadow-none hover:scale-105 active:scale-95"
                    >
                        <Plus size={20} />
                        New Supplier
                    </button>
                </div>
            </div>

            {/* Create Modal */}
            {isCreating && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-md p-8 animate-in fade-in zoom-in duration-200">
                        <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-6">Add Supplier</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Supplier Name</label>
                                <input
                                    autoFocus
                                    value={newSupplierName}
                                    onChange={e => setNewSupplierName(e.target.value)}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                                    placeholder="e.g. US Foods"
                                />
                            </div>
                            <div className="pt-4 flex gap-3 justify-end">
                                <button
                                    onClick={() => setIsCreating(false)}
                                    className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleCreate}
                                    disabled={!newSupplierName.trim()}
                                    className="px-8 py-3 rounded-xl font-bold bg-indigo-600 text-white hover:scale-105 active:scale-95 transition-all shadow-lg shadow-indigo-200 dark:shadow-none disabled:opacity-50 disabled:hover:scale-100"
                                >
                                    Create
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex flex-col gap-6">
                {/* Filter Bar */}
                <div className="glass-panel p-2 rounded-2xl flex gap-4 items-center bg-white dark:bg-slate-800 bg-adaptive dark:border-slate-700 shadow-sm border border-slate-200/50">
                    <div className="relative flex-1">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" size={18} />
                        <input
                            placeholder="Search suppliers..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-11 pr-4 py-3 bg-transparent font-medium text-slate-700 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 border-none outline-none"
                        />
                    </div>
                </div>

                {/* Data Table */}
                <div className="glass-panel bg-white dark:bg-slate-800 rounded-3xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm">
                    {isLoading ? (
                        <div className="p-20 text-center space-y-4">
                            <div className="animate-spin text-indigo-500 mx-auto"><RefreshCw size={32} /></div>
                            <p className="text-slate-400 font-medium">Loading suppliers...</p>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="p-20 text-center space-y-4">
                            <div className="w-16 h-16 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto text-slate-300">
                                <Truck size={32} />
                            </div>
                            <p className="text-slate-500 dark:text-slate-400 text-lg font-bold">No suppliers found.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="border-b border-slate-100 dark:border-slate-700/50">
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Supplier</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Account #</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Contact</th>
                                        <th className="py-5 px-6 text-xs font-black uppercase tracking-wider text-slate-400 dark:text-slate-500 text-right">Ingredients</th>
                                        <th className="py-5 px-6 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map((s, i) => (
                                        <tr
                                            key={s.id}
                                            className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors border-b last:border-0 border-slate-50 dark:border-slate-800"
                                            onClick={() => window.location.href = `/suppliers/${s.id}`}
                                        >
                                            <td className="py-4 px-6">
                                                <div className="flex items-center gap-4">
                                                    {s.logo_url ? (
                                                        <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 dark:border-slate-700 flex items-center justify-center overflow-hidden">
                                                            <img src={s.logo_url} alt={s.name} className="w-full h-full object-contain p-1" />
                                                        </div>
                                                    ) : (
                                                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-sm font-bold text-sm">
                                                            {s.name.charAt(0)}
                                                        </div>
                                                    )}
                                                    <div>
                                                        <div className="font-bold text-slate-900 dark:text-white text-adaptive group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{s.name}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="py-4 px-6 text-sm font-mono text-slate-600 dark:text-slate-400">
                                                {s.account_number || '-'}
                                            </td>
                                            <td className="py-4 px-6">
                                                <div className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400 font-medium">
                                                    {s.contact_email && <div className="flex items-center gap-1"><Mail size={12} /> {s.contact_email}</div>}
                                                    {s.phone_number && <div className="flex items-center gap-1"><Phone size={12} /> {s.phone_number}</div>}
                                                </div>
                                            </td>
                                            <td className="py-4 px-6 text-right">
                                                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                                                    <Package size={12} className="text-slate-400" />
                                                    <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{s._count.ingredients}</span>
                                                </div>
                                            </td>
                                            <td className="py-4 px-6 text-right">
                                                <button
                                                    onClick={(e) => handleDelete(e, s.id)}
                                                    className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                                    title="Delete Supplier"
                                                >
                                                    <Trash size={18} />
                                                </button>
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
