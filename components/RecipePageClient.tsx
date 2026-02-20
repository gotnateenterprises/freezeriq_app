
'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import RecipeBrowser from '@/components/RecipeBrowser';
import RecipeGeneratorModal from '@/components/RecipeGeneratorModal';

export default function RecipePageClient({ initialRecipes, categories }: { initialRecipes: any[], categories: any[] }) {
    const [isGeneratorOpen, setIsGeneratorOpen] = useState(false);
    const [isGenerating, setIsGenerating] = useState(false);
    const [batchProgress, setBatchProgress] = useState(0);

    const handleBatchAutoGrab = async () => {
        const recipes = initialRecipes;
        if (recipes.length === 0) {
            alert('No recipes found to process.');
            return;
        }

        if (!confirm(`This will automatically find fresh photos for ALL ${recipes.length} recipes, overwriting any current photos. Continue?`)) return;

        setIsGenerating(true);
        let count = 0;

        for (const recipe of recipes) {
            try {
                // 1. Grab Image
                const grabRes = await fetch('/api/recipes/grab-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: recipe.name })
                });
                const grabData = await grabRes.json();

                if (grabData.url) {
                    // 2. Save Image URL to Recipe
                    await fetch(`/api/recipes/${recipe.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            ...recipe,
                            image_url: grabData.url
                        })
                    });
                }
            } catch (e) {
                console.error(`Failed to grab image for ${recipe.name}`, e);
            }
            count++;
            setBatchProgress(Math.round((count / recipes.length) * 100));
        }

        setIsGenerating(false);
        alert(`Successfully processed ${count} recipes!`);
        window.location.reload();
    };

    const handleSaveGeneratedRecipe = async (aiRecipe: any) => {
        try {
            const res = await fetch('/api/recipes/ai-save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipe: aiRecipe })
            });
            const data = await res.json();

            if (data.error) throw new Error(data.error);

            alert(`Recipe "${aiRecipe.name}" saved successfully!`);
            setIsGeneratorOpen(false);
            window.location.reload(); // Quick refresh to show new recipe in list
        } catch (e: any) {
            alert(`Error saving recipe: ${e.message}`);
        }
    };

    return (
        <div className="max-w-7xl mx-auto pb-20 p-8">
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-bold">Recipes</h1>
                <div className="flex gap-4">
                    {isGenerating && (
                        <div className="flex items-center gap-3 bg-indigo-50 dark:bg-indigo-950/50 px-4 py-2 rounded-xl border border-indigo-100 dark:border-indigo-800">
                            <span className="text-sm font-bold text-indigo-600 animate-pulse">Grabbing Photos: {batchProgress}%</span>
                            <div className="w-24 h-2 bg-indigo-200 dark:bg-indigo-800 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-indigo-600 transition-all duration-300"
                                    style={{ width: `${batchProgress}%` }}
                                />
                            </div>
                        </div>
                    )}

                    <button
                        onClick={handleBatchAutoGrab}
                        disabled={isGenerating}
                        className="px-4 py-2 bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-bold border border-indigo-100 dark:border-slate-700 rounded-lg shadow-sm hover:translate-y-[-2px] transition-all flex items-center gap-2 disabled:opacity-50"
                    >
                        <span className="text-lg">✨</span> Auto-Grab Photos
                    </button>

                    <button
                        onClick={() => setIsGeneratorOpen(true)}
                        className="px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-medium rounded-lg shadow-md hover:translate-y-[-2px] transition-all flex items-center gap-2"
                    >
                        <span className="text-lg">✨</span> AI Chef
                    </button>
                    <Link
                        href="/recipes/new"
                        className="px-4 py-2 bg-black text-white font-medium rounded-lg hover:bg-gray-800 transition-colors"
                    >
                        + New Recipe
                    </Link>
                </div>
            </div>

            {/* AI Modal */}
            {isGeneratorOpen && (
                <RecipeGeneratorModal
                    onClose={() => setIsGeneratorOpen(false)}
                    onSave={handleSaveGeneratedRecipe}
                />
            )}

            <RecipeBrowser
                recipes={initialRecipes.map((r: any) => ({
                    ...r,
                    base_yield_qty: Number(r.base_yield_qty),
                    child_items: r.child_items?.map((item: any) => ({
                        ...item,
                        quantity: Number(item.quantity),
                        child_ingredient: item.child_ingredient ? {
                            ...item.child_ingredient,
                            cost_per_unit: Number(item.child_ingredient.cost_per_unit)
                        } : null
                    }))
                }))}
                categories={categories}
            />
        </div>
    );
}
