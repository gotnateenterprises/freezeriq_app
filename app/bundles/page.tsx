"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Package, Plus, ChevronRight, Search, Copy, BookOpen, Calendar, Trash2, X, Loader2, Archive, ArchiveRestore } from 'lucide-react';
import DashboardImporter from '@/components/DashboardImporter';

export default function BundlesPage() {
    const [activeTab, setActiveTab] = useState<'bundles' | 'catalogs' | 'surplus'>('bundles');
    const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');

    // Bundles State
    const [bundles, setBundles] = useState<any[]>([]);
    const [isLoadingBundles, setIsLoadingBundles] = useState(true);

    // Catalogs State
    const [catalogs, setCatalogs] = useState<any[]>([]);
    const [isLoadingCatalogs, setIsLoadingCatalogs] = useState(true);
    const [isCreatingCatalog, setIsCreatingCatalog] = useState(false);
    const [newCatalog, setNewCatalog] = useState({ name: '', start_date: '', end_date: '' });

    // Surplus State
    const [surplusItems, setSurplusItems] = useState<any[]>([]);
    const [isLoadingSurplus, setIsLoadingSurplus] = useState(false);
    const [recipes, setRecipes] = useState<any[]>([]); // For creating surplus from recipes
    const [newSurplus, setNewSurplus] = useState({ recipeId: '', price: '', stock: '' });

    useEffect(() => {
        if (activeTab === 'bundles') fetchBundles();
        else if (activeTab === 'catalogs') fetchCatalogs();
        else if (activeTab === 'surplus') {
            fetchSurplus();
            fetchRecipes();
        }
    }, [activeTab]);

    const fetchBundles = async () => {
        setIsLoadingBundles(true);
        try {
            const res = await fetch('/api/bundles');
            if (res.ok) setBundles(await res.json());
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoadingBundles(false);
        }
    };

    const fetchCatalogs = async () => {
        setIsLoadingCatalogs(true);
        try {
            const res = await fetch('/api/catalogs');
            if (res.ok) setCatalogs(await res.json());
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoadingCatalogs(false);
        }
    };

    const fetchSurplus = async () => {
        setIsLoadingSurplus(true);
        try {
            // Re-using /api/bundles but filtering on client or server? 
            // Better to have a dedicated endpoint or query param. For now, we'll fetch all and filter.
            // Ideally: /api/bundles?type=surplus
            const res = await fetch('/api/bundles');
            if (res.ok) {
                const all: any[] = await res.json();
                setSurplusItems(all.filter(b => b.is_surplus));
            }
        } catch (e) { console.error(e); }
        finally { setIsLoadingSurplus(false); }
    };

    const fetchRecipes = async () => {
        try {
            const res = await fetch('/api/recipes');
            if (res.ok) {
                const data = await res.json();
                setRecipes(data.recipes || (Array.isArray(data) ? data : []));
            }
        } catch (e) { console.error(e); }
    };

    const handleCreateCatalog = async () => {
        try {
            const res = await fetch('/api/catalogs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newCatalog)
            });

            if (res.ok) {
                setIsCreatingCatalog(false);
                setNewCatalog({ name: '', start_date: '', end_date: '' });
                fetchCatalogs();
            } else {
                const err = await res.json();
                alert(err.error || "Failed to create catalog");
            }
        } catch (e) {
            alert("Error creating catalog");
        }
    };

    const handleCreateSurplus = async () => {
        if (!newSurplus.recipeId || !newSurplus.price || !newSurplus.stock) return alert("Please fill all fields");

        const recipe = recipes.find(r => r.id === newSurplus.recipeId);
        if (!recipe) return;

        try {
            // We are creating a "Bundle" that represents this single surplus item
            const res = await fetch('/api/bundles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: recipe.name, // Use recipe name
                    sku: `SURPLUS-${Date.now()}`, // Temporary SKU generation
                    description: `Surplus inventory: ${recipe.name}`,
                    price: parseFloat(newSurplus.price),
                    stock_on_hand: parseFloat(newSurplus.stock),
                    is_active: true,
                    show_on_storefront: true,
                    is_surplus: true,
                    // We need to link the content. The current POST /api/bundles might expect 'contents'.
                    // If the API isn't set up for this, we might need to adjust it or pass contents here.
                    contents: [{ recipe_id: recipe.id, quantity: 1 }]
                })
            });

            if (res.ok) {
                setNewSurplus({ recipeId: '', price: '', stock: '' });
                fetchSurplus();
            } else {
                const err = await res.json();
                alert(err.error || "Failed to add surplus");
            }
        } catch (e) {
            alert("Error adding surplus");
        }
    };

    const filteredBundles = bundles.filter(b => {
        if (b.is_surplus) return false; // Hide surplus from main list
        if (statusFilter === 'all') return true;
        if (statusFilter === 'active') return b.is_active !== false; // Default true
        if (statusFilter === 'inactive') return b.is_active === false;
        return true;
    });

    return (
        <div className="max-w-6xl mx-auto space-y-8">
            <div className="flex justify-between items-end">
                <div>
                    <h1 className="text-3xl font-bold text-slate-900 dark:text-white text-adaptive">Bundle Manager</h1>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-1">Manage product bundles and seasonal catalogs.</p>
                </div>

                <div className="flex items-center gap-3">
                    <DashboardImporter minimal={true} />

                    {activeTab === 'bundles' ? (
                        <Link
                            href="/bundles/new"
                            className="flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-600 text-white px-5 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/40 hover:-translate-y-0.5"
                        >
                            <Plus size={18} />
                            New Bundle
                        </Link>
                    ) : activeTab === 'catalogs' ? (
                        <button
                            onClick={() => setIsCreatingCatalog(true)}
                            className="flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-600 text-white px-5 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/40 hover:-translate-y-0.5"
                        >
                            <Plus size={18} />
                            New Catalog
                        </button>
                    ) : (
                        // Surplus Action (maybe "Add Surplus" logic handles this inline)
                        null
                    )}
                </div>
            </div>

            {/* Tabs & Filters */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl w-fit">
                    <button
                        onClick={() => setActiveTab('bundles')}
                        className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'bundles' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                    >
                        Bundles
                    </button>
                    <button
                        onClick={() => setActiveTab('catalogs')}
                        className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'catalogs' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                    >
                        Catalogs
                    </button>
                    <button
                        onClick={() => setActiveTab('surplus' as any)}
                        className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === 'surplus' as any ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}`}
                    >
                        Surplus / Extras
                    </button>
                </div>

                {activeTab === 'bundles' && (
                    <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
                        <button
                            onClick={() => setStatusFilter('active')}
                            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${statusFilter === 'active' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
                        >
                            Active
                        </button>
                        <button
                            onClick={() => setStatusFilter('inactive')}
                            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${statusFilter === 'inactive' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
                        >
                            Inactive
                        </button>
                        <button
                            onClick={() => setStatusFilter('all')}
                            className={`px-4 py-1.5 rounded-md text-xs font-bold transition-all ${statusFilter === 'all' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-white shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
                        >
                            All
                        </button>
                    </div>
                )}
            </div>

            {activeTab === 'bundles' && (
                <BundlesList bundles={filteredBundles} isLoading={isLoadingBundles} refresh={fetchBundles} />
            )}

            {activeTab === 'catalogs' && (
                <CatalogsList catalogs={catalogs} isLoading={isLoadingCatalogs} />
            )}

            {activeTab === 'surplus' as any && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {/* Add New Surplus Form */}
                    <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4">Add Surplus Item</h3>
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                            <div className="col-span-2">
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Recipe / Meal</label>
                                <select
                                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl"
                                    value={newSurplus.recipeId}
                                    onChange={e => setNewSurplus({ ...newSurplus, recipeId: e.target.value })}
                                >
                                    <option value="">Select a recipe...</option>
                                    {recipes.map(r => (
                                        <option key={r.id} value={r.id}>{r.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Price ($)</label>
                                <input
                                    type="number"
                                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl"
                                    placeholder="0.00"
                                    value={newSurplus.price}
                                    onChange={e => setNewSurplus({ ...newSurplus, price: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Quantity</label>
                                <input
                                    type="number"
                                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl"
                                    placeholder="0"
                                    value={newSurplus.stock}
                                    onChange={e => setNewSurplus({ ...newSurplus, stock: e.target.value })}
                                />
                            </div>
                        </div>
                        <div className="mt-4 flex justify-end">
                            <button
                                onClick={handleCreateSurplus}
                                className="px-6 py-2 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 transition-colors"
                            >
                                Add to Inventory
                            </button>
                        </div>
                    </div>

                    {/* Surplus List */}
                    <BundlesList bundles={surplusItems} isLoading={isLoadingSurplus} refresh={fetchSurplus} />
                </div>
            )}

            {/* Create Catalog Modal */}
            {isCreatingCatalog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl p-8 w-full max-w-md animate-in fade-in zoom-in duration-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white">New Catalog</h3>
                            <button onClick={() => setIsCreatingCatalog(false)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors">
                                <X size={24} className="text-slate-400" />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Catalog Name</label>
                                <input
                                    value={newCatalog.name}
                                    onChange={e => setNewCatalog({ ...newCatalog, name: e.target.value })}
                                    placeholder="e.g. Spring 2026 Fundraiser"
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500 dark:text-white"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Start Date</label>
                                    <input
                                        type="date"
                                        value={newCatalog.start_date}
                                        onChange={e => setNewCatalog({ ...newCatalog, start_date: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500 dark:text-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">End Date</label>
                                    <input
                                        type="date"
                                        value={newCatalog.end_date}
                                        onChange={e => setNewCatalog({ ...newCatalog, end_date: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500 dark:text-white"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="mt-8 flex justify-end gap-3">
                            <button onClick={() => setIsCreatingCatalog(false)} className="px-6 py-3 font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl transition-colors">Cancel</button>
                            <button onClick={handleCreateCatalog} className="px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 dark:shadow-none">Create Catalog</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function BundlesList({ bundles, isLoading, refresh }: { bundles: any[], isLoading: boolean, refresh: () => void }) {
    if (isLoading) return <div className="p-8 text-center text-slate-500">Loading bundles...</div>;

    const toggleStatus = async (bundle: any) => {
        try {
            const newStatus = !bundle.is_active;
            const res = await fetch(`/api/bundles/${bundle.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: newStatus })
            });
            if (res.ok) {
                refresh();
            } else {
                alert("Failed to update status");
            }
        } catch (e) {
            alert("Error updating status");
        }
    };

    const toggleStorefront = async (bundle: any) => {
        try {
            const newStatus = !bundle.show_on_storefront;
            const res = await fetch(`/api/bundles/${bundle.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ show_on_storefront: newStatus })
            });
            if (res.ok) {
                refresh();
            } else {
                alert("Failed to update visibility");
            }
        } catch (e) {
            alert("Error updating visibility");
        }
    };

    return (
        <div className="space-y-4">
            {/* Actions Bar - Simplified for brevity */}
            <div className="flex gap-4 items-center bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                <button
                    onClick={async () => {
                        const res = await fetch('/api/bundles?full=true');
                        const data = await res.json();
                        // Handle both old (array) and new (object) formats for safety/compat
                        const exportData = Array.isArray(data) ? { bundles: data, catalogs: [] } : data;

                        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `freezeriq_export_${new Date().toISOString().split('T')[0]}.json`;
                        a.click();
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg text-sm font-bold text-slate-700 dark:text-slate-300 transition-colors"
                >
                    Export JSON
                </button>
            </div>

            <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="p-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 bg-adaptive flex items-center gap-3">
                    <Search size={18} className="text-slate-400 dark:text-slate-500" />
                    <input
                        className="bg-transparent outline-none text-sm w-full text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500"
                        placeholder="Search bundles by name or SKU..."
                    />
                </div>

                {bundles.length === 0 ? (
                    <div className="p-12 text-center">
                        <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 text-slate-400 dark:text-slate-500 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Package size={32} />
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 dark:text-white">No Bundles Found</h3>
                        <p className="text-slate-500 dark:text-slate-400 mb-6">Change your filter or create a new bundle.</p>
                    </div>
                ) : (
                    <table className="w-full">
                        <thead className="bg-slate-50 dark:bg-slate-900 bg-adaptive text-slate-500 dark:text-slate-400 text-xs font-semibold uppercase tracking-wider text-left border-b border-slate-200 dark:border-slate-700">
                            <tr>
                                <th className="px-6 py-3 pl-6">Name</th>
                                <th className="px-6 py-3">SKU</th>
                                <th className="px-6 py-3 text-center">Recipes</th>
                                <th className="px-6 py-3 text-center">Storefront</th>
                                <th className="px-6 py-3 text-right">Price</th>
                                <th className="px-6 py-3 text-center">Status</th>
                                <th className="px-6 py-3"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                            {bundles.map((bundle) => (
                                <tr key={bundle.id} className="group hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                                                <Package size={20} />
                                            </div>
                                            <div>
                                                <div className="font-medium text-slate-900 dark:text-white text-adaptive">{bundle.name}</div>
                                                <div className="text-xs text-slate-500 dark:text-slate-400 text-adaptive-subtle truncate max-w-xs">{bundle.description || 'No description'}</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="font-mono text-sm text-slate-600 dark:text-slate-400">{bundle.sku}</span>
                                    </td>
                                    <td className="px-6 py-4 text-center text-sm text-slate-600 dark:text-slate-400">
                                        {bundle._count?.contents || 0} items
                                    </td>
                                    <td className="px-6 py-4 text-center">
                                        <button
                                            onClick={() => toggleStorefront(bundle)}
                                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${bundle.show_on_storefront ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-slate-700'}`}
                                        >
                                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${bundle.show_on_storefront ? 'translate-x-6' : 'translate-x-1'}`} />
                                        </button>
                                    </td>
                                    <td className="px-6 py-4 text-right text-sm font-medium text-slate-900 dark:text-white">
                                        ${Number(bundle.menu_price || 0).toFixed(2)}
                                    </td>
                                    <td className="px-6 py-4 text-center">
                                        <span className={`px-2 py-1 rounded-full text-xs font-bold ${bundle.is_active !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                                            {bundle.is_active !== false ? 'Active' : 'Inactive'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-right flex items-center justify-end gap-3">
                                        <button
                                            onClick={() => toggleStatus(bundle)}
                                            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                                            title={bundle.is_active !== false ? "Archive Bundle" : "Activate Bundle"}
                                        >
                                            {bundle.is_active !== false ? <Archive size={18} /> : <ArchiveRestore size={18} />}
                                        </button>
                                        <Link href={`/bundles/${bundle.id}`} className="text-indigo-600 font-medium text-sm hover:underline">Edit</Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

function CatalogsList({ catalogs, isLoading }: { catalogs: any[], isLoading: boolean }) {
    if (isLoading) return <div className="p-8 text-center text-slate-500">Loading catalogs...</div>;

    if (catalogs.length === 0) {
        return (
            <div className="col-span-full py-20 text-center bg-slate-50 dark:bg-slate-800/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-700">
                <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center mx-auto mb-4 text-slate-400">
                    <BookOpen size={32} />
                </div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">No Catalogs Yet</h3>
                <p className="text-slate-500 dark:text-slate-400">Create a catalog to organize your bundles.</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {catalogs.map((catalog) => (
                <Link
                    href={`/bundles/catalogs/${catalog.id}`}
                    key={catalog.id}
                    className="group bg-white dark:bg-slate-800 rounded-3xl p-6 border border-slate-200 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-500 transition-all hover:shadow-xl relative overflow-hidden block"
                >
                    <div className="flex justify-between items-start mb-4">
                        <div className="p-3 bg-indigo-50 dark:bg-indigo-900/30 rounded-2xl text-indigo-600 dark:text-indigo-400">
                            <BookOpen size={20} />
                        </div>
                        <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${catalog.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                            {catalog.is_active ? 'Active' : 'Archived'}
                        </span>
                    </div>

                    <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                        {catalog.name}
                    </h3>

                    <div className="space-y-3 mb-6">
                        <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400 text-sm font-medium">
                            <Calendar size={16} />
                            <span>
                                {new Date(catalog.start_date).toLocaleDateString()} - {new Date(catalog.end_date).toLocaleDateString()}
                            </span>
                        </div>
                        <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400 text-sm font-medium">
                            <Package size={16} />
                            <span>{catalog._count?.bundles || 0} Bundles Assigned</span>
                        </div>
                    </div>
                </Link>
            ))}
        </div>
    );
}
