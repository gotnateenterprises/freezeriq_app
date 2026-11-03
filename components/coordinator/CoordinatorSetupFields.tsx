'use client';

/**
 * FR-FLOW-3 — the fundraiser logistics a coordinator confirms during setup.
 *
 * Everything here is coordinator-owned. The tenant's decisions — the confirmed
 * delivery date and the supporter order deadline — appear only as read-only
 * facts, because changing those belongs to the conversation the tenant already
 * had with the organization, not to this form.
 *
 * No internal vocabulary reaches this screen: no "candidate", no "active", no
 * "bundle_selection_status". A coordinator is a volunteer with a phone, not an
 * operator of a state machine.
 */

import { Lock } from 'lucide-react';
import {
    CASH_GUIDANCE,
    PAYMENT_DUE_GUIDANCE,
    PAYMENT_METHOD_LABELS,
    PAYMENT_METHOD_TYPES,
    paymentMethodsFormErrors,
    type PaymentMethodType,
    type PaymentMethodsFormValue,
} from '@/lib/supporterPaymentMethods';

/**
 * COORDINATOR-PAYMENT-METHOD-UX-1 — the payment half of setup, shared with the
 * portal's Payment Settings so a coordinator configures payment in one form.
 * `paymentMethods` is the method checklist; the Check payee stays in
 * `checksPayable` (its existing column), and `paymentLink` is the legacy
 * campaign-wide link, shown only to a campaign that already has one.
 */
export interface CoordinatorPaymentFieldValues {
    paymentMethods: PaymentMethodsFormValue;
    checksPayable: string;
    paymentInstructions: string;
    paymentLink: string;
}

export interface CoordinatorSetupFieldValues extends CoordinatorPaymentFieldValues {
    pickupLocation: string;
    deliveryTime: string;
}

export interface CoordinatorLockedInfo {
    organizationName: string | null;
    deliveryDate: string | null;
    orderDeadline: string | null;
    coordinatorName?: string | null;
    coordinatorEmail?: string | null;
    coordinatorPhone?: string | null;
}

/** Renders a stored date without timezone conversion — the same rule the rest of the app uses for DATE columns. */
function readableDate(iso: string | null): string {
    if (!iso) return 'Not set';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Not set';
    return d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
}

const inputCls =
    'w-full rounded-xl border border-slate-200 px-3 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100';

function LockedRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-start justify-between gap-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Lock size={11} aria-hidden="true" /> {label}
            </span>
            <span className="min-w-0 flex-1 text-right text-sm font-semibold text-slate-900 break-words">{value}</span>
        </div>
    );
}

const METHOD_FIELDS_HINT: Partial<Record<PaymentMethodType, string>> = {
    cash: `Supporters see: “${CASH_GUIDANCE}”`,
};

/**
 * COORDINATOR-BANK-ACH-LINK-1 — FreezerIQ needs only the payment-page link. It never asks for, and
 * has no field for, a routing number, account number or bank login; this says so where the link
 * is pasted. (Deliberately guidance, not digit-blocking: notes legitimately carry phone numbers,
 * references and dates.)
 */
export const BANK_ACH_LINK_HELP = 'Paste the payment-page link your bank or payment provider gave your organization. It must start with https://.';
export const BANK_ACH_SAFETY_WARNING = 'Never enter a routing number, account number, or bank login. FreezerIQ only needs the secure payment-page link.';

