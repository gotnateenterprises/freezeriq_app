"use client";

import { motion } from 'framer-motion';
import { Clock, Users, DollarSign, ChevronRight, Utensils, Zap, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { formatQuantity } from '@/lib/format_quantity';

interface RecipeShowcaseProps {
    recipe: any;
    costData: {
        totalCost: number;
        costPerUnit: number;
        yieldUnit: string;
        isAccurate: boolean;
    };
    onEdit?: () => void;
}

export default function RecipeShowcase({ recipe, costData, onEdit }: RecipeShowcaseProps) {
    const fadeIn = {
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 }
    };

    const stagger = {
        visible: { transition: { staggerChildren: 0.1 } }
    };

    return (
        <div className="min-h-screen bg-[#fafaf9] text-slate-900 pb-20">
            {/* --- Cinematic Hero Section --- */}
            <section className="relative h-[65vh] w-full overflow-hidden">
                <motion.div
                    initial={{ scale: 1.1 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 1.5, ease: "easeOut" }}
                    className="absolute inset-0"
                >
                    <Image
                        src={recipe.image_url || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=2000&auto=format&fit=crop'}
                        alt={recipe.name}
                        fill
                        className="object-cover"
                        priority
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/60" />
                </motion.div>

                {/* --- Hero Content --- */}
                <div className="absolute inset-0 flex flex-col justify-end p-8 md:p-16">
                    <motion.div
                        variants={stagger}
                        initial="hidden"
                        animate="visible"
                        className="max-w-4xl"
                    >
                        <motion.div variants={fadeIn} className="flex items-center gap-3 mb-4">
                            <span className="px-4 py-1.5 bg-indigo-600/90 backdrop-blur-md text-white rounded-full text-xs font-bold tracking-widest uppercase">
                                {recipe.type?.replace('_', ' ') || 'MAIN COURSE'}
                            </span>
                            {recipe.sku && (
                                <span className="px-4 py-1.5 bg-white/20 backdrop-blur-md text-white rounded-full text-xs font-bold tracking-widest uppercase border border-white/20">
                                    SKU: {recipe.sku}
                                </span>
                            )}
                        </motion.div>

                        <motion.h1
                            variants={fadeIn}
                            className="text-5xl md:text-7xl font-serif text-white mb-6 drop-shadow-2xl leading-[1.1]"
                        >
                            {recipe.name}
                        </motion.h1>

                        <motion.div variants={fadeIn} className="flex flex-wrap gap-6 items-center">
                            <button
                                onClick={onEdit}
                                className="px-8 py-4 bg-white text-slate-900 rounded-full font-bold hover:bg-slate-100 transition-all flex items-center gap-2 group shadow-xl"
                            >
                                Edit Recipe <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                            </button>

                            <div className="flex gap-8 text-white/90 font-medium">
                                <div className="flex items-center gap-2">
                                    <Users className="w-5 h-5 opacity-70" />
                                    <span>{Number(recipe.base_yield_qty)} {recipe.base_yield_unit}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Clock className="w-5 h-5 opacity-70" />
                                    <span>{recipe.shelf_life_days || 7} Days Shelf Life</span>
                                </div>
                            </div>
                        </motion.div>
                    </motion.div>
                </div>
            </section>

            {/* --- Key Metrics (The "Business" of the Recipe) --- */}
            <div className="max-w-7xl mx-auto px-8 -mt-12 relative z-10 grid grid-cols-1 md:grid-cols-3 gap-6">
                <motion.div
                    whileHover={{ y: -5 }}
                    className="p-8 bg-white/70 backdrop-blur-xl border border-white rounded-3xl shadow-xl flex items-center gap-6"
                >
                    <div className="w-14 h-14 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600">
                        <DollarSign className="w-8 h-8" />
                    </div>
                    <div>
                        <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Batch Cost</p>
                        <h3 className="text-3xl font-serif text-slate-800">${costData.totalCost.toFixed(2)}</h3>
                    </div>
                </motion.div>

                <motion.div
                    whileHover={{ y: -5 }}
                    className="p-8 bg-white/70 backdrop-blur-xl border border-white rounded-3xl shadow-xl flex items-center gap-6"
                >
                    <div className="w-14 h-14 bg-emerald-50 rounded-2xl flex items-center justify-center text-emerald-600">
                        <Utensils className="w-8 h-8" />
                    </div>
                    <div>
                        <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Cost Per {recipe.base_yield_unit}</p>
                        <h3 className="text-3xl font-serif text-slate-800">${costData.costPerUnit.toFixed(2)}</h3>
                    </div>
                </motion.div>

                <motion.div
                    whileHover={{ y: -5 }}
                    className="p-8 bg-white/70 backdrop-blur-xl border border-white rounded-3xl shadow-xl flex items-center gap-6"
                >
                    <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center text-white">
                        <Zap className="w-8 h-8" />
                    </div>
                    <div>
                        <p className="text-white/80 text-xs font-bold uppercase tracking-wider mb-1">Profit Potential</p>
                        <h3 className="text-3xl font-serif text-slate-900">Excellent</h3>
                    </div>
                </motion.div>
            </div>

            {/* --- Main Content Grid (Magazine Style) --- */}
            <div className="max-w-7xl mx-auto px-8 mt-20 grid grid-cols-1 lg:grid-cols-12 gap-16">

                {/* --- Left Column: Ingredients --- */}
                <div className="lg:col-span-5">
                    <h2 className="text-4xl font-serif mb-10 flex items-center gap-4">
                        The Build <span className="h-px bg-slate-200 flex-1" />
                    </h2>

                    <div className="space-y-4">
                        {recipe.items.map((item: any, idx: number) => (
                            <motion.div
                                key={idx}
                                initial={{ opacity: 0, x: -20 }}
                                whileInView={{ opacity: 1, x: 0 }}
                                transition={{ delay: idx * 0.05 }}
                                className="group flex items-center justify-between p-4 bg-white border border-slate-100 rounded-2xl hover:border-indigo-200 hover:shadow-md transition-all cursor-default"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-slate-50 rounded-lg flex items-center justify-center text-slate-400 group-hover:bg-indigo-50 group-hover:text-indigo-500 transition-colors">
                                        <div className="w-2 h-2 rounded-full bg-current" />
                                    </div>
                                    <span className="font-medium text-slate-700">
                                        {item.child_ingredient?.name || item.child_recipe?.name}
                                    </span>
                                </div>
                                <div className="text-indigo-600 font-bold bg-indigo-50 px-3 py-1 rounded-lg text-sm">
                                    {formatQuantity(item.quantity)} {item.unit}
                                </div>
                            </motion.div>
                        ))}
                    </div>

                    <div className="mt-12 p-8 bg-slate-900 rounded-3xl text-white">
                        <h4 className="flex items-center gap-2 text-indigo-400 font-bold mb-4">
                            <ShieldCheck className="w-5 h-5" /> Quality Assurance
                        </h4>
                        <p className="text-slate-400 text-sm leading-relaxed mb-6">
                            This recipe has been verified for both scale and margin accuracy. Ensure all raw weights are zeroed before prep.
                        </p>
                        <div className="flex gap-4">
                            <span className="px-3 py-1 bg-white/10 rounded-lg text-xs font-bold uppercase tracking-widest text-white/50 border border-white/10">
                                Gluten-Free
                            </span>
                            <span className="px-3 py-1 bg-white/10 rounded-lg text-xs font-bold uppercase tracking-widest text-white/50 border border-white/10">
                                Keto-Safe
                            </span>
                        </div>
                    </div>
                </div>

                {/* --- Right Column: Instructions --- */}
                <div className="lg:col-span-1" /> {/* Spacer */}

                <div className="lg:col-span-6">
                    <h2 className="text-4xl font-serif mb-10 flex items-center gap-4">
                        Process <span className="h-px bg-slate-200 flex-1" />
                    </h2>

                    <div className="prose prose-slate prose-lg max-w-none">
                        {recipe.instructions ? (
                            <div className="space-y-8">
                                {recipe.instructions.split('\n').filter((l: string) => l.trim()).map((line: string, idx: number) => (
                                    <motion.div
                                        key={idx}
                                        initial={{ opacity: 0, y: 10 }}
                                        whileInView={{ opacity: 1, y: 0 }}
                                        viewport={{ once: true }}
                                        className="flex gap-6"
                                    >
                                        <span className="text-5xl font-serif text-slate-100 tabular-nums">
                                            {String(idx + 1).padStart(2, '0')}
                                        </span>
                                        <p className="text-slate-600 mt-2 leading-relaxed">
                                            {line}
                                        </p>
                                    </motion.div>
                                ))}
                            </div>
                        ) : (
                            <div className="p-12 border-2 border-dashed border-slate-200 rounded-3xl text-center">
                                <p className="text-slate-400 italic">No detailed instructions yet. Switch to Editor to add them.</p>
                            </div>
                        )}
                    </div>

                    {/* --- Storage Instructions --- */}
                    {recipe.storage_instructions && (
                        <div className="mt-16 p-10 bg-indigo-50/50 rounded-3xl border border-indigo-100">
                            <h3 className="font-serif text-2xl text-indigo-900 mb-4">Shelf Life & Storage</h3>
                            <p className="text-indigo-800/70 leading-relaxed">
                                {recipe.storage_instructions}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
