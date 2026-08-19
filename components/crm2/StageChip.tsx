'use client';

import { campaignDisplayStage } from '@/lib/campaignDisplayStage';

// CRM-CC-5: restyled onto the Command Center's one chip recipe — rounded-lg,
// bordered, dark-mode aware — keeping each stage's existing hue. Purely
// presentational; stage semantics and isClosedFamily are untouched.
const STAGE_STYLES: Record<string, string> = {
    lead:       'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
    agreement:  'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
    onboarding: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
    active:     'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
    production: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
    delivery:   'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900',
    closed:     'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
    settled:    'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
    archived:   'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
    completed:  'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
    // FR-FLOW-2B: deliberately amber, not emerald. A campaign waiting on its
    // coordinator is outstanding work, and green is what told tenants otherwise.
    awaiting_setup: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
};

/**
 * FR-FLOW-2B — `bundleSelectionStatus` is optional so every existing caller keeps
 * working untouched; when it is supplied, an Active-but-pending campaign is
 * labelled "Awaiting Coordinator Setup" instead of a green ACTIVE.
 */
export function StageChip({
    status,
    bundleSelectionStatus,
    closedAt,
}: {
    status: string;
    bundleSelectionStatus?: string | null;
    closedAt?: string | null;
}) {
    const stage = campaignDisplayStage({
        status: status || '',
        closed_at: closedAt ?? null,
        bundle_selection_status: bundleSelectionStatus ?? null,
    });
    return (
        <span className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${STAGE_STYLES[stage.key] ?? 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}`}>
            {stage.label}
        </span>
    );
}

/** Closed-family predicate — keep in sync with app/fundraisers/page.tsx isCampaignClosed() */
export function isClosedFamily(f: { closed_at?: string | null; status: string }): boolean {
    return Boolean(f.closed_at) || ['Closed', 'Settled', 'Completed', 'Archived'].includes(f.status);
}
