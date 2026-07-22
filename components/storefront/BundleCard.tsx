'use client';

/**
 * SF-3: faithful port of the approved prototype `.bcard` / handoff BundleCard.
 * White token card · image block with at most ONE truthful badge · serif title ·
 * real recipe names · real price (whole dollars, per prototype) · direct Add
 * that flips to the sage "✓ Added" state driven by ACTUAL cart contents.
 *
 * Recipe-name adapter: the public payload nests names as contents[].recipe.name
 * (the handoff sketch assumed a flat recipe_name) — only real names render;
 * missing data renders nothing, never a placeholder claim.
 */

/** Matches the tier semantics used by the public tenant API and fundraiserMetrics. */
export function isServes2Tier(tier?: string | null): boolean {
    const t = (tier || '').toLowerCase();
    return t === 'serves_2' || t === 'couple' || t === 'couples' || t.includes('serves 2');
}

export function servesLabel(tier?: string | null): string {
    return isServes2Tier(tier) ? 'serves 2' : 'serves 5';
}

export function BundleCard({ b, badge, onOpen, onAdd, added }: {
    b: any;
    badge?: string | null;
    onOpen: () => void;
    onAdd: () => void;
    added: boolean;
}) {
    const inside = (b.contents ?? [])
        .slice(0, 5)
        .map((c: any) => c?.recipe?.name)
        .filter(Boolean)
        .join(' · ');
    const mealCount = Array.isArray(b.contents) ? b.contents.length : 0;

    // Correction C: approved real-data image priority —
    //   1. bundle.image_url
    //   2. first real, non-empty contents[].recipe.image_url already present
    //      in the payload (app/api/public/tenant/[slug]/route.ts merges each
    //      recipe's real image_url onto contents[].recipe — no new request,
    //      no invented URL)
    //   3. neutral emoji fallback (unchanged)
    const firstRecipeImage: string | null = (b.contents ?? [])
        .map((c: any) => c?.recipe?.image_url)
        .find((url: any) => typeof url === 'string' && url.trim().length > 0) || null;
    const cardImage: string | null = b.image_url || firstRecipeImage || null;

    return (
        <div className="overflow-hidden rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)]">
            {/* Correction 2: a native button — not a div with onClick — is the
                keyboard-reachable open control (Enter/Space open natively). The
                separate Add button below is a SIBLING, never nested inside this
                one, so no button-in-button structure exists. */}
            <button
                type="button"
                onClick={onOpen}
                aria-label={`View details for ${b.name}`}
                className="block w-full cursor-pointer text-left"
            >
                <div className="relative grid h-32 place-items-center bg-[var(--sf-soft)]">
                    {cardImage
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={cardImage} alt="" className="h-full w-full object-cover" />
                        : <span className="text-4xl" aria-hidden="true">🍲</span>}
                    {badge && <span className="absolute left-2.5 top-2.5 rounded-full bg-white/90 px-2 py-1 text-[9px] font-extrabold tracking-wide text-[var(--sf-primary)]">{badge}</span>}
                </div>
                <div className="px-3.5 pt-3.5">
                    <h3 className="font-serif text-base">{b.name}</h3>
                    {inside && <p className="mb-1.5 mt-0.5 text-[11px] leading-relaxed text-[var(--sf-muted)]">{inside}</p>}
                </div>
            </button>
            <div className="flex items-center gap-2 px-3.5 pb-3.5 pt-2">
                <span className="text-[15px] font-extrabold tabular-nums">${Number(b.price ?? 0).toFixed(0)}</span>
                <span className="text-[10px] text-[var(--sf-muted)]">
                    {mealCount > 0 ? <>· {mealCount} meals </> : null}· {servesLabel(b.serving_tier)}
                </span>
                <button
                    type="button"
                    onClick={onAdd}
                    aria-label={added ? `${b.name} added to your bag` : `Add ${b.name} to your bag`}
                    className={`ml-auto rounded-xl px-3.5 py-2 text-xs font-extrabold transition active:scale-95 ${
                        added ? 'bg-[var(--sf-sage)] text-white' : 'bg-[var(--sf-primary)] text-[var(--sf-on-primary)]'}`}
                >
                    {added ? '✓ Added' : 'Add'}
                </button>
            </div>
        </div>
    );
}
