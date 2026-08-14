"use client";

/**
 * FR-RETENTION-1B-1 — Rebooking tab.
 * Visual source of truth: docs/ai/prototypes/fr_retention_prototype.html (Screens 1 & 2).
 *
 * Rules this component enforces, from the approved product rulings:
 *  · exactly five filter chips; "Needs action" is the default
 *  · an empty "Needs action" view NEVER silently falls back to All — it shows the
 *    empty message plus a deliberate "View all rebooking contacts" action
 *  · one row per durable PERSON; people sharing an address stay separate rows
 *  · no scheduling / automatic-send control exists anywhere on this surface
 *  · "Send Seasonal Update" saves a real Seasonal Lineup, then walks the tenant
 *    through audience review and email preview before any send. Sending, token
 *    issuance, and suppression all happen in that chain — see
 *    SeasonalLineupDrawer / AudienceReviewDrawer / EmailPreviewDrawer.
 *
 * FR-RETENTION-6: row status, the Waiting/Done counts, and the per-row next step
 * are derived server-side from real outreach evidence. Rows no longer sit frozen
 * at "Ready to invite" after an update has actually gone out. The row action
 * REUSES the drawer chain above — it opens no new route and sends nothing itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { Users, AlertCircle, Loader2, Send, Inbox } from 'lucide-react';
import { SeasonalLineupDrawer, type SavedLineup } from './SeasonalLineupDrawer';
import { AudienceReviewDrawer } from './AudienceReviewDrawer';
import { EmailPreviewDrawer } from './EmailPreviewDrawer';
import { ReviewRequestDrawer, type RebookingRequest } from './ReviewRequestDrawer';
import { SeasonalRecommendationsPanel } from './SeasonalRecommendationsPanel';
import {
    REBOOKING_FILTERS,
    isQuietStatus,
    rebookingEmptyCopy,
    type RebookingFilter as Filter,
} from '@/lib/growth/rebookingUi';

interface OrgSummary {
    customer_id: string;
    name: string;
    archived: boolean;
    campaign_count: number;
    last_campaign_name: string | null;
    last_settlement_total: number | null;
}

interface ContactRow {
    contact_id: string;
    display_name: string;
    email_masked: string | null;
    is_shared_inbox: boolean;
    shares_address_with: number;
    needs_review: boolean;
    review_reason: string | null;
    organizations: OrgSummary[];
    status: string;
    status_label: string;
    exclusion_reason: string | null;
    next_step: string;
    /** FR-RETENTION-6 — which filter chip this row answers to, derived server-side. */
    bucket: 'ready_to_invite' | 'waiting' | 'needs_action' | 'done' | 'none';
    next_action: 'send_seasonal_update' | 'review_request' | 'start_fundraiser' | 'view_campaign' | 'fix_contact' | null;
    campaign_id: string | null;
    request_id: string | null;
    opportunity_id: string | null;
}

const NEUTRAL_CHIP = 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';

function statusChipClass(status: string) {
    switch (status) {
        case 'ready_to_invite': return NEUTRAL_CHIP;
        // Sent-and-waiting is genuinely informational — it is not something the
        // tenant has to act on, so it must not read as an alert.
        case 'update_sent': return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-400 dark:border-sky-900';
        case 'interested': return 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-400 dark:border-violet-900';
        case 'needs_review':
        case 'needs_coordinator': return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900';
        case 'ready_to_create': return 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-400 dark:border-indigo-900';
        case 'rebooked': return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900';
        case 'cant_email': return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900';
        case 'paused_until':
        case 'archived': return 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700';
        default: return NEUTRAL_CHIP;
    }
}

