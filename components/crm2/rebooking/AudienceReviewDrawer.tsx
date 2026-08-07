"use client";

/**
 * FR-RETENTION-2 — Audience review ("Who gets this update").
 * Visual source of truth: docs/ai/prototypes/fr_retention_prototype.html (Screen 4).
 *
 * This is the ONE place in the product where a row is an inbox rather than a
 * person. The copy says so plainly, because two coordinators sharing an office
 * address are still two people in the CRM — they have not been merged, and the
 * UI must never suggest they have.
 *
 * Nothing here sends email. "Continue to Email Preview" saves the reviewed
 * audience so a later checkpoint can render exactly what was reviewed.
 *
 * Tenant-safe by construction: the API never returns normalized addresses,
 * recipient ids, preference internals, or database statuses, so there is
 * nothing technical here to leak.
 */

import { useState, useEffect } from 'react';
import { X, Loader2, AlertCircle, Users, CheckCircle2 } from 'lucide-react';

interface AudienceRow {
    key: string;
    displayName: string;
    emailMasked: string | null;
    isSharedInbox: boolean;
    sharedInboxNote: string | null;
    contactNames: string[];
    organizationNames: string[];
    group: 'ready' | 'cant_email' | 'needs_review';
    statusLabel: string;
    reasonText: string | null;
    canResubscribe: boolean;
    canFixContact: boolean;
    resubscribeContactIds: string[];
}

interface Props {
    open: boolean;
    lineupId: string | null;
    lineupName: string;
    onClose: () => void;
    onFinalized: () => void;
}

function statusChipClass(group: AudienceRow['group']) {
    switch (group) {
        case 'ready': return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900';
        case 'needs_review': return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900';
        default: return 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';
    }
}

