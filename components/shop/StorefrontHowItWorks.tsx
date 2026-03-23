"use client";

import React from 'react';
import { ShoppingBag, Truck, UtensilsCrossed } from 'lucide-react';
import { motion } from 'framer-motion';

interface StorefrontHowItWorksProps {
    content?: string | null;
}

export default function StorefrontHowItWorks({ content }: StorefrontHowItWorksProps) {
    const steps = [
        {
            icon: ShoppingBag,
            title: "Choose Your Bundle",
            desc: "Select our Family Size or Serves 2 meal bundle from our rotating monthly menu.",
            color: "text-brand-teal",
            bg: "bg-teal-50/60 dark:bg-teal-900/20",
            num: "01"
        },
        {
            icon: Truck,
            title: "We Deliver to You",
            desc: "We prep, freeze, and deliver right to your doorstep or pickup spot.",
            color: "text-brand-teal",
            bg: "bg-teal-50/60 dark:bg-teal-900/20",
            num: "02"
        },
        {
            icon: UtensilsCrossed,
            title: "Cook & Enjoy",
            desc: "No prep needed. Just put in your crockpot, Insta-pot or oven, and dinner is served!",
            color: "text-brand-teal",
            bg: "bg-teal-50/60 dark:bg-teal-900/20",
            num: "03"
        }
    ];

    return (
        <section className="py-10 md:py-16 relative z-10 w-full">
            <div className="max-w-2xl mx-auto w-full px-4">
                <div className="text-center mb-8 md:mb-10">
                    <motion.span
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        className="text-brand-teal dark:text-teal-400 font-black tracking-[0.2em] uppercase text-[10px] mb-2 block"
                    >
                        Simple &amp; Seamless
                    </motion.span>
                    <motion.h2
                        initial={{ opacity: 0, y: 10 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.1 }}
                        className="text-2xl md:text-4xl font-black text-slate-900 dark:text-white tracking-tight"
                    >
                        The Process
                    </motion.h2>
                </div>

                {content ? (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                    >
                        <div className="bg-white/50 dark:bg-slate-900/50 backdrop-blur-xl p-6 md:p-10 rounded-2xl border border-white dark:border-white/5 shadow-lg shadow-teal-500/5 text-center">
                            <p className="text-base md:text-lg text-slate-600 dark:text-slate-300 font-medium leading-relaxed whitespace-pre-wrap">
                                {content}
                            </p>
                        </div>
                    </motion.div>
                ) : (
                    <div className="flex flex-col gap-3 md:gap-4">
                        {steps.map((step, idx) => (
                            <motion.div
                                key={idx}
                                initial={{ opacity: 0, x: -10 }}
                                whileInView={{ opacity: 1, x: 0 }}
                                viewport={{ once: true }}
                                transition={{ delay: idx * 0.08 }}
                                className={`flex items-center gap-4 p-4 md:p-5 rounded-2xl ${step.bg} border border-white/60 dark:border-white/5`}
                            >
                                <div className={`shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-xl ${step.bg} flex items-center justify-center border border-teal-100/50 dark:border-teal-800/30`}>
                                    <step.icon size={24} className={step.color} strokeWidth={1.5} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <h3 className="text-base md:text-lg font-black text-slate-900 dark:text-white tracking-tight leading-snug">
                                        {step.title}
                                    </h3>
                                    <p className="text-sm text-slate-500 dark:text-slate-400 font-medium leading-snug mt-0.5">
                                        {step.desc}
                                    </p>
                                </div>
                                <span className="shrink-0 text-[10px] font-black text-brand-teal/40 tracking-widest hidden sm:block">
                                    {step.num}
                                </span>
                            </motion.div>
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
