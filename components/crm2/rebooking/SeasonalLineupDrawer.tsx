"use client";

/**
 * FR-RETENTION-1B-1 — Seasonal Lineup shell.
 * Visual source of truth: docs/ai/prototypes/fr_retention_prototype.html (Screen 3).
 *
 * SCOPE — READ BEFORE EXTENDING:
 * This is a UI-only shell. It exists to establish the shape of the seasonal
 * flow so the next checkpoints have somewhere to land. Deliberately, it:
 *   · sends no email
 *   · calls no API and issues no network request of any kind
 *   · writes nothing to the database and persists nothing anywhere
 *   · holds every value in local component state, discarded on unmount
 *   · never claims an update was sent
 *
 * There is also NO scheduling and NO automatic-send control — not disabled,
 * not greyed out, not "coming soon". Per the approved ruling, the control
 * appears when the feature exists. Nothing here should be read as a promise
 * that a send happened.
 *
 * The bundle area is intentionally an empty placeholder rather than a grid of
 * invented bundle families: showing fabricated tenant data would be worse than
 * showing the shape and letting real selection arrive with the API.
 */

import { useState } from 'react';
import { X, Minus, Plus, CalendarRange } from 'lucide-react';

/** What the shell hands back to the parent for local preview only. */
export interface LineupDraft {
    name: string;
    startsOn: string;
    endsOn: string;
    coordinatorPicks: number;
}

interface Props {
    open: boolean;
    initial: LineupDraft | null;
    onCancel: () => void;
    /** Parent stores this in local state only. Nothing leaves the browser. */
    onSave: (draft: LineupDraft) => void;
}

const MIN_PICKS = 1;
const MAX_PICKS = 6;

export function SeasonalLineupDrawer({ open, initial, onCancel, onSave }: Props) {
    const [name, setName] = useState(initial?.name ?? '');
    const [startsOn, setStartsOn] = useState(initial?.startsOn ?? '');
    const [endsOn, setEndsOn] = useState(initial?.endsOn ?? '');
    const [coordinatorPicks, setCoordinatorPicks] = useState(initial?.coordinatorPicks ?? 2);

    if (!open) return null;

    const canSave = name.trim().length > 0;

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-sm p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="seasonal-lineup-title"
        >
            <div className="bg-white dark:bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl max-h-[92vh] flex flex-col">

                {/* Head */}
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-700">
                    <div className="min-w-0">
                        <h4 id="seasonal-lineup-title" className="font-black text-slate-900 dark:text-white">Seasonal Lineup</h4>
                        <p className="text-[11px] font-bold text-slate-400">Step 1 of 4</p>
                    </div>
                    <button
                        onClick={onCancel}
                        aria-label="Close"
                        className="flex-none w-11 h-11 rounded-xl flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 py-4 space-y-5 overflow-y-auto">

                    <div className="space-y-1.5">
                        <label htmlFor="lineup-name" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">
                            Lineup name
                        </label>
                        <input
                            id="lineup-name"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Fall 2026"
                            className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold text-slate-900 dark:text-white placeholder:text-slate-300 dark:placeholder:text-slate-600"
                        />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <label htmlFor="lineup-starts" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">Starts</label>
                            <input
                                id="lineup-starts"
                                type="date"
                                value={startsOn}
                                onChange={(e) => setStartsOn(e.target.value)}
                                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold text-slate-900 dark:text-white"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <label htmlFor="lineup-ends" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">Ends</label>
                            <input
                                id="lineup-ends"
                                type="date"
                                value={endsOn}
                                onChange={(e) => setEndsOn(e.target.value)}
                                className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold text-slate-900 dark:text-white"
                            />
                        </div>
                    </div>

                    <fieldset className="space-y-2">
                        <legend className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                            Bundles for this season
                        </legend>
                        <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-6 text-center">
                            <CalendarRange size={22} className="mx-auto text-slate-300 mb-2" />
                            <p className="text-sm font-bold text-slate-500">Pick the bundle families for this season.</p>
                            <p className="text-[11px] font-bold text-slate-400 mt-1">Your bundle families will appear here to choose from.</p>
                        </div>
                    </fieldset>

                    <div className="space-y-2">
                        <label className="block text-[11px] font-black uppercase tracking-wide text-slate-500">
                            How many bundles does the coordinator choose?
                        </label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                aria-label="Decrease"
                                onClick={() => setCoordinatorPicks((n) => Math.max(MIN_PICKS, n - 1))}
                                disabled={coordinatorPicks <= MIN_PICKS}
                                className="w-11 h-11 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-center font-black disabled:opacity-40"
                            >
                                <Minus size={16} />
                            </button>
                            <span aria-live="polite" className="min-w-[44px] text-center text-lg font-black tabular-nums text-slate-900 dark:text-white">
                                {coordinatorPicks}
                            </span>
                            <button
                                type="button"
                                aria-label="Increase"
                                onClick={() => setCoordinatorPicks((n) => Math.min(MAX_PICKS, n + 1))}
                                disabled={coordinatorPicks >= MAX_PICKS}
                                className="w-11 h-11 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-center font-black disabled:opacity-40"
                            >
                                <Plus size={16} />
                            </button>
                        </div>
                    </div>

                    <details className="rounded-2xl border border-slate-200 dark:border-slate-700">
                        <summary className="px-4 py-3 min-h-[44px] flex items-center text-sm font-black text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                            Advanced
                        </summary>
                        <div className="px-4 pb-4 space-y-4 border-t border-slate-100 dark:border-slate-700 pt-4">
                            <div className="space-y-1.5">
                                <label htmlFor="lineup-subject" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">Subject override</label>
                                <input
                                    id="lineup-subject"
                                    type="text"
                                    placeholder="Fall 2026 fundraising is open — pick your dates"
                                    className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="lineup-letter" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">Email sales letter</label>
                                <textarea
                                    id="lineup-letter"
                                    rows={3}
                                    placeholder="Uses the standard seasonal letter unless you write your own…"
                                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="lineup-notes" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">Internal notes</label>
                                <input
                                    id="lineup-notes"
                                    type="text"
                                    placeholder="Only you see this"
                                    className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600"
                                />
                            </div>
                        </div>
                    </details>
                </div>

                {/* Foot */}
                <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100 dark:border-slate-700">
                    <button
                        onClick={onCancel}
                        className="px-5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => onSave({ name: name.trim(), startsOn, endsOn, coordinatorPicks })}
                        disabled={!canSave}
                        className="px-5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 disabled:opacity-40 disabled:hover:bg-indigo-600"
                    >
                        Save lineup
                    </button>
                </div>
            </div>
        </div>
    );
}
