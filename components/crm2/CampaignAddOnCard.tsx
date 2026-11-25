"use client";

/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S2) — the campaign's "Supporter Add-On", in the Campaign Context drawer.
 *
 * The tenant chooses None or one eligible add-on bundle for THIS fundraiser and sets what the organization
 * earns on it — a campaign-specific schedule, independent of the meal share (shown for reference):
 *
 *     1–10 sold → [10] %
 *     11+ sold  → [15] %        [+ Add tier]
 *
 * Tiers are shown as ranges, never as "starting quantity". A tier the fundraiser's sold add-ons have
 * reached is LOCKED (its rate already paid real sales); new tiers start above the units already sold.
 * The server (app/api/campaigns/[id]/add-on) decides all of it — this card only reflects and asks.
 * Read-only when the campaign is closed out or the signed-in user is not an administrator.
 * Supporters see the add-on itself (S4). The share is shown to them only when "Show this share on the
 * supporter page" is ticked AND the schedule has one tier; tier rows, sales and earnings never are.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, Lock, Plus, Trash2 } from 'lucide-react';
import {
    describeShareTierRanges,
    formatPercent,
    parseShareTierSchedule,
    type ShareTierLock,
} from '@/lib/campaignAddOnShare';

interface TierRow {
    startingQuantity: number;
    percent: number;
    rangeLabel: string;
    lock: ShareTierLock;
}

interface AddOnView {
    campaignId: string;
    closed: boolean;
    mealSharePercent: number;
    addOn: null | {
        bundleId: string;
        name: string;
        price: number;
        sellable: boolean;
        tiers: TierRow[];
        next: { nextUnit: number; percent: number; nextTierStart: number | null; nextTierPercent: number | null };
        /** S4: show the share % on the supporter page (single-tier schedules only). */
        showSharePercent?: boolean;
        publicSupportPercent?: number | null;
    };
    /** B2: a removed add-on — not offered — whose share schedule is kept and resumes when one is offered again. */
    removedAddOn?: null | {
        name: string;
        removedAt: string | null;
        tiers: TierRow[];
        next: { nextUnit: number; percent: number; nextTierStart: number | null; nextTierPercent: number | null };
    };
    /** ACTIVE add-ons sold (non-canceled orders). */
    unitsSold: number;
    /** B1: lifetime tier positions (canceled orders keep theirs) — drives locks; never shown as sales. */
    tierPositionsReached?: number;
    tierProgressNote?: string | null;
    grossSales: number;
    earnedShare: number;
    eligibleBundles: Array<{ id: string; name: string; price: number }>;
    unavailableBundles: Array<{ id: string; name: string; reason: string }>;
    canManage: boolean;
}

interface DraftTier {
    key: number;
    start: string;
    percent: string;
}

const LABEL = 'text-[11px] font-black uppercase tracking-widest text-slate-400';
const INPUT = 'w-20 min-h-[40px] rounded-lg border border-slate-200 bg-white px-2 text-sm font-bold text-slate-900 tabular-nums dark:border-slate-700 dark:bg-slate-900 dark:text-white';
const BTN = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50';
const PRIMARY = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-indigo-600 text-xs font-black text-white hover:bg-indigo-700 transition-colors disabled:opacity-50';

const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;

let draftKey = 0;
const toDraft = (tiers: TierRow[]): DraftTier[] =>
    tiers.map((t) => ({ key: ++draftKey, start: String(t.startingQuantity), percent: String(t.percent) }));

