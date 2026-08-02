
"use client";

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, Search, X, Trash, FileText, Folder, GripVertical, DollarSign, Clock, Users, ArrowRight, Upload, Download, FolderPlus, List, LayoutGrid, MoreHorizontal } from 'lucide-react';
import RecipeImporter from './RecipeImporter';
import { Recipe, Category } from '@/types';
import { DndContext, DragOverlay, DragEndEvent, DragStartEvent, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { DroppableFolder, DraggableRecipe } from './DraggableComponents';
import { ClientOnly } from './ClientOnly';
import { CategoryTree } from './recipes/CategoryTree';
import { RecipeList } from './recipes/RecipeList';
import { RecipeQuickView } from './recipes/RecipeQuickView';
import { printRecipe } from './recipes/printRecipe';

// Helper to find category path
function getPath(categories: Category[], targetId: string): Category[] {
    for (const cat of categories) {
        if (cat.id === targetId) return [cat];
        if (cat.children) {
            const path = getPath(cat.children, targetId);
            if (path.length > 0) return [cat, ...path];
        }
    }
    return [];
}

// All descendant ids of a category, for tree filtering ("Entrées" includes "Chicken"/"Beef")
function collectCategoryIds(categories: Category[], targetId: string): string[] {
    const found = getPath(categories, targetId).pop();
    if (!found) return [targetId];
    const walk = (c: Category): string[] => [c.id, ...(c.children ?? []).flatMap(walk)];
    return walk(found);
}

// Recursive category search for DragOverlay (searches all nested categories)
function findCategoryById(categories: Category[], id: string): Category | null {
    for (const cat of categories) {
        if (cat.id === id) return cat;
        if (cat.children) {
            const found = findCategoryById(cat.children, id);
            if (found) return found;
        }
    }
    return null;
}

interface ScoredRecipe extends Recipe {
    score: number;
    matchReason?: string;
}

export default function RecipeBrowser({ recipes, categories }: { recipes: Recipe[], categories: Category[] }) {
    const router = useRouter();
    const [searchTerm, setSearchTerm] = useState('');
    const [showImporter, setShowImporter] = useState(false);
    const [currentCategoryId, setCurrentCategoryId] = useState<string | null>(null);
    const [isCreatingFolder, setIsCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [activeId, setActiveId] = useState<string | null>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
    const [view, setView] = useState<'list' | 'cards'>('list');
    const [showOverflow, setShowOverflow] = useState(false);
    const overflowRef = useRef<HTMLDivElement>(null);

    // Persist view preference in localStorage
    useEffect(() => {
        const saved = localStorage.getItem('recipeView');
        if (saved === 'cards' || saved === 'list') setView(saved);
    }, []);
    useEffect(() => {
        localStorage.setItem('recipeView', view);
    }, [view]);

    // Close overflow menu on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
                setShowOverflow(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const selectedRecipe = recipes.find(r => r.id === selectedRecipeId) ?? null;

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 8,
            },
        })
    );

    // ── HANDLERS (byte-identical to original) ──────────────────────────────────

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;
        try {
            const res = await fetch('/api/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newFolderName, parent_id: currentCategoryId })
            });
            if (res.ok) {
                setNewFolderName('');
                setIsCreatingFolder(false);
                console.log(`[DnD] Folder created successfully.`);
                router.refresh();
            } else {
                alert('Failed to create folder');
            }
        } catch (e) {
            alert('Error creating folder');
        }
    };

    const handleDeleteFolder = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation(); // Prevent navigation
        if (!confirm('Delete this folder? It must be empty.')) return;

        try {
            const res = await fetch(`/api/categories/${id}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                router.refresh();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to delete folder');
            }
        } catch (e) {
            alert('Error deleting folder');
        }
    };

    const handleDeleteRecipe = async (e: React.MouseEvent, id: string, name: string) => {
        e.preventDefault(); // Prevent Link navigation
        e.stopPropagation();
        if (!confirm(`Are you sure you want to delete "${name}"? This cannot be undone.`)) return;

        try {
            const res = await fetch(`/api/recipes/${id}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                router.refresh();
            } else {
                const data = await res.json();
                alert(data.error || 'Failed to delete recipe');
            }
        } catch (e) {
            alert('Error deleting recipe');
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        setActiveId(event.active.id as string);
        setIsDragging(true);
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event;

        setActiveId(null);
        setIsDragging(false);

        if (!over) return;

        const activeData = active.data.current;
        const overData = over.data.current;

        // Recipe dropped onto category
        if (activeData?.type === 'recipe' && overData?.type === 'category') {
            const recipeId = active.id as string;
            // Parse actual ID from prefixed ID
            const rawOverId = over.id as string;
            const categoryId = rawOverId.replace('folder-drop-', '');

            console.log(`[DnD] Recipe ${recipeId} dropped onto Category ${categoryId}`);

            const recipe = recipes.find(r => r.id === recipeId);
            if (!recipe) {
                console.error(`[DnD] Recipe ${recipeId} not found in current list!`);
                return;
            }

            console.log(`[DnD] Recipe categories at drop:`, JSON.stringify(recipe.categories, null, 2));

            // NEW Logic: If we are in a folder view, REPLACE that folder with the target
            // This turns "Add Category" into "Move to Category"
            let newCategoryIds: string[] = [];
            if (currentCategoryId) {
                const otherCategories = (recipe.categories || []).filter(c => c.id !== currentCategoryId).map(c => c.id);
                newCategoryIds = [...new Set([...otherCategories, categoryId])];
            } else {
                const currentIds = (recipe.categories || []).map(c => c.id);
                newCategoryIds = [...new Set([...currentIds, categoryId])];
            }

            console.log(`[DnD] Submitting new category IDs:`, newCategoryIds);

            try {
                const res = await fetch(`/api/recipes/${recipeId}/categories`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ categoryIds: newCategoryIds })
                });

                if (res.ok) {
                    console.log(`[DnD] Recipe updated successfully.`);
                    router.refresh();
                } else {
                    const data = await res.json();
                    console.error('Failed to update categories:', data.error);
                    alert(`Failed to update categories: ${data.error || 'Unknown error'}`);
                }
            } catch (error: any) {
                console.error('Failed to update categories:', error);
                alert(`Error updating categories: ${error.message}`);
            }
        }

        // Category dropped onto category
        if (activeData?.type === 'category' && overData?.type === 'category') {
            const movingCategoryId = active.id as string;
            const targetCategoryId = over.id as string;

            if (movingCategoryId === targetCategoryId) return;

            try {
                const res = await fetch(`/api/categories/${movingCategoryId}/parent`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parentId: targetCategoryId })
                });

                if (res.ok) {
                    console.log(`[DnD] Category moved successfully.`);
                    router.refresh();
                } else {
                    const data = await res.json();
                    alert(data.error || 'Failed to move category');
                }
            } catch (e) {
                alert('Error moving category');
            }
        }

        // Recipe dropped onto root (uncategorize)
        if (activeData?.type === 'recipe' && over.id === 'root-uncategorized') {
            const recipeId = active.id as string;

            try {
                const res = await fetch(`/api/recipes/${recipeId}/categories`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ categoryIds: [] }) // Remove from all categories
                });

                if (res.ok) {
                    console.log(`[DnD] Recipe uncategorized successfully.`);
                    router.refresh();
                } else {
                    alert('Failed to uncategorize recipe');
                }
            } catch (e) {
                alert('Error uncategorizing recipe');
            }
        }
    };

    // ── PRINT HANDLER (UI-only, no API) ───────────────────────────────────────
    const handlePrintRecipe = (recipe: any) => printRecipe(recipe);

    // ── SEARCH SCORING BLOCK (unchanged) ───────────────────────────────────────

    const isSearching = searchTerm.trim().length > 0;

    let displayFolders: Category[] = [];
    let displayRecipes: ScoredRecipe[] = [];

    if (isSearching) {
        const lowerSearch = searchTerm.toLowerCase();

        displayRecipes = recipes
            .map(r => {
                let score = 0;
                let matchReason = undefined;

                // Priority 1: Exact Name Start (100) or Includes (50)
                if (r.name.toLowerCase().startsWith(lowerSearch)) {
                    score = 100;
                } else if (r.name.toLowerCase().includes(lowerSearch)) {
                    score = 50;
                }

                // Priority 2: Ingredient Match (20)
                if (score < 50 && (r as any).child_items) {
                    const matchedItem = (r as any).child_items.find((item: any) =>
                        item.child_recipe?.name?.toLowerCase().includes(lowerSearch) ||
                        item.child_ingredient?.name?.toLowerCase().includes(lowerSearch)
                    );

                    if (matchedItem) {
                        score = 20;
                        const matchName = matchedItem.child_recipe?.name || matchedItem.child_ingredient?.name;
                        matchReason = `Contains: ${matchName}`;
                    }
                }

                return { ...r, score, matchReason };
            })
            .filter(r => r.score > 0)
            .sort((a, b) => b.score - a.score); // Highest score first

    } else {
        // Recursive function to get all descendant category IDs
        const getAllChildCategoryIds = (catId: string): string[] => {
            const findNode = (nodes: Category[]): Category | null => {
                for (const node of nodes) {
                    if (node.id === catId) return node;
                    if (node.children) {
                        const found = findNode(node.children);
                        if (found) return found;
                    }
                }
                return null;
            };
            const node = findNode(categories);
            if (!node) return [catId];

            const ids: string[] = [node.id];
            const collect = (cats: Category[]) => {
                for (const c of cats) {
                    ids.push(c.id);
                    if (c.children) collect(c.children);
                }
            };
            if (node.children) collect(node.children);
            return ids;
        };

        const targetCategoryIds = currentCategoryId ? getAllChildCategoryIds(currentCategoryId) : [];

        // Determine what folders to show
        if (!currentCategoryId) {
            // Root - show only uncategorized recipes
            displayFolders = categories.filter(c => !c.parent_id);
            displayRecipes = recipes.filter(r => !r.categories || r.categories.length === 0) as ScoredRecipe[];
        } else {
            // Inside Category
            // Find current node for folders list
            const findNode = (nodes: Category[]): Category | null => {
                for (const node of nodes) {
                    if (node.id === currentCategoryId) return node;
                    if (node.children) {
                        const found = findNode(node.children);
                        if (found) return found;
                    }
                }
                return null;
            };
            const activeNode = findNode(categories);

            displayFolders = activeNode?.children || [];

            // Filter by Category (Direct Match only to ensure "Move" results in removal from current list)
            displayRecipes = recipes.filter(r => {
                const recipeCatIds = [
                    ...(r.categories?.map(c => c.id) || []),
                    ...(r.category_id ? [r.category_id] : [])
                ];
                return recipeCatIds.includes(currentCategoryId);
            }) as ScoredRecipe[];
        }
    }

    // ── VISIBLE RECIPES (new: applies tree filter for list/card views) ──────────

    let visibleRecipes: ScoredRecipe[];
    if (isSearching) {
        visibleRecipes = [...displayRecipes]; // already scored and sorted
    } else {
        visibleRecipes = ([...recipes].sort((a, b) => a.name.localeCompare(b.name)) as ScoredRecipe[]);
    }
    if (currentCategoryId === 'uncategorized') {
        visibleRecipes = visibleRecipes.filter(r => !r.categories || r.categories.length === 0);
    } else if (currentCategoryId) {
        const ids = new Set(collectCategoryIds(categories, currentCategoryId));
        visibleRecipes = visibleRecipes.filter(r => (r.categories ?? []).some(c => ids.has(c.id)));
    }

    // Find active item for drag overlay (search all categories, not just displayed ones)
    const activeItem = activeId ? (recipes.find(r => r.id === activeId) || findCategoryById(categories, activeId)) : null;

    return (
        <>
            <ClientOnly>
                <DndContext
                    sensors={sensors}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    collisionDetection={closestCenter}
                >
                    <div className="space-y-4">
                        {/* ── Toolbar ── */}
                        <div className="flex flex-wrap items-center gap-3">
                            <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Recipes</h2>
                            <div className="relative flex-1 min-w-[180px] max-w-sm">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                                <input
                                    placeholder="Search recipes…"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full pl-9 pr-4 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-indigo-500/40 transition"
                                />
                            </div>
                            {/* List / Cards toggle */}
                            <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                                <button
                                    onClick={() => setView('list')}
                                    className={`px-3 py-2 text-sm font-bold transition ${view === 'list' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-500 hover:text-indigo-600'}`}
                                    title="List view"
                                >
                                    <List size={16} />
                                </button>
                                <button
                                    onClick={() => { setView('cards'); setSelectedRecipeId(null); }}
                                    className={`px-3 py-2 text-sm font-bold transition ${view === 'cards' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-500 hover:text-indigo-600'}`}
                                    title="Card view"
                                >
                                    <LayoutGrid size={16} />
                                </button>
                            </div>
                            <Link
                                href="/recipes/new"
                                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-lg text-sm font-bold flex items-center gap-1.5 shadow-sm transition"
                            >
                                <Plus size={16} strokeWidth={3} />
                                <span className="hidden sm:inline">New Recipe</span>
                            </Link>
                            {/* ⋯ overflow menu: Import CSV, Download Backup, New Folder */}
                            <div className="relative" ref={overflowRef}>
                                <button
                                    onClick={() => setShowOverflow(!showOverflow)}
                                    className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 hover:text-indigo-600 transition"
                                    title="More actions"
                                >
                                    <MoreHorizontal size={16} />
                                </button>
                                {showOverflow && (
                                    <div className="absolute right-0 mt-1 w-48 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl z-50 py-1 animate-in fade-in zoom-in-95 duration-150">
                                        <button
                                            onClick={() => { setShowImporter(true); setShowOverflow(false); }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                                        >
                                            <Upload size={14} /> Import CSV
                                        </button>
                                        <button
                                            onClick={() => { window.location.href = '/api/recipes/backup'; setShowOverflow(false); }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                                        >
                                            <Download size={14} /> Download Backup
                                        </button>
                                        <button
                                            onClick={() => { setIsCreatingFolder(true); setShowOverflow(false); }}
                                            className="flex w-full items-center gap-2 px-3 py-2 text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                                        >
                                            <FolderPlus size={14} /> New Folder
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>

                        {showImporter && <RecipeImporter onClose={() => setShowImporter(false)} />}

                        {/* ── Mobile category chips (< lg) ── */}
                        <div className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
                            <button
                                onClick={() => setCurrentCategoryId(null)}
                                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold transition ${!currentCategoryId ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'}`}
                            >
                                All
                            </button>
                            {categories.filter(c => !c.parent_id).map(cat => (
                                <button
                                    key={cat.id}
                                    onClick={() => setCurrentCategoryId(cat.id)}
                                    className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold transition ${currentCategoryId === cat.id ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'}`}
                                >
                                    {cat.name}
                                </button>
                            ))}
                            <button
                                onClick={() => setCurrentCategoryId('uncategorized')}
                                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold transition ${currentCategoryId === 'uncategorized' ? 'bg-indigo-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700'}`}
                            >
                                Uncategorized
                            </button>
                        </div>

                        {/* ── Three-pane layout ── */}
                        <div className={`grid gap-4 ${view === 'list' ? 'lg:grid-cols-[220px_1fr_380px] lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto lg:overflow-x-hidden' : 'lg:grid-cols-[220px_1fr]'}`}>
                            {/* Left: Category tree (desktop only) */}
                            <div className="hidden lg:block">
                                <CategoryTree
                                    categories={categories}
                                    activeId={currentCategoryId}
                                    totalCount={recipes.length}
                                    uncategorizedCount={recipes.filter(r => !r.categories?.length).length}
                                    onSelect={setCurrentCategoryId}
                                    onNewFolder={() => setIsCreatingFolder(true)}
                                />
                            </div>

                            {/* Middle: List or Cards */}
                            {view === 'list' ? (
                                <RecipeList
                                    recipes={visibleRecipes}
                                    selectedId={selectedRecipeId}
                                    onSelect={setSelectedRecipeId}
                                    onPrint={handlePrintRecipe}
                                />
                            ) : (
                                <div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-4">
                                        {visibleRecipes.map((recipe) => (
                                            <DraggableRecipe key={recipe.id} id={recipe.id}>
                                                {({ attributes, listeners }) => (
                                                    <Link
                                                        href={`/recipes/${recipe.id}`}
                                                        className="glass-panel p-6 rounded-3xl hover:scale-[1.02] hover:shadow-xl transition-all duration-300 group border border-white/40 dark:border-slate-700/50 flex flex-col relative overflow-hidden bg-white dark:bg-slate-800/40 bg-adaptive"
                                                    >
                                                        <div {...attributes} {...listeners} className="absolute top-2 left-2 p-2 text-slate-300 group-hover:text-indigo-500 transition-colors z-30 cursor-move">
                                                            <GripVertical size={20} />
                                                        </div>
                                                        <button
                                                            onClick={(e) => handleDeleteRecipe(e, recipe.id, recipe.name)}
                                                            className="absolute top-2 right-2 p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-full transition-all z-30 opacity-0 group-hover:opacity-100"
                                                            title="Delete Recipe"
                                                        >
                                                            <Trash size={18} />
                                                        </button>
                                                        {/* Photo Placeholder/Preview */}
                                                        <div className="h-40 -mx-6 -mt-6 mb-4 relative overflow-hidden bg-slate-100 dark:bg-slate-700">
                                                            {recipe.image_url ? (
                                                                <img
                                                                    src={recipe.image_url}
                                                                    alt={recipe.name}
                                                                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                                                                />
                                                            ) : (
                                                                <div className="w-full h-full flex items-center justify-center opacity-20">
                                                                    <FileText size={48} className="text-indigo-900 dark:text-indigo-400" />
                                                                </div>
                                                            )}
                                                            <div className="absolute inset-0 bg-linear-to-t from-black/40 to-transparent" />
                                                        </div>

                                                        <div className="flex justify-between items-start mb-4 relative z-10">
                                                            <span className={`inline-flex px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider ${recipe.type === 'prep'
                                                                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                                                                : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400'
                                                                }`}>
                                                                {recipe.type === 'prep' ? 'Prep Profile' : 'Menu Item'}
                                                            </span>
                                                            {(recipe as any).calculated_cost != null && (
                                                                <span className="inline-flex px-3 py-1 rounded-full text-xs font-black bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                                                                    ${Number((recipe as any).calculated_cost).toFixed(2)}
                                                                </span>
                                                            )}
                                                        </div>

                                                        <h3 className="text-2xl font-black text-indigo-600 dark:text-indigo-300 text-adaptive mb-2 line-clamp-2 relative z-10 group-hover:text-indigo-700 dark:group-hover:text-white transition-colors">
                                                            {recipe.name}
                                                        </h3>

                                                        {/* Search Match Highlight */}
                                                        {(recipe as ScoredRecipe).matchReason && (
                                                            <div className="mb-3 px-3 py-1 bg-indigo-50 dark:bg-indigo-900/40 rounded-lg inline-block w-full">
                                                                <p className="text-xs font-bold text-indigo-500 dark:text-indigo-300 truncate">
                                                                    {(recipe as ScoredRecipe).matchReason}
                                                                </p>
                                                            </div>
                                                        )}

                                                        <div className="mt-auto space-y-4 relative z-10">
                                                            <div className="flex items-center gap-6 text-sm font-bold text-slate-500 dark:text-slate-400 text-adaptive-subtle">
                                                                <div className="flex items-center gap-2">
                                                                    <Users size={16} className="text-slate-400 dark:text-slate-600" />
                                                                    <span>{Number(recipe.base_yield_qty)} {recipe.base_yield_unit}</span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    <Clock size={16} className="text-slate-400 dark:text-slate-600" />
                                                                    <span>Ingredients</span>
                                                                </div>
                                                            </div>
                                                            {(recipe as any).calculated_cost != null && Number(recipe.base_yield_qty) > 0 && (
                                                                <div className="flex items-center gap-2 text-sm font-bold text-emerald-600 dark:text-emerald-400">
                                                                    <DollarSign size={16} className="text-emerald-500 dark:text-emerald-500" />
                                                                    <span>
                                                                        ${(Number((recipe as any).calculated_cost) / Number(recipe.base_yield_qty)).toFixed(2)} / {recipe.base_yield_unit}
                                                                    </span>
                                                                </div>
                                                            )}

                                                            <div className="w-full h-px bg-slate-100 dark:bg-slate-700/50" />

                                                            <div className="flex items-center text-indigo-600 dark:text-indigo-400 font-bold text-sm group-hover:translate-x-2 transition-transform">
                                                                View Details <ArrowRight size={16} className="ml-1" strokeWidth={3} />
                                                            </div>
                                                        </div>
                                                    </Link>
                                                )}
                                            </DraggableRecipe>
                                        ))}
                                    </div>
                                    {visibleRecipes.length === 0 && (
                                        <div className="text-center py-20 bg-slate-50 dark:bg-slate-900/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-700">
                                            <p className="text-slate-400 dark:text-slate-600 text-lg font-bold">
                                                {isSearching ? `No recipes found matching "${searchTerm}"` : 'No recipes in this category.'}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Right: Quick view panel (list view + desktop only) */}
                            {view === 'list' && (
                                <div className="hidden lg:block self-start sticky top-0">
                                    <RecipeQuickView
                                        recipe={selectedRecipe}
                                        onClose={() => setSelectedRecipeId(null)}
                                        onPrint={handlePrintRecipe}
                                    />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* DragOverlay — unchanged */}
                    <DragOverlay dropAnimation={null}>
                        {activeId ? (
                            <div className="opacity-80 scale-105 shadow-2xl pointer-events-none">
                                {activeItem && (
                                    <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border-2 border-indigo-500 flex items-center gap-4 w-[350px]">
                                        {'children' in activeItem ? (
                                            <div className="p-4 bg-indigo-100 dark:bg-indigo-900/50 rounded-2xl text-indigo-500">
                                                <Folder size={32} />
                                            </div>
                                        ) : (
                                            <div className="p-4 bg-indigo-50 dark:bg-indigo-900/30 rounded-2xl text-indigo-500">
                                                <FileText size={32} />
                                            </div>
                                        )}
                                        <div>
                                            <h3 className="text-xl font-black text-indigo-900 dark:text-indigo-100 truncate">
                                                {(activeItem as any).name}
                                            </h3>
                                            <p className="text-sm text-indigo-400 font-bold uppercase">
                                                {'children' in activeItem ? 'Folder' : 'Recipe'}
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </DragOverlay>

                    {/* Fixed Uncategorize Drop Zone */}
                    {isDragging && (
                        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4 animate-in slide-in-from-bottom-10 fade-in duration-300">
                            <DroppableFolder id="root-uncategorized">
                                <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl border-4 border-dashed border-rose-500/50 p-8 rounded-[2.5rem] flex items-center justify-center gap-6 text-center shadow-2xl hover:border-rose-500 hover:scale-105 transition-all">
                                    <div className="p-4 bg-rose-50 dark:bg-rose-900/30 rounded-2xl text-rose-500 shadow-sm">
                                        <X size={40} strokeWidth={3} />
                                    </div>
                                    <div className="text-left">
                                        <h3 className="text-2xl font-black text-slate-900 dark:text-white leading-tight">Drop to Uncategorize</h3>
                                        <p className="text-slate-500 dark:text-slate-400 font-bold">Move back to Main List</p>
                                    </div>
                                </div>
                            </DroppableFolder>
                        </div>
                    )}
                </DndContext>
            </ClientOnly>

            {/* New Folder Modal — unchanged */}
            {isCreatingFolder && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md p-6 animate-in fade-in zoom-in duration-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-xl font-bold text-slate-900 dark:text-white">Create New Folder</h3>
                            <button onClick={() => setIsCreatingFolder(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                                <X size={24} />
                            </button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Folder Name</label>
                                <input
                                    autoFocus
                                    value={newFolderName}
                                    onChange={e => setNewFolderName(e.target.value)}
                                    placeholder="e.g. Seasonal Menu"
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                                    onKeyDown={e => e.key === 'Enter' && handleCreateFolder()}
                                />
                            </div>
                            <div className="flex justify-end gap-3 pt-2">
                                <button
                                    onClick={() => setIsCreatingFolder(false)}
                                    className="px-4 py-2 text-slate-600 dark:text-slate-400 font-bold hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleCreateFolder}
                                    disabled={!newFolderName.trim()}
                                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-xl font-bold shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Create Folder
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Mobile slide-over for quick view (list view only) */}
            {view === 'list' && selectedRecipeId && selectedRecipe && (
                <div className="fixed inset-0 z-40 lg:hidden">
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSelectedRecipeId(null)} />
                    <div className="absolute inset-y-0 right-0 w-full max-w-md shadow-2xl overflow-y-auto bg-white dark:bg-slate-900 animate-in slide-in-from-right duration-200">
                        <RecipeQuickView recipe={selectedRecipe} onClose={() => setSelectedRecipeId(null)} />
                    </div>
                </div>
            )}
        </>
    );
}
