"use client";

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { Heart, ShoppingBag, ArrowLeft, Info, ChevronRight, Tag } from 'lucide-react';
import CartDrawer from '@/components/shop/CartDrawer';
import DeliciousGrid from '@/components/shop/DeliciousGrid';
import PurchaseSidebar from '@/components/shop/PurchaseSidebar';
import FilterBar from '@/components/shop/FilterBar';
import BundleDetailsModal from '@/components/shop/BundleDetailsModal';
import { useCart } from '@/context/CartContext';

export default function FundraiserClient({
    business,
    campaign,
    raised,
    progress,
    slug,
    fundraiserId
}: any) {
    const { addToCart } = useCart();
    const [activeFilters, setActiveFilters] = useState<string[]>([]);
    const [isBundleModalOpen, setIsBundleModalOpen] = useState(false);
    const primaryColor = business.branding?.primary_color || '#4f46e5';

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
        }).format(amount);
    };

    const mainBundle = business.bundles[0];

    // Compute Dynamic Tags from the main bundle
    const availableTags = useMemo(() => {
        if (!mainBundle || !mainBundle.items) return [];
        const tags = new Set<string>();
        mainBundle.items.forEach((c: any) => {
            const r = c.recipe;
            if (!r) return;
            if (r.macros) r.macros.split(',').forEach((t: string) => {
                const trimmed = t.trim();
                if (trimmed) tags.add(trimmed);
            });
            if (r.allergens) r.allergens.split(',').forEach((t: string) => {
                const trimmed = t.trim();
                if (trimmed) tags.add(trimmed);
            });
        });
        return Array.from(tags).sort();
    }, [mainBundle]);

    const filteredRecipes = useMemo(() => {
        const rawRecipes = mainBundle?.items?.map((c: any) => c.recipe).filter(Boolean) || [];
        if (activeFilters.length === 0) return rawRecipes;

        return rawRecipes.filter((r: any) => {
            const recipeTags = [
                ...(r.macros ? r.macros.split(',').map((t: string) => t.trim().toLowerCase()) : []),
                ...(r.allergens ? r.allergens.split(',').map((t: string) => t.trim().toLowerCase()) : [])
            ];
            // Match ALL active filters to allow drill-down
            return activeFilters.every((f: string) => recipeTags.includes(f.toLowerCase()));
        });
    }, [mainBundle, activeFilters]);

    const handleToggleFilter = (tag: string) => {
        setActiveFilters(prev =>
            prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
        );
    };

    return (
        <div className="min-h-screen bg-brand-cream dark:bg-slate-950 pb-32">
            {/* Immersive Header - Warm & Giving */}
            <div className="relative pt-16 pb-32 px-4 overflow-hidden min-h-[50vh] flex flex-col justify-center" style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, #ec4899 100%)` }}>
                {/* Background Image / Soft Overlay */}
                <div className="absolute inset-0 z-0">
                    {mainBundle?.image_url && (
                        <img
                            src={mainBundle.image_url}
                            alt="Background"
                            className="w-full h-full object-cover opacity-20 mix-blend-overlay scale-110 blur-xl fixed pointer-events-none"
                        />
                    )}
                    <div className="absolute inset-0 bg-white/10 backdrop-blur-[2px]" />
                    <div className="absolute inset-0 opacity-[0.1]" style={{
                        backgroundImage: 'radial-gradient(circle at 2px 2px, #ffffff 1px, transparent 0)',
                        backgroundSize: '32px 32px'
                    }} />
                    <div className="absolute inset-0 bg-gradient-to-t from-brand-cream dark:from-slate-950 to-transparent" />
                </div>

                <div className="max-w-6xl mx-auto relative z-10 w-full">
                    <div className="flex flex-col items-center text-center space-y-6">
                        <Link
                            href={`/shop/${slug}`}
                            className="inline-flex items-center gap-2 text-white/90 hover:text-white transition-all font-black uppercase tracking-[0.2em] text-[10px] bg-black/20 px-5 py-2.5 rounded-full backdrop-blur-md shadow-sm border border-white/20 hover:bg-black/30"
                        >
                            <ArrowLeft size={14} strokeWidth={3} />
                            Back to {business.name} Shop
                        </Link>

                        <div className="space-y-4 max-w-2xl px-4">
                            <span className="inline-flex items-center gap-2 bg-[#EEDF5D] text-slate-800 px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-[0.2em] animate-pulse border-2 border-[#EEDF5D] shadow-lg shadow-[#EEDF5D]/40">
                                <Heart size={12} className="fill-slate-800" />
                                Live Fundraiser
                            </span>
                            <h1 className="text-4xl md:text-6xl font-black tracking-tight text-white leading-[1.1] drop-shadow-md">
                                Help us support <br />
                                <span className="text-yellow-200">{campaign.organization_name}</span>
                            </h1>
                            <p className="text-white/90 text-lg md:text-xl font-medium leading-relaxed drop-shadow-sm pb-4">
                                Every delicious meal you buy directly funds our mission. Thank you for your incredible generosity!
                            </p>
                        </div>

                        {/* Goal Progress Card  */}
                        <div className="bg-white/10 backdrop-blur-2xl p-8 md:p-10 rounded-[3rem] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.5)] max-w-xl w-full border-2 border-white/40 overflow-hidden relative">
                            {/* Inner ambient glow */}
                            <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />

                            <div className="flex justify-between items-end mb-6 relative z-10">
                                <div className="text-left">
                                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1 drop-shadow-sm">Impact Raised So Far</p>
                                    <p className="text-5xl font-black text-white tracking-tight drop-shadow-md">{formatCurrency(raised)}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1 drop-shadow-sm">Our Goal</p>
                                    <p className="text-xl font-black text-slate-100 drop-shadow-md">{campaign.goal_amount ? formatCurrency(Number(campaign.goal_amount)) : 'No Goal Set'}</p>
                                </div>
                            </div>

                            {/* Progress Bar  */}
                            <div className="h-6 bg-black/40 rounded-full overflow-hidden shadow-inner p-1 relative z-10 border border-white/10">
                                <div
                                    className="h-full rounded-full transition-all duration-1000 ease-out relative shadow-[0_4px_12px_rgba(255,255,255,0.2)]"
                                    style={{ width: `${progress}%`, backgroundColor: primaryColor }}
                                >
                                    <div className="absolute inset-0 bg-gradient-to-r from-white/30 via-transparent to-transparent animate-[shimmer_2s_infinite]"></div>
                                </div>
                            </div>

                            <div className="mt-8 flex items-center justify-center gap-2 py-4 bg-white/40 rounded-2xl border border-white/50 relative z-10 backdrop-blur-md shadow-inner">
                                <Heart className="w-4 h-4 text-pink-600 fill-pink-600 drop-shadow-sm" />
                                <p className="text-[10px] font-black text-pink-700 uppercase tracking-widest drop-shadow-sm">
                                    Help us reach our goal by placing an order!
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <main className="max-w-7xl mx-auto px-6 -mt-12 relative z-20">
                <div className="flex flex-col-reverse lg:flex-row gap-16">
                    {/* Left Column: Photo Grid & About */}
                    <div className="flex-1 space-y-16">
                        {/* The Delicious Grid */}
                        <div className="space-y-6">
                            <div className="flex items-center gap-2 mb-4">
                                <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-indigo-600">
                                    <ShoppingBag size={20} />
                                </div>
                                <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight uppercase tracking-[0.1em]">On The Menu</h2>
                            </div>

                            {availableTags.length > 0 && (
                                <FilterBar
                                    availableTags={availableTags}
                                    activeFilters={activeFilters}
                                    onToggleFilter={handleToggleFilter}
                                    primaryColor={primaryColor}
                                />
                            )}

                            <DeliciousGrid recipes={filteredRecipes} />
                        </div>

                        {/* About This Mission */}
                        {campaign.about_text && (
                            <section className="bg-indigo-50/30 dark:bg-slate-900/50 p-12 rounded-[3.5rem] border border-indigo-100/50 dark:border-slate-800">
                                <div className="flex items-center gap-3 mb-6 font-black uppercase tracking-[0.2em] text-[10px] text-indigo-600">
                                    <Info size={16} />
                                    About This Fundraiser
                                </div>
                                <div className="prose prose-lg dark:prose-invert max-w-none text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
                                    <p className="whitespace-pre-wrap">{campaign.about_text}</p>
                                </div>
                            </section>
                        )}
                    </div>

                    {/* Right Column: Sticky Purchase Box */}
                    <div className="lg:w-[400px]">
                        {mainBundle && (
                            <PurchaseSidebar
                                bundle={mainBundle}
                                primaryColor={primaryColor}
                                onViewMenu={() => setIsBundleModalOpen(true)}
                            />
                        )}

                        <div className="mt-8 p-10 bg-gradient-to-br from-indigo-600 to-indigo-700 rounded-[2.5rem] text-white space-y-6 shadow-2xl shadow-indigo-500/20 text-center flex flex-col items-center">
                            <h4 className="text-xl font-black leading-tight">Host Your Own Fundraiser</h4>
                            <p className="text-indigo-100 text-sm font-medium leading-relaxed">
                                Need to raise money for your team, school, or church? Freezer meals are the perfect fundraiser.
                            </p>
                            <Link
                                href={`/shop/${slug}/raise-funds`}
                                className="inline-flex items-center gap-2 bg-white text-indigo-600 px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-transform hover:scale-105 shadow-xl shadow-indigo-900/40"
                            >
                                Learn More
                                <ChevronRight size={14} strokeWidth={3} />
                            </Link>
                        </div>
                    </div>
                </div>
            </main>

            <CartDrawer
                primaryColor={primaryColor}
                businessId={business.id}
                slug={slug}
                campaignId={fundraiserId}
                campaignParticipantLabel={campaign.participant_label}
            />

            {mainBundle && (
                <BundleDetailsModal
                    isOpen={isBundleModalOpen}
                    onClose={() => setIsBundleModalOpen(false)}
                    bundle={mainBundle}
                    primaryColor={primaryColor}
                    onAddToCart={(quantity) => {
                        addToCart({
                            bundleId: mainBundle.id,
                            name: mainBundle.name,
                            price: Number(mainBundle.price || 0),
                            image_url: mainBundle.image_url || '',
                            serving_tier: mainBundle.serving_tier || 'family',
                            quantity: quantity,
                            isSubscription: false
                        });
                        setIsBundleModalOpen(false);
                    }}
                />
            )}
        </div>
    );
}
