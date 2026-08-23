'use client';

/**
 * FR-FUNNEL-1 — the pre-campaign funnel, inside the CRM the tenant already uses.
 *
 * Deliberately NOT a second dashboard and NOT a new pipeline vocabulary. Every
 * bucket below is DERIVED per request by lib/growth/opportunityNextAction.ts
 * from opportunity status and dates; none of them is a stored stage. That is the
 * whole reason FR-FUNNEL-0 could refuse to add post-campaign statuses — once a
 * campaign exists, the existing campaign surfaces stay authoritative and this
 * panel stops talking about it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mail, CalendarCheck, CalendarClock, Rocket, XCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { LaunchFundraiserDialog } from '@/components/crm2/LaunchFundraiserDialog';
import { RespondToInquiryDialog, type RespondTarget } from '@/components/crm2/RespondToInquiryDialog';

type Bucket = 'new_leads' | 'needs_follow_up' | 'waiting_on_date' | 'ready_to_create_campaign' | 'closed';

interface Opportunity {
    id: string;
    status: string;
    bucket: Bucket;
    priority: string;
    first_response_at: string | null;
    preferred_delivery_date: string | null;
    alternate_delivery_date: string | null;
    confirmed_delivery_date: string | null;
    lost_reason: string | null;
    inquiry_count: number;
    first_inquiry_at: string | null;
    response_hours: number | null;
    // FR-ACCEPTANCE-2A.1 — all four derived server-side by resolveInquiryResponse
    // so the list, the drawer and the next action cannot drift apart.
    latest_inquiry_at: string | null;
    response_state: 'manual_response' | 'auto_ack_sent' | 'auto_ack_uncertain' | 'needs_first_response';
    auto_ack_sent_at: string | null;
    /** The reply that applies to the NEWEST inquiry, which first_response_at may predate by months. */
    manual_response_at: string | null;
    /**
     * Whether first_response_at is recent enough to be about the NEWEST inquiry.
     *
     * The control gate below reads THIS and not first_response_at. One
     * opportunity holds many inquiries, so a reply sent last spring is a real
     * timestamp that answers nothing about an inquiry that arrived this morning —
     * and gating on the raw column would leave the tenant no way to answer it.
     */
    manual_response_applies: boolean;
    customer: { id: string; name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null };
    action: { label: string; reason: string; kind: string } | null;
}

/**
 * FR-ACCEPTANCE-2A.1 — a `mailto:` href built from a stored address, safely.
 *
 * The address is tenant data read back from the database, not a constant, so it
 * is treated as untrusted:
 *
 *   - VALIDATED first. Only a plain single address passes. Anything carrying a
 *     CR or LF is rejected outright, because those are what turn a mail-client
 *     handoff into injected `Bcc:`/`Subject:` headers.
 *   - ENCODED second, so a legal but awkward local-part cannot terminate the URL
 *     and start a query of its own.
 *   - The scheme is a literal. There is no path by which a stored value could
 *     make this `javascript:` or `data:` — the value only ever lands after
 *     `mailto:`, and a rejected value yields null and renders no link at all.
 *
 * No subject or body is attached. This phase deliberately ships no follow-up
 * copy, and an empty mail draft is the honest version of that.
 */
