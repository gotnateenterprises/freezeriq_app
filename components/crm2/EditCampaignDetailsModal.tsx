"use client";

/**
 * CRM-CAMPAIGN-DETAILS-1 — the tenant's own "Edit details" dialog for a live fundraiser.
 *
 * WHY THIS EXISTS
 * A fundraiser's pickup time was entered as 9:00 AM and needed to be 4:00 PM, and there
 * was no tenant path to fix it. The campaign columns were canonical and every read
 * surface already preferred them, but the only editing UI was
 * components/crm/FundraiserSetup.tsx — an ORGANISATION-scoped form writing
 * `Customer.fundraiser_info`, whose sync deliberately refused to overwrite a
 * coordinator-confirmed `delivery_time`. So the correction needed a database edit.
 *
 * WHAT IT DELIBERATELY IS NOT
 * Not a campaign builder. Six operational fields, no financial ones. `org_share_percent`
 * and `goal_amount` are reachable through the same PATCH route but stay out of here:
 * the share carries a role gate AND a closeout gate, and a "details" dialog that quietly
 * carried either would undo that design. The server enforces this too — the route only
 * reads the six keys below out of the body for this purpose.
 *
 * "Checks payable to" is not financial in that sense: it is a payee NAME printed on the
 * flyer, packet and tracking sheet, with no bearing on any amount, rate or settlement.
 *
 * DATES
 * `delivery_date` and `end_date` are `@db.Date`. `safeCalendarDateForInput` is the
 * repository's answer to the off-by-one that follows (OPS-DATE-PICKER-HOTFIX-1): it reads
 * with UTC getters, so the day the tenant picked is the day the input shows. The value
 * posted back is the same 'YYYY-MM-DD' the input holds — no Date is constructed here, so
 * the browser's timezone never enters the round trip.
 *
 * TIME
 * Free text, not a time picker, because `delivery_time` is a String by design (FR-FLOW-3):
 * real fundraisers say "4:45 PM", "3–5 PM" or "TBD", and a pickup window is not a clock
 * reading.
 */

import { useMemo, useState } from 'react';
import { CalendarClock, Loader2, Check } from 'lucide-react';
import { safeCalendarDateForInput } from '@/lib/tenantTimezone';
import { resolveBundleGoal, DEFAULT_BUNDLE_GOAL } from '@/lib/fundraiserMetrics';
import { useDialogFocus } from './useDialogFocus';

export interface EditableCampaignDetails {
    id: string;
    name?: string | null;
    delivery_date?: string | Date | null;
    delivery_time?: string | null;
    end_date?: string | Date | null;
    pickup_location?: string | null;
    checks_payable?: string | null;
    bundle_goal?: number | null;
    closed_at?: string | Date | null;
    status?: string | null;
}

/** Mirrors lib/campaignBundleSelection CLOSED_STATUSES for the read-only presentation. */
const CLOSED_STATUS_NAMES = ['Closed', 'Settled', 'Completed', 'Archived'];

function isClosedForDisplay(c: EditableCampaignDetails): boolean {
    return Boolean(c.closed_at) || CLOSED_STATUS_NAMES.includes(String(c.status ?? ''));
}

/** What changed, for the previous → new confirmation the owner asked for. */
interface AppliedChange {
    label: string;
    from: string;
    to: string;
}

const EMPTY_LABEL = 'not set';

