"use client";

import { X, ShoppingBag, Tag, Utensils, ArrowRight, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface BundleDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    bundle: any;
    primaryColor: string;
    onAddToCart?: (quantity: number) => void;
}

export default function BundleDetailsModal({ isOpen, onClose, bundle, primaryColor, onAddToCart }: BundleDetailsModalProps) {
    if (!bundle) return null;

    const price = Number(bundle.price);
    const costPerServing = bundle.serving_tier === 'family' ? price / 50 : price / 20;

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-teal-950/20 backdrop-blur-md z-50 flex items-center justify-center p-4"
                    >
                        {/* Modal */}
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0, y: 40 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.9, opacity: 0, y: 40 }}
                            transition={{ type: "spring", damping: 25, stiffness: 300 }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-white dark:bg-slate-900 w-full max-w-2xl max-h-[85vh] rounded-[3.5rem] shadow-[0_64px_128px_-32px_rgba(20,184,166,0.2)] overflow-hidden flex flex-col relative border border-white dark:border-white/10"
                        >
                            {/* Close Button */}
                            <button
                                onClick={onClose}
                                className="absolute top-6 right-6 w-12 h-12 bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl rounded-full shadow-xl flex items-center justify-center text-slate-500 dark:text-slate-300 hover:scale-110 active:scale-95 transition-all z-20 border border-teal-50/50 dark:border-white/10"
                            >
                                <X size={24} />
                            </button>

                            {/* Scrollable Content */}
                            <div className="overflow-y-auto flex-1 scrollbar-hide">
                                {/* Image Header */}
                                <div className="h-80 relative bg-slate-100 dark:bg-slate-950 overflow-hidden">
                                    {bundle.image_url ? (
                                        <motion.img
                                            initial={{ scale: 1.1 }}
                                            animate={{ scale: 1 }}
                                            transition={{ duration: 1.5 }}
                                            src={bundle.image_url}
                                            alt={bundle.name}
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex flex-col items-center justify-center text-indigo-100 dark:text-slate-800">
                                            <Tag size={80} className="mb-4 opacity-50" />
                                            <span className="font-black opacity-50 text-[10px] uppercase tracking-[0.2em]">Preview Placeholder</span>
                                        </div>
                                    )}
                                    <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-t from-white dark:from-slate-900 to-transparent" />
                                    <div className="absolute top-8 left-8">
                                        <motion.span
                                            initial={{ x: -20, opacity: 0 }}
                                            animate={{ x: 0, opacity: 1 }}
                                            transition={{ delay: 0.2 }}
                                            className="bg-white/90 dark:bg-slate-900/90 backdrop-blur px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-[0.2em] text-brand-teal dark:text-teal-300 shadow-xl border border-white/40"
                                        >
                                            {bundle.serving_tier.replace('_', ' ')}
                                        </motion.span>
                                    </div>
                                </div>

                                <div className="px-10 pb-10 -mt-10 relative z-10 space-y-10">
                                    {/* Header Info */}
                                    <div className="space-y-4">
                                        <motion.h2
                                            initial={{ y: 20, opacity: 0 }}
                                            animate={{ y: 0, opacity: 1 }}
                                            transition={{ delay: 0.3 }}
                                            className="text-4xl font-black text-slate-900 dark:text-white tracking-tight leading-none"
                                        >
                                            {bundle.name}
                                        </motion.h2>
                                        <motion.p
                                            initial={{ y: 20, opacity: 0 }}
                                            animate={{ y: 0, opacity: 1 }}
                                            transition={{ delay: 0.4 }}
                                            className="text-slate-500 dark:text-slate-400 leading-relaxed text-lg font-medium"
                                        >
                                            {bundle.description || "Indulge in our carefully selected rotation of home-style favorites."}
                                        </motion.p>
                                    </div>

                                    {/* Meals List */}
                                    <div className="space-y-6">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-[10px] font-black text-brand-teal uppercase tracking-[0.2em] flex items-center gap-2">
                                                <Utensils size={14} />
                                                Included in this bundle
                                            </h3>
                                        </div>

                                        <div className="grid grid-cols-1 gap-4">
                                            {bundle.contents?.map((item: any, idx: number) => (
                                                <motion.div
                                                    key={item.id}
                                                    initial={{ x: -20, opacity: 0 }}
                                                    animate={{ x: 0, opacity: 1 }}
                                                    transition={{ delay: 0.5 + (idx * 0.1) }}
                                                    className="flex gap-6 p-6 rounded-[2.5rem] bg-teal-50/30 dark:bg-slate-800/50 border border-white/50 dark:border-white/5 group hover:bg-white dark:hover:bg-slate-800 hover:shadow-xl transition-all duration-500"
                                                >
                                                    <div className="w-16 h-16 rounded-[1.5rem] bg-white dark:bg-slate-900 flex items-center justify-center text-xl font-black text-brand-teal shadow-sm border border-teal-100/50 dark:border-slate-700 group-hover:scale-110 group-hover:-rotate-3 transition-transform">
                                                        {item.quantity}
                                                    </div>
                                                    <div className="flex-1 space-y-1">
                                                        <h4 className="font-black text-slate-900 dark:text-white text-lg tracking-tight">
                                                            {item.recipe?.name || "Delicious Main Course"}
                                                        </h4>
                                                        <p className="text-sm text-slate-500 dark:text-slate-400 font-medium leading-relaxed line-clamp-2">
                                                            {item.recipe?.description || "Our secret family recipe, prepped fresh for your table."}
                                                        </p>
                                                    </div>
                                                </motion.div>
                                            ))}
                                            {(!bundle.contents || bundle.contents.length === 0) && (
                                                <div className="bg-slate-50 dark:bg-slate-800/30 p-12 rounded-[2.5rem] border-2 border-dashed border-teal-100/50 dark:border-slate-800 text-center">
                                                    <p className="text-slate-400 font-black text-xs uppercase tracking-widest italic">Inventory list currently being finalized</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Footer / CTA */}
                            <div className="p-10 border-t border-teal-50 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl">
                                <div className="flex items-center justify-between mb-8">
                                    <div className="space-y-1">
                                        <p className="text-4xl font-black text-slate-900 dark:text-white tracking-tighter">
                                            ${price.toFixed(2)}
                                        </p>
                                        <p className="text-[10px] font-black text-brand-teal uppercase tracking-[0.2em]">
                                            ~${costPerServing.toFixed(2)} / person
                                        </p>
                                    </div>
                                    <div className="bg-emerald-50 dark:bg-emerald-950 px-5 py-2.5 rounded-2xl border border-emerald-100 dark:border-emerald-800/30 flex items-center gap-3">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                        <span className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-[0.2em]">
                                            {bundle.stock_on_hand} Left
                                        </span>
                                    </div>
                                </div>
                                <button
                                    onClick={() => onAddToCart?.(1)}
                                    style={{ backgroundColor: primaryColor, display: onAddToCart ? undefined : 'none' }}
                                    className="w-full h-20 rounded-[2.5rem] font-black text-white shadow-[0_24px_48px_-12px_rgba(20,184,166,0.4)] hover:shadow-[0_32px_64px_-16px_rgba(20,184,166,0.5)] hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-4 text-xl tracking-tight"
                                >
                                    <ShoppingBag size={28} />
                                    Reserve My Bundle
                                    <ArrowRight size={24} />
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
