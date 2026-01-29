"use client";



import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import { Printer, Save, AlertTriangle, Eye, Settings, Trash2, Plus, Package, ArrowLeft, CheckCircle } from 'lucide-react';
import LabelRichText from '@/components/LabelRichText';

export default function LabelsPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const from = searchParams.get('from');

    // Configuration State
    const [config, setConfig] = useState({
        showIngredients: true,
        showAllergens: true,
        showDates: true,
        showNotes: false,
        showQRCode: false,
        printerProfileId: '',
        locationId: ''
    });

    // Printing State
    const [printQty, setPrintQty] = useState(1);

    const [isSaving, setIsSaving] = useState(false);
    const [isTesting, setIsTesting] = useState(false);

    // Label Inventory State
    const [labelInventory, setLabelInventory] = useState(0);
    const [showInventoryModal, setShowInventoryModal] = useState(false);
    const [purchaseQty, setPurchaseQty] = useState(100);

    // Color Mode State
    const [colorMode, setColorMode] = useState<'color' | 'bw'>('bw');

    // Label Content State (Editable)
    // Default Expiry: 6 Months from Today
    const defaultExpiry = new Date();
    defaultExpiry.setMonth(defaultExpiry.getMonth() + 6);

    const [logo, setLogo] = useState<string | null>(null);

    // Cooking Instruction Sets
    const [instructionSets, setInstructionSets] = useState<{ name: string, text: string }[]>([]);
    const [selectedSet, setSelectedSet] = useState('');

    // QR Codes State
    const [qrCodes, setQrCodes] = useState<{ id: string, name: string, data: string }[]>([]);
    const [selectedQrId, setSelectedQrId] = useState('');

    const [labelContent, setLabelContent] = useState({
        name: "Spicy Marinara Base",
        ingredients: "Tomatoes, Onions, Garlic, Olive Oil, Basil, Red Pepper Flakes, Salt, Black Pepper",
        allergens: "Garlic, Nightshades",
        expiry: defaultExpiry.toLocaleDateString(),
        mealSize: "Serves 2",
        instructions: "Preheat oven to 375°F. Remove film. Bake for 20-25 minutes until bubbling. Let stand for 2 minutes.",
        macros: ""
    });

    // Instructions Style State
    // (Styles are now inline via rich text)
    // Instructions Style State
    // (Styles are now inline via rich text)
    const [instructionStyle, setInstructionStyle] = useState({});

    // Ref to store loaded instruction sets for immediate use in useEffect
    const loadedSetsRef = useRef<{ name: string, text: string }[]>([]);

    // Load Label Inventory
    const fetchInventory = async () => {
        try {
            const res = await fetch('/api/labels/inventory');
            if (res.ok) {
                const data = await res.json();
                setLabelInventory(data.inventory);
            }
        } catch (e) {
            console.error('Failed to fetch label inventory', e);
        }
    };

    // Load Settings, Logo, & Draft Content
    useEffect(() => {
        const savedConfig = localStorage.getItem('labelConfig');
        if (savedConfig) {
            setConfig(JSON.parse(savedConfig));
        }
        const savedLogo = localStorage.getItem('kitchenLogo');
        if (savedLogo) setLogo(savedLogo);

        // Load Instruction Sets FIRST (before recipe fetch needs them)
        const savedSets = localStorage.getItem('instructionSets');
        const defaultSets = [
            { name: "Oven - Serves 2", text: "Preheat oven to 375°F. Remove film. Bake for 20-25 minutes." },
            { name: "Oven - Family", text: "Preheat oven to 375°F. Remove film. Bake for 45-50 minutes." },
            { name: "Microwave - Serves 2", text: "Pierce film. Microwave on High for 3-4 minutes." }
        ];
        const parsedSets = savedSets ? JSON.parse(savedSets) : defaultSets;
        setInstructionSets(parsedSets);
        loadedSetsRef.current = parsedSets;

        const params = new URLSearchParams(window.location.search);
        const recipeId = params.get('recipeId');
        const qtyParam = params.get('qty');
        const unitParam = params.get('unit');

        const bundleHint = params.get('bundleHint');
        const printQtyParam = params.get('printQty');
        const skuParam = params.get('sku');

        console.log('Labels Page - URL Parameters:', { recipeId, bundleHint, printQtyParam, skuParam });

        if (printQtyParam) setPrintQty(Number(printQtyParam));

        if (recipeId) {
            // Fetch Recipe Data
            // UUIDs have dashes, so don't split by dash blindly!
            // If we strictly use UUIDs, pass directly.
            fetch(`/api/recipes/${recipeId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.error) {
                        console.error("Recipe API Error:", data.error);
                        return;
                    }
                    const ingreds = data.child_items?.map((item: any) =>
                        item.child_ingredient?.name || item.child_recipe?.name
                    ).filter(Boolean).join(', ') || '';

                    setLabelContent(prev => {
                        // Priority 0: Bundle Hint (Strongest)
                        let detectedSize = bundleHint || data.base_yield_unit;

                        // If unit is generic/missing, try to parse from Name
                        const genericUnits = ['batch', 'unit', 'units', 'lb', 'lbs', 'kg', 'oz', 'g'];
                        const isGeneric = !detectedSize || genericUnits.includes(detectedSize.toLowerCase());

                        if (isGeneric) {
                            if (data.name.toLowerCase().includes('family')) detectedSize = 'Family Size';
                            else if (data.name.toLowerCase().match(/serves\s*\d+/)) detectedSize = data.name.match(/serves\s*\d+/i)[0];
                            else if (unitParam && unitParam !== 'batch') detectedSize = unitParam;
                        }

                        // SKU Based Logic (Overrides generic)
                        if (skuParam) {
                            const upperSku = skuParam.toUpperCase();
                            console.log('SKU Detection:', { skuParam, upperSku });
                            if (upperSku.endsWith('FSK')) detectedSize = 'Family Size (Keto)';
                            else if (upperSku.endsWith('S2K')) detectedSize = 'Serves 2 (Keto)';
                            else if (upperSku.endsWith('FS')) detectedSize = 'Family Size';
                            else if (upperSku.endsWith('S2')) detectedSize = 'Serves 2';
                            console.log('Detected Size from SKU:', detectedSize);
                        }

                        // Fallback logic
                        if (!detectedSize || detectedSize === 'batch') {
                            // If we have a unit param (e.g. "ea", "tray"), use it.
                            if (unitParam && unitParam !== 'batch') detectedSize = unitParam;
                            // Otherwise default to "1 Batch" (instead of "5 Batches" which confusingly implies the whole run is in one container)
                            else detectedSize = '1 Batch';
                        }


                        // Auto-Populate Instructions from Set if available and detectedSize is known
                        // (Only if recipe instructions are empty OR user explicitly wants SKU to drive it?)
                        let instructions = data.instructions || '';

                        // Heuristic: If we have a detected size, check for sets matching that size
                        if (detectedSize) {
                            // Clean size for matching (e.g. "Family Size" -> "Family")
                            const sizeKeyword = detectedSize.includes('Family') ? 'Family' : (detectedSize.includes('Serves 2') ? 'Serves 2' : '');

                            console.log('Instruction Matching:', { detectedSize, sizeKeyword, skuParam, availableSets: loadedSetsRef.current });

                            if (sizeKeyword) {
                                // Look for exact match first, then partial
                                // Existing sets are like "Oven - Serves 2"
                                // We prefer "Oven" sets as default
                                const bestSet = loadedSetsRef.current.find((s: { name: string, text: string }) => s.name.includes(sizeKeyword) && s.name.includes('Oven'));
                                console.log('Best Set Found:', bestSet);
                                if (bestSet && skuParam) {
                                    instructions = bestSet.text;
                                    console.log('Instructions set to:', instructions);
                                }
                            }
                        }

                        return {
                            ...prev,
                            name: data.name,
                            ingredients: ingreds,
                            allergens: data.allergens || '',
                            mealSize: detectedSize,
                            macros: data.macros || '',
                            instructions
                        };
                    });
                })
                .catch(e => console.error("Failed to fetch recipe", e));
        } else {
            // Fallback: Check for Draft Label (passed from Production Hub)
            const draftLabel = localStorage.getItem('draftLabel');
            if (draftLabel) {
                try {
                    const parsed = JSON.parse(draftLabel);
                    setLabelContent({
                        name: parsed.name || '',
                        ingredients: parsed.ingredients || '',
                        allergens: parsed.allergens || '',
                        expiry: parsed.expiry || defaultExpiry.toLocaleDateString(),
                        mealSize: parsed.mealSize || '',
                        instructions: parsed.instructions || '',
                        macros: parsed.macros || ''
                    });
                } catch (e) {
                    console.error("Failed to parse draft label");
                }
            }
        }

        // Poll for logo updates
        const interval = setInterval(() => {
            const current = localStorage.getItem('kitchenLogo');
            if (current !== logo) setLogo(current);
        }, 1000);

        // Load QR Codes
        const savedQrs = localStorage.getItem('qrCodes');
        if (savedQrs) {
            try {
                const parsed = JSON.parse(savedQrs);
                setQrCodes(parsed);
                if (parsed.length > 0) setSelectedQrId(parsed[0].id);
            } catch (e) {
                console.error("Failed to parse QR codes");
            }
        }

        // Load inventory
        fetchInventory();

        return () => clearInterval(interval);
    }, []); // Run once on mount to read URL params

    const handleSetSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const setName = e.target.value;
        setSelectedSet(setName);
        const set = instructionSets.find(s => s.name === setName);
        if (set) {
            setLabelContent(prev => ({ ...prev, instructions: set.text }));
        }
    };

    const saveSets = (newSets: { name: string, text: string }[]) => {
        setInstructionSets(newSets);
        localStorage.setItem('instructionSets', JSON.stringify(newSets));
    };

    const handleSave = () => {
        setIsSaving(true);
        localStorage.setItem('labelConfig', JSON.stringify(config));
        setTimeout(() => setIsSaving(false), 500);
    };

    const handleTestPrint = async () => {
        // Check inventory first
        if (labelInventory < printQty) {
            alert(`Insufficient labels! You have ${labelInventory} labels but need ${printQty}.\n\nPlease purchase more labels.`);
            setShowInventoryModal(true);
            return;
        }

        setIsTesting(true);
        try {
            const res = await fetch('/api/production/print-label', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job: {
                        recipeName: labelContent.name,
                        ingredients: config.showIngredients ? labelContent.ingredients : '',
                        expiryDate: config.showDates ? labelContent.expiry : '',
                        quantity: printQty, // User defined quantity
                        unit: labelContent.mealSize, // Overloading unit or adding metadata
                        user: 'Admin',
                        allergens: config.showAllergens ? labelContent.allergens : '',
                        notes: config.showNotes ? 'Test Label' : '',
                        isFinalLabel: true,
                        metadata: {
                            mealSize: labelContent.mealSize,
                            instructions: labelContent.instructions
                        }
                    }
                })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                // Deduct from inventory
                await deductInventory(printQty);

                if (from === 'production') {
                    if (confirm('Print Job Sent Successfully! Return to Production page?')) {
                        router.push('/production');
                    }
                } else {
                    alert('Print Job Sent Successfully!');
                }
            } else {
                alert('Print Failed: ' + (data.error || 'Check Settings'));
            }
        } catch (e) {
            alert('Network Error');
        } finally {
            setIsTesting(false);
        }
    };

    const deductInventory = async (qty: number) => {
        try {
            const res = await fetch('/api/labels/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'deduct', quantity: qty })
            });
            if (res.ok) {
                const data = await res.json();
                setLabelInventory(data.inventory);
            }
        } catch (e) {
            console.error('Failed to deduct inventory', e);
        }
    };

    const handlePurchaseLabels = async () => {
        try {
            const res = await fetch('/api/labels/inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'add', quantity: purchaseQty })
            });
            if (res.ok) {
                const data = await res.json();
                setLabelInventory(data.inventory);
                setShowInventoryModal(false);
                setPurchaseQty(100);
            }
        } catch (e) {
            alert('Failed to update inventory');
        }
    };

    const detectAllergens = () => {
        // Map ingredients to Allergen Categories
        const keywordMap: Record<string, string> = {
            "peanut": "Peanut",
            "soy": "Soy",
            "wheat": "Gluten",
            "gluten": "Gluten",
            "egg": "Egg",
            "fish": "Fish",
            "shellfish": "Shellfish",
            "crab": "Shellfish",
            "lobster": "Shellfish",
            "shrimp": "Shellfish",
            "tree nut": "Tree Nut",
            "almond": "Tree Nut",
            "walnut": "Tree Nut",
            "cashew": "Tree Nut",
            "pecan": "Tree Nut",
            "sesame": "Sesame",
            // Dairy Mapping
            "milk": "Dairy",
            "dairy": "Dairy",
            "butter": "Dairy",
            "cheese": "Dairy",
            "cream": "Dairy",
            "yogurt": "Dairy",
            "whey": "Dairy",
            "casein": "Dairy",
            "lactose": "Dairy"
        };

        const ingredientsLower = labelContent.ingredients.toLowerCase();
        const detectedSet = new Set<string>();

        Object.keys(keywordMap).forEach(key => {
            if (ingredientsLower.includes(key)) {
                detectedSet.add(keywordMap[key]);
            }
        });

        if (detectedSet.size > 0) {
            const unique = Array.from(detectedSet).sort().join(", ");
            setLabelContent(prev => ({ ...prev, allergens: unique }));
        } else {
            setLabelContent(prev => ({ ...prev, allergens: "" }));
            alert("No common allergens detected.");
        }
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-32">

            {/* Print Styles */}
            <style dangerouslySetInnerHTML={{
                __html: `
                    @media print {
                        /* Hide everything except the label */
                        body > *:not(.label-print-container) {
                            display: none !important;
                        }
                        
                        /* Show only the label container */
                        .label-print-container {
                            display: block !important;
                            position: absolute;
                            top: 0;
                            left: 0;
                            width: 2in;
                            height: 6in;
                            margin: 0;
                            padding: 0;
                        }
                        
                        /* Remove all backgrounds and borders for clean print */
                        .label-print-container * {
                            -webkit-print-color-adjust: exact !important;
                            print-color-adjust: exact !important;
                        }
                        
                        /* Page settings */
                        @page {
                            size: 2in 6in;
                            margin: 0;
                        }
                        
                        html, body {
                            width: 2in;
                            height: 6in;
                            margin: 0;
                            padding: 0;
                        }
                    }
                `
            }} />

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight">Label Designer</h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-2 text-lg">Configure printer settings and customize label layouts.</p>
                </div>
                <div className="flex gap-4">
                    {from === 'production' && (
                        <button
                            onClick={() => router.push('/production')}
                            className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-5 py-2.5 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        >
                            <ArrowLeft size={18} />
                            Back
                        </button>
                    )}
                    <button
                        onClick={handleTestPrint}
                        disabled={isTesting}
                        className="flex items-center gap-2 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-5 py-2.5 rounded-xl font-bold hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700"
                    >
                        <Printer size={18} />
                        {isTesting ? 'Printing...' : `Print & Finish`}
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-indigo-500/30"
                    >
                        <Save size={18} />
                        {isSaving ? 'Saved!' : 'Save Settings'}
                    </button>
                </div>
            </div>


            {/* Print Controls (Top Bar) */}
            <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-4 mb-4">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Copies:</label>
                        <input
                            type="number"
                            min="1"
                            value={printQty}
                            onChange={(e) => setPrintQty(Number(e.target.value))}
                            className="w-20 px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg font-bold text-center"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Print Mode:</label>
                        <div className="flex bg-slate-100 dark:bg-slate-900 rounded-lg p-1 border border-slate-200 dark:border-slate-600">
                            <button
                                onClick={() => setColorMode('color')}
                                className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${colorMode === 'color'
                                    ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                                    }`}
                            >
                                Color
                            </button>
                            <button
                                onClick={() => setColorMode('bw')}
                                className={`px-4 py-1.5 rounded-md text-sm font-bold transition-all ${colorMode === 'bw'
                                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
                                    }`}
                            >
                                B/W
                            </button>
                        </div>
                    </div>
                    <div className="text-sm text-slate-500">
                        Ready to print <strong>{printQty}</strong> label{printQty !== 1 ? 's' : ''}.
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                        <Package size={18} className={labelInventory <= 200 ? 'text-red-500' : 'text-slate-400'} />
                        <div>
                            <p className="text-xs text-slate-400 font-bold uppercase">Labels in Stock</p>
                            <p className={`text-lg font-black ${labelInventory <= 200 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-white'}`}>
                                {labelInventory}
                                {labelInventory <= 200 && <span className="text-xs ml-2 text-red-500">⚠ LOW</span>}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => setShowInventoryModal(true)}
                        className="p-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
                        title="Add Labels to Inventory"
                    >
                        <Plus size={18} />
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">

                {/* Left: Preview Canvas */}
                <div className="space-y-6">
                    <h3 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <Eye size={20} className="text-indigo-500" />
                        Live Preview
                    </h3>

                    {/* The Label Mockup: 2" Wide x 6" Tall (1:3 Ratio) */}
                    <div
                        className="label-print-container aspect-[1/3] w-full max-w-[240px] mx-auto bg-white rounded-md shadow-2xl border border-slate-300 p-4 flex flex-col relative overflow-hidden transform transition-all hover:scale-[1.01]"
                        style={{
                            filter: colorMode === 'bw' ? 'grayscale(100%)' : 'none',
                            transition: 'filter 0.3s ease'
                        }}
                    >

                        {/* Header */}
                        {/* Header */}
                        <div className="flex flex-col items-center border-b-2 border-slate-900 pb-3 mb-3 text-center">
                            {logo ? (
                                <div className="w-12 h-12 mb-2 rounded-xl overflow-hidden border border-slate-200">
                                    <img src={logo} alt="Logo" className="w-full h-full object-cover" />
                                </div>
                            ) : (
                                <div className="w-12 h-12 bg-slate-900 rounded-xl flex items-center justify-center text-white font-black text-[10px] mb-2">
                                    LOGO
                                </div>
                            )}
                            <h2 className="text-xl font-black text-slate-900 uppercase leading-tight text-center break-words w-full">{labelContent.name}</h2>
                            <p className="text-[10px] font-bold text-slate-500 mt-1 uppercase tracking-wider">{new Date().toLocaleDateString()}</p>
                        </div>

                        <div className="flex-1 space-y-6 overflow-hidden">
                            {/* Ingredients */}
                            {config.showIngredients && (
                                <div>
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Ingredients</p>
                                    <div
                                        className="text-[10px] font-bold text-slate-800 leading-tight"
                                        dangerouslySetInnerHTML={{ __html: labelContent.ingredients }}
                                    />
                                </div>
                            )}

                            {/* Allergens - Only show if content exists */}
                            {config.showAllergens && labelContent.allergens && (
                                <div className="bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-2">
                                    <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-[10px] font-black text-amber-800 uppercase tracking-wider mb-0.5">Allergens</p>
                                        <p className="text-[10px] font-bold text-amber-900 leading-tight">{labelContent.allergens}</p>
                                    </div>
                                </div>
                            )}

                            {/* Notes */}
                            {config.showNotes && (
                                <div className="bg-yellow-100 p-3 rounded-lg border-2 border-yellow-200 border-dashed text-yellow-900 font-bold text-sm text-center">
                                    Includes Custom Notes
                                </div>
                            )}

                            {/* Cooking Instructions - Now part of main flow, larger font */}
                            {labelContent.instructions && (
                                <div className="pt-2">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Preparation</p>
                                    <div
                                        className={`text-sm text-slate-900 leading-snug whitespace-pre-wrap`}
                                        dangerouslySetInnerHTML={{ __html: labelContent.instructions }}
                                    />
                                </div>
                            )}

                            {/* Macros - Compact Footer */}
                            {labelContent.macros && (
                                <div className="pt-2 border-t border-slate-200 mt-2">
                                    <div
                                        className="text-[8px] font-mono text-slate-500 leading-tight whitespace-pre-wrap"
                                        dangerouslySetInnerHTML={{ __html: labelContent.macros }}
                                    />
                                </div>
                            )}
                        </div>

                        {/* QR Code - Between Content and Footer */}
                        {config.showQRCode && (
                            <div className="flex justify-center mb-2">
                                {selectedQrId && qrCodes.find(q => q.id === selectedQrId) ? (
                                    <div className="w-12 h-12 relative">
                                        <img
                                            src={qrCodes.find(q => q.id === selectedQrId)?.data}
                                            alt="QR"
                                            className="w-full h-full object-contain"
                                        />
                                    </div>
                                ) : (
                                    <div className="w-12 h-12 bg-slate-900/10 rounded border border-slate-900/20 flex items-center justify-center text-[8px] font-mono text-slate-400">
                                        {qrCodes.length === 0 ? "NO QR" : "SELECT"}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Footer */}
                        {config.showDates && (
                            <div className="mt-auto border-t-2 border-slate-900 border-dashed pt-4 mb-8">
                                <div className="flex justify-between items-end mb-2">
                                    <p className="text-[10px] font-black text-slate-400 uppercase">Best By</p>
                                    <p className="text-sm font-black text-slate-900">{labelContent.expiry}</p>
                                </div>
                                <div className="flex justify-between items-end">
                                    <p className="text-[10px] font-black text-slate-400 uppercase">Size</p>
                                    <p className="text-sm font-black text-slate-900">{labelContent.mealSize}</p>
                                </div>
                            </div>
                        )}




                    </div>

                    <p className="text-center text-xs text-slate-400 font-medium">
                        * Previewing 2" x 6" Vertical Layout (Standard Container Strip)
                    </p>
                </div>

                {/* Right: Settings */}
                <div className="space-y-8">

                    {/* Visual Toggles */}
                    <div className="glass-panel p-8 rounded-3xl bg-white/50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700">
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                            <Settings size={20} className="text-indigo-500" />
                            Layout Options
                        </h3>

                        <div className="space-y-4">
                            {[
                                { k: 'showIngredients', l: 'Show Ingredients List' },
                                { k: 'showAllergens', l: 'Show Allergens Warning' },
                                { k: 'showDates', l: 'Show Best-By Date & Meal Size' },
                                { k: 'showNotes', l: 'Enable Custom Notes Field' },
                                { k: 'showQRCode', l: 'Show QR Code (Internal ID)' }
                            ].map((opt) => (

                                <div key={opt.k} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700 overflow-hidden">
                                    <label className="flex items-center justify-between p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                        <span className="font-bold text-slate-700 dark:text-slate-300">{opt.l}</span>
                                        <div className={`w-12 h-7 rounded-full p-1 transition-colors ${config[opt.k as keyof typeof config] ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-slate-700'}`}>
                                            <div className={`w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${config[opt.k as keyof typeof config] ? 'translate-x-5' : ''}`} />
                                        </div>
                                        <input
                                            type="checkbox"
                                            className="hidden"
                                            checked={!!config[opt.k as keyof typeof config]}
                                            onChange={(e) => setConfig({ ...config, [opt.k]: e.target.checked })}
                                        />
                                    </label>

                                    {/* QR Logic: Show Dropdown if enabled */}
                                    {opt.k === 'showQRCode' && config.showQRCode && (
                                        <div className="px-4 pb-4 pt-0 animate-in slide-in-from-top-2 duration-200">
                                            {qrCodes.length > 0 ? (
                                                <select
                                                    value={selectedQrId}
                                                    onChange={(e) => setSelectedQrId(e.target.value)}
                                                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium"
                                                >
                                                    {qrCodes.map(q => (
                                                        <option key={q.id} value={q.id}>{q.name}</option>
                                                    ))}
                                                </select>
                                            ) : (
                                                <div className="text-xs text-rose-500 font-bold bg-rose-50 dark:bg-rose-900/20 p-2 rounded-lg text-center">
                                                    No QR Codes found. Go to Settings to add one.
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Content Editor */}
                    <div className="glass-panel p-8 rounded-3xl bg-white/50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700">
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                            <Settings size={20} className="text-indigo-500" />
                            Edit Label Content
                        </h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Item Name</label>
                                <input type="text" value={labelContent.name} onChange={(e) => setLabelContent({ ...labelContent, name: e.target.value })} className="w-full px-3 py-2 bg-white dark:bg-slate-900 border rounded-lg" />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Best By</label>
                                    <input type="text" value={labelContent.expiry} onChange={(e) => setLabelContent({ ...labelContent, expiry: e.target.value })} className="w-full px-3 py-2 bg-white dark:bg-slate-900 border rounded-lg" />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Meal Size</label>
                                    <select
                                        value={labelContent.mealSize}
                                        onChange={(e) => setLabelContent({ ...labelContent, mealSize: e.target.value })}
                                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border rounded-lg appearance-none font-medium"
                                    >
                                        <option>Serves 2</option>
                                        <option>Family Size</option>
                                        <option>Single Serving</option>
                                    </select>
                                </div>
                            </div>

                            {/* Instruction Sets */}
                            <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
                                <div className="flex justify-between items-center mb-2">
                                    <label className="block text-xs font-bold text-slate-500 uppercase">Cooking Instructions</label>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => {
                                                setLabelContent({ ...labelContent, instructions: '' });
                                                setSelectedSet('');
                                            }}
                                            className="text-[10px] font-bold text-slate-400 hover:text-slate-600"
                                        >
                                            CLEAR
                                        </button>
                                        <button
                                            onClick={() => {
                                                const name = prompt("Name for new set?");
                                                if (name) {
                                                    const existing = instructionSets.find(s => s.name === name);
                                                    if (existing) {
                                                        if (confirm(`Set "${name}" already exists. Overwrite?`)) {
                                                            const newSets = instructionSets.map(s => s.name === name ? { ...s, text: labelContent.instructions } : s);
                                                            saveSets(newSets);
                                                            setSelectedSet(name);
                                                        }
                                                    } else {
                                                        saveSets([...instructionSets, { name, text: labelContent.instructions }]);
                                                        setSelectedSet(name);
                                                    }
                                                }
                                            }}
                                            className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700"
                                        >
                                            + Add New Instructions
                                        </button>
                                    </div>
                                </div>

                                {/* Formatting Toolbar - Handled by LabelRichText now */}
                                <div className="flex gap-2 mb-2">
                                    <select
                                        value={selectedSet}
                                        onChange={handleSetSelect}
                                        className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-lg text-sm"
                                    >
                                        <option value="">-- Auto-fill from Set --</option>
                                        {instructionSets.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                                    </select>
                                    {selectedSet && (
                                        <>
                                            <button
                                                onClick={() => {
                                                    // Update existing set
                                                    const newSets = instructionSets.map(s =>
                                                        s.name === selectedSet ? { ...s, text: labelContent.instructions } : s
                                                    );
                                                    saveSets(newSets);
                                                    alert(`Updated "${selectedSet}"`);
                                                }}
                                                className="p-2 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg border border-transparent hover:border-indigo-200 transition-colors font-bold text-xs"
                                                title="Save Changes to Set"
                                            >
                                                SAVE
                                            </button>
                                            <button
                                                onClick={() => {
                                                    if (confirm(`Delete instruction set "${selectedSet}"?`)) {
                                                        const newSets = instructionSets.filter(s => s.name !== selectedSet);
                                                        saveSets(newSets);
                                                        setSelectedSet('');
                                                        // if (editorRef.current) editorRef.current.innerHTML = '';
                                                    }
                                                }}
                                                className="p-2 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg border border-transparent hover:border-rose-200 transition-colors"
                                                title="Delete Set"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </>
                                    )}
                                </div>
                                <LabelRichText
                                    label="Preparation"
                                    value={labelContent.instructions}
                                    onChange={(val) => setLabelContent({ ...labelContent, instructions: val })}
                                    minHeight="80px"
                                />
                            </div>

                            <div className="pt-4 border-t border-slate-100 dark:border-slate-700">
                                <LabelRichText
                                    label="Nutritional Macros"
                                    value={labelContent.macros}
                                    onChange={(val) => setLabelContent({ ...labelContent, macros: val })}
                                    minHeight="60px"
                                />
                            </div>

                            <div>
                                <LabelRichText
                                    label="Ingredients"
                                    value={labelContent.ingredients}
                                    onChange={(val) => setLabelContent({ ...labelContent, ingredients: val })}
                                    minHeight="80px"
                                />
                            </div>
                            <div>
                                <div className="flex justify-between items-end mb-1">
                                    <label className="block text-xs font-bold text-slate-500 uppercase">Allergens</label>
                                    <button
                                        onClick={detectAllergens}
                                        className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded border border-indigo-200 transition-colors"
                                    >
                                        ✨ AUTO-DETECT
                                    </button>
                                </div>
                                <input type="text" value={labelContent.allergens} onChange={(e) => setLabelContent({ ...labelContent, allergens: e.target.value })} className="w-full px-3 py-2 bg-white dark:bg-slate-900 border rounded-lg" />
                            </div>
                        </div>
                    </div>

                    {/* Printer Configuration */}
                    <div className="glass-panel p-8 rounded-3xl bg-white/50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700">
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                            <Printer size={20} className="text-emerald-500" />
                            Printer Connection
                        </h3>

                        <div className="space-y-5">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-2 ml-1 tracking-wide">Printer Location ID</label>
                                <input
                                    type="text"
                                    value={config.locationId}
                                    onChange={(e) => setConfig({ ...config, locationId: e.target.value })}
                                    placeholder="e.g. loc_12345"
                                    className="w-full px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-xl outline-none font-medium text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-2 ml-1 tracking-wide">Printer Profile ID</label>
                                <input
                                    type="text"
                                    value={config.printerProfileId}
                                    onChange={(e) => setConfig({ ...config, printerProfileId: e.target.value })}
                                    placeholder="e.g. prof_67890"
                                    className="w-full px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-xl outline-none font-medium text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 transition-all font-mono text-sm"
                                />
                            </div>
                            <p className="text-xs text-slate-400 italic mt-2">
                                * API Key is managed securely on the server. If IDs are left blank, system defaults from environment variables will be used.
                            </p>
                        </div>
                    </div>

                </div>
            </div>

            {/* Purchase Labels Modal */}
            {showInventoryModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-md p-8 animate-in fade-in zoom-in duration-200">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="w-12 h-12 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                                <Package className="text-indigo-600 dark:text-indigo-400" size={24} />
                            </div>
                            <div>
                                <h3 className="text-2xl font-black text-slate-900 dark:text-white">Add Labels</h3>
                                <p className="text-sm text-slate-500">Update your label inventory</p>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                                <p className="text-xs text-slate-400 font-bold uppercase mb-1">Current Inventory</p>
                                <p className={`text-3xl font-black ${labelInventory <= 200 ? 'text-red-600 dark:text-red-400' : 'text-slate-900 dark:text-white'}`}>
                                    {labelInventory} labels
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Labels Purchased</label>
                                <input
                                    type="number"
                                    min="1"
                                    value={purchaseQty}
                                    onChange={(e) => setPurchaseQty(Number(e.target.value))}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-lg text-center"
                                    placeholder="100"
                                />
                            </div>

                            <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-xl p-4 border border-indigo-200 dark:border-indigo-800">
                                <p className="text-xs text-indigo-600 dark:text-indigo-400 font-bold uppercase mb-1">New Total</p>
                                <p className="text-2xl font-black text-indigo-700 dark:text-indigo-300">
                                    {labelInventory + purchaseQty} labels
                                </p>
                            </div>

                            <div className="pt-4 flex gap-3 justify-end">
                                <button
                                    onClick={() => {
                                        setShowInventoryModal(false);
                                        setPurchaseQty(100);
                                    }}
                                    className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handlePurchaseLabels}
                                    className="px-8 py-3 rounded-xl font-bold bg-indigo-600 text-white hover:scale-105 active:scale-95 transition-all shadow-lg shadow-indigo-200 dark:shadow-none"
                                >
                                    Add to Inventory
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div >
    );
}
