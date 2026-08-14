'use client';

/**
 * GE-4 — organization fundraiser impact. CRM-CC-3 — Command Center alignment.
 *
 * Answers, per relationship: WHO is this group, HOW valuable and active is the
 * relationship, WHEN did we last work together, and WHAT can I do next. Rows
 * are genuinely useful — the whole row links to the organization profile, and
 * every row carries one labeled action — instead of informational-only.
 *
 * LANGUAGE RULES THIS SCREEN FOLLOWS (GE-4, unchanged):
 *  · "Sales" means gross — what buyers paid. It is never called "raised".
 *  · The headline number is LIFETIME FUNDRAISER SALES: eligible campaign-linked
 *    gross to date, open campaigns included. "Settled" is the smaller frozen
 *    subset and is shown as subtext, never as the headline.
 *  · The group's own share is shown as "Est." because it is derived from a
 *    single global 20% rate, not a per-tenant agreement.
 *  · Sorting is by a plain factual measure. No blended score, no rebook claim.
 *
 * CRM-CC-3 deliberately DROPPED the Average and Best columns: they are
 * secondary analytics that made the table read as a spreadsheet. The averages
 * still exist server-side for any future detail surface.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, Loader2, Repeat } from 'lucide-react';
import { money, settledNote, lastFundraiserDisplay } from '@/lib/growth/organizationUi';

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
    lastCampaignName: string | null;
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

const SORTS: { key: Sort; label: string }[] = [
    { key: 'lifetime_sales', label: 'Lifetime sales' },
    { key: 'most_recent', label: 'Most recent' },
    { key: 'campaign_count', label: 'Campaigns run' },
];

function RepeatBadge() {
    return (
        <span className="inline-flex flex-none items-center gap-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            <Repeat size={10} aria-hidden="true" /> Repeat
        </span>
    );
}

/** WHAT the last fundraiser was, and WHEN — quiet when there is no history. */
function LastFundraiser({ r }: { r: Row }) {
    const last = lastFundraiserDisplay(r);
    if (!last) return <span className="text-xs font-bold text-slate-300 dark:text-slate-600">—</span>;
    return (
        <div className="min-w-0">
            {last.name && (
                <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate">{last.name}</p>
            )}
            <p className="text-[11px] font-bold text-slate-400">{last.when}</p>
        </div>
    );
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
                <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading organization history…
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm py-14 px-6 text-center">
                <p className="font-bold text-slate-500">Could not load organization history.</p>
                <p className="mt-1 text-xs text-slate-400">{error}</p>
            </div>
        );
    }

    const withHistory = rows.filter(r => r.campaignCount > 0);

    return (
        <div className="space-y-5">
            {totals && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm py-14 px-6 text-center">
                    <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                        No fundraiser history yet — once a group runs a campaign, its history appears here.
                    </p>
                </div>
            ) : (
                <>
                    {/* Desktop rows — lg and up, matching the Campaigns list's
                        breakpoint so tablets get stacked cards, never a squeeze. */}
                    <div className="hidden lg:block bg-white dark:bg-slate-800 rounded-3xl overflow-hidden border border-slate-100 dark:border-slate-700 shadow-sm">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-700">
                                    <th className="px-5 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Organization</th>
                                    <th className="px-4 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Campaigns</th>
                                    <th className="px-4 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Lifetime fundraiser sales</th>
                                    <th className="px-4 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Last fundraiser</th>
                                    <th className="px-4 py-3"><span className="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                                {withHistory.map(r => (
                                    <tr key={r.organizationId} className="hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                                        <td className="px-5 py-4">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <Building2 size={14} className="text-slate-400 flex-none" aria-hidden="true" />
                                                <Link
                                                    href={`/fundraisers/${r.organizationId}`}
                                                    className="font-bold text-sm text-slate-900 dark:text-white truncate hover:text-indigo-600 dark:hover:text-indigo-400"
                                                >
                                                    {r.organizationName}
                                                </Link>
                                                {r.isRepeatOrganization && <RepeatBadge />}
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
                                            <p className="text-[11px] font-bold text-slate-400">
                                                Est. {money(r.estimatedGroupEarnings)} to the group
                                                {settledNote(r) && <> · {settledNote(r)}</>}
                                            </p>
                                        </td>
                                        <td className="px-4 py-4">
                                            <LastFundraiser r={r} />
                                        </td>
                                        <td className="px-4 py-4 text-right">
                                            <Link
                                                href={`/fundraisers/${r.organizationId}`}
                                                aria-label={`View organization — ${r.organizationName}`}
                                                className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-950/60 transition-colors whitespace-nowrap"
                                            >
                                                View organization
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Stacked cards below lg — the money stays the headline. */}
                    <div className="lg:hidden space-y-3">
                        {withHistory.map(r => (
                            <div key={r.organizationId} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 p-4 space-y-2.5">
                                <div className="flex items-start justify-between gap-3">
                                    <p className="font-black text-slate-900 dark:text-white text-sm leading-tight break-words">{r.organizationName}</p>
                                    {r.isRepeatOrganization && <RepeatBadge />}
                                </div>
                                <div>
                                    <p className="text-xl font-black tabular-nums text-slate-900 dark:text-white">{money(r.lifetimeFundraiserSales)}</p>
                                    <p className="text-[11px] font-bold text-slate-400">
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
                                    {lastFundraiserDisplay(r) && (
                                        <span>
                                            {lastFundraiserDisplay(r)!.name
                                                ? `${lastFundraiserDisplay(r)!.name} · ${lastFundraiserDisplay(r)!.when}`
                                                : lastFundraiserDisplay(r)!.when}
                                        </span>
                                    )}
                                </div>
                                <Link
                                    href={`/fundraisers/${r.organizationId}`}
                                    aria-label={`View organization — ${r.organizationName}`}
                                    className="inline-flex w-full items-center justify-center min-h-[44px] px-4 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-950/60 transition-colors"
                                >
                                    View organization
                                </Link>
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
