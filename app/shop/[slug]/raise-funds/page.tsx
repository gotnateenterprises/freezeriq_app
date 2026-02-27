"use client";

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle, ArrowRight, DollarSign, Calendar, Users, Heart } from 'lucide-react';
import Link from 'next/link';
import StorefrontHero from '@/components/shop/StorefrontHero';
import StorefrontFooter from '@/components/shop/StorefrontFooter';

export default function RaiseFundsPage() {
    const { slug } = useParams();
    // In a real app, we'd fetch tenant branding here. For now, we'll use defaults or context if available.
    // For specific tenant color, we might need to fetch or use a layout wrapper.
    // Standardizing on indigo/emerald for this sales page for now.

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
            {/* Hero */}
            <div className="relative overflow-hidden bg-slate-950 text-white min-h-[85vh] flex flex-col justify-center items-center">
                {/* Background Image / Soft Overlay */}
                <div className="absolute inset-0 z-0">
                    <img
                        src="https://images.unsplash.com/photo-1547592180-85f173990554?q=80&w=2670&auto=format&fit=crop"
                        alt="Delicious food background"
                        className="w-full h-full object-cover opacity-30 mix-blend-overlay scale-110 blur-sm pointer-events-none"
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-indigo-900/50 via-slate-950/80 to-slate-950" />
                    <div className="absolute inset-0 opacity-[0.1]" style={{
                        backgroundImage: 'radial-gradient(circle at 2px 2px, #ffffff 1px, transparent 0)',
                        backgroundSize: '32px 32px'
                    }} />

                    {/* Glowing Orbs */}
                    <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500/30 rounded-full blur-[100px] pointer-events-none mix-blend-screen" />
                    <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-pink-500/20 rounded-full blur-[100px] pointer-events-none mix-blend-screen" />
                </div>

                <div className="relative z-10 max-w-5xl mx-auto px-6 text-center space-y-8 mt-12">
                    <div className="inline-flex items-center gap-2 bg-gradient-to-r from-pink-500/20 to-indigo-500/20 backdrop-blur-md border border-white/10 px-6 py-2 rounded-full text-indigo-100 font-black text-xs uppercase tracking-widest shadow-xl shadow-pink-500/10">
                        <Heart size={14} className="text-pink-400 fill-pink-400 animate-pulse" /> Easy Community Fundraising
                    </div>
                    <h1 className="text-6xl md:text-8xl font-black tracking-tighter leading-[1.05] drop-shadow-2xl">
                        Raise Money with <br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 via-pink-400 to-indigo-400 animate-gradient-x">
                            Delicious Meals
                        </span>
                    </h1>
                    <p className="text-xl md:text-3xl text-indigo-100/90 max-w-3xl mx-auto leading-relaxed font-medium drop-shadow-md">
                        Tired of the same old products? Sell healthy, family-friendly freezer meals that your community <span className="text-white font-black border-b-2 border-pink-500 pb-1">actually wants.</span>
                    </p>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-6 pt-10">
                        <a href="#contact-form" className="group relative inline-flex items-center justify-center px-10 py-5 font-black text-white transition-all duration-300 bg-gradient-to-br from-pink-500 to-indigo-600 rounded-[2rem] hover:scale-105 hover:shadow-[0_20px_40px_-10px_rgba(236,72,153,0.5)] overflow-hidden">
                            <span className="absolute inset-0 w-full h-full -mt-1 rounded-lg opacity-30 bg-gradient-to-b from-transparent via-transparent to-black pointer-events-none"></span>
                            <span className="relative flex items-center gap-3 text-lg uppercase tracking-widest">
                                Start a Fundraiser
                                <ArrowRight size={24} className="group-hover:translate-x-1 transition-transform" />
                            </span>
                        </a>
                        <Link href={`/shop/${slug}`} className="px-8 py-5 rounded-[2rem] font-black text-white hover:text-indigo-200 transition-colors uppercase tracking-widest hover:bg-white/5 backdrop-blur-sm border border-transparent hover:border-white/10">
                            View Current Sales
                        </Link>
                    </div>
                </div>
            </div>

            {/* Intro / Pitch */}
            <section className="py-16 px-6 max-w-4xl mx-auto text-center space-y-6">
                <h2 className="text-3xl font-black text-slate-900 dark:text-white">Simple, Profitable, and Stress-Free!</h2>
                <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed">
                    When you choose Freezer Chef, you’re offering more than a fundraiser—you’re delivering delicious, homemade-style meals that bring comfort to tables and support to your Cause & Community!
                    With over 10 years of experience, we know what it takes to make your event a success. Your group <strong>earns 20% of all sales</strong>, and we’re with you every step of the way.
                </p>
            </section>

            {/* Value Props & Pricing */}
            <section className="py-12 px-6 max-w-7xl mx-auto">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl shadow-lg border border-slate-100 dark:border-slate-700">
                        <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-900/30 rounded-xl flex items-center justify-center text-emerald-600 mb-4">
                            <DollarSign size={24} />
                        </div>
                        <h3 className="text-xl font-black mb-2">You Keep 20%</h3>
                        <p className="text-slate-500 text-sm">Full payment is due 10 days before delivery. You pay us the total due and keep your 20% profit instantly.</p>
                    </div>
                    <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl shadow-lg border border-slate-100 dark:border-slate-700">
                        <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center text-indigo-600 mb-4">
                            <Users size={24} />
                        </div>
                        <h3 className="text-xl font-black mb-2">Great Value for Families</h3>
                        <ul className="text-slate-500 text-sm space-y-2">
                            <li><strong>$125</strong> for 5 meals (serves 5–6)</li>
                            <li><strong>$60</strong> for 5 meals (serves 2)</li>
                            <li>That's just <strong>$5–$7 per serving!</strong></li>
                        </ul>
                    </div>
                    <div className="bg-white dark:bg-slate-800 p-8 rounded-3xl shadow-lg border border-slate-100 dark:border-slate-700">
                        <div className="w-12 h-12 bg-pink-100 dark:bg-pink-900/30 rounded-xl flex items-center justify-center text-pink-600 mb-4">
                            <CheckCircle size={24} />
                        </div>
                        <h3 className="text-xl font-black mb-2">Minimum Requirements</h3>
                        <p className="text-slate-500 text-sm">
                            Just 10 sets of 5 meals (serves 5-6). You can mix and match—two "serves 2" sets count as one family-size set.
                        </p>
                    </div>
                </div>
            </section>

            {/* How It Works Steps */}
            <section className="py-24 bg-white dark:bg-slate-900">
                <div className="max-w-4xl mx-auto px-6">
                    <div className="text-center mb-16">
                        <span className="text-indigo-600 font-bold uppercase tracking-widest text-xs">The Process</span>
                        <h2 className="text-4xl font-black mt-2">How It Works</h2>
                    </div>

                    <div className="space-y-12">
                        {[
                            { title: 'Schedule Your Fundraiser', desc: 'Choose your delivery date (Tue, Wed, or Thu) and location. Contact us to book.' },
                            { title: 'Pick Your Menu', desc: 'Choose 2 meal bundles. Each bundle has 5 dinners (3 slow-cooker, 2 oven-ready). Customize to suit your audience.' },
                            { title: 'Set Deadlines & Promote', desc: 'Collect orders usually 2 weeks prior to delivery. We provide a custom Coordinator dashboard, Marketing tools and Donor facing webpage where you can easily manage your fundraiser online and off.' },
                            { title: 'Delivery & Distribution', desc: 'We arrive 15–30 mins early. Have volunteers ready to help unload. Families pick up their fresh meals.' },
                            { title: 'Enjoy Your Profits', desc: 'Your organization keeps 20% of the proceeds. Simple as that!' }
                        ].map((step, i) => (
                            <div key={i} className="flex gap-6 items-start">
                                <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center font-black text-xl text-slate-400 flex-shrink-0 border-4 border-white dark:border-slate-900 shadow-sm z-10">
                                    {i + 1}
                                </div>
                                <div className="pt-1 border-l-2 border-slate-100 dark:border-slate-800 pl-8 -ml-12 pb-12 last:pb-0 last:border-0 relative top-2">
                                    <h4 className="text-2xl font-black mb-3 text-slate-900 dark:text-white">{step.title}</h4>
                                    <p className="text-slate-600 dark:text-slate-400 text-lg leading-relaxed">{step.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Contact Form */}
            <section id="contact-form" className="py-24 px-6 bg-slate-50 dark:bg-slate-800/50">
                <div className="max-w-2xl mx-auto bg-white dark:bg-slate-900 p-8 md:p-12 rounded-[2.5rem] shadow-xl">
                    <div className="text-center mb-8">
                        <h2 className="text-3xl font-black mb-3">Request a Fundraiser</h2>
                        <p className="text-slate-500">Ready to get started? Fill out the form below and we'll be in touch.</p>
                    </div>

                    <form className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Full Name *</label>
                                <input type="text" required className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Email *</label>
                                <input type="email" required className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Phone Number *</label>
                                <input type="tel" required className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Organization Name *</label>
                                <input type="text" required className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Website</label>
                            <input type="url" className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Delivery Location *</label>
                            <input type="text" required className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all" />
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Tell us about your cause</label>
                            <textarea rows={3} className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"></textarea>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Notes</label>
                            <textarea rows={2} className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"></textarea>
                        </div>

                        <button type="submit" className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl shadow-lg transition-transform hover:scale-[1.02] active:scale-95">
                            Submit Request
                        </button>
                        <p className="text-xs text-center text-slate-400 mt-4">
                            Protected by reCAPTCHA and the Google Privacy Policy and Terms of Service.
                        </p>
                    </form>
                </div>
            </section>
        </div>
    );
}
