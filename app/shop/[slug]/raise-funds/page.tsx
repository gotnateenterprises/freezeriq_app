"use client";

import { useState, useRef, useEffect, useMemo, FormEvent } from 'react';
import { useParams } from 'next/navigation';
import {
    CheckCircle, ArrowRight, Loader2, Smartphone, Share2, UtensilsCrossed,
    ClipboardList, MessageCircle, Mail, QrCode, Users, Quote,
} from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { resolveVariantSize } from '@/lib/serving_multipliers';

/**
 * RAISE-FUNDS-MARKETING-1 — the public "[Tenant] Fundraisers" page.
 *
 * This page SELLS the fundraiser: easy to share, useful meals, online
 * supporter ordering, a Coordinator Panel, visible progress, less paperwork.
 * It leads with benefits and ends in the short inquiry form. Operational
 * program details (minimums, order deadlines, delivery-day rules, bundle
 * selection rules, pricing terms) deliberately do NOT live here — they belong
 * in the follow-up the tenant sends after an inquiry, where they can be
 * current and specific to that conversation.
 *
 * MULTI-TENANT: nothing tenant-specific is written into this file. The name,
 * logo, brand color, hero image, meal bundles (names, photos, prices) and any
 * testimonials all come from the tenant's own public payload
 * (/api/public/tenant/<slug>, the same relative-path source StorefrontClient
 * uses). A tenant with no hero image gets a collage of its own bundle photos;
 * a tenant with no testimonials gets no testimonial section. No stock
 * photography, no invented quotes, no fixed fundraising percentage.
 *
 * The inquiry form below is unchanged in behaviour from FR-FUNNEL-1 /
 * FR-ACCEPTANCE-1: same endpoint, same idempotency key, same website input.
 */

type PublicBundle = {
    id: string;
    name: string;
    price: number | string | null;
    image_url?: string | null;
    serving_tier?: string | null;
    family_id?: string | null;
};

type PublicTenantPayload = {
    business: {
        name: string;
        branding?: {
            business_name?: string | null;
            logo_url?: string | null;
            primary_color?: string | null;
        } | null;
        storefrontConfig?: {
            hero_image_url?: string | null;
            testimonials?: unknown;
        } | null;
    };
    bundles?: PublicBundle[];
};

type BundleTile = {
    key: string;
    name: string;
    imageUrl: string | null;
    serves5Price: number | null;
    serves2Price: number | null;
};

type Testimonial = { quote: string; author: string };

const FALLBACK_PRIMARY = '#4f46e5';

function toPrice(value: number | string | null | undefined): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function formatPrice(n: number): string {
    return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * One tile per bundle family, pairing the Serves-5 and Serves-2 siblings the
 * way the storefront does (exact non-null family_id only). Bundles with no
 * family stand alone. The family is named after its Serves-5 member.
 */
function buildBundleTiles(bundles: PublicBundle[]): BundleTile[] {
    const families = new Map<string, PublicBundle[]>();
    const singles: PublicBundle[] = [];
    for (const b of bundles) {
        if (b.family_id) {
            const g = families.get(b.family_id) ?? [];
            g.push(b);
            families.set(b.family_id, g);
        } else {
            singles.push(b);
        }
    }

    const tiles: BundleTile[] = [];
    for (const [familyId, members] of families) {
        const serves5 = members.find((m) => resolveVariantSize(m.serving_tier) === 'serves_5') ?? members[0];
        const serves2 = members.find((m) => resolveVariantSize(m.serving_tier) === 'serves_2') ?? null;
        tiles.push({
            key: familyId,
            name: serves5.name.replace(/\s*\((serves|feeds)[^)]*\)\s*$/i, ''),
            imageUrl: serves5.image_url ?? serves2?.image_url ?? null,
            serves5Price: toPrice(serves5.price),
            serves2Price: serves2 ? toPrice(serves2.price) : null,
        });
    }
    for (const b of singles) {
        const isServes2 = resolveVariantSize(b.serving_tier) === 'serves_2';
        tiles.push({
            key: b.id,
            name: b.name,
            imageUrl: b.image_url ?? null,
            serves5Price: isServes2 ? null : toPrice(b.price),
            serves2Price: isServes2 ? toPrice(b.price) : null,
        });
    }
    return tiles.slice(0, 4);
}

