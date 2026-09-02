"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Plus, Calculator, ShoppingCart, ChefHat, Trash2, Printer, Calendar, Loader2, RefreshCw, Check, ExternalLink, Copy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { toFraction } from '@/lib/unit_converter';
import { servingTierLabel } from '@/lib/mealLabel';
import { loadBundles } from '@/lib/bundleLoader';
import { writePrintBatch, distinctTierCount } from '@/lib/printBatchStorage';

// Calculator Interfaces
interface Bundle {
    id: string;
    name: string;
    sku: string;
}

interface OrderItem {
    bundle_id: string;
    quantity: number;
    // OPS-4: the sold serving tier, when known (e.g. a row synced from a real
    // order). A synced order's variant_size is a frozen historical snapshot
    // (docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §4) and must survive this
    // round-trip unchanged — never invented, never defaulted here. Omitted on
    // a manually-typed row, exactly as before this phase; that row has no
    // sale behind it to snapshot.
    variant_size?: string | null;
}

interface PlanResult {
    rawIngredients: Record<string, {
        qty: number;
        netQty: number;
        unit: string;
        onHand: number;
        costPerUnit: number;
        costUnit?: string;
        supplier?: string;
        supplierUrl?: string;
        portalType?: string;
        searchUrlPattern?: string;
        displayName?: string;
        purchaseCost?: number;
        purchaseUnit?: string;
        purchaseQuantity?: number;
    }>;
    prepTasks: Record<string, { qty: number; unit: string; id: string; label_text?: string }>;
    /**
     * OPS-5A: the PHYSICAL MEAL MANIFEST — one row per (recipe, authoritative
     * tier) with a DISCRETE package count. This is what the print batch is
     * built from. Never prepTasks, which is ingredient demand (3 x Serves-2
     * is 1.5 there) and would round into the wrong number of labels.
     */
    assemblyTasks: Record<string, {
        id: string;
        name: string;
        variant: string;
        variantSize: string | null;
        qty: number;
        unit: string;
    }>;
    /**
     * OPS-5: the serving tier this plan can truthfully claim ("Serves 5" /
     * "Serves 2"), resolved server-side by /api/production/plan from the
     * authoritative per-line tier OPS-4/OPS-4A already established. Null when
     * the plan mixed tiers - meal labels then omit the claim rather than guess.
     */
    servingTier?: string | null;
}

