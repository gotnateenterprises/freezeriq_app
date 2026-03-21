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
    Target,
    X,
    Copy,
    Check
} from 'lucide-react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import CopyButton from '@/components/coordinator/CopyButton';

export default function SuccessGuide() {
    const params = useParams();
    const token = params.token as string;
    const [campaign, setCampaign] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isGenerating, setIsGenerating] = useState(false);
    const [generatedContent, setGeneratedContent] = useState('');
    const [generatingChannel, setGeneratingChannel] = useState('');
    const [aiRemaining, setAiRemaining] = useState<number | null>(null);
    const [previewModal, setPreviewModal] = useState<{ title: string; icon: React.ReactNode; text: string } | null>(null);
    const [modalCopied, setModalCopied] = useState(false);

    const handleGenerate = async (channel: string) => {
        setIsGenerating(true);
        setGeneratingChannel(channel);
        setGeneratedContent('');
        try {
            const res = await fetch(`/api/coordinator/${token}/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel })
            });
            const data = await res.json();
            if (!res.ok) {
                toast.error(data.error || 'Generation failed');
                return;
            }
            setGeneratedContent(data.content);
            setAiRemaining(data.remaining);
            toast.success(`${channel.charAt(0).toUpperCase() + channel.slice(1)} content generated!`);
        } catch {
            toast.error('Network error. Please try again.');
        } finally {
            setIsGenerating(false);
        }
    };

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
                        Everything you need to promote {campaign?.name || 'your campaign'} and hit your <strong>{campaign?.bundle_goal || '100'} bundle goal</strong>.
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
                        <p className="text-indigo-100 font-medium opacity-80 italic">Ready-to-use templates + AI-powered custom content!</p>
                    </div>

                    {/* Static Templates — click to preview full text */}
                    {(() => {
                        const progress = campaign?.goal_amount ? Math.round((Number(campaign.total_sales || 0) / Number(campaign.goal_amount)) * 100) : 45;
                        const templates = [
                            {
                                key: 'facebook',
                                title: 'Facebook Post',
                                icon: <Facebook className="text-indigo-300" size={32} />,
                                preview: `"Dinner is solved! Support ${campaign?.customer?.name || '[Group Name]'} by ordering your Freezer Chef meals. We are ${progress}% of the way to our goal! Order here: [Link]"`,
                                fullText: `Dinner is solved! Support ${campaign?.customer?.name || '[Group Name]'} by ordering your Freezer Chef meals. We are ${progress}% of the way to our ${Number(campaign?.bundle_goal || 100).toLocaleString()} bundle goal! Order here: ${publicUrl}`,
                            },
                            {
                                key: 'whatsapp',
                                title: 'WhatsApp / Text',
                                icon: <MessageSquare className="text-indigo-300" size={32} />,
                                preview: `"Hey everyone! We're raising money for ${campaign?.customer?.name || 'the group'}. Check out our live scoreboard and grab some easy dinners! \ud83c\udf72 [Link]"`,
                                fullText: `Hey everyone! We're raising money for ${campaign?.customer?.name || 'the group'}. Check out our live scoreboard and grab some easy dinners! \ud83c\udf72 ${publicUrl}`,
                            },
                            {
                                key: 'email',
                                title: 'Email Template',
                                icon: <Mail className="text-indigo-300" size={32} />,
                                preview: `"Hi there! I'm reaching out because ${campaign?.customer?.name || 'our organization'} is running a fundraiser. We're selling Freezer Chef meals \u2014 delicious, easy-to-prepare meals..."`,
                                fullText: `Hi there!\n\nI'm reaching out because ${campaign?.customer?.name || 'our organization'} is running the "${campaign?.name || 'our'}" fundraiser! We're selling Freezer Chef meals \u2014 delicious, easy-to-prepare meals you can stock in your freezer.\n\n\ud83c\udfaf Our goal: ${Number(campaign?.bundle_goal || 100).toLocaleString()} bundles\n\ud83d\udcca Progress: ${progress}%\n\ud83d\udd17 Order here: ${publicUrl}\n\nEvery order helps us get closer to our goal. Thank you for your support!\n\nWarmly,\n${campaign?.customer?.name || 'The Team'}`,
                                span2: true,
                            },
                        ];
                        return (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {templates.map((t) => (
                                    <button
                                        key={t.key}
                                        onClick={() => { setPreviewModal({ title: t.title, icon: t.icon, text: t.fullText }); setModalCopied(false); }}
                                        className={`bg-white/10 rounded-2xl p-6 border border-white/10 text-left hover:bg-white/20 hover:border-indigo-300/50 transition-all cursor-pointer active:scale-[0.98] group ${
                                            (t as any).span2 ? 'md:col-span-2' : ''
                                        }`}
                                    >
                                        <div className="flex items-center justify-between mb-4">
                                            {t.icon}
                                            <span className="text-xs font-bold text-indigo-200 bg-white/10 px-2 py-1 rounded-lg group-hover:bg-white/20 transition-colors">👁 Preview &amp; Copy</span>
                                        </div>
                                        <h4 className="font-black text-lg mb-2">{t.title}</h4>
                                        <p className="text-sm text-indigo-50 italic line-clamp-2">{t.preview}</p>
                                    </button>
                                ))}
                            </div>
                        );
                    })()}

                    {/* AI Generator Section */}
                    <div className="pt-8 border-t border-white/10 space-y-6">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-indigo-400 rounded-xl flex items-center justify-center text-white shadow-lg">
                                    <Rocket size={20} />
                                </div>
                                <div>
                                    <h4 className="text-xl font-black tracking-tight">AI Content Generator</h4>
                                    <p className="text-indigo-200 text-xs font-bold uppercase tracking-widest">Powered by Google Gemini</p>
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="text-xs font-black text-indigo-200 uppercase tracking-widest">
                                    {aiRemaining !== null ? `${aiRemaining} of 40 remaining` : ''}
                                </p>
                            </div>
                        </div>

                        <p className="text-sm text-indigo-100 leading-relaxed font-medium">
                            Generate custom marketing copy for any channel — instantly! Your fundraiser details are automatically included.
                        </p>

                        <div className="grid grid-cols-2 gap-3">
                            {[
                                { channel: 'facebook', label: '📘 Facebook', icon: Facebook },
                                { channel: 'text', label: '💬 Text / SMS', icon: MessageSquare },
                                { channel: 'email', label: '📧 Email', icon: Mail },
                                { channel: 'instagram', label: '📸 Instagram', icon: Target }
                            ].map(({ channel, label }) => (
                                <button
                                    key={channel}
                                    onClick={() => handleGenerate(channel)}
                                    disabled={isGenerating || aiRemaining === 0}
                                    className={`p-4 rounded-2xl border text-left transition-all ${
                                        aiRemaining === 0
                                            ? 'bg-white/5 border-white/10 opacity-50 cursor-not-allowed'
                                            : 'bg-white/5 border-white/10 hover:bg-white/15 hover:border-indigo-300/50 cursor-pointer active:scale-95'
                                    }`}
                                >
                                    <p className="text-sm font-black">{label}</p>
                                    <p className="text-[10px] text-indigo-200 mt-1">
                                        {isGenerating && generatingChannel === channel ? 'Generating...' : 'Click to generate'}
                                    </p>
                                </button>
                            ))}
                        </div>

                        {aiRemaining === 0 && (
                            <p className="text-center text-xs font-bold text-indigo-200 bg-white/5 rounded-xl p-3">
                                ✅ You&apos;ve used all 40 AI generations! Use the templates above or copy and edit previous results.
                            </p>
                        )}

                        {isGenerating && (
                            <div className="flex items-center justify-center gap-3 py-6">
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <p className="text-sm font-bold text-indigo-100 animate-pulse">Creating your {generatingChannel} content...</p>
                            </div>
                        )}

                        {generatedContent && !isGenerating && (
                            <div className="bg-indigo-900/40 rounded-3xl p-6 border border-indigo-400/30 space-y-4">
                                <div className="flex items-center justify-between">
                                    <p className="text-xs font-black text-indigo-300 uppercase tracking-widest">Generated Content</p>
                                    <CopyButton text={generatedContent} label="Content Copied!" />
                                </div>
                                <textarea
                                    value={generatedContent}
                                    onChange={(e) => setGeneratedContent(e.target.value)}
                                    rows={5}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl p-4 text-sm text-white font-medium resize-y focus:outline-none focus:ring-2 focus:ring-indigo-400/50"
                                />
                                <div className="flex gap-3">
                                    {generatingChannel === 'facebook' && (
                                        <button
                                            onClick={() => window.open('https://www.facebook.com/', '_blank')}
                                            className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 px-4 py-3 rounded-xl text-xs font-black uppercase tracking-wider transition-all active:scale-95"
                                        >
                                            <Facebook size={16} /> Open Facebook
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
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

            {/* Preview Modal */}
            {previewModal && (
                <div
                    className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                    onClick={() => setPreviewModal(null)}
                >
                    <div
                        className="w-full max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-300"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Modal Header */}
                        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center text-indigo-600">
                                    {previewModal.icon}
                                </div>
                                <h3 className="text-lg font-black text-slate-900">{previewModal.title}</h3>
                            </div>
                            <button
                                onClick={() => setPreviewModal(null)}
                                className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
                            >
                                <X size={16} className="text-slate-500" />
                            </button>
                        </div>

                        {/* Modal Body */}
                        <div className="px-6 py-6 max-h-[60vh] overflow-y-auto">
                            <div className="bg-slate-50 rounded-2xl p-5 border border-slate-200">
                                <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed font-medium">
                                    {previewModal.text}
                                </p>
                            </div>
                        </div>

                        {/* Modal Footer */}
                        <div className="px-6 py-5 border-t border-slate-100 flex gap-3">
                            <button
                                onClick={async () => {
                                    await navigator.clipboard.writeText(previewModal.text);
                                    setModalCopied(true);
                                    toast.success(`${previewModal.title} copied!`);
                                    setTimeout(() => setModalCopied(false), 2500);
                                }}
                                className={`flex-1 py-3.5 rounded-2xl font-black text-sm flex items-center justify-center gap-2 transition-all active:scale-95 ${
                                    modalCopied
                                        ? 'bg-emerald-500 text-white'
                                        : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20'
                                }`}
                            >
                                {modalCopied ? <Check size={18} /> : <Copy size={18} />}
                                {modalCopied ? 'Copied to Clipboard!' : 'Copy Full Text'}
                            </button>
                            <button
                                onClick={() => setPreviewModal(null)}
                                className="px-5 py-3.5 rounded-2xl font-bold text-sm bg-slate-100 hover:bg-slate-200 text-slate-600 transition-all active:scale-95"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
