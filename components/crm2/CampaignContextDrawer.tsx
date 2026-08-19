"use client";

/**
 * CRM-CC-4 — the Campaign Context drawer.
 *
 * Answers "what is happening with THIS fundraiser?" without losing the
 * tenant's place in the Campaigns priority list: a right-side panel on
 * desktop, a full-width sheet on smaller screens.
 *
 * AUTHORITIES REUSED, NEVER REIMPLEMENTED:
 *  · health — GE-3 verdict + reasons via CampaignHealthBadge
 *  · next action — CRM-CC-1 triage (lib/growth/nextAction)
 *  · bundle selection — the existing BundleSelectionStatusCard, mounted as-is
 *  · closeout — the page's existing Phase 7E modal, via onCloseout
 *  · invoice — the existing Create-invoice navigation, presented as a neutral
 *    capability with no invented status (current data cannot prove whether an
 *    invoice exists, so the drawer never claims one is needed or missing)
 *
 * Coordinator contact context arrives from ONE on-demand fetch of the existing
 * /api/customers/[id] endpoint when the drawer opens — never per list row.
 * Only the masked-safe fields the org profile already shows are used; the
 * CRM-CC-3 raw-email response cleanup is untouched (this is the organization's
 * own contact record, which the profile page has always displayed).
 *
 * Deliberately NOT here: automatic invoice generation, automatic closeout,
 * any end-date scheduler — those belong to the future invoice/closeout audit.
 * The "Wrap up" section is structured so that work can later live there.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, Loader2, ExternalLink, Users, Receipt, Lock, Building2 } from 'lucide-react';
import { useDialogFocus } from './useDialogFocus';
import { CampaignHealthBadge } from './CampaignHealthBadge';
import { StageChip } from './StageChip';
import { BundleSelectionStatusCard } from './BundleSelectionStatusCard';
import type { PriorityListCampaign } from './CampaignPriorityList';
import type { CampaignTriage } from '@/lib/growth/nextAction';
import { formatBundleProgress } from '@/lib/growth/campaignSections';
import { detailSections, detailDateLine } from '@/lib/growth/campaignContextUi';
import { buildCoordinatorAccessUrl } from '@/lib/fundraiserUrls';
import { campaignDisplayStage } from '@/lib/campaignDisplayStage';

interface CoordinatorInfo {
    contact_name: string | null;
    email: string | null;
    phone: string | null;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">{children}</p>
    );
}

export function CampaignContextDrawer({
    campaign,
    now,
    onClose,
    onCloseout,
}: {
    /** Non-null opens the drawer. Carries the triage the list already derived. */
    campaign: (PriorityListCampaign & { triage: CampaignTriage }) | null;
    now: Date;
    onClose: () => void;
    /** The page's existing closeout modal opener. */
    onCloseout: (c: PriorityListCampaign) => void;
}) {
    const open = campaign !== null;

    // CRM-CC-5 — shared dialog treatment: focus in on open, background scroll
    // locked, Tab contained, focus restored to the trigger on close.
    const { panelRef, containTab } = useDialogFocus(open, campaign?.id);

    // Coordinator context — ONE on-demand fetch per open, existing endpoint.
    // failed=true means the READ failed; that renders differently from a
    // successful read that found no contact fields on file.
    const [coordinator, setCoordinator] = useState<CoordinatorInfo | null>(null);
    const [coordinatorLoading, setCoordinatorLoading] = useState(false);
    const [coordinatorFailed, setCoordinatorFailed] = useState(false);

    useEffect(() => {
        if (!open || !campaign) return;
        let cancelled = false;
        setCoordinator(null);
        setCoordinatorFailed(false);
        setCoordinatorLoading(true);
        fetch(`/api/customers/${campaign.customer_id}`, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((data) => {
                if (cancelled) return;
                const c = data?.customer ?? data;
                if (c && typeof c === 'object') {
                    setCoordinator({
                        contact_name: c.contact_name ?? null,
                        email: c.email ?? null,
                        phone: c.phone ?? null,
                    });
                }
            })
            .catch(() => { if (!cancelled) setCoordinatorFailed(true); })
            .finally(() => { if (!cancelled) setCoordinatorLoading(false); });
        return () => { cancelled = true; };
    }, [open, campaign?.customer_id, campaign?.id]);

    if (!open || !campaign) return null;

    const c = campaign;
    const sections = detailSections(c, now);
    const dateLine = detailDateLine(c, now);
    const progress = formatBundleProgress(c.weighted_bundles_sold, c.bundle_goal, c.progress_percent);
    const action = c.triage.action;
    const isActiveish = sections.lifecycle === 'active' || sections.lifecycle === 'ended_open';
    const awaitingCoordinatorSetup = campaignDisplayStage({
        status: c.status,
        closed_at: c.closed_at ?? null,
        bundle_selection_status: (c as any).bundle_selection_status ?? null,
    }).awaitingCoordinatorSetup;

    return (
        <div
            className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="campaign-context-title"
            onKeyDown={(e) => {
                if (e.key === 'Escape') { onClose(); return; }
                containTab(e);
            }}
        >
            {/* Click-away layer */}
            <div className="absolute inset-0" aria-hidden="true" onClick={onClose} />

            {/* Panel: right-side drawer on desktop, full-width sheet below sm */}
            <div
                ref={panelRef}
                tabIndex={-1}
                className="relative h-full w-full sm:max-w-[480px] bg-white dark:bg-slate-900 shadow-2xl overflow-y-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/40"
            >
                {/* ── Header ─────────────────────────────────────────────── */}
                <div className="sticky top-0 z-10 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-100 dark:border-slate-800 px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 id="campaign-context-title" className="text-base font-black text-slate-900 dark:text-white leading-snug break-words">
                                {c.name}
                            </h2>
                            <p className="mt-0.5 text-xs font-bold text-slate-500 dark:text-slate-400 break-words">
                                {/* inline-flex so min-h can give this link a real
                                    tap target on phones; collapses again at lg. */}
                                <Link
                                    href={`/fundraisers/${c.customer_id}`}
                                    className="inline-flex items-center min-h-[44px] xl:min-h-0 hover:text-indigo-600 dark:hover:text-indigo-400 underline-offset-2 hover:underline"
                                >
                                    {c.customer.name}
                                </Link>
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                {/* ONE primary signal: health for running campaigns,
                                    lifecycle stage for everything else. */}
                                {/* FR-FLOW-2B: a campaign still awaiting coordinator setup is
                                    not running yet, so a health badge would be measuring a
                                    fundraiser that has not started. The setup state is the
                                    one true signal until the coordinator submits. */}
                                {isActiveish && !awaitingCoordinatorSetup
                                    ? <CampaignHealthBadge health={c.health} />
                                    : <StageChip
                                        status={c.closed_at ? 'Closed' : c.status}
                                        bundleSelectionStatus={c.bundle_selection_status ?? null}
                                        closedAt={c.closed_at ?? null}
                                    />}
                                {dateLine && (
                                    <span className="text-xs font-bold text-slate-500 dark:text-slate-400">{dateLine}</span>
                                )}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close campaign details"
                            className="flex-none inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                        >
                            <X size={16} aria-hidden="true" />
                        </button>
                    </div>
                </div>

                <div className="px-5 py-4 space-y-5">
                    {/* ── Next step ──────────────────────────────────────── */}
                    {action && (
                        <div className="rounded-2xl border border-indigo-100 dark:border-indigo-900 bg-indigo-50/60 dark:bg-indigo-950/30 p-4 space-y-2">
                            <SectionLabel>Next step</SectionLabel>
                            <p className="text-sm font-black text-slate-900 dark:text-white">{action.label}</p>
                            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">{action.reason}</p>
                            {action.kind === 'closeout' && (
                                <button
                                    type="button"
                                    onClick={() => onCloseout(c)}
                                    className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900 text-xs font-bold hover:bg-amber-100 dark:hover:bg-amber-950/60 transition-colors"
                                >
                                    <Lock size={13} aria-hidden="true" /> Close out fundraiser
                                </button>
                            )}
                        </div>
                    )}

                    {/* ── Why (GE-3 reasons) ─────────────────────────────── */}
                    {sections.showHealth && (
                        <div className="space-y-1">
                            <SectionLabel>Why this needs a look</SectionLabel>
                            <CampaignHealthBadge health={c.health} reasons={c.health_reasons} />
                        </div>
                    )}

                    {/* ── Snapshot ───────────────────────────────────────── */}
                    {sections.showSnapshot && (progress || (c.held_order_count ?? 0) > 0) && (
                        <div className="space-y-2">
                            <SectionLabel>
                                {sections.lifecycle === 'completed' ? 'Final results' : 'Progress'}
                            </SectionLabel>
                            {progress && (
                                <div>
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{progress.text}</p>
                                    {progress.percent !== null && sections.lifecycle !== 'completed' && (
                                        <div className="mt-1.5 h-1.5 w-full max-w-[16rem] bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden" aria-hidden="true">
                                            <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${progress.percent}%` }} />
                                        </div>
                                    )}
                                </div>
                            )}
                            {(c.held_order_count ?? 0) > 0 && (
                                <p className="text-sm font-bold text-violet-700 dark:text-violet-400">
                                    {c.held_order_count} held order{(c.held_order_count ?? 0) === 1 ? '' : 's'} · $
                                    {Number(c.held_order_total ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                    <span className="block text-[11px] font-bold text-slate-400">
                                        Released to production at closeout
                                    </span>
                                </p>
                            )}
                        </div>
                    )}

                    {/* ── Bundle selection — the existing card, reused as-is.
                        No outer label: the card is self-labeling and renders
                        null for legacy/not_required campaigns, so a wrapper
                        heading would orphan above nothing. */}
                    {sections.showBundleSelection && (
                        <BundleSelectionStatusCard campaignId={c.id} />
                    )}

                    {/* ── Coordinator & organization ─────────────────────── */}
                    {sections.showCoordinator && (
                        <div className="space-y-2">
                            <SectionLabel>Coordinator &amp; organization</SectionLabel>
                            <div className="rounded-2xl border border-slate-100 dark:border-slate-800 p-4 space-y-2">
                                <p className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                                    <Building2 size={14} className="text-slate-400 flex-none" aria-hidden="true" />
                                    {c.customer.name}
                                </p>
                                {coordinatorLoading ? (
                                    <p className="flex items-center gap-2 text-xs font-bold text-slate-400">
                                        <Loader2 size={12} className="animate-spin" aria-hidden="true" /> Loading contact…
                                    </p>
                                ) : coordinator && (coordinator.contact_name || coordinator.email || coordinator.phone) ? (
                                    <div className="space-y-1 text-xs font-bold">
                                        {coordinator.contact_name && (
                                            <p className="text-slate-600 dark:text-slate-300">{coordinator.contact_name}</p>
                                        )}
                                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                                            {coordinator.email && (
                                                <a href={`mailto:${coordinator.email}`} className="inline-flex items-center min-h-[44px] xl:min-h-0 xl:py-1 text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2 break-all">
                                                    {coordinator.email}
                                                </a>
                                            )}
                                            {coordinator.phone && (
                                                <a href={`tel:${coordinator.phone}`} className="inline-flex items-center min-h-[44px] xl:min-h-0 xl:py-1 text-indigo-600 dark:text-indigo-400 hover:underline underline-offset-2">
                                                    {coordinator.phone}
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                ) : coordinatorFailed ? (
                                    // The READ failed — say so instead of silently
                                    // looking like there is no contact on file.
                                    <p className="text-xs font-bold text-slate-400">Couldn&apos;t load contact details.</p>
                                ) : (
                                    // The read succeeded and found nothing — a
                                    // useful absence, worth one quiet line.
                                    <p className="text-xs font-bold text-slate-400">No contact details on file yet.</p>
                                )}
                                <div className="flex flex-wrap gap-2 pt-1">
                                    <Link
                                        href={`/fundraisers/${c.customer_id}`}
                                        className="inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        View organization
                                    </Link>
                                    {!c.is_placeholder && c.portal_token && (
                                        <a
                                            href={buildCoordinatorAccessUrl(null, c.portal_token)}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                                        >
                                            <Users size={13} aria-hidden="true" /> Coordinator portal
                                            <span className="sr-only"> (opens in new tab)</span>
                                        </a>
                                    )}
                                    {!c.is_placeholder && c.business_slug && (
                                        <a
                                            href={`/shop/${c.business_slug}/fundraiser/${c.id}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                                        >
                                            <ExternalLink size={13} aria-hidden="true" /> Public order page
                                            <span className="sr-only"> (opens in new tab)</span>
                                        </a>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── Wrap up — the EXISTING capabilities only. The future
                        invoice/closeout automation will live here after its own
                        audit phase; nothing speculative renders today. ─────── */}
                    {(sections.showCloseout || sections.showInvoice) && (
                        <div className="space-y-2">
                            <SectionLabel>Wrap up</SectionLabel>
                            <div className="flex flex-wrap gap-2">
                                {sections.showCloseout && action?.kind !== 'closeout' && (
                                    <button
                                        type="button"
                                        onClick={() => onCloseout(c)}
                                        className="inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900 text-xs font-bold hover:bg-amber-100 dark:hover:bg-amber-950/60 transition-colors"
                                    >
                                        <Lock size={13} aria-hidden="true" /> Close out fundraiser
                                    </button>
                                )}
                                {sections.showInvoice && (
                                    <Link
                                        href={`/customers/${c.customer_id}?tab=fundraisers&action=invoice&campaignId=${c.id}`}
                                        className="inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                                    >
                                        <Receipt size={13} aria-hidden="true" /> Create invoice
                                    </Link>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
