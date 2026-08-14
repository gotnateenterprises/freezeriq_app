"use client";

/**
 * GE-5A-2 — Seasonal Rebooking Recommendations.
 *
 * The visible controls for the GE-5A-1 backend, which can propose reviewable
 * work and nothing else. This panel writes only through the existing GE-5A
 * APIs (policy on/off, evaluate, approve, dismiss) — it never touches
 * OutreachBatch, OutreachMessage, EmailDeliveryAttempt, or any other
 * FR-RETENTION table directly, and it sends no email itself.
 *
 * SAFETY LANGUAGE IS LOAD-BEARING. Every actionable card ends with
 * "No email has been sent," and approving one does not change that line —
 * the panel must never let a tenant read "Approve" as "Send."
 *
 * The offering evaluated against is the tenant's own current Seasonal
 * Lineup, reused from the same `/api/rebooking/seasonal-lineups` listing the
 * rest of this tab already relies on — there is no separate offering picker,
 * because nothing else in this CRM has one either. A lineup only becomes
 * eligible once it has been used for a real Seasonal Update at least once
 * (SeasonalOfferingStatus moves draft -> in_use there); a brand-new draft
 * lineup is not yet a season FreezerIQ can recommend against, and the empty
 * state below says so honestly rather than hiding the reason.
 */

