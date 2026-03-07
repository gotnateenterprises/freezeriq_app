'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Gift, ChevronRight, Loader2, Copy, CheckCircle } from 'lucide-react';

interface LoyaltyWidgetProps {
    businessId: string;
    primaryColor: string;
}

export default function LoyaltyWidget({ businessId, primaryColor }: LoyaltyWidgetProps) {
    const [email, setEmail] = useState('');
    const [balance, setBalance] = useState<number | null>(null);
    const [customerId, setCustomerId] = useState<string | null>(null);
    const [customerName, setCustomerName] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [redeeming, setRedeeming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [generatedCode, setGeneratedCode] = useState<{ code: string, amount: number } | null>(null);
    const [copied, setCopied] = useState(false);

    // Configurable conversion rate
    const POINTS_PER_DOLLAR = 20;

    const checkBalance = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setGeneratedCode(null);

        try {
            const res = await fetch(`/api/loyalty/balance?email=${encodeURIComponent(email)}&businessId=${businessId}`);
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Failed to check balance');

            if (!data.customerId) {
                setError("We couldn't find an account matching that email.");
            } else {
                setBalance(data.balance);
                setCustomerId(data.customerId);
                setCustomerName(data.name);
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleRedeem = async () => {
        if (!customerId || !balance || balance < POINTS_PER_DOLLAR) return;

        setRedeeming(true);
        setError(null);

        try {
            // Redeem available points in increments of the conversion rate
            const redeemableBlocks = Math.floor(balance / POINTS_PER_DOLLAR);
            const pointsToRedeem = redeemableBlocks * POINTS_PER_DOLLAR;

            const res = await fetch('/api/loyalty/redeem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerId,
                    businessId,
                    pointAmount: pointsToRedeem
                })
            });

            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Failed to redeem points');

            setGeneratedCode({ code: data.discountCode, amount: data.discountAmount });
            setBalance(data.newBalance);

        } catch (err: any) {
            setError(err.message);
        } finally {
            setRedeeming(false);
        }
    };

    const copyToClipboard = () => {
        if (generatedCode) {
            navigator.clipboard.writeText(generatedCode.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <div className="bg-indigo-50/50 dark:bg-slate-900/50 p-8 rounded-[3rem] border border-indigo-100 dark:border-slate-800 shadow-sm">
            <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-2xl bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                    <Gift size={24} />
                </div>
                <div>
                    <h3 className="text-xl font-black text-slate-900 dark:text-white">Customer Rewards</h3>
                    <p className="text-sm text-slate-500 font-medium">Earn points on every purchase.</p>
                </div>
            </div>

            <AnimatePresence mode="wait">
                {balance === null ? (
                    <motion.div
                        key="lookup"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="space-y-4"
                    >
                        <form onSubmit={checkBalance} className="relative">
                            <input
                                type="email"
                                required
                                placeholder="Enter your email to check balance"
                                className="w-full pl-6 pr-32 py-4 rounded-2xl bg-white dark:bg-slate-800 border-none shadow-inner outline-none focus:ring-2 focus:ring-indigo-500/20 text-slate-900 dark:text-white font-medium"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                            <button
                                disabled={loading}
                                type="submit"
                                className="absolute right-2 top-2 bottom-2 px-6 rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 transition-colors flex items-center justify-center min-w-[100px]"
                                style={{ backgroundColor: primaryColor }}
                            >
                                {loading ? <Loader2 size={16} className="animate-spin" /> : 'Look Up'}
                            </button>
                        </form>
                        {error && <p className="text-rose-500 text-sm font-bold px-2">{error}</p>}
                    </motion.div>
                ) : (
                    <motion.div
                        key="dashboard"
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="space-y-6"
                    >
                        <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm flex items-center justify-between border border-slate-100 dark:border-slate-700">
                            <div>
                                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Welcome back,</p>
                                <p className="font-bold text-slate-800 dark:text-slate-200">{customerName?.split(' ')[0]}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-3xl font-black text-indigo-600 dark:text-indigo-400 leading-none">
                                    {balance} <span className="text-sm font-bold text-indigo-300">pts</span>
                                </p>
                            </div>
                        </div>

                        {generatedCode ? (
                            <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-6 rounded-2xl text-center space-y-4 animate-in zoom-in duration-300">
                                <div className="text-emerald-600 dark:text-emerald-400 font-bold">
                                    You unlocked a ${generatedCode.amount.toFixed(2)} discount!
                                </div>
                                <div
                                    onClick={copyToClipboard}
                                    className="bg-white dark:bg-slate-900 px-6 py-4 rounded-xl font-mono text-xl font-black tracking-widest text-slate-800 dark:text-white border-2 border-emerald-100 dark:border-emerald-800/50 cursor-pointer hover:border-emerald-300 transition-colors flex items-center justify-center gap-3 group"
                                >
                                    {generatedCode.code}
                                    {copied ? <CheckCircle className="text-emerald-500" size={20} /> : <Copy className="text-slate-300 group-hover:text-emerald-500 transition-colors" size={20} />}
                                </div>
                                <p className="text-xs font-medium text-emerald-600/70">Click to copy and apply at checkout</p>
                            </div>
                        ) : (
                            <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700">
                                <p className="text-sm text-slate-500 font-medium mb-4">
                                    Every {POINTS_PER_DOLLAR} points equals $1.00 off your next order.
                                </p>
                                <button
                                    onClick={handleRedeem}
                                    disabled={balance < POINTS_PER_DOLLAR || redeeming}
                                    className="w-full py-4 rounded-xl bg-indigo-600 text-white font-bold transition-all disabled:opacity-50 disabled:bg-slate-300 flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-indigo-500/20"
                                    style={{ backgroundColor: balance >= POINTS_PER_DOLLAR ? primaryColor : undefined }}
                                >
                                    {redeeming ? <Loader2 size={20} className="animate-spin" /> : (
                                        balance >= POINTS_PER_DOLLAR ? `Redeem $${Math.floor(balance / POINTS_PER_DOLLAR).toFixed(2)} Off` : 'Not enough points yet'
                                    )}
                                </button>
                            </div>
                        )}

                        <div className="text-center">
                            <button
                                onClick={() => {
                                    setBalance(null);
                                    setEmail('');
                                    setGeneratedCode(null);
                                }}
                                className="text-xs font-bold text-slate-400 hover:text-slate-600 underline"
                            >
                                Not {email}? Look up a different account.
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
