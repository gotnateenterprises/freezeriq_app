'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Package,
  Clock,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import { useDialogFocus } from './useDialogFocus';

// ── Types ────────────────────────────────────────────────────────────────────

interface SelectedFamily {
  familyId: string;
  name: string;
  serves5BundleId: string;
  serves5BundleName: string;
  serves2BundleId: string;
  serves2BundleName: string;
}

interface CandidateFamily {
  familyId: string;
  name: string;
  available: boolean;
}

interface SelectionData {
  campaign: {
    id: string;
    name: string;
    selectionStatus: string;
    selectionLimit: number;
    selectedAt: string | null;
  };
  candidateFamilies: CandidateFamily[];
  selectedFamilies: SelectedFamily[];
  activeBundleIds: string[];
  orderCount: number;
  canReset: boolean;
  requiresOverride: boolean;
  isClosed: boolean;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface BundleSelectionStatusCardProps {
  campaignId: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export function BundleSelectionStatusCard({ campaignId }: BundleSelectionStatusCardProps) {
  const [data, setData] = useState<SelectionData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Reset modal state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetResult, setResetResult] = useState<{ success: boolean; message: string } | null>(null);

  // Override modal state
  const [showOverride, setShowOverride] = useState(false);
  const [overrideSelectedFamilies, setOverrideSelectedFamilies] = useState<string[]>([]);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const [overrideResult, setOverrideResult] = useState<{ success: boolean; message: string } | null>(null);

  // CRM-CC-5 — both confirmation dialogs get the suite's shared dialog
  // treatment (focus in, Tab contained, scroll locked, focus restored).
  // Their Escape handlers stop propagation so closing a dialog never closes
  // the Campaign Context drawer this card can be mounted inside.
  const resetDialog = useDialogFocus(showResetConfirm);
  const overrideDialog = useDialogFocus(showOverride);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/bundle-selection`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to load' }));
        setError(err.error || 'Failed to load bundle selection status');
        return;
      }
      const json = await res.json();
      setData(json);
    } catch {
      setError('Failed to load bundle selection status');
    } finally {
      setIsLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Reset handler ────────────────────────────────────────────────────────

  const handleReset = async () => {
    setResetLoading(true);
    setResetResult(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/bundle-selection/reset`, {
        method: 'POST',
      });
      const json = await res.json();
      if (res.ok) {
        setResetResult({ success: true, message: json.message || 'Selection reset successfully.' });
        setShowResetConfirm(false);
        // Refresh data
        await fetchData();
      } else {
        setResetResult({ success: false, message: json.error || 'Reset failed.' });
      }
    } catch {
      setResetResult({ success: false, message: 'Reset failed. Please try again.' });
    } finally {
      setResetLoading(false);
    }
  };

  // ── Override handler ─────────────────────────────────────────────────────

  const handleOverride = async () => {
    setOverrideLoading(true);
    setOverrideResult(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/bundle-selection/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          familyIds: overrideSelectedFamilies,
          reason: overrideReason.trim(),
        }),
      });
      const json = await res.json();
      if (res.ok) {
        setOverrideResult({ success: true, message: json.message || 'Bundles updated successfully.' });
        setShowOverride(false);
        setOverrideSelectedFamilies([]);
        setOverrideReason('');
        setOverrideAcknowledged(false);
        // Refresh data
        await fetchData();
      } else {
        setOverrideResult({ success: false, message: json.error || 'Override failed.' });
      }
    } catch {
      setOverrideResult({ success: false, message: 'Override failed. Please try again.' });
    } finally {
      setOverrideLoading(false);
    }
  };

  // ── Toggle family selection for override ─────────────────────────────────

  const toggleOverrideFamily = (familyId: string) => {
    setOverrideSelectedFamilies((prev) => {
      if (prev.includes(familyId)) {
        return prev.filter((id) => id !== familyId);
      }
      return [...prev, familyId];
    });
  };

  // ── Loading state ────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[11px] text-slate-400 dark:bg-slate-800">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        Loading bundle selection…
      </div>
    );
  }

  if (error || !data) {
    return null; // Silent fail — don't clutter the card
  }

  const { campaign, candidateFamilies, selectedFamilies, orderCount, canReset, requiresOverride, isClosed } = data;
  const status = campaign.selectionStatus;

  // Legacy campaigns — no card at all
  if (status === 'not_required') {
    return null;
  }

  // ── Status badge ─────────────────────────────────────────────────────────

  const statusConfig = {
    pending: {
      icon: <Clock size={12} />,
      label: 'Waiting for coordinator selection',
      bg: 'bg-amber-50 dark:bg-amber-950',
      border: 'border-amber-200 dark:border-amber-900',
      text: 'text-amber-800 dark:text-amber-200',
    },
    selected: {
      icon: <CheckCircle2 size={12} />,
      label: 'Bundle selection completed',
      bg: 'bg-emerald-50 dark:bg-emerald-950',
      border: 'border-emerald-200 dark:border-emerald-900',
      text: 'text-emerald-800 dark:text-emerald-200',
    },
  };

  const config = statusConfig[status as keyof typeof statusConfig] ?? statusConfig.pending;

  return (
    <div className={`mt-2.5 rounded-xl border ${config.border} ${config.bg} overflow-hidden`}>
      {/* Header row */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={`flex w-full items-center gap-2 min-h-[44px] px-3 py-2.5 text-left ${config.text}`}
      >
        <Package size={13} className="flex-none" aria-hidden="true" />
        <span className="flex-1 text-[11px] font-bold">{config.label}</span>
        {status === 'pending' && (
          <span className="text-[10px] font-semibold opacity-75">
            {candidateFamilies.length} families in pool
          </span>
        )}
        {status === 'selected' && (
          <span className="text-[10px] font-semibold opacity-75">
            {selectedFamilies.length} selected · {orderCount} order{orderCount !== 1 ? 's' : ''}
          </span>
        )}
        {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-inherit px-3 pb-3 pt-2 space-y-2">
          {/* ── Pending state ──────────────────────────────────────────── */}
          {status === 'pending' && (
            <>
              <p className="text-[11px] text-slate-600 dark:text-slate-400">
                The coordinator needs to select {campaign.selectionLimit} bundle{' '}
                {campaign.selectionLimit === 1 ? 'family' : 'families'} before orders can be submitted.
              </p>
              {candidateFamilies.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Candidate pool
                  </p>
                  {candidateFamilies.map((f) => (
                    <div
                      key={f.familyId}
                      className="flex items-center gap-2 rounded-lg bg-white/60 px-2.5 py-1.5 text-[11px] dark:bg-slate-800/60"
                    >
                      <span className="font-bold text-slate-700 dark:text-slate-200">{f.name}</span>
                      {!f.available && (
                        <span className="text-[9px] font-semibold text-rose-600">Unavailable</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Selected state ─────────────────────────────────────────── */}
          {status === 'selected' && (
            <>
              {campaign.selectedAt && (
                <p className="text-[10px] text-slate-500">
                  Selected {new Date(campaign.selectedAt).toLocaleDateString()}
                </p>
              )}

              <div className="space-y-1">
                {selectedFamilies.map((f) => (
                  <div
                    key={f.familyId}
                    className="rounded-lg bg-white/60 px-2.5 py-2 dark:bg-slate-800/60"
                  >
                    <p className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                      {f.name}
                    </p>
                    {/* flex-wrap: two real bundle names side by side can exceed
                        the drawer sheet's width at 375 — wrap, never clip. */}
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                      <span>Serves 5: {f.serves5BundleName}</span>
                      <span>Serves 2: {f.serves2BundleName}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Order count */}
              <p className="text-[10px] text-slate-500">
                {orderCount === 0
                  ? 'No orders yet'
                  : `${orderCount} order${orderCount !== 1 ? 's' : ''} placed`}
              </p>

              {/* ── Actions ─────────────────────────────────────────────── */}
              {!isClosed && (
                <div className="pt-1">
                  {/* Reset button (zero orders) */}
                  {canReset && (
                    <button
                      type="button"
                      onClick={() => setShowResetConfirm(true)}
                      className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white min-h-[44px] px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:bg-slate-50 transition dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                    >
                      <RefreshCw size={11} aria-hidden="true" />
                      Reset selection
                    </button>
                  )}

                  {/* Override button (has orders) */}
                  {requiresOverride && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowOverride(true);
                        setOverrideSelectedFamilies([]);
                        setOverrideReason('');
                        setOverrideAcknowledged(false);
                        setOverrideResult(null);
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 min-h-[44px] px-3 py-1.5 text-[11px] font-bold text-amber-700 hover:bg-amber-100 transition dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
                    >
                      <AlertTriangle size={11} aria-hidden="true" />
                      Change future bundles
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Result messages ──────────────────────────────────────────── */}
          {resetResult && (
            <div
              className={`mt-1 rounded-lg px-3 py-2 text-[11px] font-bold ${
                resetResult.success
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
              }`}
            >
              {resetResult.message}
            </div>
          )}

          {overrideResult && !showOverride && (
            <div
              className={`mt-1 rounded-lg px-3 py-2 text-[11px] font-bold ${
                overrideResult.success
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
              }`}
            >
              {overrideResult.message}
            </div>
          )}
        </div>
      )}

      {/* ── Reset Confirmation Dialog ───────────────────────────────────── */}
      {showResetConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bundle-reset-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // stopPropagation: closing this dialog must not close the
              // Campaign Context drawer hosting the card.
              e.stopPropagation();
              if (!resetLoading) { setShowResetConfirm(false); setResetResult(null); }
              return;
            }
            resetDialog.containTab(e);
          }}
        >
          <div
            ref={resetDialog.panelRef}
            tabIndex={-1}
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-800 focus:outline-none"
          >
            <h3 id="bundle-reset-title" className="text-lg font-black text-slate-900 dark:text-white">
              Reset this bundle selection?
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              The coordinator will need to choose bundles again before new orders can be submitted.
            </p>

            <div className="mt-6 flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowResetConfirm(false);
                  setResetResult(null);
                }}
                className="rounded-xl min-h-[44px] px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100 transition dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={resetLoading}
                className="flex items-center gap-2 rounded-xl bg-indigo-600 min-h-[44px] px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 transition disabled:opacity-50"
              >
                {resetLoading && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                Reset and reopen selection
              </button>
            </div>

            {resetResult && !resetResult.success && (
              <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                {resetResult.message}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Override Dialog ─────────────────────────────────────────────── */}
      {showOverride && data && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bundle-override-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // stopPropagation: Escape here closes only this dialog — never
              // the drawer above, which would discard the typed reason.
              e.stopPropagation();
              if (!overrideLoading) { setShowOverride(false); setOverrideResult(null); }
              return;
            }
            overrideDialog.containTab(e);
          }}
        >
          <div
            ref={overrideDialog.panelRef}
            tabIndex={-1}
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-800 max-h-[90vh] overflow-y-auto focus:outline-none"
          >
            <h3 id="bundle-override-title" className="text-lg font-black text-slate-900 dark:text-white">
              Change future bundles
            </h3>

            {/* Warning */}
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950">
              <p className="text-[12px] font-bold text-amber-800 dark:text-amber-200">
                This campaign already has {orderCount} order{orderCount !== 1 ? 's' : ''}.
                Changing bundles will affect future orders only.
                Existing orders, prices, and quantities will remain unchanged.
              </p>
            </div>

            {/* Family selection */}
            <div className="mt-4 space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Select {campaign.selectionLimit} bundle{' '}
                {campaign.selectionLimit === 1 ? 'family' : 'families'}
              </p>
              {candidateFamilies
                .filter((f) => f.available)
                .map((f) => {
                  const isSelected = overrideSelectedFamilies.includes(f.familyId);
                  const atLimit = overrideSelectedFamilies.length >= campaign.selectionLimit;
                  return (
                    <button
                      key={f.familyId}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleOverrideFamily(f.familyId)}
                      disabled={!isSelected && atLimit}
                      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                        isSelected
                          ? 'border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950'
                          : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700'
                      } ${!isSelected && atLimit ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <div
                        className={`flex h-5 w-5 flex-none items-center justify-center rounded-md border-2 ${
                          isSelected
                            ? 'border-indigo-500 bg-indigo-500 text-white'
                            : 'border-slate-300 dark:border-slate-600'
                        }`}
                      >
                        {isSelected && <CheckCircle2 size={12} aria-hidden="true" />}
                      </div>
                      <span className="text-[12px] font-bold text-slate-700 dark:text-slate-200">
                        {f.name}
                      </span>
                    </button>
                  );
                })}

              <p className="text-[10px] text-slate-400">
                {overrideSelectedFamilies.length} of {campaign.selectionLimit} selected
              </p>
            </div>

            {/* Reason field */}
            <div className="mt-4">
              <label htmlFor="bundle-override-reason" className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Reason for change
              </label>
              <textarea
                id="bundle-override-reason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder="e.g. Seasonal inventory change"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
              />
              <p className="mt-0.5 text-right text-[10px] text-slate-400">
                {overrideReason.length}/500
              </p>
            </div>

            {/* Acknowledgement checkbox */}
            <label className="mt-3 flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={overrideAcknowledged}
                onChange={(e) => setOverrideAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-[11px] text-slate-600 dark:text-slate-400">
                I understand existing orders will not be changed.
              </span>
            </label>

            {/* Error message */}
            {overrideResult && !overrideResult.success && (
              <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[11px] font-bold text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                {overrideResult.message}
              </div>
            )}

            {/* Actions */}
            <div className="mt-5 flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowOverride(false);
                  setOverrideResult(null);
                }}
                className="rounded-xl min-h-[44px] px-4 py-2 text-sm font-bold text-slate-500 hover:bg-slate-100 transition dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleOverride}
                disabled={
                  overrideLoading ||
                  overrideSelectedFamilies.length !== campaign.selectionLimit ||
                  overrideReason.trim().length === 0 ||
                  !overrideAcknowledged
                }
                className="flex items-center gap-2 rounded-xl bg-indigo-600 min-h-[44px] px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {overrideLoading && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                Confirm future bundle change
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