export function CampaignAddOnCard({ campaignId }: { campaignId: string }) {
    const [view, setView] = useState<AddOnView | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [choice, setChoice] = useState('');
    const [draft, setDraft] = useState<DraftTier[]>([]);

    const accept = useCallback((v: AddOnView) => {
        setView(v);
        setDraft(v.addOn ? toDraft(v.addOn.tiers) : []);
        setChoice('');
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadFailed(false);
        fetch(`/api/campaigns/${campaignId}/add-on`, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((v: AddOnView) => { if (!cancelled) accept(v); })
            .catch(() => { if (!cancelled) setLoadFailed(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [campaignId, accept]);

    async function send(method: 'PUT' | 'DELETE' | 'PATCH', body: unknown, success: string) {
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/add-on`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                setError(data?.error || 'That change could not be saved.');
                return;
            }
            accept(data as AddOnView);
            setNotice(success);
        } catch {
            setError('Network error — please try again.');
        } finally {
            setSaving(false);
        }
    }

    const unitsSold = view?.unitsSold ?? 0;
    // B1: tier locks and the next position follow the campaign's LIFETIME tier positions (canceled orders keep
    // theirs), which can be higher than the active quantity sold. Older servers without it: the sold count.
    const positionsReached = Math.max(unitsSold, view?.tierPositionsReached ?? unitsSold);
    const editable = Boolean(view && view.canManage && !view.closed);

    // The draft, parsed by the SAME rule the server applies, so ranges and problems show as you type.
    const parsedDraft = useMemo(() => parseShareTierSchedule(
        draft.map((d) => ({ startingQuantity: d.start, percent: d.percent })),
    ), [draft]);
    const draftRows = useMemo(
        () => (parsedDraft.ok ? describeShareTierRanges(parsedDraft.tiers, positionsReached) : null),
        [parsedDraft, positionsReached],
    );
    const savedKey = view?.addOn ? JSON.stringify(view.addOn.tiers.map((t) => [t.startingQuantity, t.percent])) : '';
    const draftKeyStr = parsedDraft.ok ? JSON.stringify(parsedDraft.tiers.map((t) => [t.startingQuantity, t.percent])) : 'invalid';
    const draftChanged = savedKey !== draftKeyStr;

    if (loading) {
        return (
            <div className="space-y-2">
                <p className={LABEL}>Supporter Add-On</p>
                <p className="flex items-center gap-2 text-xs font-bold text-slate-400">
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Loading add-on…
                </p>
            </div>
        );
    }
    if (loadFailed || !view) {
        return (
            <div className="space-y-2">
                <p className={LABEL}>Supporter Add-On</p>
                <p className="text-xs font-bold text-slate-400">Couldn&apos;t load the add-on for this fundraiser.</p>
            </div>
        );
    }

    const addOn = view.addOn;
    // The lock state for each draft row comes from the SAVED schedule: a row is locked only if the saved
    // tier with that start has been reached. New rows are always editable.
    const savedLock = new Map((addOn?.tiers ?? []).map((t) => [t.startingQuantity, t.lock]));

    return (
        <section aria-labelledby={`addon-${campaignId}`} className="space-y-2">
            <p id={`addon-${campaignId}`} className={LABEL}>Supporter Add-On</p>
            <div className="rounded-2xl border border-slate-100 dark:border-slate-800 p-4 space-y-3">
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                    Main meal share: {formatPercent(view.mealSharePercent)}
                </p>

                {addOn ? (
                    <div className="space-y-1">
                        <p className="text-sm font-black text-slate-900 dark:text-white break-words">
                            {addOn.name} <span className="font-bold text-slate-500">— {money(addOn.price)}</span>
                        </p>
                        <p className="text-xs font-bold text-slate-600 dark:text-slate-300">
                            {unitsSold} add-on{unitsSold === 1 ? '' : 's'} sold
                            {view.earnedShare > 0 && <> · {money(view.earnedShare)} earned for the organization</>}
                        </p>
                        {view.tierProgressNote && (
                            <p data-addon-tier-progress="true" className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                {view.tierProgressNote}
                            </p>
                        )}
                        {!addOn.sellable && (
                            <p className="text-xs font-bold text-amber-700 dark:text-amber-400">
                                This bundle is turned off, so it can&apos;t be added to orders right now.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="space-y-1">
                        <p className="text-sm font-bold text-slate-600 dark:text-slate-300">No add-on</p>
                        {view.removedAddOn && (
                            <div data-addon-removed="true" className="space-y-1">
                                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 break-words">
                                    {view.removedAddOn.name} was removed. Its organization share schedule and tier progress are kept,
                                    and they resume when you offer an add-on on this fundraiser again.
                                </p>
                                {(unitsSold > 0 || view.earnedShare > 0) && (
                                    <p className="text-xs font-bold text-slate-600 dark:text-slate-300">
                                        {unitsSold} add-on{unitsSold === 1 ? '' : 's'} sold
                                        {view.earnedShare > 0 && <> · {money(view.earnedShare)} earned for the organization</>}
                                    </p>
                                )}
                                {view.tierProgressNote && (
                                    <p data-addon-tier-progress="true" className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                        {view.tierProgressNote}
                                    </p>
                                )}
                                <ul className="space-y-0.5" aria-label="Kept add-on share schedule">
                                    {view.removedAddOn.tiers.map((t) => (
                                        <li key={t.startingQuantity} className="text-xs font-bold text-slate-600 dark:text-slate-300 tabular-nums">
                                            {t.rangeLabel} → {formatPercent(t.percent)}
                                            {t.lock !== 'editable' && <span className="ml-1 text-[10px] font-black uppercase tracking-wide text-slate-400">Locked</span>}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}

                {/* Choose / change / remove */}
                {editable && (
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-[11px] font-bold text-slate-500 min-w-0 flex-1">
                            {addOn ? 'Change to' : 'Offer an add-on'}
                            <select
                                value={choice}
                                onChange={(e) => setChoice(e.target.value)}
                                className="min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                            >
                                <option value="">{addOn ? '— keep current —' : 'None'}</option>
                                {view.eligibleBundles
                                    .filter((b) => b.id !== addOn?.bundleId)
                                    .map((b) => <option key={b.id} value={b.id}>{b.name} — {money(b.price)}</option>)}
                                {view.unavailableBundles.map((b) => (
                                    <option key={b.id} value="" disabled>{b.name} — {b.reason}</option>
                                ))}
                            </select>
                        </label>
                        <button
                            type="button"
                            className={PRIMARY}
                            disabled={saving || !choice}
                            onClick={() => send(
                                'PUT',
                                { bundleId: choice },
                                addOn
                                    ? 'Add-on changed. Its share schedule continues.'
                                    : view.removedAddOn
                                        ? 'Add-on offered again. Its share schedule resumes where it left off.'
                                        : 'Add-on offered on this fundraiser.',
                            )}
                        >
                            {addOn ? 'Change add-on' : 'Offer add-on'}
                        </button>
                        {addOn && (
                            <button
                                type="button"
                                className={BTN}
                                disabled={saving}
                                onClick={() => {
                                    if (!window.confirm(`Remove ${addOn.name} from this fundraiser? Supporters won't be offered it. Orders already placed keep their add-on and what it earned, and the share schedule is kept for when you offer an add-on again.`)) return;
                                    send('DELETE', undefined, 'Add-on removed. Its share schedule is kept.');
                                }}
                            >
                                <Trash2 size={13} aria-hidden="true" /> Remove
                            </button>
                        )}
                    </div>
                )}
                {editable && !addOn && view.eligibleBundles.length === 0 && (
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        No add-on bundles yet. In <Link href="/bundles" className="font-bold text-indigo-600 hover:underline">Bundles</Link>,
                        create a bundle and set its type to &quot;Fundraiser add-on&quot;.
                    </p>
                )}

                {/* The organization's share on the add-on */}
                {addOn && (
                    <div className="space-y-2 pt-1">
                        <p className="text-xs font-black text-slate-700 dark:text-slate-200">Organization share on add-on</p>
                        <ul className="space-y-2">
                            {draft.map((d, i) => {
                                const startNum = Number(d.start);
                                const lock: ShareTierLock = savedLock.get(startNum) ?? 'editable';
                                const locked = lock !== 'editable';
                                const row = draftRows?.find((r) => r.startingQuantity === startNum);
                                const label = row?.rangeLabel ?? (i === 0 ? '1+ sold' : `${d.start || '?'}+ sold`);
                                return (
                                    <li key={d.key} className="flex flex-wrap items-center gap-2">
                                        {i === 0 || locked || !editable ? (
                                            <span className="min-w-[6.5rem] text-sm font-bold text-slate-700 dark:text-slate-200 tabular-nums">{label}</span>
                                        ) : (
                                            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
                                                From add-on
                                                <input
                                                    className={INPUT}
                                                    inputMode="numeric"
                                                    aria-label={`Tier ${i + 1} starts at add-on number`}
                                                    value={d.start}
                                                    onChange={(e) => setDraft((p) => p.map((x) => x.key === d.key ? { ...x, start: e.target.value } : x))}
                                                />
                                            </label>
                                        )}
                                        <span aria-hidden="true" className="text-slate-400">→</span>
                                        {locked || !editable ? (
                                            <span className="text-sm font-black text-slate-900 dark:text-white tabular-nums">{formatPercent(Number(d.percent))}</span>
                                        ) : (
                                            <label className="flex items-center gap-1 text-sm font-bold text-slate-600">
                                                <input
                                                    className={INPUT}
                                                    inputMode="decimal"
                                                    aria-label={`Share for ${label}, percent`}
                                                    value={d.percent}
                                                    onChange={(e) => setDraft((p) => p.map((x) => x.key === d.key ? { ...x, percent: e.target.value } : x))}
                                                />
                                                %
                                            </label>
                                        )}
                                        {lock === 'locked' && (
                                            <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-500 dark:bg-slate-800">
                                                <Lock size={10} aria-hidden="true" /> Locked
                                            </span>
                                        )}
                                        {lock === 'locked_for_sold' && (
                                            <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-500 dark:bg-slate-800">
                                                <Lock size={10} aria-hidden="true" /> Locked for add-ons already sold
                                            </span>
                                        )}
                                        {editable && !locked && i > 0 && (
                                            <button
                                                type="button"
                                                className="inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-lg text-slate-400 hover:text-rose-600"
                                                aria-label={`Remove the tier for ${label}`}
                                                onClick={() => setDraft((p) => p.filter((x) => x.key !== d.key))}
                                            >
                                                <Trash2 size={14} aria-hidden="true" />
                                            </button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>

                        {editable && (
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    className={BTN}
                                    disabled={saving || draft.length >= 10}
                                    onClick={() => setDraft((p) => {
                                        const starts = p.map((x) => Number(x.start)).filter((n) => Number.isInteger(n));
                                        const next = Math.max(positionsReached + 1, (starts.length ? Math.max(...starts) : 0) + 10);
                                        return [...p, { key: ++draftKey, start: String(next), percent: p[p.length - 1]?.percent ?? String(view.mealSharePercent) }];
                                    })}
                                >
                                    <Plus size={13} aria-hidden="true" /> Add tier
                                </button>
                                {draftChanged && (
                                    <>
                                        <button
                                            type="button"
                                            className={PRIMARY}
                                            disabled={saving || !parsedDraft.ok}
                                            onClick={() => parsedDraft.ok && send('PATCH', { tiers: parsedDraft.tiers }, 'Add-on share saved.')}
                                        >
                                            {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : null} Save share
                                        </button>
                                        <button type="button" className={BTN} disabled={saving} onClick={() => setDraft(toDraft(addOn.tiers))}>
                                            Undo
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                        {editable && draftChanged && !parsedDraft.ok && (
                            <p className="text-xs font-bold text-rose-700 dark:text-rose-400">{parsedDraft.error}</p>
                        )}
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                            Add-on #{addOn.next.nextUnit} earns {formatPercent(addOn.next.percent)}
                            {addOn.next.nextTierStart !== null && addOn.next.nextTierPercent !== null && (
                                <> · {formatPercent(addOn.next.nextTierPercent)} from add-on #{addOn.next.nextTierStart}</>
                            )}
                            . Reaching a new tier never changes what earlier add-ons earned.
                        </p>

                        {/* S4: the tenant decides, per fundraiser, whether supporters see the share %. */}
                        <label className="flex items-start gap-2 pt-1 text-xs font-bold text-slate-700 dark:text-slate-200">
                            <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 shrink-0"
                                checked={addOn.showSharePercent === true}
                                disabled={!editable || saving}
                                onChange={(e) => send(
                                    'PATCH',
                                    { showSharePercent: e.target.checked },
                                    e.target.checked ? 'Supporters will see the add-on share.' : 'The add-on share is hidden from supporters.',
                                )}
                            />
                            <span className="min-w-0">
                                Show this share on the supporter page
                                <span className="block font-medium text-slate-500 dark:text-slate-400">
                                    {addOn.tiers.length === 1
                                        ? `Supporters see “Your purchase also helps the organization earn ${formatPercent(addOn.tiers[0].percent)} on this add-on.”`
                                        : 'Only shown while the share has one tier. With more than one tier, supporters see general wording instead.'}
                                </span>
                            </span>
                        </label>
                    </div>
                )}

                {view.closed && (
                    <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                        Closed out — the add-on and its share are final.
                    </p>
                )}
                {!view.closed && !view.canManage && (
                    <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                        Only an administrator can change the add-on or its share.
                    </p>
                )}
                {error && <p role="alert" className="text-xs font-bold text-rose-700 dark:text-rose-400">{error}</p>}
                {notice && !error && <p role="status" className="text-xs font-bold text-emerald-700 dark:text-emerald-400">{notice}</p>}
            </div>
        </section>
    );
}
