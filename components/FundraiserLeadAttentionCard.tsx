'use client';

/**
 * FR-ACCEPTANCE-2A.2 — the main FreezerIQ Dashboard's fundraiser-lead signal.
 *
 * The tenant lands on the MAIN dashboard after login, not on the Fundraiser
 * CRM. A fundraiser prospect they have never seen is invisible unless something
 * on THIS page mentions it — this card is that mention.
 *
 * ── ACTIVE, NOT MERELY URGENT ──────────────────────────────────────────────
 *
 * A first version of this card showed only `priority === 'needs_attention'`.
 * That was wrong, and the case that proves it is the ordinary one: a brand-new
 * inquiry whose automatic acknowledgement has gone out and which is waiting for
 * the organization to name a date derives `priority: 'on_pace'` — not urgent,
 * entirely healthy, and completely invisible. The tenant would have had to
 * remember to open the Fundraiser CRM to discover a lead existed at all, which
 * is the exact problem this card was added to solve.
 *
 * So the card surfaces every ACTIVE pre-campaign lead, and distinguishes the
 * urgent subset rather than filtering to it. Discoverability first; urgency as
 * an annotation on top.
 *
 * ── TRUTHFULNESS RULES, matching AttentionStrip's ──────────────────────────
 * - Every number comes from GET /api/opportunities?open=1, the SAME endpoint
 *   and SAME server-side derivation (lib/growth/opportunityNextAction.ts) the
 *   Fundraiser CRM's own Leads tab renders from. No second classification.
 * - `?open=1` is what makes "active" true rather than asserted: it filters to
 *   OPEN_OPPORTUNITY_STATUSES, so converted (launched) and lost (not
 *   proceeding) rows are excluded at the source, not by a guess here.
 * - A failed fetch renders NOTHING rather than a stale or fabricated count.
 * - Zero active leads renders NOTHING. An empty "0 leads" card trains the
 *   tenant to stop reading it.
 * - Urgency is never invented: the count of urgent leads is only mentioned when
 *   it is non-zero, and it uses the canonical `needs_attention` priority.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Megaphone, ArrowRight } from 'lucide-react';

interface DashboardLead {
    id: string;
    bucket: string;
    priority: string;
    customer: { name: string };
    action: { label: string; reason: string; kind: string } | null;
    response_state: string;
}

/** The Fundraiser CRM's real Leads tab. Never /pipeline — that route has no page behind it. */
const LEADS_HREF = '/fundraisers?tab=leads';

/**
 * The one-line status for a single lead, in the tenant's own vocabulary.
 *
 * Two facts, because they answer different questions and the owner's example
 * shows both: what has already gone out ("Automatic acknowledgement sent"), and
 * what the lead is waiting on ("Waiting for preferred dates"). The second comes
 * from the canonical triage action label, so it can never drift from what the
 * CRM itself will say when the tenant clicks through.
 */
function leadStatusLines(lead: DashboardLead): string[] {
    const lines: string[] = [];
    if (lead.response_state === 'auto_ack_sent') lines.push('Automatic acknowledgement sent');
    else if (lead.response_state === 'manual_response') lines.push('You followed up');
    else if (lead.response_state === 'auto_ack_uncertain') lines.push('Acknowledgement not confirmed');
    if (lead.action?.label) lines.push(lead.action.label);
    return lines;
}

export function FundraiserLeadAttentionCard({ hasAccess }: { hasAccess: boolean }) {
    // null = not loaded yet, or the fetch failed — both render nothing.
    const [rows, setRows] = useState<DashboardLead[] | null>(null);

    useEffect(() => {
        if (!hasAccess) return;
        let cancelled = false;
        fetch('/api/opportunities?open=1')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((d) => { if (!cancelled) setRows(d.opportunities || []); })
            .catch(() => { /* stay null — omit the card rather than guess */ });
        return () => { cancelled = true; };
    }, [hasAccess]);

    if (!hasAccess || rows === null) return null;

    // Every row from ?open=1 is an active pre-campaign lead by construction:
    // launched (converted) and not-proceeding (lost) are excluded server-side.
    const active = rows;
    if (active.length === 0) return null;

    const urgent = active.filter((r) => r.priority === 'needs_attention');

    const shell = 'flex items-center gap-3 rounded-2xl border border-slate-100 dark:border-slate-700 border-l-4 bg-white dark:bg-slate-800 px-4 py-3 min-h-[56px] shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700/60 transition-colors';
    // Amber only when something genuinely needs attention. An ordinary healthy
    // lead is indigo — present and visible, but not dressed as a warning.
    const stripe = urgent.length > 0 ? 'border-l-amber-500' : 'border-l-indigo-500';
    const iconTone = urgent.length > 0
        ? 'text-amber-600 bg-amber-50 dark:bg-amber-900/30'
        : 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30';

    if (active.length === 1) {
        const lead = active[0];
        const status = leadStatusLines(lead);
        return (
            <Link href={LEADS_HREF} className={`${shell} ${stripe}`}>
                <span className={`grid h-9 w-9 flex-none place-items-center rounded-xl ${iconTone}`}>
                    <Megaphone size={18} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                    <b className="block text-[13px] font-black text-slate-900 dark:text-white leading-tight">
                        Fundraiser Lead
                    </b>
                    <span className="block truncate text-[12px] font-bold text-slate-600 dark:text-slate-300">
                        {lead.customer.name}
                    </span>
                    {status.length > 0 && (
                        <span className="block truncate text-[11px] font-bold text-slate-400">
                            {status.join(' · ')}
                        </span>
                    )}
                </span>
                <span className="flex-none inline-flex items-center gap-1 text-[11px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">
                    Review Lead <ArrowRight size={12} aria-hidden="true" />
                </span>
            </Link>
        );
    }

    return (
        <Link href={LEADS_HREF} className={`${shell} ${stripe}`}>
            <span className={`grid h-9 w-9 flex-none place-items-center rounded-xl ${iconTone}`}>
                <Megaphone size={18} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
                <b className="block text-[13px] font-black text-slate-900 dark:text-white leading-tight">
                    {active.length} active fundraiser leads
                </b>
                {/* Mentioned only when non-zero — never "0 need attention", which
                    would read as a warning about nothing. */}
                {urgent.length > 0 && (
                    <span className="block text-[11px] font-bold text-amber-600 dark:text-amber-400">
                        {urgent.length} need{urgent.length === 1 ? 's' : ''} attention
                    </span>
                )}
            </span>
            <span className="flex-none inline-flex items-center gap-1 text-[11px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-wide">
                Review <ArrowRight size={12} aria-hidden="true" />
            </span>
        </Link>
    );
}
