'use client';

export function SetupChecklist({
    coordinatorFirstName,
    hasPaymentInfo,
    hasSharedOnce,
    hasFirstOrder,
    onSetPayment,
    onShare,
    onAddOrder,
}: {
    coordinatorFirstName?: string;
    hasPaymentInfo: boolean; hasSharedOnce: boolean; hasFirstOrder: boolean;
    onSetPayment: () => void; onShare: () => void; onAddOrder: () => void;
}) {
    const steps = [
        {
            done: hasPaymentInfo, attn: !hasPaymentInfo,
            title: 'Tell supporters how to pay you',
            body: 'Venmo, checks, cash — buyers see this on every order.',
            cta: 'Add it', onClick: onSetPayment,
        },
        {
            done: hasSharedOnce, attn: hasPaymentInfo && !hasSharedOnce,
            title: 'Share your fundraiser link',
            body: 'Text it to 5 people to get rolling.',
            cta: 'Share', onClick: onShare,
        },
        {
            done: hasFirstOrder, attn: hasSharedOnce && !hasFirstOrder,
            title: 'Log your first order',
            body: 'Takes about 20 seconds.',
            cta: 'Add order', onClick: onAddOrder,
        },
    ];
    return (
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900">
                {coordinatorFirstName ? `Hi ${coordinatorFirstName} — ` : ''}3 steps and you&apos;re live
            </h3>
            <div className="mt-2 divide-y divide-slate-100">
                {steps.map((s, i) => (
                    <div key={i} className="flex items-start gap-3 py-2.5">
                        <span className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-extrabold ${
                            s.done ? 'bg-emerald-100 text-emerald-700'
                            : s.attn ? 'bg-amber-200 text-amber-900'
                            : 'bg-slate-100 text-slate-500'
                        }`}>
                            {s.done ? '✓' : i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-slate-900">{s.title}</p>
                            <p className="text-xs text-slate-500">{s.body}</p>
                        </div>
                        {!s.done && (
                            <button onClick={s.onClick}
                                className="flex-none self-center rounded-lg bg-indigo-50 px-2.5 py-1.5 text-xs font-bold text-indigo-700">
                                {s.cta}
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
}

export default SetupChecklist;
