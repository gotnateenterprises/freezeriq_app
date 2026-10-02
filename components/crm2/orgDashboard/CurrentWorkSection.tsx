"use client";

/**
 * FR-ORG-DASHBOARD-1A — what is in progress, and what to open next.
 *
 * Three different things, never conflated:
 *   · a FundraiserCampaign that is running   → "Current fundraiser", its stage chip
 *   · a FundraiserOpportunity being planned  → "Next fundraiser", Planning/Inquiry
 *   · a closed campaign with an unpaid invoice → "Next step", the invoice wording
 *
 * Renders nothing when none of them exist — the header's Start Next Fundraiser
 * is then the next action. Discard draft appears only when the server's
 * eligibility rule said so (an empty, tenant-created planning draft).
 */

import Link from 'next/link';
import { ChevronRight, Receipt, Trash2 } from 'lucide-react';
import { StageChip } from '@/components/crm2/StageChip';
import type { CurrentOpportunityCard, OrganizationDashboard } from '@/lib/organizationDashboard';

const LABEL = 'text-[11px] font-black uppercase tracking-widest text-slate-400';
const CARD = 'rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 sm:p-5 dark:border-indigo-900/60 dark:bg-indigo-950/20';
const PRIMARY = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-xs font-black text-white shadow-sm transition-colors hover:bg-indigo-700';
const SECONDARY = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800';
const DISCARD = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3.5 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-900 dark:bg-slate-900 dark:text-rose-300 dark:hover:bg-rose-950/40';

const CHIP_TONES: Record<CurrentOpportunityCard['chipTone'], string> = {
    sky: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
    amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
};

const INVOICE_TONES: Record<string, string> = {
    good: 'text-emerald-700 dark:text-emerald-300',
    pending: 'text-indigo-700 dark:text-indigo-300',
    warn: 'text-rose-700 dark:text-rose-300',
    neutral: 'text-slate-600 dark:text-slate-300',
};

export function CurrentWorkSection({
    current,
    onDiscardDraft,
}: {
    current: OrganizationDashboard['current'];
    onDiscardDraft: (opportunity: CurrentOpportunityCard) => void;
}) {
    const { campaigns, opportunity, invoiceFollowUps } = current;
    if (campaigns.length === 0 && !opportunity && invoiceFollowUps.length === 0) return null;

    return (
        <section aria-label="In progress" className="space-y-3">
            {campaigns.map((c) => (
                <div key={c.id} className={CARD}>
                    <p className={`${LABEL} mb-2`}>Current fundraiser</p>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="break-words text-[15px] font-black text-slate-900 dark:text-white">{c.name}</h2>
                                <StageChip status={c.status} bundleSelectionStatus={c.bundleSelectionStatus} closedAt={c.closedAt} />
                            </div>
                            <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">{c.dateLine}</p>
                            <p className="mt-0.5 text-xs font-bold text-slate-700 dark:text-slate-200">{c.figuresLine}</p>
                        </div>
                        <Link href={`/fundraisers?campaign=${c.id}`} className={PRIMARY}>
                            Open fundraiser <ChevronRight size={14} aria-hidden="true" />
                        </Link>
                    </div>
                </div>
            ))}

            {opportunity && (
                <div className={CARD}>
                    <p className={`${LABEL} mb-2`}>Next fundraiser</p>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-[15px] font-black text-slate-900 dark:text-white">{opportunity.title}</h2>
                                <span className={`inline-flex items-center rounded-lg border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${CHIP_TONES[opportunity.chipTone]}`}>
                                    {opportunity.chipLabel}
                                </span>
                            </div>
                            {opportunity.lines.map((line, i) => (
                                <p
                                    key={i}
                                    className={i === 0
                                        ? 'mt-1 text-xs font-bold text-slate-700 dark:text-slate-200'
                                        : 'mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400'}
                                >
                                    {line}
                                </p>
                            ))}
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Link href="/fundraisers?tab=leads" className={PRIMARY}>
                                Continue setup <ChevronRight size={14} aria-hidden="true" />
                            </Link>
                            {opportunity.discard.eligible && (
                                <button type="button" onClick={() => onDiscardDraft(opportunity)} className={DISCARD}>
                                    <Trash2 size={14} aria-hidden="true" /> Discard draft
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {invoiceFollowUps.map((f) => (
                <div key={f.campaignId} className={CARD}>
                    <p className={`${LABEL} mb-2`}>Next step</p>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                            <h2 className="break-words text-[15px] font-black text-slate-900 dark:text-white">{f.campaignName}</h2>
                            <p className={`mt-1 text-xs font-bold ${INVOICE_TONES[f.tone] ?? INVOICE_TONES.neutral}`}>{f.label}</p>
                        </div>
                        <Link href="/invoices" className={SECONDARY}>
                            <Receipt size={14} aria-hidden="true" /> Review invoice
                        </Link>
                    </div>
                </div>
            ))}
        </section>
    );
}