/** One method's own fields, shown only while that method is selected. */
function MethodFields({
    type, idPrefix, values, disabled, error, onChange,
}: {
    type: PaymentMethodType;
    idPrefix: string;
    values: CoordinatorPaymentFieldValues;
    disabled?: boolean;
    error?: string;
    onChange: (patch: Partial<CoordinatorPaymentFieldValues>) => void;
}) {
    const pm = values.paymentMethods;
    const setPm = (patch: Partial<PaymentMethodsFormValue>) => onChange({ paymentMethods: { ...pm, ...patch } });
    const id = (f: string) => `${idPrefix}-${type}-${f}`;
    const errorId = `${idPrefix}-${type}-error`;
    const described = error ? errorId : undefined;
    const errorLine = error ? <p id={errorId} role="alert" className="text-xs font-semibold text-rose-600">{error}</p> : null;

    if (type === 'cash') return <p className="text-xs text-slate-500">{METHOD_FIELDS_HINT.cash}</p>;
    if (type === 'check') {
        return (
            <div>
                <label htmlFor={id('payee')} className="mb-1 block text-sm font-bold text-slate-700">
                    Make checks payable to <span className="font-medium text-slate-400">(optional)</span>
                </label>
                <input id={id('payee')} type="text" disabled={disabled} value={values.checksPayable}
                    onChange={(e) => onChange({ checksPayable: e.target.value })}
                    placeholder="Lincoln PTO" className={inputCls} />
            </div>
        );
    }
    if (type === 'venmo') {
        return (
            <div className="space-y-1">
                <label htmlFor={id('handle')} className="block text-sm font-bold text-slate-700">Venmo username</label>
                <input id={id('handle')} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={disabled}
                    value={pm.venmoHandle} onChange={(e) => setPm({ venmoHandle: e.target.value })}
                    placeholder="@lincoln-pto" aria-invalid={Boolean(error)} aria-describedby={described} className={inputCls} />
                {errorLine}
            </div>
        );
    }
    if (type === 'paypal') {
        return (
            <div className="space-y-1">
                <label htmlFor={id('account')} className="block text-sm font-bold text-slate-700">PayPal.Me link or PayPal email</label>
                <input id={id('account')} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={disabled}
                    value={pm.paypalAccount} onChange={(e) => setPm({ paypalAccount: e.target.value })}
                    placeholder="paypal.me/LincolnPTO" aria-invalid={Boolean(error)} aria-describedby={described} className={inputCls} />
                {errorLine}
            </div>
        );
    }
    if (type === 'cashapp') {
        return (
            <div className="space-y-1">
                <label htmlFor={id('tag')} className="block text-sm font-bold text-slate-700">Cash App $Cashtag</label>
                <input id={id('tag')} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={disabled}
                    value={pm.cashappTag} onChange={(e) => setPm({ cashappTag: e.target.value })}
                    placeholder="$LincolnPTO" aria-invalid={Boolean(error)} aria-describedby={described} className={inputCls} />
                {errorLine}
            </div>
        );
    }
    if (type === 'bank_ach') {
        const helpId = id('help');
        const warningId = id('warning');
        return (
            <div className="min-w-0 space-y-2">
                <div>
                    <label htmlFor={id('link')} className="mb-1 block text-sm font-bold text-slate-700">
                        Bank payment link <span className="font-medium text-slate-500">(required)</span>
                    </label>
                    <input id={id('link')} type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={disabled}
                        value={pm.bankLink} onChange={(e) => setPm({ bankLink: e.target.value })} placeholder="https://"
                        aria-required="true" aria-invalid={Boolean(error)}
                        aria-describedby={[helpId, warningId, described].filter(Boolean).join(' ')} className={inputCls} />
                    <p id={helpId} className="mt-1 break-words text-xs text-slate-500">{BANK_ACH_LINK_HELP}</p>
                </div>
                <div>
                    <label htmlFor={id('note')} className="mb-1 block text-sm font-bold text-slate-700">
                        Note for supporters <span className="font-medium text-slate-400">(optional)</span>
                    </label>
                    <textarea id={id('note')} rows={2} disabled={disabled} value={pm.bankNote}
                        onChange={(e) => setPm({ bankNote: e.target.value })} placeholder="Enter your order total on the bank's payment page."
                        aria-invalid={Boolean(error)} aria-describedby={described} className={inputCls} />
                </div>
                <p id={warningId} className="break-words rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">{BANK_ACH_SAFETY_WARNING}</p>
                {errorLine}
            </div>
        );
    }
    return (
        <div className="space-y-2">
            <div>
                <label htmlFor={id('label')} className="mb-1 block text-sm font-bold text-slate-700">Name of this method</label>
                <input id={id('label')} type="text" disabled={disabled} value={pm.otherLabel}
                    onChange={(e) => setPm({ otherLabel: e.target.value })} placeholder="Pay at pickup"
                    aria-invalid={Boolean(error)} aria-describedby={described} className={inputCls} />
            </div>
            <div>
                <label htmlFor={id('details')} className="mb-1 block text-sm font-bold text-slate-700">How supporters use it</label>
                <textarea id={id('details')} rows={2} disabled={disabled} value={pm.otherDetails}
                    onChange={(e) => setPm({ otherDetails: e.target.value })} placeholder="Bring cash or a check to the pickup table."
                    aria-invalid={Boolean(error)} aria-describedby={described} className={inputCls} />
            </div>
            <div>
                <label htmlFor={id('link')} className="mb-1 block text-sm font-bold text-slate-700">
                    Link <span className="font-medium text-slate-400">(optional, must start with https)</span>
                </label>
                <input id={id('link')} type="url" inputMode="url" disabled={disabled} value={pm.otherLink}
                    onChange={(e) => setPm({ otherLink: e.target.value })} placeholder="https://"
                    aria-describedby={described} className={inputCls} />
            </div>
            {errorLine}
        </div>
    );
}

