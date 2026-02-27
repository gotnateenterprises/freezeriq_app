"use client";

import { motion, AnimatePresence } from 'framer-motion';
import { ShoppingBag } from 'lucide-react';
import { useCart } from '@/context/CartContext';
import { getContrastTextClass } from '@/lib/colorUtils';
import { useEffect, useState } from 'react';

interface MobileStickyCartProps {
    primaryColor: string;
}

export default function MobileStickyCart({ primaryColor }: MobileStickyCartProps) {
    const { setIsCartOpen, cartCount } = useCart();
    const [isVisible, setIsVisible] = useState(false);

    // Show the FAB after scrolling past the immersive hero section
    useEffect(() => {
        const handleScroll = () => {
            if (window.scrollY > 200) {
                setIsVisible(true);
            } else {
                setIsVisible(false);
            }
        };

        window.addEventListener('scroll', handleScroll);
        // Fire once to check initial scroll
        handleScroll();

        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const textClass = getContrastTextClass(primaryColor || '#0ea5e9');

    return (
        <AnimatePresence>
            {isVisible && (
                <div className="fixed bottom-6 right-6 z-40 lg:hidden pointer-events-none">
                    <motion.button
                        initial={{ y: 100, opacity: 0, scale: 0.5 }}
                        animate={{ y: 0, opacity: 1, scale: 1 }}
                        exit={{ y: 100, opacity: 0, scale: 0.5 }}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.9 }}
                        transition={{ type: "spring", stiffness: 300, damping: 25 }}
                        onClick={() => setIsCartOpen(true)}
                        style={{ backgroundColor: primaryColor || '#0ea5e9' }}
                        className={`pointer-events-auto relative w-16 h-16 rounded-full flex items-center justify-center shadow-[0_8px_32px_-4px_rgba(0,0,0,0.3)] transition-colors border-2 border-white/20 ${textClass}`}
                    >
                        <ShoppingBag size={24} strokeWidth={2.5} />

                        {/* Notification Badge */}
                        <AnimatePresence>
                            {cartCount > 0 && (
                                <motion.div
                                    initial={{ scale: 0, opacity: 0 }}
                                    animate={{ scale: 1, opacity: 1 }}
                                    exit={{ scale: 0, opacity: 0 }}
                                    className="absolute -top-1 -right-1 w-6 h-6 bg-rose-500 text-white text-[10px] font-black rounded-full flex items-center justify-center border-2 border-white shadow-sm"
                                >
                                    {cartCount}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.button>
                </div>
            )}
        </AnimatePresence>
    );
}