function readTestimonials(value: unknown): Testimonial[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((t): t is Testimonial =>
            Boolean(t) && typeof t === 'object'
            && typeof (t as Testimonial).quote === 'string' && (t as Testimonial).quote.trim().length > 0
            && typeof (t as Testimonial).author === 'string' && (t as Testimonial).author.trim().length > 0)
        .slice(0, 2);
}

export default function RaiseFundsPage() {
    const params = useParams();
    const slug = typeof params?.slug === 'string' ? params.slug : Array.isArray(params?.slug) ? params.slug[0] : '';

    const [tenant, setTenant] = useState<PublicTenantPayload | null>(null);
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [formData, setFormData] = useState({
        name: '',
        email: '',
        phone: '',
        orgName: '',
        website: '',
        deliveryLocation: '',
        cause: '',
        notes: ''
    });

    /**
     * FR-FUNNEL-1 — idempotency identity for ONE submission attempt.
     *
     * Minted once and held until the attempt succeeds, so a double-click or a
     * network retry carries the SAME key and the server returns the original
     * inquiry instead of recording a second one. Cleared on success, so a
     * deliberate future inquiry is correctly a new attempt with a new key.
     *
     * A random UUID, never a timestamp: two clicks in the same millisecond must
     * not collide, and two different submissions must never share an identity.
     * Same pattern as the public order form (FR-LAUNCH-1E).
     */
    const submissionKeyRef = useRef<string | null>(null);

    // Tenant branding, bundles and testimonials — the RELATIVE path, resolved
    // by the browser against whichever origin served this page, so Preview
    // reads Preview data and Production reads Production data.
    useEffect(() => {
        if (!slug) return;
        let cancelled = false;
        fetch(`/api/public/tenant/${slug}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => { if (!cancelled && data?.business) setTenant(data as PublicTenantPayload); })
            .catch(() => { /* the page still reads correctly with generic copy */ });
        return () => { cancelled = true; };
    }, [slug]);

    const tenantName = tenant?.business?.branding?.business_name?.trim() || tenant?.business?.name?.trim() || '';
    const primaryColor = tenant?.business?.branding?.primary_color || FALLBACK_PRIMARY;
    const heroImageUrl = tenant?.business?.storefrontConfig?.hero_image_url || null;
    const bundleTiles = useMemo(() => buildBundleTiles(tenant?.bundles ?? []), [tenant]);
    const collage = useMemo(
        () => bundleTiles.map((t) => t.imageUrl).filter((u): u is string => Boolean(u)).slice(0, 4),
        [bundleTiles],
    );
    const testimonials = useMemo(() => readTestimonials(tenant?.business?.storefrontConfig?.testimonials), [tenant]);

    const scrollToForm = () => {
        document.getElementById('contact-form')?.scrollIntoView({ behavior: 'smooth' });
    };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        if (loading) return; // cheap guard; the server key is the real protection
        setLoading(true);
        try {
            if (!submissionKeyRef.current) {
                submissionKeyRef.current = crypto.randomUUID();
            }

            const res = await fetch('/api/public/fundraiser-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...formData,
                    slug,
                    submissionKey: submissionKeyRef.current,
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to submit request');

            // Retire the key only once the attempt has genuinely landed.
            submissionKeyRef.current = null;
            setSubmitted(true);
            toast.success('Request submitted! We\'ll be in touch soon.');
        } catch (err: any) {
            toast.error(err.message);
        } finally {
            setLoading(false);
        }
    };

    const inputCls = 'w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all';
    const primaryButtonCls = 'inline-flex items-center justify-center gap-2 px-8 py-4 rounded-xl font-black text-lg text-white transition-transform hover:scale-[1.02] active:scale-95 shadow-lg';

    return (
        <div className="min-h-screen bg-white dark:bg-slate-900 text-slate-900 dark:text-white">

            {/* ── Hero ─────────────────────────────────────────────────────── */}
            <section className="max-w-6xl mx-auto px-6 pt-14 pb-10 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-10 items-center">
                <div className="space-y-5">
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                        {tenantName ? `${tenantName} Fundraisers` : 'Fundraisers'}
                    </p>
                    <h1 className="text-4xl md:text-5xl font-black tracking-tight leading-[1.1]">
                        The fundraiser families actually look forward to.
                    </h1>
                    <p className="text-lg md:text-xl leading-relaxed text-slate-700 dark:text-slate-200">
                        Everybody has to eat. Give your supporters a night off from cooking, and give your
                        organization an easier way to raise money.
                    </p>
                    <p className="text-base leading-relaxed text-slate-500 dark:text-slate-400">
                        Raise more. Stress less. Share a personalized fundraiser page, take orders online, and keep
                        everything organized from launch to pickup day.
                    </p>
                    <div className="flex flex-col sm:flex-row gap-3 pt-1">
                        <button type="button" onClick={scrollToForm} className={primaryButtonCls} style={{ backgroundColor: primaryColor }}>
                            Start a fundraiser <ArrowRight size={20} />
                        </button>
                        <Link href={`/shop/${slug}`} className="inline-flex items-center justify-center px-8 py-4 rounded-xl font-bold border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                            See the ordering page
                        </Link>
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                        Schools, churches, teams, clubs, Farm Bureaus, nonprofits, and community organizations.
                    </p>
                </div>

                {/* Hero visual: the tenant's own hero image → collage of its own
                    bundle photos → a brand-colored panel. Never stock imagery. */}
                <div className="rounded-3xl overflow-hidden min-h-[280px] lg:min-h-[380px] flex items-center justify-center" style={{ backgroundColor: heroImageUrl || collage.length ? undefined : primaryColor }}>
                    {heroImageUrl ? (
                        <img src={heroImageUrl} alt={tenantName ? `${tenantName} meals` : 'Freezer meals'} className="w-full h-full object-cover min-h-[280px] lg:min-h-[380px]" />
                    ) : collage.length > 0 ? (
                        <div className={`grid gap-2 w-full h-full min-h-[280px] lg:min-h-[380px] ${collage.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                            {collage.map((url, i) => (
                                <img key={url + i} src={url} alt="" className="w-full h-full object-cover min-h-[140px]" />
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center gap-3 text-white/90 px-8 text-center">
                            <UtensilsCrossed size={44} aria-hidden="true" />
                            <p className="font-bold text-lg">Real dinners for real families.</p>
                        </div>
                    )}
                </div>
            </section>

            {/* ── Trust strip ──────────────────────────────────────────────── */}
            <section className="border-y border-slate-100 dark:border-slate-800">
                <div className="max-w-6xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 divide-x divide-slate-100 dark:divide-slate-800">
                    {[
                        { icon: Smartphone, label: 'Online, mobile-friendly ordering' },
                        { icon: Share2, label: 'Share with one link or QR code' },
                        { icon: UtensilsCrossed, label: 'Meals families really use' },
                        { icon: ClipboardList, label: 'A Coordinator Panel that keeps you organized' },
                    ].map(({ icon: Icon, label }) => (
                        <div key={label} className="py-5 px-4 text-center text-sm font-bold text-slate-700 dark:text-slate-200">
                            <Icon size={22} className="mx-auto mb-2 text-slate-400" aria-hidden="true" />
                            {label}
                        </div>
                    ))}
                </div>
            </section>

            {/* ── Why a food fundraiser works ──────────────────────────────── */}
            <section className="max-w-3xl mx-auto px-6 py-16 text-center space-y-5">
                <h2 className="text-3xl font-black">Why a food fundraiser works</h2>
                <p className="font-serif italic text-xl md:text-2xl leading-snug text-slate-800 dark:text-slate-100">
                    Nobody needs another candle or roll of wrapping paper. But every family needs dinner,
                    tonight and tomorrow night too.
                </p>
                <p className="text-base leading-relaxed text-slate-600 dark:text-slate-300">
                    When a supporter buys a freezer meal bundle, they&apos;re not just donating. They&apos;re stocking
                    their own freezer with real, ready-to-heat dinners and giving your organization a boost at the
                    same time. It feels less like asking for money and more like offering something genuinely useful.
                </p>
            </section>

            {/* ── The meals (real bundles from the tenant's lineup) ────────── */}
            {bundleTiles.length > 0 && (
                <section className="max-w-6xl mx-auto px-6 pb-16">
                    <div className={`grid gap-5 grid-cols-1 sm:grid-cols-2 ${bundleTiles.length >= 3 ? 'lg:grid-cols-3' : ''} ${bundleTiles.length === 4 ? 'lg:grid-cols-4' : ''}`}>
                        {bundleTiles.map((tile) => (
                            <div key={tile.key} className="rounded-3xl overflow-hidden border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-800">
                                <div className="h-40 bg-slate-100 dark:bg-slate-700 flex items-center justify-center">
                                    {tile.imageUrl
                                        ? <img src={tile.imageUrl} alt={tile.name} className="w-full h-full object-cover" />
                                        : <UtensilsCrossed size={28} className="text-slate-400" aria-hidden="true" />}
                                </div>
                                <div className="p-4 space-y-1">
                                    <p className="font-black">{tile.name}</p>
                                    <p className="text-sm text-slate-500 dark:text-slate-400">
                                        {[
                                            tile.serves5Price !== null ? `Serves 5 · ${formatPrice(tile.serves5Price)}` : null,
                                            tile.serves2Price !== null ? `Serves 2 · ${formatPrice(tile.serves2Price)}` : null,
                                        ].filter(Boolean).join('  ·  ')}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                    <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
                        Your fundraiser features meal bundles from {tenantName ? `${tenantName}'s` : 'our'} current lineup.
                    </p>
                </section>
            )}

            {/* ── Supporters + coordinator ─────────────────────────────────── */}
            <section className="bg-slate-50 dark:bg-slate-800/50 border-y border-slate-100 dark:border-slate-800">
                <div className="max-w-6xl mx-auto px-6 py-16 grid grid-cols-1 md:grid-cols-2 gap-12 items-start">
                    <div className="space-y-4">
                        <p className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">For your supporters</p>
                        <h3 className="text-2xl font-black">Order from the couch in about two minutes</h3>
                        <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                            Open the link, pick a bundle, enter a name, done. A clear confirmation tells them what they
                            ordered and what happens next, so your coordinator isn&apos;t fielding the same questions all week.
                        </p>
                        <div className="w-44 mx-auto md:mx-0 rounded-[1.75rem] border-2 border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-3" aria-hidden="true">
                            <div className="h-1.5 w-12 mx-auto mb-3 rounded-full bg-slate-200 dark:bg-slate-600" />
                            <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-700 mb-2" />
                            <div className="h-12 rounded-lg bg-slate-100 dark:bg-slate-700 mb-2" />
                            <div className="h-8 rounded-lg text-white text-xs font-bold flex items-center justify-center" style={{ backgroundColor: primaryColor }}>Place order</div>
                        </div>
                    </div>
                    <div className="space-y-4">
                        <p className="text-xs font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">For your coordinator</p>
                        <h3 className="text-2xl font-black">One place instead of a shoebox of forms</h3>
                        <p className="text-slate-600 dark:text-slate-300 leading-relaxed">
                            A private Coordinator Panel shows orders as they arrive, who&apos;s paid, progress toward your
                            goal, and pickup details, without hunting through texts, emails, and spreadsheets. Payment
                            instructions are yours to set, so supporters know exactly how and when to pay.
                        </p>
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 p-4" aria-hidden="true">
                            <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
                                <span>Goal progress</span><span className="font-bold text-slate-800 dark:text-white">Bundles toward your goal</span>
                            </div>
                            <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-700 overflow-hidden">
                                <div className="h-full w-2/3 rounded-full" style={{ backgroundColor: primaryColor }} />
                            </div>
                            <div className="grid grid-cols-3 gap-2 mt-3 text-center text-[11px] text-slate-500 dark:text-slate-400">
                                <div className="rounded-lg bg-slate-50 dark:bg-slate-700 py-2">Orders</div>
                                <div className="rounded-lg bg-slate-50 dark:bg-slate-700 py-2">Paid</div>
                                <div className="rounded-lg bg-slate-50 dark:bg-slate-700 py-2">Days left</div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── Earnings (benefit language only — no fixed percentage) ───── */}
            <section className="max-w-3xl mx-auto px-6 py-14 text-center">
                <div className="inline-block rounded-3xl bg-emerald-50 dark:bg-emerald-900/30 px-8 py-7">
                    <p className="text-xs font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-300 mb-2">What your organization earns</p>
                    <p className="text-2xl md:text-3xl font-black text-emerald-900 dark:text-emerald-100">
                        Turn every bundle sold into support for your organization.
                    </p>
                    <p className="mt-3 text-sm text-emerald-800 dark:text-emerald-200">
                        Your group receives its agreed fundraising percentage from each qualifying sale, with the exact
                        amount set for your campaign.
                    </p>
                </div>
            </section>

            {/* ── Built to be shared ───────────────────────────────────────── */}
            <section className="bg-slate-50 dark:bg-slate-800/50 border-y border-slate-100 dark:border-slate-800">
                <div className="max-w-4xl mx-auto px-6 py-14 text-center space-y-4">
                    <h3 className="text-2xl font-black">Built to be shared</h3>
                    <p className="text-slate-600 dark:text-slate-300">
                        Your fundraiser can reach beyond the people you see face to face. Every participant and
                        supporter can pass it along.
                    </p>
                    <div className="flex flex-wrap justify-center gap-2 pt-1">
                        {[
                            { icon: MessageCircle, label: 'Text' },
                            { icon: Users, label: 'Facebook and group chats' },
                            { icon: Mail, label: 'Email' },
                            { icon: QrCode, label: 'QR code on a flyer' },
                        ].map(({ icon: Icon, label }) => (
                            <span key={label} className="inline-flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                                <Icon size={16} aria-hidden="true" /> {label}
                            </span>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── Three steps ──────────────────────────────────────────────── */}
            <section className="max-w-5xl mx-auto px-6 py-16">
                <h3 className="text-2xl font-black text-center mb-10">Three steps, start to finish</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[
                        { n: '1', title: 'Set it up', desc: 'Pick your dates, your goal, and the bundles you\'ll offer. Your personalized fundraiser page and private Coordinator Panel come with it.' },
                        { n: '2', title: 'Share it everywhere', desc: 'Text it, post it, email it, or print the QR code. Every share can reach people you\'d never hand a form to.' },
                        { n: '3', title: 'Cheer it on', desc: `Watch the goal fill up on your ordering page and Coordinator Panel while ${tenantName || 'the kitchen'} gets the meals ready for pickup day.` },
                    ].map((step) => (
                        <div key={step.n} className="rounded-3xl border border-slate-100 dark:border-slate-800 p-6 space-y-2">
                            <p className="text-3xl font-black text-slate-300 dark:text-slate-600">{step.n}</p>
                            <h4 className="text-xl font-black">{step.title}</h4>
                            <p className="text-slate-600 dark:text-slate-300 leading-relaxed">{step.desc}</p>
                        </div>
                    ))}
                </div>
                <p className="mt-10 text-center font-serif italic text-lg text-slate-600 dark:text-slate-300">
                    You focus on spreading the word. We&apos;ll help keep the fundraiser organized.
                </p>
            </section>

            {/* ── Testimonials — only the tenant's own, never invented ─────── */}
            {testimonials.length > 0 && (
                <section className="bg-slate-50 dark:bg-slate-800/50 border-y border-slate-100 dark:border-slate-800">
                    <div className="max-w-4xl mx-auto px-6 py-14 grid gap-8 md:grid-cols-2">
                        {testimonials.map((t, i) => (
                            <figure key={i} className="text-center md:text-left space-y-3">
                                <Quote size={22} className="text-slate-300 mx-auto md:mx-0" aria-hidden="true" />
                                <blockquote className="font-serif text-lg leading-relaxed text-slate-800 dark:text-slate-100">&ldquo;{t.quote}&rdquo;</blockquote>
                                <figcaption className="text-sm text-slate-500 dark:text-slate-400">{t.author}</figcaption>
                            </figure>
                        ))}
                    </div>
                </section>
            )}

            {/* ── Inquiry form ─────────────────────────────────────────────── */}
            <section id="contact-form" className="py-20 px-6 scroll-mt-8">
                <div className="max-w-2xl mx-auto bg-white dark:bg-slate-800 p-8 md:p-12 rounded-[2.5rem] shadow-xl border border-slate-100 dark:border-slate-700">
                    {submitted ? (
                        <div className="text-center py-12 space-y-6">
                            <div className="w-20 h-20 bg-emerald-50 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto text-emerald-500">
                                <CheckCircle className="w-10 h-10" />
                            </div>
                            <h2 className="text-3xl font-black">Request received</h2>
                            <p className="text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                                Thank you, {formData.name.split(' ')[0]}! We&apos;ll review your request and be in touch within 1–2 business days with the details and next steps.
                            </p>
                            <Link href={`/shop/${slug}`} className="inline-block mt-4 px-8 py-3 text-white font-bold rounded-xl transition-all" style={{ backgroundColor: primaryColor }}>
                                Back to the ordering page
                            </Link>
                        </div>
                    ) : (
                        <>
                            <div className="text-center mb-8 space-y-3">
                                <h2 className="text-3xl font-black">Ready to feed some families and fund your next season?</h2>
                                <p className="text-slate-500 dark:text-slate-400">
                                    Tell us a little about your organization and we&apos;ll follow up with everything you need to get your fundraiser started.
                                </p>
                            </div>

                            <form onSubmit={handleSubmit} className="space-y-6">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Full Name *</label>
                                        <input
                                            type="text" required
                                            value={formData.name}
                                            onChange={e => setFormData({ ...formData, name: e.target.value })}
                                            className={inputCls}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Email *</label>
                                        <input
                                            type="email" required
                                            value={formData.email}
                                            onChange={e => setFormData({ ...formData, email: e.target.value })}
                                            className={inputCls}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Phone Number *</label>
                                        <input
                                            type="tel" required
                                            value={formData.phone}
                                            onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                            className={inputCls}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Organization Name *</label>
                                        <input
                                            type="text" required
                                            value={formData.orgName}
                                            onChange={e => setFormData({ ...formData, orgName: e.target.value })}
                                            className={inputCls}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                        Website <span className="font-medium text-slate-400">(optional)</span>
                                    </label>
                                    {/* FR-ACCEPTANCE-1 — text, not type="url".
                                        A browser refuses to validate type="url" without a scheme, so
                                        someone typing their own address the way they say it out loud
                                        ("thebestbrewcoffee.com") was told it was invalid, with nothing
                                        on screen explaining that the fix was to type "https://" first.
                                        The server normalises this, so the input's job is only to let
                                        a person write down their website. */}
                                    <input
                                        type="text"
                                        inputMode="url"
                                        autoComplete="url"
                                        placeholder="thebestbrewcoffee.com"
                                        value={formData.website}
                                        onChange={e => setFormData({ ...formData, website: e.target.value })}
                                        className={inputCls}
                                    />
                                </div>

                                <div className="space-y-2">
                                    {/* FR-FUNNEL-1: no longer required. Capture enough to START a
                                        conversation, not enough to run the fundraiser — the delivery
                                        area is settled once the date discussion is real. */}
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Delivery / pickup area</label>
                                    <input
                                        type="text"
                                        placeholder="Optional — where would you distribute?"
                                        value={formData.deliveryLocation}
                                        onChange={e => setFormData({ ...formData, deliveryLocation: e.target.value })}
                                        className={inputCls}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Tell us about your cause</label>
                                    <textarea
                                        rows={3}
                                        value={formData.cause}
                                        onChange={e => setFormData({ ...formData, cause: e.target.value })}
                                        className={inputCls}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Notes</label>
                                    <textarea
                                        rows={2}
                                        value={formData.notes}
                                        onChange={e => setFormData({ ...formData, notes: e.target.value })}
                                        className={inputCls}
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="w-full py-4 text-white font-black rounded-xl shadow-lg transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-70 flex items-center justify-center gap-2"
                                    style={{ backgroundColor: primaryColor }}
                                >
                                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Start a fundraiser'}
                                </button>
                            </form>
                        </>
                    )}
                </div>
            </section>
        </div>
    );
}
