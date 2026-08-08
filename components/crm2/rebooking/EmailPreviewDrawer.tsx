"use client";

/**
 * FR-RETENTION-3 — Email preview (Step 3 of 4).
 * Visual source of truth: docs/ai/prototypes/fr_retention_prototype.html (Screen 5).
 *
 * COUNT HONESTY: "emails" and "people" are shown as separate numbers, because
 * they are. Six coordinators sharing three inboxes is three emails, and this
 * screen says so rather than implying six.
 *
 * The real send stays visibly gated until the rebooking link exists. The block
 * is enforced on the server; this is only how it is explained.
 *
 * Nothing here exposes batches, messages, normalized addresses, idempotency
 * keys, provider message ids, or provider names.
 */

import { useState, useEffect } from 'react';
import { X, Loader2, AlertCircle, Send, Mail, Lock } from 'lucide-react';

interface PreviewData {
    lineupName: string;
    from: string;
    replyTo: string | null;
    subject: string;
    html: string;
    counts: {
        deliveryAddresses: number;
        representedContacts: number;
        representedOrganizations: number;
        sharedInboxes: number;
    };
    ctaReady: boolean;
    ctaBlockedReason: string | null;
    senderReady: boolean;
    senderBlockedReason: string | null;
    approved: boolean;
}

interface Props {
    open: boolean;
    lineupId: string | null;
    onBack: () => void;
    onClose: () => void;
}