export function ProductionCalculator() {
    const router = useRouter();
    const { data: session } = useSession() as { data: any };
    const businessId = session?.user?.businessId;

    // Calculator State
    const [bundles, setBundles] = useState<Bundle[]>([]);
    // OPS-5B: whether the Bundle dropdown has loaded. Separate from businessId
    // on purpose -- see the Bundle-load effect below.
    const [bundlesLoadState, setBundlesLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
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

    // Sync Confirmation Modal State
    const [syncModal, setSyncModal] = useState<{ isOpen: boolean; newOrders: OrderItem[] }>({
        isOpen: false,
        newOrders: []
    });

    // Batch Print State
    const [selectedForPrint, setSelectedForPrint] = useState<Set<string>>(new Set());

    // OPS-5C: the Bundle fetch fires unconditionally on mount -- no client
    // auth-readiness gate of any kind (not businessId, not NextAuth's
    // status). OPS-5B's status-gate deadlocked in production: the effect
    // only gets one guaranteed run per mount (dependency array [status]),
    // and ProductionCalculator mounts fresh on a client tab click rather
    // than at page load, so that one run could see a not-yet-'authenticated'
    // status with nothing left in the file to give it a second chance.
    // app/api/bundles is already fully self-defending -- it authenticates
    // and tenant-scopes server-side (OPS-MANUAL-PLANNER-BUNDLE-FILTER-1) --
    // so the client does not need to know it is authenticated before
    // asking; the server decides whether to answer. The load STATE MACHINE
    // itself (loading -> ready/error, guaranteed to terminate on every
    // response shape) lives in lib/bundleLoader.ts, not here.
    useEffect(() => {
        let cancelled = false;
        loadBundles(
            () => fetch('/api/bundles?activeOnly=true'),
            { setBundles, setBundlesLoadState },
            () => cancelled,
        );
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!businessId) return;

        // Load Queue & Checked Items
        const savedQueue = localStorage.getItem(`${businessId}_productionQueue`);
        if (savedQueue) {
            try {
                setOrders(JSON.parse(savedQueue));
            } catch (e) {
                console.error("Failed to parse saved queue");
            }
        }

        const savedCompleted = localStorage.getItem(`${businessId}_productionCompleted`);
        if (savedCompleted) {
            try {
                setCompletedItems(new Set(JSON.parse(savedCompleted)));
            } catch (e) {
                console.error("Failed to parse saved completed items");
            }
        }

        const savedShoppingChecked = localStorage.getItem(`${businessId}_shoppingChecked`);
        if (savedShoppingChecked) {
            try {
                setShoppingChecked(new Set(JSON.parse(savedShoppingChecked)));
            } catch (e) {
                console.error("Failed to parse saved shopping items");
            }
        }

        const savedResult = localStorage.getItem(`${businessId}_productionResult`);
        if (savedResult) {
            try {
                setResult(JSON.parse(savedResult));
            } catch (e) {
                console.error("Failed to parse saved result");
            }
        }

        // Mark as loaded triggers re-render, enabling save effects
        setIsLoaded(true);
    }, [businessId]);

    // Save Queue to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded || !businessId) return;
        localStorage.setItem(`${businessId}_productionQueue`, JSON.stringify(orders));
    }, [orders, isLoaded, businessId]);

    // Save Completed Items to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded || !businessId) return;
        localStorage.setItem(`${businessId}_productionCompleted`, JSON.stringify(Array.from(completedItems)));
    }, [completedItems, isLoaded, businessId]);

    // Save Shopping Checked Items to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded || !businessId) return;
        localStorage.setItem(`${businessId}_shoppingChecked`, JSON.stringify(Array.from(shoppingChecked)));
    }, [shoppingChecked, isLoaded, businessId]);

    // Save Result to LocalStorage on Change
    useEffect(() => {
        if (!isLoaded || !businessId) return;
        if (result) {
            localStorage.setItem(`${businessId}_productionResult`, JSON.stringify(result));
        }
    }, [result, isLoaded, businessId]);

    // Auto-sync on Load
    useEffect(() => {
        if (isLoaded && (orders.length === 0 || (orders.length === 1 && !orders[0].bundle_id))) {
            syncOnlineOrders(true);
        }
    }, [isLoaded]);

    // Calculator Actions
    const updateOrder = (index: number, field: keyof OrderItem, value: any) => {
        const newOrders = [...orders];
        // OPS-4A: changing the BUNDLE on a row invalidates any variant_size it
        // was carrying -- that snapshot belonged to whichever bundle was
        // synced, not to whatever the dropdown now points at. Clearing it
        // correctly turns the row into a manual one, so the server derives
        // the newly-selected bundle's own current tier instead of keeping a
        // stale sold-tier claim for a bundle that was never actually chosen.
        newOrders[index] = field === 'bundle_id'
            ? { ...newOrders[index], bundle_id: value, variant_size: undefined }
            : { ...newOrders[index], [field]: value };
        setOrders(newOrders);
    };

    const addRow = () => setOrders([...orders, { bundle_id: '', quantity: 0 }]);
    const removeRow = (index: number) => setOrders(orders.filter((_, i) => i !== index));

    const clearQueue = () => {
        if (confirm("Clear the input queue? (Plan will remain visible)")) {
            setOrders([{ bundle_id: '', quantity: 10 }]); // Reset Inputs Only
            if (businessId) localStorage.removeItem(`${businessId}_productionQueue`);
        }
    };

    const clearAll = () => {
        if (confirm("Start fresh? This will clear inputs, the plan, and checks.")) {
            setOrders([{ bundle_id: '', quantity: 10 }]);
            setResult(null);
            setCompletedItems(new Set());
            setShoppingChecked(new Set());
            if (businessId) {
                localStorage.removeItem(`${businessId}_productionQueue`);
                localStorage.removeItem(`${businessId}_productionCompleted`);
                localStorage.removeItem(`${businessId}_shoppingChecked`);
                localStorage.removeItem(`${businessId}_productionResult`);
            }
        }
    };

    const [isSyncing, setIsSyncing] = useState(false);

    const syncOnlineOrders = async (silent = false) => {
        setIsSyncing(true);
        try {
            const res = await fetch('/api/production/sync');
            if (!res.ok) throw new Error('Sync failed');
            const data = await res.json();

            if (data.length === 0) {
                if (!silent) alert("No active orders found.");
                return;
            }

            // Map to order items - existing order state expects { bundle_id, quantity }.
            // OPS-4: variant_size carried through unchanged — /sync now preserves
            // it per (bundle, tier) group instead of discarding it.
            const newOrders = data.map((d: any) => ({
                bundle_id: d.bundle_id,
                quantity: d.quantity,
                variant_size: d.variant_size
            }));

            // Logic: Show custom modal for choices
            if (orders.length === 1 && !orders[0].bundle_id) {
                setOrders(newOrders);
            } else {
                setSyncModal({ isOpen: true, newOrders });
            }
        } catch (e) {
            alert("Failed to sync orders");
        } finally {
            setIsSyncing(false);
        }
    };

    const handleSyncChoice = (choice: 'replace' | 'append') => {
        if (choice === 'replace') {
            setOrders(syncModal.newOrders);
        } else {
            setOrders([...orders, ...syncModal.newOrders]);
        }
        setSyncModal({ isOpen: false, newOrders: [] });
    };

    const calculatePlan = async () => {
        setIsCalculating(true);
        try {
            const validOrders = orders.filter(o => o.bundle_id && o.quantity > 0);
            // OPS-4A: split by whether this row carries a real sold-tier
            // snapshot (it came from Auto-Sync, so variant_size was set --
            // even a legacy null still means "synced") versus a bundle
            // hand-picked from the dropdown (variant_size was never set at
            // all). The server trusts variant_size only for the former; for
            // the latter it always derives tier from the tenant-scoped
            // Bundle itself, never from anything sent here.
            const syncedOrders = validOrders.filter(o => o.variant_size != null);
            const manualOrders = validOrders.filter(o => o.variant_size == null);
            const res = await fetch('/api/production/plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ syncedOrders, manualOrders })
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
    const getSupplierSearchUrl = (baseUrl: string, query: string, pattern?: string) => {
        const encodedQuery = encodeURIComponent(query);

        // 1. If we have a dynamic pattern from the supplier config, USE IT
        if (pattern && pattern.includes('{{query}}')) {
            return pattern.replace('{{query}}', encodedQuery);
        }

        if (!baseUrl) return null;
        const lowerUrl = baseUrl.toLowerCase();

        // 2. Legacy GFS Specific Logic (If no pattern is set for GFS yet)
        if (lowerUrl.includes('gfs') || lowerUrl.includes('gordon')) {
            const portalPref = localStorage.getItem('gfsPortalType') || 'gfs_store';
            if (portalPref === 'gordon_ordering') return `https://apps.gfs.com/doc/go/search?q=${encodedQuery}`;
            if (portalPref === 'gordon_experience') return `https://gordonexperience.com/search?q=${encodedQuery}`;
            return `https://gfsstore.com/products/?query=${encodedQuery}`;
        }

        // 3. Simple Fallbacks
        if (lowerUrl.includes('amazon')) return `https://www.amazon.com/s?k=${encodedQuery}`;
        if (lowerUrl.includes('webstaurantstore')) return `https://www.webstaurantstore.com/search/${encodedQuery}.html`;
        if (lowerUrl.includes('sysco')) return `https://www.sysco.com/search?q=${encodedQuery}`;

        if (!lowerUrl.includes('/')) return `https://${baseUrl}/search?q=${encodedQuery}`;
        return baseUrl;
    };


    return (
        <div className="max-w-6xl mx-auto p-4 md:p-8">
            <style dangerouslySetInnerHTML={{
                __html: `
                    @media print {
                    @page { margin: 0.2cm !important; size: portrait; }
                    /* Universal Cleanup */
                    header, footer, aside, nav, .print-hidden, 
                    [class*="flex justify-between items-start"],
                    [class*="bg-white dark:bg-slate-800 rounded-2xl"],
                    [class*="bg-slate-50 dark:bg-slate-800/50"],
                    .prep-plan-section,
                    .print-full-width,
                    button,
                    .sticky { 
                        display: none !important; 
                    }
                    
                    /* PARENT LAYOUT RESETS - FIXES BLANK PAGE */
                    .min-h-screen { min-height: 0 !important; height: auto !important; }
                    .max-w-7xl, .max-w-6xl { 
                        max-width: none !important; 
                        padding: 0 !important; 
                        margin: 0 !important; 
                    }
                    .py-8 { padding: 0 !important; }

                    /* STOP ANIMATIONS */
                    * {
                        animation: none !important;
                        transition: none !important;
                        transform: none !important;
                    }

                    body, html { 
                        background: white !important; 
                        margin: 0 !important;
                        padding: 0 !important;
                        width: 100% !important;
                        font-size: 8.5pt !important;
                    }

                    .print-list-container {
                        display: block !important;
                        width: 100% !important;
                        padding: 0 !important;
                        margin: 0 !important;
                    }
 
                    .print-columns-wrapper {
                        display: grid !important;
                        grid-template-columns: 36% 1fr !important;
                        gap: 0.3cm !important;
                        width: 100% !important;
                        align-items: start !important;
                        break-inside: auto !important;
                        break-before: auto !important;
                        margin-top: 0 !important;
                    }

                    .print-column-others {
                        column-count: 2 !important;
                        column-gap: 0.2cm !important;
                        column-fill: balance !important;
                        break-inside: auto !important;
                    }
                        
                        .print-supplier-box { 
                            display: block !important;
                            width: 100% !important;
                            break-inside: auto !important; 
                            margin-bottom: 3px !important;
                            border: 0.5px solid #cbd5e1 !important;
                            padding: 0 !important;
                        }
                        
                        .print-supplier-box tr { break-inside: avoid !important; }
                        
                        .print-supplier-box table td {
                            padding: 2px 3px !important;
                            font-size: 8pt !important;
                            line-height: 1 !important;
                        }
                        
                        .print-supplier-box .bg-slate-100 {
                            padding: 1px 4px !important;
                            font-size: 8pt !important;
                            font-weight: 950 !important;
                            background: #fef08a !important; /* Yellow highlight fill */
                            color: #000 !important;
                            -webkit-print-color-adjust: exact;
                            border-bottom: 0.5px solid #cbd5e1 !important;
                            white-space: nowrap !important;
                            overflow: hidden !important;
                            text-overflow: ellipsis !important;
                        }
                        
                        .item-meta-print {
                            font-size: 7pt !important;
                            color: #64748b !important;
                            display: block !important;
                            line-height: 1 !important;
                        }

                        h1 { font-size: 11pt !important; margin: 0 !important; font-weight: 950 !important; padding: 0 !important; }
                        .hidden.print\\:block { margin-bottom: 2px !important; border-bottom: 2px solid #000 !important; }
                    }
            `}} />
            <div className="flex justify-between items-start mb-8 print:hidden">
                {/* Header removed from here to let parent handle it, or keep it if independent*/}
                <div>
                    <h2 className="text-xl font-bold">Manual Planner</h2>
                </div>
                <div className="flex gap-3">
                    {/* Batch Print Button - Only show if items selected */}
                    {selectedForPrint.size > 0 && (
                        <button
                            onClick={() => {
                                const batchName = prompt("Enter a name for this print batch:", `Batch - ${new Date().toLocaleDateString()}`);
                                if (batchName) {
                                    // OPS-5A: the print batch is built from the PHYSICAL MEAL
                                    // MANIFEST, not from prepTasks.
                                    //
                                    // prepTasks is ingredient demand: 3 x Serves-2 is 1.5 there,
                                    // and rounding that would print 2 labels for 3 meals. The
                                    // manifest carries a discrete package count and the
                                    // authoritative tier per (recipe, tier), so a mixed plan
                                    // now yields SEPARATE Serves-5 and Serves-2 rows instead of
                                    // one row whose tier could not be named.
                                    //
                                    // Selection is still by recipe name, exactly as the Prep Plan
                                    // list presents it; a recipe selected in a mixed plan simply
                                    // contributes one batch row per tier.
                                    const selectedRecipes = Object.values(result?.assemblyTasks || {})
                                        .filter((row: any) => selectedForPrint.has(row.name))
                                        .map((row: any) => ({
                                            name: row.name,
                                            id: row.id,
                                            qty: row.qty,
                                            unit: row.unit,
                                            // The real physical label count — no `copies || 1`.
                                            copies: row.qty,
                                            variantSize: row.variantSize ?? null,
                                            servingTier: servingTierLabel(row.variantSize)
                                        }));

                                    // OPS-5E: same repair as "Batch Print All Labels" -- this
                                    // button carried the identical silent `if (businessId)`
                                    // swallow, and would have failed the same way.
                                    const written = writePrintBatch({
                                        name: batchName,
                                        items: selectedRecipes,
                                        // Batch-level tier remains as a fallback for any item
                                        // that could not prove its own; per-item tier wins.
                                        servingTier: result?.servingTier ?? null,
                                        businessId: businessId ?? null
                                    });

                                    if (!written.ok) {
                                        alert(`Could not prepare the print batch.\n\n${written.reason}`);
                                        return;
                                    }
                                    router.push('/production/print-batch');
                                }
                            }}
                            className="flex items-center gap-2 bg-indigo-600 text-white border border-indigo-500 px-4 py-2 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 animate-in zoom-in duration-200"
                        >
                            <Printer size={18} />
                            Print Batch ({selectedForPrint.size})
                        </button>
                    )}

                    <button
                        onClick={() => syncOnlineOrders()}
                        disabled={isSyncing}
                        className="flex items-center gap-2 bg-indigo-600 text-white border border-indigo-500 px-4 py-2 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50"
                        title="Load all active online orders into the calculator"
                    >
                        {isSyncing ? <RefreshCw className="animate-spin" size={18} /> : <RefreshCw size={18} />}
                        Auto-Sync Orders
                    </button>
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
                {bundlesLoadState === 'error' && (
                    <div className="mb-4 text-sm font-bold text-rose-600 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-xl px-4 py-3">
                        Unable to load Bundles. Please refresh and try again.
                    </div>
                )}
                <div className="space-y-3">
                    {orders.map((order, i) => (
                        <div key={i} className="flex gap-4 items-center">
                            <select
                                className="flex-1 px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white"
                                value={order.bundle_id}
                                onChange={(e) => updateOrder(i, 'bundle_id', e.target.value)}
                            >
                                <option value="">
                                    {bundlesLoadState === 'loading' ? 'Loading Bundles...'
                                        : bundlesLoadState === 'error' ? 'Unable to load Bundles'
                                        : bundles.length === 0 ? 'No active Bundles found'
                                        : 'Select Bundle...'}
                                </option>
                                {bundles.map(b => (
                                    <option key={b.id} value={b.id}>{b.name} ({b.sku})</option>
                                ))}
                            </select>
                            <input
                                type="number"
                                className="w-32 px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white"
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
                        <div className="hidden print:block mb-2 border-b-2 border-slate-900 pb-1">
                            <h1 className="text-xl font-black uppercase tracking-tight">Shopping List - {new Date().toLocaleDateString()}</h1>
                            <p className="text-[9px] font-bold text-slate-500 uppercase">Freezer IQ Logistics Center</p>
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

                        <div className="space-y-6 print:space-y-0">
                            {(() => {
                                const grouped = Object.values(result.rawIngredients).reduce((acc, item) => {
                                    if (!showAllItems && (item.onHand || 0) >= item.qty) return acc;
                                    const sup = item.supplier || 'Unassigned';
                                    if (!acc[sup]) acc[sup] = [];
                                    acc[sup].push(item);
                                    return acc;
                                }, {} as Record<string, typeof result.rawIngredients[string][]>);

                                const gfsItems = grouped['GFS'] || [];
                                const otherSuppliers = Object.entries(grouped)
                                    .filter(([sup]) => sup !== 'GFS')
                                    .sort((a, b) => a[0].localeCompare(b[0]));

                                const renderSupplierBox = (supplier: string, items: typeof result.rawIngredients[string][]) => (
                                    <div key={supplier} className="border border-slate-200 dark:border-slate-700/50 rounded-xl overflow-hidden print-supplier-box">
                                        <div className="bg-slate-100 dark:bg-slate-800 px-4 py-2 font-bold text-slate-700 dark:text-slate-300 text-sm uppercase tracking-wider flex justify-between print:px-2 print:py-1">
                                            <span className="print:text-xs text-indigo-700 dark:text-indigo-400">{supplier}</span>
                                            <span className="text-slate-400 font-normal print:text-[10px]">{items.length} items</span>
                                        </div>
                                        <table className="w-full text-left">
                                            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                                                {items.map((data, i) => {
                                                    const itemId = `${supplier}-${data.displayName}`;
                                                    const isChecked = shoppingChecked.has(itemId);
                                                    const isStocked = (data.onHand || 0) >= data.qty;
                                                    const isDone = isChecked || isStocked;

                                                    return (
                                                        <tr
                                                            key={i}
                                                            className={`transition-colors cursor-pointer group hover:bg-slate-50 dark:hover:bg-slate-800/50 
                                                                ${isChecked ? 'bg-slate-50 dark:bg-slate-900/50' : ''} 
                                                                ${isStocked ? 'bg-slate-50/50 dark:bg-slate-900/30' : ''}
                                                            `}
                                                            onClick={() => {
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

                                                            <td className={`p-3 text-right font-mono font-bold text-sm print:p-0 print:text-[10px] ${isChecked ? 'text-slate-400 dark:text-slate-500' : 'text-indigo-600 dark:text-indigo-400'}`}>
                                                                {toFraction(Number(data.netQty))} {data.unit}
                                                                {(data.qty > data.netQty || (data.purchaseQuantity && data.purchaseQuantity > 0)) && (
                                                                    <div className="item-meta-print">
                                                                        {data.qty > data.netQty && `T: ${toFraction(Number(data.qty))} `}
                                                                        {data.purchaseQuantity && data.purchaseQuantity > 0 && `(${(data.netQty / data.purchaseQuantity).toFixed(1)} ${data.purchaseUnit === 'Cases' ? 'cs' : (data.purchaseUnit || 'cs')})`}
                                                                    </div>
                                                                )}
                                                            </td>
                                                            <td className={`p-3 text-right font-mono font-bold text-sm print:hidden ${isChecked ? 'text-slate-400 dark:text-slate-500' : 'text-emerald-600 dark:text-emerald-500'}`}>
                                                                ${(data.netQty * data.costPerUnit).toFixed(2)}
                                                            </td>
                                                            <td className="p-3 text-right print:hidden" onClick={(e) => e.stopPropagation()}>
                                                                <a
                                                                    href={getSupplierSearchUrl(data.supplierUrl || (data.supplier === 'Amazon' ? 'amazon.com' : ''), data.displayName || '', data.searchUrlPattern) || '#'}
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
                                        <div className="bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700/50 p-3 flex justify-end items-center gap-4 print:hidden">
                                            <span className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Subtotal:</span>
                                            <span className="text-lg font-black text-slate-800 dark:text-slate-200 font-mono">
                                                ${items.reduce((sum, item) => sum + (item.qty * (item.costPerUnit || 0)), 0).toFixed(2)}
                                            </span>
                                        </div>
                                    </div>
                                );

                                return (
                                    <>
                                        {/* Web View */}
                                        <div className="space-y-6 print:hidden w-full">
                                            {Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0])).map(([sup, items]) => renderSupplierBox(sup, items))}
                                        </div>

                                        {/* Print View */}
                                        <div className="hidden print:grid print-columns-wrapper w-full">
                                            <div className="print-column-one">
                                                {gfsItems.length > 0 && renderSupplierBox('GFS', gfsItems)}
                                            </div>
                                            <div className="print-column-others">
                                                {otherSuppliers.map(([sup, items]) => renderSupplierBox(sup, items))}
                                            </div>
                                        </div>
                                    </>
                                );
                            })()}
                        </div>

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
                                    <button
                                        onClick={() => window.print()}
                                        className="bg-white dark:bg-indigo-600 text-slate-900 dark:text-white px-4 py-2 rounded-lg font-bold text-sm hover:bg-slate-100 dark:hover:bg-indigo-700 transition-colors flex items-center gap-2 print:hidden"
                                    >
                                        <Printer size={16} /> Print List
                                    </button>
                                </div>
                            </div>
                        )}
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
                                            btn.innerHTML = '<svg class="lucide lucide-printer" width="16" height="16"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg> Print Recipes';
                                        }

                                        // Open Print Window
                                        const printWindow = window.open('', '_blank');
                                        if (printWindow) {
                                            // Grouping Logic
                                            const groups: Record<string, {
                                                baseName: string;
                                                tasks: Record<string, any>; // tier -> task
                                                allIds: string[];
                                            }> = {};

                                            Object.entries(result.prepTasks).forEach(([fullName, task]) => {
                                                if (!details[task.id]) return;

                                                // Identify Base Name & Tier
                                                let baseName = fullName;
                                                let tier = 'family';

                                                if (fullName.includes('(Serves 2)')) {
                                                    baseName = fullName.replace('(Serves 2)', '').trim();
                                                    tier = 'serves_2';
                                                } else if (fullName.includes('(Keto)')) {
                                                    baseName = fullName.replace('(Keto)', '').trim();
                                                    tier = 'keto';
                                                } else if (fullName.includes('(Single)')) {
                                                    baseName = fullName.replace('(Single)', '').trim();
                                                    tier = 'single';
                                                }

                                                if (!groups[baseName]) {
                                                    groups[baseName] = { baseName, tasks: {}, allIds: [] };
                                                }
                                                groups[baseName].tasks[tier] = task;
                                                groups[baseName].allIds.push(task.id);
                                            });

                                            const sortedGroupNames = Object.keys(groups).sort();

                                            const groupsHtml = sortedGroupNames.map(baseName => {
                                                const group = groups[baseName];

                                                // Tiers to display (sorted for consistency)
                                                const availableTiers = ['family', 'serves_2', 'keto', 'single'].filter(t => !!group.tasks[t]);

                                                // 1. Render Columns Body
                                                const columnsHtml = availableTiers.map(tier => {
                                                    const task = group.tasks[tier];
                                                    const recipe = details[task.id];
                                                    const items = recipe?.items || recipe?.child_items || [];

                                                    // Group items by section (but only Standard for the side-by-side list)
                                                    const standardItems = items.filter((item: any) => (item.section_name || 'Standard Ingredients') === 'Standard Ingredients');

                                                    const tierLabel = tier === 'family' ? 'FAM (5)' : tier === 'serves_2' ? 'SRV (2)' : tier.toUpperCase();

                                                    const ingredientsHtml = standardItems.map((item: any) => {
                                                        const iName = item.name || item.child_recipe?.name || item.child_ingredient?.name || 'Unknown';
                                                        const qty = toFraction(Number(item.quantity));

                                                        return `
                                                            <div class="ingredient-item">
                                                                <div class="checkbox"></div>
                                                                <span class="qty-col-simple">${qty}</span>
                                                                <span class="unit-col-simple">${item.unit}</span>
                                                                <span class="name-label-simple">${iName}</span>
                                                            </div>`;
                                                    }).join('');

                                                    return `
                                                        <div class="tier-column">
                                                            <div class="tier-header">
                                                                <div class="tier-name">${tierLabel}</div>
                                                                <div class="tier-make">MAKE ${Math.round(task.qty)} UNITS</div>
                                                            </div>
                                                            <div class="section-container">
                                                                <div class="section-header">Standard Ingredients</div>
                                                                ${ingredientsHtml}
                                                            </div>
                                                        </div>
                                                    `;
                                                }).join('');

                                                // 2. Render Shared Batch/Sub-Recipe Boxes (Combined from all tiers)
                                                // We collect unique sub-recipes across all tasks in group
                                                const allSubRecipeItems: Record<string, any[]> = {};
                                                availableTiers.forEach(tier => {
                                                    const task = group.tasks[tier];
                                                    const recipe = details[task.id];
                                                    const items = recipe?.items || recipe?.child_items || [];
                                                    items.forEach((item: any) => {
                                                        const sName = item.section_name || 'Standard Ingredients';
                                                        if (sName !== 'Standard Ingredients') {
                                                            if (!allSubRecipeItems[sName]) allSubRecipeItems[sName] = [];
                                                            // We need to store original task qty for scaling later
                                                            allSubRecipeItems[sName].push({ ...item, taskQty: task.qty });
                                                        }
                                                    });
                                                });

                                                const batchBoxesHtml = Object.entries(allSubRecipeItems).map(([sName, sItems]) => {
                                                    // Logic: Combine duplicates by name within the sub-recipe box
                                                    const combinedItems: Record<string, { qty: number, unit: string, name: string }> = {};
                                                    sItems.forEach(item => {
                                                        const iName = item.name || item.child_recipe?.name || item.child_ingredient?.name || 'Unknown';
                                                        const key = `${iName}-${item.unit}`;
                                                        if (!combinedItems[key]) combinedItems[key] = { qty: 0, unit: item.unit, name: iName };

                                                        const scaleFactor = item.taskQty * (Number(item.section_batch) || 1);
                                                        combinedItems[key].qty += Number(item.quantity) * scaleFactor;
                                                    });

                                                    const itemsHtml = Object.values(combinedItems).map(ci => `
                                                        <div class="ingredient-item">
                                                            <div class="checkbox" style="margin-right: 16px;"></div>
                                                            <span class="qty-col-simple" style="width: 80px; text-align: left; border-right: none; font-size: 8pt;">TOTAL: ${toFraction(ci.qty)}</span>
                                                            <span class="unit-col-simple" style="width: 40px;">${ci.unit}</span>
                                                            <span class="name-label-simple">${ci.name}</span>
                                                        </div>
                                                    `).join('');

                                                    return `
                                                        <div class="section-container box-section" style="width: 100%; grid-column: span ${availableTiers.length};">
                                                            <div class="section-header box-header">
                                                                <div style="display: flex; justify-content: space-between;">
                                                                    <span>${sName}</span>
                                                                    <span style="font-size: 6pt;">(COMBINED BATCH SCALE)</span>
                                                                </div>
                                                            </div>
                                                            ${itemsHtml}
                                                        </div>
                                                    `;
                                                }).join('');

                                                // 3. Instructions (Shared)
                                                const firstRecipe = details[Object.values(group.tasks)[0].id];

                                                return `
                                                    <div class="recipe-block">
                                                        <div class="recipe-title-bar">${baseName}</div>
                                                        <div class="tier-grid" style="display: grid; grid-template-columns: repeat(${availableTiers.length}, 1fr); gap: 15px;">
                                                            ${columnsHtml}
                                                            ${batchBoxesHtml}
                                                        </div>
                                                        ${firstRecipe.instructions ? `
                                                            <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #e2e8f0;">
                                                                <div class="section-header">Instructions</div>
                                                                <div style="font-size: 8pt; color: #475569; line-height: 1.4; white-space: pre-wrap;">${firstRecipe.instructions}</div>
                                                            </div>
                                                        ` : ''}
                                                    </div>
                                                `;
                                            }).join('');

                                            // Final HTML Assembly
                                            const htmlContent = `
                                                <html>
                                                <head>
                                                    <title>Recipe Prep Sheet</title>
                                                    <style>
                                                        body { font-family: sans-serif; padding: 10px; margin: 0; color: #1e293b; font-size: 7pt; }
                                                        .recipe-block { margin-bottom: 25px; break-inside: avoid; padding: 0; }
                                                        .recipe-title-bar { font-size: 12pt; font-weight: 900; text-transform: uppercase; letter-spacing: -0.02em; border-bottom: 2px solid #1e293b; margin-bottom: 8px; padding-bottom: 4px; color: #0f172a; }

                                                        .tier-header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #94a3b8; margin-bottom: 4px; padding-bottom: 2px; }
                                                        .tier-name { font-size: 8pt; font-weight: 800; color: #475569; }
                                                        .tier-make { font-size: 8pt; font-weight: 900; color: #4f46e5; font-family: monospace; }

                                                        .section-container { margin-top: 4px; }
                                                        .section-header { font-weight: 800; font-size: 7pt; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; border-bottom: 1px solid #f1f5f9; padding-bottom: 1px; }

                                                        .ingredient-item {
                                                            padding: 2px 0;
                                                            border-bottom: 1px dashed #f1f5f9;
                                                            display: flex;
                                                            align-items: center;
                                                            font-size: 7.5pt;
                                                        }
                                                        .ingredient-item:last-child { border-bottom: none; }
                                                        .checkbox { width: 10px; height: 10px; border: 1px solid #cbd5e1; margin-right: 6px; border-radius: 2px; flex-shrink: 0; }

                                                        .qty-col-simple { width: 35px; text-align: right; font-weight: 800; color: #1e293b; margin-right: 4px; flex-shrink: 0; }
                                                        .unit-col-simple { width: 30px; color: #64748b; font-size: 7pt; flex-shrink: 0; }
                                                        .name-label-simple { color: #334155; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; }

                                                        .box-section { border: 1.5px solid #10b981; background: #f0fdf4; padding: 6px; border-radius: 4px; margin-top: 8px; }
                                                        .box-header { color: #059669; font-weight: 900; font-size: 7pt; margin-bottom: 4px; }

                                                        @media print {
                                                            @page { margin: 0.3cm; }
                                                            body { padding: 0; }
                                                        }
                                                    </style>
                                                </head>
                                                <body>
                                                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px;">
                                                        <h1 style="font-size:14pt; font-weight: 900; margin: 0; letter-spacing: -0.04em;">RECIPE PREP SHEET</h1>
                                                        <div style="text-align: right; color: #64748b; font-weight: bold; font-size: 7pt;">${new Date().toLocaleDateString()}</div>
                                                    </div>

                                                    ${groupsHtml}

                                                    <script>
                                                        window.onload = () => { setTimeout(() => { window.print(); window.close(); }, 500); };
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
                                    onClick={() => {
                                        if (!result || !result.assemblyTasks || Object.keys(result.assemblyTasks).length === 0) {
                                            alert('No recipes to print labels for. Please calculate a production plan first.');
                                            return;
                                        }

                                        // OPS-5D: this button now builds the SAME physical meal
                                        // manifest batch the "Print Batch (N)" button already uses,
                                        // and opens the existing OPS-5-hardened browser-print
                                        // surface -- rather than independently deriving copy counts
                                        // from prepTasks (ingredient demand: lib/kitchen_engine.ts's
                                        // own comment is explicit that "Nothing downstream may
                                        // derive a label count from prepTasks") and POSTing straight
                                        // to a printer API that, absent DCG_API_KEY/DCG_LOCATION_ID,
                                        // is a MOCK that cannot truthfully claim physical delivery.
                                        // assemblyTasks is the one physical-count authority
                                        // (OPS-5A); reusing it here, and reusing the browser-print
                                        // route, means there is no second print renderer and
                                        // nothing here can claim a false "sent successfully."
                                        const allRecipes = Object.values(result.assemblyTasks).map((row: any) => ({
                                            name: row.name,
                                            id: row.id,
                                            qty: row.qty,
                                            unit: row.unit,
                                            // The real physical label count — no `copies || 1`.
                                            copies: row.qty,
                                            variantSize: row.variantSize ?? null,
                                            servingTier: servingTierLabel(row.variantSize)
                                        }));

                                        // OPS-5E: the handoff no longer depends on a client
                                        // businessId. This exact click did NOTHING on the
                                        // deployed OPS-5D preview because it was wrapped in
                                        // `if (businessId) { ...; router.push(...) }` with no
                                        // else -- and OPS-5B/OPS-5C had already proven twice
                                        // that useSession()'s businessId is not reliably
                                        // present here. The key now comes from the one shared
                                        // authority (lib/printBatchStorage.ts), businessId is
                                        // recorded inside the payload as an advisory tenant
                                        // guard rather than a gate, and a failed write is
                                        // SHOWN rather than swallowed.
                                        const written = writePrintBatch({
                                            name: `Batch - ${new Date().toLocaleDateString()}`,
                                            items: allRecipes,
                                            // Batch-level tier remains as a fallback for any item
                                            // that could not prove its own; per-item tier wins.
                                            servingTier: result?.servingTier ?? null,
                                            businessId: businessId ?? null
                                        });

                                        if (!written.ok) {
                                            alert(`Could not prepare the print batch.\n\n${written.reason}`);
                                            return;
                                        }
                                        router.push('/production/print-batch');
                                    }}
                                    className="flex items-center gap-2 text-sm font-bold text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 px-3 py-2 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors print:hidden disabled:opacity-50 border border-indigo-200 dark:border-indigo-800"
                                >
                                    <Printer size={16} />
                                    Batch Print All Labels
                                </button>
                            </div>
                        </div>
                        <div className="space-y-4">
                            {Object.entries(result.prepTasks)
                                .sort((a, b) => a[0].localeCompare(b[0]))
                                .map(([name, data]) => {
                                    // OPS-5D: the physical label copy count comes from the
                                    // manifest (assemblyTasks), NEVER from prepTasks' qty --
                                    // that is ingredient demand (lib/kitchen_engine.ts: "Nothing
                                    // downstream may derive a label count from prepTasks").
                                    const manifestRows = Object.values(result.assemblyTasks || {})
                                        .filter((row: any) => row.id === data.id);
                                    const physicalCopies = manifestRows
                                        .reduce((sum: number, row: any) => sum + row.qty, 0);
                                    // OPS-5E / Part H: a recipe can appear at MORE THAN ONE tier
                                    // in the same plan (S5 qty2 + S2 qty3). The Label Designer
                                    // this button routes into can only claim ONE serving tier, so
                                    // sending it the summed 5 would print five labels all naming
                                    // the wrong tier -- collapsing two tiers into an untrue one.
                                    // A mixed-tier recipe therefore goes through the tier-aware
                                    // batch surface instead, which keeps one row per tier.
                                    const isMixedTier = distinctTierCount(manifestRows as any) > 1;
                                    return (
                                        <div key={name} className="flex justify-between items-center p-4 rounded-xl bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 hover:border-amber-200 transition-colors cursor-pointer"
                                            onClick={() => {
                                                const next = new Set(selectedForPrint);
                                                if (next.has(name)) next.delete(name);
                                                else next.add(name);
                                                setSelectedForPrint(next);
                                            }}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${selectedForPrint.has(name) ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'}`}>
                                                    {selectedForPrint.has(name) && <Check size={14} className="text-white" />}
                                                </div>
                                                <span className="font-bold text-slate-700 dark:text-slate-300">{name}</span>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (isMixedTier) {
                                                            // Tier-aware route: one batch row per tier.
                                                            const written = writePrintBatch({
                                                                name: `${name} - ${new Date().toLocaleDateString()}`,
                                                                items: manifestRows.map((row: any) => ({
                                                                    name: row.name,
                                                                    id: row.id,
                                                                    qty: row.qty,
                                                                    unit: row.unit,
                                                                    copies: row.qty,
                                                                    variantSize: row.variantSize ?? null,
                                                                    servingTier: servingTierLabel(row.variantSize)
                                                                })),
                                                                servingTier: null,
                                                                businessId: businessId ?? null
                                                            });
                                                            if (!written.ok) {
                                                                alert(`Could not prepare the print batch.\n\n${written.reason}`);
                                                                return;
                                                            }
                                                            router.push('/production/print-batch');
                                                            return;
                                                        }
                                                        router.push(`/labels?recipeId=${data.id}&printQty=${physicalCopies}&from=production`);
                                                    }}
                                                    className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 px-2.5 py-1.5 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors"
                                                    title={`Print ${physicalCopies} labels for ${name}`}
                                                >
                                                    <Printer size={14} />
                                                    Print Labels ({physicalCopies})
                                                </button>
                                                <span className="font-mono font-bold text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 rounded text-sm">
                                                    {Math.round(data.qty)} {data.unit}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ProductionCalculator;
