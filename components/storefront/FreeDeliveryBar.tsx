'use client';

/**
 * SF-3: faithful port of the prototype `.freebar` / handoff FreeDeliveryBar.
 *
 * TRUTHFULNESS RULE (handoff): the threshold must come from real delivery
 * settings. No such field exists in tenant configuration today, so callers
 * pass `threshold={null}` and this component renders NOTHING — no default
 * amount, no hardcoded promise, no invented free-delivery claim. The bar
 * activates only when a real configured threshold exists in a future phase.
 */
export function FreeDeliveryBar({ subtotal, threshold }: {
    subtotal: number;
    threshold: number | null;
}) {
    if (!threshold || !Number.isFinite(threshold) || threshold <= 0 || subtotal <= 0) return null;
    const remain = threshold - subtotal;
    return (
        <div className="sticky bottom-14 z-20 bg-[var(--sf-gold)] px-4 py-2 text-[11px] font-bold text-[var(--sf-gold-ink)] lg:hidden">
            {remain > 0
                ? <>🚚 You&rsquo;re <b>${remain.toFixed(0)}</b> away from free home delivery</>
                : <>🎉 You&rsquo;ve unlocked <b>free home delivery</b>!</>}
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/10">
                <div className="h-full rounded-full bg-[var(--sf-sage)] transition-all" style={{ width: `${Math.min(subtotal / threshold * 100, 100)}%` }} />
            </div>
        </div>
    );
}
