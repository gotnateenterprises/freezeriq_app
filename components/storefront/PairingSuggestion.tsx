'use client';

/**
 * SF-3: faithful port of the handoff PairingSuggestion / prototype `.pair`.
 * At most ONE per detail view; never a carousel. The caller supplies a REAL
 * grounded candidate (configured upsell bundle resolved from the current
 * payload) — when no safe candidate exists this renders nothing.
 */
export function PairingSuggestion({ bundle, onAdd, added }: {
    bundle: any;
    onAdd: () => void;
    added: boolean;
}) {
    if (!bundle) return null;
    return (
        <div className="mt-3 flex items-center gap-3 rounded-2xl border border-[var(--sf-soft-border)] bg-[var(--sf-soft)] px-3.5 py-3">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-[var(--sf-card)] text-lg">
                {bundle.image_url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={bundle.image_url} alt="" className="h-full w-full rounded-xl object-cover" />
                    : <span aria-hidden="true">🍎</span>}
            </span>
            <span className="min-w-0">
                <b className="block text-xs">Families also love: {bundle.name}</b>
                <span className="text-[10px] text-[var(--sf-muted)]">+${Number(bundle.price).toFixed(0)}</span>
            </span>
            <button
                onClick={onAdd}
                aria-label={added ? `${bundle.name} added` : `Add ${bundle.name}`}
                className={`ml-auto flex-none rounded-lg border-2 px-2.5 py-1.5 text-[11px] font-extrabold ${
                    added ? 'border-[var(--sf-sage)] bg-[var(--sf-sage)] text-white'
                          : 'border-[var(--sf-primary)] bg-[var(--sf-card)] text-[var(--sf-primary)]'}`}
            >
                {added ? '✓' : '+ Add'}
            </button>
        </div>
    );
}
