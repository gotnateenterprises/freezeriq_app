
"use client";

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Save, Trash, Package, Plus, Search, Calendar, Check, X } from 'lucide-react';

export default function CatalogEditorPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [catalog, setCatalog] = useState<any>(null);
    const [availableBundles, setAvailableBundles] = useState<any[]>([]);

    // UI State
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchData();
    }, [id]);

    const fetchData = async () => {
        setIsLoading(true);
        try {
            const [catRes, bundRes] = await Promise.all([
                fetch(`/api/catalogs/${id}`),
                fetch('/api/bundles')
            ]);

            if (catRes.ok) {
                const catData = await catRes.json();
                setCatalog(catData);
            } else {
                router.push('/bundles'); // Redirect if not found
                return;
            }

            if (bundRes.ok) {
                setAvailableBundles(await bundRes.json());
            }

        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSaveDetails = async () => {
        setIsSaving(true);
        try {
            const res = await fetch(`/api/catalogs/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: catalog.name,
                    start_date: catalog.start_date,
                    end_date: catalog.end_date,
                    is_active: catalog.is_active
                })
            });

            if (res.ok) {
                alert("Catalog Details Saved!");
                fetchData();
            } else {
                alert("Failed to save changes.");
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleAddBundle = async (bundleId: string) => {
        try {
            const res = await fetch(`/api/catalogs/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundles_to_add: [bundleId] })
            });
            if (res.ok) fetchData();
        } catch (e) {
            alert("Error adding bundle");
        }
    };

    const handleRemoveBundle = async (bundleId: string) => {
        if (!confirm("Remove this bundle from the catalog?")) return;
        try {
            const res = await fetch(`/api/catalogs/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundles_to_remove: [bundleId] })
            });
            if (res.ok) fetchData();
        } catch (e) {
            alert("Error removing bundle");
        }
    };

    if (isLoading || !catalog) return <div className="p-12 text-center">Loading Catalog...</div>;

    // Filter available bundles (exclude ones already in catalog)
    const assignedIds = catalog.bundles?.map((b: any) => b.id) || [];
    const unassignedBundles = availableBundles.filter(b => !assignedIds.includes(b.id) && b.is_active !== false);

    const filteredAvailable = unassignedBundles.filter(b =>
        b.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        b.sku?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center gap-4">
                <Link href="/bundles" className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-500 dark:text-slate-400 transition-colors">
                    <ArrowLeft size={24} />
                </Link>
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white text-adaptive">Edit Catalog</h1>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle">Manage seasonal bundles and visibility.</p>
                </div>
                <div className="ml-auto flex gap-3">
                    <button
                        onClick={async () => {
                            if (!confirm("Are you sure you want to delete this catalog? Bundles will just be unassigned.")) return;
                            await fetch(`/api/catalogs/${id}`, { method: 'DELETE' });
                            router.push('/bundles');
                        }}
                        className="p-3 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl transition-colors"
                        title="Delete Catalog"
                    >
                        <Trash size={20} />
                    </button>
                    <button
                        onClick={handleSaveDetails}
                        disabled={isSaving}
                        className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-lg transition-all"
                    >
                        <Save size={18} />
                        {isSaving ? "Saving..." : "Save Changes"}
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Details */}
                <div className="space-y-6">
                    <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4">Catalog Settings</h3>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Catalog Name</label>
                                <input
                                    value={catalog.name}
                                    onChange={e => setCatalog({ ...catalog, name: e.target.value })}
                                    className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Start Date</label>
                                    <input
                                        type="date"
                                        value={catalog.start_date?.split('T')[0]}
                                        onChange={e => setCatalog({ ...catalog, start_date: e.target.value })}
                                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold text-sm"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">End Date</label>
                                    <input
                                        type="date"
                                        value={catalog.end_date?.split('T')[0]}
                                        onChange={e => setCatalog({ ...catalog, end_date: e.target.value })}
                                        className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold text-sm"
                                    />
                                </div>
                            </div>

                            <div className="flex items-center gap-3 bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-100 dark:border-slate-700 mt-2">
                                <input
                                    type="checkbox"
                                    checked={catalog.is_active}
                                    onChange={e => setCatalog({ ...catalog, is_active: e.target.checked })}
                                    className="w-5 h-5 text-indigo-600 rounded focus:ring-indigo-500 cursor-pointer"
                                />
                                <span className="font-bold text-slate-700 dark:text-slate-200">Active (Visible)</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Column: Bundles */}
                <div className="lg:col-span-2 space-y-6">
                    {/* ASSIGNED BUNDLES */}
                    <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1 flex items-center gap-2">
                            <Package className="text-indigo-500" size={20} />
                            Assigned Bundles ({catalog.bundles?.length || 0})
                        </h3>
                        <p className="text-sm text-slate-500 mb-4">These bundles appear in this catalog.</p>

                        <div className="space-y-3">
                            {catalog.bundles?.length === 0 && (
                                <div className="p-8 text-center bg-slate-50 dark:bg-slate-900/50 rounded-xl border-dashed border-2 border-slate-200 dark:border-slate-700">
                                    <p className="text-slate-400 font-medium">No bundles assigned yet.</p>
                                    <p className="text-xs text-slate-400">Add bundles from the list below.</p>
                                </div>
                            )}

                            {catalog.bundles?.map((b: any) => (
                                <div key={b.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-100 dark:border-slate-700 group hover:border-indigo-200 transition-colors">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-lg bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 flex items-center justify-center font-bold shadow-sm">
                                            {b.sku?.slice(-2) || 'B'}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <div className="font-bold text-slate-900 dark:text-white">{b.name}</div>
                                                {!b.is_active && <span className="text-[10px] font-bold bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase">Archived</span>}
                                            </div>
                                            <div className="text-xs text-slate-500 font-mono">{b.sku} • {b.serving_tier}</div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleRemoveBundle(b.id)}
                                        className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-colors"
                                        title="Remove from Catalog"
                                    >
                                        <X size={18} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* AVAILABLE BUNDLES */}
                    <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Add Available Bundles</h3>
                            <div className="relative w-64">
                                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm"
                                    placeholder="Search to add..."
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                            {filteredAvailable.length === 0 && (
                                <p className="text-center text-sm text-slate-400 py-4">No matching bundles found.</p>
                            )}

                            {filteredAvailable.map(b => (
                                <div key={b.id} className="flex items-center justify-between p-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded-xl transition-colors border border-transparent hover:border-slate-100 dark:hover:border-slate-700">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-500 flex items-center justify-center text-xs font-bold">
                                            {b.sku?.slice(0, 2)}
                                        </div>
                                        <div className="text-sm">
                                            <div className="font-bold text-slate-700 dark:text-slate-200">{b.name}</div>
                                            <div className="text-xs text-slate-400">{b.sku}</div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleAddBundle(b.id)}
                                        className="p-1.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 rounded-lg font-bold text-xs flex items-center gap-1 transition-colors"
                                    >
                                        <Plus size={14} /> Add
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
