
'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Tag, Sparkles, History, ArrowLeft, Loader2, Trophy } from 'lucide-react';
import Link from 'next/link';

interface LoyaltyData {
    balance: number;
    points: any[];
    business_name: string;
    primary_color: string;
}

export default function LoyaltyDashboard() {
    const { slug } = useParams();
    const [email, setEmail] = useState('');
    const [data, setData] = useState<LoyaltyData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const savedEmail = localStorage.getItem('customer_email');
        if (savedEmail) {
            setEmail(savedEmail);
            fetchLoyalty(savedEmail);
        }
    }, []);

    const fetchLoyalty = async (targetEmail: string) => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/public/customer/loyalty?email=${targetEmail}&slug=${slug}`);
            if (!res.ok) throw new Error('Customer not found or no points yet.');
            const json = await res.json();
            setData(json);
            localStorage.setItem('customer_email', targetEmail);
        } catch (err: any) {
            setError(err.message);
            setData(null);
        } finally {
            setLoading(false);
        }
    };

    const handleLookup = (e: React.FormEvent) => {
        e.preventDefault();
        fetchLoyalty(email);
    };

    // Calculate progress to next $5 off (100 points)
    const pointsToNextReward = data ? 100 - (data.balance % 100) : 100;
    const rewardProgress = data ? (data.balance % 100) : 0;

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 transition-colors pb-20">
            {/* Header */}
            <div className="bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-800 px-6 py-12">
                <div className="max-w-4xl mx-auto text-center">
                    <Link href={`/shop/${slug}`} className="inline-flex items-center gap-2 text-sm font-bold text-slate-400 hover:text-indigo-600 mb-8">
                        <ArrowLeft className="w-4 h-4" /> Back to Storefront
                    </Link>
                    <h1 className="text-4xl font-black mb-4">Loyalty Rewards</h1>
                    <p className="text-slate-500 font-medium max-w-md mx-auto">
                        Earn 1 point for every $1 spent. Every 100 points unlocks a $5 credit toward your next meal prep kit.
                    </p>
                </div>
            </div>

            <div className="max-w-4xl mx-auto px-6 -mt-8">
                {!data ? (
                    <div className="bg-white dark:bg-slate-800 p-10 rounded-[40px] shadow-xl border border-slate-100 dark:border-slate-700 text-center animate-in fade-in slide-in-from-bottom-5">
                        <div className="w-20 h-20 bg-indigo-50 dark:bg-indigo-900/20 rounded-3xl flex items-center justify-center mx-auto mb-8 text-indigo-600">
                            <Tag className="w-10 h-10" />
                        </div>
                        <h2 className="text-2xl font-black mb-4 text-slate-800 dark:text-white">Check Your Balance</h2>
                        <p className="text-slate-500 mb-8 max-w-xs mx-auto">Enter your email address to see your points and available rewards.</p>

                        <form onSubmit={handleLookup} className="max-w-md mx-auto space-y-4">
                            <input
                                type="email"
                                placeholder="name@example.com"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full px-8 py-5 rounded-[24px] bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-700 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all text-center text-lg font-bold"
                            />
                            <button
                                disabled={loading}
                                className="w-full py-5 bg-indigo-600 text-white rounded-[24px] font-black shadow-xl hover:shadow-indigo-500/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-3"
                            >
                                {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : 'Lookup Rewards'}
                            </button>
                            {error && <p className="text-sm font-bold text-rose-500 mt-4">{error}</p>}
                        </form>
                    </div>
                ) : (
                    <div className="space-y-8 animate-in fade-in zoom-in duration-500">
                        {/* Summary Card */}
                        <div className="bg-white dark:bg-slate-800 p-10 rounded-[40px] shadow-xl border border-slate-100 dark:border-slate-700 relative overflow-hidden">
                            <div
                                className="absolute top-0 right-0 w-64 h-64 opacity-5 pointer-events-none -mr-32 -mt-32 rounded-full"
                                style={{ backgroundColor: data.primary_color }}
                            ></div>

                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-8 relative z-10">
                                <div>
                                    <div className="flex items-center gap-3 mb-4">
                                        <Trophy className="w-8 h-8 text-amber-500" />
                                        <span className="text-sm font-black uppercase tracking-widest text-slate-400">Current Balance</span>
                                    </div>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-7xl font-black tabular-nums">{Math.floor(data.balance)}</span>
                                        <span className="text-2xl font-bold text-slate-400">Points</span>
                                    </div>
                                </div>
                                <div className="bg-slate-50 dark:bg-slate-900/50 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 flex items-center gap-6">
                                    <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center text-emerald-600">
                                        <Sparkles className="w-8 h-8" />
                                    </div>
                                    <div>
                                        <p className="text-3xl font-black">${(Math.floor(data.balance / 100) * 5).toFixed(2)}</p>
                                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Available Credit</p>
                                    </div>
                                </div>
                            </div>

                            {/* Reward Progress */}
                            <div className="mt-12 pt-12 border-t border-slate-100 dark:border-slate-700">
                                <div className="flex justify-between items-end mb-4">
                                    <p className="text-sm font-bold text-slate-500">Next $5 Reward</p>
                                    <p className="text-sm font-black text-indigo-600">{pointsToNextReward} more points needed</p>
                                </div>
                                <div className="w-full h-4 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden shadow-inner p-1">
                                    <div
                                        className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-violet-500 shadow-sm transition-all duration-1000 ease-out"
                                        style={{ width: `${rewardProgress}%`, backgroundColor: data.primary_color }}
                                    ></div>
                                </div>
                            </div>
                        </div>

                        {/* Point History */}
                        <div>
                            <div className="flex items-center gap-3 mb-6 px-6">
                                <History className="w-5 h-5 text-slate-400" />
                                <h2 className="text-xl font-black">History</h2>
                            </div>
                            <div className="space-y-4">
                                {data.points.length > 0 ? data.points.map((pt, i) => (
                                    <div key={i} className="bg-white dark:bg-slate-800 px-8 py-6 rounded-3xl border border-slate-50 dark:border-slate-700 shadow-sm flex items-center justify-between group hover:border-indigo-100 transition-all">
                                        <div>
                                            <p className="font-bold text-slate-800 dark:text-white group-hover:text-indigo-600 transition-colors">{pt.reason || 'Order Reward'}</p>
                                            <p className="text-xs text-slate-400">{new Date(pt.created_at).toLocaleDateString()}</p>
                                        </div>
                                        <span className="text-lg font-black text-emerald-600">+{Math.floor(pt.points)}</span>
                                    </div>
                                )) : (
                                    <div className="text-center py-20 text-slate-400 italic">No point history yet.</div>
                                )}
                            </div>
                        </div>

                        <button
                            onClick={() => {
                                setData(null);
                                localStorage.removeItem('customer_email');
                            }}
                            className="w-full text-center text-xs font-bold text-slate-400 uppercase tracking-widest hover:text-indigo-600 transition-colors"
                        >
                            Not you {email}? Sign out
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
