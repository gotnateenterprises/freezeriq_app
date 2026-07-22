'use client';

/**
 * SF-3: faithful port of the prototype `.cartbar` — the bag summary bar.
 * MOBILE-ONLY (hidden from lg: up; desktop keeps its existing cart access).
 * Renders only when the bag holds at least one item; count and total are the
 * ACTUAL cart values, and the action opens the existing CartDrawer. Safe-area
 * inset respected; the inner native button carries keyboard access.
 *
 * Correction: viewport-fixed (not `sticky`). This component renders as the
 * last element in StorefrontClient's page flow, so `sticky bottom-0` never
 * activated — its containing block's bottom (the page bottom) only entered
 * view once the user had already scrolled past everything, including the
 * footer. `fixed` pins it to the viewport regardless of scroll position.
 * z-30: above ordinary in-flow storefront content (max z-20) and spatially
 * separate from the top-pinned SF-2A topbar (z-40, sticky top-0), while
 * staying below CartDrawer (z-50) and BundleDetail (z-[200]) so opening
 * either always renders above this bar, never beneath it.
 */
export function StickyCartBar({ count, total, label = 'Your bag', ctaLabel = 'View →', onCta }: {
    count: number;
    total: number;
    label?: string;
    ctaLabel?: string;
    onCta: () => void;
}) {
    if (count < 1) return null;
    return (
        <div
            onClick={onCta}
            className="fixed inset-x-0 bottom-0 z-30 flex cursor-pointer items-center gap-3 bg-[var(--sf-ink)] px-4 py-3 text-white lg:hidden"
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
        >
            <span className="grid h-6 min-w-6 place-items-center rounded-full bg-[var(--sf-primary)] text-[11px] font-extrabold" aria-hidden="true">{count}</span>
            <span className="text-sm font-bold">{label}</span>
            <span className="ml-auto font-extrabold tabular-nums">${total.toFixed(0)}</span>
            <button
                onClick={(e) => { e.stopPropagation(); onCta(); }}
                aria-label={`${label}: ${count} items, $${total.toFixed(0)} — open bag`}
                className="rounded-xl bg-white px-3 py-2 text-xs font-extrabold text-[var(--sf-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
            >
                {ctaLabel}
            </button>
        </div>
    );
}