export function AudienceReviewDrawer({ open, lineupId, lineupName, onClose, onFinalized }: Props) {
    const [rows, setRows] = useState<AudienceRow[]>([]);
    const [counts, setCounts] = useState({ ready: 0, cantEmail: 0, needsReview: 0, organizations: 0 });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // Re-subscribe confirmation — deliberately a two-step action with a
    // required written note, never a one-click reset.
    const [resubTarget, setResubTarget] = useState<AudienceRow | null>(null);
    const [permissionNote, setPermissionNote] = useState('');
    const [resubError, setResubError] = useState<string | null>(null);

    const load = () => {
        if (!lineupId) return;
        setLoading(true);
        setError(null);
        fetch(`/api/rebooking/seasonal-lineups/${lineupId}/audience`, { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load');
                return data;
            })
            .then((data) => {
                setRows(data.rows || []);
                setCounts(data.counts || { ready: 0, cantEmail: 0, needsReview: 0, organizations: 0 });
                setLoading(false);
            })
            .catch((e) => { setError(e.message); setLoading(false); });
    };

    useEffect(() => {
        if (!open || !lineupId) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, lineupId]);

    if (!open) return null;

    const ready = rows.filter((r) => r.group === 'ready');
    const needsReview = rows.filter((r) => r.group === 'needs_review');
    const cantEmail = rows.filter((r) => r.group === 'cant_email');

    const handleContinue = async () => {
        if (!lineupId) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/rebooking/seasonal-lineups/${lineupId}/audience`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { setError(data.error || 'Could not save the audience.'); setSaving(false); return; }
            setSaving(false);
            onFinalized();
        } catch {
            setError('Could not save the audience. Please try again.');
            setSaving(false);
        }
    };

    const handleResubscribe = async () => {
        if (!resubTarget) return;
        if (!permissionNote.trim()) { setResubError('Add a note explaining when and how they gave permission.'); return; }
        setResubError(null);
        try {
            const res = await fetch('/api/rebooking/marketing-preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'resubscribe',
                    contactIds: resubTarget.resubscribeContactIds,
                    permissionNote: permissionNote.trim(),
                }),
            });
            const data = await res.json();
            if (!res.ok) { setResubError((data.errors && data.errors[0]) || data.error || 'Could not re-subscribe.'); return; }
            setResubTarget(null);
            setPermissionNote('');
            load();
        } catch {
            setResubError('Could not re-subscribe. Please try again.');
        }
    };

    const renderRow = (r: AudienceRow) => (
        <div key={r.key} className="px-4 py-3 border-b border-slate-100 dark:border-slate-700/60 last:border-0">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-sm font-black text-slate-900 dark:text-white">
                        {r.displayName}
                        {r.contactNames.length > 1 && (
                            <span className="ml-1.5 text-[10px] font-black uppercase tracking-wide text-violet-600 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
                                {r.contactNames.length} people
                            </span>
                        )}
                        {r.contactNames.length === 1 && r.organizationNames.length > 1 && (
                            <span className="ml-1.5 text-[10px] font-black uppercase tracking-wide text-violet-600 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
                                {r.organizationNames.length} groups
                            </span>
                        )}
                    </p>
                    {r.emailMasked && (
                        <p className="text-[11px] font-bold text-slate-400">{r.emailMasked}</p>
                    )}
                    {r.organizationNames.length > 0 && (
                        <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                            {r.organizationNames.join(' · ')}
                        </p>
                    )}
                    {r.sharedInboxNote && (
                        <p className="text-[11px] font-bold text-violet-600 dark:text-violet-400 mt-0.5">
                            {/* Names are de-duplicated for readability — the counts above
                                still reflect every distinct contact record, so nothing is
                                hidden and nobody has been merged. */}
                            {r.sharedInboxNote} Reaches {Array.from(new Set(r.contactNames)).join(' & ')}.
                        </p>
                    )}
                    {r.reasonText && (
                        <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400 mt-0.5">{r.reasonText}</p>
                    )}
                </div>
                <div className="flex-none flex flex-col items-start sm:items-end gap-1.5">
                    {/* Text label plus a dot — never colour alone. */}
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border ${statusChipClass(r.group)}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                        {r.statusLabel}
                    </span>
                    {r.canResubscribe && (
                        <button
                            onClick={() => { setResubTarget(r); setPermissionNote(''); setResubError(null); }}
                            className="px-3 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-[11px] hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                            Re-subscribe with permission
                        </button>
                    )}
                    {r.canFixContact && (
                        <span className="text-[11px] font-bold text-slate-400">Fix contact info in Rebooking</span>
                    )}
                </div>
            </div>
        </div>
    );

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-sm p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="audience-title"
        >
            <div className="bg-white dark:bg-slate-900 w-full sm:max-w-2xl rounded-t-3xl sm:rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl max-h-[92vh] flex flex-col">

                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                    <div className="min-w-0">
                        <h4 id="audience-title" className="font-black text-slate-900 dark:text-white">Who gets this update</h4>
                        <p className="text-[11px] font-bold text-slate-400">
                            {lineupName} · Step 2 of 4
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close"
                        className="flex-none w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="px-5 py-4 space-y-5 overflow-y-auto">
                    {loading ? (
                        <div className="py-14 text-center text-slate-400 font-bold flex items-center justify-center gap-2">
                            <Loader2 size={18} className="animate-spin" /> Working out who gets this…
                        </div>
                    ) : error ? (
                        <div className="rounded-2xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3">
                            <p className="text-sm font-bold text-rose-700 dark:text-rose-400 flex items-center gap-2">
                                <AlertCircle size={15} /> {error}
                            </p>
                        </div>
                    ) : (
                        <>
                            <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                                Sending to <b className="text-slate-900 dark:text-white">{counts.ready} address{counts.ready === 1 ? '' : 'es'}</b>
                                {counts.organizations > 0 && <> · covering {counts.organizations} organization{counts.organizations === 1 ? '' : 's'}</>}
                            </p>

                            <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
                                    Ready to email · {ready.length}
                                </p>
                                <div className="rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden">
                                    {ready.length === 0
                                        ? <p className="px-4 py-6 text-center text-sm font-bold text-slate-400">No one is ready to email yet.</p>
                                        : ready.map(renderRow)}
                                </div>
                            </div>

                            {needsReview.length > 0 && (
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
                                        Needs review · {needsReview.length}
                                    </p>
                                    <div className="rounded-2xl border border-slate-100 dark:border-slate-700 overflow-hidden">
                                        {needsReview.map(renderRow)}
                                    </div>
                                </div>
                            )}

                            {cantEmail.length > 0 && (
                                <details className="rounded-2xl border border-slate-200 dark:border-slate-700">
                                    <summary className="px-4 py-3 min-h-[44px] flex items-center text-sm font-black text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                                        {cantEmail.length} not receiving this — see why
                                    </summary>
                                    <div className="border-t border-slate-100 dark:border-slate-700">
                                        {cantEmail.map(renderRow)}
                                    </div>
                                </details>
                            )}
                        </>
                    )}
                </div>

                <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-100 dark:border-slate-700">
                    <button
                        onClick={onClose}
                        className="px-5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                        Back
                    </button>
                    <button
                        onClick={handleContinue}
                        disabled={loading || saving || counts.ready === 0}
                        className="px-5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 disabled:opacity-40 disabled:hover:bg-indigo-600 inline-flex items-center gap-2"
                    >
                        {saving && <Loader2 size={15} className="animate-spin" />}
                        Continue to Email Preview
                    </button>
                </div>
            </div>

            {/* Re-subscribe confirmation — permission note required. */}
            {resubTarget && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4" role="dialog" aria-modal="true" aria-labelledby="resub-title">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4">
                        <h5 id="resub-title" className="font-black text-slate-900 dark:text-white">
                            Re-subscribe {resubTarget.contactNames.join(' & ')}?
                        </h5>
                        <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">
                            Only re-subscribe if they gave you permission. Add a note explaining when and how they gave it.
                        </p>
                        <div className="space-y-1.5">
                            <label htmlFor="resub-note" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">
                                Permission note · required
                            </label>
                            <input
                                id="resub-note"
                                type="text"
                                value={permissionNote}
                                onChange={(e) => setPermissionNote(e.target.value)}
                                placeholder='e.g. "Called the office Aug 4 — asked to get seasonal updates again"'
                                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600"
                            />
                            {resubError && <p className="text-[11px] font-bold text-rose-600">{resubError}</p>}
                        </div>
                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={() => { setResubTarget(null); setResubError(null); }}
                                className="px-5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleResubscribe}
                                className="px-5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700"
                            >
                                Re-subscribe
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
