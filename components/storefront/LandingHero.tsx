'use client';

/**
 * SF-2A: faithful port of the approved prototype `.hero`
 * (storefront_prototype.html) — a compact TEXT-ONLY editorial block on the
 * warm storefront ground. Deliberately contains:
 *   no photograph · no card wrapper · no badge · no trust row
 *   no CTA button · no viewport-height layout
 * Shopping actions live in the menu/cards and the later sticky-cart phase.
 *
 * Prototype CSS ported to SF-1 tokens:
 *   .hero      padding 1.3rem 1.15rem 1rem
 *   .hero h1   Georgia serif · 400 · 1.7rem · lh 1.15 · ls -.01em → --sf-ink
 *   .hero h1 em italic → --sf-primary
 *   .hero p    .82rem → --sf-muted
 *
 * Copy contract: a tenant-configured headline/subheadline ALWAYS wins and is
 * rendered as plain text (React-escaped — never parsed as HTML). Only the
 * approved prototype default hooks use the italic primary emphasis:
 *   first visit → "What if dinner was already *done?*"     (prototype first screen)
 *   returning   → "Dinner, *solved.* Made with love…"      (prototype returning screen)
 * The subheadline default stays the existing approved neutral fallback — no
 * invented tenant claims (licensure, locality, history).
 */
export function LandingHero({
    headline,
    subheadline,
    isReturning = false,
}: {
    headline?: string | null;
    subheadline?: string | null;
    isReturning?: boolean;
}) {
    const configured = (headline || '').trim();

    return (
        <div className="px-[1.15rem] pb-4 pt-5">
            <h1 className="m-0 font-serif text-[1.7rem] font-normal leading-[1.15] tracking-[-0.01em] text-[var(--sf-ink)]">
                {configured ? (
                    configured
                ) : isReturning ? (
                    <>Dinner, <em className="italic text-[var(--sf-primary)]">solved.</em><br />Made with love, frozen with care.</>
                ) : (
                    <>What if dinner was<br />already <em className="italic text-[var(--sf-primary)]">done?</em></>
                )}
            </h1>
            <p className="mb-0 mt-2 text-[0.82rem] leading-relaxed text-[var(--sf-muted)]">
                {(subheadline || '').trim() || 'Home-cooked flavor. Zero dinner stress. Stock your freezer. Gather around the table.'}
            </p>
        </div>
    );
}
