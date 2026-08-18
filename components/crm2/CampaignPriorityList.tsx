"use client";

/**
 * CRM-CC-2 — the Campaign Priority List.
 *
 * Replaces the legacy 7-column campaigns table with a prioritized working
 * list. The ordering authority is CRM-CC-1's triage (lib/growth/nextAction),
 * arranged by lib/growth/campaignSections — this component renders, it never
 * re-decides.
 *
 * Row contract, in reading order: WHO (campaign + organization) → HOW IS IT
 * DOING (one primary signal: GE-3 health for active campaigns, stage chip for
 * everything else) → WHAT MATTERS (date, held orders, progress in words) →
 * WHAT SHOULD I DO (at most ONE labeled primary action from triage; everything
 * else behind a labeled overflow menu). A healthy campaign gets no invented
 * button — its section already says it is fine.
 *
 * Deliberately NOT here (deferred to CRM-CC-4): a campaign detail drawer.
 * Row navigation keeps the narrowest truthful existing destination — the
 * organization profile — exactly as the old table's chevron did.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { MoreHorizontal, ChevronDown, ChevronUp, CheckCircle2, Loader2 } from 'lucide-react';
import { CampaignHealthBadge } from './CampaignHealthBadge';
import { StageChip } from './StageChip';
import type { CampaignForTriage, CampaignTriage } from '@/lib/growth/nextAction';
import {
    groupCampaignsByPriority,
    formatBundleProgress,
    type CampaignSection,
} from '@/lib/growth/campaignSections';
import type { CampaignPriority } from '@/lib/growth/nextAction';
import { buildCoordinatorAccessUrl } from '@/lib/fundraiserUrls';

export interface PriorityListCampaign extends CampaignForTriage {
    id: string;
    name: string;
    customer_id: string;
    customer: { name: string; contact_name?: string | null };
    business_slug?: string;
    held_order_total?: number;
    weighted_bundles_sold?: number;
    progress_percent?: number;
    bundle_goal?: number;
}

const SECTION_DOT: Record<CampaignPriority, string> = {
    needs_attention: 'bg-rose-500',
    worth_a_look: 'bg-amber-500',
    on_pace: 'bg-emerald-500',
    upcoming: 'bg-sky-500',
    completed: 'bg-slate-400',
};

export function CampaignPriorityList({
    campaigns,
    loading,
    totalCount,
    searchTerm,
    filterStatus,
    now,
    onCloseout,
    onOpenDetail,
}: {
    /** Already search/filter-scoped rows from the page. */
    campaigns: PriorityListCampaign[];
    loading: boolean;
    /** Unfiltered count — distinguishes "no campaigns yet" from "no match". */
    totalCount: number;
    searchTerm: string;
    filterStatus: string;
    /** One clock for the whole render, supplied by the page. */
    now: Date;
    /** Existing Phase 7E closeout modal opener. */
    onCloseout: (c: PriorityListCampaign) => void;
    /** CRM-CC-4 — opens the Campaign Context drawer for one campaign. */
    onOpenDetail?: (c: PriorityListCampaign & { triage: CampaignTriage }) => void;
}) {
    // Which sections are folded. Seeded lazily from each section's default the
    // first time it is toggled; until then the meta default applies.
    const [collapsed, setCollapsed] = useState<Partial<Record<CampaignPriority, boolean>>>({});
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);

    if (loading) {
        // CRM-CC-5: one loading vocabulary across the three tabs — carded
        // container, spinner, sentence-case copy.
        return (
            <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm px-5 py-16 text-center text-slate-400 font-bold flex items-center justify-center gap-2">
                <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Loading campaigns…
            </div>
        );
    }

    if (campaigns.length === 0) {
        return (
            <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm px-5 py-14 text-center">
                {totalCount === 0 && !searchTerm ? (
                    <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                        No fundraiser campaigns yet — launch your first fundraiser and it will appear here.
                    </p>
                ) : searchTerm ? (
                    <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                        No campaigns match &ldquo;{searchTerm}&rdquo;.
                    </p>
                ) : filterStatus === 'attention' ? (
                    <p className="flex items-center justify-center gap-2 text-sm font-bold text-slate-500 dark:text-slate-400">
                        <CheckCircle2 size={16} className="text-emerald-500 flex-none" aria-hidden="true" />
                        Nothing needs your attention right now.
                    </p>
                ) : (
                    <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                        No campaigns in this view.
                    </p>
                )}
            </div>
        );
    }

    const sections = groupCampaignsByPriority(campaigns, now);

    const isCollapsed = (s: CampaignSection<PriorityListCampaign>) =>
        collapsed[s.priority] ?? s.meta.collapsedByDefault;

    return (
        <div className="space-y-5">
            {sections.map((section) => {
                const folded = isCollapsed(section);
                const headingId = `campaign-section-${section.priority}`;
                return (
                    <section key={section.priority} aria-labelledby={headingId}>
                        {/* Only "Recently completed" folds — live work stays visible.
                            The h3 wraps the button (never the reverse): a heading
                            inside a button is invalid nesting that screen readers
                            drop, leaving the toggle nameless. */}
                        {section.meta.collapsedByDefault ? (
                            <h3 id={headingId} className="px-1">
                                <button
                                    type="button"
                                    aria-expanded={!folded}
                                    onClick={() => setCollapsed((p) => ({ ...p, [section.priority]: !folded }))}
                                    className="flex w-full items-center gap-2 min-h-[44px] text-left"
                                >
                                    <SectionHeadingContent section={section} />
                                    {folded
                                        ? <ChevronDown size={14} className="text-slate-400" aria-hidden="true" />
                                        : <ChevronUp size={14} className="text-slate-400" aria-hidden="true" />}
                                </button>
                            </h3>
                        ) : (
                            <h3 id={headingId} className="flex items-center gap-2 px-1 pb-1.5">
                                <SectionHeadingContent section={section} />
                            </h3>
                        )}

                        {!folded && (
                            <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm divide-y divide-slate-50 dark:divide-slate-700/50">
                                {section.campaigns.map((c) => (
                                    <CampaignRow
                                        key={c.id}
                                        c={c}
                                        now={now}
                                        menuOpen={openMenuId === c.id}
                                        onToggleMenu={() => setOpenMenuId((id) => (id === c.id ? null : c.id))}
                                        onCloseMenu={() => setOpenMenuId(null)}
                                        onCloseout={onCloseout}
                                        onOpenDetail={onOpenDetail}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                );
            })}
        </div>
    );
}

function SectionHeadingContent({ section }: { section: CampaignSection<PriorityListCampaign> }) {
    return (
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                <span className={`w-2 h-2 rounded-full ${SECTION_DOT[section.priority]}`} aria-hidden="true" />
                {section.meta.title}
                <span className="text-slate-400 dark:text-slate-500 font-bold">({section.campaigns.length})</span>
            </span>
            <span className="text-[11px] font-medium text-slate-400 normal-case tracking-normal">
                {section.meta.description}
            </span>
        </span>
    );
}

function CampaignRow({
    c,
    now,
    menuOpen,
    onToggleMenu,
    onCloseMenu,
    onCloseout,
    onOpenDetail,
}: {
    c: PriorityListCampaign & { triage: CampaignTriage };
    now: Date;
    menuOpen: boolean;
    onToggleMenu: () => void;
    onCloseMenu: () => void;
    onCloseout: (c: PriorityListCampaign) => void;
    onOpenDetail?: (c: PriorityListCampaign & { triage: CampaignTriage }) => void;
}) {
    const action = c.triage.action;
    const isActiveRow = c.status === 'Active' && c.triage.priority !== 'completed';
    const progress = formatBundleProgress(c.weighted_bundles_sold, c.bundle_goal, c.progress_percent);

    // CRM-CC-5 — the overflow popup is announced as a menu, so it behaves like
    // one: focus moves to the first item on open, arrows move between items,
    // Escape (below) returns focus to the trigger, and losing focus closes it.
    const menuRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (menuOpen) {
            menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        }
    }, [menuOpen]);
    const moveMenuFocus = (delta: 1 | -1) => {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        if (items.length === 0) return;
        const idx = items.indexOf(document.activeElement as HTMLElement);
        items[(idx + delta + items.length) % items.length]?.focus();
    };

    const end = c.end_date ? new Date(c.end_date) : null;
    const endValid = end && !Number.isNaN(end.getTime());
    const ended = endValid && end!.getTime() < now.getTime();

    // Every capability the old table exposed, preserved — just not as five
    // mystery icons. The primary action stays out of this list.
    const menuItems: { key: string; label: string; href?: string; newTab?: boolean; onClick?: () => void; warn?: boolean }[] = [];
    menuItems.push({ key: 'org', label: 'View organization', href: `/fundraisers/${c.customer_id}` });
    if (!c.is_placeholder && c.business_slug) {
        menuItems.push({ key: 'public', label: 'Public order page', href: `/shop/${c.business_slug}/fundraiser/${c.id}`, newTab: true });
    }
    if (!c.is_placeholder && c.portal_token) {
        menuItems.push({ key: 'portal', label: 'Coordinator portal', href: buildCoordinatorAccessUrl(null, c.portal_token), newTab: true });
    }
    if (!c.is_placeholder) {
        menuItems.push({ key: 'invoice', label: 'Create invoice', href: `/customers/${c.customer_id}?tab=fundraisers&action=invoice&campaignId=${c.id}` });
    }
    if (!c.is_placeholder && c.triage.priority !== 'completed' && action?.kind !== 'closeout') {
        menuItems.push({ key: 'closeout', label: 'Close out fundraiser', onClick: () => onCloseout(c), warn: true });
    }

    return (
        // CRM-CC-5: horizontal row layout starts at xl, not lg. Breakpoints
        // track the VIEWPORT while the app sidebar eats ~256px of it — at a
        // 1024 viewport the fixed signal/meta columns crushed long campaign
        // names to one character per line. Stacked cards (the approved tablet
        // layout) carry every width below 1280.
        // `relative` so the overflow menu can anchor to the ROW below xl — a
        // 224px popup anchored to the button itself clips off the viewport edge
        // on stacked cards at 375.
        <div className="relative flex flex-col xl:flex-row xl:items-center gap-3 xl:gap-4 px-5 py-4">
            {/* WHO — the name opens the Campaign Context drawer (CRM-CC-4).
                A real button, not a clickable card: the row's other controls
                (primary action, More menu) stay independently operable. */}
            <div className="min-w-0 xl:flex-1">
                {onOpenDetail ? (
                    <button
                        type="button"
                        onClick={() => onOpenDetail(c)}
                        className="text-left font-bold text-sm text-slate-900 dark:text-white leading-snug break-words hover:text-indigo-600 dark:hover:text-indigo-400 underline-offset-2 hover:underline min-h-[44px] xl:min-h-0 xl:py-0.5"
                    >
                        {c.name}
                    </button>
                ) : (
                    <Link href={`/fundraisers/${c.customer_id}`} className="font-bold text-sm text-slate-900 dark:text-white leading-snug break-words hover:text-indigo-600 dark:hover:text-indigo-400">
                        {c.name}
                    </Link>
                )}
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 break-words">
                    {c.customer.name}
                    {c.customer.contact_name ? ` · ${c.customer.contact_name}` : ''}
                </p>
            </div>

            {/* HOW IS IT DOING — one primary signal per row */}
            <div className="xl:w-56 xl:flex-none">
                {isActiveRow
                    ? <CampaignHealthBadge health={c.health} reasons={c.health_reasons} />
                    : <StageChip status={c.closed_at ? 'Closed' : c.status} />}
            </div>

            {/* WHAT MATTERS RIGHT NOW */}
            <div className="xl:w-48 xl:flex-none space-y-1">
                {endValid && (
                    <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                        {ended ? 'Ended' : 'Ends'} {format(end!, 'MMM d, yyyy')}
                    </p>
                )}
                {(c.held_order_count ?? 0) > 0 && (
                    <p className="text-xs font-bold text-violet-700 dark:text-violet-400">
                        {c.held_order_count} held · ${Number(c.held_order_total ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </p>
                )}
                {progress && (
                    <div>
                        <p className="text-xs font-bold text-slate-600 dark:text-slate-300">{progress.text}</p>
                        {progress.percent !== null && (
                            <div className="mt-1 h-1.5 w-full max-w-[10rem] bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden" aria-hidden="true">
                                <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${progress.percent}%` }} />
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* WHAT SHOULD I DO — one labeled action, everything else in the menu */}
            <div className="flex items-center gap-2 xl:flex-none">
                {action && (
                    action.kind === 'closeout' ? (
                        <button
                            type="button"
                            onClick={() => onCloseout(c)}
                            // aria-label pins the accessible name to the action verb;
                            // title stays as the hover explanation of WHY.
                            aria-label={`${action.label} — ${c.name}`}
                            title={action.reason}
                            className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900 text-xs font-bold hover:bg-amber-100 dark:hover:bg-amber-950/60 transition-colors"
                        >
                            {action.label}
                        </button>
                    ) : onOpenDetail ? (
                        // CRM-CC-4: non-closeout actions open the Campaign
                        // Context drawer, which carries the coordinator contact,
                        // bundle-selection state, and health reasons the action
                        // refers to — instead of the generic org profile.
                        <button
                            type="button"
                            onClick={() => onOpenDetail(c)}
                            aria-label={`${action.label} — ${c.name}`}
                            title={action.reason}
                            className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-950/60 transition-colors"
                        >
                            {action.label}
                        </button>
                    ) : (
                        <Link
                            href={`/fundraisers/${c.customer_id}`}
                            aria-label={`${action.label} — ${c.name}`}
                            title={action.reason}
                            className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-900 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-950/60 transition-colors"
                        >
                            {action.label}
                        </Link>
                    )
                )}

                <div
                    className="static xl:relative"
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') { onCloseMenu(); triggerRef.current?.focus(); }
                        else if (menuOpen && e.key === 'ArrowDown') { e.preventDefault(); moveMenuFocus(1); }
                        else if (menuOpen && e.key === 'ArrowUp') { e.preventDefault(); moveMenuFocus(-1); }
                    }}
                    onBlur={(e) => {
                        // Focus left the trigger+menu entirely → close, so the
                        // invisible click-away layer never lingers over the page.
                        if (menuOpen && !e.currentTarget.contains(e.relatedTarget as Node)) onCloseMenu();
                    }}
                >
                    <button
                        ref={triggerRef}
                        type="button"
                        aria-label={`More actions for ${c.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={onToggleMenu}
                        className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/60 transition-colors"
                    >
                        <MoreHorizontal size={16} aria-hidden="true" />
                    </button>
                    {menuOpen && (
                        <>
                            {/* Click-away layer; keyboard users close with Escape. */}
                            <div className="fixed inset-0 z-10" aria-hidden="true" onClick={onCloseMenu} />
                            <div
                                ref={menuRef}
                                role="menu"
                                aria-label={`Actions for ${c.name}`}
                                className="absolute right-0 top-full mt-1 z-20 w-56 max-w-[calc(100vw-2.5rem)] rounded-xl border border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg py-1"
                            >
                                {menuItems.map((item) =>
                                    item.href ? (
                                        <Link
                                            key={item.key}
                                            role="menuitem"
                                            href={item.href}
                                            target={item.newTab ? '_blank' : undefined}
                                            onClick={onCloseMenu}
                                            className="flex items-center min-h-[44px] px-4 py-1.5 text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/60"
                                        >
                                            {item.label}
                                            {item.newTab && (
                                                <>
                                                    <span aria-hidden="true">&nbsp;↗</span>
                                                    <span className="sr-only"> (opens in new tab)</span>
                                                </>
                                            )}
                                        </Link>
                                    ) : (
                                        <button
                                            key={item.key}
                                            role="menuitem"
                                            type="button"
                                            onClick={() => { onCloseMenu(); item.onClick?.(); }}
                                            className={`flex w-full items-center text-left min-h-[44px] px-4 py-1.5 text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-700/60 ${item.warn ? 'text-amber-700 dark:text-amber-400' : 'text-slate-600 dark:text-slate-300'}`}
                                        >
                                            {item.label}
                                        </button>
                                    ),
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
