"use client";

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ShoppingBag, Info, Loader2, Sparkles } from 'lucide-react';
import { useCart } from '@/context/CartContext';

interface PurchaseSidebarProps {
    bundle: {
        id: string;
        name: string;
        price: number;
        description: string;
        image_url?: string;
        serving_tier?: string;
        is_donation?: boolean;
    };
    primaryColor: string;
    onViewMenu?: () => void;
}

export default function PurchaseSidebar({ bundle, primaryColor, onViewMenu }: PurchaseSidebarProps) {
    const { addToCart } = useCart();
    const [servingSize, setServingSize] = useState<'large' | 'medium'>('large'); // 'large' or 'medium'
    const [quantity, setQuantity] = useState(1);
    const [isAdding, setIsAdding] = useState(false);
    const [showSuccess, setShowSuccess] = useState(false);

    useEffect(() => {
        setQuantity(1);
    }, [bundle.id]);

    // Auto-select size based on bundle tier
    useEffect(() => {
        if (bundle.serving_tier === 'family') {
            setServingSize('large');
        } else if (bundle.serving_tier === 'couples') {
            setServingSize('medium');
        }
    }, [bundle.serving_tier, bundle.id]);

    const bundlePrice = Number(bundle.price || 0);

    const handleAdd = () => {
        setIsAdding(true);

        // Use cart context to add
        addToCart({
            bundleId: bundle.id,
            name: bundle.name,
            price: bundlePrice,
            image_url: bundle.image_url || '',
            serving_tier: bundle.serving_tier || (servingSize === 'large' ? 'family' : 'couples'),
            quantity: quantity,
            isSubscription: false // default single purchase for now
        });

        setTimeout(() => {
            setIsAdding(false);
            setShowSuccess(true);
            setTimeout(() => setShowSuccess(false), 3000);
        }, 800);
    };

    return (
        <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl rounded-[2.5rem] p-8 shadow-[0_24px_48px_-12px_rgba(79,70,229,0.12)] border border-indigo-50/50 dark:border-slate-700">
            <div className="mb-6">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2 tracking-tight">{bundle.name}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                    {bundle.description || "Fresh freezer meals prepped with care."}
                </p>
            </div>

            {/* Bundle Price & Summary */}
            <div className="flex items-center justify-between mb-8 bg-indigo-50/10 p-4 border border-indigo-100 dark:border-slate-700/50 rounded-3xl">
                <div>
                    <p className="font-black text-slate-900 dark:text-white tracking-tight">Total Price</p>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">One-Time Box</p>
                </div>
                <p className="text-2xl font-black text-indigo-600">${(bundlePrice * quantity).toFixed(2)}</p>
            </div>

            {/* Serving Size Toggle */}
            {!bundle.is_donation && (
                <div className="space-y-3 mb-8">
                    <label className="text-[10px] font-black uppercase text-indigo-400 tracking-[0.2em] ml-1">Select Size</label>
                    <div className="bg-slate-50 dark:bg-slate-950 p-1.5 rounded-2xl flex border border-indigo-50/50 dark:border-slate-800">
                        <button
                            onClick={() => setServingSize('large')}
                            className={`flex-1 py-3.5 rounded-xl font-black text-[10px] uppercase tracking-wider transition-all ${servingSize === 'large'
                                ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-xl"
                                : "text-slate-400 hover:text-slate-600"
                                }`}
                        >
                            Large Family (5-6)
                        </button>
                        <button
                            onClick={() => setServingSize('medium')}
                            className={`flex-1 py-3.5 rounded-xl font-black text-[10px] uppercase tracking-wider transition-all ${servingSize === 'medium'
                                ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-xl"
                                : "text-slate-400 hover:text-slate-600"
                                }`}
                        >
                            Half Family (2-3)
                        </button>
                    </div>
                </div>
            )}

            {/* Quantity Selector */}
            {!bundle.is_donation && (
                <div className="flex items-center justify-between mb-8 px-1">
                    <label className="text-[10px] font-black uppercase text-indigo-400 tracking-[0.2em]">Quantity</label>
                    <div className="flex items-center bg-white dark:bg-slate-900 rounded-2xl p-1 shadow-sm border border-indigo-50 dark:border-slate-800">
                        <button
                            onClick={() => setQuantity(Math.max(1, quantity - 1))}
                            className="w-12 h-12 flex items-center justify-center text-slate-400 hover:text-indigo-600 transition-all font-black text-2xl active:scale-75"
                        >
                            -
                        </button>
                        <span className="w-10 text-center font-black text-slate-900 dark:text-white text-xl">{quantity}</span>
                        <button
                            onClick={() => setQuantity(quantity + 1)}
                            className="w-12 h-12 flex items-center justify-center text-slate-400 hover:text-indigo-600 transition-all font-black text-2xl active:scale-75"
                        >
                            +
                        </button>
                    </div>
                </div>
            )}

            {/* CTA Button */}
            <div className="relative">
                <AnimatePresence>
                    {showSuccess && (
                        <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.9 }}
                            animate={{ opacity: 1, y: -40, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            className="absolute inset-x-0 flex justify-center z-30 pointer-events-none"
                        >
                            <div className="bg-emerald-500 text-white px-6 py-2 rounded-full shadow-xl font-black text-xs uppercase tracking-widest flex items-center gap-2">
                                <Sparkles size={14} /> Added to Cart!
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <button
                    onClick={handleAdd}
                    disabled={isAdding}
                    style={bundle.is_donation ? {} : { backgroundColor: primaryColor }}
                    className={`w-full py-5 rounded-[2.5rem] text-white font-black text-xl shadow-[0_20px_40px_-12px_rgba(79,70,229,0.4)] transition-all hover:scale-[1.03] active:scale-95 flex items-center justify-center gap-3 disabled:opacity-80
                        ${bundle.is_donation ? 'bg-pink-600 shadow-[0_20px_40px_-12px_rgba(219,39,119,0.4)] hover:bg-pink-500' : ''}`}
                >
                    {isAdding ? (
                        <Loader2 className="animate-spin" size={24} />
                    ) : (
                        <>
                            <ShoppingBag size={24} />
                            {bundle.is_donation ? 'Donate Now' : 'Add to Cart'}
                        </>
                    )}
                </button>

                {onViewMenu && !bundle.is_donation && (
                    <button
                        onClick={onViewMenu}
                        className="w-full mt-3 py-3 rounded-2xl text-indigo-600 font-bold text-sm bg-indigo-50/50 hover:bg-indigo-100 transition-colors"
                    >
                        View Meals in this Bundle &rarr;
                    </button>
                )}
            </div>

            {/* Benefits List */}
            {!bundle.is_donation && (
                <div className="mt-10 pt-8 border-t border-indigo-100/30 dark:border-slate-800 space-y-5">
                    {[
                        "Easy-to-use Slow Cooker and Oven meals",
                        "A Mom-Built local business",
                        "Perfect for busy weeknights",
                        "Hand-prepped with fresh, restaurant quality ingredients"
                    ].map((benefit, i) => (
                        <div key={i} className="flex items-center gap-4 text-slate-500 dark:text-slate-400">
                            <div className="w-6 h-6 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/50 text-indigo-600 flex items-center justify-center shadow-sm">
                                <Check size={14} strokeWidth={3} />
                            </div>
                            <span className="text-[10px] font-black tracking-widest uppercase">{benefit}</span>
                        </div>
                    ))}
                </div>
            )}

        </div >
    );
}
