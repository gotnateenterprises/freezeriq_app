"use client";

import React from 'react';
import { ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { motion } from 'framer-motion';

interface StorefrontHowItWorksProps {
    content?: string | null;
}

export default function StorefrontHowItWorks({ content }: StorefrontHowItWorksProps) {
    const scrollContainerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container) return;

        // Auto-scroll logic only intended for smaller screens where it's single line
        if (window.innerWidth > 768) return;

        let animationFrameId: number;
        let isInteracting = false;

        const stopScroll = () => { isInteracting = true; };
        const startScroll = () => { isInteracting = false; };

        container.addEventListener('mouseenter', stopScroll);
        container.addEventListener('mouseleave', startScroll);
        container.addEventListener('touchstart', stopScroll, { passive: true });
        container.addEventListener('touchend', startScroll);

        const scroll = () => {
            if (!isInteracting && container) {
                container.scrollLeft += 0.5;
                if (container.scrollLeft >= container.scrollWidth - container.clientWidth - 1) {
                    container.scrollLeft = 0;
                }
            }
            animationFrameId = requestAnimationFrame(scroll);
        };
        animationFrameId = requestAnimationFrame(scroll);

        return () => {
            cancelAnimationFrame(animationFrameId);
            container.removeEventListener('mouseenter', stopScroll);
            container.removeEventListener('mouseleave', startScroll);
            container.removeEventListener('touchstart', stopScroll);
            container.removeEventListener('touchend', startScroll);
        };
    }, []);

    const steps = [
        {
            icon: ShoppingBag,
            title: "Choose Your Bundle",
            desc: "Select our Family Size or Serves 2 meal bundle from our rotating monthly menu.",
            color: "text-brand-teal",
            bg: "bg-teal-50/50 dark:bg-teal-900/10",
            badge: "Browse"
        },
        {
            icon: Truck,
            title: "We Deliver to You",
            desc: "We prep, freeze, and deliver right to your doorstep or pickup spot.",
            color: "text-brand-teal",
            bg: "bg-teal-50/50 dark:bg-teal-900/10",
            badge: "Deliver"
        },
        {
            icon: UtensilsCrossed,
            title: "Cook & Enjoy",
            desc: "No prep needed. Just put in your crockpot, Insta-pot or oven, and dinner is served!",
            color: "text-brand-teal",
            bg: "bg-teal-50/50 dark:bg-teal-900/10",
            badge: "Enjoy"
        }
    ];

    return (
        <section className="py-24 border-b border-indigo-50/50 dark:border-slate-800/50 relative z-10">
            <div className="max-w-7xl mx-auto px-6">
                <div className="text-center mb-20">
                    <motion.span
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="text-brand-teal dark:text-teal-400 font-black tracking-[0.2em] uppercase text-[10px] mb-3 block"
                    >
                        Simple & Seamless
                    </motion.span>
                    <motion.h2
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.1 }}
                        className="text-4xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight"
                    >
                        The Process
                    </motion.h2>
                </div>

                {content ? (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="max-w-3xl mx-auto"
                    >
                        <div className="bg-white/50 dark:bg-slate-900/50 backdrop-blur-xl p-10 md:p-16 rounded-[3rem] border border-white dark:border-white/5 shadow-xl shadow-teal-500/5 text-center">
                            <p className="text-lg md:text-xl text-slate-600 dark:text-slate-300 font-medium leading-relaxed whitespace-pre-wrap">
                                {content}
                            </p>
                        </div>
                    </motion.div>
                ) : (
                    <div className="flex overflow-x-auto snap-x snap-mandatory gap-6 md:gap-16 pb-8 md:grid md:grid-cols-3 relative hide-scrollbar px-2" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
                        <style jsx>{`
                            div::-webkit-scrollbar {
                                display: none;
                            }
                        `}</style>
                        {/* Connecting Line (Desktop Only) - Feminized */}
                        <div className="hidden md:block absolute top-16 left-[10%] right-[10%] h-px bg-linear-to-r from-transparent via-teal-100 dark:via-teal-900/30 to-transparent z-0" />

                        {steps.map((step, idx) => (
                            <motion.div
                                key={idx}
                                initial={{ opacity: 0, y: 20 }}
                                whileInView={{ opacity: 1, y: 0 }}
                                viewport={{ once: true }}
                                transition={{ delay: idx * 0.1 }}
                                className="relative z-10 flex flex-col items-center text-center group min-w-[85vw] md:min-w-0 snap-center"
                            >
                                <div className={`relative w-32 h-32 rounded-[3.5rem] ${step.bg} flex items-center justify-center mb-8 transition-all duration-500 group-hover:rounded-[2.5rem] group-hover:scale-110 group-hover:shadow-[0_24px_48px_-12px_rgba(79,70,229,0.1)] border border-white dark:border-white/5`}>
                                    <div className="absolute top-0 right-0 -translate-y-1/4 translate-x-1/4 bg-white dark:bg-slate-800 px-3 py-1 rounded-full shadow-sm border border-teal-50 dark:border-slate-700">
                                        <span className="text-[10px] font-black text-brand-teal uppercase tracking-wider">{step.badge}</span>
                                    </div>
                                    <step.icon size={48} className={step.color} strokeWidth={1.5} />
                                </div>
                                <h3 className="text-2xl font-black mb-3 text-slate-900 dark:text-white tracking-tight">{step.title}</h3>
                                <p className="text-slate-500 dark:text-slate-400 font-medium leading-relaxed max-w-[280px]">
                                    {step.desc}
                                </p>
                            </motion.div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
