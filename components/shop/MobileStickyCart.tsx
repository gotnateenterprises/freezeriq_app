"use client";

import { motion, AnimatePresence } from 'framer-motion';
import { ShoppingBag } from 'lucide-react';
import { useCart } from '@/context/CartContext';
import { getContrastTextClass } from '@/lib/colorUtils';
import { useEffect, useState } from 'react';

interface MobileStickyCartProps {
    bundle: any;
    primaryColor: string;
}

export default function MobileStickyCart({ bundle, primaryColor }: MobileStickyCartProps) {
    const { addToCart, setIsCartOpen } = useCart();
    const [isVisible, setIsVisible] = useState(false);

    // Only show after scrolling down a bit past the hero
    useEffect(() => {
        const handleScroll = () => {
            if (window.scrollY > 300) {
                setIsVisible(true);
            } else {
                setIsVisible(false);
            }
        };

        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    if (!bundle) return null;

    const textClass = getContrastTextClass(primaryColor || '#0ea5e9');

    const handleCheckout = () => {
        addToCart({
            bundleId: bundle.id,
            name: bundle.name,
            price: Number(bundle.price),
            image_url: bundle.image_url,
            serving_tier: bundle.serving_tier,
            quantity: 1
        });
        setIsCartOpen(true);
    };

    return (
        <AnimatePresence>
            {isVisible && (
                <div className="fixed bottom-0 left-0 right-0 z-40 lg:hidden p-4 pointer-events-none">
                    <motion.div
                        initial={{ y: 100, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: 100, opacity: 0 }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-2xl border border-white dark:border-slate-800 shadow-[0_-8px_32px_-12px_rgba(0,0,0,0.1)] p-4 rounded-3xl flex items-center justify-between gap-4 pointer-events-auto"
                    >
                        <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-slate-500 truncate mb-0.5">{bundle.name}</p>
                            <div className="flex items-baseline gap-1.5">
                                <span className="text-xl font-black text-slate-900 dark:text-white">
                                    ${Number(bundle.price).toFixed(2)}
                                </span>
                            </div>
                        </div>

                        <button
                            onClick={handleCheckout}
                            style={{ backgroundColor: primaryColor || '#0ea5e9' }}
                            className={`flex-shrink-0 px-6 py-3.5 rounded-2xl font-black text-sm uppercase tracking-widest hover:scale-105 active:scale-95 transition-all flex items-center gap-2 shadow-lg ${textClass}`}
                        >
                            <ShoppingBag size={18} />
                            Checkout
                        </button>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
