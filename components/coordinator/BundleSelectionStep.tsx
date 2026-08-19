'use client';

/**
 * CB-3: BundleSelectionStep
 *
 * Coordinator-facing bundle-family selection experience.
 * Fetches GET /api/coordinator/[token]/bundle-selection on mount,
 * renders candidate family cards, enforces the configured count,
 * submits POST /api/coordinator/[token]/bundle-selection, and
 * renders a completed summary on success.
 *
 * SECURITY NOTE:
 *   CB-3 provides the coordinator selection user experience only.
 *   Mandatory server-side campaign bundle order gates remain scheduled for CB-5.
 *
 * PAYMENT BOUNDARY:
 *   This component processes no payments.
 */

import { useState, useEffect, useCallback } from 'react';
import {
    CoordinatorSetupFields,
    type CoordinatorSetupFieldValues,
    type CoordinatorLockedInfo,
} from '@/components/coordinator/CoordinatorSetupFields';
import {
    Loader2,
    CheckCircle2,
    AlertCircle,
    PackageOpen,
    ChevronRight,
    Check,
} from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────────

interface BundleVariantInfo {
    id: string;
    name: string;
    sku: string | null;
    price: number | null;
    imageUrl: string | null;
}

interface CandidateFamily {
    familyId: string;
    serves5: BundleVariantInfo;
    serves2: BundleVariantInfo | null;
    available: boolean;
    unavailableReason?: string;
}

interface SelectionCampaignInfo {
    id: string;
    name: string;
    selectionStatus: 'pending' | 'selected';
    selectionLimit: number;
    selectedAt: string | null;
}

interface BundleSelectionData {
    selectionRequired: true;
    campaign: SelectionCampaignInfo;
    candidateFamilies: CandidateFamily[];
    selectedFamilyIds: string[];
}

interface NotRequiredData {
    selectionRequired: false;
    message: string;
}

type SelectionApiResponse = BundleSelectionData | NotRequiredData;

