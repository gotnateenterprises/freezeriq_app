"use client";

/**
 * FR-ORG-DASHBOARD-1A — recorded outreach only.
 *
 * Every entry is a row the send engine or the rebooking form actually wrote.
 * FreezerIQ stores no provider delivery, open or click events, so none are
 * shown, and emails that were never recorded (the retired intro / info /
 * marketing packet sends) cannot appear here.
 */

import { useState } from 'react';
import { MessageSquareReply, Send, Users } from 'lucide-react';
import type { MarketingEntry } from '@/lib/organizationDashboard';

const VISIBLE = 5;

const STATE_TONES: Record<string, string> = {
    good: 'text-emerald-700 dark:text-emerald-300',
    pending: 'text-indigo-700 dark:text-indigo-300',
    warn: 'text-rose-700 dark:text-rose-300',
    neutral: 'text-slate-600 dark:text-slate-300',
};

const ICONS = {
    seasonal_update: Send,
    previous_supporters: Users,
    rebooking_response: MessageSquareReply,
} as const;

export function MarketingActivityCard({ entries }: { entries: MarketingEntry[] }) {
    const [showAll, setShowAll] = useState(false);
    const shown = showAll ? entries : entries.slice(0, VISIBLE);

    return (
        <section
            aria-labelledby="org-marketing-heading"
            className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 dark:border-slate-800 dark:bg-slate-900"
        >
            <h2 id="org-marketing-heading" className="mb-1 text-[11px] font-black uppercase tracking-widest text-slate-400">
                Marketing Activity
            </h2>
            {entries.length === 0 ? (
                <p className="py-3 text-xs font-medium text-slate-500 dark:text-slate-400">No recorded marketing activity yet.</p>
            ) : (
                <ol className="divide-y divide-slate-100 dark:divide-slate-800">
                    {shown.map((e) => {
                        const Icon = ICONS[e.kind];
                        return (
                            <li key={e.id} className="flex items-start gap-3 py-2.5">
                                <span className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                    <Icon size={13} aria-hidden="true" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block break-words text-sm font-bold text-slate-900 dark:text-white">{e.title}</span>
                                    <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                        <span className={`font-bold ${STATE_TONES[e.tone] ?? STATE_TONES.neutral}`}>{e.stateLabel}</span>
                                        {e.dateLabel ? ` · ${e.dateLabel}` : ''}
                                    </span>
                                    {e.detail && (
                                        <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">{e.detail}</span>
                                    )}
                                </span>
                            </li>
                        );
                    })}
                </ol>
            )}
            {entries.length > VISIBLE && (
                <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    aria-expanded={showAll}
                    className="mt-1 inline-flex min-h-[44px] items-center text-xs font-bold text-indigo-600 hover:underline dark:text-indigo-400"
                >
                    {showAll ? 'Show fewer' : `Show all ${entries.length}`}
                </button>
            )}
            <p className="mt-2 text-[11px] font-medium leading-snug text-slate-500 dark:text-slate-400">
                Emails FreezerIQ sent and responses it received. Opens and clicks are not tracked.
            </p>
        </section>
    );
}
