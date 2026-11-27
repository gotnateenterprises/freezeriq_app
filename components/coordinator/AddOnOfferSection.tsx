'use client';

/**
 * FR-ADDON-LAUNCH-FLOW-1 (owner-approved 2026-11-25) — the optional add-on on the coordinator's setup screen.
 *
 * Shown only when the tenant set one up for this fundraiser (GET /api/coordinator/bundle-selection →
 * addOnOffer). Separate from the meal bundle choice, below it, and never counted in it.
 *
 *   coordinator_choice  the coordinator decides: two explicit choices, neither pre-selected (D2). The setup
 *                       cannot be confirmed until one is chosen.
 *   included            the tenant included it: the same facts, informational only — nothing to accept.
 *
 * Every figure is the server's current authoritative one: the add-on's real name, image, price (the same basis
 * as the meal cards, D7), its meals, and the organization's earning schedule in plain words. When every tier is
 * 0% the copy makes NO claim that the organization earns more from it.
 *
 * Display and one answer only: a coordinator cannot pick a different add-on, change its price or its
 * percentages. The server re-checks the answer against the current offer under the campaign lock.
 */

export interface CoordinatorAddOnOffer {
    bundleId: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    price: number;
    meals: string[];
    shareSummary: string;
    shareTiers: Array<{ rangeLabel: string; percent: number }>;
    earnsShare: boolean;
    mode: 'included' | 'coordinator_choice';
    decision: 'accepted' | 'declined' | null;
}

export type CoordinatorAddOnAnswer = 'accepted' | 'declined';

export const ADDON_YES_LABEL = 'Yes! Include this optional offer in our fundraiser.';
export const ADDON_NO_LABEL = "No thanks. We'll offer meal bundles only.";

function money(n: number): string {
    return `$${(Number(n) || 0).toFixed(2)}`;
}

export function addOnOfferHeading(offer: Pick<CoordinatorAddOnOffer, 'mode' | 'earnsShare'>): string {
    if (offer.mode === 'included') return 'An optional add-on is included in your fundraiser';
    return offer.earnsShare ? 'Help your organization earn even more!' : 'A tasty bonus for your supporters';
}

export function addOnOfferIntro(offer: Pick<CoordinatorAddOnOffer, 'mode' | 'earnsShare' | 'name'>): string {
    if (offer.mode === 'included') {
        return `Your organizer has included ${offer.name}, a fun extra your supporters can add to their freezer meal order.`;
    }
    return offer.earnsShare
        ? `Offer our ${offer.name}, a fun extra your supporters can add to their freezer meal order. It gives them a little something more to enjoy, and every one sold raises even more for your organization.`
        : `Offer our ${offer.name}, a fun extra your supporters can add to their freezer meal order. It gives them a little something more to enjoy.`;
}

export function AddOnOfferSection({
    offer,
    answer,
    onAnswer,
    disabled,
}: {
    offer: CoordinatorAddOnOffer;
    answer: CoordinatorAddOnAnswer | null;
    onAnswer: (next: CoordinatorAddOnAnswer) => void;
    disabled?: boolean;
}) {
    const choosing = offer.mode === 'coordinator_choice';
    const groupName = `addon-answer-${offer.bundleId}`;
    return (
        <section
            aria-labelledby="addon-offer-heading"
            data-addon-offer={offer.mode}
            className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 space-y-4"
        >
            <div className="space-y-1">
                <p className="text-[11px] font-black uppercase tracking-widest text-amber-700">Optional add-on</p>
                <h2 id="addon-offer-heading" className="text-base font-black text-slate-900 leading-snug">
                    {addOnOfferHeading(offer)}
                </h2>
                <p className="text-sm font-medium text-slate-700 leading-relaxed">{addOnOfferIntro(offer)}</p>
            </div>

            <div className="rounded-xl border border-amber-100 bg-white overflow-hidden">
                {offer.imageUrl ? (
                    // The add-on bundle's own image (a 4:5 poster when it came from the Poster Studio).
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={offer.imageUrl}
                        alt={offer.name}
                        className="block w-full max-h-72 object-contain bg-slate-50"
                    />
                ) : null}
                <div className="p-4 space-y-2 min-w-0">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="text-sm font-black text-slate-900 break-words">{offer.name}</span>
                        <span className="text-sm font-black text-slate-900 tabular-nums">{money(offer.price)}</span>
                    </p>
                    {offer.description ? (
                        <p className="text-xs font-medium text-slate-600 leading-relaxed break-words">{offer.description}</p>
                    ) : null}
                    {offer.meals.length > 0 && (
                        <div>
                            <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">Includes</p>
                            <ul className="mt-1 space-y-0.5" aria-label={`What ${offer.name} includes`}>
                                {offer.meals.map((m, i) => (
                                    <li key={`${i}-${m}`} className="text-xs font-semibold text-slate-700 break-words">• {m}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="rounded-lg bg-emerald-50 px-3 py-2">
                        <p className="text-[11px] font-black uppercase tracking-wide text-emerald-700">What your organization earns</p>
                        <p data-addon-share-summary="true" className="text-xs font-bold text-emerald-900">{offer.shareSummary}</p>
                        {offer.shareTiers.length > 1 && (
                            <ul className="mt-1 space-y-0.5" aria-label="Add-on earning schedule">
                                {offer.shareTiers.map((t) => (
                                    <li key={t.rangeLabel} className="text-[11px] font-semibold text-emerald-800 tabular-nums">
                                        {t.rangeLabel} → {Number(t.percent)}%
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <ul className="space-y-0.5 text-[11px] font-medium text-slate-500">
                        <li>Supporters can add it to any order that includes a meal bundle.</li>
                        <li data-addon-goal-note="true">
                            {offer.earnsShare
                                ? 'Add-ons earn money for your organization, but they won’t show up in your Bundles Sold count or on your fundraiser scoreboard.'
                                : 'Add-ons won’t show up in your Bundles Sold count or on your fundraiser scoreboard.'}
                        </li>
                    </ul>
                </div>
            </div>

            {choosing && (
                <fieldset className="space-y-2" aria-describedby="addon-offer-required">
                    <legend className="sr-only">Include the optional add-on?</legend>
                    {([
                        ['accepted', ADDON_YES_LABEL],
                        ['declined', ADDON_NO_LABEL],
                    ] as const).map(([value, label]) => {
                        const checked = answer === value;
                        return (
                            <label
                                key={value}
                                data-addon-answer={value}
                                className={`flex items-start gap-3 rounded-xl border-2 p-3 cursor-pointer transition-colors ${
                                    checked ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200 bg-white hover:border-indigo-300'
                                } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                            >
                                <input
                                    type="radio"
                                    name={groupName}
                                    value={value}
                                    checked={checked}
                                    disabled={disabled}
                                    onChange={() => onAnswer(value)}
                                    className="mt-0.5 h-4 w-4 shrink-0"
                                />
                                <span className="text-sm font-bold text-slate-900 leading-snug">{label}</span>
                            </label>
                        );
                    })}
                    <p id="addon-offer-required" className="text-[11px] font-medium text-slate-500">
                        {answer ? 'You can change this until you confirm your setup.' : 'Choose one to confirm your setup.'}
                    </p>
                </fieldset>
            )}
        </section>
    );
}
