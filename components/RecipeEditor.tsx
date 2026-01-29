"use client";


import { useState, useEffect } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Plus, Trash, Save, ArrowLeft, Printer, Wand2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { Recipe } from '@/types';
import { convertUnit, optimizeUnit } from '@/lib/unit_converter';
import { formatQuantity } from '@/lib/format_quantity';

import { Category } from '@/types';

interface RecipeEditorProps {
    initialData?: Recipe | null; // Keep the original optional type if needed, or unify
    // Removing strict 'any' override to trust the type, or merge if complex.
    // Let's just use 'any' for now to match the "serialized" nature if types are messy:
    // initialData: any; 
    costData?: {
        totalCost: number;
        costPerUnit: number;
        yieldUnit: string;
        isAccurate: boolean;
    };
}


// Basic Conversion Table to Base Units (Weight: g, Volume: fl oz)
// This is MVP level. Real culinary systems need density vectors.
// Basic Unit Options (Derived from lib if possible, but hardcoded here for MVP dropdowns)
const UNIT_OPTIONS = ['bunch', 'can', 'case', 'cup', 'each', 'fl oz', 'g', 'kg', 'L', 'lb', 'ml', 'oz', 'pack', 'serving', 'servings', 'tbsp', 'tsp'];

export default function RecipeEditor({ initialData, costData }: RecipeEditorProps) {
    const [isScaling, setIsScaling] = useState(false);
    const [targetYield, setTargetYield] = useState<number | string>('');
    const [targetUnit, setTargetUnit] = useState<string>(''); // For scaling mode
    const [units, setUnits] = useState<string[]>(UNIT_OPTIONS);
    const [allIngredients, setAllIngredients] = useState<any[]>([]);
    const [allRecipes, setAllRecipes] = useState<any[]>([]);

    // Helper to ensure custom units are in the dropdown
    const addMissingUnits = (incomingUnits: (string | undefined | null)[]) => {
        const unique = Array.from(new Set(incomingUnits.filter(Boolean))) as string[];
        setUnits(prev => {
            const combined = Array.from(new Set([...prev, ...unique])).sort();
            return JSON.stringify(prev) === JSON.stringify(combined) ? prev : combined;
        });
    };

    const handleAddNewUnit = (currentValue: string, setter?: (val: string) => void) => {
        if (currentValue === 'ADD_NEW') {
            const newUnit = prompt('Enter name for new unit (e.g. Gallon, Tray, Box):');
            if (newUnit && newUnit.trim()) {
                const trimmed = newUnit.trim();
                if (!units.includes(trimmed)) {
                    setUnits(prev => [...prev, trimmed].sort());
                }
                if (setter) setter(trimmed);
                return trimmed;
            }
            if (setter) setter(''); // Reset if cancelled
            return '';
        }
        return currentValue;
    };

    const handleSyncIngredient = (index: number, name: string) => {
        const match = allIngredients.find(ing => ing.name.toLowerCase() === name.toLowerCase());
        if (match) {
            setValue(`items.${index}.unit`, match.unit);
            // If the schema/form needs more fields like cost/sku in the future, add them here
            // For now, these are the core ones needed for calculation
        }
    };

    const router = useRouter();



    // Category State
    const [categories, setCategories] = useState<Category[]>([]);
    const [selectedRoot, setSelectedRoot] = useState<string>('');
    const [selectedSub, setSelectedSub] = useState<string>('');
    const [selectedDeepSub, setSelectedDeepSub] = useState<string>('');

    // Selected Category Tags (Multi-Select)
    const [selectedCategoryTags, setSelectedCategoryTags] = useState<Category[]>([]);

    // Fetch Categories & Ingredients
    useEffect(() => {
        fetch('/api/categories')
            .then(res => res.json())
            .then(data => setCategories(data));

        fetch('/api/commercial/ingredients')
            .then(res => res.json())
            .then(data => setAllIngredients(data));

        fetch('/api/recipes')
            .then(res => res.json())
            .then(data => setAllRecipes(data.recipes || []));

        // Hydrate units from initial data
        if (initialData) {
            const initialUnits = [
                initialData.base_yield_unit,
                ...initialData.items.map(i => i.unit)
            ];
            addMissingUnits(initialUnits);
        }
    }, [initialData]);

    // Populate Initial Category Selection
    // Populate Initial Category Selection
    // Hydrate categories once loaded
    useEffect(() => {
        if (initialData?.categories && initialData.categories.length > 0) {
            setSelectedCategoryTags(initialData.categories);
        } else if (initialData?.category_id && categories.length > 0) {
            // Legacy fall back: try to find the one category and add it
            // (BFS to find category by id)
            const findCat = (nodes: Category[]): Category | undefined => {
                for (const node of nodes) {
                    if (node.id === initialData.category_id) return node;
                    if (node.children) {
                        const found = findCat(node.children);
                        if (found) return found;
                    }
                }
                return undefined;
            };
            const found = findCat(categories);
            if (found) setSelectedCategoryTags([found]);
        }
    }, [initialData, categories]);

    // Determine currently "Browsed" category
    const browsedCategoryId = selectedDeepSub || selectedSub || selectedRoot;

    const handleAddCategoryTag = () => {
        if (!browsedCategoryId) return;

        // Find the category object
        // Helper to find deep
        const findCat = (nodes: Category[], id: string): Category | undefined => {
            for (const node of nodes) {
                if (node.id === id) return node;
                if (node.children) {
                    const found = findCat(node.children, id);
                    if (found) return found;
                }
            }
            return undefined;
        };

        const cat = findCat(categories, browsedCategoryId);
        if (cat) {
            if (!selectedCategoryTags.some(c => c.id === cat.id)) {
                setSelectedCategoryTags([...selectedCategoryTags, cat]);
            }
        }
    };

    const handleRemoveCategoryTag = (id: string) => {
        setSelectedCategoryTags(selectedCategoryTags.filter(c => c.id !== id));
    };

    // Determine Final Category ID to submit
    // const finalCategoryId = selectedDeepSub || selectedSub || selectedRoot;

    // Watch form values for real-time scaling base
    const formValues = useForm<any>({
        defaultValues: initialData ? {
            name: initialData.name ?? '',
            allergens: initialData.allergens || '',
            type: initialData.type,
            yield_qty: Number(initialData.base_yield_qty) || 1,
            yield_unit: initialData.base_yield_unit ?? 'servings',
            items: initialData.items.map((i: any) => ({
                name: (i.child_recipe?.name || i.child_ingredient?.name || i.name) ?? '',
                qty: Number(i.quantity) || 0,
                unit: i.unit ?? '',
                is_sub_recipe: i.is_sub_recipe || false,
                section_name: i.section_name || '',
                section_batch: Number(i.section_batch) || 1
            })),
            instructions: initialData.instructions || '',
            macros: (initialData as any).macros || ''
        } : {
            name: '',
            type: 'menu_item',
            yield_qty: 1,
            yield_unit: 'servings',
            items: [{ name: '', qty: 0, unit: '', is_sub_recipe: false, section_name: '', section_batch: 1 }],
            instructions: '',
            macros: ''
        }
    });

    // We need to destructure these from the result of useForm
    const { register, control, handleSubmit, watch, setValue, reset } = formValues;

    const draftKey = `recipe_draft_${initialData?.id || 'new'}`;

    // 1. Load Draft on Mount
    useEffect(() => {
        const saved = localStorage.getItem(draftKey);
        if (saved) {
            try {
                const draft = JSON.parse(saved);
                // Ensure we don't overwrite if the draft is ancient or invalid? 
                // For now, simpler is better: if it exists, use it.
                reset(draft);
                if (draft.selectedCategoryTags) {
                    setSelectedCategoryTags(draft.selectedCategoryTags);
                }

                // Also hydrate units from draft
                const draftUnits = [
                    draft.yield_unit,
                    ...(draft.items || []).map((i: any) => i.unit)
                ];
                addMissingUnits(draftUnits);
            } catch (e) {
                console.error("Error loading draft:", e);
            }
        }

        // Track this as the active recipe for sidebar stickiness
        localStorage.setItem('active_recipe_id', initialData?.id || 'new');
    }, [draftKey, reset, initialData?.id]);

    // 2. Auto-Save Draft
    const watchedAll = watch();
    useEffect(() => {
        const timeout = setTimeout(() => {
            const data = {
                ...watchedAll,
                selectedCategoryTags
            };
            localStorage.setItem(draftKey, JSON.stringify(data));
        }, 1000);
        return () => clearTimeout(timeout);
    }, [watchedAll, selectedCategoryTags, draftKey]);

    const clearDraft = () => {
        localStorage.removeItem(draftKey);
        localStorage.removeItem('active_recipe_id');
    };

    const watchedYield = watch('yield_qty');
    const watchedUnit = watch('yield_unit');
    const watchedItems = watch('items') as any[]; // Explicit cast to avoid 'never' inference

    // Auto-Detect Allergens Logic
    const detectAllergens = () => {
        const keywords = ['milk', 'cream', 'cheese', 'butter', 'yogurt', 'egg', 'peanut', 'nut', 'almond', 'cashew', 'walnut', 'pecan', 'soy', 'tofu', 'wheat', 'flour', 'gluten', 'fish', 'salmon', 'tuna', 'shellfish', 'shrimp', 'crab', 'lobster', 'sesame'];
        const found = new Set<string>();

        watchedItems.forEach(item => {
            const lowerName = (item.name || '').toLowerCase();
            keywords.forEach(key => {
                if (lowerName.includes(key)) {
                    // Map keywords to standard allergens if needed, or just use the keyword
                    if (['milk', 'cream', 'cheese', 'butter', 'yogurt'].includes(key)) found.add('Dairy');
                    else if (['wheat', 'flour', 'gluten'].includes(key)) found.add('Gluten');
                    else if (['peanut'].includes(key)) found.add('Peanuts');
                    else if (['almond', 'cashew', 'walnut', 'pecan', 'nut'].includes(key)) found.add('Tree Nuts');
                    else if (['soy', 'tofu'].includes(key)) found.add('Soy');
                    else if (['fish', 'salmon', 'tuna'].includes(key)) found.add('Fish');
                    else if (['shellfish', 'shrimp', 'crab', 'lobster'].includes(key)) found.add('Shellfish');
                    else if (key === 'egg') found.add('Map');
                    else found.add(key.charAt(0).toUpperCase() + key.slice(1));
                }
            });
        });

        if (found.size > 0) {
            const current = watch('allergens');
            const newAllergens = Array.from(found).join(', ');
            if (current && current !== newAllergens) {
                if (confirm(`Found allergens: ${newAllergens}.\nReplace current value "${current}"?`)) {
                    setValue('allergens', newAllergens);
                }
            } else {
                setValue('allergens', newAllergens);
            }
        } else {
            alert('No common allergens detected in ingredients.');
        }
    };

    const { fields, append, remove } = useFieldArray({
        control,
        name: 'items'
    });

    // Inline Category Creation
    const handleCreateCategory = async (level: 'root' | 'sub' | 'deep') => {
        const parentId = level === 'deep' ? selectedSub : level === 'sub' ? selectedRoot : null;
        const levelName = level === 'root' ? 'Category Type' : level === 'sub' ? 'Sub-Category' : 'Detail Category';

        const name = prompt(`Enter name for new ${levelName}:`);
        if (!name) return; // User cancelled

        try {
            const res = await fetch('/api/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, parent_id: parentId })
            });

            if (res.ok) {
                const newCat = await res.json();

                // Refresh categories logic could be cleaner (re-fetch), but for speed we can append locally
                // Actually re-fetching is safer due to nesting structure
                const refresh = await fetch('/api/categories');
                const data = await refresh.json();
                setCategories(data);

                // Auto-select based on level
                if (level === 'root') setSelectedRoot(newCat.id);
                if (level === 'sub') {
                    // Ensure root is still selected (it should be)
                    setSelectedSub(newCat.id);
                }
                if (level === 'deep') {
                    setSelectedDeepSub(newCat.id);
                }
            } else {
                alert('Failed to create category');
            }
        } catch (e) {
            console.error(e);
            alert('Error creating category');
        }
    };

    const onSubmit = async (data: any) => {
        try {
            const url = initialData?.id
                ? `/api/recipes/${initialData.id}`
                : '/api/recipes';

            const method = initialData?.id ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({
                    ...data,
                    // Send array of IDs
                    category_ids: selectedCategoryTags.map(c => c.id),
                    // Legacy for backwards compat (send first one as primary)
                    category_id: selectedCategoryTags.length > 0 ? selectedCategoryTags[0].id : null
                })
            });

            if (res.ok) {
                clearDraft();
                alert('Recipe Saved Successfully!');
                router.push('/recipes'); // Always return to manager
                router.refresh();
            } else {
                const errData = await res.json();
                alert('Failed to save recipe: ' + (errData.error || 'Unknown Error'));
            }
        } catch (err) {
            console.error(err);
            alert('Error saving recipe');
        }
    };

    const onDelete = async () => {
        if (!initialData?.id) return;

        if (!confirm('Are you sure you want to delete this recipe? This cannot be undone.')) return;

        try {
            const res = await fetch(`/api/recipes/${initialData.id}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                clearDraft();
                alert('Recipe Deleted');
                router.push('/recipes');
                router.refresh(); // Ensure list is updated
            } else {
                alert('Failed to delete recipe');
            }
        } catch (err) {
            console.error(err);
            alert('Error deleting recipe');
        }
    };

    // Calculate Multiplier
    const baseQty = Number(watchedYield) || 1;
    const baseUnit = watchedUnit || 'unit';

    // Scaling Logic
    // If user enters a Target Qty, we assume it is in 'targetUnit' (or baseUnit if not set)
    // Multiplier = (TargetQty_Converted_To_BaseUnit) / BaseQty
    const currentTargetUnit = targetUnit || baseUnit;
    const currentTargetQty = Number(targetYield) || baseQty;

    const convertedTargetQty = convertUnit(currentTargetQty, currentTargetUnit, baseUnit);
    const multiplier = convertedTargetQty / baseQty;

    return (
        <div className="max-w-5xl mx-auto space-y-8">
            {/* Header / Actions */}
            {/* Header / Actions */}
            <div className="flex justify-between items-center bg-white dark:bg-slate-800 bg-adaptive p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-colors print:hidden">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => {
                            clearDraft();
                            router.push('/recipes');
                        }}
                        className="p-2 -ml-2 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors print:hidden"
                    >
                        <ArrowLeft size={24} />
                    </button>
                    <div>
                        <h2 className="text-2xl font-bold text-slate-900 text-adaptive">{isScaling ? 'Batch Calculator' : 'Recipe Editor'}</h2>
                        <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle text-sm print:hidden">{isScaling ? 'Scale ingredients for production.' : 'Define culinary standards and yields.'}</p>
                    </div>
                </div>
                <div className="flex items-center gap-3 print:hidden">
                    <button
                        onClick={() => window.print()}
                        className="flex items-center gap-2 px-4 py-2 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg font-medium transition-colors"
                        title="Print Recipe"
                    >
                        <Printer size={18} />
                        Print
                    </button>
                    <button
                        onClick={() => setIsScaling(!isScaling)}
                        className={`px-4 py-2 rounded-lg font-medium transition-colors ${isScaling ? 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600' : 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50'}`}
                    >
                        {isScaling ? 'Back to Editor' : 'Scale Recipe'}
                    </button>
                    {!isScaling && (
                        <>
                            {initialData?.id && (
                                <button
                                    onClick={onDelete}
                                    className="px-4 py-2 bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/40 rounded-lg font-medium transition-colors flex items-center gap-2"
                                >
                                    <Trash size={18} />
                                    Delete
                                </button>
                            )}
                            <button
                                onClick={handleSubmit(onSubmit)}
                                className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-700 hover:to-emerald-600 text-white px-6 py-2.5 rounded-lg shadow-md transition-all font-medium"
                            >
                                <Save size={18} />
                                Save
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Main Content */}
            <div className="bg-white dark:bg-slate-800 bg-adaptive rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 transition-colors print:shadow-none print:border-none print:p-0">

                {/* Print Header - Recipe Card Style */}
                <div className="hidden print:flex justify-between items-end mb-8 border-b-2 border-slate-900 pb-4">
                    <h1 className="text-4xl font-bold text-slate-900">{watch('name') || 'Untitled Recipe'}</h1>
                    <div className="flex flex-col items-end">
                        <div className="text-xl font-medium text-slate-600">
                            {isScaling ? (
                                <span>Yield: <span className="font-bold text-slate-900">{targetYield || baseQty} {targetUnit || baseUnit}</span></span>
                            ) : (
                                <span>Yield: <span className="font-bold text-slate-900">{baseQty} {baseUnit}</span></span>
                            )}
                        </div>
                        <div className="text-sm text-slate-400 mt-1">
                            {[
                                categories.find(c => c.id === selectedRoot)?.name,
                                categories.find(c => c.children?.find(s => s.id === selectedSub))?.children?.find(s => s.id === selectedSub)?.name
                            ].filter(Boolean).join(' > ')}
                        </div>
                    </div>
                </div>

                <style jsx global>{`
                    @media print {
                        @page {
                            size: portrait;
                            margin: 1cm;
                        }
                        
                        /* Ensure the recipe content is visible */
                        body {
                            background: white !important;
                        }
                        
                        /* Make sure all print:block elements are visible */
                        .print\\:block {
                            display: block !important;
                        }
                        
                        .print\\:flex {
                            display: flex !important;
                        }
                        
                        /* Ensure colors print correctly */
                        * {
                            -webkit-print-color-adjust: exact !important;
                            print-color-adjust: exact !important;
                        }
                        
                        /* Remove shadows and transforms for clean print */
                        .shadow-sm, .shadow-lg, .shadow-2xl {
                            box-shadow: none !important;
                        }
                        
                        .transform {
                            transform: none !important;
                        }
                    }
                `}</style>

                {/* Standard / Scale Inputs (Hidden in Print) */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10 print:hidden">
                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Recipe Name</label>
                        <input
                            {...register('name')}
                            disabled={isScaling}
                            className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 print:hidden"
                            placeholder="e.g. Classic Beef Lasagna"
                        />
                        <div className="hidden print:block text-xl font-bold border-b border-slate-200 pb-1">
                            {watch('name') || 'Untitled Recipe'}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="flex justify-between items-center">
                            <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Allergens</label>
                            <button
                                type="button"
                                onClick={detectAllergens}
                                disabled={isScaling}
                                className="text-xs flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-bold bg-indigo-50 dark:bg-indigo-900/30 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                            >
                                <Wand2 size={12} /> Auto-Detect
                            </button>
                        </div>
                        <input
                            {...register('allergens')}
                            disabled={isScaling}
                            className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 print:hidden"
                            placeholder="e.g. Dairy, Nuts, Gluten"
                        />
                        <div className="hidden print:block text-sm text-rose-600 font-bold">
                            {watch('allergens') ? `Contains: ${watch('allergens')}` : ''}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Category</label>
                        <div className="flex flex-col gap-2">
                            {/* Root */}
                            <select
                                className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none text-slate-900 dark:text-slate-100"
                                value={selectedRoot}
                                onChange={e => {
                                    if (e.target.value === 'NEW_ROOT') { handleCreateCategory('root'); return; }
                                    setSelectedRoot(e.target.value);
                                    setSelectedSub('');
                                    setSelectedDeepSub('');
                                }}
                            >
                                <option value="">Select Type...</option>
                                {categories.filter(c => !c.parent_id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                <option value="NEW_ROOT" className="font-bold text-indigo-600">+ New Type...</option>
                            </select>

                            {/* Level 2 */}
                            {selectedRoot && categories.find(c => c.id === selectedRoot)?.children && (
                                <select
                                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none text-slate-900 dark:text-slate-100"
                                    value={selectedSub}
                                    onChange={e => {
                                        if (e.target.value === 'NEW_SUB') { handleCreateCategory('sub'); return; }
                                        setSelectedSub(e.target.value);
                                        setSelectedDeepSub('');
                                    }}
                                >
                                    <option value="">Select Sub-Type...</option>
                                    {categories.find(c => c.id === selectedRoot)?.children?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    <option value="NEW_SUB" className="font-bold text-indigo-600">+ New Sub-Type...</option>
                                </select>
                            )}

                            {/* Level 3 */}
                            {selectedSub && categories.flatMap(c => c.children || []).find(c => c.id === selectedSub)?.children && (
                                <select
                                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none text-slate-900 dark:text-slate-100"
                                    value={selectedDeepSub}
                                    onChange={e => {
                                        if (e.target.value === 'NEW_DEEP') { handleCreateCategory('deep'); return; }
                                        setSelectedDeepSub(e.target.value);
                                    }}
                                >
                                    <option value="">Select Detail...</option>
                                    {categories.flatMap(c => c.children || []).find(c => c.id === selectedSub)?.children?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    <option value="NEW_DEEP" className="font-bold text-indigo-600">+ New Detail...</option>
                                </select>
                            )}
                        </div>
                        <div className="hidden print:block text-lg border-b border-slate-200 pb-1">
                            {[
                                categories.find(c => c.id === selectedRoot)?.name,
                                categories.find(c => c.children?.find(s => s.id === selectedSub))?.children?.find(s => s.id === selectedSub)?.name,
                                categories.flatMap(c => c.children || []).find(c => c.children?.find(d => d.id === selectedDeepSub))?.children?.find(d => d.id === selectedDeepSub)?.name
                            ].filter(Boolean).join(' > ') || 'No Category'}
                        </div>

                        {/* Add Button */}
                        <div className="flex items-center gap-2 pt-2">
                            <button
                                type="button"
                                onClick={handleAddCategoryTag}
                                disabled={!browsedCategoryId}
                                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium text-sm"
                            >
                                <Plus size={16} />
                                Add Selected Category
                            </button>
                            <span className="text-xs text-slate-400">
                                (Browse above, then click to add)
                            </span>
                        </div>

                        {/* Selected Tags */}
                        {selectedCategoryTags.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl border border-slate-100 dark:border-slate-700/50">
                                {selectedCategoryTags.map(tag => (
                                    <div key={tag.id} className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-full border border-slate-200 dark:border-slate-700 shadow-sm text-sm font-medium animate-in fade-in zoom-in duration-200">
                                        <span>{tag.name}</span>
                                        <button
                                            type="button"
                                            onClick={() => handleRemoveCategoryTag(tag.id)}
                                            className="p-0.5 hover:bg-rose-100 dark:hover:bg-rose-900/40 hover:text-rose-600 rounded-full transition-colors"
                                        >
                                            <Trash size={12} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {isScaling ? (
                        <div className="space-y-2 bg-indigo-50 dark:bg-indigo-900/20 p-4 -m-4 rounded-xl border border-indigo-100 dark:border-indigo-800 print:hidden">
                            <label className="text-sm font-bold text-indigo-900 dark:text-indigo-300">Target Batch Size</label>
                            <div className="flex gap-2 print:hidden">
                                <input
                                    type="number"
                                    value={targetYield ?? ''}
                                    onChange={(e) => setTargetYield(e.target.value)}
                                    placeholder={String(baseQty)}
                                    className="flex-1 w-full min-w-0 px-4 py-2.5 bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-700 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-bold text-indigo-900 dark:text-indigo-300 text-lg placeholder:text-indigo-300 dark:placeholder:text-indigo-700"
                                    autoFocus
                                />
                                <select
                                    className="px-4 font-medium text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-700 rounded-lg outline-none"
                                    value={targetUnit || baseUnit || ''}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === 'ADD_NEW') {
                                            handleAddNewUnit(val, setTargetUnit);
                                        } else {
                                            setTargetUnit(val);
                                        }
                                    }}
                                >
                                    {units.map(u => <option key={u} value={u}>{u}</option>)}
                                    <option value="ADD_NEW" className="font-bold text-indigo-600">+ Add New Unit...</option>
                                    {/* Allow custom if not in list */}
                                    {!units.includes(baseUnit) && <option value={baseUnit}>{baseUnit}</option>}
                                </select>
                            </div>
                            <div className="hidden print:block text-xl font-bold border-b border-indigo-200 pb-1 text-indigo-900">
                                {targetYield || baseQty} {targetUnit || baseUnit}
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Base Yield</label>
                            <div className="flex gap-2">
                                <input
                                    {...register('yield_qty')}
                                    type="number"
                                    className="w-24 px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 print:hidden"
                                />
                                <div className="flex-1 relative">
                                    <select
                                        {...register('yield_unit', {
                                            onChange: (e) => {
                                                if (e.target.value === 'ADD_NEW') {
                                                    const added = handleAddNewUnit('ADD_NEW');
                                                    if (added) setValue('yield_unit', added);
                                                    else setValue('yield_unit', watchedUnit); // revert
                                                }
                                            }
                                        })}
                                        className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 print:hidden appearance-none pr-10"
                                    >
                                        <option value="" disabled>Select Unit...</option>
                                        {units.map(u => <option key={u} value={u}>{u}</option>)}
                                        <option value="ADD_NEW" className="font-bold text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20">+ Add New Unit...</option>
                                    </select>
                                    <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400 print:hidden">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
                                    </div>
                                </div>
                                <div className="hidden print:block text-xl font-bold border-b border-slate-200 pb-1">
                                    {watch('yield_qty')} {watch('yield_unit')}
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Recipe Type</label>
                        <select
                            {...register('type')}
                            disabled={isScaling}
                            className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 text-slate-900 dark:text-slate-100 appearance-none"
                        >
                            <option value="menu_item">Menu Item (Final Dish)</option>
                            <option value="prep">Prep / Sub-Recipe</option>
                        </select>
                    </div>
                </div>

                {/* Ingredients Section */}
                <div>
                    {/* ... Header logic similar to before but hide 'Add Item' if scaling ... */}
                    <div className="flex items-center justify-between mb-4 border-b border-slate-100 dark:border-slate-700 pb-4">
                        <h3 className="text-lg font-bold text-slate-900 text-adaptive flex items-center gap-2">
                            {isScaling ? 'Scaled Ingredients' : 'Ingredients & Sub-Recipes'}
                            <span className="text-xs font-normal text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded-full">{fields.length} Items</span>
                        </h3>
                        {!isScaling && (
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => append({ name: '', qty: 0, unit: '', is_sub_recipe: false, section_name: '', section_batch: 1 })}
                                    className="text-sm text-indigo-600 dark:text-indigo-400 font-semibold hover:text-indigo-700 dark:hover:text-indigo-300 flex items-center gap-1 bg-indigo-50 dark:bg-indigo-900/30 px-3 py-1.5 rounded-lg transition-colors"
                                >
                                    <Plus size={16} />
                                    Ingredient
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const name = prompt("Enter Name for Sub or Batch Recipe (e.g. Cheese Sauce):");
                                        if (name) {
                                            append({ name: '', qty: 0, unit: '', is_sub_recipe: true, section_name: name, section_batch: 1 });
                                        }
                                    }}
                                    className="text-sm text-emerald-600 dark:text-emerald-400 font-semibold hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1.5 rounded-lg transition-colors border border-emerald-100 dark:border-emerald-800"
                                >
                                    <Plus size={16} />
                                    Sub-Recipe
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Sectioned Table Body */}
                    <div className="space-y-8">
                        {Array.from(new Set(watchedItems.map(i => i.section_name || ''))).map(sectionName => {
                            const sectionFields = fields
                                .map((f, i) => ({ ...f, originalIndex: i }))
                                .filter(f => (watchedItems[f.originalIndex]?.section_name || '') === sectionName);

                            if (sectionFields.length === 0) return null;

                            const isBox = sectionName !== '';
                            const batchValue = isBox ? (watchedItems[sectionFields[0].originalIndex]?.section_batch || 1) : 1;

                            return (
                                <div key={sectionFields[0].id} className={isBox ? "bg-emerald-50/20 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-800 rounded-xl p-6" : ""}>
                                    {isBox && (
                                        <div className="flex items-center justify-between mb-4 border-b border-emerald-100 dark:border-emerald-800 pb-4">
                                            <div className="flex items-center gap-3">
                                                <div className="p-2 bg-emerald-500 text-white rounded-lg">
                                                    <Wand2 size={20} />
                                                </div>
                                                <div className="flex-1">
                                                    <input
                                                        type="text"
                                                        value={sectionName}
                                                        onChange={(e) => {
                                                            const newName = e.target.value;
                                                            sectionFields.forEach(f => {
                                                                setValue(`items.${f.originalIndex}.section_name`, newName);
                                                            });
                                                        }}
                                                        className="text-lg font-bold text-emerald-900 dark:text-emerald-300 bg-transparent border-none outline-none focus:ring-1 focus:ring-emerald-500 rounded px-1 w-full"
                                                        placeholder="Sub-Recipe Name..."
                                                    />
                                                    <p className="text-xs text-emerald-600 dark:text-emerald-500 px-1">Internal Batch / Production Group</p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3 bg-white dark:bg-slate-800 p-2 rounded-lg border border-emerald-100 dark:border-emerald-800 shadow-sm">
                                                <label className="text-[10px] font-black text-emerald-600 dark:text-emerald-500 uppercase tracking-tighter">Batch Multiplier</label>
                                                <input
                                                    type="number"
                                                    value={batchValue}
                                                    onChange={(e) => {
                                                        const newVal = Number(e.target.value) || 1;
                                                        sectionFields.forEach(f => {
                                                            setValue(`items.${f.originalIndex}.section_batch`, newVal);
                                                        });
                                                    }}
                                                    className="w-16 px-2 py-1 text-center font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 rounded border-none outline-none focus:ring-1 focus:ring-emerald-500"
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {!isBox && sectionName === '' && (
                                        <h4 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-4">Standard Ingredients</h4>
                                    )}

                                    <div className="space-y-2">
                                        {sectionFields.map(({ originalIndex, id }) => {
                                            const index = originalIndex;
                                            // Calculate Scaled Value (Global Scale)
                                            const originalQty = Number(watchedItems?.[index]?.qty) || 0;
                                            const scaledQty = originalQty * multiplier;

                                            // Sub-recipe local batch scaling (Batch x qty)
                                            const currentBatch = Number(watchedItems?.[index]?.section_batch) || 1;
                                            const totalBatchQty = originalQty * currentBatch;

                                            return (
                                                <div key={id} className={`grid grid-cols-12 gap-4 items-center p-2 rounded-lg border group ${isScaling ? 'bg-indigo-50/30 dark:bg-indigo-900/10 border-indigo-100 dark:border-indigo-800' : 'bg-white dark:bg-slate-900/30 border-slate-200 dark:border-slate-700 hover:border-emerald-300 dark:hover:border-emerald-700 transition-colors'} print:border-0 print:border-b print:border-slate-300 print:rounded-none print:p-2 print:bg-transparent`}>
                                                    <div className="col-span-1 flex justify-center items-center text-slate-400">
                                                        {index + 1}
                                                        {/* Hidden Registrations for Metadata */}
                                                        <input type="hidden" {...register(`items.${index}.is_sub_recipe` as const)} />
                                                        <input type="hidden" {...register(`items.${index}.section_name` as const)} />
                                                        <input type="hidden" {...register(`items.${index}.section_batch` as const)} />
                                                    </div>
                                                    <div className="col-span-4 relative">
                                                        <input
                                                            {...register(`items.${index}.name` as const, {
                                                                onChange: (e) => handleSyncIngredient(index, e.target.value)
                                                            })}
                                                            list={`ingredient-list-${index}`}
                                                            disabled={isScaling}
                                                            className="w-full px-3 py-2 bg-transparent border-none font-medium text-slate-900 dark:text-slate-100 outline-none disabled:cursor-text placeholder:text-slate-400 dark:placeholder:text-slate-600 print:hidden"
                                                            placeholder={isBox ? "Search sub-ingredients..." : "Search ingredients..."}
                                                        />
                                                        <datalist id={`ingredient-list-${index}`}>
                                                            {allIngredients.map(ing => (
                                                                <option key={ing.id} value={ing.name} />
                                                            ))}
                                                        </datalist>
                                                        <div className="hidden print:block px-3 py-2 font-medium text-slate-900">
                                                            {watchedItems?.[index]?.name}
                                                        </div>
                                                    </div>
                                                    <div className="col-span-2">
                                                        {isScaling ? (
                                                            <div className="px-3 py-2 font-bold text-indigo-700 dark:text-indigo-300 font-mono text-lg">
                                                                {formatQuantity(scaledQty)}
                                                            </div>
                                                        ) : (
                                                            <div className="relative">
                                                                <input
                                                                    {...register(`items.${index}.qty` as const)}
                                                                    type="number"
                                                                    step="0.01"
                                                                    className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md focus:ring-2 focus:ring-emerald-500 outline-none text-sm text-slate-900 dark:text-slate-100 print:hidden"
                                                                />
                                                                <div className="hidden print:block px-3 py-2 font-mono font-bold text-slate-900">
                                                                    {formatQuantity(watchedItems?.[index]?.qty)}
                                                                </div>
                                                                {/* Batch Preview */}
                                                                {isBox && currentBatch > 1 && (
                                                                    <div className="absolute -top-7 left-0 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                                                                        <span className="text-[10px] font-black text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                                                                            Batch Total: {formatQuantity(totalBatchQty)} {watchedItems[index].unit}
                                                                        </span>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="col-span-2">
                                                        <select
                                                            {...register(`items.${index}.unit` as const, {
                                                                onChange: (e) => {
                                                                    if (e.target.value === 'ADD_NEW') {
                                                                        const added = handleAddNewUnit('ADD_NEW');
                                                                        if (added) setValue(`items.${index}.unit`, added);
                                                                        else setValue(`items.${index}.unit`, ''); // revert
                                                                    }
                                                                }
                                                            })}
                                                            disabled={isScaling}
                                                            className={`w-full px-3 py-2 rounded-md outline-none text-sm disabled:cursor-text appearance-none print:hidden ${isScaling ? 'bg-transparent border-none text-slate-500 dark:text-slate-400' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:ring-2 focus:ring-emerald-500 text-slate-700 dark:text-slate-200'}`}
                                                        >
                                                            <option value="" disabled>Select Unit...</option>
                                                            {units.map(u => (
                                                                <option key={u} value={u}>{u}</option>
                                                            ))}
                                                            <option value="ADD_NEW" className="font-bold text-emerald-600">+ Add New Unit...</option>
                                                        </select>
                                                        <div className="hidden print:block px-3 py-2 text-sm text-slate-500 font-bold">
                                                            {watchedItems?.[index]?.unit}
                                                        </div>
                                                    </div>

                                                    {/* Line Cost Column */}
                                                    <div className="col-span-1 text-right font-mono font-bold text-slate-600 dark:text-slate-400">
                                                        {(() => {
                                                            const item = watchedItems?.[index];
                                                            const match = allIngredients.find(ing => ing.name.toLowerCase() === (item?.name || '').toLowerCase());
                                                            if (match) {
                                                                const qty = isScaling ? scaledQty : (Number(item?.qty) || 0);
                                                                const rate = convertUnit(1, item?.unit || '', match.unit);
                                                                const lineCost = qty * rate * Number(match.cost_per_unit || 0);
                                                                return `$${lineCost.toFixed(2)}`;
                                                            }
                                                            return <span className="text-slate-300">$-.--</span>;
                                                        })()}
                                                    </div>

                                                    {isScaling ? (
                                                        <div className="col-span-2 text-right">
                                                            {(() => {
                                                                const opt = optimizeUnit(scaledQty, watchedItems?.[index]?.unit, watchedItems?.[index]?.name);
                                                                if (opt.unit !== watchedItems?.[index]?.unit) {
                                                                    return (
                                                                        <div className="px-3 py-2 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-lg font-bold font-mono text-sm inline-block shadow-sm border border-emerald-100 dark:border-emerald-900/50">
                                                                            {formatQuantity(opt.qty)} {opt.unit}
                                                                        </div>
                                                                    )
                                                                }
                                                                return <span className="text-slate-300">-</span>
                                                            })()}
                                                        </div>
                                                    ) : (
                                                        <div className="col-span-2 flex justify-center gap-1">
                                                            {isBox && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => append({ ...watchedItems[index], name: '', qty: 0 })}
                                                                    className="p-1.5 text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-md transition-all opacity-0 group-hover:opacity-100"
                                                                    title="Add Item to this Batch"
                                                                >
                                                                    <Plus size={16} />
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                onClick={() => remove(index)}
                                                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-md transition-all opacity-0 group-hover:opacity-100 print:hidden"
                                                            >
                                                                <Trash size={16} />
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>

                                    {isBox && !isScaling && (
                                        <div className="mt-4 flex justify-end">
                                            <button
                                                type="button"
                                                onClick={() => append({ name: '', qty: 0, unit: '', is_sub_recipe: true, section_name: sectionName, section_batch: batchValue })}
                                                className="text-xs font-bold text-emerald-600 hover:text-emerald-800 flex items-center gap-1 bg-white dark:bg-slate-800 px-3 py-1 rounded-full border border-emerald-100 dark:border-emerald-800 shadow-sm transition-all hover:shadow-md"
                                            >
                                                <Plus size={14} /> Add to {sectionName}
                                            </button>
                                        </div>
                                    )}

                                    {!isBox && !isScaling && (
                                        <div className="mt-4 flex justify-end">
                                            <button
                                                type="button"
                                                onClick={() => append({ name: '', qty: 0, unit: 'g', is_sub_recipe: false, section_name: '', section_batch: 1 })}
                                                className="text-xs font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 bg-white dark:bg-slate-800 px-3 py-1 rounded-full border border-indigo-100 dark:border-slate-800 shadow-sm transition-all hover:shadow-md font-mono"
                                            >
                                                <Plus size={14} /> Add Ingredient
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {!isScaling && fields.filter(f => !((watchedItems[fields.indexOf(f)] as any)?.section_name)).length === 0 && (
                        <div className="mt-4 text-center p-8 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                            <p className="text-slate-400 text-sm mb-4">No standard ingredients yet.</p>
                            <button
                                onClick={() => append({ name: '', qty: 0, unit: 'g', is_sub_recipe: false, section_name: '', section_batch: 1 })}
                                className="inline-flex items-center gap-2 text-indigo-600 font-bold hover:text-indigo-800"
                            >
                                <Plus size={18} /> Add Your First Ingredient
                            </button>
                        </div>
                    )}
                </div>

                {/* Instructions Section */}
                <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-700">
                    <h3 className="text-lg font-bold text-slate-900 text-adaptive mb-4">Instructions</h3>

                    {/* Toggle between Edit/View Mode based on isScaling (View Only in Scale Mode) or Print */}
                    <div className={isScaling ? 'hidden' : 'block print:hidden'}>
                        <textarea
                            {...register('instructions')}
                            rows={8}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-y"
                            placeholder="Enter step-by-step preparation instructions here..."
                        />
                    </div>

                    {/* Read-Only View (Scaling Mode or Print) */}
                    {(isScaling || (typeof window !== 'undefined' && window.matchMedia('print').matches) || true) && (
                        <div className={`prose dark:prose-invert max-w-none text-slate-700 dark:text-slate-300 whitespace-pre-wrap ${!isScaling ? 'hidden print:block' : ''}`}>
                            {watch('instructions') || <span className="italic text-slate-400">No instructions provided.</span>}
                        </div>
                    )}
                </div>

                {/* Macros Section */}
                <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-700">
                    <h3 className="text-lg font-bold text-slate-900 text-adaptive mb-4">Nutritional Macros</h3>

                    <div className={isScaling ? 'hidden' : 'block print:hidden'}>
                        <textarea
                            {...register('macros')}
                            rows={3}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-y"
                            placeholder="e.g. Calories: 500, Protein: 20g, Carbs: 45g, Fat: 15g"
                        />
                    </div>

                    {(isScaling || (typeof window !== 'undefined' && window.matchMedia('print').matches) || true) && (
                        <div className={`prose dark:prose-invert max-w-none text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono text-sm ${!isScaling ? 'hidden print:block' : ''}`}>
                            {watch('macros') || <span className="italic text-slate-400">No macro information.</span>}
                        </div>
                    )}
                </div>
            </div >
        </div >
    );
}
