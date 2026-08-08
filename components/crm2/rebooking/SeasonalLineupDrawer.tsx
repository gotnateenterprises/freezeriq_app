"use client";

/**
 * FR-RETENTION-2 — Seasonal Lineup.
 * Visual source of truth: docs/ai/prototypes/fr_retention_prototype.html (Screen 3).
 *
 * Now backed by real persistence. The bundle families offered here are the
 * tenant's OWN eligible families, resolved by the CB-4 resolver — never
 * invented placeholders. Saving writes a real lineup the tenant can reopen.
 *
 * Still true, and deliberately so:
 *   · sends no email
 *   · issues no rebooking or coordinator token
 *   · has NO scheduling and NO automatic-send control anywhere — not disabled,
 *     not greyed out, not "coming soon". The control appears when the feature
 *     does.
 */

import { useState, useEffect } from 'react';
import { X, Minus, Plus, CalendarRange, Loader2, AlertCircle } from 'lucide-react';
import { toCalendarInputValue } from '@/lib/calendarDate';

export interface EligibleFamily {
    familyId: string;
    serves5: { name: string; sku: string | null };
    serves2: { name: string; sku: string | null };
}

export interface SavedLineup {
    id: string;
    name: string;
    startsAt: string;
    endsAt: string;
    coordinatorBundleLimit: number;
    familyIds: string[];
    subjectOverride: string | null;
    salesLetter: string | null;
    internalNotes: string | null;
    hasAudience: boolean;
}

interface Props {
    open: boolean;
    /** Existing lineup being reopened, or null to start a new one. */
    initial: SavedLineup | null;
    onCancel: () => void;
    /** Called after the lineup is persisted. */
    onSaved: (lineup: SavedLineup) => void;
}

const MIN_PICKS = 1;

/**
 * yyyy-mm-dd for a date input. Uses the shared calendar-date helper so the
 * value round-trips as the same calendar day regardless of local timezone.
 */
function toDateInput(iso: string | null | undefined): string {
    if (!iso) return '';
    return toCalendarInputValue(new Date(iso));
}

