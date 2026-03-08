'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ShoppingBag, Users, ArrowRight, ArrowLeft, MessageSquare, Tag } from 'lucide-react';
import Link from 'next/link';
import JsonLd from '@/components/JsonLd';

import DealsPopup from '@/components/shop/DealsPopup';
import { useCart } from '@/context/CartContext';
import CartDrawer from '@/components/shop/CartDrawer';
import StorefrontHero from '@/components/shop/StorefrontHero';
import StorefrontHowItWorks from '@/components/shop/StorefrontHowItWorks';
import StickyCategoryBar from '@/components/shop/StickyCategoryBar';
import StorefrontFooter from '@/components/shop/StorefrontFooter';
import StorefrontProductCard from '@/components/shop/StorefrontProductCard';
import WeeklyBundles from '@/components/shop/WeeklyBundles';
import SurplusWaitlist from '@/components/shop/SurplusWaitlist';
import DeliciousGrid from '@/components/shop/DeliciousGrid';
import PurchaseSidebar from '@/components/shop/PurchaseSidebar';
import PublicRecipeDetail from '@/components/shop/PublicRecipeDetail';
import FreezerIQLandingPage from '@/components/shop/FreezerIQLandingPage';
import CountdownBanner from '@/components/shop/CountdownBanner';
import TestimonialWall from '@/components/shop/TestimonialWall';
import MobileStickyCart from '@/components/shop/MobileStickyCart';

interface Bundle {
    id: string;
    name: string;
    description: string;
    price: number;
    image_url: string;
    stock_on_hand: number;
    serving_tier: string;
    sku: string;
    is_surplus?: boolean;
    order_cutoff_date?: string | null;
    contents?: {
        recipe: {
            name: string;
            description: string;
            container_type?: string | null;
        };
        quantity: number;
    }[];
}

interface Fundraiser {
    id: string;
    name: string;
    about_text: string | null;
    mission_text: string | null;
    payment_instructions: string | null;
    external_payment_link: string | null;
    end_date: string;
    goal_amount: number | null;
    total_sales: number;
    customer: {
        name: string;
    };
    participant_label: string | null;
}

interface TenantData {
    business: {
        id: string;
        name: string;
        slug: string;
        branding: {
            business_name: string;
            logo_url: string | null;
            primary_color: string;
            secondary_color: string;
            accent_color: string;
            tagline: string | null;
        };
        storefrontConfig?: {
            hero_headline: string;
            hero_subheadline: string;
            hero_image_url?: string;
            our_story_headline?: string;
            our_story_content?: string;
            how_it_works_content?: string;
            footer_text?: string;
            marketing_video_url?: string;
            upsell_bundle_id: string;
            upsell_title: string;
            upsell_description: string;
            upsell_discount_percent: number;
            testimonials?: { quote: string; author: string }[] | null;
        };
    };
    bundles: Bundle[];
    fundraisers: Fundraiser[];
}

interface StorefrontClientProps {
    overrideSlug?: string;
}

