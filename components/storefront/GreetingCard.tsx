'use client';

/**
 * SF-2: TRUTHFUL generic returning-visitor greeting.
 *
 * Deliberately implements ONLY the generic variant: the repository exposes no
 * order-history, most-ordered-bundle, order-count, loyalty-balance, or
 * discount data to the landing page, so this card must never display a usual
 * bundle name, an order count, a "Reorder" action, points, or an offer.
 * Those richer variants stay deferred until grounded data exists.
 *
 * Visual structure follows the approved GreetingCard handoff shell
 * (emoji tile · title/sub · primary CTA) with SF-1 tokens.
 */
export function GreetingCard({ onBrowseMenu }: { onBrowseMenu: () => void }) {
    return (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] px-3.5 py-3">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-[var(--sf-soft)] text-xl">🧡</span>
            <span className="min-w-0">
                <b className="block text-[13px]">Welcome back!</b>
                <span className="text-[11px] text-[var(--sf-muted)]">This week&rsquo;s menu is ready when you are.</span>
            </span>
            <button
                onClick={onBrowseMenu}
                className="ml-auto flex-none rounded-xl bg-[var(--sf-primary)] px-3 py-2 text-xs font-extrabold text-[var(--sf-on-primary)] active:bg-[var(--sf-primary-press)]"
            >
                Browse this week&rsquo;s menu
            </button>
        </div>
    );
}
