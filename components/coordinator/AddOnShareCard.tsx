'use client';

/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S2) — the coordinator's READ-ONLY view of the campaign's add-on.
 *
 * Name, price, how the organization earns on it (in plain words — no tier vocabulary), and how many have
 * sold. The tenant sets the add-on and its share; a coordinator cannot change either and is never asked
 * to pick or calculate a percentage. Paper orders record the add-on through "Add Offline Order", where
 * the server decides its share.
 */
export interface CoordinatorAddOn {
    bundleId: string;
    name: string;
    price: number;
    shareSummary: string;
    shareTiers: Array<{ rangeLabel: string; percent: number }>;
    /** ACTIVE add-ons sold (non-canceled orders). */
    unitsSold: number;
    /** B1: lifetime tier positions (canceled orders keep theirs) and the plain-words note when they differ. */
    tierPositionsReached?: number;
    tierProgressNote?: string | null;
    grossSales: number;
    earnedShare: number;
}

export function AddOnShareCard({ addOn }: { addOn: CoordinatorAddOn }) {
    return (
        <section aria-label="Optional add-on" className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
            <p className="text-[11px] font-black uppercase tracking-widest text-amber-700">Optional add-on</p>
            <p className="mt-1 text-sm font-black text-slate-900 break-words">
                {addOn.name} <span className="font-bold text-slate-500">— ${Number(addOn.price).toFixed(2)}</span>
            </p>
            <p className="mt-1 text-[13px] font-medium text-slate-700">{addOn.shareSummary}</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
                {addOn.unitsSold} add-on{addOn.unitsSold === 1 ? '' : 's'} sold · added to an order with at least one meal bundle
            </p>
            {addOn.tierProgressNote ? (
                <p data-addon-tier-progress="true" className="mt-1 text-xs font-semibold text-slate-600">{addOn.tierProgressNote}</p>
            ) : null}
        </section>
    );
}
