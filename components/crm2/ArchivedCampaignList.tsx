'use client';

/**
 * CRM-ARCHIVED-VIEW-1 — the "Archived" tab on the Campaigns dashboard.
 *
 * Discoverability, not a new work queue: CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1
 * already made archived campaigns disappear from every operational bucket via
 * lib/growth/nextAction.ts's triageCampaign/isArchivedForDashboard. That
 * exclusion is exactly why this can't reuse CampaignPriorityList — passing
 * archived rows into groupCampaignsByPriority would just filter them straight
 * back out (triage.priority is null for anything isArchivedForDashboard() is
 * true for). So this is its own small, read-only list: no sections, no
 * primary action, no overflow menu, no health badge — just enough to find
 * the fundraiser again and open its real history.
 *
 * The membership test below reuses isArchivedForDashboard directly. There is
 * one authority for "is this archived" in this codebase; this file is a
 * second READER of it, never a second definition.
 */

import Link from 'next/link';
import { format } from 'date-fns';
import { Archive, Loader2 } from 'lucide-react';
import { isArchivedForDashboard } from '@/lib/growth/nextAction';

export interface ArchivedListCampaign {
    id: string;
    name: string;
    customer_id: string;
    customer: { name: string; contact_name?: string | null };
    status: string;
    end_date?: string | null;
    settlement_total?: number | string | null;
    sales_total?: number;
    weighted_bundles_sold?: number;
    organization_archived?: boolean | null;
}

/** Same search predicate every other pill already applies, plus the one archive authority. */
export function filterArchivedCampaigns<
    T extends { name: string; customer: { name: string }; status: string; organization_archived?: boolean | null },
>(campaigns: T[], searchTerm: string): T[] {
    const term = searchTerm.toLowerCase();
    return campaigns.filter((c) =>
        isArchivedForDashboard(c)
        && (c.name.toLowerCase().includes(term) || c.customer.name.toLowerCase().includes(term)));
}

/** Part E — a truthful, low-effort distinction between the two real archive signals. */
export function archivedReasonLabel(c: { status: string; organization_archived?: boolean | null }): string {
    return c.status === 'Archived' ? 'Archived fundraiser' : 'Organization archived';
}

export function ArchivedCampaignList({
    campaigns,
    loading,
}: {
    /** Already search-scoped via filterArchivedCampaigns. */
    campaigns: ArchivedListCampaign[];
    loading: boolean;
}) {
    if (loading) {
        // CRM-CC-5's own loading vocabulary, matching CampaignPriorityList.
        return (
            <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm px-5 py-16 text-center text-slate-400 font-bold flex items-center justify-center gap-2">
                <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading campaigns…
            </div>
        );
    }

    if (campaigns.length === 0) {
        return (
            <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm px-5 py-16 text-center text-slate-400 font-bold">
                No archived fundraisers.
            </div>
        );
    }

    return (
        <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm divide-y divide-slate-50 dark:divide-slate-700/50">
            {campaigns.map((c) => {
                const end = c.end_date ? new Date(c.end_date) : null;
                const endValid = end && !Number.isNaN(end.getTime());
                // Frozen gross once closeout ran; the running total otherwise. No
                // new calculation — both are already on the row.
                const gross = c.settlement_total != null ? Number(c.settlement_total) : Number(c.sales_total ?? 0);
                return (
                    <div key={c.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4">
                        <div className="min-w-0 flex-1">
                            {/* Part G — reuses the existing organization-history
                                destination, the same one CampaignPriorityList's own
                                "View organization" menu item points at. No new
                                archive detail page. */}
                            <Link
                                href={`/fundraisers/${c.customer_id}`}
                                className="font-bold text-sm text-slate-900 dark:text-white leading-snug break-words hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline"
                            >
                                {c.name}
                            </Link>
                            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 break-words">
                                {c.customer.name}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-bold text-slate-500 dark:text-slate-400">
                            <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                <Archive size={11} aria-hidden="true" />
                                {archivedReasonLabel(c)}
                            </span>
                            {endValid && <span>{format(end!, 'MMM d, yyyy')}</span>}
                            {gross > 0 && (
                                <span>${gross.toLocaleString(undefined, { maximumFractionDigits: 0 })} gross</span>
                            )}
                            {(c.weighted_bundles_sold ?? 0) > 0 && (
                                <span>{c.weighted_bundles_sold} bundles</span>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
