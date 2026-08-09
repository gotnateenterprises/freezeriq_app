"use client";

/**
 * FR-RETENTION-4 — Review request (Screen 11).
 * Visual source of truth: docs/ai/prototypes/fr_retention_prototype.html.
 *
 * THE RULE THIS SCREEN IS BUILT AROUND: bulk approval changes STATUS ONLY.
 * Campaigns are created one at a time, in Checkpoint 5, through the fundraiser
 * wizard. Nothing here creates a fundraiser, a coordinator login, or a schedule,
 * and the copy never implies otherwise.
 *
 * "Not this season" closes this request only. It does not unsubscribe anyone and
 * does not affect future seasonal updates — the button says so, because a tenant
 * who believes otherwise will avoid using it.
 */

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, AlertCircle, Check, Pencil, History, Rocket, ExternalLink } from 'lucide-react';

type OppStatus = 'interested' | 'approved' | 'needs_review' | 'canceled' | 'converted';

export interface RequestOrg {
    id: string;
    name: string;
    status: OppStatus;
    isFirstFundraiser: boolean;
    coordinatorIntent: 'yes' | 'no' | 'not_sure';
    coordinatorName: string | null;
    coordinatorEmail: string | null;
    preferredStartDate: string | null;
    alternateStartDate: string | null;
    participantEstimate: number | null;
    canceledAt: string | null;
    reopenedAt: string | null;
    /** FR-RETENTION-5: set once this organization has become a fundraiser. */
    campaignId: string | null;
    fundraiserHref: string | null;
}

export interface RequestRevision {
    revisionNumber: number;
    submittedAt: string;
    preferredStartDate: string | null;
    preferredEndDate: string | null;
    alternateStartDate: string | null;
    participantEstimate: number | null;
    notes: string | null;
    selectedOrganizations: string[];
    notSelectedOrganizations: string[];
}

export interface RebookingRequest {
    id: string;
    lineupName: string;
    /** The PERSON, or "A + 2 others" for a shared inbox. Never a bare address. */
    respondentName: string;
    respondentContactNames: string[];
    respondentEmailMasked: string | null;
    isSharedInbox: boolean;
    revisionNumber: number;
    submittedAt: string;
    wasEdited: boolean;
    details: {
        preferredStartDate: string | null;
        alternateStartDate: string | null;
        preferredEndDate: string | null;
        participantEstimate: number | null;
        notes: string | null;
    } | null;
    contactCorrection: { name: string | null; email: string | null; phone: string | null } | null;
    /** Every earlier revision, newest first. Empty on a first submission. */
    history: RequestRevision[];
    organizations: RequestOrg[];
    needsAction: boolean;
}

const STATUS_LABEL: Record<OppStatus, string> = {
    interested: 'Pending',
    approved: 'Approved',
    needs_review: 'Needs review',
    canceled: 'Not this season',
    converted: 'Fundraiser created',
};

const STATUS_CLASS: Record<OppStatus, string> = {
    interested: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
    approved: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900',
    needs_review: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900',
    canceled: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700',
    converted: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-400 dark:border-indigo-900',
};

