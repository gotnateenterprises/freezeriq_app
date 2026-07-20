'use client';

/**
 * SF-2: three compact how-it-works chips, shown to FIRST-TIME visitors only
 * (the caller owns that conditional). Replaces the legacy StorefrontHowItWorks
 * section in the landing flow — exact approved copy and token classes.
 */
const STEPS = [
    { e: '🛒', t: 'Order by Wed', s: 'pick your meals' },
    { e: '👩‍🍳', t: 'We cook fresh', s: 'small batches' },
    { e: '🧊', t: 'Stock & relax', s: 'dinner in 25 min' },
];

export function HowItWorksChips() {
    return (
        <div className="flex gap-2 px-4 pt-3">
            {STEPS.map(x => (
                <div key={x.t} className="flex-1 rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] px-2 py-2.5 text-center">
                    <div className="text-lg">{x.e}</div>
                    <b className="block text-[11px]">{x.t}</b>
                    <span className="text-[10px] text-[var(--sf-muted)]">{x.s}</span>
                </div>
            ))}
        </div>
    );
}
