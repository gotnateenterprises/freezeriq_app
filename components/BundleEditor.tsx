
"use client";

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray } from 'react-hook-form';
import { Save, Plus, Trash, ArrowLeft, Package, Search, DollarSign, TrendingUp, Sparkles, Image as ImageIcon, Loader2, Download, Copy } from 'lucide-react';
import Link from 'next/link';

interface BundleEditorProps {
    initialData: any;
    allRecipes: { id: string; name: string; type: string }[];
    knownTiers: string[];
}

export default function BundleEditor({ initialData, allRecipes, knownTiers = [] }: BundleEditorProps) {
    const router = useRouter();
    const isNew = !initialData;
    const [searchTerm, setSearchTerm] = useState('');
    const [recipeCosts, setRecipeCosts] = useState<Record<string, number>>({});
    const [catalogs, setCatalogs] = useState<any[]>([]);
    const [isGeneratingImage, setIsGeneratingImage] = useState(false);

    const { register, control, handleSubmit, watch, setValue } = useForm({
        defaultValues: initialData ? {
            name: initialData.name,
            sku: initialData.sku,
            description: initialData.description,
            serving_tier: initialData.serving_tier || 'family',
            catalog_id: initialData.catalog_id || '',
            image_url: initialData.image_url || '',
            price: initialData.price || '',
            stock_on_hand: initialData.stock_on_hand || 0,
            is_active: initialData.is_active ?? true,
            show_on_storefront: initialData.show_on_storefront ?? false,
            is_donation: initialData.is_donation ?? false,
            order_cutoff_date: initialData.order_cutoff_date ? new Date(initialData.order_cutoff_date).toISOString().split('T')[0] : '',
            contents: initialData.contents.map((c: any) => ({
                recipe_id: c.recipe_id,
                name: c.recipe.name,
                quantity: c.quantity || 1.0
            }))
        } : {
            name: '',
            sku: '',
            description: '',
            serving_tier: 'family',
            catalog_id: '',
            image_url: '',
            price: '', // Default empty (will use calc if null)
            stock_on_hand: 0,
            is_active: true,
            show_on_storefront: false,
            is_donation: false,
            order_cutoff_date: '',
            contents: []
        }
    });

    const { fields, append, remove } = useFieldArray({
        control,
        name: 'contents'
    });

    // Fetch resources on mount
    useEffect(() => {
        async function fetchData() {
            try {
                // Costs
                const costRes = await fetch('/api/recipes/costs');
                if (costRes.ok) setRecipeCosts(await costRes.json());

                // Catalogs
                const catRes = await fetch('/api/catalogs');
                if (catRes.ok) setCatalogs(await catRes.json());
            } catch (e) {
                console.error('Failed to fetch data:', e);
            }
        }
        fetchData();
    }, []);

    const onSubmit = async (data: any) => {
        try {
            const url = isNew ? '/api/bundles' : `/api/bundles/${initialData.id}`;
            const method = isNew ? 'POST' : 'PUT';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (res.ok) {
                alert('Bundle Saved!');
                router.push('/bundles');
                router.refresh();
            } else {
                const err = await res.json();
                alert(`Error: ${err.error}`);
            }
        } catch (e) {
            console.error(e);
            alert('Failed to save bundle.');
        }
    };

    // Filter recipes for dropdown with Deduping by Name
    const filteredRecipes = useMemo(() => {
        const lowerSearch = searchTerm.toLowerCase();
        const seen = new Set();
        return allRecipes
            .filter(r => {
                const name = r.name.toLowerCase();
                if (!name.includes(lowerSearch)) return false;
                if (seen.has(name)) return false;
                seen.add(name);
                return true;
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [allRecipes, searchTerm]);

    const addRecipe = (recipeId: string, recipeName: string) => {
        append({ recipe_id: recipeId, name: recipeName, quantity: 1.0 });
        setSearchTerm(''); // Reset search
    };

    // Calculate financial metrics
    const financials = useMemo(() => {
        const contents = watch('contents') || [];
        const servingTier = watch('serving_tier') || 'family';
        const manualPrice = Number(watch('price')) || 0;

        // Calculate total cost (Family/Serves 5 base)
        const totalCost = contents.reduce((sum: number, item: any) => {
            const recipeCost = recipeCosts[item.recipe_id] || 0;
            const quantity = Number(item.quantity) || 1;
            return sum + (recipeCost * quantity);
        }, 0);

        // Determine selling price
        let sellingPrice = manualPrice;
        if (!sellingPrice) {
            const tierLower = servingTier.toLowerCase();
            if (tierLower.includes('family') || tierLower === 'family') {
                sellingPrice = 125.00;
            } else if (tierLower.includes('couple') || tierLower.includes('serves 2') || tierLower === 'couple') {
                sellingPrice = 60.00;
            }
        }

        // Adjust cost logic removed: Trust the actual sum of ingredients/recipes.
        const adjustedCost = totalCost;

        const profitMargin = sellingPrice - adjustedCost;
        const profitPercent = sellingPrice > 0 ? (profitMargin / sellingPrice) * 100 : 0;
        const foodCostPercent = sellingPrice > 0 ? (adjustedCost / sellingPrice) * 100 : 0;

        return {
            totalCost,
            adjustedCost,
            sellingPrice,
            profitMargin,
            profitPercent,
            foodCostPercent
        };
    }, [watch('contents'), watch('serving_tier'), watch('price'), recipeCosts]);


    const handleDuplicateAsServes2 = async () => {
        if (!confirm("Create a 'Serves 2' version of this bundle?\n\nThis will:\n1. Clone this bundle\n2. Rename it to '(Serves 2)'\n3. Switch all recipes to their '(Serves 2)' versions (if found)\n4. Set tier to 'serves_2'")) return;

        const current = watch();

        // Map Contents
        const newContents = current.contents.map((c: any) => {
            const target = `${c.name} (Serves 2)`;
            // Case-insensitive lookup
            const match = allRecipes.find(r => r.name.toLowerCase() === target.toLowerCase());

            if (match) {
                return {
                    recipe_id: match.id,
                    quantity: c.quantity
                };
            }
            return { recipe_id: c.recipe_id, quantity: c.quantity };
        });

        const payload = {
            ...current,
            name: `${current.name} (Serves 2)`,
            sku: `${current.sku}-S2`,
            serving_tier: 'serves_2',
            contents: newContents,
            price: Number(current.price) || null, // Keep price or clear? Keeping for reference.
            is_active: true
        };

        try {
            const res = await fetch('/api/bundles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const json = await res.json();
                alert("Bundle Cloned Successfully!");
                router.push(`/bundles/${json.id}`);
                router.refresh();
            } else {
                const err = await res.json();
                alert(`Failed to clone: ${err.error}`);
            }
        } catch (e) {
            console.error(e);
            alert("Error cloning bundle.");
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Link href="/bundles" className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-500 dark:text-slate-400 transition-colors">
                        <ArrowLeft size={24} />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900 dark:text-white text-adaptive">{isNew ? 'New Bundle' : 'Edit Bundle'}</h1>
                        <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle">Define the contents of your meal kit.</p>
                    </div>
                </div>
                {!isNew && (
                    <button
                        onClick={handleDuplicateAsServes2}
                        className="flex items-center gap-2 px-4 py-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 rounded-lg font-bold transition-colors border border-indigo-100 dark:border-indigo-800"
                    >
                        <Copy size={18} />
                        Make Serves 2
                    </button>
                )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Bundle Info */}
                <div className="lg:col-span-1 space-y-6">
                    <div className="bg-white dark:bg-slate-800 bg-adaptive p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                        <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-lg flex items-center justify-center mb-4">
                            <Package size={24} />
                        </div>

                        {/* Image Generation */}
                        <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Bundle Image</label>
                            <div className="relative group">
                                {watch('image_url') ? (
                                    <div className="relative w-full aspect-square rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 mb-2 group">
                                        <img src={watch('image_url')} alt="Bundle" className="w-full h-full object-cover" />
                                        <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <a
                                                href={watch('image_url')}
                                                download={`bundle-${(watch('name') || 'image').replace(/\s+/g, '-').toLowerCase()}.png`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="p-1.5 bg-white text-slate-600 hover:text-indigo-600 rounded-full shadow-md transition-colors"
                                                title="Download Image"
                                            >
                                                <Download size={16} />
                                            </a>
                                            <button
                                                type="button"
                                                onClick={() => setValue('image_url', '')}
                                                className="p-1.5 bg-white text-rose-600 hover:text-rose-700 rounded-full shadow-md transition-colors"
                                                title="Remove Image"
                                            >
                                                <Trash size={16} />
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="w-full aspect-video bg-slate-50 dark:bg-slate-900 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg flex flex-col items-center justify-center text-slate-400 mb-3 p-4">
                                        <ImageIcon size={32} className="mb-2 opacity-50" />
                                        <span className="text-xs">No image selected</span>
                                    </div>
                                )}

                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        placeholder="Image URL..."
                                        {...register('image_url')}
                                        className="flex-1 px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-xs outline-none focus:ring-2 focus:ring-indigo-500"
                                    />
                                    <button
                                        type="button"
                                        disabled={isGeneratingImage}
                                        onClick={async () => {
                                            const name = watch('name');
                                            const desc = watch('description');
                                            const tier = watch('serving_tier');
                                            if (!name) {
                                                alert("Please enter a bundle name first.");
                                                return;
                                            }

                                            // Check providers first
                                            try {
                                                const keysRes = await fetch('/api/integrations/keys');
                                                const keys = await keysRes.json();
                                                // Prefer OpenAI
                                                let provider = keys.openai ? 'openai' : keys.gemini ? 'gemini' : null;

                                                if (!provider) {
                                                    alert("Please configure AI keys in Settings first.");
                                                    return;
                                                }

                                                setIsGeneratingImage(true);
                                                const prompt = `${name} meal kit, ${tier} size. ${desc}`;

                                                const res = await fetch('/api/ai/generate-image', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({
                                                        prompt,
                                                        provider,
                                                        bundleName: name
                                                    })
                                                });

                                                const data = await res.json();
                                                if (res.ok && data.url) {
                                                    setValue('image_url', data.url, { shouldDirty: true });
                                                } else {
                                                    alert("Generation failed: " + (data.error || 'Unknown error'));
                                                }
                                            } catch (e) {
                                                console.error(e);
                                                alert("Network error generating image.");
                                            } finally {
                                                setIsGeneratingImage(false);
                                            }
                                        }}
                                        className="px-3 py-2 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 dark:text-indigo-300 rounded-lg text-xs font-bold transition-colors flex items-center gap-1 whitespace-nowrap"
                                    >
                                        {isGeneratingImage ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                                        Generate AI
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Bundle Name</label>
                            <input
                                {...register('name', { required: true })}
                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white placeholder:text-slate-400"
                                placeholder="e.g. Family Pizza Night"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Catalog (Season)</label>
                            <select
                                {...register('catalog_id')}
                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                            >
                                <option value="">-- No Catalog --</option>
                                {catalogs.map((c: any) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Serving Size Tier</label>

                            {/* Custom Tier Input Mode */}
                            {watch('serving_tier') === 'custom_entry' ? (
                                <div className="flex gap-2">
                                    <input
                                        autoFocus
                                        className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                                        placeholder="e.g. Family Size Keto"
                                        onBlur={(e) => {
                                            if (e.target.value.trim()) {
                                                const val = e.target.value.trim();
                                                setValue('serving_tier', val);
                                                // Auto-Price
                                                const vLower = val.toLowerCase();
                                                if (vLower.includes('family')) setValue('price', '125.00', { shouldValidate: true, shouldDirty: true });
                                                else if (vLower.includes('couple') || vLower.includes('serves 2')) setValue('price', '60.00', { shouldValidate: true, shouldDirty: true });
                                            } else {
                                                setValue('serving_tier', 'family'); // Revert
                                            }
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                e.currentTarget.blur();
                                            }
                                        }}
                                    />
                                    <button
                                        onClick={() => setValue('serving_tier', 'family')}
                                        className="px-3 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg"
                                        title="Cancel"
                                    >
                                        X
                                    </button>
                                </div>
                            ) : (
                                <select
                                    value={
                                        // 1. Is it a default tier?
                                        ['family', 'couple', 'single'].includes(watch('serving_tier'))
                                            // 2. Is it a KNOWN custom tier?
                                            || knownTiers.includes(watch('serving_tier'))
                                            ? watch('serving_tier')
                                            // 3. Otherwise treat as new/temp custom value
                                            : 'custom_value'
                                    }
                                    onChange={(e) => {
                                        if (e.target.value === 'new_tier') {
                                            setValue('serving_tier', 'custom_entry');
                                        } else if (e.target.value === 'custom_value') {
                                            // Do nothing (editing existing custom)
                                        } else {
                                            const val = e.target.value;
                                            setValue('serving_tier', val);
                                            // Auto-Price
                                            const vLower = val.toLowerCase();
                                            if (vLower.includes('family')) setValue('price', '125.00', { shouldValidate: true, shouldDirty: true });
                                            else if (vLower.includes('couple') || vLower.includes('serves 2')) setValue('price', '60.00', { shouldValidate: true, shouldDirty: true });
                                        }
                                    }}
                                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                                >
                                    <option value="family">Family Size (Serves 5)</option>
                                    <option value="couple">Couple (Serves 2)</option>
                                    <option value="single">Single Serve</option>

                                    {/* Persisted Custom Tiers */}
                                    {knownTiers
                                        .filter(t => !['family', 'couple', 'single'].includes(t)) // Don't duplicate defaults
                                        .map(t => (
                                            <option key={t} value={t}>{t}</option>
                                        ))
                                    }

                                    {!['family', 'couple', 'single'].includes(watch('serving_tier'))
                                        && watch('serving_tier') !== 'custom_entry'
                                        && !knownTiers.includes(watch('serving_tier')) && (
                                            <option value="custom_value">{watch('serving_tier')} (New)</option>
                                        )}
                                    <option value="new_tier" className="font-bold text-indigo-600">+ New Tier...</option>
                                </select>
                            )}

                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                                Determines ingredient scaling base.<br />
                                • Family = Recipe * 1<br />
                                • Couple = Recipe / 2<br />
                                • Single = Recipe / 5
                            </p>
                        </div>


                        <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">SKU Generator</label>

                            {/* Generator Controls */}
                            <div className="flex gap-2 mb-2 p-3 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-100 dark:border-slate-800">
                                <select
                                    className="flex-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md outline-none focus:ring-1 focus:ring-indigo-500"
                                    onChange={(e) => {
                                        // Logic: Generate immediately on change or just set a prefix state?
                                        // User asked for "Auto Generate SKU" button, but logic depends on this.
                                        // Let's generate purely on button click reading this value, ensuring ref is persistent? 
                                        // Easier: Just store in a state or ref.
                                        // Or better, generate immediately if they select? 
                                        // "depending on which one is selected, start the Auto generated SKU... make the number a 4 digit number... then suffix"
                                        // Let's us a simple function triggered by a button.
                                        const platform = e.target.value;
                                        const tier = watch('serving_tier');

                                        // Generate logic
                                        const prefix = platform === 'square' ? 'SQ' : platform === 'qb' ? 'QB' : 'OT';

                                        // Suffix Logic
                                        let suffix = 'FS';
                                        const t = tier.toLowerCase();

                                        if (t === 'family') suffix = 'FS';
                                        else if (t === 'couple') suffix = 'S2';
                                        else if (t === 'single') suffix = 'SS';
                                        else {
                                            // Custom Logic:
                                            // "Family Size Keto" -> "FS" + "K" -> "FSK"
                                            // "Serves 2 Keto" -> "S2" + "K" -> "S2K"

                                            let base = '';
                                            let extra = '';

                                            // Check Base
                                            if (t.includes('family')) {
                                                base = 'FS';
                                                extra = tier.replace(/family/i, '').replace(/size/i, '').trim();
                                            } else if (t.includes('couple') || t.includes('serves 2')) {
                                                base = 'S2';
                                                extra = tier.replace(/couple/i, '').replace(/serves 2/i, '').trim();
                                            } else if (t.includes('single')) {
                                                base = 'SS';
                                                extra = tier.replace(/single/i, '').replace(/serve/i, '').trim();
                                            } else {
                                                // Fallback if no recognizable base
                                                base = tier.split(' ')[0].substring(0, 2).toUpperCase();
                                                extra = tier.substring(base.length);
                                            }

                                            // Extract initials from extra words
                                            // e.g. "Keto" -> "K"
                                            // "Clean Eating" -> "CE"
                                            const extrasInitials = extra.split(' ')
                                                .filter(w => w.trim().length > 0)
                                                .map(w => w[0].toUpperCase())
                                                .join('');

                                            suffix = base + extrasInitials;
                                        }

                                        // For number, we need a random or sequential logic. Client-side sequential is hard without DB check.
                                        // Let's simulate "0004" as requested baseline + random or length-based offset?
                                        // Or just random 4 digit. "make the number a 4 digit number starting with 0004"
                                        // Ambiguous. I will use a random 4 digit for now to ensure uniqueness, or a fixed if implied.
                                        // "starting with 0004" might mean > 0004?
                                        // Let's use Math.floor(Math.random() * 9000) + 1000 for safety?
                                        // Or just 0004 for the demo if that's what they literally want.
                                        // "make the number a 4 digit number starting with 0004" -> Likely means start counting from there.
                                        // I'll pick a random number between 0004 and 9999.
                                        const num = Math.floor(Math.random() * 9000) + 1000;
                                        const sku = `${prefix}${num}${suffix}`;
                                        setValue('sku', sku);
                                    }}
                                >
                                    <option value="">Select Platform...</option>
                                    <option value="square">Square</option>
                                    <option value="qb">QuickBooks</option>
                                    <option value="other">Other</option>
                                </select>

                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        const tier = watch('serving_tier');
                                        // Default to Square if nothing selected? Or Other?
                                        // Let's default to Other if dropdown not touched, or force user interaction?
                                        // The dropdown onChange handles it above.
                                        // Let's replicate logic here for a manual "Generate" button too.
                                        // Actually the dropdown onChange handles it.
                                        // Let's make this button explicitly generate.
                                        const platformSelect = (e.target as HTMLElement).previousElementSibling as HTMLSelectElement;
                                        const platform = platformSelect.value || 'other';

                                        const prefix = platform === 'square' ? 'SQ' : platform === 'qb' ? 'QB' : 'OT';
                                        const suffix = tier === 'family' ? 'FS' : tier === 'couple' ? 'S2' : 'SS';
                                        const num = Math.floor(Math.random() * 9000) + 1000; // 4 digit
                                        const sku = `${prefix}${num}${suffix}`;
                                        setValue('sku', sku);
                                    }}
                                    className="px-3 py-1.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 text-xs font-bold rounded-md transition-colors whitespace-nowrap"
                                >
                                    Auto Generate
                                </button>
                            </div>

                            <div className="relative">
                                <input
                                    {...register('sku', { required: true })}
                                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm text-slate-900 dark:text-white placeholder:text-slate-400 pr-10"
                                    placeholder="e.g. SQ0004FS"
                                />
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        const val = watch('sku');
                                        if (val) {
                                            navigator.clipboard.writeText(val);
                                            // Optional: Toast or feedback?
                                            const btn = e.currentTarget;
                                            const originalColor = btn.style.color;
                                            btn.style.color = '#10b981'; // Emerald
                                            setTimeout(() => btn.style.color = originalColor, 1000);
                                        }
                                    }}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                                    title="Copy to Clipboard"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Selling Price ($)</label>
                                <input
                                    {...register('price')}
                                    type="number"
                                    step="0.01"
                                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm text-slate-900 dark:text-white placeholder:text-slate-400"
                                    placeholder="25.00"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Stock Quantity</label>
                                <input
                                    {...register('stock_on_hand')}
                                    type="number"
                                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm text-slate-900 dark:text-white placeholder:text-slate-400"
                                    placeholder="0"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Description</label>
                            <textarea
                                {...register('description')}
                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 h-24 resize-none text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500"
                                placeholder="Internal notes..."
                            />
                        </div>

                        <div className="space-y-4 bg-slate-50 dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
                            <div className="flex items-center gap-3">
                                <input
                                    {...register('is_active')}
                                    type="checkbox"
                                    id="is_active"
                                    className="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                                />
                                <label htmlFor="is_active" className="text-sm font-bold text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                                    Active Status
                                </label>
                                <span className="ml-auto text-xs text-slate-400 font-medium">
                                    {watch('is_active') ? 'Enabled/Unlocked' : 'Archived/Hidden'}
                                </span>
                            </div>

                            <hr className="border-slate-200 dark:border-slate-800" />

                            <div className="flex items-center gap-3">
                                <input
                                    {...register('is_donation')}
                                    type="checkbox"
                                    id="is_donation"
                                    className="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                                />
                                <label htmlFor="is_donation" className="text-sm font-bold text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                                    Is Donation (Digital Only)
                                </label>
                                <span className="ml-auto text-xs text-slate-400 font-medium">
                                    {watch('is_donation') ? 'No physical delivery' : 'Standard Bundle'}
                                </span>
                            </div>

                            <hr className="border-slate-200 dark:border-slate-800" />

                            <div className="flex items-center gap-3">
                                <input
                                    {...register('show_on_storefront')}
                                    type="checkbox"
                                    id="show_on_storefront"
                                    className="w-5 h-5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                                />
                                <label htmlFor="show_on_storefront" className="text-sm font-bold text-slate-700 dark:text-slate-200 cursor-pointer select-none">
                                    Show on Customer Storefront
                                </label>
                                <span className="ml-auto text-xs text-slate-400 font-medium">
                                    {watch('show_on_storefront') ? 'Visible to public' : 'Internal CRM only'}
                                </span>
                            </div>

                            {watch('show_on_storefront') && (
                                <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 animate-in fade-in slide-in-from-top-2">
                                    <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Storefront Order Cutoff Date</label>
                                    <input
                                        {...register('order_cutoff_date')}
                                        type="date"
                                        className="w-full px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-medium text-slate-900 dark:text-white"
                                    />
                                    <p className="text-xs text-slate-500 mt-1.5">If set, a global countdown banner will appear on the storefront driving urgency to order before midnight on this date.</p>
                                </div>
                            )}
                        </div>

                        <button
                            onClick={handleSubmit(onSubmit)}
                            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-lg font-bold transition-colors shadow-md mt-4"
                        >
                            <Save size={18} />
                            Save Bundle
                        </button>

                        {!isNew && (
                            <button
                                onClick={async () => {
                                    if (!confirm('Are you sure you want to delete this bundle? This cannot be undone.')) return;
                                    try {
                                        const res = await fetch(`/api/bundles/${initialData.id}`, { method: 'DELETE' });
                                        if (res.ok) {
                                            router.push('/bundles');
                                            router.refresh();
                                        } else {
                                            const err = await res.json();
                                            alert(`Error: ${err.error}`);
                                        }
                                    } catch (e) {
                                        console.error(e);
                                        alert('Failed to delete bundle.');
                                    }
                                }}
                                className="w-full flex items-center justify-center gap-2 bg-white dark:bg-slate-800 border border-rose-200 dark:border-rose-900/50 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 py-2.5 rounded-lg font-bold transition-colors mt-3"
                            >
                                <Trash size={18} />
                                Delete Bundle
                            </button>
                        )}
                    </div>
                </div>

                {/* Right Column: Contents */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="bg-white dark:bg-slate-800 bg-adaptive p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm min-h-[500px]">
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white text-adaptive mb-4">Bundle Contents</h3>

                        {/* Search / Add */}
                        <div className="relative mb-6">
                            <div className="flex items-center gap-2 px-4 py-3 bg-slate-50 dark:bg-slate-900 bg-adaptive border border-slate-200 dark:border-slate-700 rounded-lg focus-within:ring-2 focus-within:ring-indigo-500 ring-offset-2 transition-all">
                                <Search size={18} className="text-slate-400 dark:text-slate-500" />
                                <input
                                    className="bg-transparent outline-none w-full text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500"
                                    placeholder="Search recipes to add..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                            </div>

                            {/* Dropdown Results */}
                            {searchTerm && (
                                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl z-50 max-h-60 overflow-y-auto">
                                    {filteredRecipes.length > 0 ? (
                                        filteredRecipes.map(r => (
                                            <button
                                                key={r.id}
                                                onClick={() => addRecipe(r.id, r.name)}
                                                className="w-full text-left px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700 border-b border-slate-50 dark:border-slate-700 last:border-0 flex justify-between items-center group"
                                            >
                                                <span className="font-medium text-slate-700 dark:text-slate-200">{r.name}</span>
                                                <span className="text-xs text-slate-400 uppercase bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded">{r.type.replace('_', ' ')}</span>
                                            </button>
                                        ))
                                    ) : (
                                        <div className="p-4 text-center text-slate-400 text-sm">No recipes found.</div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* List */}
                        <div className="space-y-3">
                            {fields.length === 0 && (
                                <div className="text-center py-12 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                                    <div className="text-slate-400 mb-2">No items in this bundle</div>
                                    <div className="text-sm text-slate-400">Search recipes above to add them.</div>
                                </div>
                            )}

                            {fields.map((field: any, index) => {
                                const recipeCost = recipeCosts[field.recipe_id] || 0;
                                const quantity = Number(watch(`contents.${index}.quantity`)) || 1;
                                const lineCost = recipeCost * quantity;

                                return (
                                    <div key={field.id} className="flex items-center justify-between p-4 bg-white dark:bg-slate-800 bg-adaptive border border-slate-200 dark:border-slate-700 rounded-lg hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors group">
                                        <div className="flex items-center gap-3 flex-1">
                                            <div className="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 flex items-center justify-center text-xs font-bold">
                                                {index + 1}
                                            </div>
                                            <span className="font-medium text-slate-900 dark:text-white text-adaptive w-48 truncate" title={field.name}>{field.name}</span>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <input type="hidden" {...register(`contents.${index}.recipe_id` as const)} />
                                            <input type="hidden" {...register(`contents.${index}.name` as const)} />
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Cost</label>
                                                <div className="text-sm font-mono text-slate-600 dark:text-slate-400 text-center">
                                                    ${lineCost.toFixed(2)}
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Qty</label>
                                                <input
                                                    {...register(`contents.${index}.quantity` as const)}
                                                    type="number"
                                                    step="0.01"
                                                    className="w-20 px-2 py-1 border border-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-white rounded text-sm text-center font-mono"
                                                />
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => remove(index)}
                                            className="text-slate-300 hover:text-rose-500 transition-colors ml-2"
                                        >
                                            <Trash size={18} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Financial Summary */}
                        {fields.length > 0 && (
                            <div className="mt-6 p-4 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/30 dark:to-purple-950/30 rounded-xl border border-indigo-200 dark:border-indigo-800">
                                <div className="flex items-center gap-2 mb-3">
                                    <DollarSign size={18} className="text-indigo-600 dark:text-indigo-400" />
                                    <h4 className="font-bold text-slate-900 dark:text-white">Financial Summary</h4>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                        <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Total Cost</div>
                                        <div className="text-lg font-bold text-slate-900 dark:text-white">${financials.adjustedCost.toFixed(2)}</div>
                                        {financials.adjustedCost !== financials.totalCost && (
                                            <div className="text-xs text-slate-400 mt-1">Base: ${financials.totalCost.toFixed(2)}</div>
                                        )}
                                    </div>
                                    <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                        <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Selling Price</div>
                                        <div className="text-lg font-bold text-slate-900 dark:text-white">${financials.sellingPrice.toFixed(2)}</div>
                                    </div>
                                    <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                        <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Profit Margin</div>
                                        <div className={`text-lg font-bold ${financials.profitMargin >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                            ${financials.profitMargin.toFixed(2)}
                                        </div>
                                    </div>
                                    <div className="bg-white dark:bg-slate-800 p-3 rounded-lg ring-2 ring-indigo-500/10">
                                        <div className="text-xs text-indigo-600 dark:text-indigo-400 uppercase font-black mb-1">Food Cost %</div>
                                        <div className={`text-lg font-black ${financials.foodCostPercent > 49 ? 'text-rose-600' :
                                            financials.foodCostPercent >= 35 ? 'text-orange-500' :
                                                'text-emerald-600'
                                            }`}>
                                            {financials.foodCostPercent.toFixed(1)}%
                                        </div>
                                    </div>
                                    <div className="bg-white dark:bg-slate-800 p-3 rounded-lg">
                                        <div className="text-xs text-slate-500 dark:text-slate-400 uppercase font-semibold mb-1">Profit %</div>
                                        <div className={`text-lg font-black ${financials.profitPercent > 49 ? 'text-emerald-600' :
                                            financials.profitPercent >= 35 ? 'text-orange-500' :
                                                'text-rose-600'
                                            }`}>
                                            {financials.profitPercent.toFixed(1)}%
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