/**
 * "How should supporters pay you?" — a checklist of the six methods, each opening
 * only its own fields, then the coordinator's general instructions.
 *
 * Problems are shown inline once a field has content (or after a refused save,
 * via `showAllErrors`); the server re-validates everything regardless.
 */
export function CoordinatorPaymentFields({
    values,
    disabled,
    onChange,
    idPrefix = 'setup',
    showPaymentLink = false,
    showAllErrors = false,
}: {
    values: CoordinatorPaymentFieldValues;
    disabled?: boolean;
    onChange: (patch: Partial<CoordinatorPaymentFieldValues>) => void;
    idPrefix?: string;
    /** Only a campaign that already had a campaign-wide payment link sees that field. */
    showPaymentLink?: boolean;
    showAllErrors?: boolean;
}) {
    const pm = values.paymentMethods;
    const errors = paymentMethodsFormErrors(pm);
    const hasContent: Record<PaymentMethodType, boolean> = {
        cash: false, check: false,
        venmo: pm.venmoHandle.trim() !== '',
        paypal: pm.paypalAccount.trim() !== '',
        cashapp: pm.cashappTag.trim() !== '',
        bank_ach: (pm.bankLink + pm.bankNote).trim() !== '',
        other: (pm.otherLabel + pm.otherDetails + pm.otherLink).trim() !== '',
    };
    const toggle = (type: PaymentMethodType, on: boolean) =>
        onChange({ paymentMethods: { ...pm, selected: { ...pm.selected, [type]: on } } });

    return (
        <div className="space-y-3">
            <fieldset className="min-w-0 space-y-2" disabled={disabled}>
                <legend className="mb-1 block text-sm font-bold text-slate-700">How should supporters pay you?</legend>
                <p className="text-xs text-slate-500">Select all that apply. Supporters see exactly what you choose here.</p>
                <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                    {PAYMENT_METHOD_TYPES.map((type) => (
                        <div key={type} className="px-3">
                            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-base font-semibold text-slate-800">
                                <input
                                    type="checkbox"
                                    checked={pm.selected[type]}
                                    onChange={(e) => toggle(type, e.target.checked)}
                                    aria-controls={pm.selected[type] ? `${idPrefix}-${type}-fields` : undefined}
                                    className="h-5 w-5 shrink-0 accent-indigo-600"
                                />
                                {PAYMENT_METHOD_LABELS[type]}
                            </label>
                            {pm.selected[type] && (
                                <div id={`${idPrefix}-${type}-fields`} className="min-w-0 pb-3 pl-8">
                                    <MethodFields
                                        type={type}
                                        idPrefix={idPrefix}
                                        values={values}
                                        disabled={disabled}
                                        error={showAllErrors || hasContent[type] ? errors[type] : undefined}
                                        onChange={onChange}
                                    />
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </fieldset>

            <div>
                <label htmlFor={`${idPrefix}-instructions`} className="mb-1 block text-sm font-bold text-slate-700">
                    Payment instructions <span className="font-medium text-slate-400">(optional)</span>
                </label>
                <textarea
                    id={`${idPrefix}-instructions`}
                    rows={3}
                    disabled={disabled}
                    value={values.paymentInstructions}
                    onChange={(e) => onChange({ paymentInstructions: e.target.value })}
                    placeholder="Please add your specific payment instructions here"
                    className={inputCls}
                />
                {/* COORDINATOR-SUPPORTER-POLISH-1: an example, not a default — it is
                    never written to `values.paymentInstructions` and is shown only
                    while the field is genuinely empty, exactly like a placeholder. */}
                {!values.paymentInstructions && (
                    <p className="mt-1 text-xs text-slate-400">
                        Example: Please pay your coordinator within three days. Checks should be made payable to
                        Lincoln PTO.
                    </p>
                )}
            </div>

            {showPaymentLink && (
                <div>
                    <label htmlFor={`${idPrefix}-link`} className="mb-1 block text-sm font-bold text-slate-700">
                        Payment link from your earlier setup <span className="font-medium text-slate-400">(optional)</span>
                    </label>
                    <input
                        id={`${idPrefix}-link`}
                        type="url"
                        inputMode="url"
                        disabled={disabled}
                        value={values.paymentLink}
                        onChange={(e) => onChange({ paymentLink: e.target.value })}
                        placeholder="https://"
                        className={inputCls}
                    />
                    <p className="mt-1 text-xs text-slate-400">Shown to supporters as &ldquo;Open payment link&rdquo;. Clear it to remove it.</p>
                </div>
            )}

            {/* Said plainly, because the opposite assumption costs a family real money. */}
            <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-600">
                <p>
                    Supporters are told <b className="text-slate-800">&ldquo;{PAYMENT_DUE_GUIDANCE}&rdquo;</b>, then the methods
                    and instructions above &mdash; before they order, after they order, and in their confirmation email.
                </p>
                <p className="mt-1">
                    Venmo, PayPal, Cash App and bank payment links only open another app or website. Following one does
                    not mark an order paid &mdash; you still collect payment and mark orders paid yourself.
                </p>
            </div>
        </div>
    );
}

export function CoordinatorSetupFields({
    values,
    locked,
    disabled,
    onChange,
    showPaymentLink = false,
    showAllErrors = false,
}: {
    values: CoordinatorSetupFieldValues;
    locked: CoordinatorLockedInfo | null;
    disabled?: boolean;
    onChange: (patch: Partial<CoordinatorSetupFieldValues>) => void;
    /** COORDINATOR-PAYMENT-METHOD-UX-1: true only when this campaign already had a payment link. */
    showPaymentLink?: boolean;
    /** After a refused save: show every method's problem, including still-empty fields. */
    showAllErrors?: boolean;
}) {
    const contactLines = [locked?.coordinatorName, locked?.coordinatorEmail, locked?.coordinatorPhone]
        .filter(Boolean) as string[];

    return (
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="setup-details-heading">
            <h3 id="setup-details-heading" className="text-base font-black text-slate-900">
                Fundraiser details
            </h3>

            {locked && (
                <div className="divide-y divide-slate-100 rounded-xl bg-slate-50 px-3">
                    {locked.organizationName && <LockedRow label="Organization" value={locked.organizationName} />}
                    <LockedRow label="Pickup / delivery day" value={readableDate(locked.deliveryDate)} />
                    <LockedRow label="Orders close" value={readableDate(locked.orderDeadline)} />
                    {contactLines.length > 0 && (
                        <LockedRow label="Coordinator" value={contactLines.join(' · ')} />
                    )}
                </div>
            )}
            {locked && (
                <p className="text-xs text-slate-500">
                    These are set by the fundraiser organizer. Contact them if something needs to change.
                </p>
            )}

            <div className="space-y-3">
                <div>
                    <label htmlFor="setup-time" className="mb-1 block text-sm font-bold text-slate-700">
                        Pickup / delivery time
                    </label>
                    <input
                        id="setup-time"
                        type="text"
                        inputMode="text"
                        disabled={disabled}
                        value={values.deliveryTime}
                        onChange={(e) => onChange({ deliveryTime: e.target.value })}
                        placeholder="4:45 PM, or 3–5 PM"
                        className={inputCls}
                    />
                    <p className="mt-1 text-xs text-slate-400">A single time or a window — whatever you tell families.</p>
                </div>

                <div>
                    <label htmlFor="setup-location" className="mb-1 block text-sm font-bold text-slate-700">
                        Pickup / delivery location
                    </label>
                    <input
                        id="setup-location"
                        type="text"
                        disabled={disabled}
                        value={values.pickupLocation}
                        onChange={(e) => onChange({ pickupLocation: e.target.value })}
                        placeholder="School gym, north entrance"
                        className={inputCls}
                    />
                </div>
            </div>

            {/* COORDINATOR-PAYMENT-METHOD-UX-1: replaces the three loose payment fields
                (payable-to, notes, link) with one structured "how should supporters pay
                you?" section — the same component the portal's Payment Settings uses. */}
            <div className="border-t border-slate-100 pt-4">
                <CoordinatorPaymentFields
                    values={values}
                    disabled={disabled}
                    onChange={onChange}
                    idPrefix="setup"
                    showPaymentLink={showPaymentLink}
                    showAllErrors={showAllErrors}
                />
            </div>
        </section>
    );
}