interface SelectionState {
    loading: boolean;
    submitting: boolean;
    error: string | null;
    data: SelectionApiResponse | null;
    selectedFamilyIds: string[];
    // True once the server has confirmed 'selected' (via GET or POST success)
    completed: boolean;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface BundleSelectionStepProps {
    /**
     * Called after the server confirms a successful selection so the parent
     * page can reveal the normal ordering workflow.
     */
    onSelectionComplete: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatPrice(price: number | null): string {
    if (price === null) return '';
    return `$${price.toFixed(2)}`;
}

/** Order-insensitive set equality — no sorting, no casting. */
function familySetsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const setA = new Set<string>(a);
    return b.every((id) => setA.has(id));
}

// ── Component ────────────────────────────────────────────────────────────────

export function BundleSelectionStep({ onSelectionComplete }: BundleSelectionStepProps) {
    const [state, setState] = useState<SelectionState>({
        loading: true,
        submitting: false,
        error: null,
        data: null,
        selectedFamilyIds: [],
        completed: false,
    });

    // FR-FLOW-3 — coordinator logistics, submitted with the bundle choice.
    const [setupFields, setSetupFields] = useState<CoordinatorSetupFieldValues>({
        checksPayable: '', pickupLocation: '', deliveryTime: '',
        paymentInstructions: '', paymentLink: '',
    });
    const [lockedInfo, setLockedInfo] = useState<CoordinatorLockedInfo | null>(null);

    const apiPath = '/api/coordinator/bundle-selection';

    // ── Fetch current selection state ─────────────────────────────────────

    const fetchSelectionState = useCallback(async (): Promise<SelectionApiResponse | null> => {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        try {
            const res = await fetch(apiPath);
            if (res.status === 404) {
                setState((prev) => ({
                    ...prev,
                    loading: false,
                    error: 'Invalid coordinator link.',
                }));
                return null;
            }
            if (res.status === 410) {
                setState((prev) => ({
                    ...prev,
                    loading: false,
                    error: 'This campaign is no longer accepting bundle selections.',
                }));
                return null;
            }
            if (!res.ok) {
                setState((prev) => ({
                    ...prev,
                    loading: false,
                    error: "We couldn't load the bundle options. Check your connection and try again.",
                }));
                return null;
            }

            const data: SelectionApiResponse = await res.json();

            // Legacy campaign — not required
            if (!data.selectionRequired) {
                setState((prev) => ({
                    ...prev,
                    loading: false,
                    data,
                    completed: false,
                }));
                onSelectionComplete();
                return data;
            }

            // FR-FLOW-3: seed the logistics form and the read-only tenant facts.
            const extra = data as unknown as {
                setup?: Record<string, string | null>;
                locked?: CoordinatorLockedInfo;
            };
            if (extra.setup) {
                setSetupFields({
                    checksPayable: extra.setup.checksPayable ?? '',
                    pickupLocation: extra.setup.pickupLocation ?? '',
                    deliveryTime: extra.setup.deliveryTime ?? '',
                    paymentInstructions: extra.setup.paymentInstructions ?? '',
                    paymentLink: extra.setup.paymentLink ?? '',
                });
            }
            if (extra.locked) setLockedInfo(extra.locked);

            const isAlreadySelected = data.campaign.selectionStatus === 'selected';

            setState((prev) => ({
                ...prev,
                loading: false,
                data,
                completed: isAlreadySelected,
                // Pre-populate selections for display in the already-selected state
                selectedFamilyIds: isAlreadySelected ? data.selectedFamilyIds : prev.selectedFamilyIds,
            }));

            if (isAlreadySelected) {
                onSelectionComplete();
            }

            return data;
        } catch {
            setState((prev) => ({
                ...prev,
                loading: false,
                error: "We couldn't load the bundle options. Check your connection and try again.",
            }));
            return null;
        }
    }, [apiPath, onSelectionComplete]);

    useEffect(() => {
        fetchSelectionState();
    }, [fetchSelectionState]);

    // ── Selection toggle ──────────────────────────────────────────────────

    const toggleFamily = (familyId: string, limit: number) => {
        setState((prev) => {
            const already = prev.selectedFamilyIds.includes(familyId);
            if (already) {
                // Always removable before submission
                return {
                    ...prev,
                    selectedFamilyIds: prev.selectedFamilyIds.filter((id) => id !== familyId),
                    error: null,
                };
            }
            if (prev.selectedFamilyIds.length >= limit) {
                // Limit reached — do not add
                return prev;
            }
            return {
                ...prev,
                selectedFamilyIds: [...prev.selectedFamilyIds, familyId],
                error: null,
            };
        });
    };

    // ── Submit selection ──────────────────────────────────────────────────

    const handleSubmit = async () => {
        if (state.submitting) return;
        const data = state.data;
        if (!data || !data.selectionRequired) return;

        const limit = data.campaign.selectionLimit;
        if (state.selectedFamilyIds.length !== limit) return;

        // Snapshot the coordinator's submitted IDs before any async work.
        // Used by the 409 branch to determine whether the server's committed
        // selection is identical (idempotent) or different (conflict warning).
        const submittedFamilyIds = [...state.selectedFamilyIds];

        setState((prev) => ({ ...prev, submitting: true, error: null }));

        try {
            const res = await fetch(apiPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // The body carries the coordinator's own answers and nothing else:
                // no tenant, business, campaign or bundle id, and no delivery date,
                // deadline, organization share or selection limit. Those are tenant
                // authority and the server would refuse them anyway — not sending
                // them means there is nothing to refuse.
                body: JSON.stringify({
                    familyIds: submittedFamilyIds,
                    checksPayable: setupFields.checksPayable,
                    pickupLocation: setupFields.pickupLocation,
                    deliveryTime: setupFields.deliveryTime,
                    paymentInstructions: setupFields.paymentInstructions,
                    paymentLink: setupFields.paymentLink,
                }),
            });

            const body = await res.json().catch(() => null);

            if (res.ok) {
                // Success (200) — could be fresh or idempotent
                setState((prev) => ({
                    ...prev,
                    submitting: false,
                    completed: true,
                    error: null,
                }));
                onSelectionComplete();
                return;
            }

            if (res.status === 409) {
                // Conflict — refetch to get the authoritative server selection.
                // Compare submitted IDs against the server-selected IDs before
                // treating this as idempotent success or surfacing a warning.
                const latest = await fetchSelectionState();

                if (
                    latest !== null &&
                    latest.selectionRequired &&
                    latest.campaign.selectionStatus === 'selected'
                ) {
                    const sameSelection = familySetsEqual(
                        submittedFamilyIds,
                        latest.selectedFamilyIds,
                    );

                    if (sameSelection) {
                        // Idempotent — the submitted selection is already the server selection.
                        // fetchSelectionState already set completed=true and called onSelectionComplete.
                        setState((prev) => ({ ...prev, submitting: false, error: null }));
                    } else {
                        // A different selection was already committed by another session.
                        // Show the server-selected summary with a prominent warning.
                        setState((prev) => ({
                            ...prev,
                            submitting: false,
                            completed: true,
                            error: 'This bundle selection has already been submitted.',
                        }));
                        // onSelectionComplete was already called by fetchSelectionState above.
                    }
                } else {
                    // Refetch did not resolve to a selected state — surface a generic error.
                    setState((prev) => ({
                        ...prev,
                        submitting: false,
                        error: 'A conflict occurred. Please refresh the page and try again.',
                    }));
                }
                return;
            }

            if (res.status === 410) {
                setState((prev) => ({
                    ...prev,
                    submitting: false,
                    error: 'This campaign is no longer accepting bundle selections.',
                }));
                return;
            }

            // 400 or other — surface safe server message
            const message =
                body?.error ||
                'Something went wrong. Please check your selection and try again.';
            setState((prev) => ({ ...prev, submitting: false, error: message }));
        } catch {
            setState((prev) => ({
                ...prev,
                submitting: false,
                error: 'Network error. Please check your connection and try again.',
            }));
        }
    };

