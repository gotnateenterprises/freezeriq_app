'use client';

/**
 * QB-INVOICE-1C — "Send via QuickBooks": review exactly what FreezerIQ will create in QuickBooks, confirm who
 * receives it, and send. Also shows a send in progress, a send stopped for review, and a sent invoice's delivery
 * state, with "send the same invoice again" to a corrected recipient.
 *
 * Tenant admins only (the invoices page gates it; the route enforces it). The dialog never sees a token, realm id,
 * connection id or raw QuickBooks id — only QuickBooks' own invoice number once it exists. Nothing is sent without
 * the explicit button, and the server refuses a click whose review token no longer matches the invoice.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, X } from 'lucide-react';
import {
    blockerText,
    INVALID_TEXT,
    RECIPIENT_SOURCE_TEXT,
    sendDialogView,
    type InvoiceSendPayload,
} from '@/lib/quickbooks/invoiceSendView';

const TONE_CLASS: Record<string, string> = {
    neutral: 'text-slate-600 dark:text-slate-300',
    ok: 'text-emerald-700 dark:text-emerald-300',
    warn: 'text-amber-700 dark:text-amber-300',
    bad: 'text-rose-700 dark:text-rose-300',
};

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;

export default function QuickBooksInvoiceSendDialog({
    invoiceId,
    label,
    onClose,
    onChanged,
}: {
    invoiceId: string;
    /** e.g. "Lincoln PTA · #1A2B3C4D" — FreezerIQ's own reference, for orientation only. */
    label: string;
    onClose: () => void;
    onChanged: () => void;
}) {
    const url = `/api/integrations/quickbooks/invoices/${encodeURIComponent(invoiceId)}`;
    const [payload, setPayload] = useState<InvoiceSendPayload | null>(null);
    const [busy, setBusy] = useState(false);
    const [recipientTo, setRecipientTo] = useState('');
    const [recipientCc, setRecipientCc] = useState('');

    const adopt = useCallback((next: InvoiceSendPayload) => {
        setPayload(next);
        if (next.state === 'ready') {
            setRecipientTo(next.suggestedRecipient ?? '');
            setRecipientCc(next.suggestedCc ?? '');
        } else if (next.state === 'sent') {
            setRecipientTo(next.recipientTo);
            setRecipientCc(next.recipientCc ?? '');
        }
    }, []);

    const load = useCallback(async () => {
        setPayload(null);
        try {
            const res = await fetch(url, { cache: 'no-store' });
            const data = await res.json().catch(() => null);
            adopt(res.ok && data?.state ? data : res.status === 403 ? { state: 'disabled' } : { state: 'error' });
        } catch {
            setPayload({ state: 'error' });
        }
    }, [url, adopt]);

    useEffect(() => { load(); }, [load]);

    async function act(body: Record<string, unknown>) {
        setBusy(true);
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await res.json().catch(() => ({}));
            switch (data?.outcome) {
                case 'sent': toast.success(body.action === 'resend' ? 'QuickBooks emailed the invoice again.' : 'QuickBooks emailed the invoice.'); break;
                case 'checked': toast.success('Delivery status updated from QuickBooks.'); break;
                case 'in_progress': toast.message('The send is paused or still running. Its progress is shown here.'); break;
                case 'needs_review': toast.error('The send stopped for review. Nothing further was sent.'); break;
                case 'stale': toast.error('The invoice changed since you reviewed it. Nothing was sent — review it again.'); break;
                case 'invalid': toast.error(INVALID_TEXT[data.reason] ?? 'Check the recipient and try again.'); break;
                case 'blocked': toast.error((data.blockers ?? []).map(blockerText).join(' ') || 'This invoice cannot be sent through QuickBooks right now.'); break;
                case 'unavailable': toast.error('QuickBooks could not be reached. Try again in a moment.'); break;
                case 'not_sent': toast.error('This invoice has not been sent through QuickBooks.'); break;
                default: toast.error(data?.error ?? 'Could not complete the QuickBooks request.');
            }
            if (data?.outcome !== 'invalid') {
                onChanged();
                await load();
            }
        } catch {
            toast.error('Could not complete the QuickBooks request.');
            await load();
        } finally {
            setBusy(false);
        }
    }

    const view = sendDialogView(payload);
    const ready = payload?.state === 'ready' ? payload : null;
    const sent = payload?.state === 'sent' ? payload : null;
    const inProgress = payload?.state === 'in_progress' ? payload : null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-800 shadow-2xl border border-slate-200 dark:border-slate-700">
                <div className="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-start justify-between gap-4">
                    <div>
                        <h2 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
                            {payload === null && <Loader2 size={16} className="animate-spin" />}
                            {view.title}
                        </h2>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{label}</p>
                    </div>
                    <button onClick={onClose} disabled={busy} className="p-1 text-slate-400 hover:text-slate-600" title="Close"><X size={18} /></button>
                </div>

                <div className="px-6 py-5 space-y-4">
                    {view.messages.length > 0 && (
                        <ul className={`space-y-1 text-sm ${TONE_CLASS[view.tone]}`}>
                            {view.messages.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                    )}

                    {ready && (
                        <>
                            <div className="text-sm text-slate-600 dark:text-slate-300 grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <div><span className="block text-[11px] font-black uppercase tracking-widest text-slate-400">QuickBooks customer</span>{ready.preview.quickBooksCustomerName}</div>
                                <div><span className="block text-[11px] font-black uppercase tracking-widest text-slate-400">Invoice date</span>{ready.preview.txnDate}</div>
                                <div><span className="block text-[11px] font-black uppercase tracking-widest text-slate-400">Due date</span>{ready.preview.dueDate}</div>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-[11px] font-black uppercase tracking-widest text-slate-400">
                                            <th className="py-1 pr-2">Line</th><th className="py-1 px-2 text-right">Qty</th><th className="py-1 px-2 text-right">Price</th><th className="py-1 pl-2 text-right">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                                        {ready.preview.lines.map((l, i) => (
                                            <tr key={i}>
                                                <td className="py-1.5 pr-2">{l.description}</td>
                                                <td className="py-1.5 px-2 text-right">{l.quantity}</td>
                                                <td className="py-1.5 px-2 text-right">{money(l.unitPrice)}</td>
                                                <td className="py-1.5 pl-2 text-right font-semibold">{money(l.amount)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                    <tfoot>
                                        <tr><td colSpan={3} className="pt-2 text-right font-black">Invoice total</td><td className="pt-2 text-right font-black">{money(ready.preview.totals.total)}</td></tr>
                                    </tfoot>
                                </table>
                            </div>
                            {ready.preview.memo && <p className="text-xs text-slate-500">Message on invoice: {ready.preview.memo}</p>}
                            {(ready.payment.card || ready.payment.ach) && (
                                <p className="text-xs text-slate-500 dark:text-slate-400">
                                    Online payment options ({[ready.payment.card ? 'card' : null, ready.payment.ach ? 'bank transfer' : null].filter(Boolean).join(' and ')}) are applied after
                                    the invoice is verified. QuickBooks may email the invoice at that moment; FreezerIQ records that as the send.
                                </p>
                            )}
                        </>
                    )}

                    {(ready || sent?.invoiceStatus === 'SENT') && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                                <label htmlFor="quickbooks-send-to" className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-1">Send to</label>
                                <input id="quickbooks-send-to" type="email" maxLength={100} value={recipientTo} disabled={busy}
                                    onChange={(e) => setRecipientTo(e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm" />
                            </div>
                            <div>
                                <label htmlFor="quickbooks-send-cc" className="block text-[11px] font-black uppercase tracking-widest text-slate-500 mb-1">CC (optional, comma-separated)</label>
                                <input id="quickbooks-send-cc" type="text" inputMode="email" maxLength={100} value={recipientCc} disabled={busy}
                                    onChange={(e) => setRecipientCc(e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-sm" />
                            </div>
                            {ready && <p className="sm:col-span-2 text-xs text-slate-500 dark:text-slate-400">{RECIPIENT_SOURCE_TEXT[ready.suggestedRecipientSource]}</p>}
                        </div>
                    )}

                    {sent && (
                        <div className="text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
                            {sent.sentAt && <div>Last emailed by QuickBooks: {new Date(sent.sentAt).toLocaleString()}{sent.sendCount > 1 ? ` (sent ${sent.sendCount} times)` : ''}</div>}
                            <div>Recipients: {sent.recipientTo}{sent.recipientCc ? `, CC ${sent.recipientCc}` : ''}</div>
                            <div>Delivery: {sent.deliveryErrorType ? `problem reported (${sent.deliveryErrorType})` : 'no problem reported'}{sent.deliveryCheckedAt ? ` · checked ${new Date(sent.deliveryCheckedAt).toLocaleString()}` : ''}</div>
                        </div>
                    )}
                    {inProgress?.docNumber && <p className="text-xs text-slate-500">QuickBooks invoice {inProgress.docNumber}</p>}
                    {payload?.state === 'needs_review' && payload.problemDetail && (
                        <p className="text-xs text-slate-400 break-words">Details for review: {payload.problemDetail}</p>
                    )}
                </div>

                <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/40 flex flex-wrap items-center justify-end gap-3">
                    <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2.5 rounded-xl text-sm font-bold text-slate-500 hover:text-slate-700 disabled:opacity-50">
                        Close
                    </button>
                    {view.canCheckDelivery && (
                        <button type="button" onClick={() => act({ action: 'check_delivery' })} disabled={busy}
                            className="px-4 py-2.5 rounded-xl text-sm font-bold border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 disabled:opacity-50">
                            Check delivery
                        </button>
                    )}
                    {view.canResend && (
                        <button type="button" disabled={busy || !recipientTo.trim()}
                            onClick={() => { if (confirm(`Have QuickBooks email the same invoice again to ${recipientTo.trim()}${recipientCc.trim() ? ` (CC ${recipientCc.trim()})` : ''}?`)) act({ action: 'resend', recipientTo, recipientCc: recipientCc.trim() || null }); }}
                            className="px-4 py-2.5 rounded-xl text-sm font-bold border border-indigo-200 text-indigo-700 dark:text-indigo-300 disabled:opacity-50">
                            Send again
                        </button>
                    )}
                    {view.canResume && (
                        <button type="button" onClick={() => act({ action: 'resume' })} disabled={busy}
                            className="px-5 py-2.5 rounded-xl text-sm font-black bg-slate-900 text-white disabled:opacity-50">
                            {busy ? 'Working…' : 'Resume'}
                        </button>
                    )}
                    {view.canSend && ready && (
                        <button type="button" disabled={busy || !recipientTo.trim()}
                            onClick={() => act({ action: 'send', reviewToken: ready.reviewToken, recipientTo, recipientCc: recipientCc.trim() || null })}
                            className="px-5 py-2.5 rounded-xl text-sm font-black bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                            {busy ? 'Sending…' : 'Send via QuickBooks'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
