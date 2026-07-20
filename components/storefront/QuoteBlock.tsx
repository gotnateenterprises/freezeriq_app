'use client';

/**
 * SF-2: single highlighted testimonial — prototype `.quote` treatment
 * (serif italic pull-quote, muted attribution, `#e0a52e` star row).
 *
 * GROUNDED CONTENT ONLY: the caller selects one REAL testimonial from
 * storefrontConfig.testimonials. Renders nothing without a valid quote.
 * The star row renders ONLY when a real numeric rating is supplied — the
 * current testimonial data carries no rating field, so fabricating a
 * five-star row would be dishonest. (Truthfulness deviation from the
 * prototype's illustrative ★★★★★, reported in the SF-2 notes.)
 */
export function QuoteBlock({
    quote,
    author,
    rating,
}: {
    quote?: string | null;
    author?: string | null;
    rating?: number | null;
}) {
    const text = (quote || '').trim();
    if (!text) return null;

    const stars = typeof rating === 'number' && Number.isFinite(rating) && rating > 0
        ? '★'.repeat(Math.max(1, Math.min(5, Math.round(rating))))
        : null;

    return (
        <div className="mx-4 mb-4 px-5 py-3.5 text-center">
            {stars && (
                <div className="text-[13px] tracking-[2px] text-[#e0a52e]" aria-label={`Rated ${Math.round(rating!)} out of 5`}>
                    {stars}
                </div>
            )}
            <p className="m-0 font-serif text-[14px] italic text-[var(--sf-ink)]">&ldquo;{text}&rdquo;</p>
            {author ? (
                <span className="text-[11px] font-bold text-[var(--sf-muted)]">— {author}</span>
            ) : null}
        </div>
    );
}
