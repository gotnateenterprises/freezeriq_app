"use client";

import { useEffect, useState } from 'react';
import { ShieldCheck, Truck, Plus, Edit2, Trash2, ExternalLink, Globe, Search, Save, X, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface Supplier {
    id: string;
    name: string;
    portal_type: string;
    search_url_pattern?: string;
    logo_url?: string;
    website_url?: string;
    is_global: boolean;
    _count: { ingredients: number };
}

export default function AdminSuppliersPage() {
    const [suppliers, setSuppliers] = useState<Supplier[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

    const [formData, setFormData] = useState({
        name: '',
        portal_type: 'gfs_store',
        search_url_pattern: '',
        logo_url: '',
        website_url: ''
    });

    const fetchSuppliers = async () => {
        try {
            const res = await fetch('/api/admin/suppliers');
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

    useEffect(() => {
        fetchSuppliers();
    }, []);

    const handleEdit = (supplier: Supplier) => {
        setEditingSupplier(supplier);
        setFormData({
            name: supplier.name,
            portal_type: supplier.portal_type || 'gfs_store',
            search_url_pattern: supplier.search_url_pattern || '',
            logo_url: supplier.logo_url || '',
            website_url: supplier.website_url || ''
        });
        setShowModal(true);
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSaving(true);
        try {
            const url = editingSupplier ? `/api/admin/suppliers/${editingSupplier.id}` : '/api/admin/suppliers';
            const method = editingSupplier ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (res.ok) {
                setShowModal(false);
                setEditingSupplier(null);
                setFormData({ name: '', portal_type: 'gfs_store', search_url_pattern: '', logo_url: '', website_url: '' });
                fetchSuppliers();
            } else {
                alert("Failed to save supplier");
            }
        } catch (e) {
            alert("Error saving supplier");
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this global supplier? This cannot be undone.")) return;
        try {
            const res = await fetch(`/api/admin/suppliers/${id}`, { method: 'DELETE' });
            if (res.ok) {
                fetchSuppliers();
            }
        } catch (e) {
            alert("Delete failed");
        }
    };

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
            <header className="flex justify-between items-end">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <Link href="/admin/tenants" className="text-sm font-bold text-indigo-600 hover:underline">Admin Console</Link>
                        <span className="text-slate-300">/</span>
                        <span className="text-sm font-bold text-slate-500">Global Suppliers</span>
                    </div>
                    <h1 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                        <Globe className="text-indigo-500" size={32} />
                        Global Supplier Templates
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-2">Manage default supplier definitions and search patterns for all tenants.</p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={() => {
                            if (!suppliers.length) return;
                            const headers = ['Name', 'Portal Type', 'Website', 'Search Pattern', 'Logo URL'];
                            const csvContent = [
                                headers.join(','),
                                ...suppliers.map(s => [
                                    `"${s.name.replace(/"/g, '""')}"`,
                                    `"${s.portal_type}"`,
                                    `"${s.website_url || ''}"`,
                                    `"${(s.search_url_pattern || '').replace(/"/g, '""')}"`,
                                    `"${s.logo_url || ''}"`
                                ].join(','))
                            ].join('\n');

                            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                            const link = document.createElement('a');
                            link.href = URL.createObjectURL(blob);
                            link.download = `global_suppliers_${new Date().toISOString().split('T')[0]}.csv`;
                            link.click();
                        }}
                        className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-4 py-3 rounded-xl font-bold hover:bg-slate-50 dark:hover:bg-slate-700 transition border border-slate-200 dark:border-slate-700 flex items-center gap-2 shadow-sm"
                    >
                        <Save size={18} />
                        Export CSV
                    </button>
                    <button
                        onClick={() => {
                            setEditingSupplier(null);
                            setFormData({ name: '', portal_type: 'gfs_store', search_url_pattern: '', logo_url: '', website_url: '' });
                            setShowModal(true);
                        }}
                        className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 transition flex items-center gap-2 shadow-lg shadow-indigo-500/20"
                    >
                        <Plus size={20} />
                        Add Global Supplier
                    </button>
                </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {isLoading ? (
                    <div className="col-span-full py-20 text-center text-slate-400">
                        <Loader2 className="w-10 h-10 animate-spin mx-auto mb-4" />
                        Loading global suppliers...
                    </div>
                ) : suppliers.length === 0 ? (
                    <div className="col-span-full py-20 text-center bg-white dark:bg-slate-900 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                        <Truck size={48} className="mx-auto text-slate-200 mb-4" />
                        <p className="text-slate-500 font-bold">No global suppliers defined yet.</p>
                    </div>
                ) : (
                    suppliers.map(s => (
                        <div key={s.id} className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm hover:shadow-md transition-all group">
                            <div className="flex justify-between items-start mb-4">
                                <div className="flex items-center gap-4">
                                    {s.logo_url ? (
                                        <div className="w-12 h-12 rounded-xl bg-white border border-slate-100 p-1 flex items-center justify-center overflow-hidden">
                                            <img src={s.logo_url} alt={s.name} className="w-full h-full object-contain" />
                                        </div>
                                    ) : (
                                        <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-black text-xl">
                                            {s.name.charAt(0)}
                                        </div>
                                    )}
                                    <div>
                                        <h3 className="font-bold text-slate-900 dark:text-white">{s.name}</h3>
                                        <p className="text-xs text-slate-500 font-medium">Type: {s.portal_type}</p>
                                    </div>
                                </div>
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onClick={() => handleEdit(s)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-indigo-600"><Edit2 size={16} /></button>
                                    <button onClick={() => handleDelete(s.id)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-rose-600"><Trash2 size={16} /></button>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                                    <p className="text-[10px] uppercase font-black text-slate-400 mb-1 flex items-center gap-1">
                                        <Search size={10} /> Search Pattern
                                    </p>
                                    <p className="text-[11px] font-mono text-slate-600 dark:text-slate-400 break-all h-8 overflow-hidden line-clamp-2">
                                        {s.search_url_pattern || 'No pattern defined'}
                                    </p>
                                </div>
                                <div className="flex justify-between items-center text-xs">
                                    <span className="text-slate-400 font-medium">Used in {s._count.ingredients} ingredients</span>
                                    {s.website_url && (
                                        <a href={s.website_url} target="_blank" className="text-indigo-600 hover:underline flex items-center gap-1 font-bold">
                                            Website <ExternalLink size={10} />
                                        </a>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {/* Modal */}
            {showModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <form onSubmit={handleSave} className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-lg p-8 animate-in fade-in zoom-in duration-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white">
                                {editingSupplier ? 'Edit Global Supplier' : 'New Global Supplier'}
                            </h3>
                            <button type="button" onClick={() => setShowModal(false)} className="p-2 hover:bg-slate-100 rounded-full"><X size={24} /></button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Supplier Name</label>
                                <input
                                    required
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full px-4 py-2 rounded-xl border dark:bg-slate-900 dark:border-slate-700"
                                    placeholder="e.g. Sysco"
                                />
                            </div>

                            {/* Auto-fill Search Logic */}
                            {(() => {
                                useEffect(() => {
                                    if (editingSupplier) return; // Don't overwrite when editing existing

                                    let pattern = '';
                                    if (formData.portal_type === 'gfs_store') {
                                        pattern = 'https://store.gfs.com/search?keywords={{query}}';
                                    } else if (formData.portal_type === 'sysco_shop') {
                                        pattern = 'https://shop.sysco.com/search?q={{query}}';
                                    } else if (formData.portal_type === 'usfoods_ordering') {
                                        pattern = 'https://www.usfoods.com/search?q={{query}}';
                                    }

                                    if (pattern && (!formData.search_url_pattern || formData.search_url_pattern.includes('store.gfs.com') || formData.search_url_pattern.includes('sysco.com') || formData.search_url_pattern.includes('usfoods.com'))) {
                                        setFormData(prev => ({ ...prev, search_url_pattern: pattern }));
                                    }
                                }, [formData.portal_type]);
                                return null;
                            })()}

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Portal Type</label>
                                <select
                                    value={formData.portal_type}
                                    onChange={e => setFormData({ ...formData, portal_type: e.target.value })}
                                    className="w-full px-4 py-2 rounded-xl border dark:bg-slate-900 dark:border-slate-700"
                                >
                                    <option value="gfs_store">GFS Store</option>
                                    <option value="usfoods_ordering">US Foods Ordering</option>
                                    <option value="sysco_shop">Sysco Shop</option>
                                    <option value="custom">Custom Portal</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Search URL Pattern</label>
                                <input
                                    value={formData.search_url_pattern}
                                    onChange={e => setFormData({ ...formData, search_url_pattern: e.target.value })}
                                    className="w-full px-4 py-2 rounded-xl border dark:bg-slate-900 dark:border-slate-700 font-mono text-sm"
                                    placeholder="https://example.com/search?q={{query}}"
                                />
                                <p className="text-[10px] text-slate-400 mt-1">Use `{"{{query}}"}` as the placeholder for the ingredient name.</p>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Website URL</label>
                                    <input
                                        value={formData.website_url}
                                        onChange={e => setFormData({ ...formData, website_url: e.target.value })}
                                        className="w-full px-4 py-2 rounded-xl border dark:bg-slate-900 dark:border-slate-700"
                                        placeholder="https://..."
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Logo</label>
                                    <div className="flex gap-2 items-start">
                                        <div className="flex-1">
                                            <input
                                                type="text"
                                                value={formData.logo_url}
                                                onChange={e => setFormData({ ...formData, logo_url: e.target.value })}
                                                className="w-full px-4 py-2 rounded-xl border dark:bg-slate-900 dark:border-slate-700 mb-2 text-xs"
                                                placeholder="https://..."
                                            />
                                            <input
                                                type="file"
                                                accept="image/*"
                                                onChange={async (e) => {
                                                    const file = e.target.files?.[0];
                                                    if (!file) return;

                                                    const data = new FormData();
                                                    data.append('file', file);

                                                    try {
                                                        const res = await fetch('/api/upload', {
                                                            method: 'POST',
                                                            body: data
                                                        });
                                                        if (res.ok) {
                                                            const json = await res.json();
                                                            setFormData(prev => ({ ...prev, logo_url: json.url }));
                                                        }
                                                    } catch (err) {
                                                        console.error(err);
                                                        alert("Upload failed");
                                                    }
                                                }}
                                                className="block w-full text-xs text-slate-500
                                                    file:mr-4 file:py-2 file:px-4
                                                    file:rounded-full file:border-0
                                                    file:text-xs file:font-semibold
                                                    file:bg-indigo-50 file:text-indigo-700
                                                    hover:file:bg-indigo-100
                                                "
                                            />
                                        </div>
                                        {formData.logo_url && (
                                            <div className="w-12 h-12 rounded-lg border p-1 bg-white shrink-0">
                                                <img src={formData.logo_url} alt="Preview" className="w-full h-full object-contain" />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="mt-8 flex gap-3 justify-end">
                            <button type="button" onClick={() => setShowModal(false)} className="px-6 py-2 rounded-xl font-bold text-slate-500 hover:bg-slate-100">Cancel</button>
                            <button
                                type="submit"
                                disabled={isSaving}
                                className="bg-indigo-600 text-white px-8 py-2 rounded-xl font-bold hover:bg-indigo-700 shadow-lg shadow-indigo-500/20 flex items-center gap-2"
                            >
                                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save size={18} />}
                                {editingSupplier ? 'Save Changes' : 'Create Supplier'}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
