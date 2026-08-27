'use client';

/**
 * FR-REBOOK-2 — Previous Supporters, in the coordinator portal.
 *
 * ── WHAT THE COORDINATOR SEES ───────────────────────────────────────────────
 *
 * The real invitation, in ordinary prose, in an editable box — not a description
 * of an email and not "your standard supporter invitation". FR-REBOOK-1A already
 * established why: you cannot personalise a message you are not shown.
 *
 * The audience is a COUNT plus first names, never a To/CC list. One supporter's
 * address is never visible to another, and the coordinator never gets a copyable
 * block of everyone's email.
 *
 * ── THE HONEST DISABLED BUTTON ──────────────────────────────────────────────
 *
 * Sending is not armed yet, and the card says so in the same words the server
 * uses rather than hiding the control or pretending it will work. A greyed
 * button with no explanation reads as a bug; a greyed button that says what it
 * is waiting for reads as a decision.
 */

import { useEffect, useState } from 'react';
import { Users, Mail, Lock } from 'lucide-react';

interface SupporterRow {
    name: string;
    emailMasked: string | null;
    orderCount: number;
    reachable: boolean;
    exclusionReason: string | null;
}

interface PreviousSupportersPayload {
    headline: string;
    detail: string | null;
    canInvite: boolean;
    counts: {
        supporters: number;
        reachable: number;
        noEmail: number;
        suppressed: number;
        legitimateOrders: number;
        duplicatesCollapsed: number;
    };
    supporters: SupporterRow[];
    truncated: boolean;
    draft: { subject: string; text: string; orderUrl: string | null; deadlineLabel: string | null };
    send: { canSend: boolean; code: string; reason: string };
}

interface SendResult {
    accepted: number;
    failed: number;
    skipped: number;
    alreadySent: number;
}

