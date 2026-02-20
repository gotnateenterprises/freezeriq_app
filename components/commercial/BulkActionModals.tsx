import { Trash2, Merge } from 'lucide-react';

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

interface BulkPreviewItem {
    id: string;
    name: string;
    oldCost: number;
    newCost: number;
    match: boolean;
}

interface BulkPasteModalProps {
    showBulkPaste: boolean;
    setShowBulkPaste: (show: boolean) => void;
    pasteContent: string;
    setPasteContent: (content: string) => void;
    bulkPreview: BulkPreviewItem[];
    setBulkPreview: (preview: BulkPreviewItem[]) => void;
    parseBulkData: () => void;
    applyBulkData: () => void;
}

export function BulkPasteModal({
    showBulkPaste,
    setShowBulkPaste,
    pasteContent,
    setPasteContent,
    bulkPreview,
    setBulkPreview,
    parseBulkData,
    applyBulkData
}: BulkPasteModalProps) {
    if (!showBulkPaste) return null;

    return (
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
                                                <td className="p-3 font-medium text-slate-900 dark:text-white">
                                                    <div className="flex flex-col">
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-bold text-slate-900 dark:text-white">{item.name}</span>
                                                        </div>
                                                    </div>
                                                </td>
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
    );
}

interface MergeModalProps {
    mergeSource: Ingredient | null;
    setMergeSource: (ing: Ingredient | null) => void;
    mergeTargetId: string;
    setMergeTargetId: (id: string) => void;
    ingredients: Ingredient[];
    handleMerge: () => void;
    isSaving: boolean;
}

export function MergeModal({
    mergeSource,
    setMergeSource,
    mergeTargetId,
    setMergeTargetId,
    ingredients,
    handleMerge,
    isSaving
}: MergeModalProps) {
    if (!mergeSource) return null;

    return (
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
    );
}
