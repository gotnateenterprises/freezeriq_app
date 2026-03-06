
"use client";

import { useSession } from 'next-auth/react';
import { useState } from 'react';
import { CheckCircle2, CreditCard, ShieldCheck, Zap, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function BillingPage() {
    const { data: session } = useSession();
    const [isLoading, setIsLoading] = useState(false);
    const searchParams = useSearchParams();
    const router = useRouter();

    const currentPlan = (session?.user as any)?.plan || 'BASE';
    // Treat FREE and ULTIMATE as superior to PRO (hide upgrade options)
    const isPro = currentPlan === 'PRO' || currentPlan === 'ULTIMATE' || currentPlan === 'FREE';

    const handleSubscribe = async (plan: 'BASE' | 'PRO') => {
        setIsLoading(true);
        try {
            // Price IDs should be in environment variables or constants
            const priceId = plan === 'PRO'
                ? 'price_1Qog...test_PRO' // Replace with Real PRO Price ID
                : 'price_1Qog...test_BASE'; // Replace with Real BASE Price ID

            const res = await fetch('/api/stripe/checkout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan, priceId })
            });

            const data = await res.json();
            if (data.url) {
                window.location.href = data.url;
            } else {
                alert('Failed to start checkout');
            }
        } catch (error) {
            console.error('Checkout error:', error);
            alert('Something went wrong');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8">
            <header>
                <h1 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                    <CreditCard className="text-indigo-500" size={32} />
                    Billing & Subscription
                </h1>
                <p className="text-slate-500 dark:text-slate-400 mt-2">Manage your plan and payment methods.</p>
            </header>

            {searchParams.get('success') && (
                <div className="bg-emerald-50 border border-emerald-100 text-emerald-700 p-4 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                    <CheckCircle2 size={24} />
                    <div>
                        <p className="font-bold">Upgrade Successful!</p>
                        <p className="text-sm">Your account has been upgraded. Welcome to the Pro tier.</p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* BASE PLAN */}
                <div className={`glass-card p-8 rounded-3xl border-2 transition-all ${!isPro ? 'border-indigo-500 shadow-xl shadow-indigo-500/10' : 'border-slate-200 dark:border-slate-700/50 opacity-60 hover:opacity-100'}`}>
                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <h3 className="text-2xl font-black text-slate-800 dark:text-white">Base</h3>
                            <p className="text-indigo-500 font-bold">$49/mo</p>
                        </div>
                        {!isPro && <span className="bg-indigo-100 text-indigo-700 font-black text-[10px] px-3 py-1 rounded-full uppercase">Current Plan</span>}
                    </div>

                    <ul className="space-y-3 mb-8">
                        <li className="flex gap-3 text-sm font-medium text-slate-600 dark:text-slate-300">
                            <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            Inventory Management
                        </li>
                        <li className="flex gap-3 text-sm font-medium text-slate-600 dark:text-slate-300">
                            <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            Unlimited Recipes
                        </li>
                        <li className="flex gap-3 text-sm font-medium text-slate-600 dark:text-slate-300">
                            <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            Basic Production Planning
                        </li>
                    </ul>

                    <button
                        disabled={!isPro || isLoading}
                        className="w-full py-3 rounded-xl font-bold text-sm bg-slate-100 dark:bg-slate-800 text-slate-500 cursor-not-allowed"
                    >
                        Included
                    </button>
                </div>

                {/* PRO PLAN */}
                <div className={`glass-card p-8 rounded-3xl border-2 transition-all relative overflow-hidden ${isPro ? 'border-indigo-500 shadow-xl shadow-indigo-500/10' : 'border-indigo-100 dark:border-indigo-900/30 hover:border-indigo-300 dark:hover:border-indigo-700'}`}>
                    {isPro && (
                        <div className="absolute top-0 right-0 bg-indigo-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">
                            ACTIVE
                        </div>
                    )}

                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <h3 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                                Pro <Zap size={20} className="text-amber-500 fill-amber-500" />
                            </h3>
                            <p className="text-indigo-500 font-bold">$99/mo</p>
                        </div>
                    </div>

                    <ul className="space-y-3 mb-8">
                        <li className="flex gap-3 text-sm font-medium text-slate-600 dark:text-slate-300">
                            <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            Everything in Base
                        </li>
                        <li className="flex gap-3 text-sm font-medium text-slate-600 dark:text-slate-300">
                            <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            <strong>CRM & Customer Profiles</strong>
                        </li>
                        <li className="flex gap-3 text-sm font-medium text-slate-600 dark:text-slate-300">
                            <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            Email Campaigns
                        </li>
                        <li className="flex gap-3 text-sm font-medium text-slate-600 dark:text-slate-300">
                            <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            <strong>AI Chef & Blueprint Access</strong>
                        </li>
                    </ul>

                    {isPro ? (
                        <button
                            className="w-full py-3 rounded-xl font-bold text-sm bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                        >
                            Manage Subscription
                        </button>
                    ) : (
                        <button
                            onClick={() => handleSubscribe('PRO')}
                            disabled={isLoading}
                            className="w-full py-3 rounded-xl font-bold text-sm bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-500/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                        >
                            {isLoading ? <Loader2 className="animate-spin w-4 h-4" /> : 'Upgrade to Pro'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
