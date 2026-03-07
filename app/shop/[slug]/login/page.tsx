"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Mail, ArrowRight, Loader2, CheckCircle, Store } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

export default function CustomerLoginPage() {
    const params = useParams();
    const router = useRouter();
    const slug = params.slug as string;

    const [email, setEmail] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSent, setIsSent] = useState(false);
    const [businessId, setBusinessId] = useState<string | null>(null);
    const [primaryColor, setPrimaryColor] = useState("#4F46E5"); // Default indigo

    // On mount, we need to fetch the business ID using the slug
    // We can do this in a simple effect
    useState(() => {
        const fetchBusiness = async () => {
            try {
                const res = await fetch(`/api/storefront/${slug}`);
                if (res.ok) {
                    const data = await res.json();
                    setBusinessId(data.business.id);
                    if (data.branding?.primary_color) {
                        setPrimaryColor(data.branding.primary_color);
                    }
                }
            } catch (e) {
                console.error("Failed to load business data", e);
            }
        };
        fetchBusiness();
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email || !businessId) return;

        setIsLoading(true);

        try {
            const res = await fetch("/api/public/customer/auth/request", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, businessId }),
            });

            if (!res.ok) throw new Error("Failed to send link");

            const data = await res.json();

            if (data.simulated) {
                toast.success("Development Mode: Magic Link Generated in Server Console");
            } else {
                toast.success("Magic link sent!");
            }

            setIsSent(true);
        } catch (error) {
            console.error(error);
            toast.error("Failed to send login link. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
            <div className="max-w-md w-full">

                {/* Back Link */}
                <Link
                    href={`/shop/${slug}`}
                    className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white mb-8 transition-colors"
                >
                    <ArrowRight size={16} className="rotate-180" />
                    Back to Store
                </Link>

                <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-xl overflow-hidden border border-slate-200 dark:border-slate-700">

                    {/* Header Block */}
                    <div
                        className="p-8 text-center text-white relative overflow-hidden"
                        style={{ backgroundColor: primaryColor }}
                    >
                        <div className="absolute inset-0 bg-black/10"></div>
                        <div className="relative z-10">
                            <Store size={48} className="mx-auto mb-4 opacity-90" />
                            <h1 className="text-2xl font-black mb-2 tracking-tight">Access Your Account</h1>
                            <p className="text-white/80 font-medium">Manage subscriptions & loyalty points</p>
                        </div>
                    </div>

                    <div className="p-8">
                        {isSent ? (
                            <div className="text-center py-6">
                                <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/40 rounded-full flex items-center justify-center mx-auto mb-6">
                                    <CheckCircle size={32} className="text-emerald-600 dark:text-emerald-400" />
                                </div>
                                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Check Your Email</h3>
                                <p className="text-slate-500">
                                    We sent a secure login link to <strong>{email}</strong>. Click it to instantly access your account.
                                </p>
                                <button
                                    onClick={() => setIsSent(false)}
                                    className="mt-8 text-sm font-bold text-slate-500 hover:text-slate-900"
                                >
                                    Use a different email
                                </button>
                            </div>
                        ) : (
                            <form onSubmit={handleSubmit} className="space-y-6">
                                <div>
                                    <label htmlFor="email" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                                        Email Address
                                    </label>
                                    <div className="relative">
                                        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                                            <Mail size={20} />
                                        </div>
                                        <input
                                            id="email"
                                            type="email"
                                            required
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            className="block w-full pl-11 pr-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:ring-2 focus:ring-indigo-500 font-medium outline-none transition-all dark:text-white"
                                            placeholder="you@email.com"
                                        />
                                    </div>
                                </div>

                                <button
                                    type="submit"
                                    disabled={isLoading || !email || !businessId}
                                    style={{ backgroundColor: primaryColor }}
                                    className="w-full py-3 px-4 flex items-center justify-center gap-2 rounded-xl text-white font-bold hover:opacity-90 transition-opacity disabled:opacity-50"
                                >
                                    {isLoading ? (
                                        <Loader2 size={20} className="animate-spin" />
                                    ) : (
                                        <>
                                            Send Login Link <ArrowRight size={18} />
                                        </>
                                    )}
                                </button>

                                <p className="text-xs text-center text-slate-500 font-medium">
                                    Secure, passwordless login. A magic link will be sent to your email.
                                </p>
                            </form>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