export function PreviousSupporters({ onAvailability }: {
    /**
     * FR-COORD-123 (additive, optional): reports the reachable audience size
     * so the Easy-as-1-2-3 card can offer "Invite previous supporters" as a
     * Step-2 channel without fetching this endpoint a second time. Purely
     * presentational — the send contract, audience authority and canSend all
     * remain exactly the FR-REBOOK-2 server's.
     */
    onAvailability?: (reachable: number) => void;
} = {}) {
    const [data, setData] = useState<PreviousSupportersPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [open, setOpen] = useState(false);
    const [subject, setSubject] = useState('');
    const [text, setText] = useState('');
    const [showList, setShowList] = useState(false);
    const [sending, setSending] = useState(false);
    const [result, setResult] = useState<SendResult | null>(null);
    const [sendError, setSendError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch('/api/coordinator/previous-supporters', { credentials: 'same-origin' });
                if (!res.ok) { if (alive) setLoading(false); return; }
                const json = (await res.json()) as PreviousSupportersPayload;
                if (!alive) return;
                setData(json);
                onAvailability?.(json.counts?.reachable ?? 0);
                // The draft is the server's, always. The editor starts from it
                // rather than from anything composed in the browser.
                setSubject(json.draft.subject);
                setText(json.draft.text);
            } catch { /* the card simply does not appear */ }
            finally { if (alive) setLoading(false); }
        })();
        return () => { alive = false; };
    }, []);

    async function send() {
        if (!data?.send.canSend || sending) return;
        setSending(true);
        setSendError(null);
        try {
            // Only the two edited strings travel. The recipients, the campaign,
            // the ordering link and the unsubscribe footer are all the server's.
            const res = await fetch('/api/coordinator/previous-supporters', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ subject: subject.trim(), text }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok) {
                setSendError(json?.error || json?.reason || 'We could not send those invitations.');
                return;
            }
            // Whatever the server actually achieved — never the audience count.
            setResult({
                accepted: json.accepted ?? 0,
                failed: json.failed ?? 0,
                skipped: json.skipped ?? 0,
                alreadySent: json.alreadySent ?? 0,
            });
        } catch {
            setSendError('We could not send those invitations.');
        } finally {
            setSending(false);
        }
    }

    if (loading || !data) return null;
    // An organization with no history at all gets no card rather than an empty
    // one — there is nothing yet to tell them about.
    if (data.counts.supporters === 0) return null;

    const c = data.counts;

    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-start gap-3">
                <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950">
                    <Users size={18} />
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-black text-slate-900 dark:text-slate-100">Previous Supporters</h3>
                    <p className="mt-0.5 text-[13px] font-semibold text-slate-700 dark:text-slate-300">{data.headline}</p>
                    {data.detail && (
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{data.detail}</p>
                    )}
                </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    disabled={!data.canInvite}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                    <Mail size={14} /> Invite Previous Supporters
                </button>
                {data.supporters.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setShowList((v) => !v)}
                        className="inline-flex min-h-[40px] items-center rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200"
                    >
                        {showList ? 'Hide supporters' : 'View supporters'}
                    </button>
                )}
            </div>

            {showList && (
                <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                    {data.supporters.map((s, i) => (
                        <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                            <span className="min-w-0 truncate font-semibold text-slate-800 dark:text-slate-200">{s.name}</span>
                            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                                {/* Masked, never the full address — a coordinator
                                    needs to recognise people, not harvest them. */}
                                {s.emailMasked
                                    ?? (s.exclusionReason === 'unsubscribed' ? 'opted out' : 'no email on file')}
                                {s.orderCount > 1 ? ` · ${s.orderCount} orders` : ''}
                            </span>
                        </li>
                    ))}
                    {data.truncated && (
                        <li className="px-3 py-2 text-xs text-slate-500">…and more</li>
                    )}
                </ul>
            )}

            {open && (
                <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
                    <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl dark:bg-slate-900">
                        <div className="mb-3 flex items-start justify-between gap-3">
                            <h4 className="text-base font-black text-slate-900 dark:text-slate-100">Invite Previous Supporters</h4>
                            <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="mb-1 block text-xs font-bold text-slate-500">To</label>
                                {/* A COUNT, not an address list. Nobody's email is
                                    exposed to anybody else, and there is nothing
                                    here to copy out. */}
                                <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                    {c.reachable} previous {c.reachable === 1 ? 'supporter' : 'supporters'}
                                    {c.noEmail > 0 || c.suppressed > 0 ? (
                                        <span className="block text-[11px] font-normal text-slate-500">
                                            {[c.noEmail > 0 ? `${c.noEmail} have no email address` : null,
                                            c.suppressed > 0 ? `${c.suppressed} opted out` : null]
                                                .filter(Boolean).join(' · ')} — they will not be contacted.
                                        </span>
                                    ) : null}
                                </p>
                            </div>

                            <div>
                                <label htmlFor="invite-subject" className="mb-1 block text-xs font-bold text-slate-500">Subject</label>
                                <input
                                    id="invite-subject"
                                    type="text"
                                    value={subject}
                                    onChange={(e) => setSubject(e.target.value)}
                                    maxLength={200}
                                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                />
                            </div>

                            <div>
                                <label htmlFor="invite-body" className="mb-1 block text-xs font-bold text-slate-500">Message</label>
                                {/* Plain prose. The coordinator never sees a tag,
                                    an entity or a template placeholder, and the
                                    server — not this box — renders the email. */}
                                <textarea
                                    id="invite-body"
                                    value={text}
                                    onChange={(e) => setText(e.target.value)}
                                    rows={12}
                                    spellCheck
                                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] leading-relaxed dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                />
                                <p className="mt-1 text-[11px] text-slate-400">
                                    Edit this freely — add what the fundraiser supports, or a personal thank-you.
                                    {data.draft.deadlineLabel
                                        ? ` The order deadline (${data.draft.deadlineLabel}) comes from your campaign; changing it here only changes the email.`
                                        : ''}
                                </p>
                            </div>

                            {data.draft.orderUrl && (
                                <div>
                                    <label className="mb-1 block text-xs font-bold text-slate-500">Current fundraiser · Order Online</label>
                                    <p className="break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                        {data.draft.orderUrl}
                                    </p>
                                    <p className="mt-1 text-[11px] text-slate-400">
                                        FreezerIQ adds this &ldquo;Order Online&rdquo; button to the email for you. It always
                                        points at your current fundraiser — you don&rsquo;t need to type or paste it.
                                    </p>
                                </div>
                            )}

                            {/* The result the SERVER achieved, never the audience
                                count. "Accepted" is what the email service took,
                                which is not the same as delivered. */}
                            {result && (
                                <div className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950/40">
                                    <p className="text-[13px] font-bold text-emerald-900 dark:text-emerald-200">
                                        {result.accepted} invitation{result.accepted === 1 ? '' : 's'} sent.
                                    </p>
                                    {(result.failed > 0 || result.skipped > 0 || result.alreadySent > 0) && (
                                        <p className="mt-1 text-[12px] text-emerald-900/80 dark:text-emerald-200/80">
                                            {[
                                                result.failed > 0 ? `${result.failed} could not be sent` : null,
                                                result.skipped > 0 ? `${result.skipped} had unsubscribed` : null,
                                                result.alreadySent > 0 ? `${result.alreadySent} already had this invitation` : null,
                                            ].filter(Boolean).join(' · ')}
                                        </p>
                                    )}
                                </div>
                            )}

                            {sendError && (
                                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                                    {sendError}
                                </p>
                            )}

                            {!data.send.canSend && !result && (
                                <div className="rounded-xl bg-amber-50 p-3 dark:bg-amber-950/40">
                                    <p className="flex items-start gap-2 text-[13px] font-semibold text-amber-900 dark:text-amber-200">
                                        <Lock size={14} className="mt-0.5 shrink-0" />
                                        {data.send.reason}
                                    </p>
                                </div>
                            )}

                            <div className="flex justify-end gap-2">
                                <button onClick={() => setOpen(false)} className="rounded-lg px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                                    {result ? 'Done' : 'Close'}
                                </button>
                                {!result && (
                                    <button
                                        type="button"
                                        onClick={send}
                                        disabled={!data.send.canSend || sending || !subject.trim() || !text.trim()}
                                        title={data.send.reason}
                                        className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                                    >
                                        {sending ? 'Sending…' : `Send ${c.reachable} invitation${c.reachable === 1 ? '' : 's'}`}
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default PreviousSupporters;
