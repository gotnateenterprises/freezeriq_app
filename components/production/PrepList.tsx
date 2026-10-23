"use client";

import { useMemo, useState } from 'react';
import { RefreshCw, Printer, ChefHat, CheckSquare, ArrowRight, CheckCircle2 } from 'lucide-react';
import { toFraction } from '@/lib/unit_converter';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { physicalMealCount } from '@/lib/mealManifest';
import { servingTierLabel } from '@/lib/mealLabel';
import { writePrintBatch, fetchAuthenticatedBusinessId } from '@/lib/printBatchStorage';
// PREP-WAVES-1: a fundraiser's orders are started / marked packed BY ID, through the exact-id
// route, one wave at a time. The aggregate cards below stay as the kitchen's combined view.
// See lib/prepWaves.ts for why the bundle-wide action this file used to send is gone.
import {
    buildPrepModel,
    buildPrepStatusRequest,
    describePrepAction,
    describePrepFailure,
    prepConfirmMessage,
    prepLaneOf,
    prepRowKey,
    resolveWaveSelection,
    rowBreakdown,
    rowOrdinaryOrderIds,
    waveMealLabelItems,
    PREP_ACTION_LABEL,
    type PrepAction,
    type PrepCampaigns,
    type PrepLaneKey,
    type PrepRow,
} from '@/lib/prepWaves';
import { toggleWaves, type FundraiserWave } from '@/lib/packedReadyWaves';
import PrepWavePanel from '@/components/production/PrepWavePanel';

interface PrepItem {
    bundle_id: string;
    bundle_name: string;
    sku: string;
    total_quantity: number;
    order_count: number;
    /** OPS-5A: the sold tier this prep row was ordered at, from the Kitchen Board. */
    variant_size?: string | null;
    // Phase 5H-0: canonical status values expected from API. Legacy APPROVED and
    // IN_PRODUCTION handling is kept in the bucket normalization below in case
    // cached API responses still carry legacy values during the transition period.
    status: 'production_ready' | 'in_production' | string;
    recipes: { id: string, name: string, quantity: number }[];
    /** PREP-WAVES-1: the exact orders behind this row's numbers. */
    sources?: PrepRow['sources'];
}

interface PrepListProps {
    items: any[]; // Raw items from API
    /** PREP-WAVES-1: label data for the campaigns behind those items, keyed by FundraiserCampaign.id. */
    campaigns?: PrepCampaigns | null;
    onRefresh: () => void;
}

