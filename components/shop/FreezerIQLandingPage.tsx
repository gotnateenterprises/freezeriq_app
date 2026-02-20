'use client';

import React from 'react';
import { ChefHat, TrendingUp, Sparkles, ShieldCheck, Zap, ArrowRight, CheckCircle2, Globe, Users } from 'lucide-react';
import Link from 'next/link';

export default function FreezerIQLandingPage() {
    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 font-sans selection:bg-indigo-100 selection:text-indigo-900">
            {/* Hero Section */}
            <header className="relative bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="absolute inset-0 bg-linear-to-br from-indigo-50/50 to-transparent dark:from-indigo-950/20" />

                <div className="max-w-7xl mx-auto px-6 py-24 relative z-10 flex flex-col items-center text-center">
                    <div className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-50 dark:bg-indigo-900/40 rounded-full border border-indigo-100 dark:border-indigo-800/50 text-indigo-600 dark:text-indigo-400 font-black text-[10px] uppercase tracking-widest mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
                        <Sparkles size={14} className="animate-pulse" />
                        The Future of Meal Prep Automation
                    </div>

                    <h1 className="text-5xl md:text-7xl font-black text-slate-900 dark:text-white tracking-tight mb-8 leading-[1.05] animate-in fade-in slide-in-from-bottom-8 duration-700 delay-100">
                        Scale Your Kitchen with <br />
                        <span className="bg-linear-to-r from-indigo-600 to-violet-600 dark:from-indigo-400 dark:to-violet-400 text-transparent bg-clip-text">Intelligence.</span>
                    </h1>

                    <p className="max-w-2xl text-xl text-slate-600 dark:text-slate-400 font-medium leading-relaxed mb-12 animate-in fade-in slide-in-from-bottom-12 duration-700 delay-200">
                        FreezerIQ is the all-in-one operating system for meal prep businesses. From AI-driven recipe scaling to automated production hubs—we handle the logistics so you can focus on cooking.
                    </p>

                    <div className="flex flex-col sm:flex-row gap-4 animate-in fade-in slide-in-from-bottom-16 duration-700 delay-300">
                        <Link href="/start-a-business" className="px-10 py-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all hover:scale-105 shadow-2xl shadow-indigo-600/30 flex items-center gap-2">
                            Start Your Business <ArrowRight size={16} strokeWidth={3} />
                        </Link>
                        <button className="px-10 py-5 bg-white dark:bg-slate-800 text-slate-900 dark:text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 flex items-center gap-2">
                            Watch Demo <Zap size={16} />
                        </button>
                    </div>

                    <div className="mt-20 grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-16 opacity-50 dark:opacity-40 animate-in fade-in duration-1000 delay-500">
                        <div className="flex items-center gap-2 font-black text-slate-400 uppercase text-[10px] tracking-widest justify-center">
                            <ChefHat size={16} /> Pro Chefs
                        </div>
                        <div className="flex items-center gap-2 font-black text-slate-400 uppercase text-[10px] tracking-widest justify-center">
                            <ShieldCheck size={16} /> Enterprise Grade
                        </div>
                        <div className="flex items-center gap-2 font-black text-slate-400 uppercase text-[10px] tracking-widest justify-center">
                            <TrendingUp size={16} /> 3x ROI
                        </div>
                        <div className="flex items-center gap-2 font-black text-slate-400 uppercase text-[10px] tracking-widest justify-center">
                            <Zap size={16} /> AI Powered
                        </div>
                    </div>
                </div>
            </header>

            {/* Features Grid */}
            <section className="max-w-7xl mx-auto px-6 py-32">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {/* Feature 1 */}
                    <div className="bg-white dark:bg-slate-900 p-10 rounded-[3rem] border border-slate-100 dark:border-slate-800 shadow-xl shadow-slate-200/20 dark:shadow-none hover:border-indigo-500/50 transition-colors group">
                        <div className="w-16 h-16 bg-indigo-50 dark:bg-indigo-950 rounded-2xl flex items-center justify-center text-indigo-600 mb-8 transition-transform group-hover:scale-110 group-hover:-rotate-3">
                            <Sparkles size={32} />
                        </div>
                        <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight mb-4">AI Recipe Hub</h3>
                        <p className="text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                            Upload your recipes and let our AI handle technical scaling, allergen detection, and marketing descriptions instantly.
                        </p>
                    </div>

                    {/* Feature 2 */}
                    <div className="bg-white dark:bg-slate-900 p-10 rounded-[3rem] border border-slate-100 dark:border-slate-800 shadow-xl shadow-slate-200/20 dark:shadow-none hover:border-indigo-500/50 transition-colors group">
                        <div className="w-16 h-16 bg-emerald-50 dark:bg-emerald-950 rounded-2xl flex items-center justify-center text-emerald-600 mb-8 transition-transform group-hover:scale-110 group-hover:-rotate-3">
                            <ChefHat size={32} />
                        </div>
                        <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight mb-4">Production Management</h3>
                        <p className="text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                            Organize your prep and assembly with task lists, consolidated shopping reports, and batch cooking logistics.
                        </p>
                    </div>

                    {/* Feature 3 */}
                    <div className="bg-white dark:bg-slate-900 p-10 rounded-[3rem] border border-slate-100 dark:border-slate-800 shadow-xl shadow-slate-200/20 dark:shadow-none hover:border-indigo-500/50 transition-colors group">
                        <div className="w-16 h-16 bg-indigo-50 dark:bg-indigo-950 rounded-2xl flex items-center justify-center text-indigo-600 mb-8 transition-transform group-hover:scale-110 group-hover:-rotate-3">
                            <Globe size={32} />
                        </div>
                        <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight mb-4">Branded Storefronts</h3>
                        <p className="text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                            Launch beautiful local storefronts with high-converting layouts, loyalty programs, and automated order intake.
                        </p>
                    </div>
                </div>
            </section>

            {/* Why FreezerIQ Section */}
            <section className="bg-indigo-600 py-32 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-[50%] h-full bg-linear-to-l from-white/10 to-transparent skew-x-[-15deg] transform translate-x-32" />

                <div className="max-w-7xl mx-auto px-6 flex flex-col lg:flex-row items-center gap-16">
                    <div className="lg:w-1/2 text-white space-y-8">
                        <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-tight">
                            Built by cooks, <br />
                            for the culinary elite.
                        </h2>
                        <p className="text-indigo-100 text-xl font-medium leading-relaxed opacity-90">
                            Stop using spreadsheets and generic POS systems. FreezerIQ understands how a commercial kitchen actually operates.
                        </p>

                        <div className="space-y-4 pt-4">
                            <div className="flex items-center gap-3">
                                <CheckCircle2 className="text-emerald-400" />
                                <span className="font-bold">Automated Production Hubs</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <CheckCircle2 className="text-emerald-400" />
                                <span className="font-bold">Full CRM & Sales Analytics</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <CheckCircle2 className="text-emerald-400" />
                                <span className="font-bold">Multi-Tenant Franchise Support</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <CheckCircle2 className="text-emerald-400" />
                                <span className="font-bold">Real-time Inventory Tracking</span>
                            </div>
                        </div>

                        <div className="pt-8">
                            <button className="px-10 py-5 bg-white text-indigo-600 rounded-2xl font-black text-xs uppercase tracking-widest transition-all hover:scale-105 shadow-xl">
                                Join the Network
                            </button>
                        </div>
                    </div>

                    <div className="lg:w-1/2">
                        <div className="bg-white/10 backdrop-blur-3xl p-1 rounded-[3rem] border border-white/20 shadow-2xl overflow-hidden group">
                            <div className="bg-slate-900 rounded-[2.8rem] overflow-hidden aspect-video relative">
                                <div className="absolute inset-0 bg-linear-to-br from-indigo-500/20 to-transparent pointer-events-none" />
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center text-indigo-600 shadow-2xl cursor-pointer hover:scale-110 transition-transform">
                                        <Zap size={32} />
                                    </div>
                                </div>
                                <img
                                    src="https://images.unsplash.com/photo-1556910103-1c02745aae4d?q=80&w=2070&auto=format&fit=crop"
                                    alt="Kitchen Automation"
                                    className="w-full h-full object-cover opacity-50 contrast-125"
                                />
                                <div className="absolute bottom-6 left-6 right-6 p-6 bg-white/10 backdrop-blur-md rounded-2xl border border-white/20">
                                    <p className="text-white font-black text-xs uppercase tracking-widest mb-1">Live Dashboard</p>
                                    <p className="text-indigo-200 text-xs font-medium italic">"FreezerIQ cut our prep time by 40% in our first month."</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Platform Stats */}
            <section className="max-w-7xl mx-auto px-6 py-32">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-12 text-center md:text-left">
                    <div className="space-y-2">
                        <p className="text-4xl font-black text-slate-900 dark:text-white">$1.2M+</p>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Sales Processed</p>
                    </div>
                    <div className="space-y-2">
                        <p className="text-4xl font-black text-slate-900 dark:text-white">45k+</p>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Meals Hand-Crafted</p>
                    </div>
                    <div className="space-y-2">
                        <p className="text-4xl font-black text-slate-900 dark:text-white">99%</p>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Inventory Accuracy</p>
                    </div>
                    <div className="space-y-2">
                        <p className="text-4xl font-black text-slate-900 dark:text-white">2.5k+</p>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Happy Customers</p>
                    </div>
                </div>
            </section>

            {/* Footer */}
            <footer className="bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 py-24">
                <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-12">
                    <div className="flex flex-col items-center md:items-start gap-4">
                        <div className="flex items-baseline">
                            <span className="bg-gradient-to-r from-indigo-600 to-violet-600 dark:from-indigo-400 dark:to-violet-400 text-transparent bg-clip-text text-3xl font-black tracking-tighter">
                                FreezerIQ
                            </span>
                            <span className="text-indigo-600 dark:text-indigo-400 text-[8px] ml-px self-start mt-0.5 font-black leading-none uppercase">
                                Platform
                            </span>
                        </div>
                        <p className="text-slate-400 font-bold text-xs uppercase tracking-widest">Powering local food entrepreneurs.</p>
                    </div>

                    <div className="flex gap-12 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                        <Link href="/start-a-business" className="hover:text-indigo-600 transition-colors">Start a Business</Link>
                        <Link href="/login" className="hover:text-indigo-600 transition-colors">Admin Login</Link>
                        <Link href="/legal/privacy" className="hover:text-indigo-600 transition-colors">Privacy</Link>
                        <Link href="/legal/eula" className="hover:text-indigo-600 transition-colors">Terms</Link>
                    </div>
                </div>
            </footer>
        </div>
    );
}
