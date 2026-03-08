import React from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle, Gift, Calendar, Sparkles, ChefHat } from 'lucide-react';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
import { notFound } from 'next/navigation';
import SubscribeClient from './SubscribeClient';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const business = await prisma.business.findUnique({
        where: { slug },
    });

    if (!business) return { title: 'Subscribe & Save' };

    const branding = await prisma.tenantBranding.findFirst({
        where: { user: { business_id: business.id } },
    });

    return {
        title: `Subscribe & Save | ${branding?.business_name || 'Freezer Chef'}`,
        description: 'Build your custom meal box and save up to 20%.',
    };
}

export default async function SubscribePage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const business = await prisma.business.findUnique({
        where: { slug }
    });

    if (!business) {
        notFound();
    }

    const branding = await prisma.tenantBranding.findFirst({
        where: { user: { business_id: business.id } },
    });

    const primaryColor = branding?.primary_color || '#4f46e5';

    return (
        <div className="min-h-screen bg-brand-cream dark:bg-slate-950">
            {/* Header */}
            <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-b border-slate-100 dark:border-slate-800 sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
                    <Link
                        href={`/shop/${slug}`}
                        className="flex items-center gap-2 text-slate-500 hover:text-slate-900 dark:hover:text-white transition-colors font-black uppercase tracking-widest text-[#10px]"
                    >
                        <ArrowLeft size={16} />
                        Back to Menu
                    </Link>

                    <div className="flex items-center gap-3">
                        {branding?.logo_url ? (
                            <img src={branding.logo_url} alt="Logo" className="h-10 object-contain" />
                        ) : (
                            <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center">
                                <ChefHat size={20} className="text-slate-400" />
                            </div>
                        )}
                    </div>
                    <div className="w-[100px]" /> {/* Spacer for centering */}
                </div>
            </header>

            <main className="max-w-4xl mx-auto px-6 py-20 pb-40">
                <div className="text-center space-y-6 mb-20 relative">
                    {/* Ambient Glow */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full max-w-lg blur-[120px] opacity-20 pointer-events-none" style={{ backgroundColor: primaryColor }} />

                    <div className="inline-flex items-center gap-2 bg-indigo-50 dark:bg-indigo-900/30 px-5 py-2 rounded-full border border-indigo-100 dark:border-indigo-800/50 mb-4 relative z-10">
                        <Sparkles size={14} className="text-indigo-600 dark:text-indigo-400" />
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-700 dark:text-indigo-300">
                            The VIP Experience
                        </span>
                    </div>
                    <h1 className="text-5xl md:text-7xl font-black text-slate-900 dark:text-white tracking-tight leading-[1.1] relative z-10">
                        Subscribe & <span style={{ color: primaryColor }}>Save 10%</span>
                    </h1>
                    <p className="text-xl md:text-2xl text-slate-600 dark:text-slate-400 font-medium max-w-2xl mx-auto relative z-10">
                        Become a VIP member to unlock the "Build-A-Box" experience. Pick your favorite meals, save money, and never stress about dinner again.
                    </p>
                </div>

                {/* Benefits Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-24">
                    <div className="bg-white dark:bg-slate-900 p-8 rounded-[2rem] shadow-xl shadow-slate-200/50 dark:shadow-none border border-slate-100 dark:border-slate-800 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-teal-50 dark:bg-slate-800 flex items-center justify-center mx-auto mb-6 text-teal-600">
                            <CheckCircle size={32} />
                        </div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-3">Total Flexibility</h3>
                        <p className="text-slate-500 font-medium">Create your own custom bundle every month. Pick an assortment of different meals, or stock up entirely on your favorite.</p>
                    </div>

                    <div className="bg-white dark:bg-slate-900 p-8 rounded-[2rem] shadow-xl shadow-slate-200/50 dark:shadow-none border border-slate-100 dark:border-slate-800 text-center relative overflow-hidden">
                        <div className="absolute top-0 inset-x-0 h-1" style={{ backgroundColor: primaryColor }} />
                        <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-slate-800 flex items-center justify-center mx-auto mb-6 text-indigo-600">
                            <Gift size={32} />
                        </div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-3">VIP Perks</h3>
                        <p className="text-slate-500 font-medium">Save 10% on every box, earn double loyalty points, and get first access to our seasonal mystery meals.</p>
                    </div>

                    <div className="bg-white dark:bg-slate-900 p-8 rounded-[2rem] shadow-xl shadow-slate-200/50 dark:shadow-none border border-slate-100 dark:border-slate-800 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-rose-50 dark:bg-slate-800 flex items-center justify-center mx-auto mb-6 text-rose-600">
                            <Calendar size={32} />
                        </div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-3">Zero Commitment</h3>
                        <p className="text-slate-500 font-medium">Going out of town? Need a break? Easily skip a month, pause, or cancel your subscription online at any time.</p>
                    </div>
                </div>

                {/* Dynamic Pricing Cards */}
                <SubscribeClient
                    businessId={business.id}
                    slug={slug}
                    primaryColor={primaryColor}
                    tiers={[]}
                />

            </main>
        </div>
    );
}
