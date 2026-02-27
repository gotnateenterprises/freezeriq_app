"use client";

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams, useParams } from 'next/navigation';
import { CheckCircle, Loader2 } from 'lucide-react';
import { useCart } from '@/context/CartContext';
import Link from 'next/link';
import { toast } from 'sonner';

export default function CheckoutSuccessPage() {
    const { slug } = useParams() as { slug: string };
    const router = useRouter();
    const searchParams = useSearchParams();
    const sessionId = searchParams.get('session_id');
    const { clearCart } = useCart();

    const [loading, setLoading] = useState(true);
    const [orderId, setOrderId] = useState<string | null>(null);

    useEffect(() => {
        if (!sessionId) {
            router.replace(`/shop/${slug}`);
            return;
        }

        async function verifySession() {
            try {
                const res = await fetch(`/api/checkout/session/success?session_id=${sessionId}`);
                const data = await res.json();

                if (res.ok && data.success) {
                    setOrderId(data.orderId);
                    clearCart();
                } else {
                    toast.error(data.error || 'Failed to verify payment status.');
                }
            } catch (err) {
                console.error(err);
                toast.error('Could not verify checkout session.');
            } finally {
                setLoading(false);
            }
        }

        verifySession();
    }, [sessionId, slug, router, clearCart]);

    if (loading) {
        return (
            <div className="min-h-screen bg-brand-cream dark:bg-slate-950 flex flex-col items-center justify-center p-6">
                <Loader2 className="w-12 h-12 text-indigo-500 animate-spin mb-4" />
                <h1 className="text-2xl font-serif text-slate-800 dark:text-white">Processing Payment...</h1>
                <p className="text-slate-500 mt-2">Please wait while we confirm your order.</p>
            </div>
        );
    }

    if (!orderId) {
        return (
            <div className="min-h-screen bg-brand-cream dark:bg-slate-950 flex flex-col items-center justify-center p-6 text-center">
                <h1 className="text-3xl font-serif text-rose-600 mb-4">Payment Verification Failed</h1>
                <p className="text-slate-500 mb-8">We could not verify your order status. Please contact support if you believe this is an error.</p>
                <Link href={`/shop/${slug}`} className="px-8 py-3 bg-slate-900 text-white rounded-xl font-bold">
                    Return to Store
                </Link>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-brand-cream dark:bg-slate-950 flex shadow-inner items-center justify-center p-6">
            <div className="max-w-md w-full p-12 bg-white dark:bg-slate-900 rounded-[3rem] shadow-2xl border border-white dark:border-slate-800 text-center relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-32 bg-emerald-500/10 dark:bg-emerald-500/5" />

                <div className="w-24 h-24 bg-emerald-100 dark:bg-emerald-900/50 rounded-full flex items-center justify-center mx-auto text-emerald-500 dark:text-emerald-400 shadow-inner relative z-10 mb-8">
                    <CheckCircle className="w-12 h-12" />
                </div>

                <div className="space-y-4 relative z-10">
                    <h2 className="text-4xl font-serif text-slate-900 dark:text-white leading-tight">Order Confirmed!</h2>
                    <p className="text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                        We've received your payment and your order is locked in.
                    </p>
                    <div className="py-4">
                        <span className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest block mb-1">Order #</span>
                        <span className="font-mono text-lg text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 px-4 py-2 rounded-lg inline-block border border-slate-100 dark:border-slate-700">{orderId.split('-')[0].toUpperCase()}</span>
                    </div>
                </div>

                <div className="pt-8 relative z-10 flex flex-col gap-3">
                    <Link href={`/shop/${slug}/account`} className="w-full text-white bg-indigo-600 hover:bg-indigo-700 font-bold transition-colors py-4 rounded-2xl shadow-lg shadow-indigo-100 dark:shadow-none">
                        View My Account
                    </Link>
                    <Link href={`/shop/${slug}`} className="w-full text-slate-400 font-bold hover:text-slate-600 transition-colors py-3">
                        Back to Storefront
                    </Link>
                </div>
            </div>
        </div>
    );
}
