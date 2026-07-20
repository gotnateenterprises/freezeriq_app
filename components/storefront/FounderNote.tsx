'use client';

/**
 * SF-2: founder/story note — prototype `.founder` layout with SF-1 tokens.
 *
 * GROUNDED CONTENT ONLY: the caller passes real tenant story text
 * (StorefrontConfig.our_story_content) and a real attribution (the tenant's
 * display name). No founder biography, tenant facts, or default story copy is
 * invented here — when no valid story text exists this renders nothing.
 * Avatar: tenant logo when present, 👩‍🍳 otherwise (per handoff).
 */
export function FounderNote({
    storyText,
    attribution,
    logoUrl,
}: {
    storyText?: string | null;
    attribution?: string | null;
    logoUrl?: string | null;
}) {
    const text = (storyText || '').trim();
    if (!text) return null;

    return (
        <div className="mx-4 my-4 flex gap-3 rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] px-4 py-4">
            <span className="grid h-11 w-11 flex-none place-items-center overflow-hidden rounded-full bg-[var(--sf-soft)] text-xl">
                {logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                    <span aria-hidden="true">👩‍🍳</span>
                )}
            </span>
            <p className="m-0 font-serif text-[13px] italic leading-relaxed text-[var(--sf-ink)] whitespace-pre-wrap">
                {text}
                {attribution ? (
                    <span className="mt-1.5 block font-sans text-[11px] font-bold not-italic text-[var(--sf-muted)]">
                        — {attribution}
                    </span>
                ) : null}
            </p>
        </div>
    );
}
