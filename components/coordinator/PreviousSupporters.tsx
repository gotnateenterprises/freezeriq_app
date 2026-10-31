'use client';

/**
 * FR-REBOOK-2 — Previous Supporters, in the coordinator portal.
 * PREVIOUS-SUPPORTER-EMAIL-2.0 — choose who, review one email, send each person
 * their own copy.
 *
 * ── WHAT THE COORDINATOR SEES ───────────────────────────────────────────────
 *
 *   1. Choose — the previous supporters, each with a checkbox when they can be
 *      emailed for THIS fundraiser, and why not when they cannot. "Select all"
 *      takes only the ones not yet emailed; a failed send is retried only by
 *      ticking that person on purpose.
 *   2. Review — one subject and one message, in ordinary prose they may rewrite,
 *      above the fundraiser facts FreezerIQ adds to every email (this round's
 *      menu, the deadline, pickup, and the "View Meals & Order" link). The counts
 *      say how many will be emailed and who is not included.
 *   3. Send — an explicit "Send N Individual Emails". Each supporter gets a
 *      separate email addressed only to them, starting with their own first name.
 *
 * Addresses never reach this component: rows carry a masked address and an
 * opaque reference, and the server matches references only inside the audience
 * it recomputes from this coordinator's session.
 */

import { useEffect, useRef, useState } from 'react';
import { Users, Mail, Lock } from 'lucide-react';
import {
    buildInviteSendBody,
    pruneSelection,
    selectAllReady,
    summarizeSelection,
    supporterStatusLabel,
    toggleSelected,
    type SupporterRow,
} from '@/lib/previousSupporterSelection';

interface InvitationFactsView {
    bundleNames: string[];
    deadlineLabel: string | null;
    pickup: { dateLabel: string | null; time: string | null; location: string | null };
}

export interface PreviousSupportersPayload {
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
        emailedThisFundraiser?: number;
    };
    supporters: SupporterRow[];
    truncated: boolean;
    invitation?: { open: boolean; code: string; reason: string };
    draft: {
        subject: string;
        text: string;
        orderUrl: string | null;
        deadlineLabel: string | null;
        facts?: InvitationFactsView | null;
    };
    send: { canSend: boolean; code: string; reason: string };
}

export interface SendResult {
    accepted: number;
    failed: number;
    skipped: number;
    alreadySent: number;
    notSent: { noLongerEligible: number; optedOut: number; noUsableEmail: number; alreadyEmailed: number } | null;
}

