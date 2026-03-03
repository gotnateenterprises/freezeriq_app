import { useState } from 'react';
import { Plus, Minus, Search, Save, Copy, Merge, Trash2, ExternalLink, Loader2, Printer, X, Download } from 'lucide-react';

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
    UNIT_OPTIONS
}: IngredientTableProps) {
    const [showPrintModal, setShowPrintModal] = useState(false);
    const [printSupplierFilter, setPrintSupplierFilter] = useState('all');

    const [receiveModalIng, setReceiveModalIng] = useState<Ingredient | null>(null);
    const [receiveInput, setReceiveInput] = useState<string>('');

    const handleReceiveSubmit = () => {
        if (!receiveModalIng || receiveInput === '' || Number(receiveInput) <= 0) return;

        const packSize = receiveModalIng.purchase_quantity || 1;
        const amountToAdd = Number(receiveInput) * packSize;
        const newTotal = (receiveModalIng.stock_quantity || 0) + amountToAdd;

        handleUpdateIngredient(receiveModalIng.id, 'stock_quantity', newTotal);
        handleSaveSingle(receiveModalIng.id);

        setReceiveModalIng(null);
        setReceiveInput('');
    };

    const executePrint = () => {
        const sortedIngredients = [...ingredients]
            .filter(ing => {
                const query = searchQuery.toLowerCase();
                const supplierName = suppliers.find(s => s.id === ing.supplier_id)?.name.toLowerCase() || '';

                if (supplierName === 'batch recipe') {
                    return false;
                }

                if (printSupplierFilter !== 'all' && ing.supplier_id !== printSupplierFilter) {
                    return false;
                }

                return ing.name.toLowerCase().includes(query) ||
                    (ing.sku?.toLowerCase().includes(query)) ||
                    supplierName.includes(query);
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        const printWindow = window.open('', '_blank');
        if (!printWindow) return;

        // Using standard HTML namespace for SVG since we're generating static markup.
        // It's cleaner to build the QR SVG manually for print to avoid importing react-dom/server client-side if we can avoid it, but let's use a lightweight SVG generator or just raw output.
        // A simple raw SVG for QR code generation is tricky without a library, so we will use the `qrcode.react` library implicitly by creating an off-screen render or just a pure function.
        // Wait, qrcode.react exposes `QRCodeSVG`. We can convert it to string using ReactDOMServer, BUT ReactDOMServer is not recommended in client components.
        // Since we are creating an HTML string for the print window, let's just create a hidden div, mount the QRs, and then print, OR we can use the qrcode library directly (not react wrapper).
        // Let's check package.json for `qrcode`. We have `qrcode.react`.
        // To avoid React mounting issues in a raw popup window string, what is the best way?
        // We can just render a `<div>` with the QRs in the *current* window, visually hidden, and use `window.print()` on that specific div.
        // BUT the existing code opens a new window (`window.open('', '_blank')`) and writes HTML.
        // Let's use `react-dom/server`'s `renderToString`. Even in Next.js client components, `renderToString` from `react-dom/server` usually works fine for simple SVGs. Let's try it.

        // We need to import renderToString at the top of the file. I will use await import to avoid breaking the client bundle if it's strict.
        import('react-dom/server').then(({ renderToString }) => {
            import('qrcode.react').then(({ QRCodeSVG }) => {

                const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';

                const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Inventory Checklist</title>
                    <style>
                        @media print {
                            @page { size: portrait; margin: 0.5in; }
                            body { margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
                            .print-qr svg { width: 48px; height: 48px; }
                        }
                        body { padding: 20px; font-family: system-ui, -apple-system, sans-serif; color: #000; }
                        table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; }
                        th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: middle; }
                        th { background: #f8fafc; font-weight: bold; border-bottom: 2px solid #cbd5e1; }
                        h1 { margin-top: 0; font-size: 24px; }
                        .date { color: #64748b; font-size: 14px; margin-bottom: 20px; }
                        .count-col { width: 80px; }
                        .qr-col { width: 60px; text-align: center; }
                        .count-line { border-bottom: 1px solid #000; width: 100%; display: inline-block; height: 16px; }
                        tr { page-break-inside: avoid; }
                        .print-qr { display: flex; justify-content: center; align-items: center; }
                        .print-qr svg { width: 48px; height: 48px; }
                    </style>
                </head>
                <body onload="window.print(); setTimeout(() => window.close(), 500);">
                    <div class="header">
                        <h1>Inventory Checklist</h1>
                        <div class="date">Generated: ${new Date().toLocaleDateString()}</div>
                    </div>
                    <table>
                        <thead>
                            <tr>
                                <th class="qr-col">QR</th>
                                <th>Ingredient Name</th>
                                <th>SKU</th>
                                <th>Supplier</th>
                                <th class="qr-col">QR</th>
                                <th class="count-col">Count</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sortedIngredients.map((ing, index) => {
                    const supName = suppliers.find(s => s.id === ing.supplier_id)?.name || '';
                    const sku = ing.sku || '';

                    // The scanner page parseUrl logic expects ?type=X&id=Y
                    const qrUrl = `${origin}/scanner?type=ingredient&id=${ing.id}`;
                    const qrSvgString = renderToString(<QRCodeSVG value={qrUrl} size={48} level="M" />);

                    const isLeft = index % 2 === 0;

                    return `
                                <tr>
                                    <td class="qr-col">${isLeft ? `<div class="print-qr">${qrSvgString}</div>` : ''}</td>
                                    <td><strong>${ing.name}</strong></td>
                                    <td>${sku}</td>
                                    <td>${supName}</td>
                                    <td class="qr-col">${!isLeft ? `<div class="print-qr">${qrSvgString}</div>` : ''}</td>
                                    <td><div class="count-line"></div></td>
                                </tr>
                                `;
                }).join('')}
                        </tbody>
                    </table>
                </body>
                </html>
                `;

                printWindow?.document.write(html);
                printWindow?.document.close();
            });
        });
    };

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

            <div className="flex gap-4 items-center mb-6">
                <div className="relative flex-1">
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
                <button
                    onClick={() => setShowPrintModal(true)}
                    className="flex shrink-0 items-center justify-center gap-2 px-6 py-4 bg-white/80 dark:bg-slate-900/60 border border-slate-300 dark:border-slate-700/50 rounded-3xl text-slate-700 dark:text-slate-300 font-bold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors shadow-sm"
                    title="Print Inventory Checklist"
                >
                    <Printer size={20} />
                    <span className="hidden sm:inline">Print List</span>
                </button>
            </div>

            <div className="glass-panel rounded-3xl bg-white/80 dark:bg-slate-900/60 border border-white/40 dark:border-slate-700/50 shadow-sm backdrop-blur-xl">
                <div className="w-full overflow-x-auto overflow-y-hidden rounded-3xl">
                    <table className="w-full text-left border-collapse min-w-[1000px]">
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
                                                    className="w-full min-w-[300px] px-3 py-2 bg-transparent border border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 rounded-lg outline-none transition font-bold text-slate-700 dark:text-slate-200"
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
                                            </div>
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
                                                    onClick={() => setReceiveModalIng(ing)}
                                                    className="p-1.5 text-indigo-500 hover:text-white hover:bg-indigo-500 dark:hover:bg-indigo-600 rounded-lg transition-all font-bold flex items-center gap-1"
                                                    title="Receive Inventory"
                                                >
                                                    <Plus size={16} strokeWidth={3} /> In
                                                </button>
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
            </div>

            {/* Receive Modal */}
            {receiveModalIng && (
                <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-sm w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-slate-200 dark:border-slate-800">
                        <div className="flex items-center justify-between p-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                            <h3 className="font-black text-xl text-slate-800 dark:text-white">Receive Inventory</h3>
                            <button
                                onClick={() => setReceiveModalIng(null)}
                                className="text-slate-400 hover:text-rose-500 bg-white dark:bg-slate-800 p-2 rounded-xl transition-colors shadow-sm border border-slate-200 dark:border-slate-700"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <h4 className="font-bold text-slate-900 dark:text-white text-lg">{receiveModalIng.name}</h4>
                                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                                    Current Stock: <span className="font-bold text-slate-700 dark:text-slate-300">{receiveModalIng.stock_quantity || 0} {receiveModalIng.unit}</span>
                                </p>
                            </div>

                            <div className="bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-900/30 p-4 rounded-xl">
                                <label className="block text-xs font-bold text-indigo-800 dark:text-indigo-400 mb-2 uppercase tracking-wide">
                                    How many {receiveModalIng.purchase_unit || 'Packs'} received?
                                </label>
                                <div className="flex gap-2 items-center">
                                    <input
                                        type="number"
                                        value={receiveInput}
                                        onChange={(e) => setReceiveInput(e.target.value)}
                                        placeholder="0"
                                        autoFocus
                                        className="w-full px-4 py-3 border border-indigo-200 dark:border-indigo-800/50 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-black text-center text-xl transition-all shadow-inner"
                                    />
                                </div>
                                {(receiveModalIng.purchase_quantity || 1) > 1 && receiveInput && Number(receiveInput) > 0 && (
                                    <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400 mt-3 text-center">
                                        Adding +{Number(receiveInput) * (receiveModalIng.purchase_quantity || 1)} {receiveModalIng.unit} total
                                    </p>
                                )}
                            </div>

                            <button
                                onClick={handleReceiveSubmit}
                                disabled={!receiveInput || Number(receiveInput) <= 0}
                                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-4 rounded-xl shadow-lg shadow-indigo-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                            >
                                <Download size={20} />
                                Receive to Stock
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Print Settings Modal */}
            {showPrintModal && (
                <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-3xl max-w-sm w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 border border-slate-200 dark:border-slate-800">
                        <div className="flex items-center justify-between p-6 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                            <h3 className="font-black text-xl text-slate-800 dark:text-white flex items-center gap-2">
                                <Printer size={20} className="text-indigo-500" />
                                Print Options
                            </h3>
                            <button
                                onClick={() => setShowPrintModal(false)}
                                className="text-slate-400 hover:text-rose-500 bg-white dark:bg-slate-800 p-2 rounded-xl transition-colors shadow-sm border border-slate-200 dark:border-slate-700"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-6 space-y-5">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">
                                    Filter By Supplier
                                </label>
                                <select
                                    value={printSupplierFilter}
                                    onChange={(e) => setPrintSupplierFilter(e.target.value)}
                                    className="w-full px-4 py-3 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-200 font-medium cursor-pointer"
                                >
                                    <option value="all">All Suppliers</option>
                                    {suppliers.map(s => {
                                        if (s.name.toLowerCase() === 'batch recipe') return null;
                                        return (
                                            <option key={s.id} value={s.id}>{s.name}</option>
                                        );
                                    })}
                                </select>
                            </div>

                            <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-4">
                                <p className="text-xs font-medium text-indigo-700 dark:text-indigo-300 leading-relaxed text-center">
                                    QR Codes will automatically be staggered left and right for easier scanning.
                                </p>
                            </div>

                            <button
                                onClick={() => {
                                    setShowPrintModal(false);
                                    executePrint();
                                }}
                                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl shadow-lg shadow-indigo-600/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                            >
                                <Printer size={20} />
                                Generate Print Sheet
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
