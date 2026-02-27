'use client';

import { useState } from 'react';
import { Mail, Loader2, CheckCircle2, ArrowRight, X, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface SurplusWaitlistProps {
    businessName: string;
    primaryColor: string;
    slug: string;
    businessId: string;
}

export default function SurplusWaitlist({ businessName, primaryColor, slug, businessId }: SurplusWaitlistProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [phone, setPhone] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [message, setMessage] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setStatus('loading');

        try {
            const res = await fetch('/api/public/waitlist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, phone, businessId, slug }),
            });

            if (!res.ok) throw new Error('Something went wrong');

            setStatus('success');
            setTimeout(() => {
                setIsOpen(false);
                setStatus('idle');
                setName('');
                setEmail('');
            }, 3000);
        } catch (error) {
            setStatus('error');
            setMessage('Failed to join waitlist. Please try again.');
        }
    };

    return (
        <>
            {/* Sleek, Compact Trigger Card */}
            <div className="bg-white dark:bg-slate-800 rounded-3xl overflow-hidden shadow-lg border border-slate-100 dark:border-slate-700 p-6 md:p-8 flex flex-col md:flex-row items-center justify-between gap-6 transition-all hover:shadow-xl">
                <div className="flex-1 text-center md:text-left space-y-2">
                    <div className="inline-flex items-center gap-2 px-3 py-1 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-[10px] font-black uppercase tracking-widest rounded-full border border-amber-200/50 dark:border-amber-800/50">
                        <Sparkles size={12} />
                        High Demand
                    </div>
                    <h3 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">VIP Waitlist Access</h3>
                    <p className="text-sm text-slate-500 font-medium">Extra meals sell out immediately. Get notified the second we restock the freezer.</p>
                </div>

                <button
                    onClick={() => setIsOpen(true)}
                    className="w-full md:w-auto shrink-0 px-8 py-4 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-3 shadow-[0_12px_24px_-8px_rgba(0,0,0,0.3)]"
                    style={{ backgroundColor: primaryColor }}
                >
                    <Mail size={18} />
                    Notify Me
                </button>
            </div>

            {/* Focused Action Modal */}
            <AnimatePresence>
                {isOpen && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
                            onClick={() => status !== 'loading' && setIsOpen(false)}
                        />

                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl p-8 overflow-hidden"
                        >
                            <button
                                onClick={() => setIsOpen(false)}
                                className="absolute top-6 right-6 p-2 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                            >
                                <X size={20} />
                            </button>

                            {status === 'success' ? (
                                <div className="text-center py-8">
                                    <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6">
                                        <CheckCircle2 className="w-8 h-8" />
                                    </div>
                                    <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2">You're on the list!</h3>
                                    <p className="text-slate-500 font-medium text-sm">
                                        Keep an eye on your inbox. We'll alert you details as soon as meals drop.
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-6">
                                    <div className="space-y-2">
                                        <h3 className="text-2xl font-black text-slate-900 dark:text-white">Join the Waitlist</h3>
                                        <p className="text-sm text-slate-500 font-medium">We'll email or text you a secret link the second our next batch drops!</p>
                                    </div>

                                    <form onSubmit={handleSubmit} className="space-y-4">
                                        <div>
                                            <input
                                                type="text"
                                                required
                                                value={name}
                                                onChange={e => setName(e.target.value)}
                                                className="w-full px-5 py-4 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm font-medium placeholder-slate-400"
                                                placeholder="First Name (e.g. Jane)"
                                            />
                                        </div>
                                        <div>
                                            <input
                                                type="email"
                                                required
                                                value={email}
                                                onChange={e => setEmail(e.target.value)}
                                                className="w-full px-5 py-4 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm font-medium placeholder-slate-400"
                                                placeholder="Email Address"
                                            />
                                        </div>
                                        <div>
                                            <input
                                                type="tel"
                                                value={phone}
                                                onChange={e => setPhone(e.target.value)}
                                                className="w-full px-5 py-4 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all text-sm font-medium placeholder-slate-400"
                                                placeholder="Phone Number (Optional for SMS)"
                                            />
                                        </div>

                                        {status === 'error' && (
                                            <p className="text-red-500 text-xs font-bold text-center bg-red-50 dark:bg-red-900/20 py-2 rounded-lg">{message}</p>
                                        )}

                                        <button
                                            type="submit"
                                            disabled={status === 'loading'}
                                            className="w-full mt-2 py-4 text-white rounded-xl font-black text-sm uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-3"
                                            style={{ backgroundColor: primaryColor }}
                                        >
                                            {status === 'loading' ? (
                                                <Loader2 className="w-5 h-5 animate-spin" />
                                            ) : (
                                                <>
                                                    Get First Access <ArrowRight size={18} />
                                                </>
                                            )}
                                        </button>
                                        <p className="text-[10px] text-slate-400 text-center uppercase tracking-widest font-bold mt-4">We never spam.</p>
                                    </form>
                                </div>
                            )}
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </>
    );
}
