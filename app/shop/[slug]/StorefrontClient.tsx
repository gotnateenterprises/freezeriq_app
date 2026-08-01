'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ShoppingBag, Users, ArrowRight, ArrowLeft, MessageSquare, Tag, X } from 'lucide-react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import JsonLd from '@/components/JsonLd';
import { useCart } from '@/context/CartContext';
import CartDrawer from '@/components/shop/CartDrawer';
import StorefrontFooter from '@/components/shop/StorefrontFooter';
import StorefrontProductCard from '@/components/shop/StorefrontProductCard';
import SurplusWaitlist from '@/components/shop/SurplusWaitlist';
import PurchaseSidebar from '@/components/shop/PurchaseSidebar';
import PublicRecipeDetail from '@/components/shop/PublicRecipeDetail';
import FreezerIQLandingPage from '@/components/shop/FreezerIQLandingPage';
import { buildBrandVars } from '@/lib/storefront/brandTokens';
// SF-2 landing components — regular storefront only
import { WeekStrip } from '@/components/storefront/WeekStrip';
import { HowItWorksChips } from '@/components/storefront/HowItWorksChips';
import { GreetingCard } from '@/components/storefront/GreetingCard';
import { FounderNote } from '@/components/storefront/FounderNote';
import { QuoteBlock } from '@/components/storefront/QuoteBlock';
import { EmailCaptureCard } from '@/components/storefront/EmailCaptureCard';
import { StorefrontTopbar } from '@/components/storefront/StorefrontTopbar';
import { LandingHero } from '@/components/storefront/LandingHero';
// SF-3 shopping components — regular storefront only
import { BundleCard, isServes2Tier } from '@/components/storefront/BundleCard';
import { BundleDetail } from '@/components/storefront/BundleDetail';
import { CategoryChips } from '@/components/storefront/CategoryChips';
import { StickyCartBar } from '@/components/storefront/StickyCartBar';
import { FreeDeliveryBar } from '@/components/storefront/FreeDeliveryBar';

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
    // SF-3: additive real payload field (app/api/public/tenant/[slug]/route.ts).
    // Optional to tolerate any cached/older response shape, matching the
    // existing optional convention used for order_cutoff_date above.
    family_id?: string | null;
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
    /** SF-2: true only when the server proved the customer session belongs to THIS tenant. */
    hasCustomerSession?: boolean;
}

