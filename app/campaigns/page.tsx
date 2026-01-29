"use client";

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Megaphone, Mail, MessageSquare, Send, CheckCircle, BarChart3, Users, ChevronDown, User } from 'lucide-react';

interface Campaign {
    id: string;
    subject: string;
    body: string;
    channel: 'email' | 'sms';
    status: 'draft' | 'sent';
    sent_at?: string;
    audience_size: number;
    stats?: {
        sent: number;
        opened: number;
        clicked: number;
    };
}

interface AudienceCounts {
    all: number;
    individual: number;
    organization: number;
}

function CampaignsContent() {
    const searchParams = useSearchParams();
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [counts, setCounts] = useState<AudienceCounts>({ all: 0, individual: 0, organization: 0 });

    // Form State
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [channel, setChannel] = useState<'email' | 'sms'>('email');
    const [audienceType, setAudienceType] = useState<'all' | 'individual' | 'organization' | 'single'>('all');
    const [targetRecipient, setTargetRecipient] = useState('');
    const [targetName, setTargetName] = useState('');

    const fetchCampaigns = async () => {
        setIsLoading(true);
        try {
            const [campRes, countRes] = await Promise.all([
                fetch('/api/marketing/send'),
                fetch('/api/marketing/audience')
            ]);

            if (campRes.ok) setCampaigns(await campRes.json());
            if (countRes.ok) setCounts(await countRes.json());
        } catch (e) {
            console.error("Failed to load marketing data");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchCampaigns();

        // Handle Query Params
        const to = searchParams.get('to');
        const name = searchParams.get('name');
        if (to) {
            setAudienceType('single');
            setTargetRecipient(to);
            if (name) {
                setTargetName(name);
                setSubject(`Hi ${name}!`);
            }
        }
    }, [searchParams]);

    const handleSend = async () => {
        if (!subject || !body) return;
        if (audienceType === 'single' && !targetRecipient) return;

        const audienceDesc =
            audienceType === 'single' ? targetName || targetRecipient :
                audienceType === 'all' ? 'ALL customers' :
                    `${counts[audienceType as keyof AudienceCounts]} ${audienceType}s`;

        if (!confirm(`Ready to send this ${channel.toUpperCase()} to ${audienceDesc}?`)) return;

        setIsSending(true);
        try {
            const res = await fetch('/api/marketing/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subject,
                    body,
                    channel,
                    audienceType,
                    targetRecipient,
                    // audienceSize is calculated on the backend now
                })
            });

            if (res.ok) {
                alert("Message Sent! 🚀");
                setSubject('');
                setBody('');
                if (audienceType === 'single') {
                    // Reset if it was a one-off
                    setTargetRecipient('');
                    setTargetName('');
                    setAudienceType('all');
                }
                fetchCampaigns();
            } else {
                alert("Failed to send.");
            }
        } catch (e) {
            alert("Error sending campaign.");
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="p-8 max-w-7xl mx-auto pb-32 space-y-8">
            {/* Header */}
            <div>
                <h1 className="text-4xl font-black text-slate-900 dark:text-white text-adaptive tracking-tight flex items-center gap-3">
                    <Megaphone size={36} className="text-indigo-600 dark:text-indigo-400" />
                    Campaigns & CRM
                </h1>
                <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-2 text-lg">Send targeted updates or message individual customers.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left: Composer */}
                <div className="col-span-1 lg:col-span-2 space-y-8">

                    {/* Compose Card */}
                    <div className="glass-panel p-8 rounded-3xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 shadow-xl shadow-indigo-100/50 dark:shadow-none relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-32 bg-indigo-500/5 blur-3xl rounded-full -mr-16 -mt-16 pointer-events-none"></div>

                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                            <h2 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                <Send size={24} className="text-indigo-500" />
                                {audienceType === 'single' ? `Message to ${targetName || 'Customer'}` : 'Compose Campaign'}
                            </h2>
                            <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-xl">
                                <button
                                    onClick={() => setChannel('email')}
                                    className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${channel === 'email' ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm' : 'text-slate-500'}`}
                                >
                                    <Mail size={16} /> Email
                                </button>
                                <button
                                    onClick={() => setChannel('sms')}
                                    className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${channel === 'sms' ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm' : 'text-slate-500'}`}
                                >
                                    <MessageSquare size={16} /> SMS
                                </button>
                            </div>
                        </div>

                        <div className="space-y-6">
                            {/* Audience Selector */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-2 ml-1">Target Audience</label>
                                    <div className="relative">
                                        <select
                                            value={audienceType}
                                            onChange={(e) => setAudienceType(e.target.value as any)}
                                            className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none font-bold text-base focus:ring-2 focus:ring-indigo-500 appearance-none"
                                        >
                                            <option value="all">Everyone ({counts.all})</option>
                                            <option value="individual">Individuals ({counts.individual})</option>
                                            <option value="organization">Organizations ({counts.organization})</option>
                                            <option value="single">Single Customer</option>
                                        </select>
                                        <ChevronDown size={18} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                                    </div>
                                </div>

                                {audienceType === 'single' && (
                                    <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                                        <label className="block text-xs font-bold text-slate-500 uppercase mb-2 ml-1">Recipient Email</label>
                                        <div className="relative">
                                            <User size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                                            <input
                                                type="email"
                                                value={targetRecipient}
                                                onChange={(e) => setTargetRecipient(e.target.value)}
                                                placeholder="email@example.com"
                                                className="w-full pl-11 pr-4 py-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none font-bold text-base focus:ring-2 focus:ring-indigo-500"
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-2 ml-1">Subject / Headline</label>
                                <input
                                    type="text"
                                    value={subject}
                                    onChange={(e) => setSubject(e.target.value)}
                                    placeholder={channel === 'email' ? "e.g. Menu is Open! 🥗" : "e.g. Update about your order"}
                                    className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none font-bold text-lg focus:ring-2 focus:ring-indigo-500 transition-all placeholder:font-medium"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-2 ml-1">Message Body</label>
                                <textarea
                                    rows={5}
                                    value={body}
                                    onChange={(e) => setBody(e.target.value)}
                                    placeholder="Write your message here..."
                                    className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none font-medium text-base focus:ring-2 focus:ring-indigo-500 transition-all resize-none"
                                />
                                <div className="flex justify-between items-center mt-2">
                                    <p className="text-xs text-slate-400 font-medium">
                                        {audienceType === 'single' ? 'Sending direct message' : `Targets ~${counts[audienceType as keyof AudienceCounts] || 0} customers`}
                                    </p>
                                    <p className="text-xs text-slate-400 font-medium">
                                        {body.length} / {channel === 'sms' ? '160' : '2000'} chars
                                    </p>
                                </div>
                            </div>

                            <div className="pt-2 flex justify-end">
                                <button
                                    onClick={handleSend}
                                    disabled={isSending || !subject || !body || (audienceType === 'single' && !targetRecipient)}
                                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-xl font-bold flex items-center gap-3 shadow-lg shadow-indigo-500/20 transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:shadow-none disabled:transform-none"
                                >
                                    {isSending ? (
                                        <span className="flex items-center gap-2">Sending...</span>
                                    ) : (
                                        <>
                                            <Send size={20} strokeWidth={2.5} />
                                            {audienceType === 'single' ? `Send to ${targetName || 'Customer'}` : 'Launch Campaign'}
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Recent History */}
                    <div className="glass-panel p-8 rounded-3xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                        <h3 className="text-lg font-black text-slate-900 dark:text-white mb-6">Recent Activity</h3>
                        <div className="space-y-4">
                            {isLoading ? (
                                <p className="text-slate-400 py-8 text-center">Loading history...</p>
                            ) : campaigns.length === 0 ? (
                                <p className="text-slate-400 py-8 text-center">No recent activity.</p>
                            ) : campaigns.map(camp => (
                                <div key={camp.id} className="group p-5 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-700 hover:border-indigo-200 dark:hover:border-indigo-800 transition-colors">
                                    <div className="flex justify-between items-start mb-3">
                                        <div className="flex items-center gap-3">
                                            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${camp.channel === 'email' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                                {camp.channel === 'email' ? <Mail size={18} /> : <MessageSquare size={18} />}
                                            </div>
                                            <div>
                                                <h4 className="font-bold text-slate-800 dark:text-white">{camp.subject}</h4>
                                                <p className="text-xs text-slate-500 font-medium">{new Date(camp.sent_at!).toLocaleDateString()} • {new Date(camp.sent_at!).toLocaleTimeString()}</p>
                                            </div>
                                        </div>
                                        <span className="px-3 py-1 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 text-xs font-bold rounded-lg uppercase tracking-wider">
                                            {camp.audience_size === 1 ? 'Direct' : 'Blast'}
                                        </span>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-slate-200/50 dark:border-slate-700/50">
                                        <div className="text-center">
                                            <p className="text-xs text-slate-400 font-bold uppercase">Sent</p>
                                            <p className="text-lg font-black text-slate-700 dark:text-slate-300">{camp.stats?.sent}</p>
                                        </div>
                                        <div className="text-center">
                                            <p className="text-xs text-slate-400 font-bold uppercase">Opened</p>
                                            <p className="text-lg font-black text-slate-700 dark:text-slate-300 text-emerald-600">{camp.stats?.opened}</p>
                                        </div>
                                        <div className="text-center">
                                            <p className="text-xs text-slate-400 font-bold uppercase">Clicks</p>
                                            <p className="text-lg font-black text-slate-700 dark:text-slate-300">{camp.stats?.clicked}</p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Right: Metrics */}
                <div className="col-span-1 space-y-6">
                    <div className="glass-panel p-6 rounded-3xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-xl shadow-indigo-500/30">
                        <div className="flex items-center gap-3 mb-4 opacity-80">
                            <Users size={20} />
                            <span className="font-bold text-sm uppercase tracking-wider">Total Reachable</span>
                        </div>
                        <p className="text-5xl font-black mb-1">{counts.all.toLocaleString()}</p>
                        <p className="text-indigo-100 text-sm font-medium">Reachable via Email/SMS</p>
                    </div>

                    <div className="glass-panel p-6 rounded-3xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                        <div className="flex items-center gap-3 mb-6 text-slate-500">
                            <BarChart3 size={20} />
                            <span className="font-bold text-xs uppercase tracking-wider">Avg. Performance</span>
                        </div>

                        <div className="space-y-6">
                            <div>
                                <div className="flex justify-between text-sm mb-2 font-bold">
                                    <span className="text-slate-700 dark:text-slate-300">Open Rate</span>
                                    <span className="text-emerald-500">42%</span>
                                </div>
                                <div className="h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                                    <div className="h-full bg-emerald-500 w-[42%]"></div>
                                </div>
                            </div>

                            <div>
                                <div className="flex justify-between text-sm mb-2 font-bold">
                                    <span className="text-slate-700 dark:text-slate-300">Click Rate</span>
                                    <span className="text-blue-500">18%</span>
                                </div>
                                <div className="h-2 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                                    <div className="h-full bg-blue-500 w-[18%]"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function CampaignsPage() {
    return (
        <Suspense fallback={<div className="p-12 text-center text-slate-500">Loading Campaigns...</div>}>
            <CampaignsContent />
        </Suspense>
    );
}
