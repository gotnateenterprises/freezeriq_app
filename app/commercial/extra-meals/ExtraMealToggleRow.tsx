"use client";

import { useState } from "react";
import Image from "next/image";
import { Package, Globe, EyeOff, Loader2 } from "lucide-react";

interface RecipeWithInventory {
    id: string;
    name: string;
    image_url: string | null;
    inventory_count: number | null;
    base_yield_unit: string | null;
    container_type: string | null;
    is_published?: boolean;
}

export default function ExtraMealToggleRow({ recipe }: { recipe: RecipeWithInventory }) {
    const [isPublished, setIsPublished] = useState(!!recipe.is_published);
    const [isLoading, setIsLoading] = useState(false);

    const togglePublish = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/commercial/extra-meals/${recipe.id}/publish`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ is_published: !isPublished })
            });

            if (res.ok) {
                setIsPublished(!isPublished);
            } else {
                alert("Failed to update status.");
            }
        } catch (error) {
            console.error("Toggle Error:", error);
            alert("Network error.");
        } finally {
            setIsLoading(false);
        }
    };

    const stock = Number(recipe.inventory_count) || 0;

    return (
        <tr className={`group transition-colors ${isPublished ? 'bg-indigo-50/10' : 'hover:bg-slate-50'}`}>
            {/* Meal Info */}
            <td className="px-6 py-4">
                <div className="flex items-center gap-4">
                    {recipe.image_url ? (
                        <div className="w-12 h-12 rounded-xl border border-slate-200 overflow-hidden relative shadow-sm">
                            <Image src={recipe.image_url} alt={recipe.name} fill className="object-cover" />
                        </div>
                    ) : (
                        <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400">
                            <Package size={20} />
                        </div>
                    )}
                    <div>
                        <p className="font-black text-slate-800 tracking-tight">{recipe.name}</p>
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">{recipe.container_type || 'Tray'}</p>
                    </div>
                </div>
            </td>

            {/* Category / Type info */}
            <td className="px-6 py-4 text-center">
                <span className="inline-flex px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-[10px] font-bold uppercase tracking-widest border border-slate-200">
                    Menu Item
                </span>
            </td>

            {/* Stock Count */}
            <td className="px-6 py-4 text-center">
                <div className="flex flex-col items-center justify-center gap-1">
                    <span className={`text-xl font-black ${stock > 0 ? 'text-indigo-600' : 'text-slate-400'}`}>
                        {stock}
                    </span>
                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                        {recipe.base_yield_unit || 'Units'}
                    </span>
                </div>
            </td>


            {/* Publish Toggle Button */}
            <td className="px-6 py-4 text-right">
                <div className="flex justify-end pr-2">
                    <button
                        onClick={togglePublish}
                        disabled={isLoading}
                        className={`relative flex items-center justify-between w-32 p-1.5 rounded-full border shadow-inner transition-all duration-300 disabled:opacity-50 ${isPublished
                            ? 'bg-emerald-500 border-emerald-600'
                            : 'bg-slate-200 border-slate-300'
                            }`}
                        title={isPublished ? "Hide from Storefront" : "Publish to Storefront"}
                    >
                        {/* Status Label (Left or Right) */}
                        <span className={`absolute text-[10px] font-black uppercase tracking-widest text-white z-10 ${isPublished ? 'left-3' : 'right-3 text-slate-500'}`}>
                            {isLoading ? 'Wait...' : isPublished ? 'Live' : 'Hidden'}
                        </span>

                        {/* Sliding Thumb */}
                        <div className={`w-8 h-8 rounded-full bg-white shadow-md flex items-center justify-center transform transition-transform duration-300 z-20 ${isPublished ? 'translate-x-[5.3rem] text-emerald-500' : 'translate-x-0 text-slate-400'
                            }`}>
                            {isLoading ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : isPublished ? (
                                <Globe size={16} />
                            ) : (
                                <EyeOff size={16} />
                            )}
                        </div>
                    </button>
                </div>
            </td>
        </tr>
    );
}
