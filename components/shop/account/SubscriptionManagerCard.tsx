"use client";

import { useState } from "react";
import { Loader2, Settings2, PauseCircle, PlayCircle, XCircle, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

interface SubscriptionManagerProps {
    customerId: string;
    subscriptionStatus: string | null;
    subscriptionPlanId: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId: string | null;
}

export default function SubscriptionManagerCard({
    customerId,
    subscriptionStatus,
    subscriptionPlanId,
    stripeCustomerId,
    stripeSubscriptionId
}: SubscriptionManagerProps) {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    const [isCanceling, setIsCanceling] = useState(false); // second-layer confirmation

    // Normalized states
    const isActive = subscriptionStatus === 'active';
    const isPaused = subscriptionStatus === 'paused';
    const hasActiveSubscription = isActive || isPaused;

    const handleAction = async (action: 'pause' | 'resume' | 'cancel') => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/public/customer/subscription`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action }) // customerId is sourced from session cookie securely on backend
            });

            if (!res.ok) throw new Error(`Failed to ${action} subscription`);

            toast.success(`Subscription ${action}ed successfully.`);
            setIsOpen(false);
            setIsCanceling(false);
            router.refresh();
        } catch (error) {
            console.error(error);
            toast.error(`Something went wrong trying to ${action} your subscription.`);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col justify-between relative overflow-hidden">

            {/* Visual Header */}
            <div className="flex items-start justify-between mb-4 relative z-10">
                <div>
                    <p className="text-sm font-bold text-slate-500 mb-1">Current Plan</p>
                    <h3 className="text-xl font-black text-slate-900 dark:text-white capitalize flex items-center gap-2">
                        {hasActiveSubscription ? subscriptionPlanId || 'Monthly Subscriber' : 'No Active Subscription'}

                        {isActive && <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 text-[10px] rounded-lg tracking-widest uppercase">Active</span>}
                        {isPaused && <span className="px-2 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 text-[10px] rounded-lg tracking-widest uppercase">Paused</span>}
                    </h3>
                </div>

                {hasActiveSubscription && (
                    <button
                        onClick={() => setIsOpen(!isOpen)}
                        className="w-10 h-10 rounded-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 flex items-center justify-center text-slate-500 transition-colors"
                    >
                        <Settings2 size={18} className={isOpen ? 'rotate-90 transition-transform' : 'transition-transform'} />
                    </button>
                )}
            </div>

            {/* Bottom Actions */}
            <div className="relative z-10">
                {!hasActiveSubscription && (
                    <p className="text-sm text-slate-500">
                        Visit the storefront to subscribe to our Build-A-Box feature and start saving!
                    </p>
                )}

                {/* Dropdown Menu Overlay */}
                {isOpen && hasActiveSubscription && (
                    <div className="absolute inset-0 bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm z-20 flex flex-col p-6 animate-in fade-in slide-in-from-bottom-4">
                        <div className="flex justify-between items-center mb-6 border-b border-slate-200 dark:border-slate-700 pb-3">
                            <h4 className="font-bold text-slate-900 dark:text-white">Manage Subscription</h4>
                            <button onClick={() => { setIsOpen(false); setIsCanceling(false); }} className="text-slate-400 border border-slate-200 dark:border-slate-700 rounded-full p-1">
                                <Settings2 size={16} /> {/* Generic close representation */}
                            </button>
                        </div>

                        {isCanceling ? (
                            <div className="flex-1 flex flex-col justify-center">
                                <p className="text-sm font-bold text-slate-900 dark:text-white text-center mb-2">Are you sure?</p>
                                <p className="text-xs text-slate-500 text-center mb-6">You will lose access to locked-in subscriber pricing and your current meal credits.</p>
                                <div className="grid grid-cols-2 gap-3">
                                    <button onClick={() => setIsCanceling(false)} className="py-2.5 font-bold text-slate-600 bg-slate-100 dark:bg-slate-700 dark:text-slate-300 rounded-xl">Keep It</button>
                                    <button
                                        onClick={() => handleAction('cancel')}
                                        disabled={isLoading}
                                        className="py-2.5 font-bold text-white bg-red-600 hover:bg-red-700 rounded-xl flex items-center justify-center"
                                    >
                                        {isLoading ? <Loader2 size={16} className="animate-spin" /> : 'Yes, Cancel'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {isActive ? (
                                    <button
                                        onClick={() => handleAction('pause')}
                                        disabled={isLoading}
                                        className="w-full py-3 px-4 bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/20 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-400 font-bold rounded-xl flex items-center justify-between transition-colors text-sm"
                                    >
                                        <span className="flex items-center gap-2"><PauseCircle size={18} /> Pause Deliveries</span>
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => handleAction('resume')}
                                        disabled={isLoading}
                                        className="w-full py-3 px-4 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 font-bold rounded-xl flex items-center justify-between transition-colors text-sm"
                                    >
                                        <span className="flex items-center gap-2"><PlayCircle size={18} /> Resume Deliveries</span>
                                    </button>
                                )}

                                {stripeCustomerId && (
                                    <button className="w-full py-3 px-4 bg-slate-50 hover:bg-slate-100 dark:bg-slate-900/50 dark:hover:bg-slate-900 text-indigo-600 dark:text-indigo-400 font-bold rounded-xl flex items-center justify-between transition-colors text-sm border border-slate-200 dark:border-slate-700">
                                        <span className="flex items-center gap-2"><CreditCard size={18} /> Payment Methods</span>
                                        <span>&rarr;</span>
                                    </button>
                                )}

                                <button
                                    onClick={() => setIsCanceling(true)}
                                    className="w-full text-center py-3 text-red-500 hover:text-red-700 font-bold text-xs mt-4"
                                >
                                    Cancel Subscription
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

        </div>
    );
}
