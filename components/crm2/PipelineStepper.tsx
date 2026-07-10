'use client';

const STAGES = ['Lead', 'Agreement', 'Onboarding', 'Active', 'Production', 'Delivery', 'Closed'];

export function PipelineStepper({ current, onAdvance }: { current: string; onAdvance?: (stage: string) => void }) {
    const norm = ['Settled', 'Completed', 'Archived'].includes(current) ? 'Closed' : current;
    const idx = Math.max(STAGES.indexOf(norm), 0);
    return (
        <div className="flex overflow-x-auto rounded-2xl border border-slate-200 bg-white px-5 py-3.5 dark:border-slate-800 dark:bg-slate-900">
            {STAGES.map((s, i) => (
                <button key={s} onClick={() => onAdvance?.(s)} disabled={!onAdvance}
                    className="relative min-w-[86px] flex-1 text-center text-[10px] font-extrabold uppercase tracking-wide disabled:cursor-default">
                    <span className={`relative z-10 mx-auto mb-1.5 block h-3 w-3 rounded-full ${
                        i < idx ? 'bg-emerald-500' : i === idx ? 'bg-indigo-600 ring-4 ring-indigo-100 dark:ring-indigo-950' : 'bg-slate-200 dark:bg-slate-700'}`} />
                    {i < STAGES.length - 1 && (
                        <span className={`absolute left-[calc(50%+8px)] top-[5px] h-0.5 w-[calc(100%-16px)] ${i < idx ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
                    )}
                    <span className={i < idx ? 'text-emerald-700' : i === idx ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-400'}>{s}</span>
                </button>
            ))}
        </div>
    );
}
