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
 * than inventing an email stack: POST /api/email/send is session-authenticated,
 * resolves a tenant-branded sender through getTenantSender(), and already ships
 * a `lead_intro` template written for exactly this moment. Six production
 * surfaces already call it.
 *
 * The pattern is the one StartFundraiserWizard established and comments as
 * "user-initiated only, NEVER auto-sent": draft, review, edit, then send.
 * Nothing is sent because a dialog opened, and nothing is marked responded
 * because a dialog opened either.
 */

import { useCallback, useState } from 'react';
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
    const [to, setTo] = useState(target.contactEmail ?? '');
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    /** The platform accepted the request but sent nothing — see the truth gate below. */
    const [simulated, setSimulated] = useState(false);
    /** The email is gone; we are waiting to hear whether the CRM stored it. */
    const [recording, setRecording] = useState(false);
    /** The email is gone and the CRM did NOT store it. The worst case, said out loud. */
    const [recordFailed, setRecordFailed] = useState(false);

    const send = useCallback(async () => {
        if (sending || !to.trim()) return;
        setSending(true);
        try {
            const res = await fetch('/api/email/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    to: to.trim(),
                    // The existing lead-response template. The server fills subject
                    // and body from it and signs with this tenant's sender identity.
                    template: 'lead_intro',
                    customerName: target.contactName ?? '',
                    organizationName: target.organizationName,
                }),
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
            // /api/email/send runs in a safety mode whenever RESEND_API_KEY is
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
                            <label htmlFor="respond-to" className="mb-1 block text-xs font-bold text-slate-500">Send to</label>
                            <input
                                id="respond-to"
                                type="email"
                                value={to}
                                onChange={(e) => setTo(e.target.value)}
                                placeholder="name@organization.org"
                                className={inputCls}
                            />
                            {!target.contactEmail && (
                                <p className="mt-1 text-[11px] text-amber-600">
                                    This inquiry has no email address on file. Enter one to reply.
                                </p>
                            )}
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
                            <p className="mb-1 flex items-center gap-1.5 font-bold text-slate-700 dark:text-slate-200">
                                <Mail size={12} /> Your standard fundraiser introduction
                            </p>
                            <p>
                                Sends your saved introduction — how the fundraiser works and an
                                invitation to pick a preferred date and a backup — from your
                                business, with replies coming back to you. It quotes no percentage;
                                what the organization keeps is settled when you confirm the date.
                            </p>
                        </div>

                        <div className="flex justify-end gap-2">
                            <button onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold dark:border-slate-700">
                                Cancel
                            </button>
                            <button
                                onClick={send}
                                disabled={sending || !to.trim()}
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
