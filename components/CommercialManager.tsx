"use client";

import { useState } from 'react';
import { Save, Plus, Store, Package, Trash2, ExternalLink, Loader2, Copy, Merge } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Supplier {
    id: string;
    name: string;
    website_url?: string | null;
}

interface Ingredient {
    id: string;
    name: string;
    cost_per_unit: number;
    unit: string;
    stock_quantity: number;
    supplier_id: string | null;
    sku?: string | null;
    purchase_unit?: string | null;
    purchase_quantity?: number | null;
    purchase_cost?: number | null;
}

export default function CommercialManager({ initialSuppliers, initialIngredients }: { initialSuppliers: Supplier[], initialIngredients: Ingredient[] }) {
    const [activeTab, setActiveTab] = useState<'ingredients' | 'suppliers'>('ingredients');
    const [suppliers, setSuppliers] = useState(initialSuppliers);
    const [ingredients, setIngredients] = useState(initialIngredients);
    const [isSaving, setIsSaving] = useState(false);
    const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
    const router = useRouter();

    // State for new supplier
    const [newSupplierName, setNewSupplierName] = useState('');
    // State for new ingredient
    const [newIngName, setNewIngName] = useState('');
    const [newIngSku, setNewIngSku] = useState('');
    const [newIngCost, setNewIngCost] = useState('');
    const [newIngUnit, setNewIngUnit] = useState('oz');

    // Common Units
    const UNIT_OPTIONS = ['g', 'oz', 'lb', 'kg', 'ml', 'L', 'fl oz', 'cup', 'tbsp', 'tsp', 'each', 'can', 'pack', 'case', 'bunch'];

    const handleUpdateIngredient = (id: string, field: 'name' | 'cost_per_unit' | 'supplier_id' | 'unit' | 'stock_quantity' | 'sku' | 'purchase_unit' | 'purchase_quantity' | 'purchase_cost', value: any) => {
        setIngredients(prev => prev.map(ing => {
            if (ing.id !== id) return ing;

            const next = { ...ing, [field]: (field === 'cost_per_unit' || field === 'stock_quantity' || field === 'purchase_quantity' || field === 'purchase_cost') ? Number(value) : value };

            // Auto-Calculate Unit Cost if Purchase Params Change
            if (field === 'purchase_cost' || field === 'purchase_quantity') {
                const pCost = field === 'purchase_cost' ? Number(value) : (next.purchase_cost || 0);
                const pQty = field === 'purchase_quantity' ? Number(value) : (next.purchase_quantity || 1);

                if (pQty > 0) {
                    next.cost_per_unit = Number((pCost / pQty).toFixed(2));
                }
            }
            return next;
        }));
    };

    // Helper for Deep Linking
    const getSupplierSearchUrl = (baseUrl: string, query: string) => {
        if (!baseUrl) return null;
        const lowerUrl = baseUrl.toLowerCase();
        const encodedQuery = encodeURIComponent(query);
        const encodedQueryPlus = query.split(' ').map(encodeURIComponent).join('+'); // Some sites use +

        // GFS Specific Logic
        if (lowerUrl.includes('gfs') || lowerUrl.includes('gordon')) {
            // Check Local Settings
            const portalPref = localStorage.getItem('gfsPortalType') || 'gfs_store';
            const customUrl = localStorage.getItem('customGfsUrl');

            if (portalPref === 'custom' && customUrl) {
                return customUrl.includes('?')
                    ? `${customUrl}&q=${encodedQuery}`
                    : `${customUrl}/search?q=${encodedQuery}`;
            }

            if (portalPref === 'gordon_ordering') {
                // Updated Commercial Portal (Safe Fallback)
                return `https://apps.gfs.com/doc/go/search?q=${encodedQuery}`;
            } else if (portalPref === 'gordon_experience') {
                return `https://gordonexperience.com/search?q=${encodedQuery}`;
            } else {
                // Public Store (default)
                return `https://gfsstore.com/products/?query=${encodedQuery}`;
            }
        }

        if (lowerUrl.includes('amazon')) {
            return `https://www.amazon.com/s?k=${encodedQuery}`;
        }
        if (lowerUrl.includes('webstaurantstore')) {
            return `https://www.webstaurantstore.com/search/${encodedQuery}.html`;
        }
        if (lowerUrl.includes('sysco')) {
            return `https://www.sysco.com/search?q=${encodedQuery}`;
        }
        // Generic Fallback
        if (!lowerUrl.includes('/')) { // e.g. "example.com"
            return `https://${baseUrl}/search?q=${encodedQuery}`;
        }

        return baseUrl;
    };


    const saveChanges = async () => {
        setIsSaving(true);
        try {
            const res = await fetch('/api/commercial/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ingredients, suppliers })
            });

            if (!res.ok) {
                let errorData: any = {};
                try {
                    errorData = await res.json();
                } catch (e) {
                    throw new Error(`Server Error (Status ${res.status}): ${await res.text() || "No response body"}`);
                }
                const err: any = new Error(errorData.error || `Failed to save (Status ${res.status})`);
                err.code = errorData.code;
                throw err;
            }
            alert("Saved Successfully!");
            router.refresh();
        } catch (e: any) {
            let msg = e.message;
            if (e.code) msg += ` (Code: ${e.code})`;
            alert(`Error saving changes: ${msg}`);
        } finally {
            setIsSaving(false);
        }
    };

    const downloadData = () => {
        const data = {
            date: new Date().toISOString(),
            ingredients,
            suppliers
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `freezeriq_backup_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const json = JSON.parse(event.target?.result as string);
                if (json.ingredients && Array.isArray(json.ingredients)) {
                    if (confirm(`Found ${json.ingredients.length} ingredients and ${json.suppliers?.length || 0} suppliers.\nReplace current list?`)) {
                        setIngredients(json.ingredients);
                        if (json.suppliers) setSuppliers(json.suppliers);

                        // Optional: Auto-save immediately to persist
                        // await saveChanges(); 
                        alert("Imported! Click 'Save Changes' to persist to database.");
                    }
                } else {
                    alert("Invalid backup file format.");
                }
            } catch (err) {
                alert("Failed to parse file.");
            }
        };
        reader.readAsText(file);
    };

    const handleSaveSingle = async (id: string) => {
        const ing = ingredients.find(i => i.id === id);
        if (!ing) return;

        setSavingIds(prev => new Set(prev).add(id));
        try {
            const res = await fetch('/api/commercial/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ingredients: [ing], suppliers })
            });

            if (!res.ok) {
                let errorData: any = {};
                try {
                    errorData = await res.json();
                } catch (e) {
                    throw new Error(`Server Error (Status ${res.status}): ${await res.text() || "No response body"}`);
                }
                const err: any = new Error(errorData.error || `Failed to save item (Status ${res.status})`);
                err.code = errorData.code;
                throw err;
            }
        } catch (e: any) {
            let msg = e.message;
            if (e.code) msg += ` (Code: ${e.code})`;
            alert(`Error saving item: ${msg}`);
        } finally {
            setSavingIds(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const addSupplier = async () => {
        if (!newSupplierName.trim()) return;
        try {
            const res = await fetch('/api/commercial/suppliers/create', {
                method: 'POST',
                body: JSON.stringify({ name: newSupplierName })
            });
            const newSup = await res.json();
            setSuppliers(prev => [...prev, newSup]);
            setNewSupplierName('');
        } catch (e) {
            alert("Error adding supplier");
            alert("Error adding supplier");
        }
    }

    const addIngredient = async () => {
        if (!newIngName.trim()) return;
        try {
            const res = await fetch('/api/commercial/ingredients/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newIngName,
                    cost_per_unit: Number(newIngCost),
                    unit: newIngUnit,
                    sku: newIngSku || undefined
                })
            });
            if (!res.ok) throw new Error("Failed");
            const newIng = await res.json();
            setIngredients(prev => [newIng, ...prev]); // Add to top
            setNewIngName('');
            setNewIngSku('');
            setNewIngCost('');
        } catch (e) {
            alert("Error adding ingredient");
        }
    }

    const confirmDelete = async (id: string, name: string) => {
        if (confirm(`Are you sure you want to delete "${name}"?\nThis cannot be undone.`)) {
            try {
                const res = await fetch('/api/commercial/ingredients/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                const data = await res.json();
                if (data.error) {
                    alert(data.error);
                } else {
                    setIngredients(prev => prev.filter(i => i.id !== id));
                }
            } catch (e) {
                alert("Failed to delete.");
            }
        }
    };

    // Bulk Paste State
    const [showBulkPaste, setShowBulkPaste] = useState(false);
    const [pasteContent, setPasteContent] = useState('');
    const [bulkPreview, setBulkPreview] = useState<{ id: string, name: string, oldCost: number, newCost: number, match: boolean }[]>([]);

    // Merge State
    const [mergeSource, setMergeSource] = useState<Ingredient | null>(null);
    const [mergeTargetId, setMergeTargetId] = useState('');

    const handleMerge = async () => {
        if (!mergeSource || !mergeTargetId) return;

        const targetName = ingredients.find(i => i.id === mergeTargetId)?.name;

        if (!confirm(`MERGE WARNING:\n\nAre you sure you want to merge "${mergeSource.name}" INTO "${targetName}"?\n\n"${mergeSource.name}" will be DELETED and all recipes using it will now use "${targetName}".\n\nThis cannot be undone.`)) {
            return;
        }

        setIsSaving(true);
        try {
            const res = await fetch('/api/commercial/ingredients/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceId: mergeSource.id, targetId: mergeTargetId })
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error);

            // Update Local State
            setIngredients(prev => prev.filter(i => i.id !== mergeSource.id));
            setMergeSource(null);
            setMergeTargetId('');
            alert("Merged successfully!");
            router.refresh();
        } catch (e: any) {
            alert("Merge failed: " + e.message);
        } finally {
            setIsSaving(false);
        }
    };

    const parseBulkData = () => {
        const lines = pasteContent.split(/\r?\n/).filter(l => l.trim());
        const preview = [];

        for (const line of lines) {
            // Assume Tab Separated (Excel/Sheets default)
            const cols = line.split('\t').map(c => c.trim());
            if (cols.length < 2) continue; // Need at least Name and Cost

            // Simple Heuristic: 
            // If Col 0 is text and Col 1 is number -> Name | Cost
            // If Col 1 is text and Col 0 is text -> Name | Unit (skip cost?) - Let's stick to Name | Cost

            const name = cols[0];
            // Remove '$' and ',' if present
            const costStr = cols[1].replace(/[$,]/g, '');
            const cost = parseFloat(costStr);

            if (!name || isNaN(cost)) continue;

            // Find Match
            const match = ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());

            if (match) {
                preview.push({
                    id: match.id,
                    name: match.name,
                    oldCost: match.cost_per_unit,
                    newCost: cost,
                    match: true
                });
            } else {
                preview.push({
                    id: 'new_' + Math.random(),
                    name: name,
                    oldCost: 0,
                    newCost: cost,
                    match: false
                });
            }
        }
        setBulkPreview(preview);
    };

    const applyBulkData = () => {
        const updates = new Map(bulkPreview.filter(p => p.match).map(p => [p.id, p]));

        setIngredients(prev => prev.map(ing => {
            const update = updates.get(ing.id);
            if (update) {
                return { ...ing, cost_per_unit: update.newCost };
            }
            return ing;
        }));

        setShowBulkPaste(false);
        setPasteContent('');
        setBulkPreview([]);
        alert(`Updated ${updates.size} ingredients! Don't forget to click "Save Changes".`);
    };

    return (
        <div className="space-y-6">

            {/* Bulk Paste Modal */}
            {showBulkPaste && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-slate-200 dark:border-slate-700">
                        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center">
                            <div>
                                <h3 className="text-xl font-black text-slate-900 dark:text-white">Bulk Update Costs</h3>
                                <p className="text-sm text-slate-500">Copy 2 columns from Excel: <strong>Name</strong> and <strong>Cost</strong></p>
                            </div>
                            <button onClick={() => setShowBulkPaste(false)} className="text-slate-400 hover:text-slate-600">
                                <Trash2 size={24} className="rotate-45" /> {/* Close Icon Hack */}
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {!bulkPreview.length ? (
                                <div>
                                    <textarea
                                        value={pasteContent}
                                        onChange={(e) => setPasteContent(e.target.value)}
                                        placeholder={`Example:\nOnions\t0.50\nGarlic\t3.00\nTomatoes\t1.25`}
                                        className="w-full h-64 p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl font-mono text-sm resize-none focus:ring-2 focus:ring-indigo-500 outline-none"
                                    />
                                    <button
                                        onClick={parseBulkData}
                                        disabled={!pasteContent.trim()}
                                        className="mt-4 w-full bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50 hover:bg-indigo-700"
                                    >
                                        Preview Updates
                                    </button>
                                </div>
                            ) : (
                                <div>
                                    <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl flex gap-8 mb-4 text-sm font-bold text-indigo-900 dark:text-indigo-200">
                                        <span>Found matches: {bulkPreview.filter(p => p.match).length}</span>
                                        <span className="opacity-50">|</span>
                                        <span className="text-rose-600 dark:text-rose-400">No match: {bulkPreview.filter(p => !p.match).length}</span>
                                    </div>

                                    <div className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
                                        <table className="w-full text-sm text-left">
                                            <thead className="bg-slate-50 dark:bg-slate-800 font-bold text-slate-500">
                                                <tr>
                                                    <th className="p-3">Ingredient</th>
                                                    <th className="p-3 text-right">Old Cost</th>
                                                    <th className="p-3 text-right">New Cost</th>
                                                    <th className="p-3">Status</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                                                {bulkPreview.map((item, i) => (
                                                    <tr key={i} className={!item.match ? 'bg-rose-50/50 dark:bg-rose-900/10' : ''}>
                                                        <td className="p-3 font-medium text-slate-900 dark:text-white">{item.name}</td>
                                                        <td className="p-3 text-right text-slate-400">${item.oldCost.toFixed(2)}</td>
                                                        <td className="p-3 text-right font-bold text-emerald-600">${item.newCost.toFixed(2)}</td>
                                                        <td className="p-3">
                                                            {item.match ? (
                                                                <span className="text-emerald-600 font-bold text-xs">UPDATE</span>
                                                            ) : (
                                                                <span className="text-rose-500 font-bold text-xs">NOT FOUND</span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>

                                    <div className="flex gap-4 mt-6">
                                        <button
                                            onClick={() => setBulkPreview([])}
                                            className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3 rounded-xl font-bold hover:bg-slate-200"
                                        >
                                            Back
                                        </button>
                                        <button
                                            onClick={applyBulkData}
                                            className="flex-1 bg-emerald-600 text-white py-3 rounded-xl font-bold hover:bg-emerald-700 shadow-lg shadow-emerald-500/20"
                                        >
                                            Apply {bulkPreview.filter(p => p.match).length} Updates
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}



            {/* Merge Modal */}
            {mergeSource && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                            <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                <Merge className="text-indigo-500" />
                                Merge Ingredient
                            </h3>
                            <p className="text-slate-500 mt-2">
                                Merging <strong>{mergeSource.name}</strong>...
                            </p>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Select Target Ingredient</label>
                                <select
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-medium"
                                    value={mergeTargetId}
                                    onChange={(e) => setMergeTargetId(e.target.value)}
                                >
                                    <option value="">-- Choose Ingredient to Keep --</option>
                                    {[...ingredients]
                                        .filter(i => i.id !== mergeSource.id) // Exclude self
                                        .sort((a, b) => a.name.localeCompare(b.name))
                                        .map(i => (
                                            <option key={i.id} value={i.id}>{i.name}</option>
                                        ))}
                                </select>
                            </div>
                            <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-xl text-xs text-amber-800 dark:text-amber-200 font-medium leading-relaxed">
                                <strong className="block mb-1 text-amber-900 dark:text-amber-100 uppercase">Warning</strong>
                                You are about to merge "{mergeSource.name}" into the selected ingredient. "{mergeSource.name}" will be <strong>permanently deleted</strong>, and any recipes using it will be updated to use the selected ingredient instead.
                            </div>
                        </div>
                        <div className="p-6 bg-slate-50 dark:bg-slate-800/50 flex gap-3 justify-end">
                            <button
                                onClick={() => setMergeSource(null)}
                                className="px-5 py-2.5 font-bold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleMerge}
                                disabled={!mergeTargetId || isSaving}
                                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center gap-2"
                            >
                                {isSaving ? 'Merging...' : 'Confirm Merge'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header / Tabs */}
            <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                <div className="flex gap-4">
                    <button
                        onClick={() => setActiveTab('ingredients')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition ${activeTab === 'ingredients' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                    >
                        <Package size={18} />
                        Ingredients & Costs
                    </button>
                    <button
                        onClick={() => setActiveTab('suppliers')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition ${activeTab === 'suppliers' ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                    >
                        <Store size={18} />
                        Suppliers
                    </button>
                </div>
                <div className="flex gap-3">
                    <label className="flex items-center gap-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white px-3 py-2 rounded-lg font-bold transition-colors cursor-pointer" title="Import from JSON">
                        <input type="file" accept=".json" onChange={handleImport} className="hidden" />
                        <Package size={18} /> {/* Reusing icon for Import/Upload feel */}
                        Import
                    </label>
                    <button
                        onClick={downloadData}
                        className="flex items-center gap-2 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white px-3 py-2 rounded-lg font-bold transition-colors"
                        title="Export to JSON"
                    >
                        <ExternalLink size={18} />
                        Export
                    </button>
                </div>
            </div>

            {/* Ingredients Table */}

            {activeTab === 'ingredients' && (
                <>
                    {/* Add New Ingredient */}
                    <div className="glass-panel rounded-3xl p-6 mb-6 bg-white/50 dark:bg-slate-800/40 border border-white/40 dark:border-slate-700/50">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="w-10 h-10 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                <Plus size={20} strokeWidth={3} />
                            </div>
                            <h3 className="font-black text-xl text-slate-900 dark:text-white text-adaptive">Add New Ingredient</h3>
                        </div>
                        <div className="flex flex-col md:flex-row gap-4 items-end">
                            <div className="flex-1 w-full">
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">Name</label>
                                <input
                                    value={newIngName}
                                    onChange={(e) => setNewIngName(e.target.value)}
                                    placeholder="e.g. Saffron"
                                    className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium transition-all"
                                />
                            </div>
                            <div className="w-full md:w-40">
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">SKU</label>
                                <input
                                    value={newIngSku}
                                    onChange={(e) => setNewIngSku(e.target.value)}
                                    placeholder="Optional"
                                    className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium transition-all"
                                />
                            </div>
                            <div className="w-full md:w-40">
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">Cost ($)</label>
                                <input
                                    type="number"
                                    step="0.01"
                                    value={newIngCost}
                                    onChange={(e) => setNewIngCost(e.target.value)}
                                    placeholder="0.00"
                                    className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium transition-all"
                                />
                            </div>
                            <div className="w-full md:w-32">
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">Unit</label>
                                <select
                                    value={newIngUnit}
                                    onChange={(e) => setNewIngUnit(e.target.value)}
                                    className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-medium transition-all cursor-pointer"
                                >
                                    {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
                                </select>
                            </div>
                            <button
                                onClick={addIngredient}
                                className="bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-emerald-500/20 active:scale-95 transition-all flex items-center justify-center h-[50px] w-full md:w-auto"
                            >
                                <Plus size={24} strokeWidth={2.5} />
                            </button>
                        </div>
                    </div>

                    <div className="glass-panel rounded-3xl bg-white/80 dark:bg-slate-900/60 border border-white/40 dark:border-slate-700/50 shadow-sm backdrop-blur-xl">
                        <table className="w-full text-left border-collapse">
                            {/* Force Refresh Trace: 123 */}
                            <thead className="bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 sticky top-0 z-20 shadow-md">
                                <tr>
                                    <th className="px-6 py-5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Ingredient Name</th>
                                    <th className="px-6 py-5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">SKU</th>
                                    <th className="px-6 py-5 text-right text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Purchase Cost</th>
                                    <th className="px-6 py-5 text-center text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Pack Size</th>
                                    <th className="px-6 py-5 text-right text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Cost / Unit</th>
                                    <th className="px-6 py-5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Stock Qty</th>
                                    <th className="px-6 py-5 pl-8 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Usage Unit</th>
                                    <th className="px-6 py-5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Supplier</th>
                                    <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 text-right">
                                        <button
                                            onClick={saveChanges}
                                            disabled={isSaving}
                                            className="inline-flex items-center gap-2 bg-emerald-600 text-white px-4 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 font-bold shadow-md shadow-emerald-600/20 text-xs whitespace-nowrap transition-all transform hover:scale-105"
                                        >
                                            <Save size={14} />
                                            {isSaving ? 'Saving' : 'Save'}
                                        </button>
                                    </th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                                {[...ingredients].sort((a, b) => a.name.localeCompare(b.name)).map((ing, index) => (
                                    <tr
                                        key={ing.id}
                                        className="hover:bg-indigo-50/50 dark:hover:bg-slate-800/40 transition-colors group"
                                    >
                                        <td className="px-6 py-4">
                                            <input
                                                type="text"
                                                value={ing.name}
                                                onChange={(e) => handleUpdateIngredient(ing.id, 'name', e.target.value)}
                                                className="w-full px-3 py-2 bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 rounded-lg outline-none transition font-bold text-slate-700 dark:text-slate-200"
                                            />
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="text"
                                                    value={ing.sku || ''}
                                                    onChange={(e) => handleUpdateIngredient(ing.id, 'sku', e.target.value)}
                                                    placeholder="-"
                                                    className="w-24 px-3 py-2 bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 rounded-lg outline-none transition font-medium text-slate-900 dark:text-white"
                                                />
                                                {((ing as any).sku) && (
                                                    <button
                                                        onClick={() => navigator.clipboard.writeText(ing.sku || '')}
                                                        className="p-1.5 text-slate-400 hover:text-indigo-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-all"
                                                        title="Copy SKU"
                                                    >
                                                        <Copy size={14} />
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <span className="text-slate-400 font-medium">$</span>
                                                <input
                                                    type="number"
                                                    step="0.01"
                                                    value={ing.purchase_cost || ''}
                                                    onChange={(e) => handleUpdateIngredient(ing.id, 'purchase_cost', e.target.value)}
                                                    placeholder="0.00"
                                                    className="w-24 text-right px-3 py-2 border border-slate-200 dark:border-slate-600/50 bg-slate-50/50 dark:bg-slate-800/50 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-slate-900 dark:text-white font-medium"
                                                />
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center justify-center gap-2 bg-transparent p-2 rounded-lg border border-slate-200 dark:border-slate-700">
                                                <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">1</span>
                                                <input
                                                    value={ing.purchase_unit || ''}
                                                    onChange={(e) => handleUpdateIngredient(ing.id, 'purchase_unit', e.target.value)}
                                                    placeholder="Case"
                                                    className="w-16 px-2 py-1 bg-transparent border border-slate-200 dark:border-slate-600 rounded text-center text-xs font-medium text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:ring-1 focus:ring-indigo-500 outline-none"
                                                />
                                                <span className="text-slate-500 dark:text-slate-400 font-bold text-xs">=</span>
                                                <input
                                                    type="number"
                                                    value={ing.purchase_quantity || ''}
                                                    onChange={(e) => handleUpdateIngredient(ing.id, 'purchase_quantity', e.target.value)}
                                                    placeholder="1"
                                                    className="w-14 px-2 py-1 bg-transparent border border-slate-200 dark:border-slate-600 rounded text-center text-xs font-bold text-indigo-600 dark:text-indigo-400 focus:ring-1 focus:ring-indigo-500 outline-none"
                                                />
                                                <span className="text-slate-500 dark:text-slate-400 text-xs font-medium truncate max-w-[40px]" title={ing.unit}>{ing.unit}</span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <div className="flex flex-col items-end">
                                                <span className="font-mono font-bold text-slate-700 dark:text-slate-200">
                                                    ${Number(ing.cost_per_unit || 0).toFixed(2)}
                                                </span>
                                                <span className="text-[10px] text-slate-400 uppercase tracking-wider">
                                                    Per {ing.unit}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={ing.stock_quantity || 0}
                                                onChange={(e) => handleUpdateIngredient(ing.id, 'stock_quantity', e.target.value)}
                                                className="w-24 px-3 py-2 border border-emerald-200 dark:border-emerald-800/50 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none bg-emerald-50/50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 font-bold"
                                            />
                                        </td>
                                        <td className="px-6 py-4 pl-8">
                                            <select
                                                value={ing.unit}
                                                onChange={(e) => handleUpdateIngredient(ing.id, 'unit', e.target.value)}
                                                className="w-24 px-2 py-2 border border-transparent hover:border-slate-300 dark:hover:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none bg-transparent text-slate-600 dark:text-slate-400 font-medium cursor-pointer"
                                            >
                                                {UNIT_OPTIONS.map(u => (
                                                    <option key={u} value={u}>{u}</option>
                                                ))}
                                                {!UNIT_OPTIONS.includes(ing.unit) && <option value={ing.unit}>{ing.unit}</option>}
                                            </select>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-2">
                                                <select
                                                    value={ing.supplier_id || ''}
                                                    onChange={(e) => handleUpdateIngredient(ing.id, 'supplier_id', e.target.value || null)}
                                                    className="w-full bg-slate-50/50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600/50 text-slate-600 dark:text-slate-300 text-sm rounded-lg focus:ring-2 focus:ring-blue-500 block p-2.5 font-medium"
                                                >
                                                    <option value="">-- No Supplier --</option>
                                                    {suppliers.map((s) => (
                                                        <option key={s.id} value={s.id}>
                                                            {s.name}
                                                        </option>
                                                    ))}
                                                </select>
                                                {(() => {
                                                    const currentSup = suppliers.find(s => s.id === ing.supplier_id);
                                                    if (currentSup?.website_url) {
                                                        return (
                                                            <a
                                                                href={currentSup.website_url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="w-8 h-8 flex items-center justify-center bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition"
                                                                title={`Go to ${currentSup.name}`}
                                                            >
                                                                <ExternalLink size={16} strokeWidth={2.5} />
                                                            </a>
                                                        );
                                                    }
                                                    return null;
                                                })()}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-1">
                                                <button
                                                    onClick={() => handleSaveSingle(ing.id)}
                                                    disabled={savingIds.has(ing.id)}
                                                    className={`p-2 rounded-lg transition-all ${savingIds.has(ing.id) ? 'text-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'text-slate-300 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'}`}
                                                    title="Save Changes"
                                                >
                                                    {savingIds.has(ing.id) ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                                                </button>
                                                <button
                                                    onClick={() => confirmDelete(ing.id, ing.name)}
                                                    className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-all"
                                                    title="Delete Ingredient"
                                                >
                                                    <Trash2 size={18} />
                                                </button>
                                                <button
                                                    onClick={() => setMergeSource(ing)}
                                                    className="p-2 text-indigo-300 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-all"
                                                    title="Merge into another ingredient"
                                                >
                                                    <Merge size={18} />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}


            {/* Suppliers List */}
            {
                activeTab === 'suppliers' && (
                    <div className="max-w-xl">
                        <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 mb-6">
                            <h3 className="font-bold text-slate-900 dark:text-white text-adaptive mb-4">Add New Supplier</h3>
                            <div className="flex gap-4">
                                <input
                                    value={newSupplierName}
                                    onChange={(e) => setNewSupplierName(e.target.value)}
                                    placeholder="Supplier Name (e.g. Sysco)"
                                    className="flex-1 px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500"
                                />
                                <button
                                    onClick={addSupplier}
                                    className="bg-emerald-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-emerald-700"
                                >
                                    <Plus size={20} />
                                </button>
                            </div>
                        </div>

                        <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                            <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 font-bold text-slate-700 dark:text-slate-300">Existing Suppliers</div>
                            <ul className="divide-y divide-slate-100 dark:divide-slate-700">
                                {suppliers.map(s => (
                                    <li key={s.id} className="p-4 flex items-center gap-3">
                                        <Store size={18} className="text-slate-400" />
                                        <Link href={`/commercial/suppliers/${s.id}`} className="font-medium text-slate-900 dark:text-white text-adaptive hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline flex-1">
                                            {s.name}
                                        </Link>
                                    </li>
                                ))}
                                {suppliers.length === 0 && <li className="p-8 text-center text-slate-400">No suppliers yet.</li>}
                            </ul>
                        </div>
                    </div>
                )
            }
        </div >
    );
}
