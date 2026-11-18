'use client';

/**
 * COORDINATOR-EMAIL-REOPEN-1 — a persistent way back to the coordinator setup email.
 *
 * Until now, Review & send lived only inside the launch dialog's success screen. Close that dialog
 * and the fundraiser had no route back to it — which is how Jasper and Clark were left: launched,
 * a pickup time later addable through Edit details, and no way to send the invitation that time
 * unblocked.
 *
 * NO SECOND SEND IMPLEMENTATION. Everything goes through the existing route:
 *   · GET  /api/campaigns/[id]/coordinator-email — renders the email, names its state, writes nothing
 *   · POST /api/campaigns/[id]/coordinator-email — the ONLY sender; its conditional claim is what
 *     makes it one invitation per coordinator, whatever this card shows
 * The POST carries no body: the route reads the recipient from the campaign's own Primary
 * Coordinator, never from the caller.
 *
 * Copy Setup Link builds the same link the route puts in the email (lib/fundraiserUrls), from the
 * access token the Fundraisers list already gives this page for its "Coordinator portal" link.
 * The setup token is never displayed as text.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mail, Send, X, Copy, Check, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { buildCoordinatorAccessUrl } from '@/lib/fundraiserUrls';
import {
    coordinatorEmailCardView,
    outcomeFromSendResponse,
    statusFromPreviewResponse,
    type CoordinatorEmailPreview,
    type CoordinatorEmailStatus,
} from '@/lib/coordinatorSetupEmailView';

const TONE: Record<'neutral' | 'success' | 'warning' | 'error', string> = {
    neutral: 'border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-200',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
    warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    error: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200',
};

const BTN = 'inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50';
const PRIMARY = 'inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-bold text-white hover:bg-indigo-700 transition-colors disabled:opacity-50';

function showToast(t: { level: 'success' | 'info' | 'warning' | 'error' | 'message'; title: string; description?: string }) {
    const opts = t.description ? { description: t.description, duration: t.level === 'warning' ? 12000 : undefined } : undefined;
    if (t.level === 'success') toast.success(t.title, opts);
    else if (t.level === 'info') toast.info(t.title, opts);
    else if (t.level === 'warning') toast.warning(t.title, opts);
    else if (t.level === 'error') toast.error(t.title, opts);
    else toast.message(t.title, opts);
}

export function CoordinatorSetupEmailCard({
    campaignId,
    portalToken,
    knownSentAt,
    onChanged,
}: {
    campaignId: string;
    /** The campaign's coordinator access token, already on the list payload. Absent → no Copy. */
    portalToken?: string | null;
    /** The list payload's provider-confirmed sent timestamp (coordinator_invite_sent_at). */
    knownSentAt?: string | null;
    /** Called after a send attempt changes the invitation's state, so the list can refresh. */
    onChanged?: () => void;
}) {
    const [status, setStatus] = useState<CoordinatorEmailStatus>({ kind: 'loading' });
    const [review, setReview] = useState<CoordinatorEmailPreview | null>(null);
    const [checking, setChecking] = useState(false);
    const [sending, setSending] = useState(false);
    const [copied, setCopied] = useState(false);
    // Only the newest check may write the status, so a slow earlier answer cannot overwrite a newer one.
    const seq = useRef(0);
    // A second click that lands before the button re-renders as disabled is dropped here. The
    // route's claim is still what guarantees one invitation; this only avoids a pointless request.
    const inFlight = useRef(false);

    const url = `/api/campaigns/${encodeURIComponent(campaignId)}/coordinator-email`;

    /** GET only. Never sends, never claims. Returns the status it settled on. */
    const check = async (): Promise<CoordinatorEmailStatus | null> => {
        const mine = ++seq.current;
        setChecking(true);
        try {
            const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
            const body = await res.json().catch(() => ({} as any));
            const next = statusFromPreviewResponse(res.ok, res.status, body, knownSentAt ?? null);
            if (mine !== seq.current) return null;
            setStatus(next);
            return next;
        } catch {
            if (mine !== seq.current) return null;
            const next: CoordinatorEmailStatus = { kind: 'error', message: "Couldn't check the coordinator email. Try again." };
            setStatus(next);
            return next;
        } finally {
            if (mine === seq.current) setChecking(false);
        }
    };

    useEffect(() => {
        setStatus({ kind: 'loading' });
        setReview(null);
        void check();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [campaignId]);

    /** Re-read before showing the email, so a send from another tab is reflected here. */
    const openReview = async () => {
        const next = await check();
        if (!next) return;
        if ((next.kind === 'ready' || next.kind === 'sent' || next.kind === 'unresolved') && next.preview) {
            setReview(next.preview);
        }
    };

    const send = async () => {
        if (sending || inFlight.current) return;
        // Send is rendered only in the `ready` state (reviewCanSend). The route's claim refuses
        // anything else regardless, so there is no second client-side state check here.
        inFlight.current = true;
        setSending(true);
        try {
            // No body, deliberately: the route reads the recipient server-side.
            const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
            const body = await res.json().catch(() => ({} as any));
            const outcome = outcomeFromSendResponse(res.ok, res.status, body);
            showToast(outcome.toast);
            if (outcome.next) {
                seq.current++; // any in-flight check is now older than this answer
                setStatus(outcome.next);
                setReview(null);
            }
            if (outcome.kind !== 'failed' && outcome.kind !== 'mocked') onChanged?.();
        } catch {
            toast.error("We couldn't send that email. Please try again.");
        } finally {
            inFlight.current = false;
            setSending(false);
        }
    };

    const copyLink = async () => {
        if (!portalToken) return;
        try {
            await navigator.clipboard.writeText(buildCoordinatorAccessUrl(null, portalToken));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error('Could not copy the setup link.');
        }
    };

    const view = coordinatorEmailCardView(status);
    const reviewCanSend = view.canSend && status.kind === 'ready';

    return (
        <div className="space-y-2" data-testid="coordinator-setup-email">
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">Coordinator setup email</p>
            <div className={`rounded-2xl border p-4 space-y-3 ${TONE[view.tone]}`}>
                <div aria-live="polite">
                    <p className="flex items-center gap-2 text-sm font-black">
                        {status.kind === 'loading'
                            ? <Loader2 size={14} className="animate-spin flex-none" aria-hidden="true" />
                            : view.tone === 'success'
                                ? <Check size={14} className="flex-none" aria-hidden="true" />
                                : <Mail size={14} className="flex-none" aria-hidden="true" />}
                        {view.headline}
                    </p>
                    {view.detail && <p className="mt-1 text-xs font-medium">{view.detail}</p>}
                </div>

                {(view.canReview || view.canRecheck || (view.canCopyLink && portalToken)) && (
                    <div className="flex flex-wrap gap-2">
                        {view.canReview && (
                            <button type="button" onClick={openReview} disabled={checking} aria-busy={checking}
                                className={view.canSend ? PRIMARY : BTN}>
                                {checking ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Mail size={13} aria-hidden="true" />}
                                {view.canSend ? 'Review coordinator email' : 'Review email'}
                            </button>
                        )}
                        {view.canRecheck && (
                            <button type="button" onClick={() => { void check(); }} disabled={checking} aria-busy={checking} className={BTN}>
                                {checking ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                                Check again
                            </button>
                        )}
                        {view.canCopyLink && portalToken && (
                            <button type="button" onClick={copyLink} className={BTN}>
                                {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                                {copied ? 'Copied' : 'Copy Setup Link'}
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Review before send — the same To / Subject / Message the launch dialog shows. The
                secure link lives only in the message button's href, never as readable text. */}
            {review && (
                <div
                    className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="coordinator-email-review-title"
                    onKeyDown={(e) => {
                        // Escape closes this dialog only, not the drawer underneath it.
                        if (e.key === 'Escape') { e.stopPropagation(); setReview(null); }
                    }}
                >
                    <div className="my-10 w-full max-w-xl rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900">
                        <div className="mb-3 flex items-start justify-between gap-3">
                            <h3 id="coordinator-email-review-title" className="text-base font-black text-slate-900 dark:text-white">
                                Review coordinator email
                            </h3>
                            <button type="button" onClick={() => setReview(null)} aria-label="Close"
                                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                                <X size={16} aria-hidden="true" />
                            </button>
                        </div>

                        <dl className="mb-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-800/60">
                            <div className="flex gap-2">
                                <dt className="w-16 shrink-0 font-bold text-slate-500">To</dt>
                                <dd className="break-all text-slate-700 dark:text-slate-200">{review.to}</dd>
                            </div>
                            <div className="flex gap-2">
                                <dt className="w-16 shrink-0 font-bold text-slate-500">Subject</dt>
                                <dd className="text-slate-700 dark:text-slate-200">{review.subject}</dd>
                            </div>
                        </dl>

                        <p className="mb-1 text-xs font-bold text-slate-500">Message</p>
                        <div
                            className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700"
                            dangerouslySetInnerHTML={{ __html: review.html }}
                        />
                        <p className="mt-2 text-[11px] text-slate-500">
                            The button in this message carries the coordinator&rsquo;s private setup
                            link. It is not shown as text on purpose.
                        </p>
                        {!reviewCanSend && view.detail && (
                            <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
                                {view.headline}. {view.detail}
                            </p>
                        )}

                        <div className="mt-4 flex justify-end gap-2">
                            <button type="button" onClick={() => setReview(null)}
                                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-bold dark:border-slate-700">
                                {reviewCanSend ? 'Cancel' : 'Close'}
                            </button>
                            {reviewCanSend && (
                                <button
                                    type="button"
                                    onClick={send}
                                    disabled={sending}
                                    aria-busy={sending}
                                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                                >
                                    {sending ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
                                    Send Coordinator Email
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
