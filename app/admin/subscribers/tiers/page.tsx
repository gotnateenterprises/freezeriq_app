"use client";

import { useState, useEffect } from 'react';
import { PackageOpen, Plus, Tag, ChevronRight, CheckCircle, Trash2, Edit2, Loader2, Star } from 'lucide-react';
import { toast } from 'sonner';

interface Tier {
    id: string;
    name: string;
    stripe_price_id: string;
    meal_credits_per_cycle: number;
    price: number;
    is_active: boolean;
}

export default function SubscriptionTiersAdmin() {
    const [tiers, setTiers] = useState<Tier[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);

    // Form State
    const [name, setName] = useState('');
    const [price, setPrice] = useState('');
    const [credits, setCredits] = useState('');

    useEffect(() => {
        fetchTiers();
    }, []);

    const fetchTiers = async () => {
        try {
            const res = await fetch('/api/admin/subscriptions/tiers');
            const data = await res.json();
            setTiers(data);
        } catch (error) {
            toast.error("Failed to load tiers");
        } finally {
            setLoading(false);
        }
    };

    const handleCreateTier = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsCreating(true);
        try {
            const res = await fetch('/api/admin/subscriptions/tiers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    price: parseFloat(price),
                    meal_credits_per_cycle: parseInt(credits, 10)
                })
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to create tier');
            }

            toast.success("Tier created and synced with Stripe!");
            setName('');
            setPrice('');
            setCredits('');
            fetchTiers();
        } catch (error: any) {
            toast.error(error.message);
        } finally {
            setIsCreating(false);
        }
    };

    const toggleTierStatus = async (id: string, currentStatus: boolean) => {
        try {
            const res = await fetch(`/api/admin/subscriptions/tiers/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active: !currentStatus })
            });
            if (res.ok) {
                toast.success(`Tier ${!currentStatus ? 'activated' : 'deactivated'}`);
                fetchTiers();
            }
        } catch (e) {
            toast.error("Failed to update status");
        }
    };

    if (loading) return <div className="p-8"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>;

    return (
        <div className="p-8 max-w-6xl mx-auto space-y-12 pb-32">
            <div>
                <h1 className="text-4xl font-black text-slate-900 tracking-tight">Subscription Tiers</h1>
                <p className="text-slate-500 mt-2 text-lg">Define the plans customers can choose from to automate their freezer meal deliveries.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Form Column */}
                <div className="lg:col-span-1">
                    <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm sticky top-8">
                        <div className="flex items-center gap-3 mb-6">
                            <Plus className="w-6 h-6 text-emerald-500" />
                            <h2 className="text-xl font-bold text-slate-900">New Tier</h2>
                        </div>

                        <form onSubmit={handleCreateTier} className="space-y-5">
                            <div>
                                <label className="block text-sm font-bold text-slate-700 mb-1">Plan Name</label>
                                <input
                                    required
                                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                    placeholder="e.g. The 10 Meal Box"
                                    value={name} onChange={e => setName(e.target.value)}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-slate-700 mb-1">Monthly Price ($)</label>
                                <input
                                    required type="number" step="0.01" min="1"
                                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                    placeholder="e.g. 199.00"
                                    value={price} onChange={e => setPrice(e.target.value)}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-slate-700 mb-1">Meal Credits Per Cycle</label>
                                <div className="relative">
                                    <input
                                        required type="number" min="1" step="1"
                                        className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                                        placeholder="e.g. 10"
                                        value={credits} onChange={e => setCredits(e.target.value)}
                                    />
                                    <Star className="w-5 h-5 text-amber-500 absolute left-3 top-3.5" />
                                </div>
                                <p className="text-xs text-slate-500 mt-2">These credits are awarded automatically upon payment.</p>
                            </div>

                            <button
                                disabled={isCreating || !name || !price || !credits}
                                type="submit"
                                className="w-full py-4 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-100 disabled:opacity-50 flex items-center justify-center gap-2 mt-4"
                            >
                                {isCreating ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Create Stripe Product'}
                            </button>
                        </form>
                    </div>
                </div>

                {/* List Column */}
                <div className="lg:col-span-2 space-y-4">
                    {tiers.length === 0 ? (
                        <div className="bg-white border-2 border-dashed border-slate-200 rounded-3xl p-16 text-center">
                            <PackageOpen className="w-16 h-16 text-slate-200 mx-auto mb-4" />
                            <h3 className="text-xl font-bold text-slate-800 mb-2">No Tiers Configured</h3>
                            <p className="text-slate-500">Create your first subscription tier to start accepting recurring revenue.</p>
                        </div>
                    ) : (
                        tiers.map(tier => (
                            <div key={tier.id} className={`bg-white rounded-3xl p-6 border transition-all ${tier.is_active ? 'border-slate-200 shadow-sm hover:border-indigo-200' : 'border-slate-100 bg-slate-50 opacity-60'}`}>
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                                    <div className="flex items-start gap-4">
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-xl font-black shrink-0 ${tier.is_active ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-200 text-slate-500'}`}>
                                            {tier.meal_credits_per_cycle}
                                        </div>
                                        <div>
                                            <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                                                {tier.name}
                                                {tier.is_active && <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">Active</span>}
                                            </h3>
                                            <div className="flex items-center gap-4 mt-2">
                                                <p className="text-slate-500 font-medium">
                                                    <span className="font-serif text-lg text-slate-700">${Number(tier.price).toFixed(2)}</span> / cycle
                                                </p>
                                                <div className="w-1 h-1 bg-slate-300 rounded-full" />
                                                <p className="text-xs font-mono text-slate-400">ID: {tier.stripe_price_id}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2 self-end sm:self-auto">
                                        <button
                                            onClick={() => toggleTierStatus(tier.id, tier.is_active)}
                                            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm rounded-lg transition-colors"
                                        >
                                            {tier.is_active ? 'Deactivate' : 'Reactivate'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
