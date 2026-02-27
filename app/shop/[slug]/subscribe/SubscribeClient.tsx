"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface Tier {
    id: string;
    name: string;
    stripe_price_id: string;
    stripe_product_id: string;
    meal_credits_per_cycle: number;
    price: any;
}

interface SubscribeClientProps {
    businessId: string;
    slug: string;
    primaryColor: string;
    tiers: Tier[];
}

export default function SubscribeClient({ businessId, slug, primaryColor, tiers }: SubscribeClientProps) {
    const router = useRouter();
    const [isProcessing, setIsProcessing] = useState<string | null>(null);

    const handleSubscribeOptions = async (tier: Tier) => {
        setIsProcessing(tier.id);

        try {
            // This endpoint will be built next
            const res = await fetch(`/api/checkout/subscription`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    businessId,
                    tierId: tier.id,
                    priceId: tier.stripe_price_id,
                })
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || "Failed to initialize checkout.");
            }

            if (data.url) {
                window.location.href = data.url;
            } else {
                throw new Error("No checkout URL returned.");
            }

        } catch (error: any) {
            console.error(error);
            toast.error(error.message || "An error occurred starting checkout.");
            setIsProcessing(null);
        }
    };

    if (tiers.length === 0) {
        return (
            <div className="bg-white dark:bg-slate-900 p-8 md:p-12 rounded-[2rem] text-center shadow-sm border border-slate-100 dark:border-slate-800">
                <h3 className="text-2xl font-black mb-4">No Active Plans Found</h3>
                <p className="text-slate-500 mb-8">This storefront does not currently have any active subscriptions configured.</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 relative z-10">
            {tiers.map((tier) => (
                <div key={tier.id} className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-xl shadow-slate-200/50 dark:shadow-none border border-slate-100 dark:border-slate-800 flex flex-col overflow-hidden transition-transform hover:-translate-y-1">
                    <div className="p-8 pb-6 border-b border-slate-100 dark:border-slate-800 relative overflow-hidden">
                        {/* Subtle banner logic could go here if one is 'popular' */}
                        <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2 relative z-10">{tier.name}</h3>
                        <div className="flex items-baseline gap-2 relative z-10">
                            <span className="text-4xl font-black">${parseFloat(tier.price.toString()).toFixed(2)}</span>
                            <span className="text-slate-500 font-medium">/ month</span>
                        </div>
                    </div>

                    <div className="p-8 flex-1 flex flex-col bg-slate-50/50 dark:bg-slate-800/20">
                        <ul className="space-y-4 mb-8 flex-1">
                            <li className="flex items-start gap-3">
                                <div className="mt-1 w-5 h-5 rounded-full flex items-center justify-center text-white" style={{ backgroundColor: primaryColor }}>
                                    <Check size={12} strokeWidth={4} />
                                </div>
                                <span className="font-bold text-slate-900 dark:text-white">{tier.meal_credits_per_cycle} Meals per month</span>
                            </li>
                            <li className="flex items-start gap-3 text-slate-600 dark:text-slate-400">
                                <Check size={20} className="text-emerald-500 shrink-0" />
                                <span>Total freedom to pick your own meals</span>
                            </li>
                            <li className="flex items-start gap-3 text-slate-600 dark:text-slate-400">
                                <Check size={20} className="text-emerald-500 shrink-0" />
                                <span>Pause or cancel anytime</span>
                            </li>
                        </ul>

                        <button
                            onClick={() => handleSubscribeOptions(tier)}
                            disabled={isProcessing !== null}
                            className="w-full py-4 rounded-xl font-black text-white transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                            style={{
                                backgroundColor: primaryColor,
                                boxShadow: isProcessing ? 'none' : `0 10px 15px -3px ${primaryColor}40`
                            }}
                        >
                            {isProcessing === tier.id ? (
                                <span className="flex items-center justify-center gap-2">
                                    <Loader2 size={20} className="animate-spin" /> Processing...
                                </span>
                            ) : (
                                `Select ${tier.name}`
                            )}
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}
