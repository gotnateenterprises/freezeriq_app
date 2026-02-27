import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import Image from 'next/image';
import { ChefHat, ExternalLink, Clock, Thermometer, ShieldAlert, Heart, Star } from 'lucide-react';
import NutritionFactsLabel from '@/components/NutritionFactsLabel';
import Link from 'next/link';

export default async function PublicRecipeLabel({
    params
}: {
    params: { slug: string, id: string }
}) {
    // 1. Fetch Business via slug
    const business = await prisma.business.findUnique({
        where: { slug: params.slug }
    });

    if (!business) notFound();

    // 2. Fetch Recipe
    const recipe = await prisma.recipe.findFirst({
        where: {
            id: params.id,
            business_id: business.id
        }
    });

    if (!recipe) notFound();

    // Removed relation as branding is linked to User, not Business in schema.
    // Instead we will fetch a default color or settings
    const themeColor = '#4f46e5'; // Default indigo-600

    // Parse full nutrition if available
    let fullNutrition = null;
    let simpleMacros = recipe.macros;
    if (recipe.macros && recipe.macros.startsWith('{')) {
        try {
            const parsed = JSON.parse(recipe.macros);
            fullNutrition = parsed.fullData;
            simpleMacros = parsed.summary;
        } catch (e) {
            // ignore
        }
    }


    return (
        <div className="min-h-screen bg-slate-50 relative pb-24">

            {/* Header / Brand Banner */}
            <div
                className="w-full h-48 sm:h-64 relative bg-slate-900"
                style={{ backgroundColor: themeColor }}
            >
                {/* Optional Banner Image could go here */}
                {recipe.image_url && (
                    <div className="absolute inset-0 z-0">
                        <Image
                            src={recipe.image_url}
                            alt={recipe.name}
                            fill
                            className="object-cover opacity-60"
                            priority
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/40 to-transparent"></div>
                    </div>
                )}

                <div className="absolute bottom-0 left-0 right-0 p-6 z-10 flex flex-col gap-2">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/50">
                            <ChefHat size={20} className="text-white" />
                        </div>
                        <span className="text-white font-medium drop-shadow-md">{business.name}</span>
                    </div>

                    <h1 className="text-3xl sm:text-4xl font-black text-white drop-shadow-lg leading-tight">
                        {recipe.name}
                    </h1>
                </div>
            </div>

            {/* Main Content Area - Overlapping Banner */}
            <div className="max-w-3xl mx-auto px-4 -mt-4 relative z-20 space-y-6">

                {/* Description Card */}
                {recipe.description && (
                    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 text-slate-700 leading-relaxed text-sm sm:text-base">
                        {recipe.description}
                    </div>
                )}

                {/* Info Grid */}
                <div className="grid grid-cols-2 gap-4">
                    {recipe.cook_time && (
                        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 flex items-center gap-4">
                            <div className="p-3 bg-amber-50 text-amber-600 rounded-xl">
                                <Clock size={24} />
                            </div>
                            <div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Cook Time</p>
                                <p className="font-bold text-slate-900 text-sm sm:text-base">{recipe.cook_time}</p>
                            </div>
                        </div>
                    )}
                    {recipe.base_yield_qty && (
                        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 flex items-center gap-4">
                            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
                                <Heart size={24} />
                            </div>
                            <div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Servings</p>
                                <p className="font-bold text-slate-900 text-sm sm:text-base">{Number(recipe.base_yield_qty)} {recipe.base_yield_unit}</p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Instructions Card */}
                {recipe.label_text && (
                    <div className="bg-emerald-50 rounded-2xl border border-emerald-100 p-6 space-y-4 shadow-sm shadow-emerald-900/5">
                        <div className="flex items-center gap-3 text-emerald-800 border-b border-emerald-200/50 pb-3">
                            <Thermometer size={24} className="text-emerald-600" />
                            <h2 className="text-xl font-black tracking-tight">Cooking Instructions</h2>
                        </div>
                        <div className="prose prose-emerald prose-sm max-w-none text-emerald-900 whitespace-pre-wrap font-medium leading-relaxed">
                            {recipe.label_text}
                        </div>
                    </div>
                )}

                {/* Allergens Card */}
                {recipe.allergens && (
                    <div className="bg-rose-50 rounded-2xl border border-rose-100 p-5 flex items-start gap-4 shadow-sm shadow-rose-900/5">
                        <ShieldAlert size={24} className="text-rose-500 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-black text-rose-800 uppercase tracking-wider mb-1">Allergen Warning</p>
                            <p className="text-rose-700/80 font-medium text-sm">Contains: {recipe.allergens}</p>
                        </div>
                    </div>
                )}


                {/* Nutrition Panel */}
                {(fullNutrition || simpleMacros) && (
                    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 space-y-6">
                        <h2 className="text-lg font-black text-slate-900 border-b border-slate-100 pb-3">Nutrition Facts</h2>

                        {fullNutrition ? (
                            <div className="flex justify-center -mx-2">
                                {/* Wrap to prevent overflow on very small devices */}
                                <div className="transform scale-90 sm:scale-100 origin-top">
                                    <NutritionFactsLabel data={fullNutrition} />
                                </div>
                            </div>
                        ) : (
                            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-sm font-medium text-slate-600">
                                {simpleMacros}
                            </div>
                        )}
                    </div>
                )}

                {/* Review / Facebook Link Action Bar (Fixed Bottom) */}
                <div className="fixed bottom-0 left-0 right-0 p-4 bg-white/80 backdrop-blur-xl border-t border-slate-200 shadow-[0_-10px_40px_rgba(0,0,0,0.05)] z-50">
                    <div className="max-w-3xl mx-auto flex gap-3">
                        <Link
                            href={`/shop/${business.slug}`}
                            className="flex-1 py-3.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold flex items-center justify-center transition-colors text-sm sm:text-base"
                        >
                            View Store
                        </Link>

                        <Link
                            href={`/shop/${business.slug}`}
                            className="flex-[2] py-3.5 px-4 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-[0.98] transition-all text-sm sm:text-base"
                            style={{ backgroundColor: themeColor }}
                        >
                            Browse More Meals
                        </Link>
                    </div>
                </div>

            </div>
        </div>
    );
}