export default function PrepList({ items, campaigns, onRefresh }: PrepListProps) {
    const router = useRouter();
    const { data: session } = useSession() as { data: any };
    const [isPrinting, setIsPrinting] = useState(false);

    // PREP-WAVES-1: the lanes' distinct orders and fundraiser waves, derived from the rows the
    // server just sent — never carried over from an earlier render, so a refresh cannot leave
    // stale arithmetic or a stale scope on screen.
    const model = useMemo(() => buildPrepModel(items as PrepRow[], campaigns), [items, campaigns]);
    // Selected ORDER ids per lane (the same shape Packed & Ready uses). An id whose order left the
    // lane is pruned when the selection is resolved, so a stale tick is never sent.
    const [selReady, setSelReady] = useState<Set<string>>(new Set());
    const [selInprod, setSelInprod] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);

    // Phase 5F: normalize grouping key so both canonical and legacy status values
    // land in the same bucket. production_ready and APPROVED are both "ready to prep";
    // in_production and IN_PRODUCTION are both "being cooked".
    const groups = items.reduce((acc, item) => {
        const bucket = prepLaneOf(item.status);
        if (!acc[bucket]) acc[bucket] = [];
        acc[bucket].push(item);
        return acc;
    }, {} as Record<string, PrepItem[]>);

    const approvedItems  = groups['ready']  || [];
    const productionItems = groups['inprod'] || [];

    const handlePrint = async () => {
        setIsPrinting(true);
        setTimeout(() => {
            window.print();
            setIsPrinting(false);
        }, 500);
    };

    const handlePrintLabels = async (item: PrepItem) => {
        // OPS-5E: no client session gate. This used to refuse the click
        // outright when useSession()'s businessId had not resolved -- the same
        // unreliable dependency that silently killed the Manual Planner's
        // batch print (OPS-5B/OPS-5C proved it twice). The storage key now
        // comes from the shared authority and never depends on it.
        if (!item.recipes || !Array.isArray(item.recipes)) {
            console.error("❌ Label Print Error: No recipes found for bundle", item);
            toast.error("No recipe data found for this bundle.");
            return;
        }

        // OPS-5A: the physical package count comes from the ONE shared
        // authority, not from an inline multiplication here. Both print-batch
        // writers must agree on what "how many labels" means, and the formula
        // (order quantity x bundle-content quantity, never the serving
        // multiplier) lives in lib/mealManifest.ts.
        const tier = servingTierLabel(item.variant_size);
        const batch = {
            name: `Production: ${item.bundle_name}`,
            servingTier: tier,
            items: item.recipes.map(r => {
                const count = physicalMealCount(item.total_quantity, r.quantity);
                return {
                    id: r.id,
                    name: r.name,
                    qty: count,
                    unit: 'ea',
                    copies: count,
                    servingTier: tier
                };
            })
        };

        // OPS-5F: stamped with the SERVER-authenticated tenant, never the
        // client session value, so the print page can verify ownership.
        const ownerBusinessId = await fetchAuthenticatedBusinessId();
        if (!ownerBusinessId) {
            toast.error('Your business could not be confirmed. Please reload and sign in again.');
            return;
        }

        const written = writePrintBatch({ ...batch, businessId: ownerBusinessId });
        if (!written.ok) {
            toast.error(written.reason);
            return;
        }
        router.push('/production/print-batch');
    };

    /**
     * PREP-WAVES-1 — meal labels for ONE fundraiser's orders.
     *
     * The same count authority as the card print (`physicalMealCount`), applied to the units THIS
     * fundraiser contributes to each bundle rather than the card's cross-campaign total. Printing
     * is read-only: it queues recipe ids and counts and changes no order.
     */
    const handlePrintWaveLabels = async (wave: FundraiserWave) => {
        const labelItems = waveMealLabelItems(items as PrepRow[], wave, 'inprod');
        if (labelItems.length === 0) {
            toast.error('No meals were found for this fundraiser.');
            return;
        }

        const ownerBusinessId = await fetchAuthenticatedBusinessId();
        if (!ownerBusinessId) {
            toast.error('Your business could not be confirmed. Please reload and sign in again.');
            return;
        }

        const written = writePrintBatch({ name: `Production: ${wave.label}`, items: labelItems, businessId: ownerBusinessId });
        if (!written.ok) {
            toast.error(written.reason);
            return;
        }
        router.push('/production/print-batch');
    };

    /**
     * PREP-WAVES-1 — move EXACT orders through the existing exact-id route.
     *
     * Sends order ids and the target status and nothing else: no bundle id, no "current status"
     * predicate, no campaign. The server re-reads every id, refuses foreign / canceled / illegal
     * ones and writes all-or-nothing under a per-row compare-and-set, so a refusal means nothing
     * moved. On any refusal the lanes are reloaded — never retried against a broader query.
     */
    const postStatus = async (action: PrepAction, orderIds: string[]) => {
        const request = buildPrepStatusRequest(action, orderIds);
        if (!request) {
            toast.error('Nothing is selected, so nothing was changed.');
            return;
        }

        setBusy(true);
        try {
            const res = await fetch('/api/orders/bulk-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            });

            if (res.ok) {
                toast.success('Status Updated');
                const moved = new Set(request.orderIds);
                const without = (s: Set<string>) => new Set([...s].filter((id) => !moved.has(id)));
                setSelReady(without);
                setSelInprod(without);
                onRefresh();
            } else {
                const problem = await res.json().catch(() => null);
                const failure = describePrepFailure(res.status, problem?.code);
                toast.error(failure.message);
                if (failure.stale) onRefresh();
            }
        } catch (e) {
            toast.error("An error occurred");
        } finally {
            setBusy(false);
        }
    };

    /** A fundraiser action: ONLY the ticked waves' orders, resolved from the lane the operator is looking at. */
    const runWaveAction = async (laneKey: PrepLaneKey, action: PrepAction) => {
        const lane = model[laneKey];
        const { orderIds } = resolveWaveSelection(lane, laneKey === 'ready' ? selReady : selInprod);
        if (orderIds.length === 0) {
            toast.error('Choose at least one fundraiser first. Nothing is selected, so nothing was changed.');
            return;
        }
        if (!confirm(prepConfirmMessage(describePrepAction(action, orderIds, lane)))) return;
        await postStatus(action, orderIds);
    };

    /**
     * A card action: ONLY that card's non-fundraiser orders. A fundraiser's orders that share the
     * bundle are never in this set, so the card cannot advance them — they start from the
     * fundraiser list.
     */
    const runCardAction = async (row: PrepItem, action: PrepAction) => {
        const orderIds = rowOrdinaryOrderIds(row as PrepRow, model);
        if (orderIds.length === 0) {
            toast.error('There are no orders on this card that this button can start.');
            return;
        }
        if (!confirm(prepConfirmMessage(describePrepAction(action, orderIds, model[prepLaneOf(row.status)])))) return;
        await postStatus(action, orderIds);
    };

    const toggleWavesIn = (laneKey: PrepLaneKey, waves: FundraiserWave[]) => {
        const set = laneKey === 'ready' ? setSelReady : setSelInprod;
        set((prev) => toggleWaves(prev, waves));
    };

    /** What a card says about who is behind its number, and which button (if any) it may carry. */
    const cardFacts = (item: PrepItem) => {
        const parts = rowBreakdown(item as PrepRow, model);
        const ordinaryIds = rowOrdinaryOrderIds(item as PrepRow, model);
        return { parts, ordinaryIds, hasFundraiser: parts.some((p) => p.campaignId !== null) };
    };

    const breakdownChips = (parts: ReturnType<typeof rowBreakdown>, tone: 'amber' | 'emerald') => (
        <div className="flex flex-wrap gap-1.5 mb-4" data-prep-breakdown="">
            {parts.map((p) => (
                <span
                    key={p.campaignId ?? 'other'}
                    className={
                        'px-2 py-1 rounded-lg text-[11px] font-bold '
                        + (tone === 'amber'
                            ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300'
                            : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-300')
                    }
                >
                    {p.label}
                    {p.disambiguator && <span className="ml-1 opacity-60">#{p.disambiguator}</span>}
                    {p.deliveryDateLabel ? ` · ${p.deliveryDateLabel}` : ''}
                    {' · '}{p.units}
                </span>
            ))}
        </div>
    );

    if (items.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-12 bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 text-center animate-in fade-in">
                <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mb-4 text-amber-600">
                    <ChefHat size={32} />
                </div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white">Nothing to Prep</h3>
                <p className="text-slate-500 max-w-xs mt-2">Approve orders from New Orders to populate the prep list.</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4">
            {/* Header / Print */}
            <div className="flex justify-between items-center bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm print:hidden">
                <div>
                    <h2 className="text-2xl font-black text-slate-900 dark:text-white">Kitchen Prep List</h2>
                    <p className="text-slate-500 font-medium">{items.reduce((acc, i) => acc + i.total_quantity, 0)} total units active</p>
                </div>
                <button
                    onClick={handlePrint}
                    className="flex items-center gap-2 bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-6 py-3 rounded-2xl font-bold hover:bg-slate-800 transition-colors shadow-lg shadow-slate-200 dark:shadow-none"
                >
                    <Printer size={20} />
                    Print Sheet
                </button>
            </div>

            {/* Section 1: To Prep (APPROVED) */}
            {(approvedItems.length > 0 || model.ready.waves.length > 0) && (
                <div className="space-y-4">
                    <h3 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
                        <div className="w-2 h-6 bg-amber-500 rounded-full" />
                        To Prep
                    </h3>

                    {/* PREP-WAVES-1: the action surface for fundraiser food. */}
                    <PrepWavePanel
                        lane={model.ready}
                        selected={selReady}
                        heading="Fundraisers ready to start"
                        helper="Tick the fundraisers you are starting. Each one moves as whole orders — every bundle in them — and nothing you leave unticked changes."
                        actionLabel={PREP_ACTION_LABEL.start_prep}
                        tone="amber"
                        busy={busy}
                        onToggle={(waves) => toggleWavesIn('ready', waves)}
                        onClear={() => setSelReady(new Set())}
                        onAction={() => runWaveAction('ready', 'start_prep')}
                    />

                    {model.ready.waves.length > 0 && (
                        <p className="text-xs font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 print:hidden">
                            Kitchen totals — every fundraiser and order combined
                        </p>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 print:grid-cols-2 print:gap-4">
                        {approvedItems.map((item: PrepItem) => {
                            const { parts, ordinaryIds, hasFundraiser } = cardFacts(item);
                            return (
                            <div key={prepRowKey(item)} className="bg-white dark:bg-slate-800 p-6 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm relative overflow-hidden group hover:border-amber-200 dark:hover:border-amber-900/50 transition-colors print:break-inside-avoid print:border-slate-300">
                                <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                                    <ChefHat size={64} className="text-amber-500 transform rotate-12" />
                                </div>
                                <div className="relative z-10">
                                    <div className="flex justify-between items-start mb-4">
                                        <span className="px-3 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg text-xs font-black uppercase tracking-widest">
                                            {item.sku}
                                        </span>
                                        <span className="text-xs font-bold text-slate-400">
                                            {item.order_count} Orders
                                        </span>
                                    </div>
                                    <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2 leading-tight">
                                        {item.bundle_name}
                                    </h3>
                                    <div className="flex items-end gap-2 mb-3">
                                        <span className="text-4xl font-black text-amber-600 dark:text-amber-500">
                                            {item.total_quantity}
                                        </span>
                                        <span className="text-lg font-bold text-slate-400 mb-1">units</span>
                                    </div>
                                    {hasFundraiser ? breakdownChips(parts, 'amber') : <div className="mb-3" />}
                                    {ordinaryIds.length > 0 ? (
                                        <button
                                            onClick={() => runCardAction(item, 'start_prep')}
                                            disabled={busy}
                                            className="w-full flex items-center justify-center gap-2 bg-slate-100 dark:bg-slate-700 hover:bg-emerald-500 hover:text-white dark:hover:bg-emerald-600 text-slate-600 dark:text-slate-300 py-3 rounded-xl font-bold transition-all print:hidden group-hover:bg-emerald-50 dark:group-hover:bg-emerald-900/20 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 disabled:opacity-50"
                                        >
                                            <ArrowRight size={18} />
                                            {hasFundraiser
                                                ? `Start Prep — ${ordinaryIds.length} other ${ordinaryIds.length === 1 ? 'order' : 'orders'}`
                                                : 'Start Prep'}
                                        </button>
                                    ) : hasFundraiser ? (
                                        <p className="text-xs font-bold text-slate-400 text-center print:hidden">
                                            Start these from “Fundraisers ready to start”.
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Section 2: In Prep */}
            {(productionItems.length > 0 || model.inprod.waves.length > 0) && (
                <div className="space-y-4">
                    <h3 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
                        <div className="w-2 h-6 bg-emerald-500 rounded-full" />
                        In Prep
                    </h3>

                    <PrepWavePanel
                        lane={model.inprod}
                        selected={selInprod}
                        heading="Fundraisers in prep"
                        helper="Tick the fundraisers that are really packed. Each one moves as whole orders; mark them only when the food is boxed."
                        actionLabel={PREP_ACTION_LABEL.mark_packed}
                        tone="emerald"
                        busy={busy}
                        onToggle={(waves) => toggleWavesIn('inprod', waves)}
                        onClear={() => setSelInprod(new Set())}
                        onAction={() => runWaveAction('inprod', 'mark_packed')}
                        onWaveLabels={handlePrintWaveLabels}
                    />

                    {model.inprod.waves.length > 0 && (
                        <p className="text-xs font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 print:hidden">
                            Kitchen totals — every fundraiser and order combined
                        </p>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                        {productionItems.map((item: PrepItem) => {
                            const { parts, ordinaryIds, hasFundraiser } = cardFacts(item);
                            return (
                            <div key={prepRowKey(item)} className="bg-slate-50 dark:bg-slate-900/50 p-6 rounded-3xl border border-emerald-200 dark:border-emerald-900/30 shadow-sm relative overflow-hidden">
                                <div className="relative z-10">
                                    <div className="flex justify-between items-start mb-4">
                                        <span className="px-3 py-1 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-lg text-xs font-black uppercase tracking-widest">
                                            {item.sku}
                                        </span>
                                        <span className="text-xs font-bold text-emerald-600/60">
                                            In Prep
                                        </span>
                                    </div>
                                    <h3 className="text-xl font-black text-slate-900 dark:text-white mb-2 leading-tight">
                                        {item.bundle_name}
                                    </h3>
                                    <div className="flex gap-2 mb-3">
                                        <div className="flex-1">
                                            <span className="text-4xl font-black text-emerald-600 dark:text-emerald-500">
                                                {item.total_quantity}
                                            </span>
                                            <span className="text-lg font-bold text-slate-400 ml-2">units</span>
                                        </div>
                                        <button
                                            onClick={() => handlePrintLabels(item)}
                                            className="p-3 bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-all shadow-sm"
                                            title="Print Labels for all meals in this bundle"
                                        >
                                            <Printer size={20} />
                                        </button>
                                    </div>
                                    {hasFundraiser ? breakdownChips(parts, 'emerald') : <div className="mb-3" />}
                                    {ordinaryIds.length > 0 ? (
                                        <button
                                            onClick={() => runCardAction(item, 'mark_packed')}
                                            disabled={busy}
                                            className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white hover:bg-emerald-700 py-3 rounded-xl font-bold transition-all shadow-lg shadow-emerald-200 dark:shadow-none disabled:opacity-50"
                                        >
                                            <CheckCircle2 size={18} />
                                            {hasFundraiser
                                                ? `Mark Packed & Ready — ${ordinaryIds.length} other ${ordinaryIds.length === 1 ? 'order' : 'orders'}`
                                                : 'Mark Packed & Ready'}
                                        </button>
                                    ) : hasFundraiser ? (
                                        <p className="text-xs font-bold text-slate-400 text-center">
                                            Mark these from “Fundraisers in prep”.
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
