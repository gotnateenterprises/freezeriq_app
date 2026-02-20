"use client";

import { Sparkles, ArrowRight, ShieldCheck, Zap, Star } from 'lucide-react';
import Link from 'next/link';

interface UpgradeRequiredProps {
    feature: string;
    description: string;
}

export default function UpgradeRequired({ feature, description }: UpgradeRequiredProps) {
    return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center animate-in fade-in zoom-in duration-500">
            <div className="w-20 h-20 bg-indigo-100 dark:bg-indigo-900/30 rounded-3xl flex items-center justify-center mb-6 relative">
                <ShieldCheck className="w-10 h-10 text-indigo-600 dark:text-indigo-400" />
                <div className="absolute -top-1 -right-1 bg-amber-500 rounded-full p-1.5 shadow-lg border-2 border-white dark:border-slate-900">
                    <Zap className="w-4 h-4 text-white fill-white" />
                </div>
            </div>

            <h1 className="text-3xl font-black text-slate-900 dark:text-white mb-3">
                {feature} is an <span className="bg-gradient-to-r from-indigo-600 to-violet-600 text-transparent bg-clip-text">Enterprise</span> Feature
            </h1>

            <p className="text-slate-500 dark:text-slate-400 max-w-md mx-auto mb-10 leading-relaxed font-medium">
                {description} Upgrade your plan today to unlock our full suite of CRM and growth tools.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-2xl mb-12">
                <FeatureCard
                    icon={<Zap className="text-amber-500" />}
                    title="Advanced CRM"
                    desc="Track customer history, dietary needs, and automated follow-ups."
                />
                <FeatureCard
                    icon={<Star className="text-indigo-500" />}
                    title="Fundraiser Toolkit"
                    desc="Launch organizations, track goals, and use our coordinator portal."
                />
                <FeatureCard
                    icon={<Sparkles className="text-violet-500" />}
                    title="Marketing Automation"
                    desc="Send seasonal alerts and targeted emails to your customer base."
                />
                <FeatureCard
                    icon={<ShieldCheck className="text-emerald-500" />}
                    title="Smart Invoicing"
                    desc="Generate professional PDFs and track bundle-based payments."
                />
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4">
                <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-2xl font-black shadow-xl shadow-indigo-500/20 hover:scale-105 transition-all flex items-center gap-2">
                    Upgrade to Enterprise
                    <ArrowRight className="w-5 h-5" />
                </button>
                <Link href="/" className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 font-bold px-8 py-4">
                    Back to Dashboard
                </Link>
            </div>
        </div>
    );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
    return (
        <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-100 dark:border-slate-700 text-left shadow-sm">
            <div className="flex items-center gap-3 mb-2">
                {icon}
                <h3 className="font-bold text-slate-900 dark:text-white uppercase tracking-wider text-xs">{title}</h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-medium leading-normal">
                {desc}
            </p>
        </div>
    );
}
