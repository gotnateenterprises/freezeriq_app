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

export interface CoordinatorSetupFieldValues {
    checksPayable: string;
    pickupLocation: string;
    deliveryTime: string;
    paymentInstructions: string;
    paymentLink: string;
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
            <span className="text-right text-sm font-semibold text-slate-900">{value}</span>
        </div>
    );
}

export function CoordinatorSetupFields({
    values,
    locked,
    disabled,
    onChange,
}: {
    values: CoordinatorSetupFieldValues;
    locked: CoordinatorLockedInfo | null;
    disabled?: boolean;
    onChange: (patch: Partial<CoordinatorSetupFieldValues>) => void;
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

                <div>
                    <label htmlFor="setup-checks" className="mb-1 block text-sm font-bold text-slate-700">
                        Make checks payable to
                    </label>
                    <input
                        id="setup-checks"
                        type="text"
                        disabled={disabled}
                        value={values.checksPayable}
                        onChange={(e) => onChange({ checksPayable: e.target.value })}
                        placeholder="Lincoln PTO"
                        className={inputCls}
                    />
                </div>

                <div>
                    <label htmlFor="setup-instructions" className="mb-1 block text-sm font-bold text-slate-700">
                        Payment notes for families <span className="font-medium text-slate-400">(optional)</span>
                    </label>
                    <textarea
                        id="setup-instructions"
                        rows={3}
                        disabled={disabled}
                        value={values.paymentInstructions}
                        onChange={(e) => onChange({ paymentInstructions: e.target.value })}
                        placeholder="Cash or check at pickup."
                        className={inputCls}
                    />
                </div>

                <div>
                    <label htmlFor="setup-link" className="mb-1 block text-sm font-bold text-slate-700">
                        Payment link <span className="font-medium text-slate-400">(optional)</span>
                    </label>
                    <input
                        id="setup-link"
                        type="url"
                        inputMode="url"
                        disabled={disabled}
                        value={values.paymentLink}
                        onChange={(e) => onChange({ paymentLink: e.target.value })}
                        placeholder="https://venmo.com/u/your-group"
                        className={inputCls}
                    />
                    {/* Said plainly, because the opposite assumption costs a family real money. */}
                    <p className="mt-1 text-xs text-slate-400">
                        Must start with https. Shown to families as a convenience — following it does not mark an
                        order paid, and you still collect and record payment yourself.
                    </p>
                </div>
            </div>
        </section>
    );
}
