
"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, Search, BookOpen, Clock, Users, ArrowRight, Upload, Folder, ChevronRight, ArrowLeft, FolderPlus, X, Trash, FileText, Download, DollarSign, GripVertical } from 'lucide-react';
import RecipeImporter from './RecipeImporter';
import { Recipe, Category } from '@/types';
import { DndContext, DragOverlay, DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { DroppableFolder, DraggableHandle, DraggableRecipe } from './DraggableComponents';
import { ClientOnly } from './ClientOnly';

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

// Helper to calculate recipe cost
function calculateRecipeCost(recipe: Recipe): number {
    // If server provided a pre-calculated recursive cost, use it!
    if ((recipe as any).calculated_cost !== undefined) {
        return (recipe as any).calculated_cost;
    }

    if (!(recipe as any).child_items) return 0;

    return (recipe as any).child_items.reduce((sum: number, item: any) => {
        const cost = item.child_ingredient?.cost_per_unit || 0;
        const quantity = item.quantity || 0;
        return sum + (cost * quantity);
    }, 0);
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
            const categoryId = over.id as string;

            const recipe = recipes.find(r => r.id === recipeId);
            if (!recipe) return;

            // Get current category IDs and add new one
            const currentCategoryIds = recipe.categories?.map(c => c.id) || [];
            if (currentCategoryIds.includes(categoryId)) return;

            const newCategoryIds = [...currentCategoryIds, categoryId];

            try {
                const res = await fetch(`/api/recipes/${recipeId}/categories`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ categoryIds: newCategoryIds })
                });

                if (res.ok) {
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
                    router.refresh();
                } else {
                    alert('Failed to uncategorize recipe');
                }
            } catch (e) {
                alert('Error uncategorizing recipe');
            }
        }
    };

    // Filter Logic
    // If Searching -> Show ALL matching recipes (flatten folders)
    // If Browsing -> Show Folders + Recipes in current view

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
        // Find Current Category Object
        const currentCategory = currentCategoryId
            ? categories.flatMap(c => [c, ...(c.children || []).flatMap(d => [d, ...(d.children || [])])]).find(c => c.id === currentCategoryId)
            : null;

        // Determine what folders to show
        if (!currentCategoryId) {
            // Root - show only uncategorized recipes
            displayFolders = categories.filter(c => !c.parent_id);
            displayRecipes = recipes.filter(r => !r.categories || r.categories.length === 0) as ScoredRecipe[];
        } else {
            // Inside Category
            // Re-find in tree to ensure we have children populated
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

            // Filter by Category (Support M-N and Legacy 1-N)
            displayRecipes = recipes.filter(r =>
                (r.categories && r.categories.some(c => c.id === currentCategoryId)) ||
                r.category_id === currentCategoryId
            ) as ScoredRecipe[];
        }
    }

    const breadcrumbs = currentCategoryId ? getPath(categories, currentCategoryId) : [];

    // Find active item for drag overlay
    const activeItem = activeId ? (recipes.find(r => r.id === activeId) || displayFolders.find(f => f.id === activeId)) : null;

    return (
        <>
            <ClientOnly>
                <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                    <div className="space-y-8">
                        {/* Header */}
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
                            <div>
                                <h2 className="text-4xl font-black text-indigo-900 dark:text-white text-adaptive tracking-tight">Recipe Manager</h2>
                                <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-2 text-lg">
                                    Manage culinary standards and yields.
                                </p>
                                <div className="mt-3">
                                    <span className="bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300 px-3 py-1 rounded-full text-base font-bold">
                                        Total Recipes: {recipes.length}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center gap-4 w-full md:w-auto">
                                <div className="relative group flex-1 md:w-80">
                                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 group-focus-within:text-indigo-500 transition-colors" size={20} strokeWidth={2.5} />
                                    <input
                                        placeholder="Search recipes..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="w-full pl-12 pr-6 py-4 bg-white dark:bg-slate-800 bg-adaptive border-none rounded-2xl outline-none font-bold text-slate-700 dark:text-gray-100 text-adaptive placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:ring-2 focus:ring-indigo-500/50 shadow-sm transition-all"
                                    />
                                </div>
                                <button
                                    onClick={() => window.location.href = '/api/recipes/backup'}
                                    className="bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 px-6 py-4 rounded-2xl font-bold flex items-center gap-2 shadow-sm hover:scale-105 transition-all active:scale-95"
                                >
                                    <Download size={20} strokeWidth={2.5} />
                                    <span className="hidden sm:inline">Backup</span>
                                </button>
                                <button
                                    onClick={() => setShowImporter(true)}
                                    className="bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 px-6 py-4 rounded-2xl font-bold flex items-center gap-2 shadow-sm hover:scale-105 transition-all active:scale-95"
                                >
                                    <Upload size={20} strokeWidth={2.5} />
                                    <span className="hidden sm:inline">Import</span>
                                </button>
                                <button
                                    onClick={() => setIsCreatingFolder(true)}
                                    className="bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 px-6 py-4 rounded-2xl font-bold flex items-center gap-2 shadow-sm hover:scale-105 transition-all active:scale-95"
                                >
                                    <FolderPlus size={20} strokeWidth={2.5} />
                                    <span className="hidden sm:inline">New Folder</span>
                                </button>
                                <Link
                                    href="/recipes/new"
                                    className="bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-600 text-white px-6 py-4 rounded-2xl font-bold flex items-center gap-2 shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/40 hover:scale-105 transition-all active:scale-95"
                                >
                                    <Plus size={20} strokeWidth={3} />
                                    <span className="hidden sm:inline">New Recipe</span>
                                </Link>
                            </div>
                        </div>

                        {showImporter && <RecipeImporter onClose={() => setShowImporter(false)} />}

                        {/* Breadcrumbs */}
                        {!isSearching && (
                            <div className="flex items-center gap-2 text-sm font-bold text-slate-500 dark:text-slate-400 overflow-x-auto pb-2">
                                <button
                                    onClick={() => setCurrentCategoryId(null)}
                                    className={`hover:text-indigo-600 dark:hover:text-white transition-colors flex items-center gap-1 ${!currentCategoryId ? 'text-indigo-600 dark:text-white' : ''}`}
                                >
                                    {!!currentCategoryId && <ArrowLeft size={14} />}
                                    Home
                                </button>
                                {breadcrumbs.map((crumb, i) => (
                                    <div key={crumb.id} className="flex items-center gap-2 whitespace-nowrap">
                                        <ChevronRight size={14} />
                                        <button
                                            onClick={() => setCurrentCategoryId(crumb.id)}
                                            className={`hover:text-indigo-600 dark:hover:text-white transition-colors ${i === breadcrumbs.length - 1 ? 'text-indigo-600 dark:text-white' : ''}`}
                                        >
                                            {crumb.name}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Uncategorized Drop Zone - only show when dragging */}
                        {isDragging && (
                            <DroppableFolder id="root-uncategorized">
                                <div className="p-6 border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-3xl bg-slate-50 dark:bg-slate-800/50 text-center">
                                    <p className="text-slate-500 dark:text-slate-400 font-bold">
                                        Drop here to remove from all categories
                                    </p>
                                </div>
                            </DroppableFolder>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                            {/* Folders */}
                            {!isSearching && displayFolders.map(folder => (
                                <DroppableFolder key={folder.id} id={folder.id}>
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => setCurrentCategoryId(folder.id)}
                                        onKeyDown={(e) => e.key === 'Enter' && setCurrentCategoryId(folder.id)}
                                        className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800 p-6 rounded-3xl hover:scale-[1.02] hover:shadow-lg transition-all duration-300 group flex items-center gap-4 text-left cursor-pointer"
                                    >
                                        <DraggableHandle id={folder.id} type="category">
                                            <div className="p-2 text-slate-400 group-hover:text-indigo-600 transition-colors">
                                                <GripVertical size={20} />
                                            </div>
                                        </DraggableHandle>
                                        <div className="p-4 bg-white dark:bg-indigo-900/50 rounded-2xl shadow-sm group-hover:bg-indigo-600 group-hover:text-white transition-colors text-indigo-500">
                                            <Folder size={32} strokeWidth={2} />
                                        </div>
                                        <div>
                                            <h3 className="text-xl font-black text-indigo-900 dark:text-indigo-100 group-hover:text-indigo-700 dark:group-hover:text-white transition-colors">
                                                {folder.name}
                                            </h3>
                                            <p className="text-sm text-indigo-400 dark:text-indigo-300 font-bold group-hover:text-indigo-500 dark:group-hover:text-indigo-200">
                                                {folder.children && folder.children.length > 0
                                                    ? `${folder.children.length} Sub-folders`
                                                    : `${(folder as any)._count?.recipes || 0} Recipes`
                                                }
                                            </p>
                                        </div>
                                        <div className="ml-auto flex items-center gap-2">
                                            <button
                                                onClick={(e) => handleDeleteFolder(e, folder.id)}
                                                className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                                                title="Delete Folder"
                                            >
                                                <Trash size={18} />
                                            </button>
                                            <ChevronRight size={24} strokeWidth={3} className="text-indigo-400" />
                                        </div>
                                    </div>
                                </DroppableFolder>
                            ))}

                            {/* Recipes */}
                            {displayRecipes.map((recipe) => (
                                <DraggableRecipe key={recipe.id} id={recipe.id}>
                                    {({ ref, attributes, listeners }) => (
                                        <Link
                                            href={`/recipes/${recipe.id}`}
                                            className="glass-panel p-6 rounded-3xl hover:scale-[1.02] hover:shadow-xl transition-all duration-300 group border border-white/40 dark:border-slate-700/50 flex flex-col relative overflow-hidden bg-white dark:bg-slate-800/40 bg-adaptive"
                                        >
                                            <div ref={ref} {...attributes} {...listeners} className="absolute top-2 left-2 p-2 text-slate-300 group-hover:text-indigo-500 transition-colors z-10 cursor-move">
                                                <GripVertical size={20} />
                                            </div>
                                            <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 group-hover:scale-110 transition-all">
                                                <FileText size={120} className="text-indigo-900 dark:text-indigo-400" />
                                            </div>

                                            <div className="flex justify-between items-start mb-4 relative z-10">
                                                <span className={`inline-flex px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider ${recipe.type === 'prep'
                                                    ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                                                    : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400'
                                                    }`}>
                                                    {recipe.type === 'prep' ? 'Prep Profile' : 'Menu Item'}
                                                </span>
                                                <span className="inline-flex px-3 py-1 rounded-full text-xs font-black bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                                                    ${calculateRecipeCost(recipe).toFixed(2)}
                                                </span>
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
                                                <div className="flex items-center gap-2 text-sm font-bold text-emerald-600 dark:text-emerald-400">
                                                    <DollarSign size={16} className="text-emerald-500 dark:text-emerald-500" />
                                                    <span>
                                                        ${(calculateRecipeCost(recipe) / Number(recipe.base_yield_qty)).toFixed(2)} / {recipe.base_yield_unit}
                                                    </span>
                                                </div>

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

                        {!isSearching && displayFolders.length === 0 && displayRecipes.length === 0 && (
                            <div className="text-center py-20 bg-slate-50 dark:bg-slate-900/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-700">
                                <p className="text-slate-400 dark:text-slate-600 text-lg font-bold">This folder is empty.</p>
                            </div>
                        )}
                        {isSearching && displayRecipes.length === 0 && (
                            <div className="text-center py-20">
                                <p className="text-slate-400 dark:text-slate-600 text-lg font-bold">No recipes found matching "{searchTerm}"</p>
                            </div>
                        )}


                        {/* New Folder Modal */}
                        {
                            isCreatingFolder && (
                                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
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
                            )
                        }
                    </div>
                </DndContext>
            </ClientOnly>

        </>
    );
}
