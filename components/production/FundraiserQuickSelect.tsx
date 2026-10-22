"use client";

import { Check, Minus } from 'lucide-react';
import {
    groupWavesByDate,
    waveSelectionState,
    type FundraiserWave,
} from '@/lib/packedReadyWaves';

/**
 * PACKED-READY-WAVES-1 — pick a whole fundraiser in Packed & Ready.
 *
 * PURELY A SELECTION LAYER. Choosing a fundraiser here only changes which Order IDs are
 * ticked in the lane's existing `selected` set — the same set the per-order checkboxes
 * edit. Box Labels, Packing Slips and Send to Delivery then consume that set exactly as
 * they always have (exact Order IDs; the server re-checks tenant and eligibility on each).
 * Nothing on this component calls an API, writes storage, or knows what a status is.
 *
 * One chip per FundraiserCampaign.id, grouped under that campaign's own delivery date
 * (Campaign.delivery_date, read as a calendar date — never closeout, invoice or order
 * date). Names and dates are labels; they are never sent anywhere and never decide
 * membership. Per-order checkboxes stay available below as the finer override, and a
 * chip shows a mixed state when only some of its orders are ticked.
 */
export default function FundraiserQuickSelect({
    waves,
    selected,
    onToggle,
}: {
    waves: FundraiserWave[];
    selected: ReadonlySet<string>;
    /** Toggle these whole waves in the lane's selection. */
    onToggle: (waves: FundraiserWave[]) => void;
}) {
    if (waves.length === 0) return null;
    const groups = groupWavesByDate(waves);

    return (
        <section
            aria-label="Fundraisers in Packed & Ready"
            className="bg-white dark:bg-slate-800 p-4 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-3"
        >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-sm font-black text-slate-900 dark:text-white">Fundraisers in Packed &amp; Ready</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    Choose a fundraiser to tick exactly its orders. You can still tick or untick single orders below.
                </p>
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

                        <div className="flex flex-wrap gap-2">
                            {group.waves.map((wave) => {
                                const state = waveSelectionState([wave], selected);
                                const count = wave.orderIds.length;
                                return (
                                    <button
                                        key={wave.campaignId}
                                        type="button"
                                        role="checkbox"
                                        aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'}
                                        onClick={() => onToggle([wave])}
                                        className={
                                            'min-h-11 flex items-center gap-3 text-left px-3 py-2 rounded-xl border-2 transition-colors '
                                            + (state === 'none'
                                                ? 'border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 hover:border-indigo-300'
                                                : 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/30')
                                        }
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={
                                                'shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center '
                                                + (state === 'none'
                                                    ? 'border-slate-300 dark:border-slate-500'
                                                    : 'border-indigo-600 bg-indigo-600 text-white')
                                            }
                                        >
                                            {state === 'all' && <Check size={14} strokeWidth={3} />}
                                            {state === 'some' && <Minus size={14} strokeWidth={3} />}
                                        </span>
                                        <span className="min-w-0">
                                            <span className="block text-sm font-black text-slate-900 dark:text-white break-words">
                                                {wave.label}
                                                {wave.disambiguator && (
                                                    <span className="ml-1.5 text-[10px] font-bold text-slate-400">#{wave.disambiguator}</span>
                                                )}
                                            </span>
                                            <span className="block text-xs font-medium text-slate-500 dark:text-slate-400">
                                                {count} {count === 1 ? 'order' : 'orders'}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                );
            })}
        </section>
    );
}
