"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Plus, Calculator, ShoppingCart, ChefHat, Trash2, Printer, Calendar, Loader2, RefreshCw, Check, ExternalLink, Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toFraction } from '@/lib/unit_converter';

// Calculator Interfaces
interface Bundle {
    id: string;
    name: string;
    sku: string;
}

interface OrderItem {
    bundle_id: string;
    quantity: number;
}

interface PlanResult {
    rawIngredients: Record<string, { qty: number; unit: string; onHand: number; costPerUnit: number; costUnit?: string; supplier?: string; supplierUrl?: string; displayName?: string; purchaseCost?: number; purchaseUnit?: string }>;
    prepTasks: Record<string, { qty: number; unit: string; id: string; label_text?: string }>;
    assemblyTasks: Record<string, { qty: number; unit: string }>;
}

export default function ProductionCalculator() {
    const router = useRouter();

    // Calculator State
    const [bundles, setBundles] = useState<Bundle[]>([]);
    const [orders, setOrders] = useState<OrderItem[]>([{ bundle_id: '', quantity: 10 }]);
    const [result, setResult] = useState<PlanResult | null>(null);
    const [isCalculating, setIsCalculating] = useState(false);

    // New Run State (for quick save)
    const [newName, setNewName] = useState('');
    const [newDate] = useState(new Date().toISOString().split('T')[0]);
    const [completedItems, setCompletedItems] = useState<Set<string>>(new Set());
    const [shoppingChecked, setShoppingChecked] = useState<Set<string>>(new Set());
    const [showAllItems, setShowAllItems] = useState(false);
    const [recipeDetails, setRecipeDetails] = useState<Record<string, any>>({});

    // Track if retrieval from localStorage is complete to prevent overwriting with initial empty state
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        // Fetch Bundles
        fetch('/api/bundles')
            .then(res => res.json())
            .then(data => setBundles(data))
            .catch(err => console.error("Failed to fetch bundles", err));

        // Load Queue & Checked Items
        const savedQueue = localStorage.getItem('productionQueue');
        if (savedQueue) {
            try {
                setOrders(JSON.parse(savedQueue));
            } catch (e) {
                console.error("Failed to parse saved queue");
            }
        }

        const savedCompleted = localStorage.getItem('productionCompleted');
        if (savedCompleted) {
            try {
                setCompletedItems(new Set(JSON.parse(savedCompleted)));
            } catch (e) {
                console.error("Failed to parse saved completed items");
            }
        }

        const savedShoppingChecked = localStorage.getItem('shoppingChecked');
        if (savedShoppingChecked) {
            try {
                setShoppingChecked(new Set(JSON.parse(savedShoppingChecked)));
            } catch (e) {
                console.error("Failed to parse saved shopping items");
            }
        }

        const savedResult = localStorage.getItem('productionResult');
        if (savedResult) {
            try {
                setResult(JSON.parse(savedResult));
            } catch (e) {
                console.error("Failed to parse saved result");
            }
        }

        // Mark as loaded triggers re-render, enabling save effects
        setIsLoaded(true);
    }, []);

    // Save Queue to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded) return;
        localStorage.setItem('productionQueue', JSON.stringify(orders));
    }, [orders, isLoaded]);

    // Save Completed Items to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded) return;
        localStorage.setItem('productionCompleted', JSON.stringify(Array.from(completedItems)));
    }, [completedItems, isLoaded]);

    // Save Shopping Checked Items to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded) return;
        localStorage.setItem('shoppingChecked', JSON.stringify(Array.from(shoppingChecked)));
    }, [shoppingChecked, isLoaded]);

    // Save Result to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded) return;
        if (result) {
            localStorage.setItem('productionResult', JSON.stringify(result));
        }
    }, [result, isLoaded]);

    // Calculator Actions
    const updateOrder = (index: number, field: keyof OrderItem, value: any) => {
        const newOrders = [...orders];
        newOrders[index] = { ...newOrders[index], [field]: value };
        setOrders(newOrders);
    };

    const addRow = () => setOrders([...orders, { bundle_id: '', quantity: 0 }]);
    const removeRow = (index: number) => setOrders(orders.filter((_, i) => i !== index));

    const clearQueue = () => {
        if (confirm("Clear the input queue? (Plan will remain visible)")) {
            setOrders([{ bundle_id: '', quantity: 10 }]); // Reset Inputs Only
            localStorage.removeItem('productionQueue');
            // Keep Result and Completed Items as requested
        }
    };

    const clearAll = () => {
        if (confirm("Start fresh? This will clear inputs, the plan, and checks.")) {
            setOrders([{ bundle_id: '', quantity: 10 }]);
            setResult(null);
            setResult(null);
            setCompletedItems(new Set());
            setShoppingChecked(new Set());
            localStorage.removeItem('productionQueue');
            localStorage.removeItem('productionCompleted');
            localStorage.removeItem('shoppingChecked');
            localStorage.removeItem('productionResult');
        }
    };

    const calculatePlan = async () => {
        setIsCalculating(true);
        try {
            const validOrders = orders.filter(o => o.bundle_id && o.quantity > 0);
            const res = await fetch('/api/production/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orders: validOrders })
            });
            const data = await res.json();
            setResult(data);
        } catch (e) {
            alert("Failed to calculate plan");
        } finally {
            setIsCalculating(false);
        }
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
        if (!lowerUrl.includes('/')) {
            return `https://${baseUrl}/search?q=${encodedQuery}`;
        }
        return baseUrl;
    };


    return (
        <div className="max-w-6xl mx-auto p-4 md:p-8">
            <style dangerouslySetInnerHTML={{
                __html: `
                @media print {
                    @page { margin: 0.5cm !important; size: portrait; }
                    html, body { 
                        margin: 0 !important; 
                        padding: 0 !important;
                        zoom: 115%;
                        font-size: 14px !important;
                    }
                    /* Hide EVERYTHING by default */
                    body * { visibility: hidden !important; height: 0 !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; }
                    
                    /* Show only the Shopping List container and its children */
                    .print-list-container, .print-list-container * { 
                        visibility: visible !important; 
                        height: auto !important; 
                        overflow: visible !important; 
                    }
                    
                    .print-list-container {
                        position: absolute;
                        left: 0;
                        top: 0;
                        width: 100% !important;
                        display: block !important;
                    }

                    .print-grid { 
                        display: grid !important; 
                        grid-template-columns: 1fr 1fr !important; 
                        gap: 0.3cm !important; 
                        margin-top: 0 !important;
                        width: 100% !important;
                    }
                    .print-supplier-box { 
                        break-inside: avoid !important; 
                        margin-bottom: 0.3cm !important;
                        border: 1px solid #ccc !important;
                        padding: 0 !important;
                    }
                    .print-full-width {
                        grid-column: span 2 !important;
                        width: 100% !important;
                    }
                }
            `}} />
            <div className="flex justify-between items-start mb-8 print:hidden">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
                        <Calculator className="text-indigo-600" />
                        Production Calculator
                    </h1>
                    <p className="text-slate-500 font-medium">Plan your prep and kitchen runs</p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={clearQueue}
                        className="flex items-center gap-2 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 px-4 py-2 rounded-xl font-bold hover:bg-slate-50 dark:hover:bg-slate-900/20 transition-colors shadow-sm"
                        title="Clears inputs but keeps the plan active"
                    >
                        <Trash2 size={18} />
                        Clear Inputs
                    </button>
                    <button
                        onClick={clearAll}
                        className="flex items-center gap-2 bg-white dark:bg-slate-800 text-rose-600 dark:text-rose-400 border border-slate-200 dark:border-slate-700 px-4 py-2 rounded-xl font-bold hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors shadow-sm"
                    >
                        <RefreshCw size={18} />
                        Start Fresh
                    </button>
                    {/* Link to Schedule */}
                    <Link
                        href="/production/schedule"
                        className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-4 py-2 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                    >
                        <Calendar size={18} />
                        View Tasks
                    </Link>
                </div>
            </div>

            {/* Input Section */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 mb-8 print:hidden">
                <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-white">What are we making?</h3>
                <div className="space-y-3">
                    {orders.map((order, i) => (
                        <div key={i} className="flex gap-4 items-center">
                            <select
                                className="flex-1 px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                value={order.bundle_id}
                                onChange={(e) => updateOrder(i, 'bundle_id', e.target.value)}
                            >
                                <option value="">Select Bundle...</option>
                                {bundles.map(b => (
                                    <option key={b.id} value={b.id}>{b.name} ({b.sku})</option>
                                ))}
                            </select>
                            <input
                                type="number"
                                className="w-32 px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                value={order.quantity}
                                onChange={(e) => updateOrder(i, 'quantity', Number(e.target.value))}
                                min="1"
                            />
                            {orders.length > 1 && (
                                <button onClick={() => removeRow(i)} className="text-slate-400 hover:text-rose-500">
                                    <Trash2 size={20} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                <div className="flex gap-4 mt-4">
                    <button onClick={addRow} className="text-indigo-600 font-bold flex items-center gap-2 text-sm hover:underline">
                        <Plus size={16} /> Add Bundle
                    </button>
                </div>
                <div className="mt-8 flex justify-end">
                    <button
                        onClick={calculatePlan}
                        disabled={isCalculating || !orders.some(o => o.bundle_id)}
                        className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold shadow-lg shadow-indigo-500/20 hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
                    >
                        {isCalculating ? <Loader2 className="animate-spin" /> : <Calculator size={20} />}
                        Calculate Plan
                    </button>
                </div>
            </div>

            {/* Results Section */}
            {result && (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500 print:block">
                    {/* Shopping List */}
                    <div className="glass-panel bg-gradient-to-br from-white to-slate-50 dark:from-slate-800 dark:to-slate-900 rounded-3xl p-8 border border-slate-200 dark:border-slate-700 shadow-xl h-fit print:shadow-none print:border-none print:p-0 print:w-full print-list-container">
                        <div className="hidden print:block mb-6 border-b-4 border-slate-900 pb-2">
                            <h1 className="text-3xl font-black uppercase tracking-tight">Shopping List - {new Date().toLocaleDateString()}</h1>
                            <p className="text-xs font-bold text-slate-500">Freezer IQ Logistics Center</p>
                        </div>
                        <div className="flex items-center gap-3 mb-6 print:hidden">
                            <div className="w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                <ShoppingCart size={24} />
                            </div>
                            <div>
                                <h2 className="text-2xl font-black text-slate-900 dark:text-white">Shopping List</h2>
                                <p className="text-slate-500 font-medium">Grouped by Supplier</p>
                            </div>
                            <div className="flex items-center gap-2 ml-auto print:hidden">
                                <label className="flex items-center gap-2 text-sm font-bold text-slate-600 dark:text-slate-400 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                        checked={showAllItems}
                                        onChange={(e) => setShowAllItems(e.target.checked)}
                                    />
                                    Show In-Stock Items
                                </label>
                            </div>
                            <button
                                onClick={() => window.print()}
                                className="flex items-center gap-2 text-sm font-bold text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 px-3 py-2 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors print:hidden"
                            >
                                <Printer size={16} />
                                Print List
                            </button>
                        </div>

                        <div className="space-y-6 print:space-y-0 print-grid">
                            {Object.entries(
                                Object.values(result.rawIngredients).reduce((acc, item) => {
                                    // FILTER: Hide if onHand >= qty (Fully Stocked) UNLESS showAllItems is true
                                    if (!showAllItems && (item.onHand || 0) >= item.qty) {
                                        return acc;
                                    }

                                    const sup = item.supplier || 'Unassigned';
                                    if (!acc[sup]) acc[sup] = [];
                                    acc[sup].push(item);
                                    return acc;
                                }, {} as Record<string, typeof result.rawIngredients[string][]>)
                            ).sort((a, b) => a[0].localeCompare(b[0])).map(([supplier, items]) => (
                                <div key={supplier} className="border border-slate-200 dark:border-slate-700/50 rounded-xl overflow-hidden print-supplier-box">
                                    <div className="bg-slate-100 dark:bg-slate-800 px-4 py-2 font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider flex justify-between print:px-2 print:py-1">
                                        <span className="print:text-xs text-indigo-700 dark:text-indigo-400">{supplier}</span>
                                        <span className="text-slate-400 font-normal print:text-[10px]">{items.length} items</span>
                                    </div>
                                    <table className="w-full text-left">
                                        <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                                            {items.map((data, i) => {
                                                const itemId = `${supplier}-${data.displayName}`;
                                                // Check if manually "checked" via UI
                                                const isChecked = shoppingChecked.has(itemId);
                                                // Check if "stocked" (Hidden by default unless Show All is on)
                                                const isStocked = (data.onHand || 0) >= data.qty;

                                                // visual states
                                                const isDone = isChecked || isStocked;

                                                return (
                                                    <tr
                                                        key={i}
                                                        className={`transition-colors cursor-pointer group hover:bg-slate-50 dark:hover:bg-slate-800/50 
                                                            ${isChecked ? 'bg-slate-50 dark:bg-slate-900/50' : ''} 
                                                            ${isStocked ? 'bg-slate-50/50 dark:bg-slate-900/30' : ''}
                                                        `}
                                                        onClick={() => {
                                                            // Toggle Manual Check
                                                            const next = new Set(shoppingChecked);
                                                            if (next.has(itemId)) next.delete(itemId);
                                                            else next.add(itemId);
                                                            setShoppingChecked(next);
                                                        }}
                                                    >
                                                        <td className="p-3 w-10 print:hidden">
                                                            <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors 
                                                                ${isChecked ? 'bg-emerald-500 border-emerald-500' :
                                                                    isStocked ? 'border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800' :
                                                                        'border-slate-300 dark:border-slate-600 group-hover:border-indigo-400'}
                                                            `}>
                                                                {isChecked && <Check size={14} className="text-white" strokeWidth={3} />}
                                                                {isStocked && !isChecked && <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-600" />}
                                                            </div>
                                                        </td>
                                                        <td className={`p-3 font-medium capitalize text-sm print:p-1 print:text-xs 
                                                            ${isChecked ? 'line-through text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-300'}
                                                            ${isStocked && !isChecked ? 'text-slate-500/80' : ''} 
                                                        `}>
                                                            {data.displayName || 'Unknown Item'}
                                                            {isStocked && <span className="ml-2 text-[10px] uppercase font-bold tracking-wider text-emerald-600 bg-emerald-50 border border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400 px-1.5 py-0.5 rounded print:hidden">In Stock</span>}
                                                        </td>

                                                        <td className={`p-3 text-right font-mono font-bold text-sm print:p-1 print:text-[11px] ${isChecked ? 'text-slate-400 dark:text-slate-500' : 'text-indigo-600 dark:text-indigo-400'}`}>
                                                            {toFraction(Number(data.qty))} {data.unit}
                                                        </td>
                                                        <td className={`p-3 text-right font-mono font-bold text-sm print:p-1 print:text-[11px] ${isChecked ? 'text-slate-400 dark:text-slate-500' : 'text-emerald-600 dark:text-emerald-500'}`}>
                                                            ${(data.qty * data.costPerUnit).toFixed(2)}
                                                        </td>
                                                        <td className="p-3 text-right print:hidden" onClick={(e) => e.stopPropagation()}>
                                                            <a
                                                                href={getSupplierSearchUrl(data.supplierUrl || (data.supplier === 'Amazon' ? 'amazon.com' : ''), data.displayName || '') || '#'}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className={`inline-flex items-center gap-1 hover:text-orange-500 transition-colors print:hidden ${isDone ? 'text-slate-300 pointer-events-none' : 'text-slate-400'}`}
                                                                title={`Shop for ${data.displayName}`}
                                                            >
                                                                <ExternalLink size={16} />
                                                            </a>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    {items.length > 0 && (
                                        <div className="bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700/50 p-3 flex justify-end items-center gap-4 print:hidden">
                                            <span className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Subtotal:</span>
                                            <span className="text-lg font-black text-slate-800 dark:text-slate-200 font-mono">
                                                ${items.reduce((sum, item) => sum + (item.qty * (item.costPerUnit || 0)), 0).toFixed(2)}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            ))}

                            {/* Grand Total Row */}
                            {Object.keys(result.rawIngredients).length > 0 && (
                                <div className="bg-slate-900 rounded-2xl p-6 text-white flex justify-between items-center shadow-lg mt-6 print:col-span-2 print:p-4 print:mt-4 print-full-width">
                                    <div>
                                        <p className="font-bold text-slate-400 uppercase text-xs tracking-wider mb-1">Estimated Weekly Cost</p>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-3xl font-black tracking-tight">
                                                ${Object.values(result.rawIngredients)
                                                    .reduce((acc, item) => {
                                                        // Important: Sum ALL items regardless of checked status
                                                        // Logic: This is the TOTAL COST of the plan
                                                        return acc + (item.qty * (item.costPerUnit || 0));
                                                    }, 0)
                                                    .toFixed(2)}
                                            </span>
                                            <span className="text-slate-400 font-bold text-sm">Grand Total</span>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        {(() => {
                                            const total = Object.values(result.rawIngredients).reduce((acc, item) => acc + (item.qty * (item.costPerUnit || 0)), 0);
                                            // Persist for Dashboard
                                            // Side-effect in render is not ideal but simple for this purpose
                                            if (typeof window !== 'undefined') {
                                                localStorage.setItem('shoppingListTotal', total.toString());
                                            }
                                            return null;
                                        })()}
                                        <button
                                            onClick={() => window.print()}
                                            className="bg-white text-slate-900 px-4 py-2 rounded-lg font-bold text-sm hover:bg-indigo-50 transition-colors flex items-center gap-2 print:hidden"
                                        >
                                            <Printer size={16} /> Print List
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Prep Plan */}
                    <div className="glass-panel bg-white dark:bg-slate-800 rounded-3xl p-8 border border-slate-200 dark:border-slate-700 shadow-lg h-fit print:hidden">
                        <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-3">
                                <div className="w-12 h-12 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
                                    <ChefHat size={24} />
                                </div>
                                <div>
                                    <h2 className="text-2xl font-black text-slate-900 dark:text-white">Prep Plan</h2>
                                    <p className="text-slate-500 font-medium">Recipes to prepare</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    // Print Recipes Button Logic
                                    onClick={async () => {
                                        if (!result || !result.prepTasks || Object.keys(result.prepTasks).length === 0) {
                                            alert('No recipes to print. Please calculate a production plan first.');
                                            return;
                                        }

                                        const btn = document.activeElement as HTMLButtonElement;
                                        if (btn) {
                                            btn.disabled = true;
                                            btn.textContent = 'Fetching recipes...';
                                        }

                                        // Fetch all recipe details
                                        const recipeIds = Object.values(result.prepTasks).map(task => task.id);
                                        const details: Record<string, any> = {};

                                        for (const recipeId of recipeIds) {
                                            try {
                                                const res = await fetch(`/api/recipes/${recipeId}`);
                                                if (res.ok) {
                                                    const data = await res.json();
                                                    details[recipeId] = data;
                                                }
                                            } catch (e) {
                                                console.error(e);
                                            }
                                        }

                                        // Reset button
                                        if (btn) {
                                            btn.disabled = false;
                                            btn.innerHTML = '<svg class="lucide lucide-printer" width="16" height="16"><use href="#printer-icon"/></svg> Print Recipes';
                                        }

                                        // Open Print Window
                                        const printWindow = window.open('', '_blank');
                                        if (printWindow) {
                                            const sortedRecipes = Object.entries(result.prepTasks)
                                                .sort((a, b) => a[0].localeCompare(b[0]))
                                                .filter(([name, task]) => !!details[task.id]);

                                            // Generate HTML Content
                                            const htmlContent = `
                                                <html>
                                                <head>
                                                    <title>Recipe Prep Sheet</title>
                                                    <style>
                                                        body { font-family: sans-serif; padding: 10px; margin: 0; }
                                                        .recipe-block { margin-bottom: 10px; break-inside: avoid; border-bottom: 2px solid #eee; padding-bottom: 10px; }
                                                        .recipe-name { font-size: 14pt; font-weight: bold; margin-bottom: 3px; border-bottom: 2px solid #000; padding-bottom: 2px; }
                                                        .recipe-ingredients { font-size: 10pt; margin-left: 0; }
                                                        .ingredient-item { 
                                                            padding: 4px 0; 
                                                            border-bottom: 1px solid #666; 
                                                            font-family: inherit;
                                                        }
                                                        .ingredient-item:last-child { border-bottom: none; }
                                                        @media print {
                                                            @page { margin: 0.3cm; }
                                                            body { padding: 0; }
                                                            .recipe-block:last-child { border-bottom: none; }
                                                        }
                                                    </style>
                                                </head>
                                                <body>
                                                    <h1 style="font-size:16pt; margin-bottom: 20px;">Recipe Prep Sheet</h1>
                                                    ${sortedRecipes.map(([name, task]) => {
                                                const recipe = details[task.id];
                                                const items = recipe?.items || recipe?.child_items || [];

                                                // Group items by section
                                                const sections: Record<string, any[]> = {};
                                                items.forEach((item: any) => {
                                                    const sName = item.section_name || 'Standard Ingredients';
                                                    if (!sections[sName]) sections[sName] = [];
                                                    sections[sName].push(item);
                                                });

                                                const sectionsHtml = Object.entries(sections).map(([sName, sItems]) => {
                                                    const isBox = sName !== 'Standard Ingredients';
                                                    const ingredientsHtml = sItems.map((item: any) => {
                                                        const iName = item.name || item.child_recipe?.name || item.child_ingredient?.name || 'Unknown';

                                                        // LOGIC: 
                                                        // Standard Ingredients -> Unscaled (1 meal qty)
                                                        // Sub-Recipes -> Scaled (Total Bundles * Section Multiplier)
                                                        const scaleFactor = isBox ? (task.qty * (Number(item.section_batch) || 1)) : 1;

                                                        const qtyValue = Number(item.quantity) * scaleFactor;
                                                        const qty = toFraction(qtyValue);

                                                        return `<div class="ingredient-item">
                                                            <span style="display:inline-block; width:14px; height:14px; border:1px solid #000; margin-right:8px; vertical-align:middle;"></span>
                                                            <span style="font-weight:bold; margin-right:8px; display:inline-block; min-width:60px;">${qty} ${item.unit}</span>
                                                            <span>${iName}</span>
                                                        </div>`;
                                                    }).join('');

                                                    return `
                                                        <div style="margin-top: 10px; ${isBox ? 'border: 1px solid #10b981; background: #f0fdf4; padding: 10px; border-radius: 6px;' : ''}">
                                                            <div style="font-weight: bold; font-size: 10pt; color: ${isBox ? '#059669' : '#64748b'}; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 5px;">
                                                                ${sName}
                                                            </div>
                                                            ${ingredientsHtml}
                                                        </div>
                                                    `;
                                                }).join('');

                                                return `
                                                            <div class="recipe-block" style="padding: 15px; margin-bottom: 25px;">
                                                                <div class="recipe-name" style="font-size: 16pt; font-weight: bold; border-bottom: 3px solid #000; padding-bottom: 5px; margin-bottom: 15px;">
                                                                    ${name} 
                                                                    <span style="float: right;">Make ${Math.round(task.qty)}</span>
                                                                </div>
                                                                <div class="recipe-ingredients" style="margin-left: 10px;">${sectionsHtml}</div>
                                                            </div>
                                                        `;
                                            }).join('')}
                                                    <script>
                                                        window.onload = () => { setTimeout(() => window.print(), 500); };
                                                    </script>
                                                </body>
                                                </html>
                                            `;

                                            printWindow.document.write(htmlContent);
                                            printWindow.document.close();
                                        }
                                    }}
                                    className="flex items-center gap-2 text-sm font-bold text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors print:hidden disabled:opacity-50"
                                >
                                    <Printer size={16} />
                                    Print Recipes
                                </button>
                                <button
                                    onClick={async () => {
                                        if (!newName) {
                                            const autoName = `Production Run - ${new Date().toLocaleDateString()}`;
                                            if (confirm(`Create new run "${autoName}" from this plan?`)) {
                                                setNewName(autoName);
                                                try {
                                                    // 1. Create Run
                                                    const runRes = await fetch('/api/production/runs', {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ name: autoName, run_date: newDate })
                                                    });
                                                    const run = await runRes.json();

                                                    // 2. Add Tasks
                                                    const tasks = Object.entries(result.prepTasks).map(([name, data]) => ({
                                                        production_run_id: run.id,
                                                        item_id: name,
                                                        item_type: 'recipe',
                                                        total_qty_needed: data.qty,
                                                        unit: data.unit,
                                                        status: completedItems.has(name) ? 'done' : 'todo'
                                                    }));

                                                    await Promise.all(tasks.map(t => fetch('/api/production/tasks', {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify(t)
                                                    })));

                                                    alert("Saved! Redirecting to Tasks...");
                                                    router.push('/production/schedule');

                                                } catch (e) { alert("Failed to save."); }
                                            }
                                        }
                                    }}
                                    className="text-sm font-bold text-indigo-600 hover:underline"
                                >
                                    Add to Tasks
                                </button>
                            </div>
                        </div>

                        {/* Header Row */}
                        <div className="flex items-center justify-between px-4 pb-2 text-xs font-black uppercase text-slate-400 dark:text-slate-500 tracking-wider">
                            <div className="flex items-center gap-8">
                                <span className="w-6 text-center">Done</span>
                                <span>Meal to Prepare</span>
                            </div>
                            <div className="flex items-center gap-4">
                                <span className="w-32 text-center"># To Make</span>
                                <span className="w-24 text-center">Print Label</span>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-3">
                            {Object.entries(result.prepTasks).sort((a, b) => a[0].localeCompare(b[0])).map(([name, data]) => {
                                const isChecked = completedItems.has(name);
                                return (
                                    <div key={name} className={`flex items-center justify-between p-4 rounded-xl border group transition-all ${isChecked ? 'bg-slate-50 opacity-60 border-slate-100' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800'}`}>
                                        <div className="flex items-center gap-8">
                                            {/* Functional Checkbox */}
                                            <div
                                                className={`w-6 h-6 shrink-0 rounded-md border-2 flex items-center justify-center cursor-pointer transition-colors ${isChecked ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 hover:border-indigo-500'}`}
                                                onClick={() => {
                                                    const next = new Set(completedItems);
                                                    if (next.has(name)) next.delete(name);
                                                    else next.add(name);
                                                    setCompletedItems(next);
                                                }}
                                            >
                                                {isChecked && <Check size={16} className="text-white" strokeWidth={3} />}
                                            </div>

                                            <div>
                                                <div className={`font-bold text-slate-800 dark:text-slate-200 ${isChecked ? 'line-through text-slate-400' : ''}`}>{name}</div>
                                                <div className="text-xs text-slate-400 font-mono">{data.id.split('-')[0]}</div>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-4">
                                            <div className="w-32 flex justify-center">
                                                <span className="font-mono font-bold text-amber-600 dark:text-amber-500 bg-amber-50 dark:bg-amber-900/10 px-3 py-1 rounded-lg">
                                                    {Math.round(data.qty)}
                                                </span>
                                            </div>
                                            <div className="w-24 flex justify-center">
                                                <button
                                                    onClick={() => {
                                                        // Calculate Size Hint from Bundle Names
                                                        let bundleHint = '';
                                                        const activeBundles = orders
                                                            .map(o => bundles.find(b => b.id === o.bundle_id))
                                                            .filter(Boolean);

                                                        // Check keywords
                                                        if (activeBundles.some(b => b!.name.toLowerCase().includes('family'))) bundleHint = 'Family Size';
                                                        else if (activeBundles.some(b => b!.name.toLowerCase().includes('couple'))) bundleHint = 'Serves 2';
                                                        else if (activeBundles.some(b => b!.name.toLowerCase().includes('single'))) bundleHint = 'Single Serving';

                                                        // Extract SKU from active bundles
                                                        // (Heuristic: If multiple bundles are active, we might pick the first one, or try to find one that matches the item? 
                                                        // For now, since the calculator aggregates, we'll traverse our logic or just pass the first active bundle's SKU as a hint)
                                                        const activeSku = activeBundles.length > 0 ? activeBundles[0]?.sku : '';

                                                        const printQty = Math.round(data.qty);
                                                        router.push(`/labels?recipeId=${encodeURIComponent(data.id)}&qty=${data.qty}&unit=${encodeURIComponent(data.unit)}&bundleHint=${encodeURIComponent(bundleHint)}&printQty=${printQty}&sku=${encodeURIComponent(activeSku || '')}&from=production`);
                                                    }}
                                                    className="p-2 text-slate-400 hover:text-indigo-600 transition-colors"
                                                    title="Print Label"
                                                >
                                                    <Printer size={18} />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )
            }
        </div >
    );
}