    // ── Loading ───────────────────────────────────────────────────────────

    if (state.loading) {
        return (
            <div
                className="bg-white border border-slate-200 rounded-2xl p-6 flex items-center justify-center gap-3"
                role="status"
                aria-label="Loading bundle options"
            >
                <Loader2 className="animate-spin text-indigo-600" size={20} />
                <span className="text-sm font-semibold text-slate-500">Loading bundle options…</span>
            </div>
        );
    }

    // ── API error (recoverable via Try Again) ────────────────────────────

    if (!state.data) {
        return (
            <div
                className="bg-red-50 border border-red-200 rounded-2xl p-5 space-y-3"
                role="alert"
            >
                <div className="flex items-start gap-3">
                    <AlertCircle className="text-red-500 mt-0.5 shrink-0" size={18} />
                    <div>
                        <p className="text-sm font-black text-red-900">Unable to load bundle options</p>
                        <p className="text-xs text-red-700 mt-0.5 font-medium">
                            {state.error ||
                                "We couldn't load the bundle options. Check your connection and try again."}
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => void fetchSelectionState()}
                    disabled={state.loading}
                    aria-label="Retry loading bundle options"
                    className="w-full rounded-xl border border-red-300 bg-white py-2.5 text-sm font-extrabold text-red-700
                        hover:bg-red-50 active:scale-[0.98] transition-all
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2
                        disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {state.loading ? (
                        <span className="flex items-center justify-center gap-2">
                            <Loader2 className="animate-spin" size={14} aria-hidden="true" />
                            Loading…
                        </span>
                    ) : (
                        'Try Again'
                    )}
                </button>
            </div>
        );
    }

    // ── Legacy campaign: not required ─────────────────────────────────────
    // Parent already called onSelectionComplete(); we render nothing here.
    if (!state.data.selectionRequired) {
        return null;
    }

    const { campaign, candidateFamilies } = state.data;
    const limit = campaign.selectionLimit;
    const selectedCount = state.selectedFamilyIds.length;
    const readyToSubmit = selectedCount === limit;

    // ── Completed summary ─────────────────────────────────────────────────

    if (state.completed) {
        const selectedNames = candidateFamilies
            .filter((f) => state.selectedFamilyIds.includes(f.familyId))
            .map((f) => f.serves5.name);

        const hasConflictWarning =
            state.error === 'This bundle selection has already been submitted.';

        return (
            <section
                className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 space-y-3"
                aria-label="Bundle selection complete"
            >
                <div className="flex items-center gap-2">
                    <CheckCircle2 className="text-emerald-600 shrink-0" size={20} aria-hidden="true" />
                    <h2 className="text-base font-black text-emerald-900">Bundles Selected!</h2>
                </div>
                <p className="text-sm text-emerald-800 font-medium leading-relaxed">
                    Your fundraiser bundles are ready. Supporters can now order either serving size from each
                    selected family.
                </p>
                {selectedNames.length > 0 && (
                    <ul className="space-y-1.5" aria-label="Selected bundle families">
                        {selectedNames.map((name) => (
                            <li key={name} className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
                                <Check size={14} className="text-emerald-600 shrink-0" aria-hidden="true" />
                                {name}
                            </li>
                        ))}
                    </ul>
                )}
                {/* 409 conflict warning — displayed when a different selection was already committed */}
                {hasConflictWarning && (
                    <div
                        className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-300 px-3 py-2.5"
                        role="alert"
                        aria-live="assertive"
                    >
                        <AlertCircle className="text-amber-600 shrink-0 mt-0.5" size={15} aria-hidden="true" />
                        <p className="text-xs font-semibold text-amber-800">
                            This bundle selection has already been submitted.
                        </p>
                    </div>
                )}
            </section>
        );
    }

    // ── Pending selection ─────────────────────────────────────────────────

    const availableCount = candidateFamilies.filter((f) => f.available).length;

    return (
        <section aria-labelledby="bundle-selection-heading" className="space-y-4">
            {/* Header */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-1">
                <div className="flex items-center gap-2">
                    <PackageOpen className="text-indigo-600 shrink-0" size={20} aria-hidden="true" />
                    <h2 id="bundle-selection-heading" className="text-base font-black text-slate-900">
                        Choose Your Fundraiser Bundles
                    </h2>
                </div>
                <p className="text-sm text-slate-500 font-medium leading-relaxed">
                    Your organizer has approved the following bundle options. Select exactly{' '}
                    <strong className="text-slate-700">{limit}</strong>{' '}
                    {limit === 1 ? 'family' : 'families'} for your campaign.
                </p>

                {/* Progress counter */}
                <div
                    className="mt-3 flex items-center gap-2"
                    role="status"
                    aria-live="polite"
                    aria-label={`${selectedCount} of ${limit} bundle families selected`}
                >
                    <div className="flex gap-1.5">
                        {Array.from({ length: limit }).map((_, i) => (
                            <div
                                key={i}
                                className={`h-2 w-6 rounded-full transition-colors ${
                                    i < selectedCount ? 'bg-indigo-600' : 'bg-slate-200'
                                }`}
                                aria-hidden="true"
                            />
                        ))}
                    </div>
                    <span className="text-xs font-bold text-slate-500">
                        {selectedCount} of {limit} selected
                    </span>
                </div>
            </div>

            {/* Candidate family cards */}
            <div
                className="space-y-3"
                role="group"
                aria-label={`Bundle families — choose ${limit}`}
            >
                {candidateFamilies.map((family) => {
                    const isSelected = state.selectedFamilyIds.includes(family.familyId);
                    const isAtLimit = selectedCount >= limit;
                    // A card is interactive-disabled when: unavailable, OR at limit and not currently selected
                    const isDisabled = !family.available || (!isSelected && isAtLimit);

                    return (
                        <FamilyCard
                            key={family.familyId}
                            family={family}
                            isSelected={isSelected}
                            isDisabled={isDisabled}
                            onToggle={() => toggleFamily(family.familyId, limit)}
                        />
                    );
                })}

                {availableCount === 0 && (
                    <div
                        className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-sm font-medium text-amber-800"
                        role="alert"
                    >
                        <AlertCircle className="inline mr-2 text-amber-600" size={16} aria-hidden="true" />
                        No bundle families are currently available. Please contact your organizer.
                    </div>
                )}
            </div>

            {/* Per-submission error */}
            {state.error && (
                <div
                    className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3"
                    role="alert"
                    aria-live="assertive"
                >
                    <AlertCircle className="text-red-500 mt-0.5 shrink-0" size={16} />
                    <p className="text-sm font-semibold text-red-800">{state.error}</p>
                </div>
            )}

            {/* Review + submit */}
            {selectedCount > 0 && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 space-y-3">
                    <p className="text-xs font-black uppercase text-indigo-400 tracking-wide">
                        Your selection
                    </p>
                    <ul className="space-y-1" aria-label="Selected families">
                        {candidateFamilies
                            .filter((f) => state.selectedFamilyIds.includes(f.familyId))
                            .map((f) => (
                                <li
                                    key={f.familyId}
                                    className="flex items-center gap-2 text-sm font-semibold text-indigo-900"
                                >
                                    <Check size={14} className="text-indigo-600 shrink-0" aria-hidden="true" />
                                    {f.serves5.name}
                                </li>
                            ))}
                    </ul>
                    {/* FR-FLOW-3 — the fundraiser's logistics, confirmed in the same
                        step and saved by the same submission. Deliberately below the
                        bundle choice: the coordinator answers "what are we selling"
                        before "where and when do people collect it". */}
                    <CoordinatorSetupFields
                        values={setupFields}
                        locked={lockedInfo}
                        disabled={state.submitting}
                        onChange={(patch) => setSetupFields((prev) => ({ ...prev, ...patch }))}
                    />
                    <button
                        onClick={handleSubmit}
                        disabled={!readyToSubmit || state.submitting}
                        aria-disabled={!readyToSubmit || state.submitting}
                        className={`w-full rounded-xl py-3.5 text-sm font-extrabold transition-all flex items-center justify-center gap-2
                            ${readyToSubmit && !state.submitting
                                ? 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-[0.98]'
                                : 'bg-indigo-200 text-indigo-400 cursor-not-allowed'
                            }`}
                    >
                        {state.submitting ? (
                            <>
                                <Loader2 className="animate-spin" size={16} aria-hidden="true" />
                                Confirming…
                            </>
                        ) : (
                            <>
                                Confirm Bundle Selection
                                <ChevronRight size={16} aria-hidden="true" />
                            </>
                        )}
                    </button>
                    {!readyToSubmit && !state.submitting && (
                        <p className="text-center text-xs text-indigo-500 font-medium" aria-live="polite">
                            Select {limit - selectedCount} more{' '}
                            {limit - selectedCount === 1 ? 'family' : 'families'} to continue
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}

// ── FamilyCard ────────────────────────────────────────────────────────────────

interface FamilyCardProps {
    family: CandidateFamily;
    isSelected: boolean;
    isDisabled: boolean;
    onToggle: () => void;
}

function FamilyCard({ family, isSelected, isDisabled, onToggle }: FamilyCardProps) {
    const { serves5, serves2, available, unavailableReason } = family;

    const cardClass = [
        'w-full text-left rounded-2xl border-2 p-4 space-y-3 transition-all',
        // Focus ring for keyboard
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2',
        !available
            ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
            : isSelected
            ? 'border-indigo-600 bg-indigo-50/40 shadow-sm cursor-pointer'
            : isDisabled
            ? 'border-slate-200 bg-slate-50 opacity-50 cursor-not-allowed'
            : 'border-slate-200 bg-white hover:border-indigo-300 hover:shadow-sm cursor-pointer',
    ].join(' ');

    return (
        <button
            type="button"
            onClick={!isDisabled ? onToggle : undefined}
            disabled={isDisabled}
            aria-pressed={isSelected}
            aria-disabled={isDisabled}
            className={cardClass}
        >
            {/* Card header row */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                    {/* Bundle image */}
                    {serves5.imageUrl ? (
                        <img
                            src={serves5.imageUrl}
                            alt={serves5.name}
                            className="w-14 h-14 rounded-xl object-cover shrink-0 bg-slate-100"
                        />
                    ) : (
                        <div
                            className="w-14 h-14 rounded-xl bg-slate-100 flex items-center justify-center shrink-0"
                            aria-hidden="true"
                        >
                            <PackageOpen size={24} className="text-slate-400" />
                        </div>
                    )}
                    <div className="min-w-0">
                        <p className="text-sm font-black text-slate-900 leading-snug truncate">
                            {serves5.name}
                        </p>
                        <p className="text-xs text-slate-400 font-medium mt-0.5">
                            Includes both serving sizes for your supporters
                        </p>
                    </div>
                </div>

                {/* Selection indicator */}
                <div
                    className={`w-5 h-5 rounded-full border-2 shrink-0 mt-0.5 flex items-center justify-center transition-colors ${
                        isSelected
                            ? 'border-indigo-600 bg-indigo-600'
                            : 'border-slate-300 bg-white'
                    }`}
                    aria-hidden="true"
                >
                    {isSelected && <Check size={11} className="text-white" strokeWidth={3} />}
                </div>
            </div>

            {/* Serving size details */}
            {available && (
                <div className="grid grid-cols-2 gap-2">
                    <VariantPill
                        label="Family Size"
                        description="Serves 5"
                        price={serves5.price}
                        sku={serves5.sku}
                    />
                    {serves2 ? (
                        <VariantPill
                            label="Smaller Size"
                            description="Serves 2"
                            price={serves2.price}
                            sku={serves2.sku}
                        />
                    ) : (
                        <div className="rounded-xl bg-slate-100 p-2.5 flex items-center justify-center">
                            <span className="text-xs text-slate-400 font-medium">Serves 2 unavailable</span>
                        </div>
                    )}
                </div>
            )}

            {/* Unavailable reason */}
            {!available && unavailableReason && (
                <p className="text-xs text-slate-500 font-medium leading-relaxed">
                    {unavailableReason}
                </p>
            )}
        </button>
    );
}

// ── VariantPill ───────────────────────────────────────────────────────────────

interface VariantPillProps {
    label: string;
    description: string;
    price: number | null;
    sku: string | null;
}

function VariantPill({ label, description, price }: VariantPillProps) {
    return (
        <div className="rounded-xl bg-slate-50 border border-slate-100 p-2.5 space-y-0.5">
            <p className="text-[10px] font-black uppercase text-slate-400 tracking-wide">{label}</p>
            <p className="text-xs font-semibold text-slate-700">{description}</p>
            {price !== null && (
                <p className="text-sm font-black text-slate-900">{formatPrice(price)}</p>
            )}
        </div>
    );
}
