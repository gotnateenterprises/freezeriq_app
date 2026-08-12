'use client';

/**
 * GE-4 — organization fundraiser impact.
 *
 * Fills the Organizations tab, which until now only pointed elsewhere. It
 * answers two questions the tenant could not previously ask: which groups have
 * been worth the most over time, and how much history exists with any one of
 * them.
 *
 * LANGUAGE RULES THIS SCREEN FOLLOWS:
 *  · "Sales" means gross — what buyers paid. It is never called "raised".
 *  · The headline number is LIFETIME FUNDRAISER SALES: eligible campaign-linked
 *    gross to date, open campaigns included. "Settled" is the smaller frozen
 *    subset and is shown as subtext, never as the headline, because a group
 *    whose campaign is still running is not worth $0.
 *  · The group's own share is shown as "Est." because it is derived from a
 *    single global 20% rate, not a per-tenant agreement.
 *  · Sorting is by a plain factual measure. There is no blended score and no
 *    claim about who is likely to rebook.
 */

import { useEffect, useState } from 'react';
import { Building2, Loader2, Repeat } from 'lucide-react';

type Sort = 'lifetime_sales' | 'most_recent' | 'campaign_count';

interface Row {
    organizationId: string;
    organizationName: string;
    campaignCount: number;
    settledCampaignCount: number;
    activeCampaignCount: number;
    lifetimeFundraiserSales: number;
    settledSales: number;
    estimatedGroupEarnings: number;
    averageCampaignSales: number | null;
    bestCampaignSales: number | null;
    lastCampaignAt: string | null;
    daysSinceLastCampaign: number | null;
    isRepeatOrganization: boolean;
    archived: boolean;
}

interface Totals {
    organizationCount: number;
    organizationsWithHistory: number;
    organizationsWithSales: number;
    repeatOrganizations: number;
    lifetimeFundraiserSales: number;
    settledSales: number;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const SORTS: { key: Sort; label: string }[] = [
    { key: 'lifetime_sales', label: 'Lifetime sales' },
    { key: 'most_recent', label: 'Most recent' },
    { key: 'campaign_count', label: 'Campaigns run' },
];

/** Settled subtext, shown only when it tells the reader something new. */
function settledNote(r: Row): string | null {
    if (r.lifetimeFundraiserSales <= 0) return null;
    if (r.settledSales >= r.lifetimeFundraiserSales) return 'all settled';
    if (r.settledSales <= 0) return 'none settled yet';
    return `${money(r.settledSales)} settled`;
}

/** "3 months ago" style, from a factual day count. */
function sinceLabel(days: number | null): string {
    if (days === null) return 'No campaigns yet';
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 60) return `${days} days ago`;
    const months = Math.round(days / 30);
    if (months < 24) return `${months} months ago`;
    return `${Math.round(days / 365)} years ago`;
}