function mailtoHref(email: string | null | undefined): string | null {
    const v = (email ?? '').trim();
    // Deliberately strict, and deliberately not a full RFC 5322 parser: this
    // decides whether to render a link, so anything doubtful is simply not one.
    if (!v || v.length > 254) return null;
    // `@` is excluded from the local part so exactly one separator can exist —
    // which is what makes restoring the encoded `@` below unambiguous.
    //
    // The domain deliberately allows `_` and non-ASCII. The public intake accepts
    // anything matching /^[^\s@]+@[^\s@]+\.[^\s@]+$/, so addresses like
    // `pta@central_district.org` are already stored; a stricter rule here would
    // reject a perfectly real address and tell the tenant there was none on file.
    // The safety of this function comes from excluding the STRUCTURAL characters
    // above — whitespace, quotes, brackets, comma, semicolon, colon, backslash,
    // which is also what makes a CR or LF impossible — not from validating
    // hostnames.
    if (!/^[^\s<>()[\],;:\\"@]+@[^\s<>()[\],;:\\"@]+\.[^\s<>()[\],;:\\"@]+$/.test(v)) return null;
    // Encoding matters even after that regex: it still admits `?`, `&`, `#` and
    // `%`, and a local part of `dana?subject=…` would otherwise stop being an
    // address and start being a query. `@` is restored because it is legal
    // unencoded in a mailto and every client renders it more readably.
    return `mailto:${encodeURIComponent(v).replace(/%40/g, '@')}`;
}

/**
 * FR-ACCEPTANCE-2A.1 — one line saying who has answered the newest inquiry.
 *
 * Four states, because "answered" and "not answered" cannot express an
 * acknowledgement whose delivery was never confirmed — and that state is the one
 * where a tenant most needs to act, since a person may be sitting with nothing.
 *
 * The wording never claims more than the database can prove. `auto_ack_sent`
 * means the provider ACCEPTED the message, which is not the same as the
 * volunteer reading it, so it says "sent" and never "delivered" or "they know".
 */
function ResponseStateNotice({ o }: { o: Opportunity }) {
    const stamp = (v: string | null) => (v ? new Date(v).toLocaleString() : null);

    if (o.response_state === 'manual_response') {
        // manual_response_at, NOT first_response_at. The latter is the
        // opportunity's first-ever reply and can be months older than the
        // conversation on screen.
        const at = stamp(o.manual_response_at ?? o.first_response_at);
        return (
            <p className="mt-2 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                ✓ You responded{at ? ` · ${at}` : ''}
            </p>
        );
    }
    if (o.response_state === 'auto_ack_sent') {
        const at = stamp(o.auto_ack_sent_at);
        return (
            <p className="mt-2 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                ✓ Automatic acknowledgement sent{at ? ` · ${at}` : ''}
                <span className="ml-1 font-normal text-slate-500">— they have your introduction; no reply from you yet.</span>
            </p>
        );
    }
    if (o.response_state === 'auto_ack_uncertain') {
        return (
            <p className="mt-2 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                ⚠ Acknowledgement not confirmed
                {/* Both directions of the ambiguity, because the row genuinely
                    cannot tell them apart: the send may never have happened, or
                    it may have been accepted and only the recording of it
                    failed. The tenant is the one who can find out. */}
                <span className="ml-1 font-normal text-slate-500">— an automatic introduction was started but never confirmed. They may have received nothing, or may have received it already; check before sending, or they could get it twice.</span>
            </p>
        );
    }
    return (
        <p className="mt-2 text-[11px] font-semibold text-slate-500">
            Nothing has been sent to this inquiry yet.
        </p>
    );
}

/**
 * FR-ACCEPTANCE-1 — a lead date that is not saved until the tenant says so.
 *
 * THE DEFECT THIS FIXES
 * These two fields used an UNCONTROLLED `<input type="date">` whose `onChange`
 * fired a network write immediately. Chrome's date picker emits change events
 * while you move between months, so paging from August to September silently
 * saved September 19th and popped a "Delivery date confirmed" toast — the
 * tenant had committed a delivery date they were only browsing past.
 *
 * WHY THIS IS NOT A NEW DATE PICKER
 * The deadline field in the Launch Fundraiser dialog behaves correctly and is
 * the SAME native `<input type="date">`. The repository has no date-picker
 * library and no reusable calendar component — CalendarWidget is a Google
 * Calendar embed. What makes the launch field safe is not its widget, it is
 * that `onChange` only sets React state and nothing persists until the tenant
 * presses a button. That is the property being reused here.
 *
 * A native input cannot tell "clicked a day" from "paged a month" — the browser
 * reports both as a change. So rather than guess, the commit moves to an
 * explicit action: the value follows the picker, and Save writes it.
 */
function LeadDateField({
    icon, label, value, disabled, onCommit,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    disabled?: boolean;
    onCommit: (date: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    // Re-sync when the server value changes (another save, or a refresh).
    useEffect(() => { setDraft(value); }, [value]);

    const dirty = draft !== value && draft !== '';

    return (
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <label className="inline-flex items-center gap-1.5">
                {icon} {label}
                <input
                    type="date"
                    value={draft}
                    disabled={disabled}
                    onChange={(e) => setDraft(e.target.value)}
                    className="rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                />
            </label>
            {dirty && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onCommit(draft)}
                    className="rounded-lg bg-indigo-600 px-2 py-1 text-[11px] font-bold text-white disabled:opacity-50"
                >
                    Save
                </button>
            )}
        </span>
    );
}

/** Display order matches the order a lead actually moves through them. */
const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
    // FR-ACCEPTANCE-2A.1: this bucket now holds two things, and the hint has to
    // say so — it collects both inquiries still owed a first reply and answered
    // ones that have gone quiet since.
    { key: 'needs_follow_up', label: 'Needs Follow-Up', hint: 'Owed a first reply, or quiet since you replied' },
    { key: 'new_leads', label: 'New Leads', hint: 'Inquired recently, not yet answered' },
    { key: 'waiting_on_date', label: 'Waiting on Date', hint: 'In conversation about the delivery day' },
    { key: 'ready_to_create_campaign', label: 'Ready to Create Campaign', hint: 'Delivery date agreed' },
];

const LOST_REASONS = [
    ['no_response', 'No response'],
    ['date_unavailable', 'Date unavailable'],
    ['not_interested', 'Not interested'],
    ['postponed', 'Postponed'],
    ['duplicate', 'Duplicate'],
    ['not_a_fit', 'Not a fit'],
    ['chose_other_fundraiser', 'Chose another fundraiser'],
    ['other', 'Other'],
] as const;

const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { timeZone: 'UTC' }) : '—');

