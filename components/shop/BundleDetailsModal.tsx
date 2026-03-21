"use client";

import { useState } from 'react';
import { X, Tag, Utensils, ArrowRight, Mail, Minus, Plus, UtensilsCrossed } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface BundleDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    bundle: any;
    primaryColor: string;
    onAddToCart?: (quantity: number) => void;
    /** Fundraiser-mode props (when set, shows email-order CTA instead of cart) */
    fundraiserMode?: boolean;
    coordinatorEmail?: string;
    campaignName?: string;
}

export default function BundleDetailsModal({
    isOpen,
    onClose,
    bundle,
    primaryColor,
    onAddToCart,
    fundraiserMode,
    coordinatorEmail,
    campaignName,
}: BundleDetailsModalProps) {
    const [quantity, setQuantity] = useState(1);

    if (!bundle) return null;

    const price = Number(bundle.price);
    // Recipes come from page.tsx as bundle.items[].recipe
    const meals = (bundle.items || [])
        .map((i: any) => i.recipe)
        .filter((r: any) => r && r.name);
    const mealCount = meals.length || 5; // fallback to 5 if unknown
    const costPerMeal = price / mealCount;

    const totalPrice = price * quantity;

    // Build mailto link with quantity
    const buildMailtoUrl = () => {
        if (!coordinatorEmail) return '';
        const subject = encodeURIComponent(`Fundraiser Order - ${bundle.name}`);
        const body = encodeURIComponent(
            `Hello,\n\n` +
            `I would like to order:\n\n` +
            `${quantity} x ${bundle.name}\n\n` +
            `Total: $${totalPrice.toFixed(2)}\n\n` +
            (campaignName ? `Fundraiser: ${campaignName}\n\n` : '') +
            `Name: \n` +
            `Phone: \n\n` +
            `Please let me know the next steps for payment and pickup.\n\nThank you!`
        );
        return `mailto:${coordinatorEmail}?subject=${subject}&body=${body}`;
    };

    // Reset quantity when modal closes
    const handleClose = () => {
        setQuantity(1);
        onClose();
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={handleClose}
                        className="fixed inset-0 bg-teal-950/20 backdrop-blur-md z-50 flex items-end sm:items-center justify-center sm:p-4"
                    >
                        {/* Modal */}
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0, y: 40 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.95, opacity: 0, y: 40 }}
                            transition={{ type: "spring", damping: 25, stiffness: 300 }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-white dark:bg-slate-900 w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[85vh] rounded-t-[2rem] sm:rounded-[3rem] shadow-[0_64px_128px_-32px_rgba(20,184,166,0.2)] overflow-hidden flex flex-col relative border border-white dark:border-white/10"
                        >
                            {/* Close Button */}
                            <button
                                onClick={handleClose}
                                className="absolute top-4 right-4 sm:top-6 sm:right-6 w-10 h-10 sm:w-12 sm:h-12 bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl rounded-full shadow-xl flex items-center justify-center text-slate-500 dark:text-slate-300 hover:scale-110 active:scale-95 transition-all z-20 border border-teal-50/50 dark:border-white/10"
                            >
                                <X size={20} />
                            </button>

                            {/* Scrollable Content */}
                            <div className="overflow-y-auto flex-1 scrollbar-hide overscroll-contain">
                                {/* Image Header */}
                                <div className="h-56 sm:h-80 relative bg-slate-100 dark:bg-slate-950 overflow-hidden">
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
                                    {bundle.serving_tier && (
                                        <div className="absolute top-6 left-6 sm:top-8 sm:left-8">
                                            <motion.span
                                                initial={{ x: -20, opacity: 0 }}
                                                animate={{ x: 0, opacity: 1 }}
                                                transition={{ delay: 0.2 }}
                                                className="bg-white/90 dark:bg-slate-900/90 backdrop-blur px-4 py-2 sm:px-5 sm:py-2.5 rounded-xl sm:rounded-2xl text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] text-brand-teal dark:text-teal-300 shadow-xl border border-white/40"
                                            >
                                                {bundle.serving_tier.replace('_', ' ')}
                                            </motion.span>
                                        </div>
                                    )}
                                </div>

                                <div className="px-5 sm:px-10 pb-6 sm:pb-10 -mt-8 sm:-mt-10 relative z-10 space-y-6 sm:space-y-10">
                                    {/* Header Info */}
                                    <div className="space-y-3 sm:space-y-4">
                                        <motion.h2
                                            initial={{ y: 20, opacity: 0 }}
                                            animate={{ y: 0, opacity: 1 }}
                                            transition={{ delay: 0.3 }}
                                            className="text-2xl sm:text-4xl font-black text-slate-900 dark:text-white tracking-tight leading-none"
                                        >
                                            {bundle.name}
                                        </motion.h2>
                                        <motion.p
                                            initial={{ y: 20, opacity: 0 }}
                                            animate={{ y: 0, opacity: 1 }}
                                            transition={{ delay: 0.4 }}
                                            className="text-slate-500 dark:text-slate-400 leading-relaxed text-sm sm:text-lg font-medium"
                                        >
                                            {bundle.description || "Indulge in our carefully selected rotation of home-style favorites."}
                                        </motion.p>
                                    </div>

                                    {/* Meals List — reads bundle.items[].recipe */}
                                    <div className="space-y-4 sm:space-y-6">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-[10px] font-black text-brand-teal uppercase tracking-[0.2em] flex items-center gap-2">
                                                <Utensils size={14} />
                                                Included in this bundle
                                            </h3>
                                        </div>

                                        <div className="grid grid-cols-1 gap-3 sm:gap-4">
                                            {(bundle.items || []).length > 0 ? (
                                                (bundle.items || []).map((item: any, idx: number) => (
                                                    <motion.div
                                                        key={item.id || idx}
                                                        initial={{ x: -20, opacity: 0 }}
                                                        animate={{ x: 0, opacity: 1 }}
                                                        transition={{ delay: 0.5 + (idx * 0.08) }}
                                                        className="flex gap-4 sm:gap-6 p-4 sm:p-6 rounded-2xl sm:rounded-[2.5rem] bg-teal-50/30 dark:bg-slate-800/50 border border-white/50 dark:border-white/5 group hover:bg-white dark:hover:bg-slate-800 hover:shadow-xl transition-all duration-500"
                                                    >
                                                        {item.recipe?.image_url ? (
                                                            <img
                                                                src={item.recipe.image_url}
                                                                alt={item.recipe.name || ''}
                                                                className="w-14 h-14 sm:w-16 sm:h-16 rounded-xl sm:rounded-[1.5rem] object-cover shadow-sm border border-teal-100/50 dark:border-slate-700 group-hover:scale-110 group-hover:-rotate-3 transition-transform shrink-0"
                                                            />
                                                        ) : (
                                                            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-xl sm:rounded-[1.5rem] bg-white dark:bg-slate-900 flex items-center justify-center text-lg sm:text-xl font-black text-brand-teal shadow-sm border border-teal-100/50 dark:border-slate-700 group-hover:scale-110 group-hover:-rotate-3 transition-transform shrink-0">
                                                                {Number(item.quantity) || 1}
                                                            </div>
                                                        )}
                                                        <div className="flex-1 space-y-0.5 sm:space-y-1 min-w-0">
                                                            <h4 className="font-black text-slate-900 dark:text-white text-base sm:text-lg tracking-tight truncate">
                                                                {item.recipe?.name || "Meal"}
                                                            </h4>
                                                            {item.recipe?.description && (
                                                                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium leading-relaxed line-clamp-2">
                                                                    {item.recipe.description}
                                                                </p>
                                                            )}
                                                            {item.recipe?.cook_time && (
                                                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                                                                    🕐 {item.recipe.cook_time}
                                                                </p>
                                                            )}
                                                        </div>
                                                    </motion.div>
                                                ))
                                            ) : (
                                                <div className="bg-slate-50 dark:bg-slate-800/30 p-8 sm:p-12 rounded-2xl sm:rounded-[2.5rem] border-2 border-dashed border-teal-100/50 dark:border-slate-800 text-center">
                                                    <UtensilsCrossed size={24} className="mx-auto mb-3 text-slate-300" />
                                                    <p className="text-slate-400 font-black text-xs uppercase tracking-widest italic">Menu being finalized</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Footer / CTA */}
                            <div className="p-5 sm:p-8 border-t border-teal-50 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl">
                                <div className="flex items-center justify-between mb-4 sm:mb-6">
                                    <div className="space-y-0.5">
                                        <p className="text-3xl sm:text-4xl font-black text-slate-900 dark:text-white tracking-tighter">
                                            ${price.toFixed(2)}
                                        </p>
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: primaryColor }}>
                                            ~${Math.round(costPerMeal)} / Meal
                                        </p>
                                    </div>

                                    {/* Quantity Selector */}
                                    {fundraiserMode && (
                                        <div className="flex items-center gap-0 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                                            <button
                                                onClick={() => setQuantity(q => Math.max(1, q - 1))}
                                                className="w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-90 transition-all"
                                                aria-label="Decrease quantity"
                                            >
                                                <Minus size={18} strokeWidth={3} />
                                            </button>
                                            <span className="w-12 sm:w-14 text-center text-lg sm:text-xl font-black text-slate-900 dark:text-white tabular-nums">
                                                {quantity}
                                            </span>
                                            <button
                                                onClick={() => setQuantity(q => q + 1)}
                                                className="w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-90 transition-all"
                                                aria-label="Increase quantity"
                                            >
                                                <Plus size={18} strokeWidth={3} />
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {/* Show total when quantity > 1 */}
                                {fundraiserMode && quantity > 1 && (
                                    <div className="flex items-center justify-between mb-4 px-1 text-sm">
                                        <span className="text-slate-500 font-bold">{quantity} × ${price.toFixed(2)}</span>
                                        <span className="font-black text-slate-900 dark:text-white text-lg">Total: ${totalPrice.toFixed(2)}</span>
                                    </div>
                                )}

                                {/* Fundraiser email CTA */}
                                {fundraiserMode && coordinatorEmail ? (
                                    <a
                                        href={buildMailtoUrl()}
                                        className="w-full h-14 sm:h-16 rounded-2xl sm:rounded-[2rem] font-black text-white shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-3 text-sm sm:text-base tracking-tight"
                                        style={{ backgroundColor: primaryColor }}
                                    >
                                        <Mail size={20} strokeWidth={3} />
                                        Order {quantity > 1 ? `${quantity} Bundles` : 'This Bundle'}
                                        <ArrowRight size={18} />
                                    </a>
                                ) : onAddToCart ? (
                                    <button
                                        onClick={() => onAddToCart(quantity)}
                                        style={{ backgroundColor: primaryColor }}
                                        className="w-full h-16 sm:h-20 rounded-2xl sm:rounded-[2.5rem] font-black text-white shadow-[0_24px_48px_-12px_rgba(20,184,166,0.4)] hover:shadow-[0_32px_64px_-16px_rgba(20,184,166,0.5)] hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-4 text-lg sm:text-xl tracking-tight"
                                    >
                                        Reserve My Bundle
                                        <ArrowRight size={24} />
                                    </button>
                                ) : null}
                            </div>
                        </motion.div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