export function SeasonalLineupDrawer({ open, initial, onCancel, onSaved }: Props) {
    const [name, setName] = useState('');
    const [startsOn, setStartsOn] = useState('');
    const [endsOn, setEndsOn] = useState('');
    const [coordinatorPicks, setCoordinatorPicks] = useState(2);
    const [selectedFamilies, setSelectedFamilies] = useState<string[]>([]);
    const [subjectOverride, setSubjectOverride] = useState('');
    const [salesLetter, setSalesLetter] = useState('');
    const [internalNotes, setInternalNotes] = useState('');

    const [families, setFamilies] = useState<EligibleFamily[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState<string[]>([]);

    // Load the tenant's real eligible families, and hydrate a reopened lineup.
    useEffect(() => {
        if (!open) return;
        let alive = true;
        setLoading(true);
        setErrors([]);
        fetch('/api/rebooking/seasonal-lineups', { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load');
                return data;
            })
            .then((data) => {
                if (!alive) return;
                setFamilies(data.eligibleFamilies || []);
                setName(initial?.name ?? '');
                setStartsOn(toDateInput(initial?.startsAt));
                setEndsOn(toDateInput(initial?.endsAt));
                setCoordinatorPicks(initial?.coordinatorBundleLimit ?? 2);
                setSelectedFamilies(initial?.familyIds ?? []);
                setSubjectOverride(initial?.subjectOverride ?? '');
                setSalesLetter(initial?.salesLetter ?? '');
                setInternalNotes(initial?.internalNotes ?? '');
                setLoading(false);
            })
            .catch((e) => { if (alive) { setErrors([e.message]); setLoading(false); } });
        return () => { alive = false; };
    }, [open, initial]);

    if (!open) return null;

    const maxPicks = Math.max(MIN_PICKS, selectedFamilies.length);
    const canSave = name.trim().length > 0 && selectedFamilies.length > 0 && !saving;

    const toggleFamily = (familyId: string) => {
        setSelectedFamilies((prev) =>
            prev.includes(familyId) ? prev.filter((f) => f !== familyId) : [...prev, familyId],
        );
    };

    const handleSave = async () => {
        setSaving(true);
        setErrors([]);
        try {
            const res = await fetch('/api/rebooking/seasonal-lineups', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: initial?.id,
                    name,
                    startsAt: startsOn,
                    endsAt: endsOn,
                    familyIds: selectedFamilies,
                    coordinatorBundleLimit: coordinatorPicks,
                    subjectOverride: subjectOverride || null,
                    salesLetter: salesLetter || null,
                    internalNotes: internalNotes || null,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                setErrors(data.errors || [data.error || 'Could not save this lineup.']);
                setSaving(false);
                return;
            }
            setSaving(false);
            onSaved(data.lineup);
        } catch {
            setErrors(['Could not save this lineup. Please try again.']);
            setSaving(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-sm p-0 sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="seasonal-lineup-title"
        >
            <div className="bg-white dark:bg-slate-900 w-full sm:max-w-lg rounded-t-3xl sm:rounded-3xl border border-slate-200 dark:border-slate-700 shadow-xl max-h-[92vh] flex flex-col">

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

                <div className="px-5 py-4 space-y-5 overflow-y-auto">

                    {errors.length > 0 && (
                        <div className="rounded-2xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 space-y-1">
                            {errors.map((e, i) => (
                                <p key={i} className="text-sm font-bold text-rose-700 dark:text-rose-400 flex items-start gap-2">
                                    <AlertCircle size={15} className="flex-none mt-0.5" /> {e}
                                </p>
                            ))}
                        </div>
                    )}

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
                            {selectedFamilies.length > 0 && (
                                <span className="ml-1.5 text-indigo-600 dark:text-indigo-400">· {selectedFamilies.length} selected</span>
                            )}
                        </legend>

                        {loading ? (
                            <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-6 text-center">
                                <Loader2 size={20} className="mx-auto text-slate-300 animate-spin" />
                            </div>
                        ) : families.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-6 text-center">
                                <CalendarRange size={22} className="mx-auto text-slate-300 mb-2" />
                                <p className="text-sm font-bold text-slate-500">No paired bundles are ready yet.</p>
                                <p className="text-[11px] font-bold text-slate-400 mt-1">
                                    A bundle needs both a Serves-5 and a Serves-2 version before coordinators can choose it.
                                </p>
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-2">
                                {families.map((f) => {
                                    const selected = selectedFamilies.includes(f.familyId);
                                    return (
                                        <button
                                            key={f.familyId}
                                            type="button"
                                            onClick={() => toggleFamily(f.familyId)}
                                            aria-pressed={selected}
                                            className={`w-full text-left px-4 min-h-[44px] py-2.5 rounded-xl border transition-colors flex items-center gap-3 ${selected
                                                ? 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-500 dark:border-indigo-500'
                                                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
                                                }`}
                                        >
                                            <span
                                                aria-hidden="true"
                                                className={`flex-none w-5 h-5 rounded-md border-2 flex items-center justify-center ${selected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600'
                                                    }`}
                                            >
                                                {selected && <span className="text-white text-[11px] font-black leading-none">✓</span>}
                                            </span>
                                            <span className="min-w-0">
                                                <span className="block text-sm font-black text-slate-900 dark:text-white truncate">{f.serves5.name}</span>
                                                <span className="block text-[11px] font-bold text-slate-400 truncate">
                                                    Serves 5 &amp; Serves 2 ready
                                                </span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
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
                                onClick={() => setCoordinatorPicks((n) => Math.min(maxPicks, n + 1))}
                                disabled={coordinatorPicks >= maxPicks}
                                className="w-11 h-11 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-center font-black disabled:opacity-40"
                            >
                                <Plus size={16} />
                            </button>
                        </div>
                        {selectedFamilies.length > 0 && (
                            <p className="text-[11px] font-bold text-slate-400">
                                Up to {maxPicks}, because {maxPicks} bundle{maxPicks === 1 ? ' is' : 's are'} in this lineup.
                            </p>
                        )}
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
                                    value={subjectOverride}
                                    onChange={(e) => setSubjectOverride(e.target.value)}
                                    placeholder="Fall 2026 fundraising is open — pick your dates"
                                    className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="lineup-letter" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">Email sales letter</label>
                                <textarea
                                    id="lineup-letter"
                                    rows={3}
                                    value={salesLetter}
                                    onChange={(e) => setSalesLetter(e.target.value)}
                                    placeholder="Uses the standard seasonal letter unless you write your own…"
                                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="lineup-notes" className="block text-[11px] font-black uppercase tracking-wide text-slate-500">Internal notes</label>
                                <input
                                    id="lineup-notes"
                                    type="text"
                                    value={internalNotes}
                                    onChange={(e) => setInternalNotes(e.target.value)}
                                    placeholder="Only you see this"
                                    className="w-full min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm font-bold placeholder:text-slate-300 dark:placeholder:text-slate-600"
                                />
                            </div>
                        </div>
                    </details>
                </div>

                <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-100 dark:border-slate-700">
                    <button
                        onClick={onCancel}
                        className="px-5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!canSave}
                        className="px-5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 disabled:opacity-40 disabled:hover:bg-indigo-600 inline-flex items-center gap-2"
                    >
                        {saving && <Loader2 size={15} className="animate-spin" />}
                        Save lineup
                    </button>
                </div>
            </div>
        </div>
    );
}
