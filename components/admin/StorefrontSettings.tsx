"use client";

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Save, Loader2, Tag, Percent, ExternalLink, Plus, Trash, MessageSquare } from 'lucide-react';

interface Bundle {
    id: string;
    name: string;
}

export default function StorefrontSettings() {
    const [config, setConfig] = useState({
        hero_headline: '',
        hero_subheadline: '',
        hero_image_url: '',
        our_story_headline: '',
        our_story_content: '',
        how_it_works_content: '',
        footer_text: '',
        marketing_video_url: '',
        upsell_bundle_id: '',
        upsell_title: '',
        upsell_description: '',
        upsell_discount_percent: 0,
        upsell_type: 'bundle', // 'bundle' | 'manual'
        manual_upsell_name: '',
        manual_upsell_price: '',
        business_slug: '',
        testimonials: [] as { quote: string, author: string }[]
    });
    const [bundles, setBundles] = useState<Bundle[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [configRes, bundlesRes] = await Promise.all([
                    fetch('/api/admin/storefront-config'),
                    fetch('/api/bundles?activeOnly=true')
                ]);

                if (configRes.ok) {
                    const data = await configRes.json();
                    if (data) setConfig({
                        ...data,
                        upsell_type: data.upsell_type || 'bundle',
                        testimonials: data.testimonials || []
                    });
                }

                if (bundlesRes.ok) {
                    setBundles(await bundlesRes.json());
                }
            } catch (e) {
                console.error("Failed to load storefront settings", e);
                toast.error("Failed to load settings");
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await fetch('/api/admin/storefront-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (res.ok) {
                toast.success("Storefront settings saved");
            } else {
                toast.error("Failed to save");
            }
        } catch (e) {
            toast.error("An error occurred");
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="p-8 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>;

    return (
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4">
            {/* Header */}
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-black text-slate-900 dark:text-white">Storefront Customization</h2>
                    <p className="text-slate-500">Manage your public shop's appearance and featured offers.</p>
                </div>
                <div className="flex items-center gap-3">
                    {config.business_slug && (
                        <a
                            href={`/shop/${config.business_slug}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-6 py-2.5 rounded-xl font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
                        >
                            <ExternalLink size={18} />
                            View Webpage
                        </a>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 dark:shadow-none disabled:opacity-50"
                    >
                        {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                        Save Changes
                    </button>
                </div>
            </div>

            {/* Domain Mapping Section */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <div className="w-1.5 h-6 bg-blue-500 rounded-full" />
                    Custom Domain
                </h3>
                <div className="grid gap-4">
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                            Domain Name <span className="text-xs font-normal text-slate-400 ml-2">(e.g., www.mybakery.com)</span>
                        </label>
                        <div className="flex gap-2 relative">
                            <input
                                type="text"
                                value={(config as any).custom_domain || ''}
                                onChange={e => setConfig({ ...config, custom_domain: e.target.value } as any)}
                                placeholder="www.yourdomain.com"
                                className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-sm"
                            />
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                            Enter the fully qualified domain name you wish to map. Make sure to point your domain's CNAME or A Record to our servers first!
                        </p>
                        <a
                            href="/training?topic=custom-domain-setup"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 mt-1.5 transition-colors"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                            View DNS Setup Instructions (CNAME & A Record Guide)
                        </a>
                    </div>
                </div>
            </div>

            {/* Hero Section */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <div className="w-1.5 h-6 bg-indigo-500 rounded-full" />
                    Hero Section
                </h3>
                <div className="grid gap-4">
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Headline</label>
                        <input
                            type="text"
                            value={config.hero_headline}
                            onChange={e => setConfig({ ...config, hero_headline: e.target.value })}
                            placeholder="Welcome to Our Shop"
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none font-bold text-lg"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Subheadline</label>
                        <input
                            type="text"
                            value={config.hero_subheadline}
                            onChange={e => setConfig({ ...config, hero_subheadline: e.target.value })}
                            placeholder="Delicious meals made fresh for you."
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                            Header Image URL <span className="text-xs font-normal text-slate-400 ml-2">(Best: 2000x1200 px)</span>
                        </label>
                        <input
                            type="text"
                            value={config.hero_image_url || ''}
                            onChange={e => setConfig({ ...config, hero_image_url: e.target.value })}
                            placeholder="https://..."
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-xs"
                        />
                    </div>
                </div>
            </div>

            {/* Our Story Section */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <div className="w-1.5 h-6 bg-pink-500 rounded-full" />
                    Our Story
                </h3>
                <div className="grid gap-4">
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Headline</label>
                        <input
                            type="text"
                            value={config.our_story_headline || ''}
                            onChange={e => setConfig({ ...config, our_story_headline: e.target.value })}
                            placeholder="Delicious Done Easy. Nostalgia in Every Bite."
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none font-bold text-lg"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Content</label>
                        <textarea
                            value={config.our_story_content || ''}
                            onChange={e => setConfig({ ...config, our_story_content: e.target.value })}
                            placeholder="Tell your story here..."
                            rows={6}
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500 outline-none resize-none leading-relaxed"
                        />
                        <p className="text-xs text-slate-400 mt-2">
                            Tip: This text accepts basic spacing and will be displayed exactly as typed.
                        </p>
                    </div>
                </div>
            </div>

            {/* How It Works Section */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <div className="w-1.5 h-6 bg-amber-500 rounded-full" />
                    How It Works
                </h3>
                <div className="grid gap-4">
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Process Description</label>
                        <textarea
                            value={config.how_it_works_content || ''}
                            onChange={e => setConfig({ ...config, how_it_works_content: e.target.value })}
                            placeholder="Explain your ordering and delivery process..."
                            rows={4}
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-amber-500 outline-none resize-none leading-relaxed"
                        />
                    </div>
                </div>
            </div>

            {/* Platform Extras (Video) */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <div className="w-1.5 h-6 bg-purple-500 rounded-full" />
                    Marketing & Media
                </h3>
                <div className="grid gap-4">
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Marketing Video URL (YouTube/Vimeo)</label>
                        <input
                            type="text"
                            value={config.marketing_video_url || ''}
                            onChange={e => setConfig({ ...config, marketing_video_url: e.target.value })}
                            placeholder="https://www.youtube.com/watch?v=..."
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-purple-500 outline-none font-mono text-xs"
                        />
                    </div>
                </div>
            </div>

            {/* Footer Section */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <div className="w-1.5 h-6 bg-slate-500 rounded-full" />
                    Footer Information
                </h3>
                <div className="grid gap-4">
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Footer Custom Text</label>
                        <textarea
                            value={config.footer_text || ''}
                            onChange={e => setConfig({ ...config, footer_text: e.target.value })}
                            placeholder="Copyright, license info, or extra notes..."
                            rows={2}
                            className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-slate-500 outline-none resize-none"
                        />
                    </div>
                </div>
            </div>

            {/* Testimonials Section */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <div className="w-1.5 h-6 bg-rose-500 rounded-full" />
                        Customer Feedback
                    </h3>
                    <button
                        onClick={() => setConfig({ ...config, testimonials: [...(config.testimonials || []), { quote: '', author: '' }] })}
                        className="flex items-center gap-2 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 px-3 py-1.5 rounded-lg transition-colors"
                    >
                        <Plus size={16} />
                        Add Review
                    </button>
                </div>
                <div className="space-y-4">
                    {config.testimonials?.map((t, index) => (
                        <div key={index} className="flex flex-col md:flex-row gap-4 p-4 bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 relative group">
                            <div className="flex-1 space-y-3">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Quote</label>
                                    <textarea
                                        value={t.quote}
                                        onChange={e => {
                                            const newTestimonials = [...config.testimonials];
                                            newTestimonials[index].quote = e.target.value;
                                            setConfig({ ...config, testimonials: newTestimonials });
                                        }}
                                        placeholder="This is the best food ever!"
                                        rows={2}
                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-rose-500 outline-none resize-none text-sm"
                                    />
                                </div>
                                <div className="w-full md:w-1/2">
                                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Author Name</label>
                                    <input
                                        type="text"
                                        value={t.author}
                                        onChange={e => {
                                            const newTestimonials = [...config.testimonials];
                                            newTestimonials[index].author = e.target.value;
                                            setConfig({ ...config, testimonials: newTestimonials });
                                        }}
                                        placeholder="Jane Doe"
                                        className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-rose-500 outline-none text-sm font-medium"
                                    />
                                </div>
                            </div>
                            <button
                                onClick={() => {
                                    const newTestimonials = config.testimonials.filter((_, i) => i !== index);
                                    setConfig({ ...config, testimonials: newTestimonials });
                                }}
                                className="self-end md:self-start p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-lg transition-colors"
                                title="Remove Review"
                            >
                                <Trash size={18} />
                            </button>
                        </div>
                    ))}
                    {(!config.testimonials || config.testimonials.length === 0) && (
                        <div className="text-center p-8 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl">
                            <MessageSquare className="mx-auto text-slate-300 dark:text-slate-600 mb-2" size={32} />
                            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No reviews added yet. Add some to build customer trust!</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Featured Upsell */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-6">
                <div>
                    <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                        <div className="w-1.5 h-6 bg-emerald-500 rounded-full" />
                        Featured Upsell
                    </h3>
                    <p className="text-sm text-slate-500 mt-1">This offer will appear in the checkout flow to boost average order value.</p>
                </div>

                <div className="flex gap-4 p-1 bg-slate-100 dark:bg-slate-900 rounded-xl w-fit">
                    <button
                        onClick={() => setConfig({ ...config, upsell_type: 'bundle' })}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${config.upsell_type === 'bundle'
                            ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm'
                            : 'text-slate-500 hover:text-slate-700'
                            }`}
                    >
                        Existing Bundle
                    </button>
                    <button
                        onClick={() => setConfig({ ...config, upsell_type: 'manual' })}
                        className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${config.upsell_type === 'manual'
                            ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm'
                            : 'text-slate-500 hover:text-slate-700'
                            }`}
                    >
                        Manual Entry
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {config.upsell_type === 'bundle' ? (
                        <div className="col-span-2">
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Select Bundle to Promote</label>
                            <select
                                value={config.upsell_bundle_id || ''}
                                onChange={e => setConfig({ ...config, upsell_bundle_id: e.target.value })}
                                className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-emerald-500 outline-none font-medium"
                            >
                                <option value="">-- No Active Upsell --</option>
                                {bundles.map(b => (
                                    <option key={b.id} value={b.id}>{b.name}</option>
                                ))}
                            </select>
                        </div>
                    ) : (
                        <>
                            <div className="col-span-2 md:col-span-1">
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Item Name</label>
                                <input
                                    type="text"
                                    value={config.manual_upsell_name || ''}
                                    onChange={e => setConfig({ ...config, manual_upsell_name: e.target.value })}
                                    placeholder="e.g. Flash Cookie"
                                    className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-emerald-500 outline-none"
                                />
                            </div>
                            <div className="col-span-2 md:col-span-1">
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Price ($)</label>
                                <input
                                    type="number"
                                    value={config.manual_upsell_price || ''}
                                    onChange={e => setConfig({ ...config, manual_upsell_price: e.target.value })}
                                    placeholder="0.00"
                                    step="0.01"
                                    className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-emerald-500 outline-none"
                                />
                            </div>
                        </>
                    )}

                    {(config.upsell_bundle_id || (config.upsell_type === 'manual' && config.manual_upsell_name)) && (
                        <>
                            <div className="col-span-2 md:col-span-1">
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Offer Title</label>
                                <div className="relative">
                                    <Tag className="absolute left-3 top-3 text-slate-400" size={18} />
                                    <input
                                        type="text"
                                        value={config.upsell_title || ''}
                                        onChange={e => setConfig({ ...config, upsell_title: e.target.value })}
                                        placeholder="Special Deal!"
                                        className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-emerald-500 outline-none"
                                    />
                                </div>
                            </div>

                            <div className="col-span-2 md:col-span-1">
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Discount (%)</label>
                                <div className="relative">
                                    <Percent className="absolute left-3 top-3 text-slate-400" size={18} />
                                    <input
                                        type="number"
                                        value={config.upsell_discount_percent}
                                        onChange={e => setConfig({ ...config, upsell_discount_percent: Number(e.target.value) })}
                                        min="0"
                                        max="100"
                                        className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-emerald-500 outline-none"
                                    />
                                </div>
                            </div>

                            <div className="col-span-2">
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Short Description</label>
                                <textarea
                                    value={config.upsell_description || ''}
                                    onChange={e => setConfig({ ...config, upsell_description: e.target.value })}
                                    placeholder="Add this to your order for a discount."
                                    rows={2}
                                    className="w-full px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 focus:ring-2 focus:ring-emerald-500 outline-none resize-none"
                                />
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
