"use client";

/**
 * CRM-CC-1 — the needs-attention strip.
 *
 * This is the piece of the approved 2026-07-10 CRM redesign (CRM-1) that never
 * shipped: the dashboard's first band answers "what needs me today?" instead
 * of presenting passive counts. The 2026 handoff's AttentionStrip hand-rolled
 * its own staleness rules; this version feeds on the signals that now actually
 * exist — GE-3 health via lib/growth/nextAction triage, held-order facts from
 * the campaigns rows, FR-RETENTION's needs-action bucket, and GE-5A's open
 * recommendation candidates.
 *
 * TRUTHFULNESS RULES:
 * - Campaign numbers are derived from the rows the page already fetched.
 * - Rebooking and recommendation counts come from their EXISTING read-only
 *   APIs. If either call fails, that item is omitted — a missing chip is
 *   honest; a fabricated zero is not.
 * - When nothing needs attention the strip collapses to one quiet line, not a
 *   row of zero-value cards.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, PackageOpen, MailQuestion, Sparkles, CheckCircle2 } from 'lucide-react';
import { summarizeAttention, type CampaignForTriage } from '@/lib/growth/nextAction';

interface StripCampaign extends CampaignForTriage {
    held_order_total?: number;
}

interface AttentionItem {
    key: string;
    icon: typeof AlertTriangle;
    stripe: string;       // left-border accent class
    iconTone: string;
    title: string;
    sub: string;
    onClick?: () => void;
}

export function AttentionStrip({
    fundraisers,
    loading,
    onShowAttention,
    onGoRebooking,
}: {
    fundraisers: StripCampaign[];
    loading: boolean;
    /** Filters the campaign table to the attention set. */
    onShowAttention: () => void;
    /** Switches to the Rebooking tab (recommendations panel sits at its top). */
    onGoRebooking: () => void;
}) {
    // Auxiliary counts from existing APIs. null = not loaded or failed → omit.
    const [rebookingNeedsAction, setRebookingNeedsAction] = useState<number | null>(null);
    const [openRecommendations, setOpenRecommendations] = useState<number | null>(null);
    const [auxSettled, setAuxSettled] = useState(false);

    useEffect(() => {
        let cancelled = false;
        Promise.allSettled([
            fetch('/api/rebooking/contacts', { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => {
                    if (!cancelled && d?.counts && typeof d.counts.needs_action === 'number') {
                        setRebookingNeedsAction(d.counts.needs_action);
                    }
                })
                .catch(() => { /* omit the chip rather than guess */ }),
            fetch('/api/growth/automation/actions', { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => {
                    if (!cancelled && Array.isArray(d?.actions)) {
                        setOpenRecommendations(
                            d.actions.filter((a: { status?: string }) => a.status === 'candidate').length,
                        );
                    }
                })
                .catch(() => { /* omit the chip rather than guess */ }),
        ]).then(() => { if (!cancelled) setAuxSettled(true); });
        return () => { cancelled = true; };
    }, []);

    if (loading) return null;

    const summary = summarizeAttention(fundraisers, new Date());

    const items: AttentionItem[] = [];
    if (summary.needsAttention > 0) {
        items.push({
            key: 'campaigns',
            icon: AlertTriangle,
            stripe: 'border-l-amber-500',
            iconTone: 'text-amber-600 bg-amber-50 dark:bg-amber-900/30',
            title: `${summary.needsAttention} campaign${summary.needsAttention === 1 ? '' : 's'} need${summary.needsAttention === 1 ? 's' : ''} attention`,
            sub: 'Warning signs, or ended with orders still held',
            onClick: onShowAttention,
        });
    }
    if (summary.heldOrders > 0) {
        items.push({
            key: 'held',
            icon: PackageOpen,
            stripe: 'border-l-violet-500',
            iconTone: 'text-violet-600 bg-violet-50 dark:bg-violet-900/30',
            title: `${summary.heldOrders} held order${summary.heldOrders === 1 ? '' : 's'} · $${summary.heldValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
            sub: 'Close out a campaign to release them to production',
            onClick: onShowAttention,
        });
    }
    if (rebookingNeedsAction !== null && rebookingNeedsAction > 0) {
        items.push({
            key: 'rebooking',
            icon: MailQuestion,
            stripe: 'border-l-indigo-500',
            iconTone: 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30',
            title: `${rebookingNeedsAction} rebooking item${rebookingNeedsAction === 1 ? '' : 's'} need${rebookingNeedsAction === 1 ? 's' : ''} review`,
            sub: 'Responses and requests waiting on you',
            onClick: onGoRebooking,
        });
    }
    if (openRecommendations !== null && openRecommendations > 0) {
        items.push({
            key: 'recommendations',
            icon: Sparkles,
            stripe: 'border-l-violet-500',
            iconTone: 'text-violet-600 bg-violet-50 dark:bg-violet-900/30',
            title: `${openRecommendations} recommendation${openRecommendations === 1 ? '' : 's'} waiting for review`,
            sub: 'Approve or dismiss on the Rebooking tab',
            onClick: onGoRebooking,
        });
    }

    // Quiet until the auxiliary counts settle, so "caught up" never flashes
    // before a real count arrives to contradict it.
    if (items.length === 0) {
        if (!auxSettled) return null;
        return (
            <p className="flex items-center gap-2 text-sm font-bold text-slate-400 dark:text-slate-500">
                <CheckCircle2 size={16} className="text-emerald-500 flex-none" aria-hidden="true" />
                You&apos;re caught up — nothing needs your attention right now.
            </p>
        );
    }

    return (
        <div className="flex flex-wrap gap-3" role="region" aria-label="Needs attention today">
            {items.map((it) => (
                <button
                    key={it.key}
                    type="button"
                    onClick={it.onClick}
                    className={`flex min-w-[230px] flex-1 items-center gap-3 rounded-2xl border border-slate-100 dark:border-slate-700 border-l-4 ${it.stripe} bg-white dark:bg-slate-800 px-4 py-3 min-h-[56px] text-left shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700/60 transition-colors`}
                >
                    <span className={`grid h-9 w-9 flex-none place-items-center rounded-xl ${it.iconTone}`}>
                        <it.icon size={18} aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                        <b className="block text-[13px] font-black text-slate-900 dark:text-white leading-tight">{it.title}</b>
                        <span className="text-[11px] font-bold text-slate-400">{it.sub}</span>
                    </span>
                </button>
            ))}
        </div>
    );
}