export function OrganizationImpactTab() {
    const [rows, setRows] = useState<Row[]>([]);
    const [totals, setTotals] = useState<Totals | null>(null);
    const [sort, setSort] = useState<Sort>('lifetime_sales');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        fetch(`/api/growth/organizations?sort=${sort}`, { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || res.statusText);
                return data;
            })
            .then((data) => {
                if (!alive) return;
                setRows(data.organizations || []);
                setTotals(data.totals || null);
                setLoading(false);
            })
            .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
        return () => { alive = false; };
    }, [sort]);

    if (loading) {
        return (
            <div className="py-20 text-center text-slate-400 font-bold flex items-center justify-center gap-2">
                <Loader2 size={18} className="animate-spin" /> Loading organization history…
            </div>
        );
    }

    if (error) {
        return (
            <div className="glass-panel rounded-3xl border border-slate-100 dark:border-slate-700 py-14 px-6 text-center">
                <p className="font-bold text-slate-500">Could not load organization history.</p>
                <p className="mt-1 text-xs text-slate-400">{error}</p>
            </div>
        );
    }

    const withHistory = rows.filter(r => r.campaignCount > 0);

    return (
        <div className="space-y-6">
            {totals && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {[
                        { label: 'Organizations with history', value: String(totals.organizationsWithHistory), tone: '' },
                        { label: 'Repeat organizations', value: String(totals.repeatOrganizations), tone: 'text-emerald-600' },
                        { label: 'Lifetime fundraiser sales', value: money(totals.lifetimeFundraiserSales), tone: '' },
                    ].map(s => (
                        <div key={s.label} className="glass-panel p-4 rounded-2xl border border-slate-100 dark:border-slate-700">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{s.label}</p>
                            <p className={`text-2xl font-black tabular-nums ${s.tone}`}>{s.value}</p>
                        </div>
                    ))}
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Sort by</span>
                {SORTS.map(s => (
                    <button
                        key={s.key}
                        onClick={() => setSort(s.key)}
                        aria-pressed={sort === s.key}
                        className={`min-h-[44px] rounded-xl px-4 text-xs font-black uppercase tracking-wide transition-all ${
                            sort === s.key
                                ? 'bg-indigo-600 text-white'
                                : 'border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                    >
                        {s.label}
                    </button>
                ))}
            </div>

            {withHistory.length === 0 ? (
                <div className="glass-panel rounded-3xl border border-slate-100 dark:border-slate-700 py-14 px-6 text-center">
                    <p className="text-lg font-black text-slate-900 dark:text-white">No fundraiser history yet.</p>
                    <p className="mt-1 text-sm text-slate-500">Once a group runs a campaign, its history appears here.</p>
                </div>
            ) : (
                <>
                    {/* Desktop table */}
                    <div className="hidden md:block bg-white dark:bg-slate-800 rounded-[2.5rem] overflow-hidden border border-slate-100 dark:border-slate-700 shadow-xl shadow-slate-200/50 dark:shadow-none">
                        <div className="overflow-x-auto">
                            <table className="w-full text-left border-collapse">
                                <thead>
                                    <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-700">
                                        <th className="px-5 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Organization</th>
                                        <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Campaigns</th>
                                        <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Lifetime fundraiser sales</th>
                                        <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Average</th>
                                        <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Best</th>
                                        <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Last fundraiser</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                                    {withHistory.map(r => (
                                        <tr key={r.organizationId} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                                            <td className="px-5 py-4">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <Building2 size={14} className="text-slate-400 flex-none" aria-hidden="true" />
                                                    <span className="font-black text-sm text-slate-900 dark:text-white truncate">{r.organizationName}</span>
                                                    {r.isRepeatOrganization && (
                                                        <span className="inline-flex flex-none items-center gap-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                                                            <Repeat size={10} aria-hidden="true" /> Repeat
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-4 text-sm font-bold text-slate-600 dark:text-slate-300">
                                                {/* Stacked, not inline: "1" beside "1 active" scans as "11". */}
                                                <p className="tabular-nums">{r.campaignCount}</p>
                                                {r.activeCampaignCount > 0 && (
                                                    <p className="text-[10px] font-black uppercase tracking-wide text-emerald-600">
                                                        {r.activeCampaignCount} running now
                                                    </p>
                                                )}
                                            </td>
                                            <td className="px-4 py-4">
                                                <p className="font-black tabular-nums text-slate-900 dark:text-white">{money(r.lifetimeFundraiserSales)}</p>
                                                {/* Explicitly an estimate, and explicitly the group's share. */}
                                                <p className="text-[10px] font-bold text-slate-400">
                                                    Est. {money(r.estimatedGroupEarnings)} to the group
                                                    {settledNote(r) && <> · {settledNote(r)}</>}
                                                </p>
                                            </td>
                                            <td className="px-4 py-4 text-sm font-bold tabular-nums text-slate-600 dark:text-slate-300">
                                                {r.averageCampaignSales === null ? '—' : money(r.averageCampaignSales)}
                                            </td>
                                            <td className="px-4 py-4 text-sm font-bold tabular-nums text-slate-600 dark:text-slate-300">
                                                {r.bestCampaignSales === null ? '—' : money(r.bestCampaignSales)}
                                            </td>
                                            <td className="px-4 py-4 text-xs font-bold text-slate-500 whitespace-nowrap">
                                                {sinceLabel(r.daysSinceLastCampaign)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Mobile cards — the money stays the headline rather than
                        disappearing into a column the phone cannot reach. */}
                    <div className="md:hidden space-y-3">
                        {withHistory.map(r => (
                            <div key={r.organizationId} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 p-4 space-y-2">
                                <div className="flex items-start justify-between gap-3">
                                    <p className="font-black text-slate-900 dark:text-white text-sm leading-tight">{r.organizationName}</p>
                                    {r.isRepeatOrganization && (
                                        <span className="inline-flex flex-none items-center gap-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-700 dark:text-emerald-300">
                                            <Repeat size={10} aria-hidden="true" /> Repeat
                                        </span>
                                    )}
                                </div>
                                <div>
                                    <p className="text-xl font-black tabular-nums text-slate-900 dark:text-white">{money(r.lifetimeFundraiserSales)}</p>
                                    <p className="text-[10px] font-bold text-slate-400">
                                        lifetime fundraiser sales · est. {money(r.estimatedGroupEarnings)} to the group
                                        {settledNote(r) && <> · {settledNote(r)}</>}
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-slate-500">
                                    <span>{r.campaignCount} campaign{r.campaignCount === 1 ? '' : 's'}</span>
                                    {/* Without this, a group whose only campaign is still open
                                        shows $0 with nothing to say the money has not landed yet. */}
                                    {r.activeCampaignCount > 0 && (
                                        <span className="text-emerald-600">{r.activeCampaignCount} running now</span>
                                    )}
                                    {r.averageCampaignSales !== null && <span>avg {money(r.averageCampaignSales)}</span>}
                                    {r.bestCampaignSales !== null && <span>best {money(r.bestCampaignSales)}</span>}
                                    <span>{sinceLabel(r.daysSinceLastCampaign)}</span>
                                </div>
                            </div>
                        ))}
                    </div>

                    <p className="text-[11px] font-medium text-slate-400">
                        Lifetime fundraiser sales are gross order totals — what buyers paid —
                        across this group&rsquo;s campaigns, including campaigns still running.
                        Cancelled orders are excluded. &ldquo;Settled&rdquo; is the portion already
                        frozen by campaign closeout. The amount to the group is an estimate at the
                        standard 20% share, not a payout record.
                    </p>
                </>
            )}
        </div>
    );
}
