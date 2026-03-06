"use client";

import { useState } from 'react';
import { Plus, Minus, MessageSquare, ShoppingCart, Tag, Flame, Timer, ChefHat } from 'lucide-react';
import { motion } from 'framer-motion';

interface StorefrontProductCardProps {
    bundle: {
        id: string;
        name: string;
        description: string;
        price: number;
        image_url?: string;
        stock_on_hand: number;
        serving_tier: string;
        sku?: string;
        is_surplus?: boolean;
        contents?: {
            recipe: {
                container_type?: string | null;
            };
        }[];
    };
    primaryColor: string;
    onAddToCart: (params: { quantity: number; bundleId: string; name: string; price: number; image_url?: string; serving_tier: string }) => void;
    onViewDetails?: () => void;
    onSelect?: () => void;
    isActive?: boolean;
}

export default function StorefrontProductCard({ bundle, primaryColor, onAddToCart, onViewDetails, onSelect, isActive }: StorefrontProductCardProps) {
    const [quantity, setQuantity] = useState(1);
    const [isHovered, setIsHovered] = useState(false);

    const price = Number(bundle.price || 0);
    const servings = (bundle.serving_tier.toLowerCase().includes('serves_2') || bundle.serving_tier === 'couple') ? 2 : 5;
    const costPerServing = price / servings;
    const isLowStock = bundle.stock_on_hand > 0 && bundle.stock_on_hand <= 5;

    // Logic: Regular bundles are Preorders (always Order Now). Surplus follows stock.
    const isSurplus = bundle.is_surplus;
    const isOutOfStock = bundle.stock_on_hand <= 0;
    const showSoldOut = isSurplus && isOutOfStock;

    // Dynamically derive required cooking methods based on recipe packaging
    const hasSlowCooker = bundle.contents?.some(c => c.recipe?.container_type?.includes('ziplock_bag'));
    const hasOvenReady = bundle.contents?.some(c => c.recipe?.container_type?.includes('tray') || c.recipe?.container_type?.includes('pan'));

    const cookingMethods = [];
    if (hasSlowCooker) {
        cookingMethods.push({ icon: ChefHat, label: "Slow Cooker" });
        cookingMethods.push({ icon: Timer, label: "Instant Pot" });
    }
    if (hasOvenReady) {
        cookingMethods.push({ icon: Flame, label: "Oven Ready" });
    }
    // Fallback if empty
    if (cookingMethods.length === 0) {
        cookingMethods.push({ icon: Flame, label: "Oven Ready" });
        cookingMethods.push({ icon: ChefHat, label: "Slow Cooker" });
    }

    const handleIncrement = () => {
        // If surplus, respect stock limit. If preorder (not surplus), allow unlimited selection or 99?
        if (isSurplus) {
            if (quantity < bundle.stock_on_hand) setQuantity(prev => prev + 1);
        } else {
            setQuantity(prev => prev + 1);
        }
    };

    const handleDecrement = () => {
        if (quantity > 1) setQuantity(prev => prev - 1);
    };

    const handleAdd = () => {
        onAddToCart({
            quantity,
            bundleId: bundle.id,
            name: bundle.name,
            price,
            image_url: bundle.image_url,
            serving_tier: bundle.serving_tier
        });
        setQuantity(1);
    };

    return (
        <div
            className={`group bg-white dark:bg-slate-900 rounded-[3.5rem] overflow-hidden shadow-[0_24px_48px_-12px_rgba(79,70,229,0.05)] border transition-all duration-700 flex flex-col h-full cursor-pointer
                ${isActive ? 'border-brand-teal ring-4 ring-teal-500/10 scale-[1.02]' : 'border-indigo-50/50 dark:border-slate-800 hover:shadow-[0_40px_80px_-16px_rgba(20,184,166,0.1)] hover:scale-[1.02]'}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            onClick={onSelect}
        >
            {/* Image Section - Smart Frame Logic */}
            <div className="h-80 relative bg-linear-to-br from-brand-cream to-white dark:from-slate-950 dark:to-slate-900 overflow-hidden">
                {/* Background Blur Fill */}
                {bundle.image_url && (
                    <div className="absolute inset-0 z-0 opacity-40 select-none pointer-events-none scale-110 blur-2xl">
                        <img src={bundle.image_url} alt="" className="w-full h-full object-cover" />
                    </div>
                )}

                {bundle.image_url ? (
                    <div className="absolute inset-4 z-1 flex items-center justify-center overflow-hidden rounded-[2.5rem] shadow-inner bg-white/40 dark:bg-black/20 backdrop-blur-sm border border-white/20">
                        <motion.img
                            src={bundle.image_url}
                            alt={bundle.name}
                            className="w-full h-full object-cover cursor-pointer"
                            animate={{ scale: isHovered ? 1.05 : 1 }}
                            transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
                            onClick={onViewDetails}
                        />
                    </div>
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-indigo-100 dark:text-slate-800">
                        <Tag size={64} className="mb-2 opacity-50" />
                        <span className="font-black opacity-50 text-[10px] uppercase tracking-[0.2em]">No Image</span>
                    </div>
                )}

                {/* Overlays */}
                <div className="absolute inset-0 z-2 bg-linear-to-t from-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                <div className="absolute top-8 left-8 z-3 flex flex-col gap-2">
                    <span className="bg-white/95 dark:bg-slate-900/95 backdrop-blur px-5 py-2 rounded-full text-[9px] font-black uppercase tracking-[0.15em] text-brand-teal dark:text-teal-300 shadow-xl border border-white/40 inline-flex items-center gap-1.5 self-start">
                        <div className="w-1.5 h-1.5 rounded-full bg-brand-teal animate-pulse" />
                        {bundle.serving_tier.toLowerCase().includes('serves_2') ? '2 Servings' :
                            bundle.serving_tier.toLowerCase().includes('serves_5') ? '5 Servings' :
                                bundle.serving_tier === 'couple' ? '2 Servings' :
                                    bundle.serving_tier === 'family' ? 'Family Friendly' :
                                        bundle.serving_tier.replace('_', ' ')}
                    </span>
                </div>

                {isLowStock && isSurplus && (
                    <span className="bg-emerald-500 text-white px-5 py-2 rounded-full text-[9px] font-black uppercase tracking-[0.15em] shadow-xl animate-pulse self-start">
                        Only {Math.round(bundle.stock_on_hand)} left
                    </span>
                )}
            </div>

            {/* Content Section */}
            <div className="p-10 flex flex-col flex-grow">
                <div className="mb-8">
                    <div className="flex justify-between items-start mb-4">
                        <h3 className="font-serif text-3xl text-slate-900 dark:text-white leading-[1.1] tracking-tight group-hover:text-brand-teal transition-colors">
                            {bundle.name}
                        </h3>
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400 line-clamp-3 leading-relaxed font-medium">
                        {bundle.description}
                    </p>
                </div>

                {/* Cooking Methods - Dynamic Icons */}
                <div className="flex items-center flex-wrap gap-4 mb-10">
                    {cookingMethods.map((method, i) => (
                        <div key={i} className="flex items-center gap-2 opacity-60 group-hover:opacity-100 transition-opacity duration-700">
                            <div className="w-7 h-7 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-brand-teal">
                                <method.icon size={12} strokeWidth={2.5} />
                            </div>
                            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{method.label}</span>
                        </div>
                    ))}
                </div>

                <div className="mt-auto space-y-8 pt-8 border-t border-slate-50 dark:border-slate-800">
                    {/* Price Row */}
                    <div className="flex items-end justify-between">
                        <div>
                            <p className="text-4xl font-serif text-slate-900 dark:text-white tracking-widest">
                                <span className="text-xl font-sans font-bold text-brand-teal mr-1">$</span>{price.toFixed(0)}<span className="text-lg font-sans opacity-40">.00</span>
                            </p>
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mt-2">
                                ~${costPerServing.toFixed(2)} / serving
                            </p>
                        </div>
                        {onViewDetails && (
                            <button
                                onClick={onViewDetails}
                                className="w-12 h-12 rounded-full bg-white dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-800 flex items-center justify-center text-slate-400 hover:text-brand-teal hover:border-brand-teal/30 transition-all active:scale-95"
                            >
                                <MessageSquare size={20} />
                            </button>
                        )}
                    </div>

                    {/* Actions Row */}
                    {!showSoldOut ? (
                        <div className="flex items-center gap-4">
                            <div className="flex items-center bg-slate-50/50 dark:bg-slate-950 rounded-[1.25rem] p-1.5 border border-slate-100 dark:border-slate-800">
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleDecrement(); }}
                                    disabled={quantity <= 1}
                                    className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-white dark:hover:bg-slate-800 text-slate-400 hover:text-brand-teal transition-all disabled:opacity-30 active:scale-75"
                                >
                                    <Minus size={16} strokeWidth={3} />
                                </button>
                                <span className="font-serif w-10 text-center text-xl text-slate-900 dark:text-white">{quantity}</span>
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleIncrement(); }}
                                    disabled={isSurplus && quantity >= bundle.stock_on_hand}
                                    className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-white dark:hover:bg-slate-800 text-slate-400 hover:text-brand-teal transition-all disabled:opacity-30 active:scale-75"
                                >
                                    <Plus size={16} strokeWidth={3} />
                                </button>
                            </div>

                            <button
                                onClick={(e) => { e.stopPropagation(); handleAdd(); }}
                                style={{ backgroundColor: primaryColor }}
                                className="flex-1 h-14 rounded-2xl font-black text-white shadow-xl shadow-brand-teal/20 hover:shadow-brand-teal/40 hover:scale-[1.03] active:scale-95 transition-all duration-300 flex items-center justify-center gap-3 bg-linear-to-br from-brand-teal to-teal-700"
                            >
                                <ShoppingCart size={20} strokeWidth={2.5} />
                                <span className="text-[10px] uppercase tracking-[0.2em]">{isSurplus ? 'Add' : 'Order Now'}</span>
                            </button>
                        </div>
                    ) : (
                        <div className="w-full h-14 bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-slate-400 rounded-2xl font-black text-xs uppercase tracking-[0.2em] flex items-center justify-center cursor-not-allowed">
                            Sold Out
                        </div>
                    )}
                </div>
            </div >
        </div >
    );
}
