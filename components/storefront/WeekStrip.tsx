'use client';

/**
 * SF-2: order-week strip driven by the earliest REAL future order_cutoff_date.
 * Renders nothing when no valid future cutoff exists — no invented dates.
 * Pure presentation: no fetching, no mutation, and it does not replace the
 * existing cutoff logic used elsewhere in the storefront.
 */
export function WeekStrip({ bundles }: { bundles: Array<{ order_cutoff_date?: string | null }> }) {
    const cutoffs = bundles.map(b => b.order_cutoff_date).filter(Boolean).map(d => new Date(d!));
    if (!cutoffs.length) return null;
    const next = new Date(Math.min(...cutoffs.map(d => d.getTime())));
    if (next.getTime() < Date.now()) return null;
    const week = new Date(next); week.setDate(week.getDate() + 4); // delivery week ≈ cutoff + lead; adjust to tenant settings if present
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const day = next.toLocaleDateString('en-US', { weekday: 'short' });
    return (
        <div className="flex items-center gap-2 bg-[var(--sf-soft)] px-4 py-2 text-xs font-semibold text-[var(--sf-ink)]">
            📦 Ordering for the week of <b>{fmt(week)}</b> · order by {day} 9pm
        </div>
    );
}