export function EmailPreviewDrawer({ open, lineupId, onBack, onClose }: Props) {
    const [data, setData] = useState<PreviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [testAddress, setTestAddress] = useState('');
    const [testState, setTestState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
    const [testMessage, setTestMessage] = useState<string | null>(null);

    useEffect(() => {
        if (!open || !lineupId) return;
        let alive = true;
        setLoading(true); setError(null); setTestState('idle'); setTestMessage(null);
        fetch(`/api/rebooking/seasonal-lineups/${lineupId}/message`, { cache: 'no-store' })
            .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed to load'); return d; })
            .then((d) => { if (alive) { setData(d); setLoading(false); } })
            .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
        return () => { alive = false; };
    }, [open, lineupId]);

    if (!open) return null;

    const sendTest = async () => {
        if (!lineupId) return;
        setTestState('sending'); setTestMessage(null);
        try {
            const res = await fetch(`/api/rebooking/seasonal-lineups/${lineupId}/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'test', testAddress: testAddress.trim() || undefined }),
            });
            const d = await res.json();
            if (!res.ok || !d.ok) {
                setTestState('error');
                setTestMessage((d.errors && d.errors[0]) || d.error || "The test email couldn't be sent.");
                return;
            }
            setTestState('sent');
            setTestMessage(`Test email on its way to your ${d.destinationCategory}.`);
        } catch {
            setTestState('error');
            setTestMessage("The test email couldn't be sent.");
        }
    };

    const c = data?.counts;

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-sm p-0 sm:p-4"
            role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <div className="bg-white dark:bg-slate-900 w-full sm:max-w-2xl rounded-t-3xl sm:rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl max-h-[92vh] flex flex-col">

                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                    <div className="min-w-0">
                        <h4 id="preview-title" className="font-black text-slate-900 dark:text-white">Email preview</h4>
                        <p className="text-[11px] font-bold text-slate-400">{data?.lineupName ?? ''} · Step 3 of 4</p>
                    </div>
                    <button onClick={onClose} aria-label="Close"
                        className="flex-none w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                        <X size={18} />
                    </button>
                </div>

                <div className="px-5 py-4 space-y-5 overflow-y-auto">
                    {loading ? (
                        <div className="py-14 text-center text-slate-400 font-bold flex items-center justify-center gap-2">
                            <Loader2 size={18} className="animate-spin" /> Building your email…
                        </div>
                    ) : error ? (
                        <div className="rounded-2xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3">
                            <p className="text-sm font-bold text-rose-700 dark:text-rose-400 flex items-center gap-2"><AlertCircle size={15} /> {error}</p>
                        </div>
                    ) : data && c ? (
                        <>
                            {/* People and emails are different numbers, and are shown as such. */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="glass-panel p-4 rounded-2xl border border-slate-100 dark:border-slate-700">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Emails to send</p>
                                    <p className="text-2xl font-black tabular-nums text-indigo-600">{c.deliveryAddresses}</p>
                                    {c.sharedInboxes > 0 && (
                                        <p className="text-[11px] font-bold text-violet-600 mt-1">
                                            {c.sharedInboxes} shared inbox{c.sharedInboxes === 1 ? '' : 'es'}
                                        </p>
                                    )}
                                </div>
                                <div className="glass-panel p-4 rounded-2xl border border-slate-100 dark:border-slate-700">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">People reached</p>
                                    <p className="text-2xl font-black tabular-nums">{c.representedContacts}</p>
                                    <p className="text-[11px] font-bold text-slate-400 mt-1">
                                        across {c.representedOrganizations} organization{c.representedOrganizations === 1 ? '' : 's'}
                                    </p>
                                </div>
                            </div>

                            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                                <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 space-y-1 bg-slate-50/60 dark:bg-slate-800/40">
                                    <p className="text-[11px] font-bold text-slate-400">From</p>
                                    <p className="text-sm font-bold text-slate-900 dark:text-white break-words">{data.from}</p>
                                    {data.replyTo && (
                                        <>
                                            <p className="text-[11px] font-bold text-slate-400 pt-1">Replies go to</p>
                                            <p className="text-sm font-bold text-slate-700 dark:text-slate-300 break-words">{data.replyTo}</p>
                                        </>
                                    )}
                                    <p className="text-[11px] font-bold text-slate-400 pt-1">Subject</p>
                                    <p className="text-sm font-black text-slate-900 dark:text-white break-words">{data.subject}</p>
                                </div>
                                <div className="p-4 bg-white dark:bg-slate-900 overflow-x-auto">
                                    <div className="text-sm text-slate-800 dark:text-slate-200 [&_a]:text-indigo-600"
                                        dangerouslySetInnerHTML={{ __html: data.html }} />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <label htmlFor="test-address" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">
                                    Send yourself a test
                                </label>
                                <div className="flex flex-col sm:flex-row gap-2">
                                    <input id="test-address" type="email" value={testAddress}
                                        onChange={(e) => setTestAddress(e.target.value)}
                                        placeholder="Leave blank to use your own address"
                                        className="flex-1 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600" />
                                    <button onClick={sendTest} disabled={testState === 'sending'}
                                        className="px-5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-2 disabled:opacity-50">
                                        {testState === 'sending' ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />}
                                        Send Test Email
                                    </button>
                                </div>
                                {testMessage && (
                                    <p className={`text-[11px] font-bold ${testState === 'error' ? 'text-rose-600' : 'text-emerald-600'}`}>{testMessage}</p>
                                )}
                                <p className="text-[11px] font-bold text-slate-400">
                                    A test is clearly marked and never goes to a coordinator.
                                </p>
                            </div>
                        </>
                    ) : null}
                </div>

                <div className="px-5 py-4 border-t border-slate-100 dark:border-slate-700 space-y-3">
                    {data && !data.senderReady && (
                        <div className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3">
                            <p className="text-sm font-bold text-amber-800 dark:text-amber-400 flex items-start gap-2">
                                <Lock size={15} className="flex-none mt-0.5" />
                                {data.senderBlockedReason}
                            </p>
                        </div>
                    )}
                    {data && !data.ctaReady && (
                        <div className="rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3">
                            <p className="text-sm font-bold text-amber-800 dark:text-amber-400 flex items-start gap-2">
                                <Lock size={15} className="flex-none mt-0.5" />
                                {data.ctaBlockedReason}
                            </p>
                        </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                        <button onClick={onBack}
                            className="px-5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                            Back to audience
                        </button>
                        <button
                            disabled={!data?.ctaReady || !data?.senderReady}
                            title={data?.ctaReady ? (data?.senderReady ? undefined : data?.senderBlockedReason ?? undefined) : data?.ctaBlockedReason ?? undefined}
                            className="px-5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 disabled:opacity-40 disabled:hover:bg-indigo-600 inline-flex items-center gap-2">
                            <Send size={15} /> Send Seasonal Update
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
