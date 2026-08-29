'use client';

/**
 * FR-SHARE-COPY-1 addendum — "raised for {org}" must be the organization's
 * ACTUAL money raised (totalSales × this campaign's configured
 * org_share_percent), never gross sales relabeled. totalSales is still shown,
 * as its own stat, so a coordinator can see both facts rather than losing
 * one to fix the other. See lib/fundraiserMetrics.computeFundraiserProgress
 * (raisedAmount) and lib/fundraiserOrgShare.organizationShareAmount — the
 * campaign's own share, resolved by the caller, never guessed here.
 */
export function ProgressHero({
    sold, goal, progress, totalSales, raisedAmount, orderCount, daysRemaining,
    paceText, hot = false, dimmed = false, orgLabel = 'your group', orgSharePercent,
}: {
    sold: number; goal: number; progress: number;
    totalSales: number; raisedAmount: number; orderCount: number; daysRemaining: number | null;
    paceText?: string; hot?: boolean; dimmed?: boolean; orgLabel?: string; orgSharePercent?: number;
}) {
    const sharePercentLabel = orgSharePercent && orgSharePercent > 0
        ? `${parseFloat(orgSharePercent.toFixed(2))}% share`
        : undefined;

    return (
        <section className={`bg-white border border-slate-200 rounded-2xl p-4 ${dimmed ? 'opacity-75' : ''}`}>
            <p className="text-4xl font-black tracking-tight tabular-nums text-slate-900">
                {sold} <span className="text-base font-bold text-slate-500">of {goal} bundles</span>
            </p>
            <div className="mt-2 h-2.5 rounded-full bg-slate-200 overflow-hidden">
                <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-600 to-indigo-400 transition-all"
                    style={{ width: `${Math.min(progress, 100)}%` }}
                />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                <Stat label="total sales" value={`$${totalSales.toFixed(0)}`} />
                <Stat label={`raised for ${orgLabel}`} value={`$${raisedAmount.toFixed(0)}`} caption={sharePercentLabel} money />
                <Stat label="orders" value={String(orderCount)} />
                <Stat label="days left" value={daysRemaining === null ? '—' : String(Math.max(daysRemaining, 0))} />
            </div>
            {paceText && (
                <p className={`mt-3 rounded-xl px-3 py-2 text-[13px] font-medium ${
                    hot ? 'bg-amber-50 text-amber-800' : 'bg-indigo-50 text-indigo-800'
                }`}>
                    {paceText}
                </p>
            )}
        </section>
    );
}

function Stat({ label, value, caption, money = false }: { label: string; value: string; caption?: string; money?: boolean }) {
    return (
        <div className="min-w-0 flex-1 rounded-xl bg-slate-50 px-2 py-2 text-center">
            <p className={`text-base font-black tabular-nums ${money ? 'text-emerald-600' : 'text-slate-900'}`}>{value}</p>
            <p className="break-words text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
            {caption && <p className="mt-0.5 text-[9px] font-medium normal-case text-slate-400">{caption}</p>}
        </div>
    );
}

export default ProgressHero;
