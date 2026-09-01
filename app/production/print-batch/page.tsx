"use client";

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer, Trash2, Settings, CheckCircle, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import LabelTemplate from '@/components/LabelTemplate';
import { resolveLabelAllergens } from '@/lib/allergens';
import { resolveLabelIngredients, collectBlockedLabels } from '@/lib/mealLabel';

interface BatchItem {
    name: string;
    id: string;
    qty: number;
    unit: string;
    status?: 'pending' | 'printed' | 'error';
    copies?: number;
}

interface BatchJob {
    name: string;
    items: BatchItem[];
    /**
     * OPS-5: the serving tier this whole batch can truthfully claim
     * ("Serves 5" / "Serves 2"), resolved server-side by
     * /api/production/plan from the authoritative per-line tier. Null when the
     * plan mixed tiers - the label then omits the claim rather than guessing,
     * because KitchenEngine's prepTasks already merged the meals.
     */
    servingTier?: string | null;
}

export default function ProductionBatchPrintPage() {
    const router = useRouter();
    const { data: session } = useSession() as { data: any };
    const businessId = session?.user?.businessId;

    const [batch, setBatch] = useState<BatchJob | null>(null);
    const [labelSize, setLabelSize] = useState('2x6'); // Default to 2" x 6"
    const [printMethod, setPrintMethod] = useState<'browser' | 'api'>('browser');
    const [isPrinting, setIsPrinting] = useState(false);

    // Store full recipe details (ingredients, allergens, etc.) keyed by Recipe ID
    const [batchDetails, setBatchDetails] = useState<Record<string, any>>({});
    const [loadingDetails, setLoadingDetails] = useState(false);

    // Global Config for Batch (Could be made granular later)
    const [config, setConfig] = useState({
        showIngredients: true,
        showAllergens: true,
        showDates: true, // Show Expiry
        showNotes: false,
        showQRCode: false
    });

    const [branding, setBranding] = useState<any>(null);

    useEffect(() => {
        if (!businessId) return;
        const savedBatch = localStorage.getItem(`${businessId}_printBatch`);
        if (savedBatch) {
            try {
                const parsed = JSON.parse(savedBatch);
                setBatch(parsed);

                // Fetch Details for all items
                if (parsed.items && parsed.items.length > 0) {
                    fetchBatchDetails(parsed.items);
                }

                // Fetch Branding
                fetch('/api/tenant/branding').then(res => res.json()).then(setBranding).catch(console.error);
            } catch (e) {
                console.error("Failed to parse batch");
            }
        }
    }, [businessId]);

    const fetchBatchDetails = async (items: BatchItem[]) => {
        setLoadingDetails(true);
        const uniqueIds = Array.from(new Set(items.map(i => i.id)));
        const details: Record<string, any> = {};

        // OPS-5: allergen detection is no longer defined here. It lives in
        // lib/allergens.ts, the ONE authority every meal-label surface shares,
        // so the same ingredient text can no longer produce different allergens
        // depending on which print button the kitchen pressed.
        await Promise.all(uniqueIds.map(async (id) => {
            try {
                // Determine if this is a recipe or just an item (simple check, assume recipe API works for both or handles it)
                const res = await fetch(`/api/recipes/${id}`);
                const data = await res.json();

                if (data && !data.error) {
                    const ingredients = data.child_items?.map((item: any) =>
                        item.child_ingredient?.name || item.child_recipe?.name
                    ).filter(Boolean).join(', ') || '';

                    details[id] = {
                        ...data,
                        processedIngredients: ingredients,
                        processedAllergens: resolveLabelAllergens(data.allergens, ingredients)
                    };
                }
            } catch (e) {
                // OPS-5: the failure is still logged, but it is no longer
                // SILENT. `details[id]` stays absent, and the print gate below
                // turns that absence into a hard stop instead of a placeholder
                // string on a physical label.
                console.error(`Failed to fetch details for ${id}`, e);
            }
        }));

        setBatchDetails(details);
        setLoadingDetails(false);
    };

    /**
     * OPS-5 — the fail-closed print gate.
     *
     * Required food data is verified for EVERY queued label before any of them
     * can print. A meal whose ingredients could not be loaded blocks the batch
     * and is named, so the kitchen knows exactly which recipe to fix rather
     * than discovering a bad label on the food.
     *
     * Scope is deliberate: only data the label FORMAT actually requires is
     * gated. Ingredients are gated only when `config.showIngredients` is on AND
     * the selected size actually renders them - the 2.25x1.25 and 4x6 layouts
     * below take the simple name/qty/date path and never print an ingredient
     * list, so blocking those would be a kitchen stoppage for data they do not
     * use. Tenant branding is NOT gated either: a missing logo is cosmetic.
     */
    const blockedLabels = (!batch || loadingDetails)
        ? []
        : collectBlockedLabels(
            batch.items,
            Object.fromEntries(
                Object.entries(batchDetails).map(([id, d]) => [id, d?.processedIngredients])
            ),
            // Ingredients are required only by the layout that actually prints
            // them (see the doc comment above).
            config.showIngredients && labelSize === '2x6',
        );

    const handlePrintAll = async () => {
        if (!batch) return;

        // OPS-5 FAIL CLOSED: never print a label whose required food data is
        // missing. A physical label outlives the request that produced it.
        if (blockedLabels.length > 0) {
            alert(
                'Printing stopped.\n\n'
                + blockedLabels.map(b => b.reason).join('\n\n')
                + '\n\nRemove the affected item(s) from the queue, or reload once the recipe data is available.'
            );
            return;
        }

        setIsPrinting(true);

        if (printMethod === 'browser') {
            window.print();
            setTimeout(() => {
                // Only mark printed, don't auto-redirect so they can reprint if needed or verify
                // Mark all as printed (optimistically) after a delay
                const updatedItems = batch.items.map(item => ({ ...item, status: 'printed' as const }));
                setBatch({ ...batch, items: updatedItems });
                setIsPrinting(false);

                if (confirm("Did the labels print correctly?")) {
                    // Could clear batch or redirect
                    localStorage.removeItem(`${businessId}_printBatch`);
                    router.push('/production');
                }
            }, 1000);
        } else {
            alert("API Printing not yet configured.");
            setIsPrinting(false);
        }
    };

    const removeItem = (index: number) => {
        if (!batch) return;
        const newItems = batch.items.filter((_, i) => i !== index);
        setBatch({ ...batch, items: newItems });
        if (businessId) {
            localStorage.setItem(`${businessId}_printBatch`, JSON.stringify({ ...batch, items: newItems }));
        }
    };

    // Helper to construct LabelProps from Item + Details
    const getLabelProps = (item: BatchItem) => {
        const detail = batchDetails[item.id] || {};

        // Expiry Logic: Default 6 months if not set
        const expiry = new Date();
        expiry.setMonth(expiry.getMonth() + 6);

        // OPS-5: ingredients are resolved through the fail-closed authority.
        // There is deliberately NO placeholder fallback here - the old
        // `|| "Ingredients loading..."` printed that literal string onto
        // physical food labels whenever the recipe fetch failed. If this
        // resolves to !ok, `blockedLabels` has already stopped the print, and
        // the empty string below is only ever seen in the on-screen preview.
        const ingredientCheck = resolveLabelIngredients(item.name, detail.processedIngredients);

        // OPS-5: the serving tier is the batch-level authority resolved by
        // /api/production/plan (a sold OrderItem.variant_size snapshot, or a
        // manual row's tenant-scoped Bundle.serving_tier). It is NEVER
        // re-derived here, and when the plan could not prove a single tier the
        // field falls back to the recipe's own yield unit rather than claiming
        // a serving size the batch cannot support.
        const tier = batch?.servingTier;

        return {
            content: {
                name: item.name,
                ingredients: ingredientCheck.ok ? ingredientCheck.text : "",
                allergens: detail.processedAllergens || "",
                expiry: expiry.toLocaleDateString(),
                mealSize: tier || detail.base_yield_unit || `${Math.round(item.qty)} ${item.unit}`,
                instructions: detail.label_text || "",
                macros: detail.macros || ""
            },
            config: config,
            logoUrl: branding?.logo_url,
            // batch does not support QR codes yet
            qrCodeUrl: null,
            colorMode: 'bw' as const,
            onClearUpload: undefined
        };
    };

    if (!batch) return <div className="p-12 text-center">Loading batch...</div>;

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 print:bg-white">
            {/* Header (No Print) */}
            <div className="print:hidden max-w-4xl mx-auto p-6">
                <div className="flex items-center gap-4 mb-8">
                    <Link href="/production" className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                        <ArrowLeft size={20} className="text-slate-500" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
                            <Printer className="text-indigo-600" />
                            {batch.name}
                        </h1>
                        <p className="text-slate-500 font-medium">{batch.items.length} Labels Queued</p>
                    </div>
                </div>

                {/* Controls */}
                <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 mb-8">
                    <div className="flex flex-wrap gap-6 items-end">
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Print Method</label>
                            <select
                                value={printMethod}
                                onChange={e => setPrintMethod(e.target.value as any)}
                                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                            >
                                <option value="browser">Browser Print (Universal)</option>
                                <option value="api" disabled>DateCodeGenie (Coming Soon)</option>
                            </select>
                        </div>
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Label Size</label>
                            <select
                                value={labelSize}
                                onChange={e => setLabelSize(e.target.value)}
                                className="w-full p-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                            >
                                <option value="2x6">Roll - 2" x 6" (Prep)</option>
                                <option value="2.25x1.25">Roll - 2.25" x 1.25"</option>
                                <option value="4x6">Roll - 4" x 6" (Shipping)</option>
                            </select>
                        </div>
                        <button
                            onClick={handlePrintAll}
                            disabled={batch.items.length === 0 || isPrinting || loadingDetails || blockedLabels.length > 0}
                            className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center gap-2"
                        >
                            <Printer size={20} />
                            {loadingDetails ? 'Loading Data...' : blockedLabels.length > 0 ? 'Printing Blocked' : 'Print All'}
                        </button>
                    </div>

                    {/* OPS-5: fail-closed notice. Required food data is missing,
                        so no label in this batch may print. */}
                    {blockedLabels.length > 0 && (
                        <div className="mt-6 bg-rose-50 dark:bg-rose-900/20 border-2 border-rose-300 dark:border-rose-800 rounded-xl p-5">
                            <div className="flex items-start gap-3">
                                <AlertCircle size={22} className="text-rose-600 shrink-0 mt-0.5" />
                                <div>
                                    <h4 className="font-black text-rose-900 dark:text-rose-200 mb-2">
                                        Printing stopped — incomplete food data
                                    </h4>
                                    <ul className="space-y-1.5">
                                        {blockedLabels.map((b, i) => (
                                            <li key={i} className="text-sm font-medium text-rose-800 dark:text-rose-300">
                                                {b.reason}
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="text-xs font-bold text-rose-700 dark:text-rose-400 mt-3">
                                        Remove the affected item(s) from the queue, or reload once the recipe data is available.
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* OPS-5: the plan mixed serving tiers, so prepTasks already
                        merged those meals and no single tier is true for all of
                        them. The label omits the claim rather than guessing. */}
                    {batch.servingTier == null && !loadingDetails && (
                        <div className="mt-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-800 rounded-xl p-4 flex items-start gap-3">
                            <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                            <p className="text-xs font-bold text-amber-800 dark:text-amber-300">
                                These labels will not show a serving size. This plan did not resolve to a single
                                serving tier, so no tier can be printed truthfully. Plan Serves&nbsp;5 and
                                Serves&nbsp;2 separately if you need per-tier meal labels.
                            </p>
                        </div>
                    )}
                </div>

                {/* Live Preview */}
                {batch.items.length > 0 && (
                    <div className="mb-8">
                        <h3 className="font-bold text-lg mb-4 text-slate-900 dark:text-white flex items-center gap-2">
                            <CheckCircle size={20} className="text-indigo-600" />
                            Batch Preview
                        </h3>
                        <div className="bg-slate-100 dark:bg-slate-800/50 p-8 rounded-2xl border border-slate-200 dark:border-slate-700 flex flex-col items-center">
                            {/* We just show the first label as a sample */}
                            {loadingDetails ? (
                                <div className="text-slate-400 font-bold animate-pulse">Loading recipe assets...</div>
                            ) : (
                                <LabelTemplate {...getLabelProps(batch.items[0])} />
                            )}
                            <p className="mt-4 text-xs text-slate-500 font-medium">
                                Preview of first item. Only 2" x 6" layout supports full details.
                            </p>
                        </div>
                    </div>
                )}

                {/* Queue List */}
                <div className="space-y-3">
                    {batch.items.map((item, i) => (
                        <div key={i} className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between group">
                            <div className="flex items-center gap-4">
                                <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-500 font-bold text-xs">
                                    {i + 1}
                                </div>
                                <div>
                                    <div className="font-bold text-slate-900 dark:text-white">{item.name}</div>
                                    <div className="text-xs text-slate-500 font-mono">Qty: {Math.round(item.qty)} {item.unit}</div>
                                </div>
                            </div>
                            <button
                                onClick={() => removeItem(i)}
                                className="text-slate-300 hover:text-rose-500 transition-colors p-2"
                            >
                                <Trash2 size={18} />
                            </button>
                        </div>
                    ))}
                </div>
            </div>

            {/* PRINT OPTIMIZED LAYOUT */}
            <div className="hidden print:block">
                <style dangerouslySetInnerHTML={{
                    __html: `
                        @media print {
                            @page {
                                size: ${labelSize === '2x6' ? '2in 6in' : labelSize === '2.25x1.25' ? '2.25in 1.25in' : '4in 6in'};
                                margin: 0;
                            }
                            body { margin: 0; padding: 0; }
                            .print-page {
                                break-after: always;
                                page-break-after: always;
                                width: ${labelSize === '2x6' ? '2in' : labelSize === '2.25x1.25' ? '2.25in' : '4in'};
                                height: ${labelSize === '2x6' ? '6in' : labelSize === '2.25x1.25' ? '1.25in' : '6in'};
                                overflow: hidden;
                                display: flex;
                                flex-direction: column;
                                justify-content: center;
                                align-items: center;
                                text-align: center;
                                padding: 0.1in; /* Default padding for basic text labels */
                                box-sizing: border-box;
                            }
                            
                            /* Reset padding for the Template Label since it manages its own padding */
                            .print-page.template-mode {
                                padding: 0 !important;
                                display: block !important; /* Allow the label container to take full flow */
                            }
                        }
                    `
                }} />

                {/* OPS-5: the fail-closed gate lives in the PRINTABLE DOM, not
                    only on the button. This block is `hidden print:block` — CSS
                    hidden, always mounted — so an operator pressing Ctrl+P (or
                    the browser's own Print command) bypasses `handlePrintAll`
                    entirely and prints whatever is rendered here. Refusing to
                    render the labels themselves is what actually makes an
                    incomplete food label unprintable. */}
                {blockedLabels.length > 0 ? (
                    <div className="print-page">
                        <div style={{ fontSize: '14pt', fontWeight: 900, lineHeight: 1.2, marginBottom: '8px' }}>
                            DO NOT USE
                        </div>
                        <div style={{ fontSize: '9pt', fontWeight: 'bold', lineHeight: 1.3 }}>
                            Label printing was stopped: required ingredient data could not be loaded
                            for {blockedLabels.length} item{blockedLabels.length === 1 ? '' : 's'} in this batch.
                        </div>
                        <div style={{ fontSize: '8pt', marginTop: '8px', lineHeight: 1.3 }}>
                            {blockedLabels.map(b => b.name).join(', ')}
                        </div>
                    </div>
                ) : batch.items.flatMap((item, i) => {
                    const copies = Math.max(1, Math.round(item.copies || 1));
                    return Array.from({ length: copies }).map((_, copyIndex) => {
                        // Use Template for 2x6, Basic Text for others (until we make template responsive)
                        if (labelSize === '2x6') {
                            return (
                                <div key={`${i}-${copyIndex}`} className="print-page template-mode">
                                    <LabelTemplate {...getLabelProps(item)} />
                                </div>
                            );
                        }

                        // Fallback for small/large simple labels
                        return (
                            <div key={`${i}-${copyIndex}`} className="print-page">
                                <div style={{
                                    fontSize: labelSize === '2.25x1.25' ? '10pt' : '16pt',
                                    fontWeight: '900',
                                    lineHeight: 1.1,
                                    marginBottom: '4px'
                                }}>
                                    {item.name}
                                </div>
                                <div style={{
                                    fontSize: labelSize === '2.25x1.25' ? '8pt' : '12pt',
                                    fontWeight: 'bold'
                                }}>
                                    {Math.round(item.qty)} {item.unit}
                                </div>
                                <div style={{
                                    fontSize: labelSize === '2.25x1.25' ? '6pt' : '8pt',
                                    marginTop: 'auto',
                                    paddingBottom: '0'
                                }}>
                                    {new Date().toLocaleDateString()}
                                </div>
                            </div>
                        );
                    });
                })}
            </div>
        </div>
    );
}