export function RebookingTab({ onStartFundraiser }: {
    /**
     * FR-RETENTION-5. The page above owns the StartFundraiserWizard, so the
     * handoff is one opportunity id passed up in memory. No id travels through a
     * URL, which keeps respondent notes and rebooking tokens out of query
     * strings by construction.
     */
    onStartFundraiser?: (opportunityId: string) => void;
} = {}) {
    const [rows, setRows] = useState<ContactRow[]>([]);
    const [counts, setCounts] = useState<Record<Filter, number>>({ all: 0, ready_to_invite: 0, waiting: 0, needs_action: 0, done: 0 });
    const [filter, setFilter] = useState<Filter>('needs_action');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // Seasonal Lineup shell state. Local only — never fetched, never persisted.
    const [lineupOpen, setLineupOpen] = useState(false);
    const [audienceOpen, setAudienceOpen] = useState(false);
    const [savedLineup, setSavedLineup] = useState<SavedLineup | null>(null);
    const [audienceSaved, setAudienceSaved] = useState(false);
    const [previewOpen, setPreviewOpen] = useState(false);
    // FR-RETENTION-4 — incoming responses.
    const [requests, setRequests] = useState<RebookingRequest[]>([]);
    const [openRequestId, setOpenRequestId] = useState<string | null>(null);

    const loadRequests = useCallback(() => {
        return fetch('/api/rebooking/requests', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (data?.requests) setRequests(data.requests); })
            // The rest of the tab is still useful without the requests panel.
            .catch(() => { /* no-op */ });
    }, []);

    useEffect(() => { void loadRequests(); }, [loadRequests]);

    // Reload the most recent saved lineup so the tenant can come back to it
    // after a refresh instead of starting over.
    useEffect(() => {
        let alive = true;
        fetch('/api/rebooking/seasonal-lineups', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive || !data?.lineups?.length) return;
                const latest: SavedLineup = data.lineups[0];
                setSavedLineup(latest);
                setAudienceSaved(Boolean(latest.hasAudience));
            })
            .catch(() => { /* the dashboard still works without a saved lineup */ });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        let alive = true;
        fetch('/api/rebooking/contacts', { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load');
                return data;
            })
            .then((data) => {
                if (!alive) return;
                setRows(data.contacts || []);
                setCounts(data.counts || { all: 0, ready_to_invite: 0, waiting: 0, needs_action: 0, done: 0 });
                setLoading(false);
            })
            .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
        return () => { alive = false; };
    }, []);

    // Still used to suppress a false "nothing needs your attention" while an
    // unreviewed request sits above the table — see the empty state below.
    const requestsNeedingAction = requests.filter((r) => r.needsAction).length;

    // FR-RETENTION-4 added `requestsNeedingAction` on top of the contact count,
    // because back then a pending request appeared NOWHERE in the contact table —
    // the CP1 route could not see responses at all.
    //
    // FR-RETENTION-6 removes that addition. The same people are now real rows
    // (Interested / Needs review / Needs a coordinator all land in needs_action),
    // so adding the requests again counted the identical work twice and left the
    // chip reading 7 while the filter showed 5. A chip that disagrees with its own
    // rows is the exact defect this checkpoint exists to remove.
    const displayCounts: Record<Filter, number> = counts;

    // FR-RETENTION-6 — filters read the SAME server-derived bucket the counts are
    // aggregated from, so a chip's number always matches the rows behind it.
    const visible = rows.filter((r) => (filter === 'all' ? true : r.bucket === filter));

    /**
     * The ONE way into the Seasonal Update chain. The header button and every
     * row-level "Include in your next Seasonal Update" call this same function,
     * so there is exactly one send path — CP6 adds no per-contact send.
     */
    const openSeasonalUpdate = () => {
        // Once a lineup has a reviewed audience it can no longer be edited, so go
        // straight back to the audience rather than opening an editor that would
        // only refuse.
        if (savedLineup?.hasAudience || audienceSaved) setAudienceOpen(true);
        else setLineupOpen(true);
    };

    /**
     * The row's next step. Where a real action exists it is a button wired to an
     * EXISTING handler; where none exists it stays plain text rather than
     * pretending to be clickable.
     */
    const NextStep = ({ r }: { r: ContactRow }) => {
        const label = r.next_step;
        // CRM-CC-3 — a row IN the work queue surfaces its action as a real
        // button (the Campaigns list's primary-action treatment); everything
        // else keeps the quieter text link. Same handlers either way.
        // inline-flex is load-bearing: `min-h` has no effect on an inline element,
        // so the anchor variant would otherwise render a ~15px tap target on
        // mobile while the button variants were fine.
        const base = r.bucket === 'needs_action'
            ? 'inline-flex items-center justify-center text-left min-h-[44px] px-4 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-950/60 transition-colors'
            : 'inline-flex items-center text-left text-[11px] font-bold underline-offset-2 hover:underline text-indigo-600 dark:text-indigo-400 min-h-[44px] lg:min-h-0 lg:py-1';

        switch (r.next_action) {
            case 'send_seasonal_update':
                return <button onClick={openSeasonalUpdate} className={base}>{label}</button>;
            case 'review_request':
                return r.request_id
                    ? <button onClick={() => setOpenRequestId(r.request_id)} className={base}>{label}</button>
                    : <span className="text-[11px] font-bold text-slate-400">{label}</span>;
            case 'start_fundraiser': {
                // The wizard lives on the page above and the prop is optional, so
                // the row only offers the action when it can actually perform it.
                const oppId = r.opportunity_id;
                return oppId && onStartFundraiser
                    ? <button onClick={() => onStartFundraiser(oppId)} className={base}>{label}</button>
                    : <span className="text-[11px] font-bold text-slate-400">{label}</span>;
            }
            case 'view_campaign':
                return r.campaign_id
                    ? <a href={`/fundraisers/${r.campaign_id}`} className={base}>View campaign</a>
                    : <span className="text-[11px] font-bold text-slate-400">{label}</span>;
            default:
                return <span className="text-[11px] font-bold text-slate-400">{label}</span>;
        }
    };

    if (loading) {
        return (
            <div className="py-20 text-center text-slate-400 font-bold flex items-center justify-center gap-2">
                <Loader2 size={18} className="animate-spin" /> Loading rebooking contacts…
            </div>
        );
    }

    if (error) {
        return (
            <div className="py-16 text-center space-y-3">
                <p className="font-bold text-rose-600">Couldn&apos;t load rebooking contacts.</p>
                <button onClick={() => window.location.reload()} className="px-5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm min-h-[44px]">
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {/* GE-5A-2 — safe recommendation foundation. Entirely self-contained:
                its own fetches, its own on/off state, writes only through the
                GE-5A APIs. It never touches the Seasonal Update chain below. */}
            <SeasonalRecommendationsPanel />

            {/* CRM-CC-3 — compact control bar. The counted filter chips ARE the
                summary, replacing the four KPI cards that used to say the same
                numbers a second time ~110px taller. "Needs action" leads and
                carries amber emphasis while work exists; it remains the default
                selection per the approved ruling. */}
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
                <div className="flex flex-wrap gap-2 flex-1 min-w-0">
                    {REBOOKING_FILTERS.map((f) => {
                        const active = filter === f.key;
                        const hot = f.emphasize && displayCounts[f.key] > 0;
                        return (
                            <button
                                key={f.key}
                                onClick={() => setFilter(f.key)}
                                aria-pressed={active}
                                className={`px-4 py-2 rounded-full text-[11px] font-black uppercase tracking-wide border transition-colors min-h-[44px] ${
                                    active
                                        ? hot
                                            ? 'bg-amber-600 text-white border-amber-600'
                                            : 'bg-indigo-600 text-white border-indigo-600'
                                        : hot
                                            ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900 hover:bg-amber-100'
                                            : 'bg-white dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700'
                                }`}
                            >
                                {f.label} <span className="opacity-65 tabular-nums ml-1">{displayCounts[f.key]}</span>
                            </button>
                        );
                    })}
                </div>

                <div className="flex flex-col items-stretch lg:items-end gap-1.5 flex-none">
                    <button
                        onClick={openSeasonalUpdate}
                        className="inline-flex items-center justify-center gap-2 px-5 min-h-[44px] rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 transition-colors"
                    >
                        <Send size={15} /> Send Seasonal Update
                    </button>
                    <span className="text-[11px] font-bold text-slate-400 lg:text-right">
                        {audienceSaved && savedLineup
                            ? `${savedLineup.name} · audience ready to preview`
                            : savedLineup
                                ? `Saved lineup: ${savedLineup.name} · coordinators choose ${savedLineup.coordinatorBundleLimit}`
                                : 'No updates sent yet.'}
                    </span>
                </div>
            </div>

            {/* FR-RETENTION-4 — responses that came back. Kept as its own panel
                because a request belongs to the ADDRESS that answered, while the
                table below is one row per durable person; folding them together
                would misrepresent both. */}
            {requests.length > 0 && (
                <section aria-labelledby="requests-heading" className="space-y-2.5">
                    <h3 id="requests-heading" className="text-[11px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                        <Inbox size={12} aria-hidden="true" /> Requests to review
                        <span className="text-slate-400 dark:text-slate-500 font-bold">({requests.length})</span>
                    </h3>
                    <ul className="space-y-2.5">
                        {requests.map((r) => (
                            <li key={r.id}>
                                <button
                                    onClick={() => setOpenRequestId(r.id)}
                                    className="w-full text-left bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 p-4 hover:border-indigo-200 dark:hover:border-indigo-800 transition-colors min-h-[44px]"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="font-black text-slate-900 dark:text-white text-sm truncate">{r.respondentName}</p>
                                            <p className="text-[11px] font-bold text-slate-400 truncate">
                                                {r.lineupName} · {r.organizations.filter((o) => o.status !== 'canceled').length} of{' '}
                                                {r.organizations.length} group{r.organizations.length === 1 ? '' : 's'}
                                                {r.wasEdited && <span className="text-amber-600"> · updated</span>}
                                            </p>
                                        </div>
                                        {r.needsAction && (
                                            <span className="flex-none px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900">
                                                Needs review
                                            </span>
                                        )}
                                    </div>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* Empty Needs-action: never silently shows All. Suppressed when a
                request above is itself waiting on a decision — "nothing needs
                your attention" directly under an unreviewed request would be a
                straightforward lie. */}
            {visible.length === 0 && filter === 'needs_action' && requestsNeedingAction === 0 && (
                <div className="glass-panel rounded-3xl border border-slate-100 dark:border-slate-700 py-14 px-6 text-center space-y-3">
                    <p className="text-lg font-black text-slate-900 dark:text-white">Nothing needs your attention right now.</p>
                    <p className="text-sm text-slate-500">New responses and requests will appear here.</p>
                    <button
                        onClick={() => setFilter('all')}
                        className="mt-2 px-5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800 min-h-[44px]"
                    >
                        View all rebooking contacts
                    </button>
                </div>
            )}

            {visible.length === 0 && filter !== 'needs_action' && (
                <div className="glass-panel rounded-3xl border border-slate-100 dark:border-slate-700 py-14 px-6 text-center">
                    <Users size={32} className="mx-auto text-slate-300 mb-3" aria-hidden="true" />
                    <p className="font-bold text-slate-500">{rebookingEmptyCopy(filter)}</p>
                </div>
            )}

            {/* Desktop table — lg and up, matching the Campaigns list's
                breakpoint so tablets get stacked cards, never a squeeze. */}
            {visible.length > 0 && (
                <div className="hidden lg:block bg-white dark:bg-slate-800 rounded-3xl overflow-hidden border border-slate-100 dark:border-slate-700 shadow-sm">
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-700">
                                    <th className="px-5 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Main contact</th>
                                    <th className="px-4 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Organizations</th>
                                    <th className="px-4 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Last fundraiser</th>
                                    <th className="px-4 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                                    <th className="px-4 py-3 text-[11px] font-black text-slate-400 uppercase tracking-widest">Next step</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                                {visible.map((r) => (
                                    /* Resting states (archived / paused) render dimmed —
                                       they are deliberately not work, and must not compete
                                       with rows that need a human. */
                                    <tr key={r.contact_id} className={`hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors ${isQuietStatus(r.status) ? 'opacity-60' : ''}`}>
                                        <td className="px-5 py-4">
                                            <p className="font-black text-slate-900 dark:text-white text-sm">{r.display_name}</p>
                                            <p className="text-[11px] font-bold text-slate-400">
                                                {r.email_masked || 'No email on file'}
                                                {r.shares_address_with > 0 && (
                                                    <span className="ml-1 text-violet-600">
                                                        · shared with {r.shares_address_with} other {r.shares_address_with === 1 ? 'person' : 'people'}
                                                    </span>
                                                )}
                                            </p>
                                        </td>
                                        <td className="px-4 py-4">
                                            <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                                {r.organizations[0]?.name || '—'}
                                                {r.organizations.length > 1 && (
                                                    <span className="ml-1.5 text-[10px] font-black uppercase tracking-wide text-violet-600 bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded">
                                                        {r.organizations.length} groups
                                                    </span>
                                                )}
                                            </p>
                                            {r.organizations.length > 1 && (
                                                <p className="text-[11px] text-slate-400 font-bold">{r.organizations.slice(1).map((o) => o.name).join(' · ')}</p>
                                            )}
                                        </td>
                                        <td className="px-4 py-4">
                                            {/* settlement_total is the FINAL CAMPAIGN TOTAL — the closeout
                                                API freezes it from all non-canceled orders. It is gross, and
                                                there is no verified calculation in this repository for what
                                                the organization actually retained. It is therefore labelled
                                                exactly as the coordinator view labels it, and never presented
                                                as an amount "kept". */}
                                            {r.organizations[0]?.last_settlement_total != null ? (
                                                <>
                                                    <p className="text-sm font-black tabular-nums">
                                                        ${Number(r.organizations[0].last_settlement_total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                    </p>
                                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">Final campaign total</p>
                                                </>
                                            ) : (
                                                <p className="text-[11px] text-slate-400 font-bold">
                                                    {r.organizations[0]?.campaign_count ? 'No result recorded' : 'First fundraiser'}
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-4 py-4">
                                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border ${statusChipClass(r.status)}`}>
                                                <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                                                {r.status_label}{r.exclusion_reason ? ` — ${r.exclusion_reason}` : ''}
                                            </span>
                                            {r.needs_review && (
                                                <p className="mt-1 text-[10px] font-black uppercase tracking-wide text-amber-600 flex items-center gap-1">
                                                    <AlertCircle size={11} /> Needs review
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-4 py-4">
                                            <NextStep r={r} />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Stacked cards below lg */}
            {visible.length > 0 && (
                <div className="lg:hidden space-y-3">
                    {visible.map((r) => (
                        <div key={r.contact_id} className={`bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 p-4 space-y-2.5 ${isQuietStatus(r.status) ? 'opacity-60' : ''}`}>
                            <div className="flex justify-between items-start gap-3">
                                <div className="min-w-0">
                                    <p className="font-black text-slate-900 dark:text-white text-sm break-words">{r.display_name}</p>
                                    <p className="text-[11px] font-bold text-slate-400 break-words">{r.organizations[0]?.name || '—'}</p>
                                </div>
                                <span className={`flex-none inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border ${statusChipClass(r.status)}`}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                                    {r.status_label}
                                </span>
                            </div>
                            {r.organizations.length > 1 && (
                                <p className="text-[11px] font-bold text-violet-600">{r.organizations.length} groups</p>
                            )}
                            {/* Mobile keeps an explicit "Next step" label. Without the
                                table header, the bare uppercase text was what read in
                                Production as a software-release notice. */}
                            <div className="border-t border-dashed border-slate-200 dark:border-slate-700 pt-2.5">
                                <p className="text-[10px] font-black uppercase tracking-wide text-slate-400">Next step</p>
                                <div className="mt-0.5"><NextStep r={r} /></div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Step 1 — the lineup itself. Saving persists it, then hands off
                to the audience review. Neither step sends email. */}
            <SeasonalLineupDrawer
                open={lineupOpen}
                initial={savedLineup}
                onCancel={() => setLineupOpen(false)}
                onSaved={(lineup) => {
                    setSavedLineup(lineup);
                    setAudienceSaved(false);
                    setLineupOpen(false);
                    setAudienceOpen(true);
                }}
            />

            {/* Step 2 — who gets this update. */}
            <AudienceReviewDrawer
                open={audienceOpen}
                lineupId={savedLineup?.id ?? null}
                lineupName={savedLineup?.name ?? ''}
                onClose={() => setAudienceOpen(false)}
                onFinalized={() => { setAudienceSaved(true); setAudienceOpen(false); setPreviewOpen(true); }}
            />

            {/* Step 3 — the real email preview. Each recipient's private
                rebooking link is minted at send time, never here. */}
            <EmailPreviewDrawer
                open={previewOpen}
                lineupId={savedLineup?.id ?? null}
                onBack={() => { setPreviewOpen(false); setAudienceOpen(true); }}
                onClose={() => setPreviewOpen(false)}
            />

            {/* Step 4 — reviewing what came back. Status changes only; creating
                the fundraiser itself is Checkpoint 5. */}
            <ReviewRequestDrawer
                open={openRequestId !== null}
                request={requests.find((r) => r.id === openRequestId) ?? null}
                onClose={() => setOpenRequestId(null)}
                onChanged={() => { void loadRequests(); }}
                onStartFundraiser={(opportunityId) => {
                    setOpenRequestId(null);
                    onStartFundraiser?.(opportunityId);
                }}
            />
        </div>
    );
}