import { useCallback, useEffect, useState } from 'react';
import { Sparkles, Loader2, Check, X, ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import {
    classifyActions,
    selectEmptyState,
    selectEligibleOffering,
    formatEvaluateResult,
    formatDisableMessage,
    ENABLE_MESSAGE,
    STATUS_PRESENTATION,
    type AutomationStatus,
    type EmptyStateKey,
} from '@/lib/growth/automationUi';

interface AutomationReason {
    kind: 'fact' | 'heuristic';
    code: string;
    detail: string;
}

interface AutomationAction {
    id: string;
    status: AutomationStatus;
    organization_name: string | null;
    offering_name: string | null;
    reasons: AutomationReason[];
    evidence_at: string;
    suppressed_reason: string | null;
    expired_reason: string | null;
    email_sent: false;
}

interface EligibleOffering {
    id: string;
    name: string;
}

const NEUTRAL_CHIP = 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700';

const TONE_CHIP: Record<StatusToneKey, string> = {
    candidate: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-400 dark:border-indigo-900',
    approved: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900',
    neutral: NEUTRAL_CHIP,
    suppressed: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900',
};

type StatusToneKey = 'candidate' | 'approved' | 'neutral' | 'suppressed';

/** Facts read plainly; heuristics are visibly softened, never stated as certain. */
function ReasonLine({ reason }: { reason: AutomationReason }) {
    if (reason.kind === 'heuristic') {
        return (
            <li className="text-slate-500 dark:text-slate-400">
                <span className="font-bold text-slate-600 dark:text-slate-300">Worth a look —</span> {reason.detail}
            </li>
        );
    }
    return <li className="text-slate-600 dark:text-slate-300">{reason.detail}</li>;
}

function StatusChip({ status }: { status: AutomationStatus }) {
    const cfg = STATUS_PRESENTATION[status];
    return (
        <span className={`inline-flex flex-none items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border ${TONE_CHIP[cfg.tone]}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
            {cfg.label}
        </span>
    );
}

/** Single source of copy for every empty state, keyed by selectEmptyState's decision. */
function emptyStateCopy(key: Exclude<EmptyStateKey, null>): string {
    switch (key) {
        case 'policy_off':
            return 'Turn on recommendations when you’d like FreezerIQ to look for past fundraiser organizations worth revisiting.';
        case 'never_evaluated':
            return 'Recommendations are on. Choose Find Recommendations when you’re ready.';
        case 'no_new_recommendations':
            return 'No new seasonal rebooking recommendations right now.';
        case 'only_history':
            return 'No active recommendations.';
    }
}

/** Always present on an actionable card. Approving never changes this line. */
function NoEmailSentNote() {
    return (
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
            <ShieldCheck size={13} className="flex-none" aria-hidden="true" /> No email has been sent.
        </p>
    );
}

export function SeasonalRecommendationsPanel() {
    const [policyLoading, setPolicyLoading] = useState(true);
    const [policyEnabled, setPolicyEnabled] = useState(false);
    const [policyUpdating, setPolicyUpdating] = useState(false);
    const [policyError, setPolicyError] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);

    const [offering, setOffering] = useState<EligibleOffering | null>(null);
    const [offeringChecked, setOfferingChecked] = useState(false);

    const [actions, setActions] = useState<AutomationAction[]>([]);
    const [actionsLoading, setActionsLoading] = useState(true);
    const [actionsError, setActionsError] = useState<string | null>(null);
    const [hasEvaluated, setHasEvaluated] = useState(false);

    const [evaluating, setEvaluating] = useState(false);
    const [evaluateMessage, setEvaluateMessage] = useState<string | null>(null);

    const [transitioning, setTransitioning] = useState<Record<string, 'approve' | 'dismiss'>>({});
    const [historyOpen, setHistoryOpen] = useState(false);

    const loadPolicy = useCallback(() => {
        setPolicyLoading(true);
        return fetch('/api/growth/automation/policy', { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load');
                return data;
            })
            .then((data) => {
                const row = (data.policies || []).find(
                    (p: { action_type: string }) => p.action_type === 'seasonal_rebooking_recommendation',
                );
                // Absent row = OFF. This is a fact about the current state, not a guess.
                setPolicyEnabled(Boolean(row?.enabled));
                setPolicyError(null);
            })
            .catch((e) => setPolicyError(e.message))
            .finally(() => setPolicyLoading(false));
    }, []);

    const loadOffering = useCallback(() => {
        return fetch('/api/rebooking/seasonal-lineups', { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                const lineups: { id: string; name: string; status: string; updatedAt: string }[] = data?.lineups || [];
                const eligible = selectEligibleOffering(lineups);
                setOffering(eligible ? { id: eligible.id, name: eligible.name } : null);
            })
            .catch(() => setOffering(null))
            .finally(() => setOfferingChecked(true));
    }, []);

    const loadActions = useCallback(() => {
        setActionsLoading(true);
        return fetch('/api/growth/automation/actions', { cache: 'no-store' })
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load');
                return data;
            })
            .then((data) => {
                setActions(data.actions || []);
                setActionsError(null);
            })
            .catch((e) => setActionsError(e.message))
            .finally(() => setActionsLoading(false));
    }, []);

    useEffect(() => { void loadPolicy(); void loadOffering(); void loadActions(); }, [loadPolicy, loadOffering, loadActions]);

    const setPolicy = async (next: boolean) => {
        setPolicyUpdating(true);
        setPolicyError(null);
        try {
            const res = await fetch('/api/growth/automation/policy', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action_type: 'seasonal_rebooking_recommendation', enabled: next }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not update recommendations.');
            setPolicyEnabled(Boolean(data.enabled));
            setStatusMessage(next ? ENABLE_MESSAGE : formatDisableMessage(data.retired_actions || 0));
            setEvaluateMessage(null);
            setHasEvaluated(false);
            await loadActions();
        } catch (e) {
            setPolicyError(e instanceof Error ? e.message : 'Could not update recommendations.');
        } finally {
            setPolicyUpdating(false);
        }
    };

    const findRecommendations = async () => {
        if (!offering) return;
        setEvaluating(true);
        setEvaluateMessage(null);
        try {
            const res = await fetch('/api/growth/automation/evaluate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seasonal_offering_id: offering.id }),
            });
            const data = await res.json();
            if (res.status === 409) {
                setEvaluateMessage('Recommendations are currently off.');
                return;
            }
            if (!res.ok) throw new Error(data.error || 'Could not check for recommendations right now.');
            // "New" is exact: an organization that already has a live recommendation
            // for this season is reused, not recreated, so it never inflates this count.
            setEvaluateMessage(formatEvaluateResult(data.created_count ?? 0));
            setHasEvaluated(true);
            await loadActions();
        } catch (e) {
            setEvaluateMessage(e instanceof Error ? e.message : 'Could not check for recommendations right now. Try again in a moment.');
        } finally {
            setEvaluating(false);
        }
    };

    const transition = async (id: string, kind: 'approve' | 'dismiss') => {
        setTransitioning((prev) => ({ ...prev, [id]: kind }));
        try {
            const res = await fetch(`/api/growth/automation/actions/${id}/${kind}`, { method: 'POST' });
            // 404/409 both mean the action moved since we last loaded it (approved by
            // someone else, suppressed, expired). The server already recorded the
            // correct state — refreshing shows it rather than leaving a stale card.
            await loadActions();
            if (!res.ok && res.status !== 409 && res.status !== 404) {
                const data = await res.json().catch(() => ({}));
                setActionsError(data.error || 'That action could not be completed.');
            } else {
                setActionsError(null);
            }
        } catch {
            setActionsError('Could not reach FreezerIQ. Check your connection and try again.');
        } finally {
            setTransitioning((prev) => { const next = { ...prev }; delete next[id]; return next; });
        }
    };

    const { active, history } = classifyActions(actions);
    const emptyStateKey = selectEmptyState({
        policyEnabled,
        activeCount: active.length,
        historyCount: history.length,
        hasEvaluated,
    });

    const loading = policyLoading || actionsLoading || !offeringChecked;

    return (
        <section aria-labelledby="ge5a-recommendations-heading" className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0">
                    <h3 id="ge5a-recommendations-heading" className="flex items-center gap-2 font-black text-slate-900 dark:text-white text-sm">
                        <Sparkles size={16} className="text-violet-500 flex-none" aria-hidden="true" />
                        Seasonal Rebooking Recommendations
                    </h3>
                    <p className="mt-1 text-[12px] font-medium text-slate-500 dark:text-slate-400 max-w-xl">
                        FreezerIQ can review your previous fundraiser organizations and suggest who may be worth contacting again.
                        No emails are sent automatically.
                    </p>
                </div>

                {/* The control is a verb, not a state badge: "Turn On" / "Turn Off"
                    can't be misread as a status. When enabled, the separate "On"
                    chip carries the state so the button stays purely an action. */}
                <div className="flex-none flex items-center gap-2">
                    {policyEnabled && (
                        <span className="inline-flex flex-none items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide border bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900">
                            <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                            On
                        </span>
                    )}
                    <button
                        type="button"
                        aria-label={policyEnabled
                            ? 'Turn off Seasonal Rebooking Recommendations'
                            : 'Turn on Seasonal Rebooking Recommendations'}
                        disabled={policyLoading || policyUpdating}
                        onClick={() => setPolicy(!policyEnabled)}
                        className={`flex-1 sm:flex-none inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl border font-black text-xs uppercase tracking-wide transition-colors disabled:opacity-50 ${
                            policyEnabled
                                ? 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700'
                                : 'bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700'
                        }`}
                    >
                        {(policyLoading || policyUpdating) && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                        {policyEnabled ? 'Turn Off' : 'Turn On'}
                    </button>
                </div>
            </div>

            {policyError && <p className="text-[11px] font-bold text-rose-600">{policyError}</p>}
            {statusMessage && !policyError && (
                <p role="status" className="text-[11px] font-bold text-slate-500 dark:text-slate-400">{statusMessage}</p>
            )}

            {loading ? (
                <div className="py-8 text-center text-slate-400 font-bold text-sm flex items-center justify-center gap-2">
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading recommendations…
                </div>
            ) : !policyEnabled ? (
                /* Dormant state stays deliberately light: one compact line, not a
                   tall placeholder — the panel earns its height only once it has
                   recommendations to show. */
                <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 py-3 px-4 text-center">
                    <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                        {emptyStateCopy('policy_off')}
                    </p>
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            type="button"
                            onClick={findRecommendations}
                            disabled={evaluating || !offering}
                            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 rounded-xl bg-indigo-600 text-white font-bold text-sm hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {evaluating ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Sparkles size={15} aria-hidden="true" />}
                            {evaluating ? 'Looking…' : 'Find Recommendations'}
                        </button>
                        {evaluateMessage && <p role="status" className="text-[11px] font-bold text-slate-500 dark:text-slate-400">{evaluateMessage}</p>}
                    </div>

                    {/* The tenant must know WHICH season is being searched before they
                        press the button — the eligible lineup is chosen for them, so
                        the choice has to be visible, not silent. */}
                    {offering ? (
                        <p className="text-[11px] font-bold text-slate-400">
                            Finding recommendations for:{' '}
                            <span className="text-slate-600 dark:text-slate-300">{offering.name}</span>
                        </p>
                    ) : (
                        <p className="text-[11px] font-bold text-slate-400">
                            Save and send a Seasonal Update first — FreezerIQ can look for recommendations once a season is underway.
                        </p>
                    )}

                    {actionsError && (
                        <p className="text-[11px] font-bold text-rose-600">{actionsError}</p>
                    )}

                    {/* Empty states — distinct copy for each real reason the list is empty,
                        keyed off the same decision selectEmptyState makes in tests. */}
                    {emptyStateKey && (
                        <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 py-8 px-5 text-center">
                            <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                                {emptyStateCopy(emptyStateKey)}
                            </p>
                        </div>
                    )}

                    {/* Recommendation cards */}
                    {active.length > 0 && (
                        <ul className="space-y-3">
                            {active.map((a) => (
                                <li key={a.id} className="bg-slate-50/60 dark:bg-slate-900/40 rounded-2xl border border-slate-100 dark:border-slate-700 p-4 space-y-3">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="font-black text-slate-900 dark:text-white text-sm break-words">
                                                {a.organization_name || 'This organization'}
                                            </p>
                                            {a.offering_name && (
                                                <p className="text-[11px] font-bold text-slate-400">Recommended for: {a.offering_name}</p>
                                            )}
                                        </div>
                                        <StatusChip status={a.status} />
                                    </div>

                                    {a.reasons?.length > 0 && (
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Why FreezerIQ suggested this</p>
                                            <ul className="space-y-1 text-[12px] font-medium list-disc list-inside">
                                                {a.reasons.map((r, i) => <ReasonLine key={i} reason={r} />)}
                                            </ul>
                                        </div>
                                    )}

                                    {a.status === 'candidate' ? (
                                        <div className="flex flex-wrap items-center gap-2 pt-1">
                                            <button
                                                type="button"
                                                onClick={() => transition(a.id, 'approve')}
                                                disabled={Boolean(transitioning[a.id])}
                                                className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-emerald-600 text-white font-bold text-xs uppercase tracking-wide hover:bg-emerald-700 transition-colors disabled:opacity-50"
                                            >
                                                {transitioning[a.id] === 'approve' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                                                Approve
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => transition(a.id, 'dismiss')}
                                                disabled={Boolean(transitioning[a.id])}
                                                className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs uppercase tracking-wide text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                                            >
                                                {transitioning[a.id] === 'dismiss' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                                                Dismiss
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="flex flex-wrap items-center gap-2 pt-1">
                                            <button
                                                type="button"
                                                onClick={() => transition(a.id, 'dismiss')}
                                                disabled={Boolean(transitioning[a.id])}
                                                className="inline-flex items-center gap-1.5 min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-xs uppercase tracking-wide text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                                            >
                                                {transitioning[a.id] === 'dismiss' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
                                                Dismiss
                                            </button>
                                        </div>
                                    )}

                                    <NoEmailSentNote />
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* History — collapsed by default, same instinct as the tab's own
                        default filter (needs_action, not all): recent/actionable first,
                        settled history available but not competing for attention. */}
                    {history.length > 0 && (
                        <div className="pt-1">
                            <button
                                type="button"
                                onClick={() => setHistoryOpen((v) => !v)}
                                aria-expanded={historyOpen}
                                className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-wide text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 min-h-[36px]"
                            >
                                {historyOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                                {historyOpen ? 'Hide' : 'Show'} history ({history.length})
                            </button>
                            {historyOpen && (
                                <ul className="mt-2 space-y-2">
                                    {history.map((a) => (
                                        <li key={a.id} className="rounded-xl border border-slate-100 dark:border-slate-700 p-3 flex flex-wrap items-center justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="font-bold text-slate-700 dark:text-slate-300 text-[13px] break-words">{a.organization_name || 'This organization'}</p>
                                                {a.status === 'suppressed' && (
                                                    <p className="text-[11px] text-slate-400">This organization can&apos;t currently be included in outreach.</p>
                                                )}
                                            </div>
                                            <StatusChip status={a.status} />
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