export default function StorefrontClient({ overrideSlug }: StorefrontClientProps = {}) {
    const params = useParams();
    const slug = overrideSlug || params?.slug;
    const { addToCart } = useCart();
    const [data, setData] = useState<TenantData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<{ message: string, slugs?: { name: string, slug: string }[] } | null>(null);
    const [activeBundleId, setActiveBundleId] = useState<string | null>(null);
    const [selectedPublicRecipe, setSelectedPublicRecipe] = useState<any | null>(null);

    useEffect(() => {
        async function fetchStorefront() {
            try {
                const res = await fetch(`/api/public/tenant/${slug}`);
                const contentType = res.headers.get('content-type');

                if (!res.ok) {
                    let errorMessage = 'Failed to load storefront';
                    let slugs = [];

                    if (contentType && contentType.includes('application/json')) {
                        const json = await res.json();
                        errorMessage = json.details || json.error || errorMessage;
                        slugs = json.available_slugs || [];
                    } else {
                        errorMessage = `Server Error: ${res.status} ${res.statusText}. The server returned an unexpected format (HTML).`;
                    }

                    setError({ message: errorMessage, slugs });
                    setLoading(false);
                    return;
                }

                if (!contentType || !contentType.includes('application/json')) {
                    throw new Error('Server returned invalid data format (expected JSON, got HTML). This usually indicates a 500 error page.');
                }

                const json = await res.json();
                setData(json);

                // Set initial active bundle (first regular bundle)
                const regular = json.bundles?.filter((b: any) => !b.is_surplus);
                if (regular && regular.length > 0) {
                    setActiveBundleId(regular[0].id);
                }
            } catch (err: any) {
                setError({ message: err.message });
            } finally {
                setLoading(false);
            }
        }
        if (slug) fetchStorefront();
    }, [slug]);

    if (loading) return (
        <div className="min-h-screen bg-brand-cream dark:bg-slate-950 pb-32 overflow-hidden">
            {/* Skeleton Navbar */}
            <div className="h-20 bg-white/40 dark:bg-slate-900/40 border-b border-slate-100 dark:border-slate-800" />

            {/* Skeleton Hero */}
            <div className="h-[500px] w-full bg-slate-200/50 dark:bg-slate-800/50 animate-pulse" />

            <div className="max-w-7xl mx-auto px-6 -mt-24 relative z-20 space-y-24">
                {/* Skeleton Story Block */}
                <div className="bg-white/40 dark:bg-slate-900/60 rounded-[4rem] p-12 h-64 border border-white dark:border-slate-800 animate-pulse" />

                {/* Skeleton Grid (Bundles) */}
                <div className="flex flex-col lg:flex-row gap-16">
                    <div className="flex-1 space-y-12">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-12">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="bg-white dark:bg-slate-900 rounded-[3.5rem] overflow-hidden shadow-sm border border-slate-100 dark:border-slate-800 h-[600px] flex flex-col animate-pulse">
                                    <div className="h-80 w-full bg-slate-200 dark:bg-slate-800" />
                                    <div className="p-10 space-y-4">
                                        <div className="h-8 w-3/4 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                                        <div className="h-4 w-full bg-slate-100 dark:bg-slate-800 rounded-lg mt-4" />
                                        <div className="h-4 w-2/3 bg-slate-100 dark:bg-slate-800 rounded-lg" />

                                        <div className="mt-auto pt-16 flex justify-between items-end">
                                            <div className="h-10 w-24 bg-slate-200 dark:bg-slate-800 rounded-lg" />
                                            <div className="h-14 w-32 bg-slate-200 dark:bg-slate-800 rounded-2xl" />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );

    if (error || !data) {
        return (
            <div className="min-h-screen bg-brand-cream/50 flex items-center justify-center p-6">
                <div className="max-w-xl w-full p-12 bg-white/80 backdrop-blur-3xl dark:bg-slate-800/80 rounded-[3.5rem] shadow-2xl border border-white shadow-brand-rose/5 text-center">
                    <h1 className="text-4xl font-serif text-slate-900 dark:text-white mb-6">Shop Not Found</h1>
                    <p className="text-slate-500 dark:text-slate-400 mb-10 font-medium">
                        We couldn't find a storefront at <strong>/shop/{slug}</strong>.
                    </p>

                    <div className="bg-brand-cream/20 dark:bg-slate-950 p-8 rounded-[2.5rem] mb-10 text-left border border-white/40">
                        <p className="text-[10px] font-black text-brand-rose mb-6 uppercase tracking-[0.25em]">Available Shops:</p>
                        <div className="space-y-3">
                            {(error as any)?.available_shops ? (
                                (error as any).available_shops.map((s: any) => (
                                    <Link
                                        key={s.slug}
                                        href={`/shop/${s.slug}`}
                                        className="block p-5 bg-white/60 dark:bg-slate-800 rounded-2xl border border-white hover:border-brand-rose hover:scale-[1.02] transition-all font-black text-slate-700 dark:text-slate-200 uppercase tracking-widest text-xs"
                                    >
                                        {s.name}
                                    </Link>
                                ))
                            ) : error?.slugs?.map((s) => (
                                <Link
                                    key={s.slug}
                                    href={`/shop/${s.slug}`}
                                    className="block p-5 bg-white/60 dark:bg-slate-800 rounded-2xl border border-white hover:border-brand-rose hover:scale-[1.02] transition-all font-black text-slate-700 dark:text-slate-200 uppercase tracking-widest text-xs"
                                >
                                    {s.name}
                                </Link>
                            ))}
                        </div>
                    </div>

                    <Link href="/" className="bg-slate-900 text-white px-10 py-4 rounded-full font-black text-[10px] uppercase tracking-[0.2em] inline-block hover:scale-105 transition-all">Return to Home</Link>
                </div>
            </div>
        );
    }

    const { business, bundles, fundraisers } = data;
    const { branding, storefrontConfig } = business;

    // Filter bundles
    const regularBundles = bundles.filter(b => !b.is_surplus);
    const surplusBundles = bundles.filter(b => b.is_surplus);

    // Current featured bundle based on activeBundleId
    const featuredBundle = regularBundles.find(b => b.id === activeBundleId) || regularBundles[0];

    // Find the global order cutoff date across all regular bundles
    const globalCutoffDate = regularBundles.reduce((latest: string | null, bundle) => {
        if (!bundle.order_cutoff_date) return latest;
        if (!latest) return bundle.order_cutoff_date;
        return new Date(bundle.order_cutoff_date) > new Date(latest) ? bundle.order_cutoff_date : latest;
    }, null);

    // Grid shows all regular bundles (including Regular & Family sizes)
    const monthlyBundles = regularBundles;

    const scrollToBundles = () => {
        const el = document.getElementById('shop-bundles');
        if (el) el.scrollIntoView({ behavior: 'smooth' });
    };

    const handleSelectBundle = (bundleId: string) => {
        setActiveBundleId(bundleId);
        // Smooth scroll to the meals grid
        const mealsGrid = document.getElementById('meals-grid');
        if (mealsGrid) {
            mealsGrid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    };

    if (slug === 'freezeriq') {
        return <FreezerIQLandingPage />;
    }

    return (
        <div className="relative min-h-screen bg-brand-cream dark:bg-slate-950 pb-32 noise-grain">
            {/* Global Background Blobs for Glass Look - Warm Feminine Energy */}
            <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
                <div className="absolute top-[5%] -right-[5%] w-[60%] h-[60%] bg-brand-rose/10 rounded-full blur-[160px] animate-pulse" />
                <div className="absolute bottom-[5%] -left-[5%] w-[60%] h-[60%] bg-amber-100/20 rounded-full blur-[160px] animate-pulse" style={{ animationDelay: '2s' }} />
            </div>

            <div className="relative z-10 font-sans flex flex-col min-h-screen">
                <CountdownBanner
                    targetDate={globalCutoffDate}
                    primaryColor={branding.primary_color}
                />

                <DealsPopup
                    businessName={(business.branding.business_name && business.branding.business_name !== 'FreezerIQ') ? business.branding.business_name : 'Freezer Chef'}
                    primaryColor={branding.primary_color}
                    onCapture={(email, name) => console.log('Lead captured:', { email, name })}
                />
                {/* ... (CartDrawer, PublicRecipeDetail, JsonLd remain same) */}
                <CartDrawer
                    primaryColor={branding.primary_color}
                    businessId={business.id}
                    slug={business.slug}
                />

                <MobileStickyCart
                    bundle={featuredBundle}
                    primaryColor={branding.primary_color}
                />

                <PublicRecipeDetail
                    isOpen={!!selectedPublicRecipe}
                    onClose={() => setSelectedPublicRecipe(null)}
                    recipe={selectedPublicRecipe}
                    primaryColor={branding.primary_color}
                />

                <JsonLd data={{
                    "@context": "https://schema.org",
                    "@type": "LocalBusiness",
                    "name": (business.branding.business_name && business.branding.business_name !== 'FreezerIQ') ? business.branding.business_name : 'Freezer Chef',
                    "image": business.branding.logo_url,
                    "description": business.branding.tagline || "Fresh freezer meals.",
                    "url": `https://freezeriq.com/shop/${business.slug}`,
                    "priceRange": "$$",
                    "offers": bundles.map(b => ({
                        "@type": "Offer",
                        "name": b.name,
                        "price": b.price,
                        "priceCurrency": "USD",
                        "availability": b.stock_on_hand > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
                    }))
                }} />

                {/* Immersive Header */}
                <StorefrontHero
                    headline={storefrontConfig?.hero_headline || "Delicious Freezer Meals Made for Your Busy Life"}
                    subheadline={storefrontConfig?.hero_subheadline || "Home-cooked flavor. Zero dinner stress. Stock your freezer. Gather around the table."}
                    businessName={(business.branding.business_name && business.branding.business_name !== 'FreezerIQ') ? business.branding.business_name : 'Freezer Chef'}
                    primaryColor={business.branding.primary_color}
                    heroImage={storefrontConfig?.hero_image_url || "/images/nostalgic-hero.jpg"}
                    logoUrl={business.branding.logo_url}
                />

                {/* Main Content Flow */}
                <div className="max-w-7xl mx-auto px-6 -mt-24 relative z-20 space-y-24">

                    {/* Our Story / Mission */}
                    <section className="bg-white/40 dark:bg-slate-900/60 backdrop-blur-3xl p-12 md:p-20 rounded-[4rem] border border-white dark:border-white/5 shadow-[0_48px_96px_-24px_rgba(244,114,182,0.1)] relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-amber-50 rounded-full blur-3xl opacity-50 -z-10" />

                        <div className="flex items-center gap-3 mb-8 font-black uppercase tracking-[0.25em] text-[10px] text-brand-teal">
                            <div className="w-8 h-px bg-brand-teal/30" />
                            Our Heritage
                        </div>

                        <h2 className="font-serif text-4xl md:text-5xl text-slate-900 dark:text-white mb-10 leading-tight">
                            {storefrontConfig?.our_story_headline || (
                                <>The Heart of <span className="text-brand-teal">{business.branding.business_name}</span></>
                            )}
                        </h2>

                        <div className="prose prose-xl dark:prose-invert max-w-none text-slate-600 dark:text-slate-300 font-medium leading-[1.8] opacity-90">
                            {storefrontConfig?.our_story_content ? (
                                <p className="whitespace-pre-wrap">{storefrontConfig.our_story_content}</p>
                            ) : (
                                <div className="space-y-8">
                                    <p>At <strong>{(!business.branding.business_name || business.branding.business_name === 'FreezerIQ') ? 'Freezer Chef' : business.branding.business_name}</strong>, we bring over 10 years of experience in freezer meal preparation to your table—taking the stress out of dinnertime and replacing it with comforting, crave-worthy flavors your whole family will love.</p>
                                    <p>Our freezer-ready meals are handcrafted with care and packed with nostalgia—from hearty casseroles and slow-simmered soups to warm, oven-baked favorites and cozy crockpot classics that taste just like Grandma used to make.</p>
                                </div>
                            )}
                        </div>
                    </section>

                    {/* The Process (Now below Story) */}
                    <StorefrontHowItWorks content={storefrontConfig?.how_it_works_content} />

                    {/* Customer Feedback Wall */}
                    <TestimonialWall testimonials={storefrontConfig?.testimonials as any} />

                    {/* Marketing Video Section */}
                    {storefrontConfig?.marketing_video_url && (
                        <section className="relative aspect-video max-w-5xl mx-auto rounded-[3rem] overflow-hidden shadow-2xl shadow-indigo-500/10 border border-white/50 dark:border-white/5 group">
                            <iframe
                                src={storefrontConfig.marketing_video_url.includes('youtube.com') || storefrontConfig.marketing_video_url.includes('youtu.be')
                                    ? storefrontConfig.marketing_video_url.replace('watch?v=', 'embed/').replace('youtu.be/', 'youtube.com/embed/')
                                    : storefrontConfig.marketing_video_url
                                }
                                className="w-full h-full"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                            />
                        </section>
                    )}

                    {/* Lower Section: Bundles & Stationary Purchase Box */}
                    <div className="flex flex-col lg:flex-row gap-16 pb-20">
                        {/* Left Column: Monthly Bundles */}
                        <div className="flex-1 space-y-16">

                            {/* Monthly Bundles Container */}
                            <div id="shop-bundles" className="scroll-mt-32">
                                <WeeklyBundles
                                    bundles={monthlyBundles}
                                    primaryColor={branding.primary_color}
                                    onAddToCart={addToCart}
                                    onSelect={handleSelectBundle}
                                    activeBundleId={activeBundleId || ''}
                                />
                            </div>

                            {/* Featured Recipes Grid (Reflects active bundle) */}
                            <div className="space-y-6 scroll-mt-24" id="meals-grid">
                                <div className="flex items-center gap-2 mb-4">
                                    <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-indigo-600">
                                        <ShoppingBag size={20} />
                                    </div>
                                    <h2 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight uppercase tracking-[0.1em]">
                                        Menu: {featuredBundle?.name}
                                    </h2>
                                </div>
                                <DeliciousGrid
                                    recipes={featuredBundle?.contents?.map((c: any) => c.recipe).filter(Boolean) || []}
                                    onItemClick={(recipe) => setSelectedPublicRecipe(recipe)}
                                />
                            </div>
                        </div>

                        {/* Right Column: Stationary Purchase Box */}
                        <div className="lg:w-[400px]" id="purchase-section">
                            {featuredBundle ? (
                                <div className="space-y-8">
                                    <div className="bg-indigo-600 text-white px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest text-center shadow-lg">
                                        Subscribe & Save
                                    </div>
                                    <PurchaseSidebar
                                        key={featuredBundle.id} // Force re-render on selection change
                                        // @ts-ignore
                                        bundle={featuredBundle}
                                        primaryColor={branding.primary_color}
                                    />

                                    {/* Host Fundraiser CTA */}
                                    <div className="mt-8 p-10 bg-linear-to-br from-pink-500 to-rose-500 rounded-[2.5rem] text-white space-y-6 shadow-2xl shadow-pink-500/20">
                                        <h4 className="text-xl font-black leading-tight">Raise Funds With Us</h4>
                                        <p className="text-pink-100 text-sm font-medium leading-relaxed">
                                            Partner with us to raise money for your organization with delicious freezer meals.
                                        </p>
                                        <Link
                                            href={`/shop/${slug}/raise-funds`}
                                            className="inline-flex items-center gap-2 bg-white text-pink-600 px-6 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-transform hover:scale-105"
                                        >
                                            Start Fundraising
                                            <ArrowRight size={14} strokeWidth={3} />
                                        </Link>
                                    </div>
                                </div>
                            ) : (
                                <div className="p-8 bg-slate-50 dark:bg-slate-900 rounded-[2.5rem] text-center border border-slate-100 dark:border-slate-800">
                                    <p className="text-slate-500 font-medium">No bundles available right now.</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Sticky Navigation */}
                <StickyCategoryBar
                    primaryColor={branding.primary_color}
                    hasFundraisers={fundraisers.length > 0}
                    hasBundles={regularBundles.length > 0}
                />

                <div className="max-w-6xl mx-auto px-6 relative z-20 py-24 space-y-32">
                    {/* Fundraisers Section - Refined Cards */}
                    {fundraisers.length > 0 && (
                        <section id="fundraisers" className="space-y-12">
                            <div className="text-center space-y-4">
                                <span className="text-pink-600 dark:text-pink-400 font-black tracking-[0.2em] uppercase text-[10px] block">Giving Back</span>
                                <h2 className="text-4xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight">Active Fundraisers</h2>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                                {fundraisers.map(campaign => (
                                    <Link
                                        key={campaign.id}
                                        href={`/shop/${slug}/fundraiser/${campaign.id}`}
                                        className="group bg-white dark:bg-slate-900 p-8 rounded-[3rem] shadow-[0_24px_48px_-12px_rgba(79,70,229,0.08)] border border-indigo-50/50 dark:border-slate-800 hover:scale-[1.03] hover:shadow-[0_32px_64px_-16px_rgba(79,70,229,0.15)] transition-all duration-500"
                                    >
                                        <div className="flex justify-between items-start mb-6">
                                            <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-indigo-600 transition-transform group-hover:scale-110 group-hover:-rotate-3">
                                                <Tag size={24} />
                                            </div>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] bg-slate-50 dark:bg-slate-900/50 px-4 py-1.5 rounded-full border border-slate-100 dark:border-slate-800">
                                                Fundraising
                                            </span>
                                        </div>
                                        <h3 className="text-2xl font-black mb-3 group-hover:text-indigo-600 transition-colors tracking-tight">
                                            {campaign.name}
                                        </h3>
                                        <p className="text-sm text-slate-500 dark:text-slate-400 font-medium line-clamp-2 mb-6 leading-relaxed">
                                            {campaign.about_text || `Supporting ${campaign.customer.name}`}
                                        </p>
                                        <div className="flex items-center gap-2 text-indigo-600 font-black text-[10px] uppercase tracking-widest">
                                            Support This Cause <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform" />
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* Direct Sales / Extra Meals Section (Surplus) */}
                    <section id="extras" className="space-y-12">
                        <div className="flex flex-col items-center text-center space-y-4">
                            <span className="text-emerald-600 dark:text-emerald-400 font-black tracking-[0.2em] uppercase text-[10px] block">Available Now</span>
                            <h2 className="text-4xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight">Extra Meals</h2>
                            <p className="text-slate-500 dark:text-slate-400 font-medium max-w-xl">Limited surplus inventory available for immediate pickup or delivery.</p>
                        </div>

                        <div className="bg-emerald-50/20 dark:bg-slate-900/30 p-4 rounded-[4rem] border border-emerald-50/50 dark:border-slate-800">
                            {surplusBundles.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-6">
                                    {surplusBundles.map(bundle => (
                                        <StorefrontProductCard
                                            key={bundle.id}
                                            bundle={bundle}
                                            primaryColor={branding.primary_color}
                                            onAddToCart={(item) => addToCart({
                                                bundleId: item.bundleId,
                                                name: item.name,
                                                price: item.price,
                                                image_url: item.image_url,
                                                serving_tier: item.serving_tier,
                                                quantity: item.quantity
                                            })}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <div className="p-8">
                                    <SurplusWaitlist
                                        businessName={branding.business_name}
                                        primaryColor={branding.primary_color}
                                        slug={business.slug}
                                        businessId={business.id}
                                    />
                                </div>
                            )}
                        </div>
                    </section>
                </div>

                {/* Footer */}
                <StorefrontFooter
                    businessName={branding.business_name}
                    slug={business.slug}
                    primaryColor={branding.primary_color}
                    footerText={storefrontConfig?.footer_text}
                />
            </div>
        </div>
    );
}
