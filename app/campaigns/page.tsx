"use client";

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Megaphone, Mail, MessageSquare, Send, Users, ChevronDown, User, Ban, Info, History, ArrowRight } from 'lucide-react';
import { useSession } from 'next-auth/react';
import UpgradeRequired from '@/components/UpgradeRequired';

// MARKETING-PLACEHOLDER-SEND-1. FreezerIQ has no marketing email or SMS
// sender. This page used to POST to a mock that only logged the message and
// then showed "Message Sent!", list two invented demo campaigns with made-up
// stats, and show hard-coded 42% / 18% open and click rates. It now says
// plainly that sending is unavailable, keeps Send disabled, and points to the
// email features that do work. /api/marketing/send refuses with 501.

interface AudienceCounts {
    all: number;
    individual: number;
    organization: number;
}

const SEND_UNAVAILABLE_REASON_ID = 'marketing-send-unavailable-reason';

function CampaignsContent() {
    const { data: session, status } = useSession();
    const searchParams = useSearchParams();

    // Plan Gating
    const userPlan = (session?.user as any)?.plan;
    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;
    const hasAccess = userPlan === 'ENTERPRISE' || userPlan === 'ULTIMATE' || userPlan === 'FREE' || isSuperAdmin;
    const [counts, setCounts] = useState<AudienceCounts>({ all: 0, individual: 0, organization: 0 });

    // Form State (a draft only: nothing here is sent or saved)
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [channel, setChannel] = useState<'email' | 'sms'>('email');
    const [audienceType, setAudienceType] = useState<'all' | 'individual' | 'organization' | 'single'>('all');
    const [targetRecipient, setTargetRecipient] = useState('');
    const [targetName, setTargetName] = useState('');

    useEffect(() => {
        const fetchCounts = async () => {
            try {
                const countRes = await fetch('/api/marketing/audience');
                if (countRes.ok) setCounts(await countRes.json());
            } catch (e) {
                console.error("Failed to load customer counts");
            }
        };
        fetchCounts();

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

    if (status === 'loading') return <div className="p-12 text-center text-slate-500 font-bold animate-pulse">Checking Plan Access...</div>;

    if (!hasAccess) {
        return (
            <UpgradeRequired
                feature="Marketing"
                description="Draft customer campaigns. Email and SMS campaign sending is not available in FreezerIQ yet."
            />
        );
    }

    return (
        <div className="p-8 max-w-7xl mx-auto pb-32 space-y-8">
            {/* Header */}
            <div>
                <h1 className="text-4xl font-black text-slate-900 dark:text-white text-adaptive tracking-tight flex items-center gap-3">
                    <Megaphone size={36} className="text-indigo-600 dark:text-indigo-400" />
                    Campaigns & CRM
                </h1>
                <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-2 text-lg">Draft customer updates. Sending from this page is not available yet.</p>
            </div>

            {/* Unavailable notice */}
            <div
                role="status"
                className="flex items-start gap-4 p-6 rounded-2xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-100"
            >
                <Info size={24} className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                    <p className="font-black text-lg">Sending isn&apos;t available yet</p>
                    <p className="font-medium">
                        FreezerIQ can&apos;t send campaign emails or text messages from this page yet.
                        You can draft a message below, but nothing is emailed, texted, or saved.
                    </p>
                </div>
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
                                {audienceType === 'single' ? `Draft to ${targetName || 'Customer'}` : 'Draft Campaign'}
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
                                        {audienceType === 'single' ? 'Single customer' : `~${counts[audienceType as keyof AudienceCounts] || 0} customers on file`}
                                    </p>
                                    <p className="text-xs text-slate-400 font-medium">
                                        {body.length} / {channel === 'sms' ? '160' : '2000'} chars
                                    </p>
                                </div>
                            </div>

                            <div className="pt-2 flex flex-col items-end gap-2">
                                <button
                                    type="button"
                                    disabled
                                    aria-disabled="true"
                                    aria-describedby={SEND_UNAVAILABLE_REASON_ID}
                                    className="bg-slate-300 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-8 py-4 rounded-xl font-bold flex items-center gap-3 cursor-not-allowed"
                                >
                                    <Ban size={20} strokeWidth={2.5} />
                                    Sending not available
                                </button>
                                <p id={SEND_UNAVAILABLE_REASON_ID} className="text-xs text-slate-500 dark:text-slate-400 font-medium text-right max-w-md">
                                    {channel === 'sms'
                                        ? 'FreezerIQ has no text-message sender. Nothing on this page is texted.'
                                        : 'Campaign email sending is turned off until FreezerIQ has a real sender. Nothing on this page is emailed.'}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Campaign history: there is none, because nothing has ever been sent from here */}
                    <div className="glass-panel p-8 rounded-3xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                        <h3 className="text-lg font-black text-slate-900 dark:text-white mb-6 flex items-center gap-2">
                            <History size={20} className="text-slate-400" />
                            Campaign History
                        </h3>
                        <p className="text-slate-500 dark:text-slate-400 py-6 text-center font-medium">
                            No campaigns have been sent from FreezerIQ. History will appear here once campaign sending exists.
                        </p>
                    </div>
                </div>

                {/* Right: what is real today */}
                <div className="col-span-1 space-y-6">
                    <div className="glass-panel p-6 rounded-3xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-xl shadow-indigo-500/30">
                        <div className="flex items-center gap-3 mb-4 opacity-80">
                            <Users size={20} />
                            <span className="font-bold text-sm uppercase tracking-wider">Customers on File</span>
                        </div>
                        <p className="text-5xl font-black mb-1">{counts.all.toLocaleString()}</p>
                        <p className="text-indigo-100 text-sm font-medium">Active customers in your CRM. Not all have an email address, a phone number, or marketing consent.</p>
                    </div>

                    <div className="glass-panel p-6 rounded-3xl bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700">
                        <div className="flex items-center gap-3 mb-4 text-slate-500">
                            <Mail size={20} />
                            <span className="font-bold text-xs uppercase tracking-wider">Email that works today</span>
                        </div>
                        <ul className="space-y-4 text-sm">
                            <li>
                                <Link
                                    href="/fundraisers?tab=rebooking"
                                    className="font-bold text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
                                >
                                    Seasonal lineup emails <ArrowRight size={14} />
                                </Link>
                                <p className="text-slate-500 dark:text-slate-400 font-medium mt-1">Fundraiser CRM, Rebooking tab: review the audience and send a new season&apos;s lineup to coordinators of past fundraisers.</p>
                            </li>
                            <li>
                                <p className="font-bold text-slate-700 dark:text-slate-200">Previous Supporters invitations</p>
                                <p className="text-slate-500 dark:text-slate-400 font-medium mt-1">While a fundraiser is open, its coordinator can invite past supporters who agreed to future emails, from the coordinator portal.</p>
                            </li>
                        </ul>
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
