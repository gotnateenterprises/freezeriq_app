
'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import RecipeBrowser from '@/components/RecipeBrowser';
import RecipeGeneratorModal from '@/components/RecipeGeneratorModal';

export default function RecipePageClient({ initialRecipes, categories }: { initialRecipes: any[], categories: any[] }) {
    const [isGeneratorOpen, setIsGeneratorOpen] = useState(false);
    // const [recipes, setRecipes] = useState(initialRecipes); // Removed to allow server updates to flow through

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
