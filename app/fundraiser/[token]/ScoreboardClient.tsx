"use client";

import { useState, useEffect } from 'react';
import {
    Megaphone,
    TrendingUp,
    Target,
    Calendar,
    Share2,
    Link as LinkIcon,
    Copy,
    CheckCircle2,
    Facebook,
    ArrowRight,
    Loader2,
    MessageCircle,
    Heart,
    HandHeart,
    ExternalLink
} from 'lucide-react';
import { format } from 'date-fns';

interface ScoreboardClientProps {
    token: string;
}

export default function ScoreboardClient({ token }: ScoreboardClientProps) {
    const [campaign, setCampaign] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        fetchCampaign();
        // Poll for updates every 30 seconds
        const interval = setInterval(fetchCampaign, 30000);
        return () => clearInterval(interval);
    }, [token]);

    const fetchCampaign = async () => {
        try {
            const res = await fetch(`/api/fundraiser/${token}`);
            const data = await res.json();
            setCampaign(data);
            setIsLoading(false);
        } catch (err) {
            console.error("Failed to load scoreboard", err);
            setIsLoading(false);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(window.location.href);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const shareOnFacebook = () => {
        const url = encodeURIComponent(window.location.href);
        window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, '_blank');
    };

    const shareOnWhatsApp = () => {
        const text = encodeURIComponent(`Check out this fundraiser for ${campaign?.customer?.name || 'a great cause'}! We've already raised $${campaign?.total_sales}. Support us here: ${window.location.href}`);
        window.open(`https://wa.me/?text=${text}`, '_blank');
    };

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-white">
                <Loader2 className="animate-spin text-indigo-600" size={48} />
            </div>
        );
    }

    if (!campaign) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6">
                <Megaphone size={64} className="text-slate-300 mb-4" />
                <h1 className="text-2xl font-black italic">Fundraiser Not Found</h1>
                <p className="text-slate-500 font-bold">The link might be old or disabled.</p>
            </div>
        );
    }

    const progress = Math.min(((campaign.total_sales || 0) / (campaign.goal_amount || 1)) * 100, 100);

    return (
        <div className="min-h-screen bg-[#FDFCFB] text-slate-900 selection:bg-indigo-100">
            {/* Hero Header */}
            <div className="bg-indigo-600 px-6 py-12 text-white text-center relative overflow-hidden">
                <div className="absolute inset-0 opacity-10">
                    <div className="absolute top-0 left-0 w-64 h-64 bg-white rounded-full -translate-x-20 -translate-y-20 blur-3xl" />
                    <div className="absolute bottom-0 right-0 w-96 h-96 bg-white rounded-full translate-x-20 translate-y-20 blur-3xl" />
                </div>

                <div className="max-w-2xl mx-auto relative z-10 space-y-4">
                    <div className="inline-flex items-center gap-2 bg-white/20 backdrop-blur-md px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest border border-white/30">
                        <Heart size={14} className="fill-current" />
                        Live Support Tracker
                    </div>
                    <h1 className="text-4xl md:text-5xl font-black tracking-tight">{campaign.name}</h1>
                    <p className="text-indigo-100 font-black text-lg max-w-lg mx-auto leading-tight italic">
                        {campaign.mission_text || `Supporting ${campaign.customer?.name || 'our cause'}`}
                    </p>
                </div>
            </div>

            <main className="max-w-xl mx-auto -mt-10 px-6 pb-20 relative z-20 space-y-6">
                {/* Scoreboard Card */}
                <div className="bg-white rounded-[2.5rem] p-10 shadow-2xl shadow-indigo-600/10 border border-slate-100 text-center">
                    <div className="space-y-2 mb-8">
                        <p className="text-6xl font-black tracking-tighter text-slate-900">${campaign.total_sales || 0}</p>
                        <p className="text-sm font-black text-slate-400 uppercase tracking-widest">Raised So Far</p>
                    </div>

                    {/* Progress Bar */}
                    <div className="relative pt-6">
                        <div className="absolute top-0 right-0 text-indigo-600 font-black italic text-sm">
                            {progress.toFixed(0)}% Complete!
                        </div>
                        <div className="w-full h-6 bg-slate-100 rounded-full overflow-hidden border-2 border-slate-50">
                            <div
                                className="h-full bg-gradient-to-r from-indigo-500 to-indigo-600 transition-all duration-1000 ease-out relative"
                                style={{ width: `${progress}%` }}
                            >
                                <div className="absolute inset-0 bg-white/20 animate-pulse" />
                            </div>
                        </div>
                        <div className="flex justify-between mt-3 px-1">
                            <span className="text-xs font-black text-slate-300 uppercase tracking-widest">$0</span>
                            <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Goal: ${campaign.goal_amount}</span>
                        </div>
                    </div>

                    <p className="mt-8 text-slate-500 font-medium leading-relaxed">
                        {campaign.about_text || 'Help us reach our goal! Every purchase directly supports our organization.'}
                    </p>
                </div>

                {/* Social Share Box */}
                <div className="bg-white rounded-[2rem] p-8 border border-slate-200 shadow-sm text-center">
                    <h2 className="text-xl font-black mb-6 flex items-center justify-center gap-2">
                        <Share2 size={24} className="text-indigo-600" />
                        Spread the Word!
                    </h2>
                    <div className="flex justify-center gap-4">
                        <button
                            onClick={shareOnFacebook}
                            className="w-14 h-14 bg-[#1877F2]/10 text-[#1877F2] rounded-2xl flex items-center justify-center transition-all hover:scale-110 active:scale-90"
                            title="Share on Facebook"
                        >
                            <Facebook size={28} />
                        </button>
                        <button
                            onClick={shareOnWhatsApp}
                            className="w-14 h-14 bg-[#25D366]/10 text-[#25D366] rounded-2xl flex items-center justify-center transition-all hover:scale-110 active:scale-90"
                            title="Share on WhatsApp"
                        >
                            <MessageCircle size={28} />
                        </button>
                        <button
                            onClick={handleCopy}
                            className={`w-14 h-14 bg-slate-100 rounded-2xl flex items-center justify-center transition-all hover:scale-110 active:scale-90 ${copied ? 'text-emerald-500 bg-emerald-50' : 'text-slate-600 hover:bg-slate-200'}`}
                            title="Copy Link"
                        >
                            {copied ? <CheckCircle2 size={28} /> : <LinkIcon size={28} />}
                        </button>
                    </div>
                    {copied && <p className="text-xs font-black text-emerald-500 mt-3 animate-bounce uppercase">Link Copied!</p>}
                </div>

                {/* Recent Activity Ticker */}
                <div className="space-y-4">
                    <h2 className="text-sm font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2 px-4">
                        <TrendingUp size={16} /> Recent Support
                    </h2>
                    <div className="space-y-3">
                        {(campaign.orders || []).length === 0 ? (
                            <div className="bg-slate-50 rounded-3xl p-8 text-center border border-slate-100">
                                <p className="text-slate-400 italic font-bold">Be the first to support us!</p>
                            </div>
                        ) : (
                            campaign.orders.map((order: any, idx: number) => (
                                <div key={idx} className="bg-white p-5 rounded-3xl border border-slate-200 flex justify-between items-center group animate-in slide-in-from-right duration-500" style={{ animationDelay: `${idx * 100}ms` }}>
                                    <div className="flex items-center gap-4">
                                        <div className="w-10 h-10 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 transition-transform group-hover:rotate-12">
                                            <HandHeart size={20} />
                                        </div>
                                        <div>
                                            <p className="font-black text-slate-900">{order.customer_name || 'Anonymous'}</p>
                                            <p className="text-[10px] font-black text-slate-300 uppercase">
                                                {format(new Date(order.created_at), 'MMM d, h:mm a')}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-indigo-600 font-black text-lg">+${order.total_amount}</p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Instructions Box */}
                {(campaign.payment_instructions || campaign.external_payment_link) && (
                    <div className="bg-slate-900 rounded-[2rem] p-8 text-white shadow-xl shadow-slate-900/20">
                        <div className="flex items-center gap-3 mb-4">
                            <AlertCircle size={24} className="text-indigo-400" />
                            <h2 className="text-xl font-black italic underline decoration-indigo-500">How to Help</h2>
                        </div>
                        <p className="text-slate-300 font-bold mb-6 italic leading-relaxed whitespace-pre-wrap">
                            {campaign.payment_instructions}
                        </p>
                        {campaign.external_payment_link && (
                            <a
                                href={campaign.external_payment_link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-5 rounded-2xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 shadow-lg shadow-indigo-600/20"
                            >
                                <ExternalLink size={24} /> Take Me to Payment
                            </a>
                        )}
                    </div>
                )}
            </main>
        </div>
    );
}

function AlertCircle(props: any) {
    return (
        <svg
            {...props}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
    );
}
