"use client";

import { useState, FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { CheckCircle, ArrowRight, DollarSign, Users, Heart, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

export default function RaiseFundsPage() {
    const { slug } = useParams();
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

    const scrollToForm = () => {
        document.getElementById('contact-form')?.scrollIntoView({ behavior: 'smooth' });
    };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/public/fundraiser-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...formData, slug })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to submit request');

            setSubmitted(true);
            toast.success('Request submitted! We\'ll be in touch soon.');
        } catch (err: any) {
            toast.error(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
            {/* Hero */}
            <div className="relative overflow-hidden bg-slate-900 text-white min-h-[500px] flex items-center justify-center">
                <div className="absolute inset-0 opacity-20 bg-[url('https://images.unsplash.com/photo-1574960309172-29775dd364df?q=80&w=2070')] bg-cover bg-center" />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-900 to-transparent" />

                <div className="relative z-10 max-w-4xl mx-auto px-6 text-center space-y-6">
                    <div className="inline-flex items-center gap-2 bg-indigo-500/20 backdrop-blur border border-indigo-500/50 px-4 py-1.5 rounded-full text-indigo-300 font-bold text-xs uppercase tracking-widest">
                        <Heart size={14} className="text-pink-500" /> Community Fundraising
                    </div>
                    <h1 className="text-5xl md:text-7xl font-black tracking-tight leading-tight">
                        Raise Money with <br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-pink-500 to-indigo-500">Delicious Meals</span>
                    </h1>
                    <p className="text-xl md:text-2xl text-slate-300 max-w-2xl mx-auto leading-relaxed font-medium">
                        Stop selling wrapping paper. Sell healthy, family-friendly freezer meals that your community actually wants.
                    </p>
                    <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
                        <button
                            onClick={scrollToForm}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-4 rounded-xl font-black text-lg transition-all shadow-lg shadow-indigo-500/25 flex items-center gap-2"
                        >
                            Start a Fundraiser
                            <ArrowRight size={20} />
                        </button>
                        <Link href={`/shop/${slug}`} className="px-8 py-4 rounded-xl font-bold text-slate-300 hover:text-white transition-colors">
                            View Current Sales
                        </Link>
                    </div>
                </div>
            </div>

            {/* Intro / Pitch */}
            <section className="py-16 px-6 max-w-4xl mx-auto text-center space-y-6">
                <h2 className="text-3xl font-black text-slate-900 dark:text-white">Simple, Profitable, and Stress-Free!</h2>
                <p className="text-lg text-slate-600 dark:text-slate-300 leading-relaxed">
                    When you choose Freezer Chef, you're offering more than a fundraiser—you're delivering delicious, homemade-style meals that bring comfort to tables and support to your Cause &amp; Community!
                    With over 10 years of experience, we know what it takes to make your event a success. Your group <strong>earns 20% of all sales</strong>, and we're with you every step of the way.
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
                            { title: 'Set Deadlines & Promote', desc: 'Collect orders usually 2 weeks prior to delivery. We provide marketing materials. You collect payments (checks to your org).' },
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
                    {submitted ? (
                        <div className="text-center py-12 space-y-6">
                            <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto text-emerald-500">
                                <CheckCircle className="w-10 h-10" />
                            </div>
                            <h2 className="text-3xl font-black text-slate-900 dark:text-white">Request Received!</h2>
                            <p className="text-slate-500 max-w-md mx-auto">Thank you, {formData.name.split(' ')[0]}! We&apos;ll review your request and be in touch within 1–2 business days.</p>
                            <Link href={`/shop/${slug}`} className="inline-block mt-4 px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-all">
                                Back to Store
                            </Link>
                        </div>
                    ) : (
                        <>
                            <div className="text-center mb-8">
                                <h2 className="text-3xl font-black mb-3">Request a Fundraiser</h2>
                                <p className="text-slate-500">Ready to get started? Fill out the form below and we'll be in touch.</p>
                            </div>

                            <form onSubmit={handleSubmit} className="space-y-6">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Full Name *</label>
                                        <input
                                            type="text" required
                                            value={formData.name}
                                            onChange={e => setFormData({ ...formData, name: e.target.value })}
                                            className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Email *</label>
                                        <input
                                            type="email" required
                                            value={formData.email}
                                            onChange={e => setFormData({ ...formData, email: e.target.value })}
                                            className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
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
                                            className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Organization Name *</label>
                                        <input
                                            type="text" required
                                            value={formData.orgName}
                                            onChange={e => setFormData({ ...formData, orgName: e.target.value })}
                                            className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Website</label>
                                    <input
                                        type="url"
                                        value={formData.website}
                                        onChange={e => setFormData({ ...formData, website: e.target.value })}
                                        className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Delivery Location *</label>
                                    <input
                                        type="text" required
                                        value={formData.deliveryLocation}
                                        onChange={e => setFormData({ ...formData, deliveryLocation: e.target.value })}
                                        className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Tell us about your cause</label>
                                    <textarea
                                        rows={3}
                                        value={formData.cause}
                                        onChange={e => setFormData({ ...formData, cause: e.target.value })}
                                        className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                    />
                                </div>

                                <div className="space-y-2">
                                    <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Notes</label>
                                    <textarea
                                        rows={2}
                                        value={formData.notes}
                                        onChange={e => setFormData({ ...formData, notes: e.target.value })}
                                        className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                    />
                                </div>

                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black rounded-xl shadow-lg transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-70 flex items-center justify-center gap-2"
                                >
                                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Submit Request'}
                                </button>
                                <p className="text-xs text-center text-slate-400 mt-4">
                                    Protected by reCAPTCHA and the Google Privacy Policy and Terms of Service.
                                </p>
                            </form>
                        </>
                    )}
                </div>
            </section>
        </div>
    );
}
