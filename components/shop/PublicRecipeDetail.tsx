"use client";

import { motion, AnimatePresence } from 'framer-motion';
import { X, ChefHat, Timer, Flame, Utensils, Info } from 'lucide-react';

interface Ingredient {
    name: string;
    quantity: number;
    unit: string;
}

interface Recipe {
    id: string;
    name: string;
    description?: string;
    image_url?: string;
    yield_qty?: number;
    yield_unit?: string;
    items?: Ingredient[];
    cook_time?: string;
    container_type?: 'tray' | 'bag';
    categories?: string[];
}

interface PublicRecipeDetailProps {
    isOpen: boolean;
    onClose: () => void;
    recipe: Recipe | null;
    primaryColor: string;
}

export default function PublicRecipeDetail({ isOpen, onClose, recipe, primaryColor }: PublicRecipeDetailProps) {
    if (!recipe) return null;

    const isCrockPot = recipe.categories?.some(c => c.toLowerCase().includes('crock pot') || c.toLowerCase().includes('slow cooker'));
    const isInstantPot = recipe.categories?.some(c => c.toLowerCase().includes('instant pot'));
    const isOven = recipe.container_type === 'tray' || recipe.categories?.some(c => c.toLowerCase().includes('oven'));

    // Visibility Logic:
    // 1. If it's a tray meal, we hide Crock Pot and Instant Pot (as they are bag-based).
    // 2. If it's marked as Crock Pot, we hide Oven (per user request).
    const showCrockPot = isCrockPot && recipe.container_type !== 'tray';
    const showInstantPot = isInstantPot && recipe.container_type !== 'tray';
    const showOven = isOven && !isCrockPot;

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8">
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
                    />

                    {/* Modal Content */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        className="relative w-full max-w-5xl bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl overflow-hidden flex flex-col md:flex-row max-h-[90vh]"
                    >
                        {/* Close Button */}
                        <button
                            onClick={onClose}
                            className="absolute top-6 right-6 z-50 p-3 rounded-full bg-white/20 hover:bg-white/40 backdrop-blur-md text-white md:text-slate-900 md:bg-slate-100 md:hover:bg-slate-200 transition-all active:scale-95"
                        >
                            <X size={20} />
                        </button>

                        {/* Image Section */}
                        <div className="md:w-1/2 h-64 md:h-auto relative overflow-hidden bg-slate-100">
                            {recipe.image_url ? (
                                <img
                                    src={recipe.image_url}
                                    alt={recipe.name}
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-slate-200">
                                    <Utensils size={80} />
                                </div>
                            )}
                            <div className="absolute inset-0 bg-linear-to-t from-black/60 via-transparent to-transparent md:hidden" />
                            <div className="absolute bottom-6 left-8 md:hidden">
                                <h2 className="text-3xl font-serif text-white">{recipe.name}</h2>
                            </div>
                        </div>

                        {/* Details Section */}
                        <div className="md:w-1/2 p-8 md:p-12 overflow-y-auto">
                            <div className="hidden md:block mb-8">
                                <h2 className="text-4xl font-serif text-slate-900 dark:text-white leading-tight mb-4">
                                    {recipe.name}
                                </h2>
                                <div className="flex items-center gap-4 text-xs font-black uppercase tracking-widest text-slate-400">
                                    <span className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 rounded-full">
                                        <Timer size={14} className="text-indigo-500" />
                                        {recipe.cook_time || 'Prep Ready'}
                                    </span>
                                    {recipe.yield_qty && (
                                        <span className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 rounded-full">
                                            <Utensils size={14} className="text-indigo-500" />
                                            Serves {recipe.yield_qty} {recipe.yield_unit}
                                        </span>
                                    )}
                                </div>
                            </div>

                            {recipe.description && (
                                <div className="mb-10">
                                    <p className="text-slate-600 dark:text-slate-300 font-medium leading-relaxed text-lg italic">
                                        "{recipe.description}"
                                    </p>
                                </div>
                            )}

                            {/* Cooking Methods Container */}
                            <div className="flex gap-4 mb-10 overflow-x-auto pb-2 scrollbar-none">
                                {showCrockPot && (
                                    <div className="flex flex-col items-center p-4 rounded-2xl bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100/50 dark:border-indigo-800/30 text-indigo-600 dark:text-indigo-400 min-w-24">
                                        <ChefHat size={20} className="mb-2" />
                                        <span className="text-[10px] font-black uppercase tracking-widest text-center whitespace-nowrap">Crock Pot</span>
                                    </div>
                                )}
                                {showInstantPot && (
                                    <div className="flex flex-col items-center p-4 rounded-2xl bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100/50 dark:border-indigo-800/30 text-indigo-600 dark:text-indigo-400 min-w-24">
                                        <Timer size={20} className="mb-2" />
                                        <span className="text-[10px] font-black uppercase tracking-widest text-center whitespace-nowrap">Instant Pot</span>
                                    </div>
                                )}
                                {showOven && (
                                    <div className="flex flex-col items-center p-4 rounded-2xl bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100/50 dark:border-indigo-800/30 text-indigo-600 dark:text-indigo-400 min-w-24">
                                        <Flame size={20} className="mb-2" />
                                        <span className="text-[10px] font-black uppercase tracking-widest text-center whitespace-nowrap">Oven Ready</span>
                                    </div>
                                )}
                            </div>

                            {/* Ingredients List */}
                            <div className="space-y-6">
                                <div className="flex items-center gap-2 pb-4 border-b border-slate-100 dark:border-slate-800">
                                    <Info size={18} className="text-indigo-500" />
                                    <h3 className="font-serif text-xl text-slate-900 dark:text-white">Ingredients</h3>
                                </div>
                                <ul className="grid grid-cols-1 gap-1.5">
                                    {recipe.items?.map((item, i) => (
                                        <li key={i} className="flex items-center gap-3 text-slate-500 dark:text-slate-400 font-medium py-1">
                                            <div className="w-1.5 h-1.5 rounded-full bg-indigo-200 dark:bg-indigo-800 shrink-0" />
                                            <span>{item.name}</span>
                                        </li>
                                    )) || (
                                            <p className="text-slate-400 text-sm italic">Recipe details being updated...</p>
                                        )}
                                </ul>
                            </div>

                            {/* CTA */}
                            <div className="mt-12 pt-8 border-t border-slate-100 dark:border-slate-800">
                                <button
                                    onClick={onClose}
                                    style={{ backgroundColor: primaryColor }}
                                    className="w-full py-4 rounded-2xl font-black text-white shadow-xl hover:scale-[1.02] active:scale-95 transition-all text-xs uppercase tracking-widest"
                                >
                                    Back to Menu
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