export default function StorefrontClient({ overrideSlug, hasCustomerSession = false }: StorefrontClientProps = {}) {
    const params = useParams();
    const slug = overrideSlug || params?.slug;
    // SF-3: cart READS for ✓ Added state and the mobile bag bar — the mutation
    // contract (addToCart / dedup / toasts / drawer auto-open) is untouched.
    const { items: cartItems, addToCart, cartTotal, cartCount, setIsCartOpen } = useCart();
    const [data, setData] = useState<TenantData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<{ message: string, slugs?: { name: string, slug: string }[] } | null>(null);
    const [activeBundleId, setActiveBundleId] = useState<string | null>(null);
    const [selectedPublicRecipe, setSelectedPublicRecipe] = useState<any | null>(null);
    const [showPurchaseModal, setShowPurchaseModal] = useState(false);
    const [purchaseModalBundle, setPurchaseModalBundle] = useState<any>(null);
    const [mealsPopupBundle, setMealsPopupBundle] = useState<any | null>(null);
    // SF-3: Fable bundle detail selection — { family: 1-2 REAL tiers, initialId }.
    const [detailSelection, setDetailSelection] = useState<{ family: any[]; initialId: string } | null>(null);
    // SF-2: cookieless returning detection from the sf_last_order marker.
    const [hasReturnMarker, setHasReturnMarker] = useState(false);

    // SF-2: validate the sf_last_order marker. It is a returning-visitor
    // MARKER only — never bundle/history data. Valid iff it parses, slug
    // matches THIS storefront, orderId is a non-empty string, and ts is a
    // finite number. Malformed or wrong-slug markers are ignored and removed.
    useEffect(() => {
        if (typeof window === 'undefined' || !slug) return;
        try {
            const raw = localStorage.getItem('sf_last_order');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const valid = parsed
                && typeof parsed === 'object'
                && parsed.slug === slug
                && typeof parsed.orderId === 'string'
                && parsed.orderId.length > 0
                && Number.isFinite(parsed.ts);
            if (valid) {
                setHasReturnMarker(true);
            } else {
                localStorage.removeItem('sf_last_order');
            }
        } catch {
            try { localStorage.removeItem('sf_last_order'); } catch { /* storage unavailable */ }
        }
    }, [slug]);

    // SF-2: a visitor is "returning" via a tenant-proven customer session OR a
    // valid cookieless marker for this slug.
    const isReturning = hasCustomerSession || hasReturnMarker;

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

            <div className="max-w-7xl mx-auto px-4 sm:px-6 -mt-24 relative z-20 space-y-24">
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
            <div className="min-h-screen bg-brand-cream/50 flex items-center justify-center p-4">
                <div className="max-w-xl w-full p-8 md:p-12 bg-white/80 backdrop-blur-3xl dark:bg-slate-800/80 rounded-[3.5rem] shadow-2xl border border-white shadow-brand-rose/5 text-center">
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

    const { business } = data;
    const { branding, storefrontConfig } = business;

    // ── Defensive array normalization ─────────────────────────────────────────
    // The API normalizes these at the source, but we add client-side guards too
    // so a stale deployment or unexpected API shape never crashes the storefront.
    const bundles: Bundle[] = Array.isArray(data.bundles) ? data.bundles : [];
    const fundraisers: Fundraiser[] = Array.isArray(data.fundraisers) ? data.fundraisers : [];
    if (storefrontConfig) {
        if (!Array.isArray(storefrontConfig.testimonials)) {
            storefrontConfig.testimonials = [];
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

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

    const handleViewMeals = (bundleId: string) => {
        const bundle = monthlyBundles.find(b => b.id === bundleId);
        if (bundle) {
            setMealsPopupBundle(bundle);
        }
    };

    // SF-2: single best REAL testimonial for QuoteBlock. The current
    // testimonial config carries no rating field, so "highest rating" cannot
    // apply — the first valid quote is used and no rating is fabricated.
    const bestTestimonial = (storefrontConfig?.testimonials || []).find(
        (t: any) => t && typeof t.quote === 'string' && t.quote.trim().length > 0
    ) || null;

    // ── SF-3: presentation-only bundle-family adapter ─────────────────────────
    // Grouping uses ONLY exact non-null family_id from the payload — never
    // names, prices, SKUs, or similarity. A COMPLETE family (exactly one
    // Serves-5 tier + exactly one Serves-2 tier) renders as ONE card whose
    // default is the canonical Serves-5 tier (CB family semantics), with both
    // real tiers handed to the detail view. Anything else — null family_id,
    // missing sibling, duplicate tiers — renders each real bundle as its own
    // normal card. No sibling is ever synthesized; no real bundle is hidden.
    // Original payload order is preserved (family card sits at the first
    // member's position).
    const familyGroups = new Map<string, any[]>();
    for (const b of regularBundles) {
        if (b.family_id) {
            const g = familyGroups.get(b.family_id) || [];
            g.push(b);
            familyGroups.set(b.family_id, g);
        }
    }
    const consumedIds = new Set<string>();
    const displayEntries: { key: string; primary: any; family: any[] }[] = [];
    for (const b of regularBundles) {
        if (consumedIds.has(b.id)) continue;
        const group = b.family_id ? familyGroups.get(b.family_id) : null;
        if (group && group.length >= 2) {
            const fives = group.filter(m => !isServes2Tier(m.serving_tier));
            const twos = group.filter(m => isServes2Tier(m.serving_tier));
            if (fives.length === 1 && twos.length === 1) {
                const five = fives[0], two = twos[0];
                consumedIds.add(five.id);
                consumedIds.add(two.id);
                displayEntries.push({ key: five.id, primary: five, family: [five, two] });
                continue;
            }
        }
        consumedIds.add(b.id);
        displayEntries.push({ key: b.id, primary: b, family: [b] });
    }

    // SF-3 badges — max one per card, truthful only:
    // 'CUSTOMER FAVORITE' is NEVER rendered (no real order tally exists in the
    // public payload; heuristics are off per the handoff).
    // 'PERFECT FIRST TRY' = the single lowest-priced multi-meal entry, shown to
    // first-time visitors only.
    let firstTryBadgeId: string | null = null;
    if (!isReturning && displayEntries.length > 0) {
        const eligible = displayEntries.filter(
            d => Array.isArray(d.primary.contents) && d.primary.contents.length >= 2 && Number(d.primary.price) > 0
        );
        if (eligible.length > 0) {
            firstTryBadgeId = eligible.reduce(
                (min, d) => Number(d.primary.price) < Number(min.primary.price) ? d : min,
                eligible[0]
            ).primary.id;
        }
    }

    // SF-3 pairing candidate — grounded only: the tenant-configured
    // upsell_bundle_id resolved against the CURRENT payload. The manual-upsell
    // sentinel is deliberately excluded (it carries no serving_tier, which the
    // cart contract requires) and no side/dessert fallback exists (bundles have
    // no category field) — so absent a configured real bundle, no pairing shows.
    const pairingCandidate = storefrontConfig?.upsell_bundle_id
        ? bundles.find(b => b.id === storefrontConfig.upsell_bundle_id) || null
        : null;

    // SF-3 direct add — EXACT existing cart contract; dedup/toasts/drawer
    // auto-open all come from the untouched CartContext.
    const addBundleToCart = (b: any) => addToCart({
        bundleId: b.id,
        name: b.name,
        price: Number(b.price),
        image_url: b.image_url || undefined,
        serving_tier: b.serving_tier,
    });
    const isInCart = (bundleId: string) => cartItems.some(i => i.bundleId === bundleId);

    if (slug === 'freezeriq') {
        return <FreezerIQLandingPage />;
    }

    // SF-1: one branding read (already fetched above) → CSS custom properties.
    // Every storefront descendant consumes var(--sf-*); never raw tenant hex.
    const brandVars = buildBrandVars(branding.primary_color, branding.accent_color);

    return (
        <div style={brandVars as React.CSSProperties} className="relative min-h-screen bg-[var(--sf-ground)] text-[var(--sf-ink)] dark:bg-slate-950 pb-32 noise-grain w-full max-w-[100vw] overflow-x-clip overflow-x-hidden">
            {/* Global Background Blobs for Glass Look - Warm Feminine Energy */}
            <div className="fixed inset-0 pointer-events-none z-0">
                <div className="absolute top-[5%] -right-[5%] w-[60%] h-[60%] bg-brand-rose/10 rounded-full blur-[160px] animate-pulse" />
                <div className="absolute bottom-[5%] -left-[5%] w-[60%] h-[60%] bg-amber-100/20 rounded-full blur-[160px] animate-pulse" style={{ animationDelay: '2s' }} />
            </div>

            {/* Correction: bottom clearance for the viewport-fixed mobile
                StickyCartBar, applied ONLY while the bag actually has items
                (cartCount >= 1) and only below the lg: breakpoint where the
                bar renders — so nothing is reserved when the bag is empty or
                on desktop. This keeps the bar from permanently covering the
                end of Extra Meals, the fundraiser CTA, or the footer without
                touching any of that content directly. */}
            <div className={`relative z-10 font-sans flex flex-col min-h-screen w-full max-w-[100vw] overflow-x-hidden ${cartCount >= 1 ? 'pb-20 lg:pb-0' : ''}`}>
                {/* SF-2: CountdownBanner and DealsPopup are DELETED FROM THE RENDER
                    per spec §9 ("persuasion by invitation, never pressure") — their
                    component files remain in the repository untouched. */}

                <CartDrawer
                    primaryColor={branding.primary_color}
                    businessId={business.id}
                    slug={business.slug}
                    storefrontConfig={storefrontConfig}
                />

                {/* SF-3: legacy MobileStickyCart render removed (file untouched) —
                    the prototype StickyCartBar at the end of the page replaces it. */}

                {/* SF-3: Fable bundle detail (image · serif title · meta chips ·
                    ServingToggle for complete real families · meal rows · direct
                    Add · at most one grounded pairing). Replaces the legacy
                    regular-bundle meals popup composition. */}
                {detailSelection && (
                    <BundleDetail
                        family={detailSelection.family}
                        initialId={detailSelection.initialId}
                        onClose={() => setDetailSelection(null)}
                        onAdd={addBundleToCart}
                        isAdded={isInCart}
                        pairing={pairingCandidate && !detailSelection.family.some(f => f.id === pairingCandidate.id) ? pairingCandidate : null}
                        onAddPairing={pairingCandidate ? () => addBundleToCart(pairingCandidate) : undefined}
                        pairingAdded={pairingCandidate ? isInCart(pairingCandidate.id) : false}
                    />
                )}

                <PublicRecipeDetail
                    isOpen={!!selectedPublicRecipe}
                    onClose={() => setSelectedPublicRecipe(null)}
                    recipe={selectedPublicRecipe}
                    primaryColor={branding.primary_color}
                />

                {/* Purchase Modal */}
                <AnimatePresence>
                    {showPurchaseModal && purchaseModalBundle && (
                        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                onClick={() => setShowPurchaseModal(false)}
                                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                            />
                            <motion.div
                                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                                className="relative w-full max-w-md z-10"
                            >
                                <button
                                    onClick={() => setShowPurchaseModal(false)}
                                    className="absolute -top-12 right-0 w-10 h-10 bg-white/20 hover:bg-white/40 rounded-full flex items-center justify-center text-white backdrop-blur-md transition-colors"
                                >
                                    <span className="sr-only">Close</span>
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                                </button>
                                <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-full h-2 z-10 bg-[var(--sf-primary)]" />
                                    <PurchaseSidebar
                                        bundle={purchaseModalBundle}
                                        primaryColor={branding.primary_color}
                                        onClose={() => setShowPurchaseModal(false)}
                                    />
                                </div>
                            </motion.div>
                        </div>
                    )}
                </AnimatePresence>

                {/* SF-3: the legacy regular-bundle meals popup composition no longer
                    renders — BundleDetail above owns the detail view. */}

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

                {/* ── SF-2A landing shell: faithful Fable port ─────────────────────
                    Prototype order — Topbar → WeekStrip → compact text hero — on
                    the warm token ground. The legacy full-screen photographic
                    StorefrontHero no longer renders here (its file is untouched
                    and still serves app/start-a-business). No landing photograph,
                    card, badge, trust row, or hero CTA — per the prototype. */}
                <StorefrontTopbar
                    businessName={(business.branding.business_name && business.branding.business_name !== 'FreezerIQ') ? business.branding.business_name : 'Freezer Chef'}
                    logoUrl={business.branding.logo_url}
                    slug={business.slug}
                />

                {/* SF-2: order-week strip — earliest real future cutoff, hidden when
                    none. SF-2A width ruling: editorial elements sit in a max-w-2xl
                    column. (This wrapper lives in a plain flex column — when WeekStrip
                    self-returns null it collapses to zero height with no gap.) */}
                <div className="max-w-2xl mx-auto w-full">
                    <WeekStrip bundles={regularBundles} />
                </div>

                {/* SF-2A: compact Fable hero. Tenant-configured headline/subheadline
                    always win (rendered as plain text); the prototype's first-visit
                    and returning default hooks apply only when no config exists. */}
                <div className="max-w-2xl mx-auto w-full">
                    <LandingHero
                        headline={storefrontConfig?.hero_headline}
                        subheadline={storefrontConfig?.hero_subheadline}
                        isReturning={isReturning}
                    />
                </div>

                {/* Main Content Flow — SF-2 re-orchestration. The legacy inline
                    "Our Story" section, StorefrontHowItWorks, and TestimonialWall no
                    longer render (files remain): FounderNote and QuoteBlock below the
                    bundles now own the story and testimonial regions, so nothing is
                    duplicated. */}
                {/* SF-2A rhythm: space-y-10 sm:space-y-14 (was 16/24) + mb-8 (was 16)
                    — the old spacing was tuned for the removed dense legacy sections
                    and left screen-height empty bands between the small editorial
                    cards. Width ruling: each editorial element is constrained to a
                    max-w-2xl column; wrappers share the exact render condition of
                    their child, so nothing leaves an empty band when content is
                    absent. */}
                {/* SF-2A: -mt-24 removed — it existed to overlap the old full-screen
                    photo hero and would pull content over the compact Fable hero.
                    Correction A: the trailing mb-8 was removed — it stacked with
                    the lower section's own py-16/py-20 top padding (mb-8 + py-16
                    with nothing between = ~7-8rem of empty space, worse when no
                    fundraisers render). The lower container's padding alone is
                    the intentional gap; EmailCaptureCard's own my-4 still adds a
                    small amount of natural breathing room above it. */}
                <div className="max-w-7xl mx-auto px-4 sm:px-6 relative z-20 space-y-10 sm:space-y-14">

                    {/* SF-2: first-visit-only how-it-works chips */}
                    {!isReturning && (
                        <div className="max-w-2xl mx-auto w-full">
                            <HowItWorksChips />
                        </div>
                    )}

                    {/* SF-2: returning-only TRUTHFUL generic greeting — no usual bundle,
                        no order count, no reorder, no points. CTA scrolls to the
                        existing bundle region. */}
                    {isReturning && (
                        <div className="max-w-2xl mx-auto w-full">
                            <GreetingCard onBrowseMenu={scrollToBundles} />
                        </div>
                    )}

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

                    {/* SF-3: inline Fable category chips replace the fixed legacy
                        StickyCategoryBar render (file untouched) — no overlap with
                        the SF-2A sticky topbar. Same destinations, same section ids. */}
                    <CategoryChips
                        hasFundraisers={fundraisers.length > 0}
                        hasBundles={regularBundles.length > 0}
                    />

                    {/* SF-3: Fable bundle-card shopping grid (replaces the legacy
                        WeeklyBundles render — file untouched). One card per real
                        complete family (Serves-5 default), separate cards otherwise.
                        Grid per ruling: 1 / 2 / 3 columns inside max-w-7xl.
                        SF-3E: when no regular bundles exist, a calm editorial
                        empty state renders in place of the grid — approved copy,
                        SF-1 tokens, no fabricated dates or promises. */}
                    <div className="pb-8 w-full overflow-hidden">
                        <div id="shop-bundles" className="scroll-mt-32 grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {displayEntries.length === 0 ? (
                                <div className="col-span-full flex flex-col items-center gap-2 rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] px-6 py-10 text-center">
                                    <span className="text-3xl" aria-hidden="true">🍲</span>
                                    <p className="text-[15px] font-semibold text-[var(--sf-ink)]">This week&rsquo;s menu is being prepared.</p>
                                    <p className="text-[13px] text-[var(--sf-muted)]">Check back soon for new menu options.</p>
                                </div>
                            ) : displayEntries.map(entry => (
                                <BundleCard
                                    key={entry.key}
                                    b={entry.primary}
                                    badge={entry.primary.id === firstTryBadgeId ? '👋 PERFECT FIRST TRY' : null}
                                    onOpen={() => setDetailSelection({ family: entry.family, initialId: entry.primary.id })}
                                    onAdd={() => addBundleToCart(entry.primary)}
                                    added={isInCart(entry.primary.id)}
                                />
                            ))}
                        </div>
                    </div>

                    {/* SF-2: grounded founder/story note (renders nothing without real
                        config story text) followed by the single best REAL testimonial.
                        SF-2A: each wrapper is gated on the SAME condition its child
                        uses to self-null, so no empty space-y band can appear when
                        the tenant has no story or testimonial content. */}
                    {Boolean((storefrontConfig?.our_story_content || '').trim()) && (
                        <div className="max-w-2xl mx-auto w-full">
                            <FounderNote
                                storyText={storefrontConfig?.our_story_content}
                                attribution={(branding.business_name && branding.business_name !== 'FreezerIQ' && branding.business_name !== 'Freezer IQ') ? branding.business_name : 'Freezer Chef'}
                                logoUrl={branding.logo_url}
                            />
                        </div>
                    )}
                    {bestTestimonial && (
                        <div className="max-w-2xl mx-auto w-full">
                            <QuoteBlock quote={bestTestimonial.quote} author={bestTestimonial.author} />
                        </div>
                    )}

                    {/* SF-2: first-visit-only soft menu-email capture */}
                    {!isReturning && (
                        <div className="max-w-2xl mx-auto w-full">
                            <EmailCaptureCard slug={String(slug || '')} />
                        </div>
                    )}
                </div>

                {/* SF-2A rhythm: py-24 space-y-32 → py-16 sm:py-20 space-y-16 sm:space-y-20
                    — the legacy padding produced multi-screen empty bands once the dense
                    sections above were replaced, especially with zero fundraisers. */}
                <div className="max-w-6xl mx-auto px-6 relative z-20 py-16 sm:py-20 space-y-16 sm:space-y-20">
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

                        <div className="bg-emerald-50/20 dark:bg-slate-900/30 p-2 sm:p-4 rounded-[2rem] sm:rounded-[4rem] border border-emerald-50/50 dark:border-slate-800 w-full overflow-hidden">
                            {surplusBundles.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 p-4 sm:p-6">
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
                                <div className="p-2 sm:p-8 w-full overflow-hidden">
                                    <SurplusWaitlist
                                        businessName={branding.business_name}
                                        primaryColor={branding.primary_color}
                                        slug={business.slug}
                                        businessId={business.id}
                                    />
                                </div>
                            )}
                        </div>

                        {/* Host Fundraiser CTA Moved Here! */}
                        <div className="p-8 lg:p-12 bg-linear-to-br from-pink-500 to-rose-500 rounded-[3.5rem] text-white space-y-6 shadow-2xl shadow-pink-500/20 w-full overflow-hidden relative group">
                            <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-10 rounded-full blur-3xl z-0 group-hover:scale-110 transition-transform duration-700" />
                            <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-8">
                                <div className="space-y-4 max-w-xl">
                                    <h4 className="text-3xl md:text-4xl font-black leading-tight">Raise Funds With Us</h4>
                                    <p className="text-pink-50 text-lg font-medium leading-relaxed">
                                        Partner with us to raise money for your organization with delicious freezer meals.
                                    </p>
                                </div>
                                <Link
                                    href={`/shop/${slug}/raise-funds`}
                                    className="shrink-0 inline-flex items-center justify-center gap-2 bg-white text-pink-600 px-8 py-4 rounded-full font-black text-sm uppercase tracking-widest transition-transform hover:scale-105 shadow-xl"
                                >
                                    Start Fundraising
                                    <ArrowRight size={16} className="shrink-0" strokeWidth={3} />
                                </Link>
                            </div>
                        </div>
                    </section>
                </div>

                {/* Footer */}
                <StorefrontFooter
                    businessName={(branding.business_name && branding.business_name !== 'FreezerIQ' && branding.business_name !== 'Freezer IQ') ? branding.business_name : 'Freezer Chef'}
                    slug={business.slug}
                    primaryColor={branding.primary_color}
                    footerText={storefrontConfig?.footer_text}
                />

                {/* SF-3: mobile bag bars. FreeDeliveryBar is passed threshold={null}
                    because NO free-delivery threshold exists in tenant delivery
                    settings — per the handoff truthfulness rule it therefore renders
                    nothing (no invented amount, no false promise). StickyCartBar is
                    mobile-only, shows the REAL bag count/total, and opens the
                    existing CartDrawer. */}
                <FreeDeliveryBar subtotal={cartTotal} threshold={null} />
                <StickyCartBar count={cartCount} total={cartTotal} onCta={() => setIsCartOpen(true)} />
            </div>
        </div>
    );
}
