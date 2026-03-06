'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChefHat, DollarSign, TrendingUp, CheckCircle, ArrowRight, Loader2 } from 'lucide-react';
import StorefrontHero from '@/components/shop/StorefrontHero';
import StorefrontFooter from '@/components/shop/StorefrontFooter';
import { toast } from 'sonner';

// Note: Metadata export removed as this is now a Client Component. 
// Ideally use a separate Layout or Server Component wrapper for metadata.

export default function StartBusinessPage() {
    const [formData, setFormData] = useState({ name: '', email: '', type: 'Professional Chef / Caterer' });
    const [status, setStatus] = useState<'IDLE' | 'LOADING' | 'SUCCESS'>('IDLE');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setStatus('LOADING');

        try {
            const res = await fetch('/api/public/business-lead', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (!res.ok) throw new Error('Failed to submit');

            setStatus('SUCCESS');
            toast.success("Welcome to the list! Check your email.");
        } catch (error) {
            console.error(error);
            setStatus('IDLE');
            toast.error("Something went wrong. Please try again.");
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 font-sans text-slate-900 dark:text-white">

            {/* Hero Section */}
            <div className="relative bg-indigo-900 text-white overflow-hidden">
                <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1556910103-1c02745a30bf?q=80&w=2070&auto=format&fit=crop')] bg-cover bg-center opacity-20"></div>
                <div className="absolute inset-0 bg-gradient-to-b from-indigo-900/80 to-slate-900"></div>

                <div className="relative max-w-5xl mx-auto px-6 py-24 md:py-32 text-center">
                    <div className="inline-flex items-center gap-2 bg-indigo-500/30 border border-indigo-400/30 px-4 py-1.5 rounded-full text-indigo-200 font-bold uppercase tracking-widest text-xs mb-8">
                        <span className="animate-pulse text-indigo-400">●</span> Now Recruiting Chefs & Cooks
                    </div>
                    <h1 className="text-4xl md:text-7xl font-black mb-6 tracking-tight leading-tight">
                        Launch Your Freezer Meal <br /> <span className="text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-cyan-400">Business in 7 Days.</span>
                    </h1>
                    <p className="text-xl md:text-2xl text-slate-300 max-w-3xl mx-auto mb-10 leading-relaxed font-light">
                        Where would I even start? Commercial kitchens are expensive and logistics are a nightmare. <br />
                        <strong className="text-white font-bold">FreezerIQ</strong> handles the training, technology and tracking... <br />
                        So you can focus on <span className="text-emerald-400 font-bold border-b-2 border-emerald-500/50 pb-0.5">making meals and money!</span>
                    </p>

                    <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
                        <Link href="#get-started" className="px-8 py-4 bg-emerald-500 hover:bg-emerald-400 text-slate-900 text-lg font-black rounded-full transition-all hover:scale-105 shadow-[0_0_40px_-10px_rgba(16,185,129,0.5)] flex items-center gap-2">
                            Start My Kitchen <ArrowRight size={20} strokeWidth={3} />
                        </Link>
                        <Link href="/" className="px-8 py-4 bg-white/10 hover:bg-white/20 text-white text-lg font-bold rounded-full transition-all backdrop-blur-sm">
                            See What It Looks Like
                        </Link>
                    </div>
                </div>
            </div>

            {/* Problem / Solution Grid */}
            <section className="py-24 px-6 max-w-6xl mx-auto">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    {/* Card 1 */}
                    <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl hover:shadow-2xl transition-all hover:-translate-y-2 group">
                        <div className="w-14 h-14 bg-indigo-100 dark:bg-indigo-900/50 rounded-2xl flex items-center justify-center text-indigo-600 dark:text-indigo-400 mb-6 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                            <ChefHat size={32} />
                        </div>
                        <h3 className="text-2xl font-black mb-3">AI Menu Planning</h3>
                        <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                            Don't stress about what to cook. Our AI analyzes trends and costs to generate high-margin menus and automatic prep lists for you.
                        </p>
                    </div>

                    {/* Card 2 */}
                    <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl hover:shadow-2xl transition-all hover:-translate-y-2 group relative overflow-hidden">
                        <div className="absolute top-0 right-0 bg-emerald-500 text-white text-xs font-bold px-3 py-1 rounded-bl-xl">Pro & Enterprise</div>
                        <div className="w-14 h-14 bg-emerald-100 dark:bg-emerald-900/50 rounded-2xl flex items-center justify-center text-emerald-600 dark:text-emerald-400 mb-6 group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                            <TrendingUp size={32} />
                        </div>
                        <h3 className="text-2xl font-black mb-3">Instant Storefront</h3>
                        <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                            Get a beautiful, mobile-ready website instantly. We handle payments, taxes, and order tracking so you never miss a sale.
                        </p>
                    </div>

                    {/* Card 3 */}
                    <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl hover:shadow-2xl transition-all hover:-translate-y-2 group">
                        <div className="w-14 h-14 bg-amber-100 dark:bg-amber-900/50 rounded-2xl flex items-center justify-center text-amber-600 dark:text-amber-400 mb-6 group-hover:bg-amber-600 group-hover:text-white transition-colors">
                            <DollarSign size={32} />
                        </div>
                        <h3 className="text-2xl font-black mb-3">Fundraising Engine</h3>
                        <p className="text-slate-500 dark:text-slate-400 leading-relaxed">
                            Partner with local schools and teams effortlessly. Our built-in fundraising portal makes you the community hero (and boosts sales).
                        </p>
                    </div>
                </div>
            </section>

            {/* Social Proof */}
            <section className="bg-slate-100 dark:bg-slate-800/50 py-16 px-6 mb-20">
                <div className="max-w-4xl mx-auto text-center">
                    <p className="text-slate-500 font-bold uppercase tracking-widest text-sm mb-8">Trusted by Kitchens Across the Country</p>
                    <div className="flex flex-wrap justify-center gap-10 md:gap-20 opacity-50 grayscale hover:grayscale-0 transition-all">
                        <span className="text-2xl font-black text-slate-800 dark:text-white">DinnerPrep PRO</span>
                        <span className="text-2xl font-black text-slate-800 dark:text-white">The Family Table</span>
                        <span className="text-2xl font-black text-slate-800 dark:text-white">Chef's Pantry</span>
                        <span className="text-2xl font-black text-slate-800 dark:text-white">LocalEats</span>
                    </div>
                </div>
            </section>

            {/* Lead Capture Form */}
            <section id="get-started" className="max-w-3xl mx-auto px-6 pb-32">
                <div className="bg-white dark:bg-slate-800 rounded-[2.5rem] p-8 md:p-12 border border-slate-200 dark:border-slate-700 shadow-2xl relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>

                    {status === 'SUCCESS' ? (
                        <div className="text-center py-12">
                            <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6">
                                <CheckCircle size={40} />
                            </div>
                            <h2 className="text-3xl font-black mb-4">You're on the list!</h2>
                            <p className="text-slate-500 max-w-md mx-auto">
                                Check your email for a welcome packet. We'll be in touch shortly to help you get your kitchen started.
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className="text-center mb-10">
                                <h2 className="text-3xl md:text-4xl font-black mb-4">Ready to start cooking?</h2>
                                <p className="text-slate-500">Join the waiting list for early access to FreezerIQ.</p>
                            </div>

                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1 ml-1">Your Name</label>
                                        <input
                                            required
                                            type="text"
                                            className="w-full p-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                            placeholder="Gordon Ramsay"
                                            value={formData.name}
                                            onChange={e => setFormData({ ...formData, name: e.target.value })}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1 ml-1">Email Address</label>
                                        <input
                                            required
                                            type="email"
                                            className="w-full p-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                            placeholder="chef@kitchen.com"
                                            value={formData.email}
                                            onChange={e => setFormData({ ...formData, email: e.target.value })}
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1 ml-1">I describe myself as...</label>
                                    <select
                                        className="w-full p-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                        value={formData.type}
                                        onChange={e => setFormData({ ...formData, type: e.target.value })}
                                    >
                                        <option>Professional Chef / Caterer</option>
                                        <option>Home Cook / Hobbyist</option>
                                        <option>Restaurant Owner</option>
                                        <option>Meal Prep Service</option>
                                    </select>
                                </div>

                                <button
                                    disabled={status === 'LOADING'}
                                    type="submit"
                                    className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-lg rounded-xl shadow-lg hover:shadow-xl hover:scale-[1.02] active:scale-[0.98] transition-all mt-4 flex justify-center items-center gap-2"
                                >
                                    {status === 'LOADING' && <Loader2 className="animate-spin" />}
                                    {status === 'LOADING' ? 'Sending...' : 'Get Early Access'}
                                </button>
                                <p className="text-xs text-center text-slate-400 mt-4">
                                    No credit card required. Limited spots available for Beta.
                                </p>
                            </form>
                        </>
                    )}
                </div>
            </section>

            <StorefrontFooter
                businessName="FreezerIQ Platform"
                slug=""
                primaryColor="#4f46e5"
            />
        </div>
    );
}
