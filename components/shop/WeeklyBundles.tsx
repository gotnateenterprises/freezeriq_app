"use client";

import { ShoppingBag, Check, ChevronRight, Eye } from 'lucide-react';
import { motion } from 'framer-motion';

interface WeeklyBundlesProps {
    bundles: any[];
    primaryColor: string;
    onAddToCart: (params: any) => void;
    onSelect?: (bundleId: string) => void;
    activeBundleId?: string;
    onViewMeals?: (bundleId: string) => void;
}

export default function WeeklyBundles({ bundles, primaryColor, onAddToCart, onSelect, activeBundleId, onViewMeals }: WeeklyBundlesProps) {
    return (
        <section id="bundles" className="pt-2 pb-12 w-full scroll-mt-20">
            <div className="flex flex-col space-y-3 mb-8 md:mb-10">
                <motion.span
                    initial={{ opacity: 0, scale: 0.9 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    className="font-black tracking-[0.2em] uppercase text-[10px] block"
                    style={{ color: primaryColor }}
                >
                    Curated Collections
                </motion.span>
                <motion.h2
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    className="text-3xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight"
                >
                    {new Date().toLocaleString('default', { month: 'long' })} Bundles
                </motion.h2>
                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-slate-500 font-medium text-sm max-w-sm"
                >
                    Tap a bundle to view included meals, then add to cart.
                </motion.p>
            </div>

            <div className="flex flex-col gap-4 md:gap-4 w-full md:max-w-none">
                {bundles.map((bundle, idx) => {
                    const isActive = bundle.id === activeBundleId;
                    return (
                        <motion.div
                            key={bundle.id}
                            initial={{ opacity: 0, x: -20 }}
                            whileInView={{ opacity: 1, x: 0 }}
                            viewport={{ once: true }}
                            transition={{ delay: idx * 0.1 }}
                            className={`relative overflow-hidden w-full p-4 md:p-6 rounded-2xl md:rounded-[2rem] border transition-all duration-300 text-left group
                                ${isActive
                                    ? 'bg-white dark:bg-slate-900 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.1)] ring-2'
                                    : 'bg-white/40 dark:bg-slate-900/40 backdrop-blur-sm border-slate-200/50 dark:border-slate-800/50 hover:bg-white dark:hover:bg-slate-900 hover:shadow-xl'
                                }`}
                            style={isActive ? { borderColor: `${primaryColor}40`, '--tw-ring-color': `${primaryColor}15` } as any : {}}
                        >
                            {isActive && (
                                <motion.div layoutId="activeBundleIndicator" className="absolute top-0 left-0 w-1.5 h-full rounded-r-full" style={{ backgroundColor: primaryColor }} />
                            )}

                            {/* Bundle header row */}
                            <button
                                onClick={() => onSelect?.(bundle.id)}
                                className="w-full text-left focus:outline-none"
                            >
                                <div className="flex items-center justify-between gap-3 pl-2">
                                    <div className="flex-1 min-w-0">
                                        <h3 className={`text-lg md:text-xl font-bold mb-1 transition-colors truncate ${isActive ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400 group-hover:text-slate-900 dark:group-hover:text-white'}`}>
                                            {bundle.name}
                                        </h3>
                                        <div className="flex items-center gap-2 text-[10px] md:text-xs font-black uppercase tracking-widest text-slate-400 flex-wrap">
                                            <span className={`bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 rounded-md ${isActive && 'text-slate-700'}`}>
                                                {bundle.serving_tier?.replace(/_/g, ' ')}
                                            </span>
                                            <span className="font-bold text-xs" style={{ color: isActive ? primaryColor : undefined }}>
                                                ${Number(bundle.price).toFixed(2)}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="shrink-0">
                                        {isActive ? (
                                            <div className="w-9 h-9 md:w-10 md:h-10 rounded-full flex items-center justify-center text-white shadow-lg" style={{ backgroundColor: primaryColor }}>
                                                <Check size={18} strokeWidth={3} />
                                            </div>
                                        ) : (
                                            <div className="w-9 h-9 md:w-10 md:h-10 rounded-full flex items-center justify-center text-slate-300 group-hover:text-slate-500 bg-slate-50 group-hover:bg-slate-100 transition-all">
                                                <ChevronRight size={18} className="group-hover:translate-x-0.5 transition-transform" />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </button>

                            {/* Action row */}
                            <div className="mt-3 px-2 flex flex-col sm:flex-row gap-2 sm:justify-between sm:items-center border-t border-slate-100 dark:border-slate-800 pt-3">
                                <button
                                    onClick={() => onViewMeals?.(bundle.id)}
                                    className="flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-wider py-2.5 px-4 rounded-xl bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none"
                                >
                                    <Eye size={14} />
                                    View Meals
                                </button>

                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onAddToCart({ bundleId: bundle.id });
                                    }}
                                    className="w-full sm:w-auto px-5 py-3 sm:py-2.5 rounded-xl sm:rounded-full text-white font-black text-xs uppercase tracking-widest shadow-md hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2"
                                    style={{ backgroundColor: primaryColor }}
                                >
                                    <ShoppingBag size={14} />
                                    Add to Cart
                                </button>
                            </div>
                        </motion.div>
                    )
                })}
            </div>

            {bundles.length === 0 && (
                <div className="text-center py-16 bg-white dark:bg-slate-900 rounded-[3rem] border border-slate-100 dark:border-slate-800">
                    <div className="w-16 h-16 rounded-2xl bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-slate-400 mx-auto mb-4">
                        <ShoppingBag size={32} />
                    </div>
                    <p className="text-slate-400 font-black text-sm uppercase tracking-widest">New Menu Coming Soon</p>
                </div>
            )}
        </section>
    );
}
