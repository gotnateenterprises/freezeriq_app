'use client';

/**
 * FR-ACCEPTANCE-1 — actually replying to a new fundraiser inquiry.
 *
 * "Respond to new inquiry" was a derived next-action LABEL rendered as indigo
 * bold text, beside "Mark responded" rendered as a solid dark button. The
 * tenant read the coloured text as the action — reasonably, it is the only
 * thing on the row that looks like one — and found it inert, while the button
 * that did work only recorded that a reply had happened somewhere else.
 *
 * This is the real reply. It reuses the existing authorised send path rather
 * than inventing an email stack. FR-REBOOK-1A moved it from the generic
 * POST /api/email/send — which took the recipient from the browser — to
 * POST /api/opportunities/[id]/respond, which derives the recipient from the
 * opportunity inside this tenant and renders the body server-side. The canonical
 * `lead_intro` template is still the only source of the message.
 *
 * The pattern is the one StartFundraiserWizard established and comments as
 * "user-initiated only, NEVER auto-sent": draft, review, edit, then send.
 * Nothing is sent because a dialog opened, and nothing is marked responded
 * because a dialog opened either.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Mail, Send, X } from 'lucide-react';
import { toast } from 'sonner';

export interface RespondTarget {
    opportunityId: string;
    contactName: string | null;
    contactEmail: string | null;
    organizationName: string;
}

const inputCls =
    'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800';

export function RespondToInquiryDialog({
    target,
    onClose,
    onResponded,
}: {
    target: RespondTarget;
    onClose: () => void;
    /**
     * Records the response. Called ONLY after a real send succeeded.
     * Resolves true when the CRM actually stored it — see the recording gate.
     */
    onResponded: () => Promise<boolean>;
}) {
    // ── FR-REBOOK-1A: the draft comes from the server, and so does the recipient.
    //
    // `to` used to be editable client state seeded from the row, and the send
    // route took it verbatim — its tenant-ownership preflight keys on
    // `customerId`, which this call never sent, so nothing tied the address to
    // the organization being answered. It is now derived server-side from the
    // opportunity's own customer and shown read-only.
    const [to, setTo] = useState<string | null>(null);
    const [subject, setSubject] = useState('');
    const [text, setText] = useState('');
    const [loadingDraft, setLoadingDraft] = useState(true);
    const [draftError, setDraftError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    /** The platform accepted the request but sent nothing — see the truth gate below. */
    const [simulated, setSimulated] = useState(false);
    /** The email is gone; we are waiting to hear whether the CRM stored it. */
    const [recording, setRecording] = useState(false);
    /** The email is gone and the CRM did NOT store it. The worst case, said out loud. */
    const [recordFailed, setRecordFailed] = useState(false);

    // Fetch the canonical draft — the SAME EMAIL_TEMPLATES.lead_intro the
    // automatic acknowledgement renders, with this tenant's brand resolved
    // server-side. Rendering a second copy in the browser would be a template
    // that drifts from the one the platform actually sends.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/opportunities/${target.opportunityId}/respond`, {
                    credentials: 'same-origin',
                });
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                if (!res.ok) {
                    setDraftError(data?.error || 'Could not load the draft.');
                } else {
                    setTo(data?.to ?? null);
                    setSubject(data?.subject ?? '');
                    setText(data?.text ?? '');
                }
            } catch {
                if (!cancelled) setDraftError('Could not load the draft.');
            } finally {
                if (!cancelled) setLoadingDraft(false);
            }
        })();
        return () => { cancelled = true; };
    }, [target.opportunityId]);

    const send = useCallback(async () => {
        if (sending || !subject.trim() || !text.trim()) return;
        setSending(true);
        try {
            // Opportunity-scoped: the recipient is derived from the opportunity's
            // customer inside this tenant. Only what the owner actually edited
            // travels — no recipient, no template key, no identity.
            const res = await fetch(`/api/opportunities/${target.opportunityId}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ subject: subject.trim(), text }),
            });
            const data = await res.json().catch(() => ({}));

            // A failed send must never look like a success. Only a 2xx marks the
            // opportunity as responded — the whole point of this control is that
            // the recorded state matches what actually left the building.
            if (!res.ok) {
                toast.error(data?.error || "We couldn't send that email. Please try again.");
                setSending(false);
                return;
            }

            // ── THE SAFETY-MODE TRUTH GATE ───────────────────────────────────
            //
            // The respond route runs in a safety mode whenever RESEND_API_KEY is
            // absent or EMAIL_LIVE is not 'true'. In that mode it logs, returns
            // HTTP 200 with { mocked: true }, and CONTACTS NO PROVIDER. Nothing
            // reaches the volunteer.
            //
            // A 200 is therefore not evidence that anyone was written to, and
            // marking the lead responded here would put a fact into durable CRM
            // history that never happened — the tenant would later read "we
            // replied on the 19th", stop chasing, and lose the fundraiser to
            // silence. Response time is also a reported funnel metric, so the
            // lie would compound.
            //
            // So a simulated send records NOTHING. The lead stays in New Leads,
            // the tenant can retry once sending is enabled, and if they did in
            // fact reply another way, "I replied elsewhere" is still there and
            // still means exactly what it says.
            if (data?.mocked) {
                setSimulated(true);
                setSending(false);
                return;
            }

            // ── THE RECORDING GATE ───────────────────────────────────────────
            //
            // The email has now left the building. That part is irreversible, so
            // it is stated first and never retracted.
            //
            // Recording it in the CRM is a SECOND, separate thing that can fail
            // on its own — a dropped connection, an expired session, a 500. This
            // used to be fire-and-forget under a screen that already claimed
            // "sent and marked as responded", so a failed save left the tenant
            // certain of something untrue: the lead would sit unanswered on the
            // list while they believed it was handled.
            //
            // The .catch is load-bearing. Without it a throw here would fall into
            // the outer catch and toast "We couldn't send that email" about an
            // email that demonstrably did send.
            setSent(true);
            setRecording(true);
            const recorded = await onResponded().catch(() => false);
            setRecording(false);
            setRecordFailed(!recorded);
        } catch {
            toast.error("We couldn't send that email. Please try again.");
        } finally {
            setSending(false);
        }
    }, [sending, to, target, onResponded]);

    /**
     * Retry ONLY the record step, never the send.
     *
     * Safe to press repeatedly: marking responded is idempotent server-side —
     * the first reply is the one that counts, so a second call cannot move the
     * response clock. What it must never do is send the email again; the
     * recipient has already had it.
     */
    const retryRecord = useCallback(async () => {
        setRecording(true);
        const ok = await onResponded().catch(() => false);
        setRecording(false);
        setRecordFailed(!ok);
    }, [onResponded]);

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
            <div className="my-10 w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900">
                <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                        <h2 className="text-base font-black text-slate-900 dark:text-white">Respond to new inquiry</h2>
                        <p className="text-xs text-slate-500">{target.organizationName}</p>
                    </div>
                    {/* Closing mid-record would hide the one screen that says the
                        save failed, leaving the tenant with a sent email and no
                        idea it was not recorded. */}
                    <button onClick={onClose} disabled={recording} aria-label="Close" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800">
                        <X size={16} />
                    </button>
                </div>

                {simulated ? (
                    /* Nothing was delivered, so nothing is recorded. Said plainly:
                       a tenant who believes a volunteer was emailed will stop
                       chasing the lead. */
                    <div className="space-y-4">
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                            <p className="flex items-center gap-1.5 text-sm font-bold text-amber-800 dark:text-amber-300">
                                <AlertTriangle size={14} /> No email was sent
                            </p>
                            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                                Email sending is switched off for this environment, so nothing reached{' '}
                                {target.contactName || 'this contact'}. This lead has <strong>not</strong> been
                                marked as responded, so it stays on your list to follow up.
                            </p>
                        </div>
                        <p className="text-xs text-slate-500">
                            If you already replied by phone or from your own inbox, use
                            “I replied elsewhere” on the lead instead.
                        </p>
                        <div className="flex justify-end">
                            <button onClick={onClose} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white dark:bg-white dark:text-slate-900">
                                Close
                            </button>
                        </div>
                    </div>
                ) : recording ? (
                    /* The email is gone. We do not yet know whether the CRM kept
                       a record of it, so we claim only the half we can vouch for. */
                    <div className="space-y-4">
                        <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                            <Loader2 className="animate-spin" size={15} />
                            Your response was sent. Recording it in your CRM…
                        </p>
                    </div>
                ) : recordFailed ? (
                    /* The bad case, and the reason this screen exists. The email
                       cannot be unsent, so the first thing said is the thing that
                       cannot be undone — and the instruction not to send again. */
                    <div className="space-y-4">
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                            <p className="flex items-center gap-1.5 text-sm font-bold text-amber-800 dark:text-amber-300">
                                <AlertTriangle size={14} /> Sent, but not recorded
                            </p>
                            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                                Your response reached {target.contactName || 'this contact'} —{' '}
                                <strong>don’t send it again</strong>. FreezerIQ could not save that it
                                happened, so this lead still shows as awaiting a reply.
                            </p>
                        </div>
                        <p className="text-xs text-slate-500">
                            Try recording it again below. If that keeps failing, “I replied elsewhere”
                            on the lead does the same thing.
                        </p>
                        <div className="flex justify-end gap-2">
                            <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold dark:border-slate-700">
                                Close
                            </button>
                            <button
                                onClick={retryRecord}
                                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white dark:bg-white dark:text-slate-900"
                            >
                                Try recording again
                            </button>
                        </div>
                    </div>
                ) : sent ? (
                    <div className="space-y-4">
                        <p className="text-sm text-slate-600 dark:text-slate-300">
                            Your response was sent and this lead is now marked as responded.
                        </p>
                        <div className="flex justify-end">
                            <button onClick={onClose} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white dark:bg-white dark:text-slate-900">
                                Done
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div>
                            <label className="mb-1 block text-xs font-bold text-slate-500">Send to</label>
                            {/* Read-only on purpose. The address is resolved server-side
                                from the organization this opportunity belongs to, so a
                                reply cannot be redirected from the browser. */}
                            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                                {loadingDraft ? 'Loading…' : (to ?? 'No email address on file')}
                            </p>
                            {!loadingDraft && !to && (
                                <p className="mt-1 text-[11px] text-amber-600">
                                    This organization has no email address on file. Add one on their
                                    profile, then reply.
                                </p>
                            )}
                        </div>

                        <div>
                            <label htmlFor="respond-subject" className="mb-1 block text-xs font-bold text-slate-500">Subject</label>
                            <input
                                id="respond-subject"
                                type="text"
                                value={subject}
                                onChange={(e) => setSubject(e.target.value)}
                                disabled={loadingDraft}
                                maxLength={200}
                                className={inputCls}
                            />
                        </div>

                        <div>
                            <label htmlFor="respond-body" className="mb-1 block text-xs font-bold text-slate-500">
                                <span className="inline-flex items-center gap-1.5"><Mail size={12} /> Message</span>
                            </label>
                            {/* The REAL outgoing body, prefilled from the canonical
                                template and editable before it goes. This dialog used to
                                DESCRIBE the message instead of showing it, so the owner
                                could not read or personalise a word of what went out. */}
                            <textarea
                                id="respond-body"
                                value={loadingDraft ? 'Loading your introduction…' : text}
                                onChange={(e) => setText(e.target.value)}
                                disabled={loadingDraft}
                                rows={14}
                                spellCheck
                                className={inputCls + ' text-[13px] leading-relaxed'}
                            />
                            <p className="mt-1 text-[11px] text-slate-400">
                                Your standard fundraiser introduction, ready to personalise. Sent from
                                your business, with replies coming back to you.
                            </p>
                        </div>

                        {draftError && (
                            <p className="rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                                {draftError}
                            </p>
                        )}

                        <div className="flex justify-end gap-2">
                            <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold dark:border-slate-700">
                                Cancel
                            </button>
                            <button
                                onClick={send}
                                disabled={sending || loadingDraft || !to || !subject.trim() || !text.trim()}
                                aria-busy={sending}
                                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                            >
                                {sending ? <Loader2 className="animate-spin" size={15} /> : <Send size={15} />}
                                Send response
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
