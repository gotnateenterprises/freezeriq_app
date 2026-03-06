
'use client';

import { useState, useEffect } from 'react';
import { X, Sparkles, Send, CheckCircle2 } from 'lucide-react';

interface DealsPopupProps {
    businessName: string;
    primaryColor: string;
    onCapture: (email: string, name: string) => void;
}

export default function DealsPopup({ businessName, primaryColor, onCapture }: DealsPopupProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [submitted, setSubmitted] = useState(false);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        // Show after 3 seconds
        const timer = setTimeout(() => {
            const hasSignedUp = localStorage.getItem(`signed_up_${businessName}`);
            if (!hasSignedUp) setIsOpen(true);
        }, 3000);
        return () => clearTimeout(timer);
    }, [businessName]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            // Here we would call an API to create a CRM lead
            // For now, let's simulate and use the onCapture callback
            await new Promise(r => setTimeout(r, 1000));
            onCapture(email, name);
            localStorage.setItem(`signed_up_${businessName}`, 'true');
            setSubmitted(true);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-sm transition-opacity">
            <div className="relative w-full max-w-lg bg-white dark:bg-slate-800 rounded-[40px] shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-500">
                <button
                    onClick={() => setIsOpen(false)}
                    className="absolute top-6 right-6 p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 transition-colors z-20"
                >
                    <X className="w-6 h-6" />
                </button>

                {!submitted ? (
                    <div className="p-8 md:p-12">
                        <div className="flex items-center gap-3 mb-6 bg-amber-50 dark:bg-amber-900/20 px-4 py-2 rounded-full inline-flex border border-amber-100 dark:border-amber-800/50">
                            <Sparkles className="w-4 h-4 text-amber-500" />
                            <span className="text-xs font-black uppercase tracking-widest text-amber-600">Special Offer</span>
                        </div>

                        <h2 className="text-3xl font-black mb-4 leading-tight">
                            Get $10 Off Your First Order!
                        </h2>
                        <p className="text-slate-500 dark:text-slate-400 mb-8 font-medium">
                            Join the {businessName} community to get secret deals, loyalty points, and $10 off your first set of freezer-ready meals.
                        </p>

                        <form onSubmit={handleSubmit} className="space-y-4">
                            <input
                                type="text"
                                placeholder="Your Name"
                                required
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="w-full px-6 py-4 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                            />
                            <input
                                type="email"
                                placeholder="Email Address"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full px-6 py-4 rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                            />
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full py-5 bg-indigo-600 text-white rounded-[24px] font-black shadow-xl hover:shadow-indigo-500/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-3"
                                style={{ backgroundColor: primaryColor }}
                            >
                                {loading ? 'Saving...' : (
                                    <>Send My Code <Send className="w-5 h-5" /></>
                                )}
                            </button>
                            <p className="text-[10px] text-center text-slate-400 mt-4 leading-relaxed">
                                By signing up, you agree to receive marketing updates from {businessName}. We value your privacy and you can unsubscribe at any time.
                            </p>
                        </form>
                    </div>
                ) : (
                    <div className="p-12 text-center">
                        <div className="w-20 h-20 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto mb-8 text-emerald-600">
                            <CheckCircle2 className="w-10 h-10" />
                        </div>
                        <h2 className="text-3xl font-black mb-4">You're In!</h2>
                        <p className="text-slate-500 mb-8">
                            Welcome to the family. Use the code below at checkout to save $10 on your first order.
                        </p>
                        <div className="bg-slate-100 dark:bg-slate-900 p-8 rounded-3xl border-2 border-dashed border-indigo-200 dark:border-indigo-800">
                            <span className="text-4xl font-black tracking-widest text-indigo-600 select-all">
                                WELCOME10
                            </span>
                        </div>
                        <button
                            onClick={() => setIsOpen(false)}
                            className="mt-10 text-slate-400 hover:text-slate-600 font-bold uppercase tracking-widest text-xs"
                        >
                            Back to Shopping
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
