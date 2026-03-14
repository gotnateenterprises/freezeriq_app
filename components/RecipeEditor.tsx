"use client";


import { useState, useEffect, useMemo, useRef } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Plus, Trash, Save, ArrowLeft, Printer, Wand2, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    verticalListSortingStrategy
} from '@dnd-kit/sortable';

import { Recipe } from '@/types';
import { convertUnit, optimizeUnit } from '@/lib/unit_converter';
import { formatQuantity } from '@/lib/format_quantity';
import RecipeIngredientRow from './RecipeIngredientRow';
import NutritionFactsLabel, { NutritionData } from './NutritionFactsLabel';

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
    const [isGrabbingImage, setIsGrabbingImage] = useState(false);
    const [isGeneratingDescription, setIsGeneratingDescription] = useState(false);
    const [isGeneratingMacros, setIsGeneratingMacros] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [isDetectingAllergens, setIsDetectingAllergens] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [targetYield, setTargetYield] = useState<number | string>('');
    const [showFullNutrition, setShowFullNutrition] = useState(false);
    const [fullNutritionData, setFullNutritionData] = useState<Partial<NutritionData> | null>(null);
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

    // Initialize Full Nutrition from macros field if it's JSON
    useEffect(() => {
        const macrosValue = watch('macros');
        if (macrosValue && macrosValue.startsWith('{')) {
            try {
                const parsed = JSON.parse(macrosValue);
                if (parsed.fullData) {
                    setFullNutritionData(parsed.fullData);
                    setShowFullNutrition(true);
                }
            } catch (e) {
                // Not JSON, ignore
            }
        }
    }, []);

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
            // Only auto-fill unit when the field is empty (new row).
            // Never overwrite a unit the user already chose.
            const currentUnit = watch(`items.${index}.unit`);
            if (!currentUnit) {
                setValue(`items.${index}.unit`, match.unit);
            }
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

    // Helper to toggle a category tag
    const toggleCategoryTag = (cat: Category) => {
        if (selectedCategoryTags.some(c => c.id === cat.id)) {
            setSelectedCategoryTags(selectedCategoryTags.filter(c => c.id !== cat.id));
        } else {
            setSelectedCategoryTags([...selectedCategoryTags, cat]);
        }
    };

    // Determine Final Category ID to submit
    // const finalCategoryId = selectedDeepSub || selectedSub || selectedRoot;

    // Watch form values for real-time scaling base
    const formValues = useForm<any>({
        defaultValues: initialData ? {
            name: initialData.name ?? '',
            allergens: initialData.allergens || '',
            type: initialData.type || 'menu_item',
            container_type: (initialData as any).container_type || 'tray',
            yield_qty: Number(initialData.base_yield_qty) || 1,
            yield_unit: initialData.base_yield_unit ?? 'servings',
            items: (initialData.items || []).map((i: any) => ({
                name: (i.child_recipe?.name || i.child_ingredient?.name || i.name) ?? '',
                qty: Number(i.quantity) || 0,
                unit: i.unit || '',
                is_sub_recipe: !!i.is_sub_recipe,
                section_name: i.section_name || '',
                section_batch: Number(i.section_batch) || 1
            })),
            instructions: initialData.instructions || '',
            label_text: initialData.label_text || '',
            macros: (initialData as any).macros || '',
            image_url: initialData.image_url || '',
            description: initialData.description || '',
            cook_time: (initialData as any).cook_time || ''
        } : {
            name: '',
            type: 'menu_item',
            container_type: 'tray',
            yield_qty: 1,
            yield_unit: 'servings',
            items: [{ name: '', qty: 0, unit: '', is_sub_recipe: false, section_name: '', section_batch: 1 }],
            instructions: '',
            label_text: '',
            macros: '',
            image_url: '',
            description: '',
            cook_time: ''
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

                // Sanitize draft to prevent undefined values causing controlled/uncontrolled warnings
                const sanitizedDraft = {
                    ...draft,
                    name: draft.name || '',
                    allergens: draft.allergens || '',
                    type: draft.type || 'menu_item',
                    container_type: draft.container_type || 'tray',
                    yield_unit: draft.yield_unit || 'servings',
                    instructions: draft.instructions || '',
                    label_text: draft.label_text || '',
                    macros: draft.macros || '',
                    items: (draft.items || []).map((i: any) => ({
                        ...i,
                        name: i.name || '',
                        unit: i.unit || '',
                        section_name: i.section_name || ''
                    }))
                };

                reset(sanitizedDraft);
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

    // Live Cost Calculation
    const liveCostData = useMemo(() => {
        let totalCost = 0;
        let isAccurate = true;

        (watchedItems || []).forEach(item => {
            if (!item.name) return;

            if (item.is_sub_recipe) {
                const subRec = allRecipes.find(r => r.name.toLowerCase() === item.name.toLowerCase());
                if (subRec) {
                    const subCostPerUnit = (subRec as any).cost_per_unit || 0;
                    if (subCostPerUnit === 0) isAccurate = false;

                    const conversion = convertUnit(1, item.unit, subRec.base_yield_unit || 'servings', subRec.name);
                    totalCost += Number(item.qty) * conversion * subCostPerUnit;
                } else {
                    isAccurate = false;
                }
            } else {
                const ing = allIngredients.find(i => i.name.toLowerCase() === item.name.toLowerCase());
                if (ing) {
                    const costPerUnit = Number(ing.cost_per_unit || 0);
                    if (costPerUnit === 0) isAccurate = false;

                    const conversion = convertUnit(1, item.unit, ing.unit, ing.name);
                    totalCost += Number(item.qty) * conversion * costPerUnit;
                } else {
                    isAccurate = false;
                }
            }
        });

        const yieldQty = Number(watchedYield) || 1;
        return {
            totalCost,
            costPerUnit: totalCost / yieldQty,
            isAccurate
        };
    }, [watchedItems, watchedYield, allIngredients, allRecipes]);

    // AI-Powered Allergen Detection
    const detectAllergens = async () => {
        const items = watch('items') || [];
        const ingredientNames = items.map((i: any) => i.name).filter(Boolean);

        if (ingredientNames.length === 0) {
            alert('Please add some ingredients first.');
            return;
        }

        setIsDetectingAllergens(true);
        try {
            const res = await fetch('/api/recipes/detect-allergens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ingredients: ingredientNames })
            });
            const data = await res.json();

            if (data.allergens) {
                const current = watch('allergens');
                const newAllergens = data.allergens;

                if (current && current !== newAllergens) {
                    if (confirm(`AI found allergens: ${newAllergens}.\nReplace current value "${current}"?`)) {
                        setValue('allergens', newAllergens, { shouldDirty: true });
                    }
                } else {
                    setValue('allergens', newAllergens, { shouldDirty: true });
                }
            } else if (data.error) {
                alert(`${data.error}${data.details ? `\n\nDetails: ${data.details}` : ''}`);
            } else {
                alert('No common allergens detected.');
            }
        } catch (e) {
            console.error(e);
            alert("Error analyzing allergens.");
        } finally {
            setIsDetectingAllergens(false);
        }
    };

    const handleGrabImage = async () => {
        const recipeName = watch('name');
        const items = watch('items') || [];
        const description = watch('description') || '';
        const ingredientNames = items.map((i: any) => i.name).filter(Boolean);

        if (!recipeName) {
            alert('Please enter a recipe name first');
            return;
        }

        setIsGrabbingImage(true);
        try {
            const res = await fetch('/api/recipes/grab-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: recipeName,
                    ingredients: ingredientNames,
                    description: description
                })
            });
            const data = await res.json();
            if (data.url) {
                setValue('image_url', data.url, { shouldDirty: true });
                // Trigger draft save immediately with latest values
                const currentData = { ...formValues.getValues(), image_url: data.url, selectedCategoryTags };
                localStorage.setItem(draftKey, JSON.stringify(currentData));
                alert('Success! Image detected. Make sure to click "Save" at the bottom to keep this photo.');
            } else if (data.error) {
                alert(`Error: ${data.error}`);
            } else {
                alert('No image found for this name');
            }
        } catch (e: any) {
            console.error('Grab Image Error:', e);
            alert(`Error grabbing image: ${e.message || 'Unknown error'}`);
        } finally {
            setIsGrabbingImage(false);
        }
    };

    const handleGenerateDescription = async () => {
        const recipeName = watch('name');
        const items = watch('items') || [];
        const ingredientNames = items.map((i: any) => i.name).filter(Boolean);

        if (!recipeName) {
            alert('Please enter a recipe name first');
            return;
        }

        setIsGeneratingDescription(true);
        try {
            const res = await fetch('/api/recipes/generate-description', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: recipeName, ingredients: ingredientNames })
            });
            const data = await res.json();
            if (data.description) {
                setValue('description', data.description, { shouldDirty: true });
                // Trigger draft save immediately with latest values
                const currentData = { ...formValues.getValues(), description: data.description, selectedCategoryTags };
                localStorage.setItem(draftKey, JSON.stringify(currentData));
            } else if (data.error) {
                alert(`${data.error}${data.details ? `\n\nDetails: ${data.details}` : ''}`);
            }
        } catch (e) {
            console.error(e);
            alert("Error generating description.");
        } finally {
            setIsGeneratingDescription(false);
        }
    };

    const handleGenerateMacros = async () => {
        const recipeName = watch('name');
        const items = watch('items') || [];
        const yieldQty = watch('yield_qty');
        const yieldUnit = watch('yield_unit');

        if (!recipeName) {
            alert('Please enter a recipe name first');
            return;
        }

        setIsGeneratingMacros(true);
        try {
            const res = await fetch('/api/recipes/generate-macros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: recipeName,
                    yield_qty: yieldQty,
                    yield_unit: yieldUnit,
                    items: items
                })
            });
            const data = await res.json();
            if (data.macros) {
                setValue('macros', data.macros, { shouldDirty: true });
                if (data.fullNutrition) {
                    setFullNutritionData(data.fullNutrition);
                    // If we get full data, we automatically switch to full mode to show it off
                    setShowFullNutrition(true);
                    // Store the full JSON in the macros field for persistence
                    const macrosJson = JSON.stringify({ summary: data.macros, fullData: data.fullNutrition });
                    setValue('macros', macrosJson, { shouldDirty: true });
                }

                // Trigger draft save immediately with latest values
                const currentData = { ...formValues.getValues(), macros: data.macros, selectedCategoryTags };
                localStorage.setItem(draftKey, JSON.stringify(currentData));
            } else if (data.error) {
                alert(`${data.error}${data.details ? `\n\nDetails: ${data.details}` : ''}`);
            }
        } catch (e) {
            console.error(e);
            alert("Error generating macros.");
        } finally {
            setIsGeneratingMacros(false);
        }
    };

    const handleUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            setIsUploading(true);
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('/api/recipes/upload-image', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();
            if (data.url) {
                setValue('image_url', data.url);
            } else {
                alert(data.error || 'Failed to upload image');
            }
        } catch (err: any) {
            console.error('Upload Error:', err);
            alert('Error uploading image');
        } finally {
            setIsUploading(false);
        }
    };

    const { fields, append, remove, move } = useFieldArray({
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
                console.error('Failed to save recipe. Status:', res.status, 'Error data:', errData);
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

    // DnD Sensors
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (active.id !== over?.id) {
            const oldIndex = fields.findIndex((f) => f.id === active.id);
            const newIndex = fields.findIndex((f) => f.id === over?.id);
            if (oldIndex !== -1 && newIndex !== -1) {
                move(oldIndex, newIndex);
            }
        }
    };

    // Duplicate as Serves 2 Logic
    const handleDuplicateAsSmall = () => {
        if (!confirm("This will create a NEW recipe with all quantities halved.\n\nAre you sure?")) return;

        const currentData = watch();

        // Deep copy and modify
        const newData = {
            ...currentData,
            id: null, // Ensure it's new
            name: `${currentData.name} (Serves 2)`,
            // Heuristic: If it's a "Family" meal, half usually means 2 servings.
            // If the unit is "Servings", forcing 2 is likely what they want.
            // Otherwise, we divide by 2.
            yield_qty: (currentData.yield_unit?.toLowerCase().includes('serving')) ? 2 : ((Number(currentData.yield_qty) || 0) / 2),
            yield_unit: currentData.yield_unit?.toLowerCase().includes('serving') ? 'Servings' : currentData.yield_unit,

            items: currentData.items.map((item: any) => ({
                ...item,
                qty: (Number(item.qty) || 0) / 2,
                // Also halve batch size if it's a sub-recipe section
                section_batch: item.section_batch ? Number(item.section_batch) / 2 : 1
            }))
        };

        // Save to 'new' draft so the new page picks it up
        localStorage.setItem('recipe_draft_new', JSON.stringify(newData));
        localStorage.setItem('active_recipe_id', 'new');

        // Force navigation to new page
        // Using window.location to ensure a full clean mount if needed, 
        // though router.push should trigger the useEffect.
        // Let's use router.push but give it a moment to save.
        router.push('/recipes/new');

        // alert("Recipe duplicated! Please check the values.");
    };

    return (
        <div className="max-w-5xl mx-auto space-y-8">
            {/* Header / Actions */}
            <div className="flex justify-between items-center bg-white dark:bg-slate-800 bg-adaptive p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm transition-colors print:hidden">
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => {
                            clearDraft();
                            router.back();
                        }}
                        className="flex items-center gap-1 p-2 -ml-2 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors print:hidden"
                    >
                        <ArrowLeft size={20} />
                        <span className="font-bold text-sm">BACK</span>
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
                        onClick={handleDuplicateAsSmall}
                        className="hidden md:flex items-center gap-2 px-4 py-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 rounded-lg font-medium transition-colors border border-indigo-100 dark:border-indigo-800"
                        title="Create Serves 2 Version"
                    >
                        <Wand2 size={18} />
                        Make Serves 2
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
                        <div className="text-right mt-2">
                            <div className={`text-3xl font-black ${liveCostData.isAccurate ? 'text-emerald-600' : 'text-amber-500'}`}>
                                ${liveCostData.costPerUnit.toFixed(2)}
                            </div>
                            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Live Cost Per {watch('yield_unit') || 'Unit'}</div>
                            {!liveCostData.isAccurate && (
                                <div className="text-[10px] font-bold text-amber-600 uppercase tracking-tighter flex items-center justify-end gap-1 mt-1">
                                    <Sparkles size={10} /> Estimate Only
                                </div>
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
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-10 print:hidden">
                    <div className="space-y-2 lg:col-span-1">
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

                    <div className="space-y-2 lg:col-span-1">
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

                    {/* Multi-Level Category Selector */}
                    <div className="space-y-4 lg:col-span-2 bg-slate-50/50 dark:bg-slate-900/40 p-5 rounded-2xl border border-dashed border-indigo-200/50 dark:border-indigo-800/30">
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-sm font-bold text-slate-700 dark:text-slate-300 flex items-center gap-2">
                                <Sparkles size={16} className="text-indigo-500" />
                                Recipe Categories
                            </label>
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Select Multiple</span>
                        </div>

                        <div className="space-y-4">
                            {/* Level 1: Multi-Select Root Dropdown (Primary Theme) */}
                            <div className="space-y-1.5">
                                <span className="text-[10px] font-bold text-slate-500 uppercase">1. Primary Type</span>
                                <div className="grid grid-cols-1 gap-2">
                                    <select
                                        className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none text-sm text-slate-900 dark:text-slate-100 shadow-sm focus:ring-2 focus:ring-indigo-500 transition-all font-medium"
                                        value={selectedRoot}
                                        onChange={e => {
                                            if (e.target.value === 'NEW_ROOT') { handleCreateCategory('root'); return; }
                                            setSelectedRoot(e.target.value);
                                            setSelectedSub('');
                                            setSelectedDeepSub('');
                                        }}
                                    >
                                        <option value="">Select Primary Type...</option>
                                        {categories.filter(c => !c.parent_id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                        <option value="NEW_ROOT" className="font-bold text-indigo-600">+ Add New Category...</option>
                                    </select>
                                </div>
                            </div>

                            {/* Level 2: Sub-Types (Checkbox Grid) */}
                            {selectedRoot && (
                                <div className="bg-white/50 dark:bg-slate-800/50 p-4 rounded-xl border border-slate-200 dark:border-slate-700 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-tight">2. Menu Sub-Types</span>
                                        <button
                                            type="button"
                                            onClick={() => handleCreateCategory('sub')}
                                            className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800 uppercase"
                                        >
                                            + New Sub-Type
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                        {categories.find(c => c.id === selectedRoot)?.children?.map(c => (
                                            <div
                                                key={c.id}
                                                onClick={() => {
                                                    toggleCategoryTag(c);
                                                    setSelectedSub(selectedSub === c.id ? '' : c.id);
                                                    setSelectedDeepSub('');
                                                }}
                                                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer border transition-all select-none ${selectedCategoryTags.some(tag => tag.id === c.id) || selectedSub === c.id
                                                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-md shadow-indigo-200 dark:shadow-none'
                                                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-indigo-300 dark:hover:border-indigo-500'
                                                    }`}
                                            >
                                                <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${selectedCategoryTags.some(tag => tag.id === c.id)
                                                    ? 'bg-white border-white'
                                                    : 'border-slate-300 dark:border-slate-600'
                                                    }`}>
                                                    {selectedCategoryTags.some(tag => tag.id === c.id) && <div className="w-1.5 h-1.5 rounded-full bg-indigo-600" />}
                                                </div>
                                                {c.name}
                                            </div>
                                        ))}
                                    </div>

                                    {/* Level 3: Details (Checkbox Grid if Sub active) */}
                                    {selectedSub && categories.flatMap(c => c.children || []).find(c => c.id === selectedSub)?.children && (
                                        <div className="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-2">
                                            <div className="flex items-center justify-between">
                                                <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-tight">3. Specific Details</span>
                                                <button
                                                    type="button"
                                                    onClick={() => handleCreateCategory('deep')}
                                                    className="text-[10px] font-bold text-emerald-600 hover:text-emerald-800 uppercase"
                                                >
                                                    + New Detail
                                                </button>
                                            </div>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                                {categories.flatMap(c => c.children || []).find(c => c.id === selectedSub)?.children?.map(c => (
                                                    <div
                                                        key={c.id}
                                                        onClick={() => toggleCategoryTag(c)}
                                                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer border transition-all select-none ${selectedCategoryTags.some(tag => tag.id === c.id)
                                                            ? 'bg-emerald-600 border-emerald-600 text-white shadow-md shadow-emerald-200 dark:shadow-none'
                                                            : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-emerald-300 dark:hover:border-emerald-500'
                                                            }`}
                                                    >
                                                        <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${selectedCategoryTags.some(tag => tag.id === c.id)
                                                            ? 'bg-white border-white'
                                                            : 'border-slate-300 dark:border-slate-600'
                                                            }`}>
                                                            {selectedCategoryTags.some(tag => tag.id === c.id) && <div className="w-1.5 h-1.5 rounded-full bg-emerald-600" />}
                                                        </div>
                                                        {c.name}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Selected Tags Summary */}
                        <div className="pt-4 mt-2 border-t border-slate-200 dark:border-slate-700">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold text-slate-500 uppercase">Selected Types</span>
                                <span className="text-[10px] font-bold text-indigo-500 bg-indigo-50 dark:bg-indigo-950 px-2 py-0.5 rounded-full">{selectedCategoryTags.length} Active</span>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {selectedCategoryTags.length === 0 ? (
                                    <div className="text-[10px] italic text-slate-400 py-1">No categories selected - select a primary type above to begin</div>
                                ) : (
                                    selectedCategoryTags.map((tag) => (
                                        <div key={tag.id} className="group flex items-center gap-1.5 pl-2 pr-1.5 py-1 bg-indigo-50 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 rounded-full text-[10px] font-black border border-indigo-200 dark:border-indigo-800 transition-all hover:bg-indigo-100 dark:hover:bg-indigo-900 hover:border-rose-300 dark:hover:border-rose-800 hover:text-rose-600">
                                            {tag.name}
                                            <div
                                                className="w-4 h-4 rounded-full bg-indigo-200/50 dark:bg-indigo-800/50 flex items-center justify-center group-hover:bg-rose-200/50 dark:group-hover:bg-rose-900/50 cursor-pointer"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleRemoveCategoryTag(tag.id);
                                                }}
                                            >
                                                <X size={10} />
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>


                    {/* Row 2 */}
                    {isScaling ? (
                        <div className="space-y-2 bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-xl border border-indigo-100 dark:border-indigo-800 print:hidden overflow-hidden">
                            <label className="text-sm font-bold text-indigo-900 dark:text-indigo-300">Target Batch Size</label>
                            <div className="flex gap-2 print:hidden w-full">
                                <input
                                    key="target-yield-input"
                                    type="number"
                                    value={targetYield ?? ''}
                                    onChange={(e) => setTargetYield(e.target.value)}
                                    placeholder={String(baseQty)}
                                    className="flex-1 w-full min-w-0 px-4 py-2.5 bg-white dark:bg-slate-800 border border-indigo-200 dark:border-indigo-700 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-bold text-indigo-900 dark:text-indigo-300 text-lg placeholder:text-indigo-300 dark:placeholder:text-indigo-700"
                                    autoFocus
                                />
                                <select
                                    key="target-yield-unit-select"
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
                                    {!units.includes(baseUnit) && <option value={baseUnit}>{baseUnit}</option>}
                                </select>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Base Yield</label>
                            <div className="flex gap-2">
                                <input
                                    key="base-yield-input"
                                    {...register('yield_qty')}
                                    type="number"
                                    className="w-24 px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 print:hidden"
                                />
                                <div className="flex-1 relative">
                                    <select
                                        key="base-yield-unit-select"
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

                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Container Type</label>
                        <select
                            {...register('container_type')}
                            disabled={isScaling}
                            className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 text-slate-900 dark:text-slate-100 appearance-none"
                        >
                            <option value="tray">Tray (Oven/Casserole)</option>
                            <option value="bag">Bag (Crockpot/Soup)</option>
                        </select>
                    </div>

                    <div className="space-y-2">
                        <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Cook Time (Public)</label>
                        <input
                            {...register('cook_time')}
                            disabled={isScaling}
                            className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 print:hidden"
                            placeholder="e.g. 4-6 hrs Low"
                        />
                    </div>

                    {/* Row 3 - Large Description & Photo */}
                    <div className="space-y-2 lg:col-span-3">
                        <div className="flex justify-between items-center">
                            <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Description</label>
                            <button
                                type="button"
                                onClick={handleGenerateDescription}
                                disabled={isScaling || isGeneratingDescription}
                                className="text-xs flex items-center gap-1.5 text-purple-600 dark:text-purple-400 hover:text-purple-800 dark:hover:text-purple-300 font-bold bg-purple-50 dark:bg-purple-900/30 px-2 py-1 rounded-md transition-colors disabled:opacity-50 shadow-sm"
                            >
                                {isGeneratingDescription ? <span className="animate-pulse">✨ Generating...</span> : <><Sparkles size={12} /> AI Generate</>}
                            </button>
                        </div>
                        <textarea
                            {...register('description')}
                            disabled={isScaling}
                            rows={4}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 print:hidden resize-none overflow-y-auto"
                            placeholder="A mouth-watering summary..."
                        />
                        <div className="hidden print:block text-sm text-slate-500 italic mt-1">
                            {watch('description')}
                        </div>
                    </div>

                    <div className="space-y-2 lg:col-span-1 relative">
                        <div className="flex justify-between items-center">
                            <label className="text-sm font-semibold text-slate-700 dark:text-slate-300">Recipe Photo</label>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isScaling || isUploading}
                                    className="text-[10px] flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:text-emerald-800 dark:hover:text-emerald-300 font-bold bg-emerald-50 dark:bg-emerald-900/30 px-1.5 py-0.5 rounded transition-colors disabled:opacity-50 border border-emerald-100 dark:border-emerald-800/30"
                                >
                                    {isUploading ? '...' : 'Upload'}
                                </button>
                                <button
                                    type="button"
                                    onClick={handleGrabImage}
                                    disabled={isScaling || isGrabbingImage}
                                    className="text-[10px] flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-bold bg-indigo-50 dark:bg-indigo-900/30 px-1.5 py-0.5 rounded transition-colors disabled:opacity-50 border border-indigo-100 dark:border-indigo-800/30"
                                >
                                    {isGrabbingImage ? '...' : 'Auto-Grab'}
                                </button>
                            </div>
                        </div>
                        <input
                            type="file"
                            ref={fileInputRef}
                            className="hidden"
                            accept="image/*"
                            onChange={handleUploadImage}
                        />
                        <div className="flex flex-col gap-3">
                            <input
                                {...register('image_url')}
                                disabled={isScaling || isGrabbingImage}
                                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-xs disabled:bg-slate-100 dark:disabled:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-500 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 print:hidden"
                                placeholder="Image URL..."
                            />

                            {watch('image_url') && (
                                <div className="w-full h-48 rounded-xl overflow-hidden border-2 border-slate-200 dark:border-slate-700 shadow-lg relative group/img animate-in fade-in zoom-in duration-300">
                                    <img
                                        src={watch('image_url')}
                                        alt="Recipe Preview"
                                        className="w-full h-full object-cover hover:scale-105 transition-transform duration-500"
                                    />
                                    {isGrabbingImage && (
                                        <div className="absolute inset-0 bg-indigo-600/40 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2">
                                            <Sparkles size={24} className="text-white animate-spin-slow" />
                                            <span className="text-[10px] font-bold text-white uppercase tracking-wider">AI Generating...</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
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
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragEnd={handleDragEnd}
                        >
                            {Array.from(new Set(watchedItems.map(i => i.section_name || ''))).map(sectionName => {
                                const sectionFields = fields
                                    .map((f, i) => ({ ...f, originalIndex: i }))
                                    .filter(f => (watchedItems[f.originalIndex]?.section_name || '') === sectionName);

                                if (sectionFields.length === 0) return null;

                                const isBox = sectionName !== '';
                                const batchValue = isBox ? (watchedItems[sectionFields[0].originalIndex]?.section_batch || 1) : 1;

                                return (
                                    <div key={sectionFields[0]?.id || sectionName || 'standard'} className={isBox ? "bg-emerald-50/20 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-800 rounded-xl p-6" : ""}>
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
                                            <SortableContext
                                                items={sectionFields.map(f => f.id)}
                                                strategy={verticalListSortingStrategy}
                                            >
                                                {sectionFields.map(({ originalIndex, id }) => {
                                                    const index = originalIndex;
                                                    // Sub-recipe local batch scaling
                                                    const currentBatch = Number(watchedItems?.[index]?.section_batch) || 1;
                                                    const totalBatchQty = (Number(watchedItems?.[index]?.qty) || 0) * currentBatch;

                                                    return (
                                                        <RecipeIngredientRow
                                                            key={id}
                                                            index={index}
                                                            fieldId={id}
                                                            item={watchedItems[index]}
                                                            register={register}
                                                            setValue={setValue}
                                                            isScaling={isScaling}
                                                            allIngredients={allIngredients}
                                                            units={units}
                                                            multiplier={multiplier}
                                                            remove={remove}
                                                            handleSyncIngredient={handleSyncIngredient}
                                                            handleAddNewUnit={handleAddNewUnit}
                                                            isBox={isBox}
                                                            currentBatch={currentBatch}
                                                            totalBatchQty={totalBatchQty}
                                                        />
                                                    );
                                                })}
                                            </SortableContext>
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
                        </DndContext>
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

                {/* Instructions / Preparation Section */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8 pt-6 border-t border-slate-100 dark:border-slate-700">
                    {/* Kitchen Facing */}
                    <div className="space-y-4">
                        <div className="flex justify-between items-center">
                            <h3 className="text-lg font-bold text-slate-900 text-adaptive">Preparation (Kitchen Only)</h3>
                            <span className="text-[10px] font-bold text-amber-600 bg-amber-50 dark:bg-amber-950 px-2 py-0.5 rounded-full uppercase tracking-tighter">Internal</span>
                        </div>
                        <p className="text-xs text-slate-500 -mt-2">Steps for the kitchen to follow during production. Not shown on labels.</p>

                        <div className={isScaling ? 'hidden' : 'block print:hidden'}>
                            <textarea
                                {...register('instructions')}
                                rows={8}
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-y"
                                placeholder="Enter step-by-step production steps..."
                            />
                        </div>
                        {(isScaling || (typeof window !== 'undefined' && window.matchMedia('print').matches) || true) && (
                            <div className={`prose dark:prose-invert max-w-none text-slate-700 dark:text-slate-300 whitespace-pre-wrap ${!isScaling ? 'hidden print:block' : ''}`}>
                                {watch('instructions') || <span className="italic text-slate-400">No preparation steps provided.</span>}
                            </div>
                        )}
                    </div>

                    {/* Customer Facing */}
                    <div className="space-y-4">
                        <div className="flex justify-between items-center">
                            <h3 className="text-lg font-bold text-slate-900 text-adaptive">Cooking Instructions (Labels)</h3>
                            <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 dark:bg-indigo-950 px-2 py-0.5 rounded-full uppercase tracking-tighter">On Labels</span>
                        </div>
                        <p className="text-xs text-slate-500 -mt-2">Instructions for the customer (e.g. Bake at 375°F for 45 mins). Shown on labels.</p>

                        <div className={isScaling ? 'hidden' : 'block print:hidden'}>
                            <textarea
                                {...register('label_text')}
                                rows={8}
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-y font-bold"
                                placeholder="Enter instructions for the customer label..."
                            />
                        </div>
                        {(isScaling || (typeof window !== 'undefined' && window.matchMedia('print').matches) || true) && (
                            <div className={`prose dark:prose-invert max-w-none text-slate-700 dark:text-slate-300 whitespace-pre-wrap ${!isScaling ? 'hidden print:block' : ''}`}>
                                {watch('label_text') || <span className="italic text-slate-400">No label instructions provided.</span>}
                            </div>
                        )}
                    </div>
                </div>

                {/* Macros Section */}
                <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-700">
                    <div className="flex justify-between items-center mb-4">
                        <div className="flex items-center gap-4">
                            <h3 className="text-lg font-bold text-slate-900 text-adaptive">Nutritional Macros</h3>
                            <button
                                type="button"
                                onClick={() => setShowFullNutrition(!showFullNutrition)}
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tighter transition-colors ${showFullNutrition ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                            >
                                {showFullNutrition ? 'Full Label Mode' : 'Simple Mode'}
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={handleGenerateMacros}
                            disabled={isScaling || isGeneratingMacros}
                            className="text-xs flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 font-bold bg-indigo-50 dark:bg-indigo-900/30 px-2 py-1 rounded-md transition-colors disabled:opacity-50 shadow-sm"
                        >
                            {isGeneratingMacros ? <span className="animate-pulse">✨ Calculating...</span> : <><Sparkles size={12} /> AI Generate</>}
                        </button>
                    </div>

                    {showFullNutrition ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-slate-50 dark:bg-slate-900/50 p-6 rounded-2xl border border-slate-200 dark:border-slate-700">
                            <div>
                                <p className="text-xs text-slate-500 mb-4 italic">Full nutritional data generated by AI. You can edit the summary text below to override what appears on small labels.</p>
                                <textarea
                                    {...register('macros')}
                                    rows={3}
                                    className="w-full px-4 py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-y mb-4"
                                    placeholder="Simple summary for labels..."
                                />
                                <div className="p-4 bg-indigo-50 dark:bg-indigo-900/20 rounded-xl border border-indigo-100 dark:border-indigo-800/50">
                                    <p className="text-[10px] font-bold text-indigo-600 uppercase mb-2">Pro Tip</p>
                                    <p className="text-xs text-indigo-900 dark:text-indigo-300 leading-relaxed">The full label on the right will be used for 4x6 labels and digital menus. The text box above is used for compact 2x6 labels.</p>
                                </div>
                            </div>
                            <div className="flex justify-center">
                                {fullNutritionData ? (
                                    <NutritionFactsLabel data={fullNutritionData} />
                                ) : (
                                    <div className="w-[240px] aspect-[2/3] border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-lg flex items-center justify-center text-slate-400 text-xs text-center p-8">
                                        Click AI Generate to see the full nutrition facts panel
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <>
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
                        </>
                    )}
                </div>
            </div >
        </div >
    );
}