type Step = 'choose' | 'review' | 'done';

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
    const [step, setStep] = useState<Step>('choose');
    const [selected, setSelected] = useState<string[]>([]);
    const [subject, setSubject] = useState('');
    const [text, setText] = useState('');
    const [showList, setShowList] = useState(false);
    const [sending, setSending] = useState(false);
    const [result, setResult] = useState<SendResult | null>(null);
    const [sendError, setSendError] = useState<string | null>(null);
    // A second click in the same tick still sees `sending` as false; this does not.
    const inFlight = useRef(false);
    const draftLoaded = useRef(false);

    async function load() {
        try {
            const res = await fetch('/api/coordinator/previous-supporters', { credentials: 'same-origin' });
            if (!res.ok) return;
            const json = (await res.json()) as PreviousSupportersPayload;
            setData(json);
            onAvailability?.(json.counts?.reachable ?? 0);
            setSelected((prev) => pruneSelection(prev, json.supporters ?? []));
            // The draft is the server's, always. The editor starts from it
            // rather than from anything composed in the browser — and a refresh
            // after sending never overwrites what the coordinator has typed.
            if (!draftLoaded.current) {
                draftLoaded.current = true;
                setSubject(json.draft.subject);
                setText(json.draft.text);
            }
        } catch { /* the card simply does not appear */ }
    }

    useEffect(() => {
        let alive = true;
        (async () => {
            await load();
            if (alive) setLoading(false);
        })();
        return () => { alive = false; };
    }, []);

    async function send() {
        if (!data?.send.canSend || sending) return;
        if (inFlight.current || selected.length === 0) return;
        inFlight.current = true;
        setSending(true);
        setSendError(null);
        try {
            // The edited subject and message, the ticked references and the
            // confirmation. Who they are, the campaign, the ordering link and the
            // unsubscribe footer are all the server's.
            const res = await fetch('/api/coordinator/previous-supporters', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(buildInviteSendBody({ subject, text, selected })),
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
                notSent: json.notSent ?? null,
            });
            setSelected([]);
            setStep('done');
            await load();
        } catch {
            setSendError('We could not send those invitations.');
        } finally {
            inFlight.current = false;
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

            {data.invitation && !data.invitation.open && data.canInvite && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    {data.invitation.reason}
                </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={() => { setResult(null); setSendError(null); setStep('choose'); setOpen(true); }}
                    disabled={!data.canInvite}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                    <Mail size={14} /> Invite Previous Supporters
                </button>
                {data.supporters.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setShowList((v) => !v)}
                        className="inline-flex min-h-[44px] items-center rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-700 dark:border-slate-700 dark:text-slate-200"
                    >
                        {showList ? 'Hide supporters' : 'View supporters'}
                    </button>
                )}
            </div>

            {showList && <SupporterList rows={data.supporters} truncated={data.truncated} />}

            {open && (
                <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
                    <div role="dialog" aria-modal="true" aria-labelledby="invite-title" className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 sm:rounded-2xl dark:bg-slate-900">
                        <div className="mb-3 flex items-start justify-between gap-3">
                            <h4 id="invite-title" className="text-base font-black text-slate-900 dark:text-slate-100">Invite Previous Supporters</h4>
                            <button onClick={() => setOpen(false)} aria-label="Close" className="min-h-[44px] min-w-[44px] rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
                        </div>

                        <p className="mb-3 text-[12px] text-slate-500 dark:text-slate-400">
                            {c.reachable} previous {c.reachable === 1 ? 'supporter' : 'supporters'} can be invited by email.
                            {' '}Each one gets their own email, addressed only to them — nobody sees anyone else&rsquo;s address.
                        </p>

                        {step === 'choose' && (
                            <ChooseStep
                                rows={data.supporters}
                                selected={selected}
                                truncated={data.truncated}
                                invitationReason={data.invitation && !data.invitation.open ? data.invitation.reason : null}
                                onToggle={(ref) => setSelected((prev) => toggleSelected(prev, ref, data.supporters))}
                                onSelectAll={() => setSelected(selectAllReady(data.supporters))}
                                onClear={() => setSelected([])}
                                onClose={() => setOpen(false)}
                                onNext={() => setStep('review')}
                            />
                        )}

                        {step === 'review' && (
                            <div className="space-y-4">
                                <SelectionCounts selected={selected} rows={data.supporters} />

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
                                    <label htmlFor="invite-body" className="mb-1 block text-xs font-bold text-slate-500">Your message</label>
                                    <p className="mb-1 text-[11px] text-slate-400">Each email starts with &ldquo;Hi&rdquo; and that supporter&rsquo;s first name.</p>
                                    {/* Plain prose. The coordinator never sees a tag,
                                        an entity or a template placeholder, and the
                                        server — not this box — renders the email. */}
                                    <textarea
                                        id="invite-body"
                                        value={text}
                                        onChange={(e) => setText(e.target.value)}
                                        rows={6}
                                        spellCheck
                                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] leading-relaxed dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                                    />
                                </div>

                                <FundraiserFacts facts={data.draft.facts ?? null} orderUrl={data.draft.orderUrl} />

                                {sendError && (
                                    <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                                        {sendError}
                                    </p>
                                )}

                                {!data.send.canSend && (
                                    <div className="rounded-xl bg-amber-50 p-3 dark:bg-amber-950/40">
                                        <p className="flex items-start gap-2 text-[13px] font-semibold text-amber-900 dark:text-amber-200">
                                            <Lock size={14} className="mt-0.5 shrink-0" />
                                            {data.send.reason}
                                        </p>
                                    </div>
                                )}

                                <div className="flex flex-wrap justify-end gap-2">
                                    <button onClick={() => setStep('choose')} className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                                        Back
                                    </button>
                                    <button
                                        type="button"
                                        onClick={send}
                                        disabled={!data.send.canSend || sending || !subject.trim() || !text.trim() || selected.length === 0}
                                        title={data.send.reason}
                                        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                                    >
                                        {sending ? 'Sending…' : `Send ${selected.length} Individual Email${selected.length === 1 ? '' : 's'}`}
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 'done' && result && (
                            <div className="space-y-4">
                                {/* The result the SERVER achieved, never the audience
                                    count. "Sent" is what the email service accepted,
                                    which is not the same as delivered. */}
                                <div aria-live="polite" className="rounded-xl bg-emerald-50 p-3 dark:bg-emerald-950/40">
                                    <p className="text-[13px] font-bold text-emerald-900 dark:text-emerald-200">
                                        {result.accepted} invitation{result.accepted === 1 ? '' : 's'} sent.
                                    </p>
                                    <SendResultDetail result={result} />
                                    <p className="mt-2 text-[11px] text-emerald-900/70 dark:text-emerald-200/70">
                                        &ldquo;Sent&rdquo; means our email service accepted it. We can&rsquo;t confirm it reached the inbox.
                                    </p>
                                </div>
                                <div className="flex justify-end">
                                    <button onClick={() => setOpen(false)} className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                                        Done
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Hookless pieces (each renders from props alone) ──────────────────────────

/** Read-only list on the card: who supported before and where each stands for this fundraiser. */
export function SupporterList({ rows, truncated }: { rows: SupporterRow[]; truncated: boolean }) {
    return (
        <ul className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            {rows.map((s, i) => (
                <li key={s.ref ?? `row-${i}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-[13px]">
                    <span className="min-w-0 break-words font-semibold text-slate-800 dark:text-slate-200">{s.name}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                        {/* Masked, never the full address — a coordinator
                            needs to recognise people, not harvest them. */}
                        {s.emailMasked ? `${s.emailMasked} · ` : ''}
                        {supporterStatusLabel(s)}
                        {s.orderCount > 1 ? ` · ${s.orderCount} orders` : ''}
                    </span>
                </li>
            ))}
            {truncated && (
                <li className="px-3 py-2 text-xs text-slate-500">…and more</li>
            )}
        </ul>
    );
}

export function ChooseStep(props: {
    rows: SupporterRow[];
    selected: string[];
    truncated: boolean;
    invitationReason: string | null;
    onToggle: (ref: string) => void;
    onSelectAll: () => void;
    onClear: () => void;
    onClose: () => void;
    onNext: () => void;
}) {
    const readyCount = selectAllReady(props.rows).length;
    const anySelectable = props.rows.some((r) => r.selectable);
    return (
        <div className="space-y-3">
            {props.invitationReason && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                    {props.invitationReason}
                </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={props.onSelectAll}
                    disabled={readyCount === 0}
                    className="min-h-[44px] rounded-lg border border-indigo-200 px-3 py-2 text-[13px] font-bold text-indigo-700 disabled:opacity-50 dark:border-indigo-800 dark:text-indigo-300"
                >
                    Select all not yet emailed ({readyCount})
                </button>
                <button
                    type="button"
                    onClick={props.onClear}
                    disabled={props.selected.length === 0}
                    className="min-h-[44px] rounded-lg border border-slate-200 px-3 py-2 text-[13px] font-bold text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300"
                >
                    Clear
                </button>
                <span aria-live="polite" className="text-[12px] font-semibold text-slate-500">{props.selected.length} selected</span>
            </div>

            <ul role="group" aria-label="Previous supporters" className="max-h-[45vh] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                {props.rows.map((s, i) => {
                    const id = `ps-${s.ref ?? `x${i}`}`;
                    const checked = !!s.ref && props.selected.includes(s.ref);
                    return (
                        <li key={id} className="px-3 py-2">
                            <label htmlFor={id} className={`flex min-h-[44px] items-start gap-3 ${s.selectable ? 'cursor-pointer' : 'opacity-60'}`}>
                                <input
                                    id={id}
                                    type="checkbox"
                                    className="mt-1 h-5 w-5 shrink-0"
                                    checked={checked}
                                    disabled={!s.selectable || !s.ref}
                                    onChange={() => { if (s.ref) props.onToggle(s.ref); }}
                                />
                                <span className="min-w-0">
                                    <span className="block break-words text-[13px] font-semibold text-slate-800 dark:text-slate-200">{s.name}</span>
                                    <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                                        {s.emailMasked ? `${s.emailMasked} · ` : ''}
                                        {s.orderCount > 1 ? `ordered ${s.orderCount} times before · ` : 'ordered before · '}
                                        {supporterStatusLabel(s)}
                                    </span>
                                </span>
                            </label>
                        </li>
                    );
                })}
                {props.truncated && <li className="px-3 py-2 text-xs text-slate-500">…and more</li>}
            </ul>

            <div className="flex flex-wrap justify-end gap-2">
                <button onClick={props.onClose} className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-bold text-slate-600 dark:text-slate-300">
                    Close
                </button>
                <button
                    type="button"
                    onClick={props.onNext}
                    disabled={!anySelectable || props.selected.length === 0}
                    className="min-h-[44px] rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                >
                    Review email
                </button>
            </div>
        </div>
    );
}

export function SelectionCounts({ selected, rows }: { selected: string[]; rows: SupporterRow[] }) {
    const s = summarizeSelection(selected, rows);
    return (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <p className="font-bold">{s.selected} {s.selected === 1 ? 'supporter' : 'supporters'} selected · {s.ready} ready to email</p>
            {s.notIncluded.length > 0 && (
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    Not included: {s.notIncluded.map((n) => `${n.count} ${n.label}`).join(' · ')}
                </p>
            )}
        </div>
    );
}

/** The parts FreezerIQ adds to every email — shown, not editable. */
export function FundraiserFacts({ facts, orderUrl }: { facts: InvitationFactsView | null; orderUrl: string | null }) {
    const pickup = facts ? [facts.pickup.dateLabel, facts.pickup.time, facts.pickup.location].filter(Boolean) : [];
    return (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">Added to every email by FreezerIQ</p>
            {facts && facts.bundleNames.length > 0 && (
                <div className="mb-1">
                    <p>This round we&rsquo;re offering:</p>
                    <ul className="list-disc pl-5">
                        {facts.bundleNames.map((n, i) => <li key={`${n}-${i}`} className="break-words">{n}</li>)}
                    </ul>
                </div>
            )}
            {facts?.deadlineLabel && <p className="mb-1">Ordering ends: <b>{facts.deadlineLabel}</b></p>}
            {pickup.length > 0 && (
                <p className="mb-1 break-words">Pickup: <b>{pickup.join(' · ')}</b></p>
            )}
            {orderUrl && (
                <div className="mt-2">
                    <p className="text-[11px] font-bold text-slate-500">Current fundraiser · View Meals &amp; Order</p>
                    <p className="break-all">{orderUrl}</p>
                    <p className="mt-1 text-[11px] text-slate-400">
                        Every email gets a &ldquo;View Meals &amp; Order&rdquo; button to your current fundraiser — you
                        don&rsquo;t need to type or paste it.
                    </p>
                </div>
            )}
        </div>
    );
}

export function SendResultDetail({ result }: { result: SendResult }) {
    const n = result.notSent;
    const optedOut = result.skipped + (n?.optedOut ?? 0);
    const already = result.alreadySent + (n?.alreadyEmailed ?? 0);
    const bits = [
        result.failed > 0 ? `${result.failed} could not be sent` : null,
        optedOut > 0 ? `${optedOut} skipped — opted out` : null,
        already > 0 ? `${already} already had this invitation` : null,
        (n?.noUsableEmail ?? 0) > 0 ? `${n!.noUsableEmail} skipped — no usable email address` : null,
        (n?.noLongerEligible ?? 0) > 0 ? `${n!.noLongerEligible} skipped — no longer on the list` : null,
    ].filter(Boolean);
    if (bits.length === 0) return null;
    return (
        <p className="mt-1 text-[12px] text-emerald-900/80 dark:text-emerald-200/80">{bits.join(' · ')}</p>
    );
}

export default PreviousSupporters;
