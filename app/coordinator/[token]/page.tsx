"use client";

import { useState, useEffect } from 'react';
import { toast } from 'sonner';

import {
    Megaphone,
    Plus,
    TrendingUp,
    Target,
    Calendar,
    Users,
    Share2,
    Link as LinkIcon,
    Copy,
    CheckCircle2,
    Facebook,
    ArrowRight,
    Loader2,
    DollarSign,
    User,
    Mail,
    Phone,
    MapPin,
    AlertCircle,
    X,
    Star,
    Settings
} from 'lucide-react';
import { format } from 'date-fns';
import Link from 'next/link';
import { motion } from 'framer-motion';

import { useParams } from 'next/navigation';
import UpgradeRequired from '@/components/UpgradeRequired';
import MarketingAssetGenerator from '@/components/marketing/MarketingAssetGenerator';

import Leaderboard from '@/components/coordinator/Leaderboard';
import ProgressThermometer from '@/components/coordinator/ProgressThermometer';
import ShareAction from '@/components/coordinator/ShareAction';
import Confetti from 'react-confetti';
import { useWindowSize } from 'react-use';

export default function CoordinatorPortal() {
    const { width, height } = useWindowSize();
    const params = useParams();
    const token = params.token as string;
    const [campaign, setCampaign] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showOrderModal, setShowOrderModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [copied, setCopied] = useState(false);

    // Form State
    const [formData, setFormData] = useState({
        customerName: '',
        participantName: '', // For Leaderboard attribution
        email: '',
        phone: '',
        totalAmount: '',
        deliveryAddress: ''
    });

    const [hasAccess, setHasAccess] = useState(true);

    useEffect(() => {
        fetchCampaign();

        // Polling mechanism (every 30 seconds)
        const interval = setInterval(() => {
            fetchCampaign();
        }, 30000);

        return () => clearInterval(interval);
    }, [token]);

    const fetchCampaign = async () => {
        if (!token) return;

        // Gating Check
        const session = await fetch('/api/auth/session').then(r => r.json());
        const userPlan = session?.user?.plan;
        const isSuperAdmin = (session?.user as any)?.isSuperAdmin;

        if (userPlan && userPlan !== 'ENTERPRISE' && userPlan !== 'ULTIMATE' && userPlan !== 'FREE' && !isSuperAdmin) {
            setHasAccess(false);
            setIsLoading(false);
            return;
        }

        try {
            const res = await fetch(`/api/coordinator/${token}`);
            const data = await res.json();
            setCampaign(data);
            setIsLoading(false);
        } catch (err) {
            console.error("Failed to load campaign", err);
            setIsLoading(false);
        }
    };

    const handleCopy = () => {
        const url = `${window.location.origin}/fundraiser/${campaign?.public_token}`;
        navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // State for selected items in manual order
    const [selectedItems, setSelectedItems] = useState<any[]>([]);

    const toggleItem = (bundle: any) => {
        const exists = selectedItems.find(i => i.id === bundle.id);
        if (exists) {
            setSelectedItems(selectedItems.filter(i => i.id !== bundle.id));
        } else {
            setSelectedItems([...selectedItems, { ...bundle, quantity: 1 }]);
        }
    };

    const updateQty = (id: string, delta: number) => {
        setSelectedItems(selectedItems.map(i =>
            i.id === id ? { ...i, quantity: Math.max(1, i.quantity + delta) } : i
        ));
    };

    // Auto-calculate total
    useEffect(() => {
        const total = selectedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        if (total > 0) {
            setFormData(prev => ({ ...prev, totalAmount: total.toString() }));
        }
    }, [selectedItems]);

    const handleAddOrder = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const res = await fetch(`/api/coordinator/${token}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...formData,
                    totalAmount: parseFloat(formData.totalAmount),
                    items: selectedItems.map(i => ({
                        bundleId: i.id,
                        quantity: i.quantity,
                        variantSize: i.serving_tier || 'family'
                    }))
                })
            });

            if (res.ok) {
                toast.success("Order recorded and goal updated!");
                setShowOrderModal(false);
                setFormData({ customerName: '', participantName: '', email: '', phone: '', totalAmount: '', deliveryAddress: '' });
                setSelectedItems([]);
                fetchCampaign(); // Refresh data
            } else {
                toast.error("Failed to save order");
            }
        } catch (err) {
            console.error("Failed to add order", err);
            toast.error("An error occurred");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50">
                <Loader2 className="animate-spin text-indigo-600" size={48} />
            </div>
        );
    }

    if (!hasAccess) {
        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
                <UpgradeRequired
                    feature="Coordinator Portal"
                    description="Provide your organization leads with a private dashboard to track their sales, goals, and team performance."
                />
            </div>
        );
    }

    if (!campaign) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
                <div className="text-center space-y-4">
                    <AlertCircle className="mx-auto text-red-500" size={48} />
                    <h1 className="text-2xl font-black">Portal Not Found</h1>
                    <p className="text-slate-500">This link may be expired or incorrect.</p>
                </div>
            </div>
        );
    }

    const progress = Math.min(((campaign.total_sales || 0) / (campaign.goal_amount || 1)) * 100, 100);

    return (
        <div className="min-h-screen bg-slate-50 pb-20">
            {/* Nav: Premium Glassmorphism */}
            <div className="bg-white/70 backdrop-blur-xl border-b border-white/20 px-6 py-4 sticky top-0 z-10 shadow-sm">
                <div className="max-w-xl mx-auto flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
                            <Megaphone size={16} />
                        </div>
                        <span className="font-black tracking-tight text-lg">Coordinator Portal</span>
                    </div>
                </div>
            </div>

            {/* Gamification: Confetti on Goal Met */}
            {progress >= 100 && (
                <Confetti
                    width={width}
                    height={height}
                    recycle={false}
                    numberOfPieces={400}
                    gravity={0.15}
                    colors={['#4f46e5', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6']}
                    className="z-50 pointer-events-none fixed top-0 left-0"
                />
            )}

            <main className="max-w-xl mx-auto p-6 space-y-6">
                {/* Scoreboard Card */}
                <div className="bg-white rounded-[2rem] p-8 shadow-xl shadow-indigo-500/5 border border-slate-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50 rounded-full -translate-y-12 translate-x-12 opacity-50" />

                    <div className="relative">
                        <p className="text-sm font-black text-indigo-600 uppercase tracking-widest mb-2">Live Progress</p>
                        <h1 className="text-3xl font-black text-slate-900 mb-6">{campaign.name}</h1>

                        <ProgressThermometer
                            current={campaign.total_sales || 0}
                            goal={campaign.goal_amount || 0}
                        />
                    </div>
                </div>

                {/* Leaderboard - Only show if name collection is enabled */}
                {campaign.participant_label && (
                    <Leaderboard
                        orders={campaign.orders || []}
                        participantLabel={campaign.participant_label}
                    />
                )}

                {/* Quick Actions (Desktop & Large Screens - hidden on exact mobile as we use sticky bottom bar) */}
                <div className="hidden sm:grid grid-cols-2 gap-4">
                    <button
                        onClick={() => setShowOrderModal(true)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white p-6 rounded-3xl font-black shadow-lg shadow-indigo-500/20 flex flex-col items-center gap-3 transition-all active:scale-95"
                    >
                        <Plus size={32} strokeWidth={3} />
                        <span className="text-sm">Add Offline Order</span>
                    </button>
                    <ShareAction
                        url={`${typeof window !== 'undefined' ? window.location.origin : ''}/fundraiser/${campaign?.public_token}`}
                        title={campaign.name || 'Fundraiser'}
                        className="bg-white hover:bg-slate-50 text-slate-900 p-6 rounded-3xl font-black border border-slate-200 shadow-sm flex flex-col items-center gap-3 transition-all active:scale-95 text-sm"
                    />
                </div>

                {/* Marketing Tools */}
                <div className="bg-white rounded-[2rem] p-6 border border-slate-200 shadow-sm space-y-4">
                    <h2 className="text-lg font-black flex items-center gap-2">
                        <Megaphone size={20} className="text-pink-600" />
                        Marketing Tools
                    </h2>
                    <p className="text-sm text-slate-500 font-medium">
                        Download your custom packet with QR codes, flyers, and social posts to boost your sales.
                    </p>
                    <MarketingAssetGenerator
                        campaign={campaign}
                        organizationName={campaign.customer?.name || 'Organization'}
                    />
                </div>

                <button
                    onClick={() => setShowSettingsModal(true)}
                    className="w-full bg-white hover:bg-slate-50 text-slate-900 p-4 rounded-2xl font-bold border border-slate-200 shadow-sm flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                    <Settings size={20} />
                    <span>Payment Settings</span>
                </button>

                {/* Success Toolkit CTA */}
                <Link
                    href={`/coordinator/${token}/guide`}
                    className="bg-gradient-to-br from-indigo-600 to-indigo-800 text-white p-6 rounded-[2rem] shadow-xl flex items-center justify-between group hover:scale-[1.02] transition-all overflow-hidden relative"
                >
                    <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -translate-y-8 translate-x-8 blur-2xl group-hover:bg-white/20 transition-colors" />
                    <div className="relative flex items-center gap-4">
                        <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center">
                            <Star className="text-white" fill="white" size={24} />
                        </div>
                        <div>
                            <h3 className="font-black text-lg leading-tight uppercase tracking-tight">Success Toolkit</h3>
                            <p className="text-indigo-100/80 text-xs font-bold">How-To Guide & Social Scripts</p>
                        </div>
                    </div>
                    <ArrowRight className="group-hover:translate-x-1 transition-transform" />
                </Link>

                {/* Info Section */}
                <div className="bg-white rounded-[2rem] p-6 border border-slate-200 shadow-sm">
                    <h2 className="text-lg font-black mb-4 flex items-center gap-2">
                        <TrendingUp size={20} className="text-indigo-600" />
                        Campaign Details
                    </h2>
                    <div className="space-y-4">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
                                <Calendar size={18} />
                            </div>
                            <div>
                                <p className="text-xs font-black text-slate-300 uppercase">Ends On</p>
                                <p className="font-bold text-slate-700">
                                    {campaign.end_date ? format(new Date(campaign.end_date), 'MMMM d, yyyy') : 'No date set'}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
                                <Target size={18} />
                            </div>
                            <div>
                                <p className="text-xs font-black text-slate-300 uppercase">Organization</p>
                                <p className="font-bold text-slate-700">{campaign.customer?.name}</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Recent Activity */}
                <div className="space-y-4 pb-20">
                    <h2 className="text-lg font-black px-2 flex items-center justify-between">
                        Recent Orders
                        <span className="bg-slate-200 px-2 py-0.5 rounded-full text-[10px] text-slate-600">
                            {(campaign.orders || []).length}
                        </span>
                    </h2>
                    {(campaign.orders || []).length === 0 ? (
                        <div className="bg-white rounded-3xl p-10 text-center border-2 border-dashed border-slate-200">
                            <p className="text-slate-400 font-bold italic">No orders yet. Add your first offline order!</p>
                        </div>
                    ) : (
                        (campaign.orders || []).map((order: any) => (
                            <div key={order.id} className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm flex justify-between items-center group">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600 font-black">
                                        {order.customer_name?.[0] || 'O'}
                                    </div>
                                    <div>
                                        <p className="font-black text-slate-900">{order.customer_name || 'Anonymous'}</p>
                                        <p className="text-xs font-bold text-slate-400">
                                            {format(new Date(order.created_at), 'MMM d, h:mm a')}
                                        </p>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <p className="font-black text-lg text-slate-900">${order.total_amount}</p>
                                    <span className="text-[10px] font-black uppercase text-slate-300 tracking-tighter">{order.source}</span>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </main>

            {/* Offline Order Modal */}
            {showOrderModal && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-300 overflow-y-auto">
                    <div className="bg-white w-full max-w-lg rounded-t-[2.5rem] sm:rounded-[2.5rem] p-8 mt-10 shadow-2xl relative animate-in slide-in-from-bottom-10 duration-300">
                        <button
                            onClick={() => setShowOrderModal(false)}
                            className="absolute top-6 right-6 p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                        >
                            <X size={24} />
                        </button>

                        <div className="mb-6">
                            <h2 className="text-2xl font-black text-slate-900 flex items-center gap-3">
                                <div className="p-2 bg-indigo-100 text-indigo-600 rounded-xl">
                                    <Plus size={20} strokeWidth={3} />
                                </div>
                                Add Offline Order
                            </h2>
                            <p className="text-slate-500 font-medium mt-1">Record a sale from cash, Venmo, or check.</p>
                        </div>

                        <form onSubmit={handleAddOrder} className="space-y-6">
                            {/* Bundle Selection Section */}
                            <div className="space-y-3">
                                <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Select Items Sold</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {(campaign.availableBundles || []).map((bundle: any) => {
                                        const isSelected = selectedItems.find(i => i.id === bundle.id);
                                        return (
                                            <div
                                                key={bundle.id}
                                                onClick={() => toggleItem(bundle)}
                                                className={`p-3 rounded-2xl border-2 transition-all cursor-pointer ${isSelected
                                                    ? 'border-indigo-600 bg-indigo-50/50 shadow-sm'
                                                    : 'border-slate-100 bg-slate-50 hover:border-slate-300'
                                                    }`}
                                            >
                                                <div className="flex justify-between items-start mb-1">
                                                    <p className="text-xs font-black truncate max-w-[80%]">{bundle.name}</p>
                                                    <span className="text-[10px] font-black opacity-40">${bundle.price}</span>
                                                </div>
                                                {isSelected && (
                                                    <div className="flex items-center gap-2 mt-2" onClick={e => e.stopPropagation()}>
                                                        <button
                                                            type="button"
                                                            onClick={() => updateQty(bundle.id, -1)}
                                                            className="w-6 h-6 rounded-lg bg-white border border-slate-200 flex items-center justify-center font-bold text-xs"
                                                        >-</button>
                                                        <span className="text-sm font-black w-4 text-center">{isSelected.quantity}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => updateQty(bundle.id, 1)}
                                                            className="w-6 h-6 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-xs"
                                                        >+</button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="h-px bg-slate-100 w-full" />

                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Customer Name</label>
                                    <div className="relative">
                                        <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                        <input
                                            required
                                            type="text"
                                            placeholder="Jane Doe"
                                            className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                            value={formData.customerName}
                                            onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                                        />
                                    </div>
                                </div>

                                {/* Participant / Student Name */}
                                {campaign?.participant_label && (
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">
                                            {campaign.participant_label} Name <span className="text-slate-300">(Optional - for Leaderboard)</span>
                                        </label>
                                        <div className="relative">
                                            <Target className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                            <input
                                                type="text"
                                                placeholder={`e.g. ${campaign.participant_label} Name`}
                                                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                                value={formData.participantName}
                                                onChange={(e) => setFormData({ ...formData, participantName: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Amount ($)</label>
                                        <div className="relative">
                                            <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                            <input
                                                required
                                                type="number"
                                                placeholder="45.00"
                                                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                                value={formData.totalAmount}
                                                onChange={(e) => setFormData({ ...formData, totalAmount: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Phone (Optional)</label>
                                        <div className="relative">
                                            <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                            <input
                                                type="tel"
                                                placeholder="555-0123"
                                                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                                value={formData.phone}
                                                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-1">
                                    <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Note / Address (Optional)</label>
                                    <div className="relative">
                                        <MapPin className="absolute left-4 top-4 text-slate-400" size={18} />
                                        <textarea
                                            rows={2}
                                            placeholder="Delivery to Room 24..."
                                            className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold resize-none"
                                            value={formData.deliveryAddress}
                                            onChange={(e) => setFormData({ ...formData, deliveryAddress: e.target.value })}
                                        />
                                    </div>
                                </div>

                                <button
                                    disabled={isSubmitting}
                                    type="submit"
                                    className="w-full bg-slate-900 text-white py-5 rounded-3xl font-black text-lg shadow-xl shadow-slate-900/10 hover:bg-black transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {isSubmitting ? <Loader2 className="animate-spin" size={24} /> : 'Save Order & Update Goal'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Mobile Sticky Bottom Nav Actions */}
            <div className="sm:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4 pb-safe flex gap-3 z-40 shadow-[0_-10px_40px_rgba(0,0,0,0.05)]">
                <button
                    onClick={() => setShowOrderModal(true)}
                    className="flex-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-black transition-colors"
                >
                    <Plus size={20} strokeWidth={3} />
                    <span>Offl. Order</span>
                </button>
                <ShareAction
                    url={`${typeof window !== 'undefined' ? window.location.origin : ''}/fundraiser/${campaign?.public_token}`}
                    title={campaign.name || 'Support our Fundraiser!'}
                    className="flex-[2] bg-indigo-600 hover:bg-indigo-700 text-white py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-black shadow-lg shadow-indigo-500/20"
                />
            </div>

            {/* Settings Modal */}
            <SettingsModal
                isOpen={showSettingsModal}
                onClose={() => setShowSettingsModal(false)}
                token={token}
                initialData={{
                    paymentInstructions: campaign?.payment_instructions,
                    externalPaymentLink: campaign?.external_payment_link
                }}
            />
        </div>
    );
}

function SettingsModal({ isOpen, onClose, token, initialData }: { isOpen: boolean; onClose: () => void; token: string; initialData: any }) {
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        paymentInstructions: initialData.paymentInstructions || '',
        externalPaymentLink: initialData.externalPaymentLink || ''
    });

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch(`/api/coordinator/${token}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (!res.ok) throw new Error('Failed to update settings');

            toast.success('Settings updated!');
            onClose();
            window.location.reload();
        } catch (e) {
            toast.error('Failed to save settings');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl p-6 animate-in zoom-in-95">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-black">Payment Settings</h2>
                    <button onClick={onClose}><X className="text-slate-400" /></button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5 ml-1">External Payment Link</label>
                        <input
                            className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-500"
                            placeholder="https://venmo.com/..."
                            value={formData.externalPaymentLink}
                            onChange={e => setFormData({ ...formData, externalPaymentLink: e.target.value })}
                        />
                        <p className="text-xs text-slate-400 mt-1 ml-1">E.g., Venmo, PayPal, or School Portal link.</p>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5 ml-1">Payment Instructions</label>
                        <textarea
                            className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-500 min-h-[100px]"
                            placeholder="Please send checks payable to..."
                            value={formData.paymentInstructions}
                            onChange={e => setFormData({ ...formData, paymentInstructions: e.target.value })}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-70"
                    >
                        {loading ? <Loader2 className="animate-spin mx-auto" /> : 'Save Changes'}
                    </button>
                </form>
            </div>
        </div>
    );
}
