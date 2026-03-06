"use client";

import { useState, useEffect, use } from 'react';
import {
    Megaphone,
    ArrowLeft,
    CheckCircle2,
    Share2,
    DollarSign,
    TrendingUp,
    Mail,
    MessageSquare,
    Facebook,
    ArrowRight,
    Star,
    Rocket,
    Users,
    MousePointer2,
    Calendar,
    Target
} from 'lucide-react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';

export default function SuccessGuide() {
    const params = useParams();
    const token = params.token as string;
    const [campaign, setCampaign] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        if (!token) return;

        // Gating Check
        fetch('/api/auth/session')
            .then(r => r.json())
            .then(session => {
                const userPlan = session?.user?.plan;
                if (userPlan !== 'ENTERPRISE' && userPlan !== 'ULTIMATE' && userPlan !== 'FREE' && !session?.user?.isSuperAdmin) {
                    setIsLoading(false);
                    return;
                }

                fetch(`/api/coordinator/${token}`)
                    .then(res => res.json())
                    .then(data => {
                        setCampaign(data);
                        setIsLoading(false);
                    })
                    .catch(() => setIsLoading(false));
            });
    }, [token]);

    const sections = [
        {
            icon: <TrendingUp className="text-indigo-600" />,
            title: "1. Your Secret Dashboard",
            desc: "This is your control center. Use it to record cash and Venmo sales instantly.",
            tips: [
                "Bookmark this page on your phone!",
                "Add orders as soon as you get them to keep the scoreboard live.",
                "See who has contributed and how close you are to the goal."
            ],
            color: "bg-indigo-50"
        },
        {
            icon: <Megaphone className="text-emerald-600" />,
            title: "2. The Public Scoreboard",
            desc: "Your supporters will see this page. It's designed to bring energy and excitement!",
            tips: [
                "Share this link on Facebook and in group chats.",
                "Mention your goal frequently to motivate parents.",
                "Watch the 'Recent Support' ticker grow in real-time."
            ],
            color: "bg-emerald-50"
        },
        {
            icon: <DollarSign className="text-amber-600" />,
            title: "3. Direct Online Payments",
            desc: "Want payment to go directly to your organization's bank account or Venmo?",
            tips: [
                "Add your payment link in the Portal settings.",
                "Direct donors to use your specific payment link for faster processing.",
                "Let Laurie know if you need help setting this up."
            ],
            color: "bg-amber-50"
        }
    ];

    if (isLoading) return <div className="min-h-screen flex items-center justify-center font-black animate-pulse">Loading Your Toolkit...</div>;

    const publicUrl = `${window.location.origin}/fundraiser/${campaign?.public_token}`;
    const portalUrl = `${window.location.origin}/coordinator/${token}`;

    return (
        <div className="min-h-screen bg-slate-50 pb-20 font-sans selection:bg-indigo-100 selection:text-indigo-900">
            {/* Header */}
            <header className="bg-white border-b border-slate-200 px-6 py-6 sticky top-0 z-50">
                <div className="max-w-2xl mx-auto flex items-center justify-between">
                    <Link href={`/coordinator/${token}`} className="flex items-center gap-2 text-slate-500 hover:text-indigo-600 font-black text-xs uppercase tracking-widest transition-colors">
                        <ArrowLeft size={16} /> Back to Dashboard
                    </Link>
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
                            <Star size={16} fill="currentColor" />
                        </div>
                        <span className="font-black tracking-tighter text-xl">Success Guide</span>
                    </div>
                </div>
            </header>

            <main className="max-w-2xl mx-auto px-6 py-12 space-y-12">
                {/* Hero */}
                <div className="text-center space-y-4">
                    <div className="inline-flex items-center gap-2 bg-indigo-100 text-indigo-700 px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest">
                        <Rocket size={14} /> Coordinator Toolkit
                    </div>
                    <h1 className="text-5xl font-black text-slate-900 tracking-tight leading-none">
                        Let's CRUSH <br /> this fundraiser!
                    </h1>
                    <p className="text-lg text-slate-500 font-medium max-w-md mx-auto">
                        Everything you need to promote {campaign?.name || 'your campaign'} and hit your <strong>${campaign?.goal_amount || '1,000'} goal</strong>.
                    </p>
                </div>

                {/* Scoreboard Preview */}
                <div className="bg-slate-900 rounded-[2.5rem] p-10 text-white relative overflow-hidden shadow-2xl">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full -translate-y-20 translate-x-20 blur-3xl" />
                    <div className="relative z-10 space-y-6">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center text-indigo-400">
                                <Share2 size={24} />
                            </div>
                            <h2 className="text-2xl font-black tracking-tight">Promote Your Scoreboard</h2>
                        </div>
                        <p className="text-slate-400 font-medium">
                            The Live Scoreboard is your secret weapon. When people see the progress bar moving, they are 3x more likely to support you!
                        </p>
                        <div className="bg-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 border border-white/10 group">
                            <code className="text-xs font-mono text-indigo-300 truncate">{publicUrl}</code>
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(publicUrl);
                                    alert("Public Link Copied!");
                                }}
                                className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-xs font-black uppercase transition-all"
                            >
                                Copy Link
                            </button>
                        </div>
                    </div>
                </div>

                {/* The Plan */}
                <div className="space-y-6">
                    <h3 className="text-2xl font-black text-slate-900 px-2">The Success Plan</h3>
                    <div className="space-y-4">
                        {sections.map((s, i) => (
                            <div key={i} className="bg-white rounded-3xl p-8 border border-slate-100 shadow-sm group hover:border-indigo-200 transition-all">
                                <div className="flex items-start gap-6">
                                    <div className={`w-14 h-14 ${s.color} rounded-2xl flex items-center justify-center shrink-0`}>
                                        {s.icon}
                                    </div>
                                    <div className="space-y-3">
                                        <h4 className="text-xl font-black text-slate-900">{s.title}</h4>
                                        <p className="text-slate-500 font-medium leading-relaxed">{s.desc}</p>
                                        <ul className="space-y-2 pt-2">
                                            {s.tips.map((tip, idx) => (
                                                <li key={idx} className="flex items-start gap-2 text-sm font-bold text-slate-600">
                                                    <CheckCircle2 size={16} className="text-indigo-500 shrink-0 mt-0.5" />
                                                    {tip}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Social Media Strategy */}
                <div className="bg-indigo-600 rounded-[2.5rem] p-10 text-white space-y-8">
                    <div className="space-y-2">
                        <h3 className="text-3xl font-black tracking-tight">Social Media Strategy</h3>
                        <p className="text-indigo-100 font-medium opacity-80 italic">Copy & paste these ideas for maximum reach!</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="bg-white/10 rounded-2xl p-6 border border-white/10 hover:bg-white/[0.15] transition-colors">
                            <Facebook className="mb-4 text-indigo-300" size={32} />
                            <h4 className="font-black text-lg mb-2">Facebook Post</h4>
                            <p className="text-sm text-indigo-50 italic">"Dinner is solved! Support [Group Name] by ordering your Freezer Chef meals. We are 45% of the way to our goal! Order here: [Link]"</p>
                        </div>
                        <div className="bg-white/10 rounded-2xl p-6 border border-white/10 hover:bg-white/[0.15] transition-colors">
                            <MessageSquare className="mb-4 text-indigo-300" size={32} />
                            <h4 className="font-black text-lg mb-2">WhatsApp / Text</h4>
                            <p className="text-sm text-indigo-50 italic">"Hey everyone! We're raising money for the playground. Checkout our live scoreboard here and grab some easy dinners! 🍲 [Link]"</p>
                        </div>
                    </div>

                    {/* Gemini AI Powered Content Section */}
                    <div className="pt-8 border-t border-white/10 space-y-6">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-indigo-400 rounded-xl flex items-center justify-center text-white shadow-lg">
                                <Rocket size={20} />
                            </div>
                            <div>
                                <h4 className="text-xl font-black tracking-tight">AI Content Helper (Gemini)</h4>
                                <p className="text-indigo-200 text-xs font-bold uppercase tracking-widest">Powered by Google Gemini</p>
                            </div>
                        </div>

                        <div className="bg-indigo-900/40 rounded-3xl p-6 border border-indigo-400/30 space-y-4">
                            <p className="text-sm text-indigo-100 leading-relaxed font-medium">
                                Struggling to write the perfect description? Use Google's Gemini AI to do it for you!
                                Paste one of these prompts into <a href="https://gemini.google.com" target="_blank" className="font-black underline hover:text-white transition-colors">Gemini</a> for instant results:
                            </p>

                            <div className="space-y-3">
                                <div className="bg-white/5 rounded-xl p-4 border border-white/10 group cursor-pointer hover:bg-white/10 transition-all"
                                    onClick={() => {
                                        navigator.clipboard.writeText(`Write an energetic Facebook post for our fundraiser "${campaign?.name}". Our goal is to raise $${campaign?.goal_amount}. We are selling Freezer Chef meals. Mention that dinner is finally solved!`);
                                        toast.success("AI Prompt Copied!");
                                    }}>
                                    <p className="text-xs font-black text-indigo-300 uppercase tracking-widest mb-1">Facebook Post Prompt</p>
                                    <p className="text-[11px] text-indigo-50 font-mono italic">"Write an energetic Facebook post for our fundraiser..."</p>
                                </div>
                                <div className="bg-white/5 rounded-xl p-4 border border-white/10 group cursor-pointer hover:bg-white/10 transition-all"
                                    onClick={() => {
                                        navigator.clipboard.writeText(`Write a short, friendly text message to send to my friends and family about the "${campaign?.name}" fundraiser. Mention solving dinner with Freezer Chef and include this link: ${publicUrl}`);
                                        toast.success("AI Prompt Copied!");
                                    }}>
                                    <p className="text-xs font-black text-indigo-300 uppercase tracking-widest mb-1">Text Message Prompt</p>
                                    <p className="text-[11px] text-indigo-50 font-mono italic">"Write a short, friendly text message to my friends..."</p>
                                </div>
                            </div>
                        </div>

                        <div className="pt-2">
                            <p className="text-center font-black uppercase text-xs tracking-[0.2em] text-indigo-200">
                                Pro Tip: The more details you give Gemini, the better the copy!
                            </p>
                        </div>
                    </div>
                </div>

                {/* FAQ / Support */}
                <div className="bg-white rounded-3xl p-8 border border-slate-100 text-center space-y-4">
                    <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto text-slate-400">
                        <Users size={32} />
                    </div>
                    <div>
                        <h4 className="text-xl font-black text-slate-900">Need Help?</h4>
                        <p className="text-slate-500 font-medium">Laurie is here to support you every step of the way.</p>
                    </div>
                    <a href="mailto:Laurie@MyFreezerChef.com" className="inline-flex items-center gap-2 text-indigo-600 font-black hover:underline underline-offset-4">
                        <Mail size={18} /> Laurie@MyFreezerChef.com
                    </a>
                </div>

                {/* Bottom CTA */}
                <div className="text-center pt-10">
                    <Link
                        href={`/coordinator/${token}`}
                        className="inline-flex items-center gap-3 bg-slate-900 hover:bg-black text-white px-10 py-5 rounded-full font-black text-xl shadow-2xl transition-all hover:scale-105 active:scale-95"
                    >
                        Go to My Dashboard <ArrowRight strokeWidth={3} />
                    </Link>
                </div>
            </main>

            {/* Sticky Mobile Share */}
            <div className="fixed bottom-6 left-0 right-0 px-6 z-40 md:hidden">
                <button
                    onClick={() => {
                        if (navigator.share) {
                            navigator.share({
                                title: `${campaign?.name} Fundraiser`,
                                text: `Support our fundraiser and solve dinner!`,
                                url: publicUrl
                            });
                        }
                    }}
                    className="w-full bg-indigo-600 text-white py-5 rounded-full font-black shadow-2xl shadow-indigo-500/40 flex items-center justify-center gap-3 active:scale-95 transition-all"
                >
                    <Share2 size={24} /> Share Public Scoreboard
                </button>
            </div>
        </div>
    );
}
