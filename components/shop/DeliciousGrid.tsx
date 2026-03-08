"use client";

import React from 'react';
import { motion } from 'framer-motion';

interface DeliciousGridProps {
    images?: string[];
    recipes?: any[];
    onItemClick?: (recipe: any) => void;
}

export default function DeliciousGrid({ images = [], recipes = [], onItemClick }: DeliciousGridProps) {
    const [loadedIndices, setLoadedIndices] = React.useState<Set<number>>(new Set());

    const handleImageLoad = (index: number) => {
        setLoadedIndices(prev => {
            const newSet = new Set(prev);
            newSet.add(index);
            return newSet;
        });
    };

    // If we have recipes, we use them as the source of truth
    const items = recipes.length > 0 ? recipes.map((r, i) => {
        const recipeObj = typeof r === 'string' ? { name: r, image_url: images[i] } : r;
        return {
            ...recipeObj,
            name: recipeObj.name,
            image: recipeObj.image_url || images[i] || "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=2071&auto=format&fit=crop"
        };
    }) : [
        // ... defaults ...
        { name: "Healthy Harvest", image: "https://images.unsplash.com/photo-1547592166-23ac45744acd?q=80&w=2071&auto=format&fit=crop" },
        { name: "Savory Selections", image: "https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?q=80&w=2070&auto=format&fit=crop" },
        { name: "Family Favorites", image: "https://images.unsplash.com/photo-158503222665a-719976ec8dfc?q=80&w=1982&auto=format&fit=crop" },
        { name: "Fresh & Green", image: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=2070&auto=format&fit=crop" }
    ];

    return (
        <div className="flex overflow-x-auto gap-4 p-4 pb-8 snap-x snap-mandatory relative z-10 w-full" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
            <style jsx>{`
                div::-webkit-scrollbar {
                    display: none;
                }
            `}</style>
            {items.map((item, idx) => (
                <motion.div
                    key={idx}
                    initial={{ opacity: 0, scale: 0.95 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ delay: idx * 0.1, duration: 0.6, ease: "easeOut" }}
                    onClick={() => onItemClick?.(item)}
                    className={`relative group/grid overflow-hidden rounded-[3rem] shadow-lg hover:shadow-2xl transition-all duration-500 border border-slate-100 dark:border-slate-800 cursor-pointer snap-center shrink-0 w-[85vw] sm:w-[60vw] md:w-[45vw] lg:w-[35vw] aspect-square`}
                >
                    {/* Background Ethereal Fill (Prevents Pixelation for small vertical/horizontal files) */}
                    <div className="absolute inset-0 z-0 select-none pointer-events-none overflow-hidden origin-center scale-110">
                        <img
                            src={item.image}
                            alt=""
                            className="w-full h-full object-cover blur-3xl opacity-30 dark:opacity-20"
                        />
                    </div>

                    {/* Loading Skeleton */}
                    {!loadedIndices.has(idx) && (
                        <div className="absolute inset-0 bg-slate-200 dark:bg-slate-800 animate-pulse z-10" />
                    )}

                    {/* Main Image - "Smart Frame" ensures it doesn't over-zoom */}
                    <div className="absolute inset-0 z-1 flex items-center justify-center p-4">
                        <img
                            src={item.image}
                            alt={item.name}
                            onLoad={() => handleImageLoad(idx)}
                            className={`max-w-full max-h-full w-full h-full object-cover transform group-hover/grid:scale-105 transition-transform duration-700 ease-in-out rounded-[2rem] ${loadedIndices.has(idx) ? 'opacity-100' : 'opacity-0'
                                }`}
                        />
                    </div>

                    {/* Premium Gradient Overlay */}
                    <div className="absolute inset-0 z-2 bg-linear-to-t from-black/60 via-black/10 to-transparent group-hover/grid:from-black/70 transition-all duration-500" />

                    {/* Content Overlay */}
                    <div className="absolute inset-x-0 bottom-0 p-8 z-3 translate-y-2 group-hover/grid:translate-y-0 transition-transform duration-500">
                        <div className="overflow-hidden">
                            <p className="text-white font-serif text-2xl md:text-4xl tracking-tight mb-2 transform translate-y-0 transition-transform duration-500 drop-shadow-lg">
                                {item.name}
                            </p>
                            {item.description && (
                                <p className="text-white/80 text-xs md:text-sm font-medium mb-4 line-clamp-2 transform translate-y-0 transition-transform duration-500 drop-shadow-md">
                                    {item.description}
                                </p>
                            )}
                            <div className="flex items-center gap-2 opacity-0 group-hover/grid:opacity-100 transform translate-y-4 group-hover/grid:translate-y-0 transition-all duration-500 delay-75">
                                <div className="h-px w-8 bg-brand-rose" />
                                <p className="text-pink-100 text-[10px] font-black uppercase tracking-[0.2em]">
                                    {item.cook_time ? `Ready in ${item.cook_time}` : "Chef's Special"}
                                </p>
                            </div>
                        </div>
                    </div>
                </motion.div>
            ))}
        </div>
    );
}
