"use client";

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import { Heart, ShoppingBag, ArrowLeft, Info, ChevronRight, ChevronDown, UtensilsCrossed, Mail } from 'lucide-react';
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
    const [selectedBundle, setSelectedBundle] = useState<any>(null);
    const primaryColor = business.branding?.primary_color || '#4f46e5';
    const coordinatorEmail = campaign.coordinator_email || '';

    const buildMailtoUrl = (bundleName?: string, bundlePrice?: number) => {
        if (!coordinatorEmail) return '';
        const subject = encodeURIComponent(
            bundleName
                ? `Fundraiser Bundle Order - ${bundleName}`
                : 'Freezer Meal Fundraiser Order'
        );
        const priceStr = bundlePrice && bundlePrice > 0 ? `$${bundlePrice.toFixed(2)}` : 'See coordinator';
        const body = encodeURIComponent(
            `Hi!\n\nI'd like to place an order for the fundraiser.\n\n` +
            `Bundle: ${bundleName || ''}\n` +
            `Price: ${priceStr}\n\n` +
            `Quantity: \n` +
            `Name: \n` +
            `Phone: \n\n` +
            `Please let me know the next steps for payment and pickup.\n\nThanks!`
        );
        return `mailto:${coordinatorEmail}?subject=${subject}&body=${body}`;
    };

    const formatCurrency = (amount: number) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
        }).format(amount);
    };

    const bundles = business.bundles || [];
    const mainBundle = bundles[0];

    // Collect all recipes across ALL bundles for the "On The Menu" grid
    const allRecipes = useMemo(() => {
        const seen = new Set<string>();
        const recipes: any[] = [];
        bundles.forEach((b: any) => {
            (b.items || []).forEach((c: any) => {
                const r = c.recipe;
                if (!r || !r.name) return;
                const key = r.name;
                if (!seen.has(key)) {
                    seen.add(key);
                    recipes.push(r);
                }
            });
        });
        return recipes;
    }, [bundles]);

    // Compute Dynamic Tags from ALL bundle recipes
    const availableTags = useMemo(() => {
        const tags = new Set<string>();
        allRecipes.forEach((r: any) => {
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
    }, [allRecipes]);

    const filteredRecipes = useMemo(() => {
        if (activeFilters.length === 0) return allRecipes;

        return allRecipes.filter((r: any) => {
            const recipeTags = [
                ...(r.macros ? r.macros.split(',').map((t: string) => t.trim().toLowerCase()) : []),
                ...(r.allergens ? r.allergens.split(',').map((t: string) => t.trim().toLowerCase()) : [])
            ];
            return activeFilters.every((f: string) => recipeTags.includes(f.toLowerCase()));
        });
    }, [allRecipes, activeFilters]);

    const handleToggleFilter = (tag: string) => {
        setActiveFilters(prev =>
            prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
        );
    };

    const handleOpenBundleModal = (bundle: any) => {
        setSelectedBundle(bundle);
        setIsBundleModalOpen(true);
    };

    return (
        <div className="min-h-screen bg-brand-cream dark:bg-slate-950 pb-24 sm:pb-32">
            {/* === Hero Header === */}
            <div
                className="relative pt-10 sm:pt-16 pb-24 sm:pb-32 px-3 sm:px-4 overflow-hidden min-h-[40vh] sm:min-h-[50vh] flex flex-col justify-center"
                style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, #ec4899 100%)` }}
            >
                {/* Background image overlay */}
                <div className="absolute inset-0 z-0">
                    {mainBundle?.image_url && (
                        <img
                            src={mainBundle.image_url}
                            alt=""
                            className="w-full h-full object-cover opacity-20 mix-blend-overlay scale-110 blur-xl pointer-events-none"
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
                    <div className="flex flex-col items-center text-center space-y-4 sm:space-y-6">
                        <Link
                            href={`/shop/${slug}`}
                            className="inline-flex items-center gap-2 text-white/90 hover:text-white transition-all font-black uppercase tracking-[0.15em] sm:tracking-[0.2em] text-[9px] sm:text-[10px] bg-black/20 px-4 sm:px-5 py-2 sm:py-2.5 rounded-full backdrop-blur-md shadow-sm border border-white/20 hover:bg-black/30"
                        >
                            <ArrowLeft size={12} strokeWidth={3} />
                            <span className="hidden sm:inline">Back to {business.name} Shop</span>
                            <span className="sm:hidden">Back to Shop</span>
                        </Link>

                        <div className="space-y-3 sm:space-y-4 max-w-2xl px-1 sm:px-4">
                            <span className="inline-flex items-center gap-2 bg-[#EEDF5D] text-slate-800 px-3 sm:px-4 py-1.5 rounded-full text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] animate-pulse border-2 border-[#EEDF5D] shadow-lg shadow-[#EEDF5D]/40">
                                <Heart size={11} className="fill-slate-800" />
                                Live Fundraiser
                            </span>
                            <h1 className="text-3xl sm:text-4xl md:text-6xl font-black tracking-tight text-white leading-[1.1] drop-shadow-md">
                                Help us support <br />
                                <span className="text-yellow-200">{campaign.organization_name}</span>
                            </h1>
                            <p className="text-white/90 text-sm sm:text-lg md:text-xl font-medium leading-relaxed drop-shadow-sm pb-2 sm:pb-4">
                                Every delicious meal you buy directly funds our mission.
                            </p>
                        </div>

                        {/* === Progress Card === */}
                        <div className="bg-white/10 backdrop-blur-2xl p-5 sm:p-8 md:p-10 rounded-2xl sm:rounded-[3rem] shadow-[0_32px_64px_-16px_rgba(0,0,0,0.5)] max-w-xl w-full border-2 border-white/40 overflow-hidden relative">
                            <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />

                            <div className="flex justify-between items-end mb-4 sm:mb-6 relative z-10">
                                <div className="text-left">
                                    <p className="text-[9px] sm:text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1 drop-shadow-sm">Raised</p>
                                    <p className="text-3xl sm:text-5xl font-black text-white tracking-tight drop-shadow-md">{formatCurrency(raised)}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-[9px] sm:text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1 drop-shadow-sm">Goal</p>
                                    <p className="text-base sm:text-xl font-black text-slate-100 drop-shadow-md">{campaign.goal_amount ? formatCurrency(Number(campaign.goal_amount)) : 'No Goal Set'}</p>
                                </div>
                            </div>

                            {/* Progress Bar */}
                            <div className="h-5 sm:h-6 bg-black/40 rounded-full overflow-hidden shadow-inner p-1 relative z-10 border border-white/10">
                                <div
                                    className="h-full rounded-full transition-all duration-1000 ease-out relative shadow-[0_4px_12px_rgba(255,255,255,0.2)]"
                                    style={{ width: `${progress}%`, backgroundColor: primaryColor }}
                                >
                                    <div className="absolute inset-0 bg-gradient-to-r from-white/30 via-transparent to-transparent animate-[shimmer_2s_infinite]"></div>
                                </div>
                            </div>

                            <div className="mt-5 sm:mt-8 flex items-center justify-center gap-2 py-3 sm:py-4 bg-white/40 rounded-xl sm:rounded-2xl border border-white/50 relative z-10 backdrop-blur-md shadow-inner px-3">
                                <Heart className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-pink-600 fill-pink-600 drop-shadow-sm shrink-0" />
                                <p className="text-[9px] sm:text-[10px] font-black text-pink-700 uppercase tracking-widest drop-shadow-sm">
                                    Place an order to help us reach our goal!
                                </p>
                            </div>

                            {/* Order by Email CTA */}
                            {coordinatorEmail && (
                                <a
                                    href={buildMailtoUrl()}
                                    className="mt-4 sm:mt-6 w-full flex items-center justify-center gap-2.5 py-3.5 sm:py-4 rounded-xl sm:rounded-2xl font-black text-xs sm:text-sm uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-95 shadow-lg relative z-10"
                                    style={{ backgroundColor: '#fff', color: primaryColor, border: `2px solid rgba(255,255,255,0.5)` }}
                                >
                                    <Mail size={16} strokeWidth={3} />
                                    Order by Email
                                </a>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* === Main Content Area === */}
            <main className="max-w-7xl mx-auto px-3 sm:px-6 -mt-8 sm:-mt-12 relative z-20">
                <div className="flex flex-col-reverse lg:flex-row gap-8 sm:gap-12 lg:gap-16">

                    {/* Left Column: Bundles + Menu + About */}
                    <div className="flex-1 min-w-0 space-y-10 sm:space-y-16">

                        {/* === Bundle Cards Section === */}
                        {bundles.length > 0 && (
                            <section className="space-y-4 sm:space-y-6">
                                <div className="flex items-center gap-2">
                                    <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl sm:rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-indigo-600">
                                        <ShoppingBag size={18} />
                                    </div>
                                    <h2 className="text-lg sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight uppercase">Order a Bundle to Support Us</h2>
                                </div>
                                <p className="text-sm sm:text-base text-slate-500 dark:text-slate-400 font-medium -mt-1">
                                    Tap a bundle below to start your order by email.
                                </p>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                                    {bundles.map((bundle: any) => (
                                        <BundleCard
                                            key={bundle.id}
                                            bundle={bundle}
                                            primaryColor={primaryColor}
                                            onViewDetails={() => handleOpenBundleModal(bundle)}
                                            mailtoUrl={coordinatorEmail ? buildMailtoUrl(bundle.name, Number(bundle.price || 0)) : undefined}
                                        />
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* === On The Menu (All Recipes) === */}
                        {allRecipes.length > 0 && (
                            <div className="space-y-4 sm:space-y-6">
                                <div className="flex items-center gap-2">
                                    <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl sm:rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-indigo-600">
                                        <UtensilsCrossed size={18} />
                                    </div>
                                    <h2 className="text-lg sm:text-2xl font-black text-slate-900 dark:text-white tracking-tight uppercase">On The Menu</h2>
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
                        )}

                        {/* === About Section === */}
                        {campaign.about_text && (
                            <section className="bg-indigo-50/30 dark:bg-slate-900/50 p-6 sm:p-12 rounded-2xl sm:rounded-[3.5rem] border border-indigo-100/50 dark:border-slate-800">
                                <div className="flex items-center gap-3 mb-4 sm:mb-6 font-black uppercase tracking-[0.2em] text-[10px] text-indigo-600">
                                    <Info size={16} />
                                    About This Fundraiser
                                </div>
                                <div className="prose prose-sm sm:prose-lg dark:prose-invert max-w-none text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
                                    <p className="whitespace-pre-wrap">{campaign.about_text}</p>
                                </div>
                            </section>
                        )}
                    </div>

                    {/* Right Column: Purchase Sidebar (sticky on desktop, full-width on mobile) */}
                    <div className="w-full lg:w-[400px] lg:sticky lg:top-8 lg:self-start space-y-6 sm:space-y-8">
                        {mainBundle && (
                            <PurchaseSidebar
                                bundle={mainBundle}
                                primaryColor={primaryColor}
                            />
                        )}

                        <div className="p-6 sm:p-10 bg-gradient-to-br from-indigo-600 to-indigo-700 rounded-2xl sm:rounded-[2.5rem] text-white space-y-4 sm:space-y-6 shadow-2xl shadow-indigo-500/20 text-center flex flex-col items-center">
                            <h4 className="text-lg sm:text-xl font-black leading-tight">Host Your Own Fundraiser</h4>
                            <p className="text-indigo-100 text-xs sm:text-sm font-medium leading-relaxed">
                                Need to raise money for your team, school, or church? Freezer meals are the perfect fundraiser.
                            </p>
                            <Link
                                href={`/shop/${slug}/raise-funds`}
                                className="inline-flex items-center gap-2 bg-white text-indigo-600 px-5 sm:px-6 py-2.5 sm:py-3 rounded-xl sm:rounded-2xl font-black text-[10px] sm:text-xs uppercase tracking-widest transition-transform hover:scale-105 shadow-xl shadow-indigo-900/40"
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

            {selectedBundle && (
                <BundleDetailsModal
                    isOpen={isBundleModalOpen}
                    onClose={() => { setIsBundleModalOpen(false); setSelectedBundle(null); }}
                    bundle={selectedBundle}
                    primaryColor={primaryColor}
                    onAddToCart={(quantity) => {
                        addToCart({
                            bundleId: selectedBundle.id,
                            name: selectedBundle.name,
                            price: Number(selectedBundle.price || 0),
                            image_url: selectedBundle.image_url || '',
                            serving_tier: selectedBundle.serving_tier || 'family',
                            quantity: quantity,
                            isSubscription: false
                        });
                        setIsBundleModalOpen(false);
                        setSelectedBundle(null);
                    }}
                />
            )}
        </div>
    );
}

// ─── Bundle Card with Meal Listing ───────────────────────────
function BundleCard({ bundle, primaryColor, onViewDetails, mailtoUrl }: {
    bundle: any;
    primaryColor: string;
    onViewDetails: () => void;
    mailtoUrl?: string;
}) {
    const [expanded, setExpanded] = useState(false);
    const meals = (bundle.items || [])
        .map((i: any) => i.recipe)
        .filter((r: any) => r && r.name);

    return (
        <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-sm hover:shadow-lg transition-all overflow-hidden group">
            {/* Bundle image */}
            {bundle.image_url && (
                <div className="aspect-[16/9] overflow-hidden">
                    <img
                        src={bundle.image_url}
                        alt={bundle.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    />
                </div>
            )}

            <div className="p-4 sm:p-6">
                <h3 className="text-lg sm:text-xl font-black text-slate-900 dark:text-white mb-1">{bundle.name}</h3>
                {bundle.description && (
                    <p className="text-xs sm:text-sm text-slate-500 mb-3 line-clamp-2">{bundle.description}</p>
                )}

                <div className="flex items-center justify-between mb-4">
                    <span className="text-xl sm:text-2xl font-black" style={{ color: primaryColor }}>
                        {Number(bundle.price || 0) > 0 ? `$${Number(bundle.price).toFixed(2)}` : 'Contact for Price'}
                    </span>
                    {bundle.serving_tier && (
                        <span className="text-[9px] sm:text-[10px] font-black uppercase tracking-widest text-slate-400 bg-slate-50 dark:bg-slate-800 px-3 py-1 rounded-full">
                            {bundle.serving_tier === 'family' ? 'Serves 5-6' : 'Serves 2-3'}
                        </span>
                    )}
                </div>

                {/* Included meals */}
                {meals.length > 0 && (
                    <div className="border-t border-slate-100 dark:border-slate-800 pt-3 mt-1">
                        <button
                            onClick={() => setExpanded(!expanded)}
                            className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-indigo-500 hover:text-indigo-700 transition-colors w-full"
                        >
                            <UtensilsCrossed size={12} />
                            {meals.length} Meal{meals.length !== 1 ? 's' : ''} Included
                            <ChevronDown size={12} className={`ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </button>

                        {expanded && (
                            <ul className="mt-2 space-y-1.5">
                                {meals.map((meal: any, i: number) => (
                                    <li key={i} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400">
                                        {meal.image_url ? (
                                            <img src={meal.image_url} alt="" className="w-6 h-6 rounded-md object-cover shrink-0 mt-0.5" />
                                        ) : (
                                            <div className="w-6 h-6 rounded-md bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center shrink-0 mt-0.5">
                                                <UtensilsCrossed size={10} className="text-indigo-400" />
                                            </div>
                                        )}
                                        <span className="font-semibold">{meal.name}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                {mailtoUrl ? (
                    <a
                        href={mailtoUrl}
                        className="w-full mt-4 py-3.5 rounded-xl sm:rounded-2xl font-black text-[10px] sm:text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 text-white hover:shadow-lg hover:scale-[1.02] active:scale-95"
                        style={{ backgroundColor: primaryColor }}
                    >
                        <Mail size={14} strokeWidth={3} />
                        Order This Bundle
                    </a>
                ) : (
                    <div className="w-full mt-4 py-3 rounded-xl sm:rounded-2xl font-bold text-[10px] sm:text-xs text-center text-slate-400 bg-slate-50 dark:bg-slate-800">
                        Coordinator contact coming soon
                    </div>
                )}

                <button
                    onClick={onViewDetails}
                    className="w-full mt-2 py-2.5 rounded-xl sm:rounded-2xl font-bold text-[10px] sm:text-xs transition-all border hover:shadow-sm flex items-center justify-center gap-1.5 text-slate-500 hover:text-slate-700 border-slate-200 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                    View Details
                </button>
            </div>
        </div>
    );
}