/** yyyy-mm-dd rendered without letting a timezone move it a day. */
function day(value: string | null): string {
    if (!value) return '—';
    const d = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function stamp(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ReviewRequestDrawer({
    open, request, onClose, onChanged, onStartFundraiser,
}: {
    open: boolean;
    request: RebookingRequest | null;
    onClose: () => void;
    onChanged: () => void;
    /**
     * FR-RETENTION-5. Passes ONE opportunity id upward. Deliberately not a bulk
     * action: one organization is one fundraiser, and a single button that
     * quietly created three campaigns is exactly the thing this product rule
     * exists to prevent.
     */
    onStartFundraiser: (opportunityId: string) => void;
}) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    // Pre-select exactly what is awaiting a decision, so "Approve selected"
    // starts on the rows the tenant actually came here for.
    useEffect(() => {
        if (!request) return;
        setSelected(new Set(
            request.organizations.filter((o) => o.status === 'interested' || o.status === 'needs_review').map((o) => o.id),
        ));
        setError(null);
        setNote(null);
    }, [request]);

    const approvedCount = useMemo(
        () => request?.organizations.filter((o) => o.status === 'approved').length ?? 0,
        [request],
    );

    if (!open || !request) return null;

    const act = async (action: 'approve' | 'not_this_season' | 'leave_pending', ids: string[]) => {
        if (ids.length === 0) { setError('Choose at least one organization.'); return; }
        setBusy(true); setError(null); setNote(null);
        try {
            const res = await fetch(`/api/rebooking/requests/${request.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, opportunityIds: ids }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                setError(data.error || "That couldn't be saved.");
                return;
            }
            if (Array.isArray(data.skippedConverted) && data.skippedConverted.length > 0) {
                setNote(
                    `${data.skippedConverted.join(', ')} already ${data.skippedConverted.length === 1 ? 'has' : 'have'} a fundraiser — left unchanged.`,
                );
            }
            onChanged();
        } catch {
            setError("That couldn't be saved.");
        } finally {
            setBusy(false);
        }
    };

    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });

    const d = request.details;

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-sm p-0 sm:p-4"
            role="dialog" aria-modal="true" aria-labelledby="review-request-title">
            <div className="bg-white dark:bg-slate-900 w-full sm:max-w-2xl rounded-t-3xl sm:rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl max-h-[92vh] flex flex-col">

                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                    <div className="min-w-0">
                        <h2 id="review-request-title" className="font-black text-slate-900 dark:text-white truncate">
                            {request.respondentName}
                        </h2>
                        <p className="text-[11px] font-bold text-slate-400">
                            {request.lineupName} · submitted {stamp(request.submittedAt)} ·{' '}
                            {request.organizations.length} group{request.organizations.length === 1 ? '' : 's'} requested
                            {request.wasEdited && (
                                <span className="ml-1 text-amber-600">
                                    · updated {request.revisionNumber - 1}{' '}
                                    time{request.revisionNumber === 2 ? '' : 's'} (revision {request.revisionNumber})
                                </span>
                            )}
                        </p>
                        {request.respondentEmailMasked && (
                            <p className="text-[11px] font-bold text-slate-400">{request.respondentEmailMasked}</p>
                        )}
                    </div>
                    <button onClick={onClose} aria-label="Close"
                        className="flex-none w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                        <X size={18} />
                    </button>
                </div>

                <div className="px-5 py-4 space-y-4 overflow-y-auto">

                    {/* What they asked for */}
                    <section className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
                        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400">What they asked for</h3>
                        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            <div>
                                <dt className="text-[11px] font-bold text-slate-400">Preferred</dt>
                                <dd className="text-sm font-black text-slate-900 dark:text-white">
                                    {day(d?.preferredStartDate ?? null)}
                                    {d?.preferredEndDate ? ` → ${day(d.preferredEndDate)}` : ''}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-[11px] font-bold text-slate-400">Alternate</dt>
                                <dd className="text-sm font-black text-slate-900 dark:text-white">{day(d?.alternateStartDate ?? null)}</dd>
                            </div>
                            <div>
                                <dt className="text-[11px] font-bold text-slate-400">Participants</dt>
                                <dd className="text-sm font-black text-slate-900 dark:text-white tabular-nums">
                                    {d?.participantEstimate != null ? `~${d.participantEstimate}` : '—'}
                                </dd>
                            </div>
                        </dl>

                        {d?.notes && (
                            <blockquote className="text-sm font-bold text-slate-600 dark:text-slate-300 border-l-2 border-slate-200 dark:border-slate-700 pl-3">
                                &ldquo;{d.notes}&rdquo;
                            </blockquote>
                        )}

                        {/* A correction is EVIDENCE. Checkpoint 4 shows it; the
                            contact record itself is edited from the contact, so
                            a public form can never rewrite CRM identity. */}
                        {request.contactCorrection && (
                            <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 px-3.5 py-3 space-y-1">
                                <p className="text-[11px] font-black uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
                                    <Pencil size={11} /> Contact correction
                                </p>
                                <ul className="text-sm font-bold text-slate-700 dark:text-slate-200 space-y-0.5">
                                    {request.contactCorrection.name && <li>Name: {request.contactCorrection.name}</li>}
                                    {request.contactCorrection.email && <li>Email: {request.contactCorrection.email}</li>}
                                    {request.contactCorrection.phone && <li>Phone: {request.contactCorrection.phone}</li>}
                                </ul>
                                <p className="text-[11px] font-bold text-slate-400">
                                    Nothing has been changed. Update the contact record from their profile if this is right.
                                </p>
                            </div>
                        )}

                        {/* Only when the inbox genuinely reaches DIFFERENT people.
                            One person who coordinates several organizations has
                            several contact records but is still one person, and
                            warning about them would be noise. */}
                        {request.isSharedInbox && request.respondentContactNames.length > 1 && (
                            <p className="text-[11px] font-bold text-violet-600">
                                This inbox reaches {request.respondentContactNames.join(', ')} — we
                                can&apos;t tell which of them answered.
                            </p>
                        )}
                    </section>

                    {/* History. Revisions are immutable, so this is the record of
                        what was actually said each time — the tenant can see that
                        a group was added or a date moved, rather than only the
                        current state. Collapsed by default; the current answer is
                        what usually matters. */}
                    {request.history.length > 0 && (
                        <details className="rounded-2xl border border-slate-200 dark:border-slate-700">
                            <summary className="px-4 py-3 min-h-[44px] flex items-center gap-2 cursor-pointer text-[12px] font-black uppercase tracking-wide text-slate-500">
                                <History size={13} aria-hidden="true" />
                                Earlier versions ({request.history.length})
                            </summary>
                            <ol className="px-4 pb-4 space-y-3">
                                {request.history.map((h) => (
                                    <li key={h.revisionNumber} className="border-l-2 border-slate-200 dark:border-slate-700 pl-3 space-y-1">
                                        <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">
                                            Revision {h.revisionNumber} · {stamp(h.submittedAt)}
                                        </p>
                                        <p className="text-[12px] font-bold text-slate-600 dark:text-slate-300">
                                            {day(h.preferredStartDate)}
                                            {h.preferredEndDate ? ` → ${day(h.preferredEndDate)}` : ''}
                                            {h.participantEstimate != null ? ` · ~${h.participantEstimate} participants` : ''}
                                        </p>
                                        <p className="text-[12px] font-bold text-slate-600 dark:text-slate-300">
                                            Asked for: {h.selectedOrganizations.length > 0
                                                ? h.selectedOrganizations.join(', ')
                                                : 'no groups'}
                                        </p>
                                        {h.notSelectedOrganizations.length > 0 && (
                                            <p className="text-[12px] font-bold text-slate-400">
                                                Not included: {h.notSelectedOrganizations.join(', ')}
                                            </p>
                                        )}
                                        {h.notes && (
                                            <p className="text-[12px] text-slate-500 italic">&ldquo;{h.notes}&rdquo;</p>
                                        )}
                                    </li>
                                ))}
                            </ol>
                        </details>
                    )}

                    {/* One card per organization */}
                    {request.organizations.map((o) => {
                        const decided = o.status === 'converted';
                        return (
                            <section key={o.id}
                                className={`rounded-2xl border p-4 space-y-3 ${o.status === 'approved'
                                    ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/20'
                                    : 'border-slate-200 dark:border-slate-700'}`}>
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-start gap-1 min-w-0">
                                        {/* The box stays 20px because a giant
                                            checkbox looks wrong; the LABEL around
                                            it carries the 44px touch target, so a
                                            thumb has something to hit. */}
                                        <label className="flex-none -ml-2.5 -mt-2 w-11 h-11 flex items-center justify-center cursor-pointer has-[:disabled]:cursor-default">
                                            <input
                                                type="checkbox"
                                                checked={selected.has(o.id)}
                                                onChange={() => toggle(o.id)}
                                                disabled={decided}
                                                aria-label={`Select ${o.name}`}
                                                className="w-5 h-5 rounded accent-indigo-600 disabled:opacity-40"
                                            />
                                        </label>
                                        <div className="min-w-0 mt-0.5">
                                            <p className="font-black text-slate-900 dark:text-white text-sm truncate">{o.name}</p>
                                            <p className="text-[11px] font-bold text-slate-400">
                                                {o.isFirstFundraiser ? 'First fundraiser' : 'Has run before'}
                                            </p>
                                        </div>
                                    </div>
                                    <span className={`flex-none px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border ${STATUS_CLASS[o.status]}`}>
                                        {STATUS_LABEL[o.status]}
                                    </span>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-slate-500">
                                    <span className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800">{day(o.preferredStartDate)}</span>
                                    <span aria-hidden="true">→</span>
                                    <span className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                                        {day(d?.preferredEndDate ?? null)}
                                    </span>
                                    <span className="text-slate-400">as requested</span>
                                </div>

                                <p className="text-[12px] font-bold text-slate-600 dark:text-slate-300">
                                    Coordinator:{' '}
                                    {o.coordinatorIntent === 'yes'
                                        ? `${request.respondentName} (they said yes)`
                                        : o.coordinatorIntent === 'no'
                                            ? (o.coordinatorName || 'Someone else — name not given')
                                            : 'Not decided yet'}
                                    {o.coordinatorIntent === 'no' && (
                                        <span className="block text-[11px] font-bold text-slate-400 mt-0.5">
                                            Recorded only — no login has been created for them.
                                        </span>
                                    )}
                                </p>

                                {o.status === 'needs_review' && (
                                    <p className="text-[12px] font-bold text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                                        <AlertCircle size={13} className="flex-none mt-0.5" />
                                        They changed this after you approved it. Check the dates before approving again.
                                    </p>
                                )}
                                {o.status === 'canceled' && o.canceledAt && (
                                    <p className="text-[12px] font-bold text-slate-400">Closed {stamp(o.canceledAt)} — history kept.</p>
                                )}
                                {/* FR-RETENTION-5 — converted. "Start Fundraiser"
                                    is gone, not disabled: offering an action that
                                    the server will refuse is worse than not
                                    offering it. */}
                                {o.status === 'converted' && (
                                    <div className="space-y-2">
                                        <p className="text-[12px] font-bold text-indigo-600 inline-flex items-center gap-1.5">
                                            <Check size={13} aria-hidden="true" /> Fundraiser created for this group.
                                        </p>
                                        {o.fundraiserHref && (
                                            <a href={o.fundraiserHref}
                                                className="inline-flex items-center gap-2 px-3.5 min-h-[44px] rounded-xl border border-indigo-200 dark:border-indigo-900 font-bold text-[12px] text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/40">
                                                <ExternalLink size={13} aria-hidden="true" /> Open fundraiser
                                            </a>
                                        )}
                                    </div>
                                )}

                                {/* FR-RETENTION-5 — approved. This does NOT create
                                    anything; it opens the existing wizard with the
                                    request's evidence pre-filled, and the tenant
                                    still confirms every field. */}
                                {o.status === 'approved' && (
                                    <button type="button" onClick={() => onStartFundraiser(o.id)}
                                        className="w-full sm:w-auto px-4 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-[12px] hover:bg-indigo-700 inline-flex items-center justify-center gap-2">
                                        <Rocket size={14} aria-hidden="true" /> Start Fundraiser
                                    </button>
                                )}

                                {!decided && (
                                    <div className="flex flex-wrap gap-2">
                                        <button onClick={() => act('approve', [o.id])} disabled={busy}
                                            className="px-3.5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-[12px] hover:bg-indigo-700 disabled:opacity-50">
                                            Approve
                                        </button>
                                        <button onClick={() => act('leave_pending', [o.id])} disabled={busy}
                                            className="px-3.5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                                            Leave pending
                                        </button>
                                        <button onClick={() => act('not_this_season', [o.id])} disabled={busy}
                                            className="px-3.5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-[12px] hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                                            Not this season
                                        </button>
                                    </div>
                                )}
                            </section>
                        );
                    })}

                    <p className="text-[11px] font-bold text-slate-400">
                        &ldquo;Not this season&rdquo; closes this request only — it won&apos;t unsubscribe {request.respondentName} or
                        affect future updates.
                    </p>

                    <div aria-live="polite" className="space-y-2">
                        {note && (
                            <p className="text-[12px] font-bold text-indigo-600 flex items-start gap-1.5">
                                <Check size={13} className="flex-none mt-0.5" /> {note}
                            </p>
                        )}
                        {error && (
                            <p className="text-[12px] font-bold text-rose-600 flex items-start gap-1.5">
                                <AlertCircle size={13} className="flex-none mt-0.5" /> {error}
                            </p>
                        )}
                    </div>
                </div>

                <div className="px-5 py-4 border-t border-slate-100 dark:border-slate-700 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                    <span className="text-[11px] font-bold text-slate-400">
                        {approvedCount} of {request.organizations.length} approved · approving changes status only
                    </span>
                    <button onClick={() => act('approve', [...selected])} disabled={busy || selected.size === 0}
                        className="px-5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 disabled:opacity-40 inline-flex items-center justify-center gap-2">
                        {busy && <Loader2 size={15} className="animate-spin" />}
                        Approve selected
                    </button>
                </div>
            </div>
        </div>
    );
}
