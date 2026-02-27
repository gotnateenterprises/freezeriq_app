"use client";

import React, { useRef, useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Filter, ChevronRight, ChevronLeft } from 'lucide-react';

interface FilterBarProps {
    availableTags: string[];
    activeFilters: string[];
    onToggleFilter: (tag: string) => void;
    primaryColor?: string;
}

export default function FilterBar({ availableTags, activeFilters, onToggleFilter, primaryColor = '#10b981' }: FilterBarProps) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [showLeftGradient, setShowLeftGradient] = useState(false);
    const [showRightGradient, setShowRightGradient] = useState(false);

    const checkScroll = () => {
        if (!scrollContainerRef.current) return;
        const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
        setShowLeftGradient(scrollLeft > 0);
        setShowRightGradient(scrollLeft < scrollWidth - clientWidth - 2);
    };

    useEffect(() => {
        checkScroll();
        window.addEventListener('resize', checkScroll);
        return () => window.removeEventListener('resize', checkScroll);
    }, [availableTags]);

    if (availableTags.length === 0) return null;

    return (
        <div className="relative w-full mb-6">
            {/* Filter Icon Indicator */}
            <div className="flex items-center gap-2 mb-3 px-2">
                <Filter size={14} className="text-slate-400" />
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Dietary & Macros</span>
            </div>

            {/* Scroll Container */}
            <div className="relative group/scroll">
                {showLeftGradient && (
                    <div className="absolute left-0 top-0 bottom-0 w-16 bg-gradient-to-r from-brand-cream dark:from-slate-950 to-transparent z-10 pointer-events-none" />
                )}

                <div
                    ref={scrollContainerRef}
                    onScroll={checkScroll}
                    className="flex overflow-x-auto hide-scrollbar gap-2 px-1 pb-4 pt-1 snap-x select-none"
                    style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                    {availableTags.map((tag) => {
                        const isActive = activeFilters.includes(tag);
                        return (
                            <motion.button
                                key={tag}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => onToggleFilter(tag)}
                                className={`snap-start shrink-0 px-5 py-2.5 rounded-full text-xs font-black uppercase tracking-widest transition-all duration-300 border shadow-sm ${isActive
                                    ? 'text-white border-transparent'
                                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
                                    }`}
                                style={isActive ? { backgroundColor: primaryColor, boxShadow: `0 4px 14px 0 ${primaryColor}40` } : {}}
                            >
                                {tag}
                            </motion.button>
                        );
                    })}
                </div>

                {showRightGradient && (
                    <div className="absolute right-0 top-0 bottom-0 w-16 bg-gradient-to-l from-brand-cream dark:from-slate-950 to-transparent z-10 pointer-events-none" />
                )}
            </div>
        </div >
    );
}
