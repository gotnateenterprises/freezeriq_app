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
    };
    primaryColor: string;
}

export default function PurchaseSidebar({ bundle, primaryColor }: PurchaseSidebarProps) {
    const { addToCart } = useCart();
    const [isSubscription, setIsSubscription] = useState(true);
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
    const price = isSubscription ? bundlePrice * 0.9 : bundlePrice;

    const handleAdd = () => {
        setIsAdding(true);

        // Use cart context to add
        addToCart({
            bundleId: bundle.id,
            name: bundle.name,
            price: price,
            image_url: bundle.image_url || '',
            serving_tier: bundle.serving_tier || (servingSize === 'large' ? 'family' : 'couples'),
            quantity: quantity,
            isSubscription: isSubscription
        });

        setTimeout(() => {
            setIsAdding(false);
            setShowSuccess(true);
            setTimeout(() => setShowSuccess(false), 3000);
        }, 800);
    };

    return (
        <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl rounded-[2.5rem] p-6 sm:p-8 shadow-[0_24px_48px_-12px_rgba(79,70,229,0.12)] border border-indigo-50/50 dark:border-slate-700 w-full max-w-full">
            <div className="mb-6">
                <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2 tracking-tight">{bundle.name}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                    {bundle.description || "Fresh freezer meals prepped with care."}
                </p>
            </div>

            {/* Price Selection */}
            <div className="space-y-3 mb-8">
                <button
                    onClick={() => setIsSubscription(true)}
                    className={`w-full text-left p-4 rounded-3xl border-2 transition-all relative group/btn ${isSubscription
                        ? "border-indigo-600 bg-indigo-50/10 shadow-sm"
                        : "border-slate-100 dark:border-slate-700 hover:border-indigo-200"
                        }`}
                >
                    {isSubscription && (
                        <div className="absolute top-2 right-4 bg-indigo-600 text-white text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest animate-bounce">
                            Save 10%
                        </div>
                    )}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSubscription ? "border-indigo-600" : "border-slate-300"}`}>
                                {isSubscription && <motion.div layoutId="dot" className="w-2.5 h-2.5 rounded-full bg-indigo-600" />}
                            </div>
                            <div>
                                <p className="font-black text-slate-900 dark:text-white tracking-tight">Subscribe & Save</p>
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Cancel or skip anytime</p>
                            </div>
                        </div>
                        <p className="text-lg font-black text-indigo-600">${price.toFixed(2)}</p>
                    </div>
                </button>

                <button
                    onClick={() => setIsSubscription(false)}
                    className={`w-full text-left p-4 rounded-3xl border-2 transition-all group/btn ${!isSubscription
                        ? "border-indigo-600 bg-indigo-50/10 shadow-sm"
                        : "border-slate-100 dark:border-slate-700 hover:border-indigo-200"
                        }`}
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${!isSubscription ? "border-indigo-600" : "border-slate-300"}`}>
                                {!isSubscription && <motion.div layoutId="dot" className="w-2.5 h-2.5 rounded-full bg-indigo-600" />}
                            </div>
                            <div>
                                <p className="font-black text-slate-900 dark:text-white tracking-tight">One-time Purchase</p>
                            </div>
                        </div>
                        <p className="text-lg font-black text-slate-400">${bundlePrice.toFixed(2)}</p>
                    </div>
                </button>
            </div>

            {/* Serving Size Toggle */}
            <div className="space-y-3 mb-8 w-full">
                <label className="text-[10px] font-black uppercase text-indigo-400 tracking-[0.2em] ml-1">Select Size</label>
                <div className="bg-slate-50 dark:bg-slate-950 p-1.5 rounded-2xl flex flex-col min-[400px]:flex-row border border-indigo-50/50 dark:border-slate-800 w-full max-w-full">
                    <button
                        onClick={() => setServingSize('large')}
                        className={`flex-1 py-3 px-2 rounded-xl font-black text-[9px] sm:text-[10px] uppercase tracking-wider transition-all min-w-0 ${servingSize === 'large'
                            ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-xl"
                            : "text-slate-400 hover:text-slate-600"
                            }`}
                    >
                        Large <span className="hidden sm:inline">(5-6)</span>
                    </button>
                    <button
                        onClick={() => setServingSize('medium')}
                        className={`flex-1 py-3 px-2 rounded-xl font-black text-[9px] sm:text-[10px] uppercase tracking-wider transition-all min-w-0 ${servingSize === 'medium'
                            ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-xl"
                            : "text-slate-400 hover:text-slate-600"
                            }`}
                    >
                        Small <span className="hidden sm:inline">(2-3)</span>
                    </button>
                </div>
            </div>

            {/* Quantity Selector */}
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
                    style={{ backgroundColor: primaryColor }}
                    className="w-full py-5 rounded-[2.5rem] text-white font-black text-xl shadow-[0_20px_40px_-12px_rgba(79,70,229,0.4)] transition-all hover:scale-[1.03] active:scale-95 flex items-center justify-center gap-3 disabled:opacity-80"
                >
                    {isAdding ? (
                        <Loader2 className="animate-spin" size={24} />
                    ) : (
                        <>
                            <ShoppingBag size={24} />
                            Add to Cart
                        </>
                    )}
                </button>
            </div>

            {/* Benefits List */}
            <div className="mt-10 pt-8 border-t border-indigo-100/30 dark:border-slate-800 space-y-5">
                {[
                    "Easy-to-use Slow Cooker Meals",
                    "A Mom-Built local business",
                    "Perfect for busy weeknights",
                    "Hand-prepped with fresh ingredients"
                ].map((benefit, i) => (
                    <div key={i} className="flex items-center gap-4 text-slate-500 dark:text-slate-400">
                        <div className="w-6 h-6 rounded-xl bg-indigo-50/50 dark:bg-indigo-950/50 text-indigo-600 flex items-center justify-center shadow-sm">
                            <Check size={14} strokeWidth={3} />
                        </div>
                        <span className="text-[10px] font-black tracking-widest uppercase">{benefit}</span>
                    </div>
                ))}
            </div>

            <div className="mt-8 p-6 bg-indigo-50/30 dark:bg-indigo-950/20 rounded-[2rem] flex items-start gap-4 border border-indigo-100/20">
                <Info size={20} className="text-indigo-400 shrink-0" />
                <p className="text-[10px] text-indigo-600/60 dark:text-indigo-400/60 leading-relaxed font-black uppercase tracking-wider">
                    Our monthly menu rotates on the 1st. Subscriptions are automatically updated to the newest items!
                </p>
            </div>
        </div>
    );
}
