'use client';

export function WhatsNext({
    tenantName, deliveryWindowLabel,
}: {
    tenantName: string; deliveryWindowLabel?: string;
}) {
    return (
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900 mb-1">What happens next</h3>
            <Step n="✓" done title={`${tenantName} confirms your totals`} body="Done — your order is locked in." />
            {deliveryWindowLabel && (
                <Step n="2" title={`Food arrives ${deliveryWindowLabel}`} body="You&apos;ll get an email with the exact time." />
            )}
            <Step n={deliveryWindowLabel ? '3' : '2'} title="Hand out orders with your pickup sheet"
                body="Every family, every bundle, one checklist." />
        </section>
    );
}

function Step({ n, title, body, done = false }: { n: string; title: string; body: string; done?: boolean }) {
    return (
        <div className="flex items-start gap-3 border-t border-slate-100 py-2.5 first:border-t-0">
            <span className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-extrabold ${
                done ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-50 text-indigo-700'
            }`}>{n}</span>
            <div>
                <p className="text-sm font-bold text-slate-900">{title}</p>
                <p className="text-xs text-slate-500">{body}</p>
            </div>
        </div>
    );
}

export default WhatsNext;
