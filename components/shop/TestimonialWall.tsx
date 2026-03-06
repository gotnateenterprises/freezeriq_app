"use client";

import { motion } from 'framer-motion';
import { Quote } from 'lucide-react';

interface Testimonial {
    quote: string;
    author: string;
}

interface TestimonialWallProps {
    testimonials?: Testimonial[] | null;
}

export default function TestimonialWall({ testimonials }: TestimonialWallProps) {
    if (!testimonials || testimonials.length === 0) return null;

    return (
        <section className="py-12 md:py-24 relative overflow-hidden">
            {/* Background Decorations */}
            <div className="absolute inset-0 pointer-events-none mb-10">
                <div className="absolute top-0 w-full h-px bg-gradient-to-r from-transparent via-slate-200 dark:via-slate-800 to-transparent" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80%] h-[80%] bg-indigo-50/50 dark:bg-indigo-900/10 blur-[120px] rounded-full" />
            </div>

            <div className="max-w-7xl mx-auto px-6 relative z-10">
                <div className="text-center mb-16 md:mb-24">
                    <h2 className="font-serif text-4xl md:text-5xl text-slate-900 dark:text-white mb-6">
                        Loved by Local Families
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400 max-w-2xl mx-auto font-medium md:text-lg">
                        Hear from our community of busy parents and food lovers who have reclaimed their dinnertime.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {testimonials.map((t, idx) => (
                        <motion.div
                            key={idx}
                            initial={{ y: 50, opacity: 0 }}
                            whileInView={{ y: 0, opacity: 1 }}
                            viewport={{ once: true, margin: "-100px" }}
                            transition={{ duration: 0.6, delay: idx * 0.1 }}
                            className="bg-white/60 dark:bg-slate-900/60 backdrop-blur-xl p-8 md:p-10 rounded-[2.5rem] border border-white dark:border-white/5 shadow-xl shadow-slate-200/20 dark:shadow-none relative group hover:-translate-y-2 transition-transform duration-300"
                        >
                            <div className="absolute top-8 right-8 text-indigo-100 dark:text-indigo-900/30 group-hover:text-indigo-200 dark:group-hover:text-indigo-900/50 transition-colors">
                                <Quote size={48} className="rotate-180" />
                            </div>

                            <div className="relative z-10 flex flex-col h-full">
                                <div className="flex gap-1 mb-6 text-amber-400">
                                    {[1, 2, 3, 4, 5].map((star) => (
                                        <svg key={star} className="w-5 h-5 fill-current" viewBox="0 0 20 20">
                                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                        </svg>
                                    ))}
                                </div>
                                <p className="text-slate-700 dark:text-slate-300 font-medium leading-relaxed mb-8 flex-1 text-lg">
                                    "{t.quote}"
                                </p>
                                <div className="flex items-center gap-4 border-t border-slate-100 dark:border-slate-800 pt-6">
                                    <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-black text-sm">
                                        {t.author ? t.author.charAt(0).toUpperCase() : '?'}
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-slate-900 dark:text-white leading-tight">{t.author}</h4>
                                        <span className="text-xs text-slate-500 font-medium">Verified Buyer</span>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    ))}
                </div>
            </div>
        </section>
    );
}
