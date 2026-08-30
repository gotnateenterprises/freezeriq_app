'use client';

/**
 * GE-3 — campaign health badge.
 *
 * Answers "which fundraiser needs my attention, and why?" inline in the
 * campaigns table, so the tenant never has to open each campaign to find out.
 *
 * Rules this component follows:
 *  · every state carries a WORD — colour is reinforcement, never the signal,
 *    so it still reads for a colour-blind user or in a greyscale print;
 *  · reasons are listed, not summarised into a score, because the reason is
 *    the actionable part;
 *  · nothing here predicts an outcome. The wording states what happened
 *    ("No orders in the last 9 days"), never what will happen.
 */

import { AlertTriangle, Eye, CheckCircle2, CircleDashed, Mail, Clock } from 'lucide-react';
import type { CampaignHealth, CampaignHealthReason } from '@/lib/growth/health';
import { resolveCoordinatorSetupStatus } from '@/lib/growth/coordinatorSetupStatus';

interface Props {
    health?: CampaignHealth;
    // Shared type, not a local copy — a reason's classification cannot drift
    // away from the engine that produced it.
    reasons?: CampaignHealthReason[];
    // CRM-ACTIVE-STATUS-UX-1 — optional. When a caller supplies these, the
    // badge can tell "coordinator setup still pending" and "set up and just
    // quiet" apart instead of collapsing both into "No signal yet". Any
    // caller that omits them keeps the original health-only rendering,
    // unchanged.
    status?: string;
    closedAt?: string | Date | null;
    bundleSelectionStatus?: string | null;
    coordinatorInviteSentAt?: string | Date | null;
}

const PRESENTATION: Record<Exclude<CampaignHealth, 'not_applicable'>, {
    label: string;
    className: string;
    Icon: typeof AlertTriangle;
}> = {
    at_risk: {
        label: 'Needs attention',
        className: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900',
        Icon: AlertTriangle,
    },
    watch: {
        label: 'Worth a look',
        className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
        Icon: Eye,
    },
    on_pace: {
        label: 'On pace',
        className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
        Icon: CheckCircle2,
    },
    no_signal: {
        label: 'No signal yet',
        className: 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
        Icon: CircleDashed,
    },
};

const SETUP_PRESENTATION: Record<'invite_not_sent' | 'waiting_on_coordinator' | 'open_for_orders', {
    className: string;
    Icon: typeof AlertTriangle;
}> = {
    invite_not_sent: {
        className: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
        Icon: Mail,
    },
    waiting_on_coordinator: {
        className: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
        Icon: Clock,
    },
    open_for_orders: {
        className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
        Icon: CheckCircle2,
    },
};

export function CampaignHealthBadge({ health, reasons, status, closedAt, bundleSelectionStatus, coordinatorInviteSentAt }: Props) {
    // Closed campaigns and lead placeholders render nothing at all — an empty
    // row is quieter and more honest than a "not applicable" chip.
    if (!health || health === 'not_applicable') return null;

    // CRM-ACTIVE-STATUS-UX-1: when the caller supplies enough to derive it,
    // the coordinator-setup status is strictly more specific than the generic
    // health label for these windows — it replaces "No signal yet" with the
    // real blocker (invite not sent / waiting on coordinator) or, once setup
    // is confirmed done, with the truthful "Open for orders". Every other
    // health value falls straight through to the original rendering below.
    const setupStatus = status
        ? resolveCoordinatorSetupStatus({
            status,
            closed_at: closedAt ?? null,
            bundle_selection_status: bundleSelectionStatus ?? null,
            coordinator_invite_sent_at: coordinatorInviteSentAt ?? null,
            health,
        })
        : null;

    if (setupStatus) {
        const { className, Icon } = SETUP_PRESENTATION[setupStatus.key];
        return (
            <div className="mt-1.5 max-w-[16rem]">
                <span
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${className}`}
                >
                    <Icon size={11} aria-hidden="true" />
                    {setupStatus.label}
                </span>
                {setupStatus.helper && (
                    <p className="mt-1 text-[10px] font-medium leading-snug text-slate-500 dark:text-slate-400">
                        {setupStatus.helper}
                    </p>
                )}
            </div>
        );
    }

    const { label, className, Icon } = PRESENTATION[health];
    const list = reasons ?? [];

    return (
        <div className="mt-1.5 max-w-[16rem]">
            <span
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${className}`}
            >
                <Icon size={11} aria-hidden="true" />
                {label}
            </span>
            {list.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                    {list.map((r) => (
                        <li key={r.code} className="text-[10px] font-medium leading-snug text-slate-500 dark:text-slate-400">
                            {r.label}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
