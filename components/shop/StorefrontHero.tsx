"use client";

import { ArrowRight, Truck, CheckCircle, Calendar, ArrowDown, ChefHat, UserCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import Link from 'next/link';

interface StorefrontHeroProps {
    headline: string;
    subheadline: string;
    businessName: string;
    primaryColor: string;
    heroImage?: string; // Optional background image URL
    logoUrl?: string | null; // Optional business logo
    slug?: string; // Need slug for login link
}

export default function StorefrontHero({
    headline,
    subheadline,
    businessName,
    primaryColor,
    heroImage,
    logoUrl,
    slug
}: StorefrontHeroProps) {

    const scrollToShop = () => {
        const shopSection = document.getElementById('shop-bundles');
        if (shopSection) {
            shopSection.scrollIntoView({ behavior: 'smooth' });
        }
    };

    const isVideo = heroImage?.toLowerCase().endsWith('.mp4') || heroImage?.toLowerCase().endsWith('.webm');

    const defaultHero = '/images/nostalgic-hero.jpg';
    const finalHero = heroImage || defaultHero;

    return (
        <div className="relative w-full min-h-[90vh] md:min-h-screen flex flex-col">
            {/* Premium Top Navigation Bar */}
            <nav className="absolute top-0 left-0 right-0 z-50 px-6 py-6 md:py-8 flex justify-between items-center bg-linear-to-b from-black/20 to-transparent pointer-events-none">
                <div className="flex items-center gap-4 pointer-events-auto group cursor-pointer" onClick={() => window.location.href = '/'}>
                    {logoUrl ? (
                        <div className="w-12 h-12 md:w-16 md:h-16 rounded-2xl overflow-hidden shadow-2xl bg-white/10 backdrop-blur-md p-1.5 transition-transform group-hover:scale-105 border border-white/20">
                            <img src={logoUrl} alt={businessName} className="w-full h-full object-contain" />
                        </div>
                    ) : (
                        <div className="w-12 h-12 md:w-16 md:h-16 rounded-2xl overflow-hidden shadow-2xl bg-brand-teal/20 backdrop-blur-md flex items-center justify-center border border-brand-teal/20">
                            <ChefHat className="text-white" size={32} />
                        </div>
                    )}
                    <h2 className="text-xl md:text-2xl font-serif text-white drop-shadow-md">
                        {(!businessName || businessName === 'FreezerIQ') ? 'Freezer Chef' : businessName}
                    </h2>
                </div>

                {slug && (
                    <div className="flex items-center pointer-events-auto relative">
                        <Link
                            href={`/shop/${slug}/login`}
                            className="group flex items-center gap-2 bg-slate-900/40 hover:bg-slate-900/60 backdrop-blur-xl border-2 border-white/50 px-4 py-2.5 rounded-full text-white transition-all hover:scale-105 shadow-[0_8px_32px_0_rgba(0,0,0,0.5)]"
                        >
                            <UserCircle size={18} />
                            <span className="text-xs font-black uppercase tracking-widest hidden sm:inline">Sign In</span>

                            {/* Hover Tooltip (Desktop Only) */}
                            <div className="absolute top-12 right-0 bg-slate-900/90 backdrop-blur-md text-white px-3 py-1.5 rounded-lg text-xs font-bold tracking-widest uppercase opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow-xl border border-white/10 hidden sm:block">
                                Manage Account
                            </div>
                        </Link>
                    </div>
                )}
            </nav>

            {/* Immersive Background Layer */}
            <div className="absolute inset-0 z-0 overflow-hidden bg-white">
                {/* Visual Treatment Overlays - NOSTALGIC BRIGHT COUNTRY */}
                <div className="absolute inset-0 bg-white/5 z-10" /> {/* Minimal shade */}
                <div className="absolute inset-0 bg-amber-900/15 z-15 mix-blend-overlay" /> {/* Warmer nostalgic warmth */}
                <div className="absolute inset-0 z-20 pointer-events-none opacity-25 mix-blend-soft-light grayscale contrast-125" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/p6.png")' }} /> {/* Nostalgic Grain */}
                <div className="absolute inset-0 z-25 pointer-events-none shadow-[inset_0_0_150px_rgba(255,255,255,0.3)]" /> {/* Soft light vignette */}

                {/* Floating Sparkles */}
                <div className="absolute inset-0 pointer-events-none opacity-30 z-20">
                    {[...Array(8)].map((_, i) => (
                        <motion.div
                            key={i}
                            initial={{ opacity: 0, scale: 0 }}
                            animate={{ opacity: [0, 0.8, 0], scale: [0, 1, 0], y: i % 2 === 0 ? [0, -60] : [0, 60] }}
                            transition={{ duration: 4 + i % 2, repeat: Infinity, delay: i * 0.8 }}
                            className="absolute w-1.5 h-1.5 bg-brand-gold rounded-full"
                            style={{
                                top: `${20 + Math.random() * 60}%`,
                                left: `${20 + Math.random() * 60}%`,
                                boxShadow: '0 0 15px #fbbf24'
                            }}
                        />
                    ))}
                </div>

                {/* Main Hero Image */}
                <div className="absolute inset-0">
                    <div
                        className="w-full h-full bg-cover bg-center transition-transform duration-[10s] ease-linear animate-slow-zoom"
                        style={{ backgroundImage: `url(${finalHero})` }}
                    />
                </div>
            </div>

            {/* Content Card - Centered Frosted Glass */}
            <div className="relative z-30 flex-1 flex items-center justify-center px-6 pt-20">
                <motion.div
                    initial={{ opacity: 0, y: 30 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
                    className="w-full max-w-4xl"
                >
                    <div className="bg-white/10 dark:bg-slate-900/20 backdrop-blur-md rounded-[3rem] md:rounded-[5rem] p-10 md:p-24 text-center shadow-[0_32px_64px_-16px_rgba(0,0,0,0.2)] border border-white/20 dark:border-white/5 relative overflow-hidden">

                        {logoUrl && (
                            <div className="flex justify-center mb-10 relative z-10">
                                <div className="w-28 h-28 md:w-36 md:h-36 rounded-full bg-white dark:bg-slate-900 shadow-2xl flex items-center justify-center p-4 md:p-6 border border-slate-100 dark:border-slate-800 relative hover:scale-105 transition-transform duration-500"
                                    style={{ boxShadow: `0 25px 50px -12px ${primaryColor}40` }}>
                                    <img src={logoUrl} alt={`${businessName} Logo`} className="w-full h-full object-contain" />
                                </div>
                            </div>
                        )}
                        {/* Status Label */}
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.8 }}
                            className="inline-flex items-center gap-2 bg-white/60 dark:bg-teal-950/30 px-5 py-2 rounded-full border border-white/50 dark:border-teal-500/10 mb-8 backdrop-blur-md"
                        >
                            <div className="w-2 h-2 rounded-full bg-brand-teal animate-pulse shadow-[0_0_10px_rgba(20,184,166,1)]" />
                            <span className="text-[10px] md:text-[11px] font-black uppercase tracking-[0.3em] text-teal-800 dark:text-teal-300">
                                Fresh Menus Open
                            </span>
                        </motion.div>

                        <h1 className="text-4xl md:text-7xl font-black text-slate-900 dark:text-white mb-6 md:mb-10 leading-[1.1] tracking-tight">
                            {headline || (
                                <>Stock your freezer<br />in 5 minutes.</>
                            )}
                        </h1>

                        <p className="text-lg md:text-3xl text-slate-800 dark:text-slate-100 font-serif mb-10 md:mb-14 max-w-2xl mx-auto leading-relaxed opacity-95">
                            {subheadline || "Take the stress out of dinner. Real food, ready when you are."}
                        </p>

                        <div className="flex flex-col items-center gap-10">
                            <button
                                onClick={scrollToShop}
                                className="group relative inline-flex items-center justify-center gap-4 px-12 md:px-16 py-5 md:py-6 text-xl md:text-3xl font-black text-white rounded-full transition-all hover:scale-[1.03] shadow-2xl active:scale-95 w-full md:w-auto bg-linear-to-br from-brand-teal to-teal-700 border-b-4 border-teal-800"
                            >
                                Shop The Menu
                                <ArrowRight size={28} className="group-hover:translate-x-3 transition-transform duration-500" />
                            </button>

                            {/* Trust Indicators */}
                            <div className="flex flex-wrap justify-center gap-x-10 md:gap-x-16 gap-y-6">
                                {[
                                    { icon: Truck, text: "Local Delivery" },
                                    { icon: CheckCircle, text: "Family Friendly" },
                                    { icon: Calendar, text: "Monthly Menus" }
                                ].map((item, i) => (
                                    <div key={i} className="flex items-center gap-3 text-slate-700 dark:text-slate-300 font-black tracking-widest transition-all">
                                        <item.icon size={18} className="text-brand-teal" />
                                        <span className="text-[10px] md:text-[11px] uppercase">{item.text}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </motion.div>
            </div>
        </div>
    );
}
