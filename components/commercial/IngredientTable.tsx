import { useState } from 'react';
import { Plus, Minus, Search, Save, Copy, Merge, Trash2, ExternalLink, Loader2, PackagePlus } from 'lucide-react';

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
    needs_review?: boolean;
}

interface IngredientTableProps {
    ingredients: Ingredient[];
    suppliers: Supplier[];
    newIngName: string;
    setNewIngName: (name: string) => void;
    newIngSku: string;
    setNewIngSku: (sku: string) => void;
    newIngCost: string;
    setNewIngCost: (cost: string) => void;
    newIngUnit: string;
    setNewIngUnit: (unit: string) => void;
    addIngredient: () => void;
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    handleUpdateIngredient: (id: string, field: 'name' | 'cost_per_unit' | 'supplier_id' | 'unit' | 'stock_quantity' | 'sku' | 'purchase_unit' | 'purchase_quantity' | 'purchase_cost', value: any) => void;
    saveChanges: () => void;
    isSaving: boolean;
    savingIds: Set<string>;
    handleSaveSingle: (id: string) => void;
    confirmDelete: (id: string, name: string) => void;
    setMergeSource: (ing: Ingredient) => void;
    UNIT_OPTIONS: string[];
    handleAddCases: (id: string, caseCount: number) => void;
}

export default function IngredientTable({
    ingredients,
    suppliers,
    newIngName,
    setNewIngName,
    newIngSku,
    setNewIngSku,
    newIngCost,
    setNewIngCost,
    newIngUnit,
    setNewIngUnit,
    addIngredient,
    searchQuery,
    setSearchQuery,
    handleUpdateIngredient,
    saveChanges,
    isSaving,
    savingIds,
    handleSaveSingle,
    confirmDelete,
    setMergeSource,
    UNIT_OPTIONS,
    handleAddCases
}: IngredientTableProps) {
    const [addCasesId, setAddCasesId] = useState<string | null>(null);
    const [caseCount, setCaseCount] = useState('1');
    return (
        <>
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

            <div className="relative mb-6">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                    <Search size={20} />
                </div>
                <input
                    type="text"
                    placeholder="Search ingredients, SKUs, or suppliers..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-12 pr-4 py-4 bg-white/80 dark:bg-slate-900/60 border border-white/40 dark:border-slate-700/50 rounded-3xl shadow-sm backdrop-blur-xl focus:ring-2 focus:ring-indigo-500 outline-none font-medium transition-all text-adaptive"
                />
            </div>

            <div className="glass-panel rounded-3xl bg-white/80 dark:bg-slate-900/60 border border-white/40 dark:border-slate-700/50 shadow-sm backdrop-blur-xl">
                <table className="w-full text-left border-collapse">
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
                        {[...ingredients]
                            .filter(ing => {
                                const query = searchQuery.toLowerCase();
                                const supplierName = suppliers.find(s => s.id === ing.supplier_id)?.name.toLowerCase() || '';
                                return ing.name.toLowerCase().includes(query) ||
                                    (ing.sku?.toLowerCase().includes(query)) ||
                                    supplierName.includes(query);
                            })
                            .sort((a, b) => a.name.localeCompare(b.name))
                            .map((ing) => (
                                <tr
                                    key={ing.id}
                                    className="hover:bg-indigo-50/50 dark:hover:bg-slate-800/40 transition-colors group"
                                >
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="text"
                                                value={ing.name}
                                                onChange={(e) => handleUpdateIngredient(ing.id, 'name', e.target.value)}
                                                className="w-full px-3 py-2 bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 rounded-lg outline-none transition font-bold text-slate-700 dark:text-slate-200"
                                            />
                                            {ing.needs_review && (
                                                <span className="px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 text-[10px] font-black rounded-full border border-amber-200 dark:border-amber-800 animate-pulse whitespace-nowrap">
                                                    NEW ITEM
                                                </span>
                                            )}
                                        </div>
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
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => handleUpdateIngredient(ing.id, 'stock_quantity', Math.max(0, (ing.stock_quantity || 0) - 1))}
                                                className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-all"
                                                title="Decrease Stock"
                                            >
                                                <Minus size={16} />
                                            </button>
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={ing.stock_quantity || 0}
                                                onChange={(e) => handleUpdateIngredient(ing.id, 'stock_quantity', e.target.value)}
                                                className="w-20 px-2 py-2 border border-emerald-200 dark:border-emerald-800/50 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none bg-emerald-50/50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 font-bold text-center"
                                            />
                                            <button
                                                onClick={() => handleUpdateIngredient(ing.id, 'stock_quantity', (ing.stock_quantity || 0) + 1)}
                                                className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-all"
                                                title="Increase Stock"
                                            >
                                                <Plus size={16} />
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setAddCasesId(addCasesId === ing.id ? null : ing.id);
                                                    setCaseCount('1');
                                                }}
                                                className={`p-1.5 rounded-lg transition-all ${
                                                    addCasesId === ing.id
                                                        ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 dark:text-indigo-400'
                                                        : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                                                }`}
                                                title="Add Cases to Stock"
                                            >
                                                <PackagePlus size={16} />
                                            </button>
                                        </div>
                                        {addCasesId === ing.id && (
                                            <div className="mt-2 p-3 bg-indigo-50/80 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/50 rounded-xl space-y-2 animate-in fade-in slide-in-from-top-1">
                                                {(ing.purchase_quantity && ing.purchase_quantity > 0) ? (
                                                    <>
                                                        <div className="flex items-center gap-2">
                                                            <input
                                                                type="number"
                                                                min="1"
                                                                value={caseCount}
                                                                onChange={(e) => setCaseCount(e.target.value)}
                                                                className="w-16 px-2 py-1.5 border border-indigo-300 dark:border-indigo-700 rounded-lg text-center font-bold text-indigo-700 dark:text-indigo-300 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none text-sm"
                                                                autoFocus
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') {
                                                                        const count = parseInt(caseCount) || 0;
                                                                        if (count > 0) {
                                                                            handleAddCases(ing.id, count);
                                                                            setAddCasesId(null);
                                                                        }
                                                                    } else if (e.key === 'Escape') {
                                                                        setAddCasesId(null);
                                                                    }
                                                                }}
                                                            />
                                                            <span className="text-xs text-slate-500 dark:text-slate-400">
                                                                × {ing.purchase_quantity} = <strong className="text-emerald-600 dark:text-emerald-400">+{(parseInt(caseCount) || 0) * ing.purchase_quantity} {ing.unit}</strong>
                                                            </span>
                                                        </div>
                                                        <button
                                                            onClick={() => {
                                                                const count = parseInt(caseCount) || 0;
                                                                if (count > 0) {
                                                                    handleAddCases(ing.id, count);
                                                                    setAddCasesId(null);
                                                                }
                                                            }}
                                                            className="w-full px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold rounded-lg shadow-sm transition-all active:scale-95"
                                                        >
                                                            Add to Stock
                                                        </button>
                                                    </>
                                                ) : (
                                                    <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                                                        ⚠️ Set Pack Size first (in the Pack Size column)
                                                    </p>
                                                )}
                                            </div>
                                        )}
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
    );
}
