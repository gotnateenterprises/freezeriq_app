
'use client';

import { useState } from 'react';
import { Mail, Loader2, CheckCircle2, ArrowRight } from 'lucide-react';

interface SurplusWaitlistProps {
    businessName: string;
    primaryColor: string;
    slug: string;
    businessId: string;
}

export default function SurplusWaitlist({ businessName, primaryColor, slug, businessId }: SurplusWaitlistProps) {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [message, setMessage] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setStatus('loading');

        try {
            const res = await fetch('/api/public/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, businessId, slug }),
            });

            if (!res.ok) throw new Error('Something went wrong');

            setStatus('success');
            setTimeout(() => {
                // Optional: Reset form after success state shown
            }, 3000);
        } catch (error) {
            setStatus('error');
            setMessage('Failed to join waitlist. Please try again.');
        }
    };

    if (status === 'success') {
        return (
            <div className="bg-white dark:bg-slate-800 rounded-3xl p-12 text-center shadow-sm border border-slate-100 dark:border-slate-700">
                <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6">
                    <CheckCircle2 className="w-8 h-8" />
                </div>
                <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2">You're on the list!</h3>
                <p className="text-slate-600 dark:text-slate-400">
                    We'll email you as soon as more extra meals become available.
                </p>
            </div>
        );
    }

    return (
        <div className="bg-white dark:bg-slate-800 rounded-3xl overflow-hidden shadow-lg border border-slate-100 dark:border-slate-700 max-w-4xl mx-auto w-full">
            <div className="p-4 sm:p-6 md:p-10 grid md:grid-cols-2 gap-6 md:gap-10 items-center">
                <div>
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs font-bold uppercase tracking-widest mb-6">
                        <span className="w-2 h-2 rounded-full bg-slate-400"></span>
                        Currently Sold Out
                    </div>
                    <h2 className="text-xl md:text-3xl lg:text-4xl font-black text-slate-900 dark:text-white mb-3">
                        Don't Miss the Next Drop
                    </h2>
                    <p className="text-base text-slate-600 dark:text-slate-400 mb-6 leading-relaxed">
                        Our extra meals sell out fast! Join the waitlist to get an instant email notification when we restock the freezer.
                    </p>

                    <div className="flex items-center gap-4 text-sm font-bold text-slate-500">
                        <div className="flex -space-x-2">
                            {[1, 2, 3].map(i => (
                                <div key={i} className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 border-2 border-white dark:border-slate-800" />
                            ))}
                        </div>
                        <span>Join 120+ neighbors waiting</span>
                    </div>
                </div>

                <div className="bg-slate-50 dark:bg-slate-900 p-6 md:p-8 rounded-2xl w-full">
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                                First Name
                            </label>
                            <input
                                type="text"
                                required
                                value={name}
                                onChange={e => setName(e.target.value)}
                                className="w-full px-4 py-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                                placeholder="Jane"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                                Email Address
                            </label>
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                className="w-full px-4 py-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                                placeholder="jane@example.com"
                            />
                        </div>

                        {status === 'error' && (
                            <p className="text-red-500 text-sm font-bold">{message}</p>
                        )}

                        <button
                            type="submit"
                            disabled={status === 'loading'}
                            className="w-full py-4 bg-indigo-600 text-white rounded-xl font-black hover:bg-indigo-700 active:scale-95 transition-all flex items-center justify-center gap-2"
                            style={{ backgroundColor: primaryColor }}
                        >
                            {status === 'loading' ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : (
                                <>
                                    Notify Me <ArrowRight className="w-5 h-5" />
                                </>
                            )}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