export function FunnelLeadsPanel() {
    const [rows, setRows] = useState<Opportunity[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    // FR-FLOW-2B: which opportunity, if any, is being launched right now.
    const [launchingId, setLaunchingId] = useState<string | null>(null);
    // FR-ACCEPTANCE-1: which lead, if any, we are replying to.
    const [respondingTo, setRespondingTo] = useState<RespondTarget | null>(null);

    /**
     * FR-ACCEPTANCE-1C: `silent` refreshes without tearing the panel down.
     *
     * A plain load() sets `loading`, and the early return below swaps the whole
     * panel for a spinner — which unmounts any open dialog mid-request. That is
     * why the respond dialog could never learn whether its own save worked: it
     * was gone before the answer came back. Refreshes triggered by a mutation
     * are silent; only the first load and an explicit retry show the spinner.
     */
    const load = useCallback((silent = false) => {
        if (!silent) setLoading(true);
        fetch('/api/opportunities?open=1')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
            .then((d) => { setRows(d.opportunities || []); setError(false); })
            .catch(() => { if (!silent) setError(true); })
            .finally(() => { if (!silent) setLoading(false); });
    }, []);

    useEffect(() => { load(); }, [load]);

    /**
     * Returns whether the change was actually persisted.
     *
     * The caller needs this. A dialog that reports "recorded" on the strength of
     * having *asked* is telling the tenant something it does not know.
     */
    const mutate = async (id: string, body: Record<string, unknown>, okMsg: string): Promise<boolean> => {
        setBusyId(id);
        try {
            const res = await fetch(`/api/opportunities/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            // A gateway can answer with HTML; parsing it must not become the error.
            const data = await res.json().catch(() => ({} as any));
            if (!res.ok) throw new Error(data.error || 'Update failed');
            toast.success(okMsg);
            load(true);
            return true;
        } catch (e: any) {
            toast.error(e.message);
            return false;
        } finally {
            setBusyId(null);
        }
    };

    if (loading) {
        return <div className="flex items-center gap-2 p-8 text-slate-500"><Loader2 className="animate-spin" size={16} /> Loading leads…</div>;
    }
    if (error) {
        return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Could not load fundraiser leads. <button onClick={() => load()} className="font-bold underline">Try again</button>
        </div>;
    }
    if (rows.length === 0) {
        return <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900">
            No open fundraiser inquiries yet. New requests from your storefront appear here.
        </div>;
    }

    return (
        <div className="space-y-6">
            {BUCKETS.map((b) => {
                const items = rows.filter((r) => r.bucket === b.key);
                if (items.length === 0) return null;
                return (
                    <section key={b.key}>
                        <header className="mb-2 flex items-baseline gap-2">
                            <h3 className="text-sm font-black uppercase tracking-wide text-slate-700 dark:text-slate-200">{b.label}</h3>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{items.length}</span>
                            <span className="text-xs text-slate-400">{b.hint}</span>
                        </header>

                        <ul className="space-y-2">
                            {items.map((o) => (
                                <li key={o.id} className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate font-bold text-slate-900 dark:text-white">{o.customer.name}</p>
                                            <p className="truncate text-xs text-slate-500">
                                                {o.customer.contact_name || '—'} · {o.customer.contact_email || '—'} · {o.customer.contact_phone || '—'}
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {o.inquiry_count} inquir{o.inquiry_count === 1 ? 'y' : 'ies'}
                                                {o.first_inquiry_at ? ` · first ${new Date(o.first_inquiry_at).toLocaleDateString()}` : ''}
                                                {o.response_hours !== null ? ` · replied in ${Math.round(o.response_hours)}h` : ' · not yet answered'}
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                Preferred {fmtDate(o.preferred_delivery_date)} · Backup {fmtDate(o.alternate_delivery_date)} · Confirmed {fmtDate(o.confirmed_delivery_date)}
                                            </p>
                                        </div>

                                        {o.action && (
                                            <div className="max-w-xs text-right">
                                                <p className="text-xs font-bold text-indigo-700 dark:text-indigo-300">{o.action.label}</p>
                                                <p className="text-[11px] text-slate-500">{o.action.reason}</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* FR-ACCEPTANCE-2A.1 — what has already gone out, stated plainly.
                                        Without this the tenant cannot tell an inquiry nobody has
                                        touched from one the platform already answered, and would
                                        either re-introduce themselves or leave a person waiting. */}
                                    <ResponseStateNotice o={o} />

                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        {/* FR-ACCEPTANCE-1 — the real reply leads, and looks like it.
                                            "Mark responded" stays for a reply that happened on the
                                            phone or from a personal inbox, but as the quiet secondary
                                            action it actually is: it records history, it does not
                                            contact anybody.

                                            FR-ACCEPTANCE-2A.1 — gated on manual_response_applies, not
                                            on the raw first_response_at column. A reply to an earlier
                                            inquiry must not remove the tenant's ability to answer a
                                            new one. Note this only ever WIDENS availability: when
                                            there is one inquiry the two are identical. */}
                                        {/* FR-ACCEPTANCE-2A.1 — the mail-client handover.

                                            Shown when the platform has nothing left to send: either the
                                            lead is due a follow-up, or the acknowledgement already went
                                            out and the next message must be a personal one.

                                            A follow-up TEMPLATE is deliberately out of scope for this
                                            phase, so this does not add one. It hands over the thing the
                                            tenant actually needs — the address — and opens their own
                                            mail client. Nothing is sent by the platform and nothing is
                                            recorded, which is right for a message the platform never
                                            sees; the tenant records it afterwards with "I replied
                                            elsewhere". */}
                                        {(o.action?.kind === 'send_follow_up' || o.response_state === 'auto_ack_sent') && (
                                            mailtoHref(o.customer.contact_email) ? (
                                                <a
                                                    href={mailtoHref(o.customer.contact_email)!}
                                                    className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950"
                                                    title="Opens your own email client. FreezerIQ sends and records nothing — use “I replied elsewhere” afterwards."
                                                >
                                                    <Mail size={13} /> Email {o.customer.contact_name || 'them'} yourself
                                                </a>
                                            ) : (
                                                // Otherwise this lead could render with NO control at all:
                                                // a follow-up anchored on a manual reply hides the buttons
                                                // below, and an unusable address hides the link above. Say
                                                // why, rather than showing an instruction and nothing to
                                                // act on.
                                                <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                                                    No usable email address on file — reach out by phone.
                                                </span>
                                            )
                                        )}

                                        {!o.manual_response_applies && (
                                            <>
                                                {/* FR-ACCEPTANCE-2A.1 — THE DUPLICATE-INTRODUCTION GATE.

                                                    This button posts template: 'lead_intro' — the very
                                                    message the automatic acknowledgement already sent. An
                                                    earlier revision only RENAMED it after an
                                                    acknowledgement, which changed the label and not the
                                                    payload: one click still put a second identical
                                                    introduction in the volunteer's inbox.

                                                    So once the newest inquiry has a confirmed
                                                    acknowledgement, the send is removed rather than
                                                    reworded. What remains is the mail-client handover
                                                    above and "I replied elsewhere" below — a personal
                                                    reply and a way to record it. */}
                                                {o.response_state !== 'auto_ack_sent' && (
                                                <button
                                                    disabled={busyId === o.id}
                                                    onClick={() => setRespondingTo({
                                                        opportunityId: o.id,
                                                        contactName: o.customer.contact_name,
                                                        contactEmail: o.customer.contact_email,
                                                        organizationName: o.customer.name,
                                                    })}
                                                    className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
                                                >
                                                    <Send size={13} /> Respond to inquiry
                                                </button>
                                                )}
                                                <button
                                                    disabled={busyId === o.id}
                                                    onClick={() => mutate(o.id, { action: 'mark_responded' }, 'Marked as responded')}
                                                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                                                    title="Use this if you already replied by phone or from your own inbox"
                                                >
                                                    <Mail size={13} /> I replied elsewhere
                                                </button>
                                            </>
                                        )}

                                        <LeadDateField
                                            icon={<CalendarClock size={13} />}
                                            label="Preferred"
                                            value={o.preferred_delivery_date ? o.preferred_delivery_date.slice(0, 10) : ''}
                                            disabled={busyId === o.id}
                                            onCommit={(d) => mutate(o.id, { action: 'set_dates', preferred_delivery_date: d }, 'Preferred delivery date saved')}
                                        />

                                        <LeadDateField
                                            icon={<CalendarCheck size={13} />}
                                            label="Confirm"
                                            value={o.confirmed_delivery_date ? o.confirmed_delivery_date.slice(0, 10) : ''}
                                            disabled={busyId === o.id}
                                            onCommit={(d) => mutate(o.id, { action: 'confirm_date', confirmed_delivery_date: d }, 'Delivery date confirmed')}
                                        />

                                        {/* FR-FLOW-2B: this was a dead label telling the tenant to go
                                            somewhere else, and there was nowhere else to go — conversion
                                            did not exist. It is now the action itself. */}
                                        {o.status === 'date_confirmed' && (
                                            <button
                                                type="button"
                                                disabled={busyId === o.id}
                                                onClick={() => setLaunchingId(o.id)}
                                                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                                            >
                                                <Rocket size={13} /> Launch Fundraiser
                                            </button>
                                        )}

                                        <select
                                            disabled={busyId === o.id}
                                            defaultValue=""
                                            onChange={(e) => e.target.value && mutate(o.id, { action: 'mark_lost', lost_reason: e.target.value }, 'Marked as not proceeding')}
                                            className="ml-auto rounded-lg border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-800"
                                            aria-label="Mark not proceeding"
                                        >
                                            <option value="">Not proceeding…</option>
                                            {LOST_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                        </select>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}

            <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <XCircle size={12} /> Leads marked not proceeding are kept, never deleted — the reason is what tells you where prospects drop out.
            </p>

            {respondingTo && (
                <RespondToInquiryDialog
                    target={respondingTo}
                    onClose={() => setRespondingTo(null)}
                    // Only a genuinely successful send records the response — the
                    // whole point of this control is that what we store matches
                    // what actually left the building. Returning the outcome lets
                    // the dialog say whether the record actually landed, instead
                    // of assuming it did.
                    onResponded={() =>
                        mutate(respondingTo.opportunityId, { action: 'mark_responded' }, 'Response recorded')
                    }
                />
            )}

            {launchingId && (
                <LaunchFundraiserDialog
                    opportunityId={launchingId}
                    onClose={() => setLaunchingId(null)}
                    // A launched opportunity leaves this panel entirely — it is now a
                    // campaign, and the campaign surfaces are authoritative from here.
                    // FR-ACCEPTANCE-1D: silent, for the same reason mutate() is.
                    // A plain load() sets `loading`, and the early return above
                    // swaps the WHOLE panel for a spinner — unmounting this
                    // dialog while it is showing the coordinator setup link the
                    // tenant is about to copy. The dialog stays mounted because
                    // launchingId does not change here; only its own Done/Cancel
                    // buttons close it.
                    onLaunched={() => load(true)}
                />
            )}
        </div>
    );
}
