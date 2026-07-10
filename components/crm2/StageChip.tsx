'use client';

const STAGE_STYLES: Record<string, string> = {
    lead:       'bg-amber-100 text-amber-800',
    agreement:  'bg-sky-100 text-sky-800',
    onboarding: 'bg-sky-100 text-sky-800',
    active:     'bg-emerald-100 text-emerald-700',
    production: 'bg-violet-100 text-violet-700',
    delivery:   'bg-indigo-100 text-indigo-700',
    closed:     'bg-orange-100 text-orange-800',
    settled:    'bg-slate-200 text-slate-600',
    archived:   'bg-slate-200 text-slate-600',
    completed:  'bg-orange-100 text-orange-800',
};

export function StageChip({ status }: { status: string }) {
    const key = (status || '').toLowerCase();
    return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${STAGE_STYLES[key] ?? 'bg-slate-100 text-slate-500'}`}>
            {status}
        </span>
    );
}

/** Closed-family predicate — keep in sync with app/fundraisers/page.tsx isCampaignClosed() */
export function isClosedFamily(f: { closed_at?: string | null; status: string }): boolean {
    return Boolean(f.closed_at) || ['Closed', 'Settled', 'Completed', 'Archived'].includes(f.status);
}
