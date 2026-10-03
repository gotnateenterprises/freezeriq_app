"use client";

/**
 * FR-ORG-DASHBOARD-1A — every campaign this organization has run, newest first.
 *
 * Closed rows read what was FROZEN (invoice lines, then the orders' own line
 * names); running rows say "so far". A missing record says so — "No sales data
 * recorded", "Bundles not recorded" — and is never rendered as a zero. Deeper
 * work happens in the Campaign Context drawer, not here: "View campaign" opens
 * it on the Campaigns dashboard.
 */

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { StageChip } from '@/components/crm2/StageChip';
import type { HistoryRow } from '@/lib/organizationDashboard';

const INVOICE_TONES: Record<string, string> = {
    good: 'text-emerald-700 dark:text-emerald-300',
    pending: 'text-indigo-700 dark:text-indigo-300',
    warn: 'text-rose-700 dark:text-rose-300',
    neutral: 'text-slate-600 dark:text-slate-300',
};

export function CampaignHistoryList({ rows }: { rows: HistoryRow[] }) {
    return (
        <ol className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:gap-4">
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h3 className="break-words text-[15px] font-black text-slate-900 dark:text-white">{r.name}</h3>
                            <StageChip status={r.status} bundleSelectionStatus={r.bundleSelectionStatus} closedAt={r.closedAt} />
                            {/* DATA-CLEANUP-GUARDS-1: kept on the record, never counted as a run. */}
                            {r.isSetupAttempt && (
                                <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:text-slate-400">
                                    Not run
                                </span>
                            )}
                        </div>
                        <p className="mt-0.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">{r.dateLabel}</p>

                        {r.metricsLabel ? (
                            <p className="mt-2 text-sm font-bold text-slate-800 dark:text-slate-100">{r.metricsLabel}</p>
                        ) : (
                            <p className="mt-2 text-sm font-bold text-slate-400 dark:text-slate-500">No sales data recorded</p>
                        )}

                        {r.bundleFamilies.length > 0 ? (
                            <ul aria-label="Bundles" className="mt-2 flex flex-wrap gap-1.5">
                                {r.bundleFamilies.map((f) => (
                                    <li key={f} className="rounded-lg bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                        {f}
                                    </li>
                                ))}
                            </ul>
                        ) : r.bundleNote ? (
                            <p className="mt-2 text-[11px] font-bold text-slate-400 dark:text-slate-500">{r.bundleNote}</p>
                        ) : null}

                        {(r.shareLabel || r.invoiceLabel) && (
                            <p className="mt-2.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                                {r.shareLabel && (
                                    <>Organization share: <b className="font-bold text-slate-800 dark:text-slate-100">{r.shareLabel}</b></>
                                )}
                                {r.shareLabel && r.invoiceLabel && ' · '}
                                {r.invoiceLabel && (
                                    <>Invoice: <b className={`font-bold ${INVOICE_TONES[r.invoiceTone ?? 'neutral'] ?? INVOICE_TONES.neutral}`}>{r.invoiceLabel}</b></>
                                )}
                            </p>
                        )}
                    </div>
                    <Link
                        href={`/fundraisers?campaign=${r.id}`}
                        aria-label={`View campaign — ${r.name}`}
                        className="inline-flex min-h-[44px] items-center gap-1 self-start whitespace-nowrap rounded-xl px-2 text-xs font-bold text-indigo-600 transition-colors hover:bg-indigo-50 hover:text-indigo-800 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                    >
                        View campaign <ChevronRight size={13} aria-hidden="true" />
                    </Link>
                </li>
            ))}
        </ol>
    );
}
