'use client';

/**
 * COORDINATOR-PAYMENT-METHOD-UX-1 — "what did I tell supporters about paying?", on the panel.
 *
 * Shows exactly what supporters see (the same projection and view the public page uses), so a
 * coordinator never has to reopen setup to remember it. Read-only: "Edit" opens the existing
 * Payment Settings. Says nothing about whether anyone HAS paid — that is the per-order
 * "Paid" mark in Recent orders, which this card neither reads nor writes.
 */

import {
    buildSupporterPaymentView,
    paymentLinkDestination,
    readStoredPaymentMethods,
    toPublicPaymentMethods,
} from '@/lib/supporterPaymentMethods';

export function PaymentMethodsSummary({
    paymentMethods,
    checksPayable,
    paymentInstructions,
    externalPaymentLink,
    onEdit,
}: {
    /** The campaign's stored methods as the coordinator API returns them (null = never configured). */
    paymentMethods: unknown;
    checksPayable: unknown;
    paymentInstructions: unknown;
    externalPaymentLink: unknown;
    onEdit: () => void;
}) {
    const methods = toPublicPaymentMethods(paymentMethods, checksPayable);
    const view = buildSupporterPaymentView({ methods, instructions: paymentInstructions, legacyLink: externalPaymentLink });
    const nothingSet = view.methods.length === 0 && !view.instructions && !view.legacyLink;
    // COORDINATOR-BANK-ACH-LINK-1: a bank payment page is summarised by where it goes (host only) plus
    // the coordinator's own note — not the whole link, and not the fixed sentence every supporter sees.
    const bank = readStoredPaymentMethods(paymentMethods)?.methods.find((m) => m.type === 'bank_ach');
    const bankNote = bank && bank.type === 'bank_ach' ? bank.note ?? null : null;

    return (
        <section aria-labelledby="supporter-payment-heading" className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
                <h3 id="supporter-payment-heading" className="text-base font-black text-slate-900">Supporter payment methods</h3>
                <button
                    type="button"
                    onClick={onEdit}
                    className="shrink-0 min-h-[44px] rounded-xl px-3 text-sm font-bold text-indigo-600 hover:bg-indigo-50"
                >
                    {nothingSet ? 'Add' : 'Edit'}
                </button>
            </div>

            {view.methods.length > 0 && (
                <p className="text-sm font-bold text-slate-800">{view.methods.map((m) => m.label).join(' · ')}</p>
            )}
            {view.methods.some((m) => m.detail && m.type !== 'cash') && (
                <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                    {view.methods.filter((m) => m.detail && m.type !== 'cash').map((m) => (
                        m.type === 'bank_ach' ? (
                            <li key={m.type} className="break-words">
                                <span className="font-semibold text-slate-700">{m.label}:</span> Opens {paymentLinkDestination(m.href)}
                                {bankNote && <span className="block whitespace-pre-wrap">{bankNote}</span>}
                            </li>
                        ) : (
                            <li key={m.type} className="break-words">
                                <span className="font-semibold text-slate-700">{m.label}:</span> {m.detail}
                            </li>
                        )
                    ))}
                </ul>
            )}
            {view.instructions && (
                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-600">{view.instructions}</p>
            )}
            {view.legacyLink && (
                <p className="mt-1 break-all text-xs text-slate-500">Payment link: {view.legacyLink.text}</p>
            )}
            {nothingSet && (
                <p className="text-xs text-slate-500">
                    Not set yet. Supporters are asked to contact you to arrange payment.
                </p>
            )}
            {view.dueLine && !nothingSet && (
                <p className="mt-2 text-[11px] text-slate-400">Supporters are also told: &ldquo;{view.dueLine}&rdquo;</p>
            )}
        </section>
    );
}
