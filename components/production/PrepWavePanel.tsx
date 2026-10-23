"use client";

import { Check, Minus, Printer } from 'lucide-react';
import {
    groupWavesByDate,
    waveSelectionState,
    type FundraiserWave,
} from '@/lib/packedReadyWaves';
import { waveLines, waveUnitCount, type PrepLane, type PrepWaveLine } from '@/lib/prepWaves';

/**
 * PREP-WAVES-1 — the fundraiser list a Prep status action is made from.
 *
 * A Prep card answers "how much of this meal do we make?" across every fundraiser. This panel
 * answers the other question — "which fundraiser's food are we working on NOW?" — and it is the
 * ONLY place a fundraiser's orders are started or marked packed. One row per
 * FundraiserCampaign.id, grouped under that campaign's own delivery date (Campaign.delivery_date,
 * read as a calendar date). Tick the fundraisers you mean; the button then carries exactly their
 * orders, by id, to the existing exact-id route.
 *
 * Presentational and hookless: the selection lives in PrepList. Nothing here calls an API, writes
 * storage or knows what a status is — it renders what it is handed and reports clicks.
 *
 * Each row lists the bundles inside it because a status belongs to the whole ORDER: ticking
 * Alpha moves every bundle in every one of Alpha's orders, and the row says so rather than
 * implying one bundle moves.
 */
export default function PrepWavePanel({
    lane,
    selected,
    heading,
    helper,
    actionLabel,
    tone,
    busy,
    onToggle,
    onClear,
    onAction,
    onWaveLabels,
}: {
    lane: PrepLane;
    /** Selected ORDER ids (the same shape the Packed & Ready lane uses). */
    selected: ReadonlySet<string>;
    heading: string;
    helper: string;
    actionLabel: string;
    tone: 'amber' | 'emerald';
    busy: boolean;
    /** Toggle these whole fundraisers in the lane's selection. */
    onToggle: (waves: FundraiserWave[]) => void;
    onClear: () => void;
    onAction: () => void;
    /** Optional: queue this fundraiser's meal labels (read-only). */
    onWaveLabels?: (wave: FundraiserWave) => void;
}) {
    if (lane.waves.length === 0) return null;

    const groups = groupWavesByDate(lane.waves);
    const live = new Set(lane.orders.map((o) => o.id));
    const chosenWaves = lane.waves.filter((w) => w.orderIds.some((id) => selected.has(id) && live.has(id)));
    const chosenOrders = new Set<string>();
    for (const w of chosenWaves) for (const id of w.orderIds) if (selected.has(id) && live.has(id)) chosenOrders.add(id);
    const count = chosenOrders.size;

    const buttonTone = tone === 'amber'
        ? 'bg-amber-600 hover:bg-amber-700 shadow-amber-500/20'
        : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20';

    const chipText = (line: PrepWaveLine, all: PrepWaveLine[]) => {
        // The bundle name usually carries its tier; spell the tier out only where the same bundle appears twice.
        const twice = all.filter((l) => l.bundleId === line.bundleId).length > 1;
        return `${line.bundleName}${twice && line.tierLabel ? ` · ${line.tierLabel}` : ''} ×${line.units}`;
    };

    return (
        <section
            aria-label={heading}
            className="bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4 print:hidden"
        >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-lg font-black text-slate-900 dark:text-white">{heading}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">{helper}</p>
            </div>

            {groups.map((group) => {
                const dateState = waveSelectionState(group.waves, selected);
                return (
                    <div key={group.dateKey ?? 'undated'} className="space-y-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <h4 className="text-xs font-black uppercase tracking-wider text-slate-500 dark:text-slate-400">
                                {group.dateLabel ? `Delivery ${group.dateLabel}` : 'No delivery date set'}
                            </h4>
                            {group.dateKey !== null && group.waves.length > 1 && (
                                <button
                                    type="button"
                                    onClick={() => onToggle(group.waves)}
                                    className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                                >
                                    {dateState === 'all' ? 'Unselect all for this date' : 'Select all for this date'}
                                </button>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-2">
                            {group.waves.map((wave) => {
                                const state = waveSelectionState([wave], selected);
                                const lines = waveLines(lane, wave);
                                const orders = wave.orderIds.length;
                                const units = waveUnitCount(lane, wave);
                                return (
                                    <div key={wave.campaignId} className="flex items-stretch gap-2">
                                        <button
                                            type="button"
                                            role="checkbox"
                                            aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
                                            onClick={() => onToggle([wave])}
                                            className={
                                                'flex-1 min-w-0 flex items-start gap-3 text-left px-3 py-3 rounded-xl border-2 transition-colors '
                                                + (state === 'none'
                                                    ? 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 hover:border-indigo-300'
                                                    : 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30')
                                            }
                                        >
                                            <span
                                                aria-hidden="true"
                                                className={
                                                    'mt-0.5 shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center '
                                                    + (state === 'none'
                                                        ? 'border-slate-300 dark:border-slate-500'
                                                        : 'border-indigo-600 bg-indigo-600 text-white')
                                                }
                                            >
                                                {state === 'all' && <Check size={14} strokeWidth={3} />}
                                                {state === 'some' && <Minus size={14} strokeWidth={3} />}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-sm font-black text-slate-900 dark:text-white break-words">
                                                    {wave.label}
                                                    {wave.disambiguator && (
                                                        <span className="ml-1.5 text-[10px] font-bold text-slate-400">#{wave.disambiguator}</span>
                                                    )}
                                                </span>
                                                <span className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                                                    {orders} {orders === 1 ? 'order' : 'orders'} · {units} {units === 1 ? 'bundle' : 'bundles'}
                                                </span>
                                                <span className="mt-1.5 flex flex-wrap gap-1.5">
                                                    {lines.map((line) => (
                                                        <span
                                                            key={`${line.bundleId}|${line.variantSize}`}
                                                            className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-[11px] font-bold text-slate-600 dark:text-slate-300"
                                                        >
                                                            {chipText(line, lines)}
                                                        </span>
                                                    ))}
                                                </span>
                                            </span>
                                        </button>
                                        {onWaveLabels && (
                                            <button
                                                type="button"
                                                onClick={() => onWaveLabels(wave)}
                                                title="Meal labels for this fundraiser's orders"
                                                className="shrink-0 px-3 rounded-xl border-2 border-slate-200 dark:border-slate-600 text-slate-500 hover:text-emerald-600 hover:border-emerald-300 transition-colors"
                                            >
                                                <Printer size={18} />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            })}

            <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                    type="button"
                    onClick={onAction}
                    disabled={busy || count === 0}
                    className={`${buttonTone} text-white px-5 py-3 rounded-xl font-bold transition-colors shadow-lg disabled:opacity-50`}
                >
                    {busy
                        ? 'Working…'
                        : count === 0
                            ? `${actionLabel} — choose fundraisers`
                            : `${actionLabel} — ${count} selected`}
                </button>
                {count > 0 && (
                    <button
                        type="button"
                        onClick={onClear}
                        className="text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        Clear selection
                    </button>
                )}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    {count === 0
                        ? 'Nothing is selected, so nothing will move.'
                        : `${count} whole ${count === 1 ? 'order' : 'orders'} from ${chosenWaves.length} ${chosenWaves.length === 1 ? 'fundraiser' : 'fundraisers'} will move.`}
                </p>
            </div>
        </section>
    );
}