export function EditCampaignDetailsModal({
    campaign,
    onClose,
    onSaved,
}: {
    campaign: EditableCampaignDetails;
    onClose: () => void;
    onSaved?: () => void;
}) {
    const closed = isClosedForDisplay(campaign);

    const initial = useMemo(
        () => ({
            delivery_date: safeCalendarDateForInput(campaign.delivery_date ?? null),
            delivery_time: campaign.delivery_time ?? '',
            end_date: safeCalendarDateForInput(campaign.end_date ?? null),
            pickup_location: campaign.pickup_location ?? '',
            checks_payable: campaign.checks_payable ?? '',
            bundle_goal: campaign.bundle_goal != null ? String(campaign.bundle_goal) : '',
        }),
        [campaign],
    );

    const [form, setForm] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [applied, setApplied] = useState<AppliedChange[] | null>(null);

    const dialog = useDialogFocus(true, campaign.id);
    const set = (k: keyof typeof initial, v: string) => setForm((p) => ({ ...p, [k]: v }));

    async function handleSave() {
        setError(null);

        // Only send what actually changed. The route treats an omitted key as "leave it
        // alone", so a tenant correcting the time cannot disturb the date or the deadline.
        const body: Record<string, unknown> = {};
        if (form.delivery_date !== initial.delivery_date) body.delivery_date = form.delivery_date;
        if (form.delivery_time !== initial.delivery_time) body.delivery_time = form.delivery_time;
        if (form.end_date !== initial.end_date) body.end_date = form.end_date;
        if (form.pickup_location !== initial.pickup_location) body.pickup_location = form.pickup_location;
        if (form.checks_payable !== initial.checks_payable) body.checks_payable = form.checks_payable;
        if (form.bundle_goal !== initial.bundle_goal) body.bundleGoal = form.bundle_goal;

        if (Object.keys(body).length === 0) {
            onClose();
            return;
        }

        setSaving(true);
        try {
            const res = await fetch(`/api/campaigns/${campaign.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.error || 'Could not save these details. Please try again.');
                return;
            }

            const changes: AppliedChange[] = [];
            const note = (label: string, from: string, to: string) => {
                changes.push({ label, from: from || EMPTY_LABEL, to: to || EMPTY_LABEL });
            };
            if ('delivery_date' in body) note('Delivery / pickup date', initial.delivery_date, form.delivery_date);
            if ('delivery_time' in body) note('Delivery / pickup time', initial.delivery_time, form.delivery_time);
            if ('end_date' in body) note('Supporter order deadline', initial.end_date, form.end_date);
            if ('pickup_location' in body) note('Delivery / pickup location', initial.pickup_location, form.pickup_location);
            if ('checks_payable' in body) note('Checks payable to', initial.checks_payable, form.checks_payable);
            if ('bundleGoal' in body) {
                note(
                    'Fundraiser goal',
                    `${resolveBundleGoal(initial.bundle_goal)} bundles`,
                    `${resolveBundleGoal(form.bundle_goal)} bundles`,
                );
            }
            setApplied(changes);
            onSaved?.();
        } catch {
            setError('Could not reach the server. Please try again.');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-details-modal-title"
            onKeyDown={(e) => {
                if (e.key === 'Escape' && !saving) { onClose(); return; }
                dialog.containTab(e);
            }}
        >
            <div
                ref={dialog.panelRef}
                tabIndex={-1}
                className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-md p-8 max-h-[90vh] overflow-y-auto animate-in fade-in zoom-in duration-200 focus:outline-none"
            >
                <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 rounded-2xl bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                        <CalendarClock size={20} className="text-indigo-600" aria-hidden="true" />
                    </div>
                    <h3 id="campaign-details-modal-title" className="text-xl font-black text-slate-900 dark:text-white">
                        Edit details
                    </h3>
                </div>
                <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-6">
                    {campaign.name || 'This fundraiser'}
                </p>

                {applied ? (
                    <div className="space-y-4">
                        <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-4">
                            <p className="flex items-center gap-2 font-black text-emerald-800 dark:text-emerald-300">
                                <Check size={16} aria-hidden="true" /> Campaign details updated.
                            </p>
                            <p className="mt-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                                {/* Only claimed because it is architecturally true: the coordinator
                                    portal and the supporter page read this campaign row on every
                                    request. There is no snapshot and no sync job between them. */}
                                Changes are now reflected on the coordinator and supporter pages.
                            </p>
                        </div>
                        {applied.length > 0 && (
                            <dl className="space-y-2 text-sm">
                                {applied.map((c) => (
                                    <div key={c.label} className="rounded-xl bg-slate-50 dark:bg-slate-900/40 px-3 py-2">
                                        <dt className="font-bold text-slate-700 dark:text-slate-300">{c.label}</dt>
                                        <dd className="font-mono text-slate-500 dark:text-slate-400">
                                            <span className="line-through">{c.from}</span>
                                            <span aria-hidden="true"> → </span>
                                            <span className="sr-only">changed to</span>
                                            <span className="font-black text-slate-900 dark:text-white">{c.to}</span>
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                        )}
                        <div className="flex justify-end">
                            <button
                                onClick={onClose}
                                className="px-6 py-3 rounded-xl font-black bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20 transition-all"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                ) : closed ? (
                    <div className="space-y-4">
                        <p className="rounded-2xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-4 text-sm font-bold text-amber-800 dark:text-amber-300">
                            This fundraiser has been closed out, so its details are read-only. Its
                            invoice, packing slips and settlement were all produced from these values.
                        </p>
                        <dl className="space-y-2 text-sm">
                            <Row label="Delivery / pickup date" value={initial.delivery_date} />
                            <Row label="Delivery / pickup time" value={initial.delivery_time} />
                            <Row label="Supporter order deadline" value={initial.end_date} />
                            <Row label="Delivery / pickup location" value={initial.pickup_location} />
                            <Row label="Checks payable to" value={initial.checks_payable} />
                            <Row label="Fundraiser goal" value={`${resolveBundleGoal(initial.bundle_goal)} bundles`} />
                        </dl>
                        <div className="flex justify-end">
                            <button onClick={onClose} className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">
                                Close
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-5">
                        {/* Date and time sit together: they are one decision about when the
                            food changes hands, and the tenant owns both. */}
                        <div className="grid grid-cols-2 gap-3">
                            <Field label="Delivery / pickup date" htmlFor="cd-delivery-date">
                                <input
                                    id="cd-delivery-date"
                                    type="date"
                                    value={form.delivery_date}
                                    onChange={(e) => set('delivery_date', e.target.value)}
                                    className={inputClass}
                                />
                            </Field>
                            <Field label="Delivery / pickup time" htmlFor="cd-delivery-time" hint="e.g. 4:00 PM">
                                <input
                                    id="cd-delivery-time"
                                    type="text"
                                    inputMode="text"
                                    placeholder="4:00 PM"
                                    value={form.delivery_time}
                                    onChange={(e) => set('delivery_time', e.target.value)}
                                    className={inputClass}
                                />
                            </Field>
                        </div>

                        <Field
                            label="Supporter order deadline"
                            htmlFor="cd-end-date"
                            hint="The last day supporters may order — not the delivery date."
                        >
                            <input
                                id="cd-end-date"
                                type="date"
                                value={form.end_date}
                                onChange={(e) => set('end_date', e.target.value)}
                                className={inputClass}
                            />
                        </Field>

                        <Field label="Delivery / pickup location" htmlFor="cd-pickup-location">
                            <input
                                id="cd-pickup-location"
                                type="text"
                                placeholder="School gym parking lot"
                                value={form.pickup_location}
                                onChange={(e) => set('pickup_location', e.target.value)}
                                className={inputClass}
                            />
                        </Field>

                        {/* CRM-CAMPAIGN-DETAILS-1A. Added because protecting the field
                            without it would have stranded the tenant: the organization
                            Fundraiser Setup form was their ONLY way to set a campaign's
                            payee, and once the sync stops overwriting an established
                            value, that path can no longer change one. That is the exact
                            shape of the bug this whole feature exists to fix — a value
                            only the coordinator could set — so it would have been
                            recreated on a new field. */}
                        <Field
                            label="Checks payable to"
                            htmlFor="cd-checks-payable"
                            hint="Who supporters should make paper checks out to."
                        >
                            <input
                                id="cd-checks-payable"
                                type="text"
                                placeholder={campaign.name || 'Organization name'}
                                value={form.checks_payable}
                                onChange={(e) => set('checks_payable', e.target.value)}
                                className={inputClass}
                            />
                        </Field>

                        <Field
                            label="Fundraiser goal"
                            htmlFor="cd-bundle-goal"
                            hint={`Set the bundle goal your organization is working toward. Leave blank to use the default goal of ${DEFAULT_BUNDLE_GOAL} weighted bundles.`}
                        >
                            <input
                                id="cd-bundle-goal"
                                type="number"
                                min={1}
                                step={1}
                                placeholder={String(DEFAULT_BUNDLE_GOAL)}
                                value={form.bundle_goal}
                                onChange={(e) => set('bundle_goal', e.target.value)}
                                className={inputClass}
                            />
                        </Field>

                        {error && (
                            <p role="alert" className="rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 px-3 py-2 text-sm font-bold text-rose-700 dark:text-rose-400">
                                {error}
                            </p>
                        )}

                        <div className="flex gap-3 justify-end pt-1">
                            <button
                                onClick={onClose}
                                disabled={saving}
                                className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="flex items-center gap-2 px-6 py-3 rounded-xl font-black bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-60 disabled:scale-100"
                            >
                                {saving ? (
                                    <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Saving…</>
                                ) : (
                                    'Save changes'
                                )}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

const inputClass =
    'w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 '
    + 'text-slate-900 dark:text-white font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500';

function Field({
    label, htmlFor, hint, children,
}: {
    label: string; htmlFor: string; hint?: string; children: React.ReactNode;
}) {
    return (
        <div className="space-y-1">
            <label htmlFor={htmlFor} className="block text-sm font-black text-slate-700 dark:text-slate-300">
                {label}
            </label>
            {children}
            {hint && <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{hint}</p>}
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-xl bg-slate-50 dark:bg-slate-900/40 px-3 py-2">
            <dt className="font-bold text-slate-700 dark:text-slate-300">{label}</dt>
            <dd className="font-mono text-slate-900 dark:text-white">{value || EMPTY_LABEL}</dd>
        </div>
    );
}
