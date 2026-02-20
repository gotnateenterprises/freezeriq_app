import { Plus, Minus, Package, Trash2, ExternalLink } from 'lucide-react';

interface PackagingItem {
    id: string;
    name: string;
    quantity: number;
    reorderUrl?: string | null;
    lowStockThreshold: number;
    type: string;
    cost_per_unit: number;
    defaultLabelId?: string | null;
}

interface PackagingTableProps {
    packaging: PackagingItem[];
    newPkgName: string;
    setNewPkgName: (name: string) => void;
    newPkgType: string;
    setNewPkgType: (type: string) => void;
    newPkgCost: string;
    setNewPkgCost: (cost: string) => void;
    newPkgStock: string;
    setNewPkgStock: (stock: string) => void;
    addPackaging: () => void;
    updatePackaging: (id: string, updates: Partial<PackagingItem>) => void;
    deletePackaging: (id: string, name: string) => void;
    PKG_TYPES: { value: string; label: string }[];
}

export default function PackagingTable({
    packaging,
    newPkgName,
    setNewPkgName,
    newPkgType,
    setNewPkgType,
    newPkgCost,
    setNewPkgCost,
    newPkgStock,
    setNewPkgStock,
    addPackaging,
    updatePackaging,
    deletePackaging,
    PKG_TYPES
}: PackagingTableProps) {
    return (
        <>
            <div className="glass-panel rounded-3xl p-6 mb-6 bg-white/50 dark:bg-slate-800/40 border border-white/40 dark:border-slate-700/50">
                <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                        <Plus size={20} strokeWidth={3} />
                    </div>
                    <h3 className="font-black text-xl text-slate-900 dark:text-white text-adaptive">Add New Packaging</h3>
                </div>
                <div className="flex flex-col md:flex-row gap-4 items-end">
                    <div className="flex-1 w-full">
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">Name</label>
                        <input
                            value={newPkgName}
                            onChange={(e) => setNewPkgName(e.target.value)}
                            placeholder="e.g. Large Thermal Box"
                            className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium transition-all"
                        />
                    </div>
                    <div className="w-full md:w-48">
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">Type</label>
                        <select
                            value={newPkgType}
                            onChange={(e) => setNewPkgType(e.target.value)}
                            className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-medium transition-all cursor-pointer"
                        >
                            {PKG_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </div>
                    <div className="w-full md:w-32">
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">Cost ($)</label>
                        <input
                            type="number"
                            step="0.01"
                            value={newPkgCost}
                            onChange={(e) => setNewPkgCost(e.target.value)}
                            placeholder="0.00"
                            className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium transition-all"
                        />
                    </div>
                    <div className="w-full md:w-32">
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">Stock</label>
                        <input
                            type="number"
                            value={newPkgStock}
                            onChange={(e) => setNewPkgStock(e.target.value)}
                            placeholder="0"
                            className="w-full px-4 py-3 border border-slate-200 dark:border-slate-600 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium transition-all"
                        />
                    </div>
                    <button
                        onClick={addPackaging}
                        className="bg-indigo-500 hover:bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-indigo-500/20 active:scale-95 transition-all flex items-center justify-center h-[50px] w-full md:w-auto"
                    >
                        <Plus size={24} strokeWidth={2.5} />
                    </button>
                </div>
            </div>

            <div className="glass-panel rounded-3xl bg-white/80 dark:bg-slate-900/60 border border-white/40 dark:border-slate-700/50 shadow-sm backdrop-blur-xl">
                <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 sticky top-0 z-20 shadow-md">
                        <tr>
                            <th className="px-6 py-5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Packaging Name</th>
                            <th className="px-6 py-5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Type</th>
                            <th className="px-6 py-5 text-right text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Cost ($)</th>
                            <th className="px-6 py-5 text-center text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Stock Qty</th>
                            <th className="px-6 py-5 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-slate-700">Reorder URL</th>
                            <th className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 text-right"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                        {packaging.map(pkg => (
                            <tr key={pkg.id} className="hover:bg-indigo-50/50 dark:hover:bg-slate-800/40 transition-colors group">
                                <td className="px-6 py-4">
                                    <input
                                        type="text"
                                        value={pkg.name}
                                        onChange={(e) => updatePackaging(pkg.id, { name: e.target.value })}
                                        className="w-full px-3 py-2 bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 rounded-lg outline-none transition font-bold text-slate-700 dark:text-slate-200"
                                    />
                                </td>
                                <td className="px-6 py-4">
                                    <select
                                        value={pkg.type}
                                        onChange={(e) => updatePackaging(pkg.id, { type: e.target.value })}
                                        className="w-full px-2 py-2 border border-transparent hover:border-slate-300 dark:hover:border-slate-600 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none bg-transparent text-slate-600 dark:text-slate-400 font-medium cursor-pointer"
                                    >
                                        {PKG_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                    </select>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <div className="flex items-center justify-end gap-2">
                                        <span className="text-slate-400 font-medium">$</span>
                                        <input
                                            type="number"
                                            step="0.01"
                                            value={pkg.cost_per_unit || ''}
                                            onChange={(e) => updatePackaging(pkg.id, { cost_per_unit: Number(e.target.value) })}
                                            placeholder="0.00"
                                            className="w-24 text-right px-3 py-2 border border-slate-200 dark:border-slate-600/50 bg-slate-50/50 dark:bg-slate-800/50 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-slate-900 dark:text-white font-medium"
                                        />
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-center">
                                    <div className="flex items-center justify-center gap-2">
                                        <button
                                            onClick={() => updatePackaging(pkg.id, { quantity: Math.max(0, (pkg.quantity || 0) - 1) })}
                                            className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-all"
                                        >
                                            <Minus size={16} />
                                        </button>
                                        <span className="font-bold w-12 text-center text-slate-800 dark:text-white">{pkg.quantity}</span>
                                        <button
                                            onClick={() => updatePackaging(pkg.id, { quantity: (pkg.quantity || 0) + 1 })}
                                            className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-all"
                                        >
                                            <Plus size={16} />
                                        </button>
                                    </div>
                                </td>
                                <td className="px-6 py-4">
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="text"
                                            value={pkg.reorderUrl || ''}
                                            onChange={(e) => updatePackaging(pkg.id, { reorderUrl: e.target.value })}
                                            placeholder="Paste URL..."
                                            className="w-full px-3 py-2 bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 rounded-lg outline-none transition text-sm text-slate-500 dark:text-slate-400"
                                        />
                                        {pkg.reorderUrl && (
                                            <a href={pkg.reorderUrl} target="_blank" className="text-indigo-500 hover:text-indigo-600 p-2 hover:bg-indigo-50 rounded-lg">
                                                <ExternalLink size={16} />
                                            </a>
                                        )}
                                    </div>
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <button
                                        onClick={() => deletePackaging(pkg.id, pkg.name)}
                                        className="text-slate-400 hover:text-rose-500 p-2 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-all"
                                        title="Delete Packaging"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {packaging.length === 0 && (
                    <div className="p-12 text-center">
                        <Package size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                        <h3 className="text-lg font-bold text-slate-500">No packaging items yet</h3>
                        <p className="text-slate-400">Add trays, boxes, lids, and bags above.</p>
                    </div>
                )}
            </div>
        </>
    );
}
