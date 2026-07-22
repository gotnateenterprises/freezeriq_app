'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ServingToggle } from './ServingToggle';
import { PairingSuggestion } from './PairingSuggestion';
import { servesLabel } from './BundleCard';

/**
 * SF-3: bundle detail view — the Fable prototype detail screen composed as an
 * accessible modal (dimg image block · serif title · meta chips · ServingToggle
 * when a complete real family exists · dashed meal rows · direct Add · at most
 * one PairingSuggestion). Everything rendered is real payload data; the tier
 * selection swaps to that exact bundle's id/name/image/contents/price/tier.
 * Replaces the legacy regular-bundle meals popup composition; it never mutates
 * recipe data and uses only the existing cart contract via the onAdd callback.
 */
export function BundleDetail({
    family,
    initialId,
    onClose,
    onAdd,
    isAdded,
    pairing,
    onAddPairing,
    pairingAdded,
}: {
    /** 1 or 2 REAL tiers of one family (never synthesized). */
    family: any[];
    initialId: string;
    onClose: () => void;
    /** Direct add of the given bundle via the existing cart contract. */
    onAdd: (bundle: any) => void;
    isAdded: (bundleId: string) => boolean;
    /** Grounded pairing candidate or null. */
    pairing?: any | null;
    onAddPairing?: () => void;
    pairingAdded?: boolean;
}) {
    const [activeId, setActiveId] = useState(initialId);
    const active = family.find(b => b.id === activeId) || family[0];

    // Correction 3: Escape closes the detail. Hook order stays unconditional
    // (before the early-return below) per the Rules of Hooks.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    if (!active) return null;

    // Correction 3: never invent a placeholder "Meal" name — render only rows
    // with a real, non-empty recipe name. The meal-count chip reflects the
    // same filtered set so the displayed count always matches what's shown.
    const validContents = Array.isArray(active.contents)
        ? active.contents.filter((c: any) => typeof c?.recipe?.name === 'string' && c.recipe.name.trim().length > 0)
        : [];
    const mealCount = validContents.length;
    const added = isAdded(active.id);

    return (
        <div className="fixed inset-0 z-[200] flex items-end justify-center sm:items-center">
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="sf-bundle-detail-title"
                className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-[var(--sf-card)] sm:rounded-3xl"
            >
                {/* dimg */}
                <div className="relative grid h-44 flex-none place-items-center bg-[var(--sf-soft)]">
                    {active.image_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={active.image_url} alt={active.name} className="h-full w-full object-cover" />
                        : <span className="text-5xl" aria-hidden="true">🍲</span>}
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-[var(--sf-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--sf-primary)]"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-4 pb-4 pt-4">
                    <h2 id="sf-bundle-detail-title" className="m-0 font-serif text-[1.45rem] font-normal text-[var(--sf-ink)]">
                        {active.name}
                    </h2>

                    {/* meta chips */}
                    <div className="my-2 flex flex-wrap gap-1.5">
                        {mealCount > 0 && (
                            <span className="rounded-full bg-[var(--sf-soft)] px-2.5 py-1 text-[10px] font-bold text-[var(--sf-ink)]">{mealCount} meals</span>
                        )}
                        <span className="rounded-full bg-[var(--sf-soft)] px-2.5 py-1 text-[10px] font-bold text-[var(--sf-ink)]">{servesLabel(active.serving_tier)}</span>
                    </div>

                    {/* one card, both sizes — renders only for a complete real family */}
                    <ServingToggle
                        family={family as any}
                        active={activeId}
                        onPick={setActiveId}
                    />

                    {/* inside list — only real, named recipes; no invented rows */}
                    {mealCount > 0 && (
                        <ul className="my-2 list-none p-0">
                            {validContents.map((c: any, idx: number) => (
                                <li key={idx} className="flex items-center gap-2.5 border-b border-dashed border-[var(--sf-line)] py-2 text-sm last:border-b-0">
                                    <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-[var(--sf-soft)] text-[0.95rem]" aria-hidden="true">🍽️</span>
                                    <span className="min-w-0 text-[var(--sf-ink)]">{c.recipe.name}</span>
                                    {c?.recipe?.container_type && (
                                        <span className="ml-auto whitespace-nowrap text-[11px] text-[var(--sf-muted)]">{c.recipe.container_type}</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* direct add — real tier id, real price */}
                    <button
                        type="button"
                        onClick={() => onAdd(active)}
                        className={`mt-2 w-full rounded-2xl px-4 py-3.5 text-sm font-extrabold transition active:scale-[0.98] ${
                            added ? 'bg-[var(--sf-sage)] text-white' : 'bg-[var(--sf-primary)] text-[var(--sf-on-primary)]'}`}
                    >
                        {added ? '✓ Added to your bag' : `Add · ${servesLabel(active.serving_tier)} — $${Number(active.price ?? 0).toFixed(0)}`}
                    </button>

                    {pairing && onAddPairing && (
                        <PairingSuggestion bundle={pairing} onAdd={onAddPairing} added={Boolean(pairingAdded)} />
                    )}
                </div>
            </div>
        </div>
    );
}
