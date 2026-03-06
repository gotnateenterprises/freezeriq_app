"use client";

import { useState, useEffect } from 'react';
import { ShoppingBag, Users, Sparkles, Utensils } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface StickyCategoryBarProps {
    primaryColor: string;
    hasFundraisers: boolean;
    hasBundles: boolean;
}

export default function StickyCategoryBar({ primaryColor, hasFundraisers, hasBundles }: StickyCategoryBarProps) {
    const [activeSection, setActiveSection] = useState('all');
    const [isSticky, setIsSticky] = useState(false);

    useEffect(() => {
        const handleScroll = () => {
            const heroHeight = 500;
            setIsSticky(window.scrollY > heroHeight);

            // Simplified scroll spy
            const sections = ['fundraisers', 'bundles', 'extras'];
            for (const section of sections) {
                const el = document.getElementById(section);
                if (el) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top >= 0 && rect.top <= 200) {
                        setActiveSection(section);
                    }
                }
            }
        };

        window.addEventListener('scroll', handleScroll);
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    const scrollTo = (id: string) => {
        const el = document.getElementById(id);
        if (el) {
            const offset = 100;
            const elementPosition = el.getBoundingClientRect().top;
            const offsetPosition = elementPosition + window.pageYOffset - offset;
            window.scrollTo({
                top: offsetPosition,
                behavior: "smooth"
            });
            setActiveSection(id);
        }
    };

    const navItems = [
        { id: 'fundraisers', label: 'Support a Cause', icon: Users, show: hasFundraisers },
        { id: 'bundles', label: 'Monthly Menus', icon: ShoppingBag, show: hasBundles },
        { id: 'extras', label: 'Extra Meals', icon: Utensils, show: true },
    ].filter(item => item.show);

    if (navItems.length === 0) return null;

    return (
        <AnimatePresence>
            <motion.div
                initial={{ y: -100, opacity: 0 }}
                animate={{
                    y: isSticky ? 20 : -100,
                    opacity: isSticky ? 1 : 0,
                    scale: isSticky ? 1 : 0.95
                }}
                className="fixed top-0 left-1/2 -translate-x-1/2 z-[100] w-full max-w-fit px-4 pointer-events-none"
            >
                <div className="pointer-events-auto bg-white/80 dark:bg-slate-900/80 backdrop-blur-2xl rounded-[2rem] shadow-[0_32px_64px_-12px_rgba(79,70,229,0.15)] border border-white/40 dark:border-white/10 p-1.5 flex items-center gap-1">
                    {navItems.map((item) => (
                        <button
                            key={item.id}
                            onClick={() => scrollTo(item.id)}
                            className={`
                                relative px-6 py-2.5 rounded-[1.5rem] flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.1em] transition-all whitespace-nowrap
                                ${activeSection === item.id
                                    ? 'text-white'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-white/50 dark:hover:bg-white/5'}
                            `}
                        >
                            {activeSection === item.id && (
                                <motion.div
                                    layoutId="activeTab"
                                    className="absolute inset-0 rounded-[1.5rem] -z-10"
                                    style={{ backgroundColor: primaryColor || '#4f46e5' }}
                                    transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                />
                            )}
                            <item.icon size={14} strokeWidth={activeSection === item.id ? 3 : 2} />
                            {item.label}
                        </button>
                    ))}
                </div>
            </motion.div>
        </AnimatePresence>
    );
}
