"use client";

import { useState } from "react";
import { CheckCircle2, ChevronRight, Loader2, Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

type RecipeItem = {
    id: string;
    name: string;
    description: string | null;
    image_url: string | null;
    macros: string | null;
    allergens: string | null;
};

interface BoxBuilderProps {
    credits: number;
    menuItems: RecipeItem[];
    slug: string;
    businessId: string;
}

export default function BoxBuilder({ credits, menuItems, slug, businessId }: BoxBuilderProps) {
    const router = useRouter();
    // Use an object to track quantities of selected recipes: { [recipeId]: quantity }
    const [selections, setSelections] = useState<Record<string, number>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Calculate total selected so far
    const totalSelected = Object.values(selections).reduce((sum, qty) => sum + qty, 0);
    const isFull = totalSelected >= credits;
    const remaining = credits - totalSelected;

    const handleAdd = (id: string) => {
        if (isFull) {
            toast.error("Your box is full! Please remove a meal to add a different one.");
            return;
        }
        setSelections(prev => ({
            ...prev,
            [id]: (prev[id] || 0) + 1
        }));
    };

    const handleRemove = (id: string) => {
        setSelections(prev => {
            const current = prev[id] || 0;
            if (current <= 1) {
                const newSelections = { ...prev };
                delete newSelections[id];
                return newSelections;
            }
            return {
                ...prev,
                [id]: current - 1
            };
        });
    };

    const handleSubmit = async () => {
        if (!isFull) {
            toast.error(`Please select ${remaining} more meals to fill your box.`);
            return;
        }

        setIsSubmitting(true);
        try {
            const res = await fetch("/api/public/customer/box/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ selections, businessId })
            });

            if (!res.ok) throw new Error("Failed to submit box");

            toast.success("Box confirmed! Your order has been scheduled.");
            router.push(`/shop/${slug}/account`);
            router.refresh();

        } catch (error) {
            console.error(error);
            toast.error("An error occurred confirming your box. Please try again.");
            setIsSubmitting(false);
        }
    };

    return (
        <div className="space-y-6">

            {/* Sticky Progress Bar */}
            <div className="sticky top-4 z-40 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 p-4 md:p-6 mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h3 className="font-black text-lg text-slate-900 dark:text-white flex items-center gap-2">
                        {isFull ? (
                            <><CheckCircle2 className="text-emerald-500" /> Box Complete!</>
                        ) : (
                            <>Pick {remaining} More Meals</>
                        )}
                    </h3>
                    <div className="w-full md:w-64 bg-slate-100 dark:bg-slate-700 h-2 rounded-full overflow-hidden mt-2">
                        <div
                            className={`h-full transition-all duration-300 ${isFull ? 'bg-emerald-500' : 'bg-indigo-600'}`}
                            style={{ width: `${(totalSelected / credits) * 100}%` }}
                        ></div>
                    </div>
                </div>

                <button
                    onClick={handleSubmit}
                    disabled={!isFull || isSubmitting}
                    className={`px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-all ${isFull
                        ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-md'
                        : 'bg-slate-100 dark:bg-slate-700 text-slate-400 cursor-not-allowed'}`}
                >
                    {isSubmitting ? (
                        <><Loader2 size={18} className="animate-spin" /> Processing...</>
                    ) : (
                        <>Confirm Box <ChevronRight size={18} /></>
                    )}
                </button>
            </div>

            {/* Menu Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {menuItems.map(recipe => {
                    const selectedQty = selections[recipe.id] || 0;
                    return (
                        <div key={recipe.id} className="bg-white dark:bg-slate-800 rounded-3xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col">
                            {/* Image Placeholder */}
                            <div className="aspect-[4/3] bg-slate-100 dark:bg-slate-700 relative group overflow-hidden">
                                {recipe.image_url ? (
                                    <img src={recipe.image_url} alt={recipe.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center font-black text-slate-300 dark:text-slate-600 text-4xl">
                                        No Image
                                    </div>
                                )}
                                {/* Badge if selected */}
                                {selectedQty > 0 && (
                                    <div className="absolute top-3 right-3 bg-indigo-600 text-white w-8 h-8 rounded-full flex items-center justify-center font-black shadow-lg ring-2 ring-white dark:ring-slate-800">
                                        {selectedQty}
                                    </div>
                                )}
                            </div>

                            <div className="p-5 flex-1 flex flex-col">
                                <h4 className="font-black text-lg text-slate-900 dark:text-white leading-tight mb-2">
                                    {recipe.name}
                                </h4>
                                {recipe.description && (
                                    <p className="text-sm text-slate-500 line-clamp-2 mb-4">
                                        {recipe.description}
                                    </p>
                                )}

                                <div className="mt-auto flex items-center justify-between pt-4 border-t border-slate-100 dark:border-slate-700/50">
                                    {selectedQty > 0 ? (
                                        <div className="flex items-center gap-4 bg-slate-50 dark:bg-slate-900/50 p-1 rounded-xl w-full border border-slate-100 dark:border-slate-700 h-12">
                                            <button
                                                onClick={() => handleRemove(recipe.id)}
                                                className="w-10 h-10 flex items-center justify-center rounded-lg bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 shadow-sm transition-colors"
                                            >
                                                <Minus size={18} />
                                            </button>
                                            <span className="flex-1 text-center font-black text-lg text-slate-900 dark:text-white">
                                                {selectedQty}
                                            </span>
                                            <button
                                                onClick={() => handleAdd(recipe.id)}
                                                disabled={isFull}
                                                className={`w-10 h-10 flex items-center justify-center rounded-lg shadow-sm transition-colors ${isFull ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 opacity-50 cursor-not-allowed' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                                            >
                                                <Plus size={18} />
                                            </button>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => handleAdd(recipe.id)}
                                            disabled={isFull}
                                            className={`w-full h-12 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${isFull ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed' : 'bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90'}`}
                                        >
                                            <Plus size={18} /> Add to Box
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
