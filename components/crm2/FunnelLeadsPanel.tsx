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
import { Loader2, Mail, CalendarCheck, CalendarClock, Rocket, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { LaunchFundraiserDialog } from '@/components/crm2/LaunchFundraiserDialog';

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
    customer: { id: string; name: string; contact_name: string | null; contact_email: string | null; contact_phone: string | null };
    action: { label: string; reason: string; kind: string } | null;
}

/** Display order matches the order a lead actually moves through them. */
const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
    { key: 'needs_follow_up', label: 'Needs Follow-Up', hint: 'Waiting on a first reply for over a day' },
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

    const load = useCallback(() => {
        setLoading(true);
        fetch('/api/opportunities?open=1')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
            .then((d) => { setRows(d.opportunities || []); setError(false); })
            .catch(() => setError(true))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(); }, [load]);

    const mutate = async (id: string, body: Record<string, unknown>, okMsg: string) => {
        setBusyId(id);
        try {
            const res = await fetch(`/api/opportunities/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Update failed');
            toast.success(okMsg);
            load();
        } catch (e: any) {
            toast.error(e.message);
        } finally {
            setBusyId(null);
        }
    };

    if (loading) {
        return <div className="flex items-center gap-2 p-8 text-slate-500"><Loader2 className="animate-spin" size={16} /> Loading leads…</div>;
    }
    if (error) {
        return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Could not load fundraiser leads. <button onClick={load} className="font-bold underline">Try again</button>
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

                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        {!o.first_response_at && (
                                            <button
                                                disabled={busyId === o.id}
                                                onClick={() => mutate(o.id, { action: 'mark_responded' }, 'Marked as responded')}
                                                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
                                            >
                                                <Mail size={13} /> Mark responded
                                            </button>
                                        )}

                                        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                                            <CalendarClock size={13} /> Preferred
                                            <input
                                                type="date"
                                                defaultValue={o.preferred_delivery_date ? o.preferred_delivery_date.slice(0, 10) : ''}
                                                disabled={busyId === o.id}
                                                onChange={(e) => e.target.value && mutate(o.id, { action: 'set_dates', preferred_delivery_date: e.target.value }, 'Preferred delivery date saved')}
                                                className="rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                                            />
                                        </label>

                                        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                                            <CalendarCheck size={13} /> Confirm
                                            <input
                                                type="date"
                                                defaultValue={o.confirmed_delivery_date ? o.confirmed_delivery_date.slice(0, 10) : ''}
                                                disabled={busyId === o.id}
                                                onChange={(e) => e.target.value && mutate(o.id, { action: 'confirm_date', confirmed_delivery_date: e.target.value }, 'Delivery date confirmed')}
                                                className="rounded-lg border border-slate-200 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                                            />
                                        </label>

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

            {launchingId && (
                <LaunchFundraiserDialog
                    opportunityId={launchingId}
                    onClose={() => setLaunchingId(null)}
                    // A launched opportunity leaves this panel entirely — it is now a
                    // campaign, and the campaign surfaces are authoritative from here.
                    onLaunched={() => load()}
                />
            )}
        </div>
    );
}
