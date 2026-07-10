'use client';

export function ProgressHero({
    sold, goal, progress, totalSales, orderCount, daysRemaining,
    paceText, hot = false, dimmed = false, orgLabel = 'your group',
}: {
    sold: number; goal: number; progress: number;
    totalSales: number; orderCount: number; daysRemaining: number | null;
    paceText?: string; hot?: boolean; dimmed?: boolean; orgLabel?: string;
}) {
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
            <div className="mt-3 flex gap-2">
                <Stat label={`raised for ${orgLabel}`} value={`$${totalSales.toFixed(0)}`} money />
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

function Stat({ label, value, money = false }: { label: string; value: string; money?: boolean }) {
    return (
        <div className="flex-1 rounded-xl bg-slate-50 px-2 py-2 text-center">
            <p className={`text-base font-black tabular-nums ${money ? 'text-emerald-600' : 'text-slate-900'}`}>{value}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        </div>
    );
}

export default ProgressHero;
