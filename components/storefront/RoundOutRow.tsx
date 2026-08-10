'use client';

/**
 * SF-4: faithful port of the handoff `RoundOutRow` — the bag-step suggestion
 * strip ("Round out your freezer week").
 *
 * ELIGIBILITY IS THE DOCUMENTED RULE AND NOTHING MORE. `selectRoundOutBundles`
 * below is the whole ranking system: active, storefront-visible, not already in
 * the bag, cheapest first, at most three. No affinity, no personalisation, no
 * invented "recommended for you" — the handoff specifies the cheapest eligible
 * bundles and that is exactly what ships.
 *
 * The handoff also suggests preferring a sides/desserts category. That is NOT
 * implemented, because it cannot be: bundles carry no category field (categories
 * exist only on recipes), the same constraint SF-3 already recorded for its
 * pairing candidate. Inventing a category proxy would be fabricated ranking.
 *
 * Renders nothing when no bundle qualifies, so an empty strip can never appear.
 */

/** The bag contract requires a serving_tier; a bundle without one cannot be added. */
function isAddable(b: any): boolean {
    return Boolean(b) && typeof b.id === 'string' && Boolean(b.serving_tier) && Number.isFinite(Number(b.price));
}

/**
 * The three cheapest bundles a customer could sensibly add from the bag.
 *
 * `bundles` is the tenant-scoped storefront payload — it arrives already
 * filtered to this business, so tenant isolation is inherited rather than
 * re-implemented here. `show_on_storefront` is re-checked anyway: it is the
 * tenant's own "customers may see this" switch and is cheap to honour twice.
 * `is_active` MUST be checked here, because the storefront payload does not
 * filter on it.
 */
export function selectRoundOutBundles(bundles: any[], bundleIdsInBag: Set<string>, limit = 3): any[] {
    if (!Array.isArray(bundles)) return [];
    return bundles
        .filter((b) =>
            isAddable(b)
            && b.is_active !== false
            && b.show_on_storefront !== false
            && !bundleIdsInBag.has(b.id))
        .sort((a, b) => Number(a.price) - Number(b.price))
        .slice(0, Math.max(0, limit));
}

/** Same image precedence as SF-3's BundleCard, so a suggestion never looks foreign. */
function bundleImage(b: any): string | null {
    if (b?.image_url) return b.image_url;
    const fromRecipe = (b?.contents ?? []).find((c: any) => c?.recipe?.image_url)?.recipe?.image_url;
    return fromRecipe || null;
}

export function RoundOutRow({ addOns, onAdd, addedIds }: {
    addOns: any[];
    onAdd: (b: any) => void;
    addedIds: Set<string>;
}) {
    if (!addOns.length) return null;
    return (
        <section aria-labelledby="sf4-roundout-heading" className="-mx-6">
            <h3
                id="sf4-roundout-heading"
                className="px-6 pt-1 text-[10px] font-extrabold uppercase tracking-widest text-[var(--sf-muted)]"
            >
                Round out your freezer week
            </h3>
            <ul
                className="flex gap-2.5 overflow-x-auto px-6 py-2"
                style={{ scrollbarWidth: 'none' }}
            >
                {addOns.map((b) => {
                    const img = bundleImage(b);
                    const added = addedIds.has(b.id);
                    return (
                        <li key={b.id} className="w-36 flex-none rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] p-2.5">
                            <div className="grid h-14 place-items-center overflow-hidden rounded-xl bg-[var(--sf-soft)] text-xl">
                                {img
                                    ? <img src={img} alt="" className="h-full w-full rounded-xl object-cover" />
                                    : <span aria-hidden="true">🍲</span>}
                            </div>
                            {/* Clamped: a long bundle name must not stretch the
                                card and break the horizontal strip. NOTE: no `block`
                                utility here — `line-clamp-2` supplies its own
                                `display: -webkit-box`, and `block` would override it
                                and silently render the clamp inert. */}
                            <b className="mt-1.5 text-[11px] font-bold leading-tight text-[var(--sf-ink)] line-clamp-2">{b.name}</b>
                            <span className="text-[10px] text-[var(--sf-muted)]">${Number(b.price).toFixed(0)}</span>
                            <button
                                type="button"
                                onClick={() => onAdd(b)}
                                aria-label={added ? `${b.name} added to your bag` : `Add ${b.name} to your bag`}
                                className={`mt-1.5 min-h-[44px] w-full rounded-lg py-1.5 text-[11px] font-extrabold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sf-primary)] ${
                                    added
                                        ? 'bg-[var(--sf-sage)] text-white'
                                        : 'bg-[var(--sf-soft)] text-[var(--sf-primary)]'
                                }`}
                            >
                                {added ? '✓ Added' : '+ Add'}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
