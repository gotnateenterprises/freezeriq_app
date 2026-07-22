'use client';

import { isServes2Tier } from './BundleCard';

/**
 * SF-3: faithful port of the handoff ServingToggle / prototype `.sizetog`.
 * Renders ONLY when BOTH real tiers of a family exist — never a disabled fake
 * option for a missing sibling. Selecting a tier reports that tier's REAL
 * bundle id back to the caller; toggling never adds anything to the cart.
 */
export function ServingToggle({ family, active, onPick }: {
    family: Array<{ id: string; serving_tier: string; price: number }>;
    active: string;
    onPick: (id: string) => void;
}) {
    const five = family.find(b => !isServes2Tier(b.serving_tier));
    const two = family.find(b => isServes2Tier(b.serving_tier));
    if (!five || !two) return null;

    const Opt = ({ b, label, note }: { b: { id: string; price: number }; label: string; note: string }) => (
        <button
            onClick={() => onPick(b.id)}
            aria-pressed={active === b.id}
            className={`flex-1 rounded-xl px-2 py-2.5 text-xs font-bold transition ${
                active === b.id ? 'bg-[var(--sf-card)] text-[var(--sf-ink)] shadow-sm' : 'text-[var(--sf-muted)]'}`}
        >
            {label} <span className="block text-[10px] font-semibold text-[var(--sf-muted)]">${Number(b.price).toFixed(0)} · {note}</span>
        </button>
    );

    return (
        <div className="my-3 flex rounded-2xl bg-[var(--sf-soft)] p-1" role="group" aria-label="Choose a serving size">
            <Opt b={five} label="Serves 5" note="family night" />
            <Opt b={two} label="Serves 2" note="date night" />
        </div>
    );
}
