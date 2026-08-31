'use client';

/**
 * OPS-3 — FUNDRAISER ORDERS · WAITING.
 *
 * One card per CAMPAIGN, not per supporter order. A fundraiser accumulates
 * orders all season and the kitchen needs it as a single requirement; this
 * is that view, for the window between "orders are coming in" and "the
 * organization's invoice was paid".
 *
 * READ-ONLY BY DESIGN. There is no approve button, no release button, and no
 * status control here. A fundraiser leaves this lane exactly one way: its
 * invoice is recorded as PAID through the existing Record Payment workflow
 * (app/api/tenant/invoices/[id]/settle/route.ts), which promotes the held
 * orders and makes them appear in To Prep on the next refresh. Putting a
 * release control here would be a second, competing gate.
 *
 * PRIVACY: the API deliberately sends no supporter name, email, phone, or
 * address to this lane — a batch is bundles and counts. Individual supporter
 * identity stays where it already lives (the coordinator tracker and the
 * tenant's own order/CRM surfaces), and is not duplicated onto a kitchen board.
 */

import { PiggyBank, CalendarDays, Loader2 } from 'lucide-react';

export interface FundraiserWaitingLine {
    bundleId: string | null;
    bundleName: string;
    variantSize: string;
    servingTierLabel: string;
    quantity: number;
}

export interface FundraiserWaitingBatch {
    campaignId: string;
    campaignName: string;
    organizationName: string;
    deliveryDate: string | null;
    orderDeadline: string | null;
    orderCount: number;
    totalUnitCount: number;
    salesTotal: number;
    invoiceStatus: string | null;
    invoicePaid: boolean;
    lines: FundraiserWaitingLine[];
}

/**
 * What the tenant must DO for this fundraiser to reach the kitchen, stated in
 * terms of the real invoice lifecycle (DRAFT -> SENT -> PAID) rather than an
 * invented one. Never claims a payment happened.
 */
function paymentGateLabel(batch: FundraiserWaitingBatch): string {
    if (batch.invoicePaid) return 'Invoice paid · releasing to production';
    switch (batch.invoiceStatus) {
        case null:
        case undefined:
            return 'Not closed out yet · no invoice';
        case 'DRAFT':
            return 'Invoice drafted · send it, then record payment';
        case 'SENT':
            return 'Invoice sent · waiting on payment';
        case 'PENDING':
            return 'Invoice outstanding · waiting on payment';
        case 'OVERDUE':
            return 'Invoice overdue · waiting on payment';
        case 'CANCELED':
            return 'Invoice canceled';
        default:
            return `Invoice ${String(batch.invoiceStatus).toLowerCase()}`;
    }
}

export function FundraiserWaiting({
    batches,
    loading = false,
}: {
    batches: FundraiserWaitingBatch[];
    loading?: boolean;
}) {
    if (loading) {
        return (
            <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-12 text-center text-slate-400 font-bold flex items-center justify-center gap-2">
                <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading fundraisers…
            </div>
        );
    }

    if (!batches || batches.length === 0) {
        return (
            <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-5 py-10 text-center">
                <PiggyBank className="w-9 h-9 text-slate-300 mx-auto mb-2" aria-hidden="true" />
                <p className="text-sm font-bold text-slate-500 dark:text-slate-400">No fundraisers waiting.</p>
                <p className="text-xs text-slate-400 mt-0.5">
                    Fundraiser orders collect here until the organization&apos;s invoice is paid.
                </p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {batches.map((b) => (
                <section
                    key={b.campaignId}
                    className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-sm"
                >
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h3 className="font-black text-slate-900 dark:text-white leading-snug break-words">
                                {b.campaignName}
                            </h3>
                            {b.organizationName && (
                                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 break-words">
                                    {b.organizationName}
                                </p>
                            )}
                        </div>
                        <span
                            className={`shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${
                                b.invoicePaid
                                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                                    : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                            }`}
                        >
                            {b.invoicePaid ? 'Paid' : 'Awaiting payment'}
                        </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold text-slate-500 dark:text-slate-400">
                        {b.deliveryDate && (
                            <span className="inline-flex items-center gap-1.5">
                                <CalendarDays size={12} aria-hidden="true" />
                                {b.deliveryDate}
                            </span>
                        )}
                        <span>
                            {b.orderCount} order{b.orderCount === 1 ? '' : 's'}
                        </span>
                        <span>
                            {b.totalUnitCount} bundle{b.totalUnitCount === 1 ? '' : 's'}
                        </span>
                        {b.salesTotal > 0 && (
                            <span>${b.salesTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                        )}
                    </div>

                    <p className="mt-2 text-[11px] font-semibold text-slate-400">{paymentGateLabel(b)}</p>

                    {b.lines.length > 0 && (
                        <ul className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-3 space-y-1">
                            {b.lines.map((l) => (
                                <li
                                    key={`${l.bundleId ?? l.bundleName}-${l.variantSize}`}
                                    className="flex items-baseline justify-between gap-3 text-[13px]"
                                >
                                    <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">
                                        {l.bundleName}
                                        {l.servingTierLabel && (
                                            <span className="text-slate-400"> — {l.servingTierLabel}</span>
                                        )}
                                    </span>
                                    <span className="shrink-0 font-black tabular-nums text-slate-900 dark:text-white">
                                        ×{l.quantity}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            ))}
        </div>
    );
}

export default FundraiserWaiting;
