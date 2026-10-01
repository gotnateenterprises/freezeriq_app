"use client";

/**
 * CLOSEOUT-BUNDLE-SUMMARY-1 — the persistent, read-only Bundle Summary for a
 * fundraiser invoice.
 *
 * Built ONLY from the invoice's own frozen items: the lines closeout wrote,
 * at the prices that were charged. Never from the campaign's orders as they
 * stand today, so an order canceled after closeout or a bundle repriced since
 * cannot change it. It answers "what bundles and sizes did this fundraiser
 * actually order?" long after the closeout modal has been dismissed.
 *
 * Read-only by construction: no input, no form, no request. The only control
 * closes it.
 */

import { X } from 'lucide-react';
import { useDialogFocus } from '@/components/crm2/useDialogFocus';
import { BundleSummaryTable } from './BundleSummaryTable';
import { bundleSummaryFromInvoiceItems, type FrozenInvoiceItem } from '@/lib/bundleSummary';

export interface BundleSummaryInvoice {
    id: string;
    customer?: { name?: string | null } | null;
    items?: readonly FrozenInvoiceItem[] | null;
}

export function InvoiceBundleSummaryDialog({
    invoice,
    onClose,
}: {
    invoice: BundleSummaryInvoice;
    onClose: () => void;
}) {
    const { panelRef, containTab } = useDialogFocus(true, invoice.id);
    const summary = bundleSummaryFromInvoiceItems(invoice.items);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invoice-bundle-summary-title"
            onKeyDown={(e) => {
                if (e.key === 'Escape') { onClose(); return; }
                containTab(e);
            }}
        >
            <div className="absolute inset-0" aria-hidden="true" onClick={onClose} />
            <div
                ref={panelRef}
                tabIndex={-1}
                className="relative flex w-full max-w-md max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl focus:outline-none dark:border-slate-700 dark:bg-slate-800"
            >
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 pb-4 pt-6 dark:border-slate-700">
                    <div className="min-w-0">
                        <h2 id="invoice-bundle-summary-title" className="text-lg font-black text-slate-900 dark:text-white">
                            Bundle Summary
                        </h2>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 [overflow-wrap:anywhere]">
                            {invoice.customer?.name ?? 'Fundraiser'} &middot; #{invoice.id.slice(0, 8).toUpperCase()}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close bundle summary"
                        className="inline-flex min-h-[44px] min-w-[44px] flex-none items-center justify-center rounded-xl border border-slate-200 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600 dark:border-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-300"
                    >
                        <X size={16} aria-hidden="true" />
                    </button>
                </div>

                <div className="space-y-3 overflow-y-auto px-6 py-5">
                    <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                        What this fundraiser sold, as frozen onto its invoice at closeout.
                    </p>
                    <BundleSummaryTable summary={summary} showHeading={false} />
                </div>
            </div>
        </div>
    );
}

export default InvoiceBundleSummaryDialog;
