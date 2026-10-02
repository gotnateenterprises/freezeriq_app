"use client";

/**
 * FR-ORG-DASHBOARD-1A — the snapshot row: four facts, one helper line each.
 *
 * Every figure arrives already decided by lib/organizationDashboard.ts; this
 * component only lays them out. Four-up on desktop, two-by-two below `lg`.
 */

import { DollarSign, Flag, Mail, Users } from 'lucide-react';
import type { DashboardKpis } from '@/lib/organizationDashboard';

export function OrgKpiRow({ kpis }: { kpis: DashboardKpis }) {
    const cards = [
        {
            key: 'sales',
            Icon: DollarSign,
            tile: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
            label: 'Lifetime Fundraiser Sales',
            value: kpis.lifetimeSalesLabel,
            helper: kpis.lifetimeSalesHelper,
        },
        {
            key: 'campaigns',
            Icon: Flag,
            tile: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300',
            label: 'Campaigns Run',
            value: kpis.campaignsRun.toLocaleString('en-US'),
            helper: kpis.campaignsHelper,
        },
        {
            key: 'supporters',
            Icon: Users,
            tile: 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
            label: 'Supporters on File',
            value: kpis.supportersOnFile.toLocaleString('en-US'),
            helper: kpis.supportersHelper,
        },
        {
            key: 'email',
            Icon: Mail,
            tile: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
            label: 'Email-Ready',
            value: kpis.emailReady.toLocaleString('en-US'),
            helper: kpis.emailReadyHelper,
        },
    ];

    return (
        <section aria-label="Organization snapshot" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {cards.map(({ key, Icon, tile, label, value, helper }) => (
                <div
                    key={key}
                    className="min-w-0 rounded-3xl border border-slate-100 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-800 dark:bg-slate-900"
                >
                    <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-xl ${tile}`}>
                        <Icon size={16} aria-hidden="true" />
                    </div>
                    <p className="mb-1 break-words text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                        {label}
                    </p>
                    <p className="text-2xl font-black tabular-nums text-slate-900 dark:text-white">{value}</p>
                    {helper && (
                        <p className="mt-1 text-[11px] font-medium leading-snug text-slate-500 dark:text-slate-400">{helper}</p>
                    )}
                </div>
            ))}
        </section>
    );
}
