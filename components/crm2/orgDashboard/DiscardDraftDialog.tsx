"use client";

/**
 * FR-ORG-DASHBOARD-1A — the confirmation for discarding an empty planning draft.
 *
 * The copy is the owner's, and it is only ever shown for a draft the server
 * already proved empty (lib/opportunityDraftDiscard.ts), so every sentence in it
 * is literally true when it appears. The route re-proves it before deleting.
 */

import { Trash2 } from 'lucide-react';
import { useDialogFocus } from '@/components/crm2/useDialogFocus';

export function DiscardDraftDialog({
    open,
    organizationName,
    busy,
    error,
    onCancel,
    onConfirm,
}: {
    open: boolean;
    organizationName: string;
    busy: boolean;
    error: string | null;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const { panelRef, containTab } = useDialogFocus(open);
    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
            onKeyDown={(e) => {
                if (e.key === 'Escape' && !busy) { onCancel(); return; }
                containTab(e);
            }}
        >
            <div
                ref={panelRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="discard-draft-title"
                aria-describedby="discard-draft-body"
                className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl focus:outline-none sm:p-8 dark:bg-slate-900"
            >
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
                    <Trash2 size={18} aria-hidden="true" />
                </div>
                <h2 id="discard-draft-title" className="text-xl font-black text-slate-900 dark:text-white">
                    Discard draft fundraiser?
                </h2>
                <p id="discard-draft-body" className="mt-2 text-sm font-medium leading-relaxed text-slate-600 dark:text-slate-300">
                    This removes this empty planning draft from your working fundraiser list. No campaign or supporter orders have been created.
                </p>
                <p className="mt-3 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {organizationName} stays in your organizations, with its history unchanged.
                </p>
                {error && (
                    <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-3.5 py-2 text-xs font-bold text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                        {error}
                    </p>
                )}
                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={busy}
                        className="inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-rose-600 px-4 text-xs font-black text-white transition-colors hover:bg-rose-700 disabled:cursor-wait disabled:opacity-60"
                    >
                        <Trash2 size={14} aria-hidden="true" />
                        {busy ? 'Discarding…' : 'Discard draft'}
                    </button>
                </div>
            </div>
        </div>
    );
}
