'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { Plus, ExternalLink, Calendar, Target, Megaphone, Loader2, Settings, Package, Percent } from 'lucide-react';
import { toast } from 'sonner';
// INV-A: useRouter dropped — closeout no longer redirects to the invoice page.
// (useParams was already imported-unused before INV-A; left alone deliberately.)
import { useParams } from 'next/navigation';
import {
    orgShareRequestField,
    orgShareInputError,
    orgShareFieldMode,
    formatOrgShare,
    ORG_SHARE_DEFAULT_INPUT,
    ORG_SHARE_HELPER_TEXT,
    ORG_SHARE_LOCKED_NOTE,
} from '@/lib/orgShareForm';
import { isCampaignClosed } from '@/lib/campaignBundleSelection';
import { resolveBundleGoal, parseBundleGoal, DEFAULT_BUNDLE_GOAL } from '@/lib/fundraiserMetrics';
// OPS-2: the "New Campaign" form used to POST bundleSelection-less bodies
// straight to /api/campaigns, landing on the route's now-removed
// not_required bypass branch. It now reuses the one safe creation path the
// canonical wizard already provides — prefill.customerId skips wizard Step 1
// (organization selection) and lands directly on Step 2 (Campaign), which
// only ever sends bundleSelection.mode: 'coordinator_selects'.
import { StartFundraiserWizard } from '@/components/crm2/StartFundraiserWizard';

interface BundleOption {
    id: string;
    name: string;
    price: number | null;
    is_active: boolean;
}

interface Fundraiser {
    id: string;
    name: string;
    status: string;
    goal_amount: number | null;
    bundle_goal: number | null;
    total_sales: number;
    end_date: string | null;
    public_token: string | null;
    participant_label?: string;
    group_label?: string;
    is_group_enabled?: boolean;
    // INV-A: per-campaign organization share + closed marker for the locked state.
    org_share_percent?: number | string | null;
    closed_at?: string | null;
}

export default function FundraisersTab({ customerId, businessSlug }: { customerId: string, businessSlug: string }) {
    const [campaigns, setCampaigns] = useState<Fundraiser[]>([]);
    const [loading, setLoading] = useState(true);
    // OPS-2: opens the canonical StartFundraiserWizard (prefilled to this
    // organization) instead of the removed inline "New Campaign" form.
    const [showWizard, setShowWizard] = useState(false);
    const [editingLabelsId, setEditingLabelsId] = useState<string | null>(null);

    const [editData, setEditData] = useState({
        participant_label: '',
        group_label: ''
    });

    // INV-A: organization share. Client role read is presentation only — the
    // server authorizes every explicit override independently.
    const { data: session } = useSession();
    const shareUser = {
        role: (session?.user as any)?.role,
        isSuperAdmin: (session?.user as any)?.isSuperAdmin === true,
    };
    const [editingShareId, setEditingShareId] = useState<string | null>(null);
    const [shareInput, setShareInput] = useState(ORG_SHARE_DEFAULT_INPUT);
    const [savingShare, setSavingShare] = useState(false);
    const editShareError = orgShareInputError(shareInput);

    // FR-GOAL-CONFIG-1: tenant-controlled weighted bundle goal. No role gate
    // (unlike org share) — any tenant user on this tab may set it; only the
    // campaign's closed-out state locks the field.
    const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
    const [goalInput, setGoalInput] = useState(String(DEFAULT_BUNDLE_GOAL));
    const [savingGoal, setSavingGoal] = useState(false);
    const editGoalErrorResult = parseBundleGoal(goalInput);
    const editGoalError = editGoalErrorResult.ok ? null : editGoalErrorResult.error;

    // Bundle assignment state
    const [allBundles, setAllBundles] = useState<BundleOption[]>([]);
    const [editingBundlesId, setEditingBundlesId] = useState<string | null>(null);
    const [selectedBundleIds, setSelectedBundleIds] = useState<Set<string>>(new Set());
    const [bundleCountMap, setBundleCountMap] = useState<Record<string, number>>({});
    const [savingBundles, setSavingBundles] = useState(false);

    useEffect(() => {
        fetchCampaigns();
        fetchAllBundles();
    }, [customerId]);

    async function fetchAllBundles() {
        try {
            const res = await fetch('/api/bundles');
            const data = await res.json();
            if (res.ok) setAllBundles(data.filter((b: any) => b.is_active));
        } catch (error) {
            console.error('Failed to load bundles', error);
        }
    }

    async function fetchCampaigns() {
        try {
            const res = await fetch(`/api/campaigns?customerId=${customerId}`);
            const data = await res.json();
            if (res.ok) {
                setCampaigns(data);
                // Fetch bundle counts for each campaign
                const counts: Record<string, number> = {};
                await Promise.all(data.map(async (c: Fundraiser) => {
                    try {
                        const r = await fetch(`/api/campaigns/${c.id}/bundles`);
                        const d = await r.json();
                        counts[c.id] = d.bundleIds?.length || 0;
                    } catch {
                        counts[c.id] = 0;
                    }
                }));
                setBundleCountMap(counts);
            }
        } catch (error) {
            console.error('Failed to load campaigns', error);
        } finally {
            setLoading(false);
        }
    }

    async function openBundleEditor(campaignId: string) {
        setEditingLabelsId(null); // close labels panel if open
        setEditingBundlesId(campaignId);
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/bundles`);
            const data = await res.json();
            setSelectedBundleIds(new Set(data.bundleIds || []));
        } catch {
            setSelectedBundleIds(new Set());
        }
    }

    function toggleBundleSelection(bundleId: string) {
        setSelectedBundleIds(prev => {
            const next = new Set(prev);
            if (next.has(bundleId)) next.delete(bundleId);
            else next.add(bundleId);
            return next;
        });
    }

    async function saveBundleAssignments(campaignId: string) {
        setSavingBundles(true);
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/bundles`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundleIds: Array.from(selectedBundleIds) })
            });
            if (res.ok) {
                toast.success('Bundle assignments saved!');
                setEditingBundlesId(null);
                setBundleCountMap(prev => ({ ...prev, [campaignId]: selectedBundleIds.size }));
            } else {
                const err = await res.json();
                toast.error(err.error || 'Failed to save');
            }
        } catch {
            toast.error('Failed to save bundle assignments');
        } finally {
            setSavingBundles(false);
        }
    }

    /**
     * INV-A — save an edited organization share for one OPEN campaign.
     *
     * Uses the campaign-specific PATCH (never the customer profile save). The
     * server re-checks authorization (403), open-ness (409) and range (400);
     * its messages are already human-readable, so they surface verbatim.
     */
    async function handleSaveShare(id: string) {
        if (editShareError) {
            toast.error(editShareError);
            return;
        }
        const field = orgShareRequestField({ user: shareUser, raw: shareInput });
        if (!('orgSharePercent' in field)) {
            // Blank input or unauthorized viewer — nothing truthful to send.
            setEditingShareId(null);
            return;
        }
        setSavingShare(true);
        try {
            const res = await fetch(`/api/campaigns/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(field)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update organization share');
            toast.success('Organization share updated!');
            setEditingShareId(null);
            fetchCampaigns();
        } catch (error: any) {
            toast.error(error.message);
        } finally {
            setSavingShare(false);
        }
    }

    /**
     * FR-GOAL-CONFIG-1 — save an edited bundle goal for one OPEN campaign.
     *
     * Uses the same campaign-specific PATCH as the org share above. A blank
     * input is submitted as omitted, matching decideBundleGoalChange's
     * "no value supplied = leave the stored goal alone" contract — the server
     * re-checks closeout (409) and value validity (400) independently.
     */
    async function handleSaveGoal(id: string) {
        if (editGoalError) {
            toast.error(editGoalError);
            return;
        }
        const trimmed = goalInput.trim();
        if (trimmed === '') {
            setEditingGoalId(null);
            return;
        }
        setSavingGoal(true);
        try {
            const res = await fetch(`/api/campaigns/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundleGoal: trimmed })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to update bundle goal');
            toast.success('Bundle goal updated!');
            setEditingGoalId(null);
            fetchCampaigns();
        } catch (error: any) {
            toast.error(error.message);
        } finally {
            setSavingGoal(false);
        }
    }

    async function handleUpdateLabels(id: string) {
        try {
            const res = await fetch(`/api/campaigns/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    participant_label: editData.participant_label,
                    group_label: editData.group_label,
                    is_group_enabled: !!editData.group_label
                })
            });
            if (res.ok) {
                toast.success('Labels updated!');
                setEditingLabelsId(null);
                fetchCampaigns();
            }
        } catch (error) {
            toast.error('Failed to update labels');
        }
    }

    /**
     * INV-A — Close out fundraiser.
     *
     * WHAT THIS USED TO DO, AND WHY IT WAS WRONG: it PATCHed the campaign to
     * status 'Production' and reported "Campaign Closed!". 'Production' is not
     * in the closed family, so nothing was actually closed — held fundraiser
     * orders were never released, settlement_total was never frozen, and the
     * campaign kept accepting orders. It then deep-linked to the invoice page
     * prefilled from campaign.total_sales, a denormalised counter the closeout
     * engine itself distrusts.
     *
     * It now calls the canonical closeout endpoint, which freezes the gross
     * settlement and promotes held orders in one transaction. No invoice is
     * created — INV-B owns generation — so this no longer claims one was.
     */
    async function handleCloseOut(campaign: Fundraiser) {
        if (!confirm(
            `Close out "${campaign.name}"?\n\n` +
            `This freezes the campaign's settlement total and releases its held orders to production. ` +
            `It cannot be undone.`
        )) {
            return;
        }

        try {
            const res = await fetch(`/api/campaigns/${campaign.id}/closeout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            const data = await res.json().catch(() => ({}));

            if (res.ok) {
                toast.success(
                    data?.idempotent
                        ? 'This fundraiser was already closed out.'
                        : 'Fundraiser closed out.'
                );
                fetchCampaigns();
            } else if (res.status === 403) {
                toast.error(data?.error || 'Only an administrator can close out a fundraiser.');
            } else {
                toast.error(data?.error || 'Failed to close out fundraiser');
            }
        } catch (e) {
            toast.error('An error occurred');
        }
    }

    if (loading && campaigns.length === 0) return <div className="p-8 text-center text-slate-500">Loading campaigns...</div>;

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Active Campaigns</h3>
                <button
                    onClick={() => setShowWizard(true)}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                    <Plus className="w-4 h-4" /> New Campaign
                </button>
            </div>

            {showWizard && (
                <StartFundraiserWizard
                    prefill={{ customerId }}
                    onClose={() => {
                        setShowWizard(false);
                        fetchCampaigns();
                    }}
                />
            )}

            <div className="grid gap-4">
                {campaigns.length > 0 ? campaigns.map(campaign => (
                    <div key={campaign.id} className="bg-white dark:bg-slate-800 p-5 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col gap-4">
                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <h4 className="font-bold text-lg text-slate-900 dark:text-white">{campaign.name}</h4>
                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${campaign.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
                                        }`}>
                                        {campaign.status}
                                    </span>
                                </div>
                                <div className="flex flex-wrap gap-4 text-sm text-slate-500">
                                    <div className="flex items-center gap-1.5">
                                        <Target className="w-4 h-4 text-slate-400" />
                                        <span>Goal: {resolveBundleGoal(campaign.bundle_goal)} Bundles</span>
                                        {/* FR-GOAL-CONFIG-1: tenant-owned, editable while open;
                                            locked after closeout, mirroring the org-share pattern. */}
                                        {!isCampaignClosed({ closed_at: campaign.closed_at ? new Date(campaign.closed_at) : null, status: campaign.status }) ? (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setEditingLabelsId(null);
                                                    setEditingBundlesId(null);
                                                    setEditingShareId(null);
                                                    setEditingGoalId(campaign.id);
                                                    setGoalInput(String(resolveBundleGoal(campaign.bundle_goal)));
                                                }}
                                                className="text-xs font-bold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 px-2 py-1.5 -my-1.5 rounded"
                                                title="Edit bundle goal"
                                            >
                                                Edit
                                            </button>
                                        ) : (
                                            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400" title="Bundle goal is locked after fundraiser closeout.">
                                                Locked
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <Calendar className="w-4 h-4 text-slate-400" />
                                        <span>Ends: {campaign.end_date ? new Date(campaign.end_date).toLocaleDateString() : 'No date set'}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <Package className="w-4 h-4 text-slate-400" />
                                        <span>
                                            {bundleCountMap[campaign.id]
                                                ? `${bundleCountMap[campaign.id]} bundle${bundleCountMap[campaign.id] !== 1 ? 's' : ''} assigned`
                                                : 'All bundles (default)'
                                            }
                                        </span>
                                    </div>
                                    {/* INV-A: per-campaign organization share.
                                        Editable for ADMIN/super-admin while the
                                        fundraiser is open; locked after closeout. */}
                                    <div className="flex items-center gap-1.5">
                                        <Percent className="w-4 h-4 text-slate-400" />
                                        <span>Org share: {formatOrgShare(campaign.org_share_percent)}</span>
                                        {orgShareFieldMode({ user: shareUser, campaignClosed: isCampaignClosed({ closed_at: campaign.closed_at ? new Date(campaign.closed_at) : null, status: campaign.status }) }) === 'editable' && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setEditingLabelsId(null);
                                                    setEditingBundlesId(null);
                                                    setEditingGoalId(null);
                                                    setEditingShareId(campaign.id);
                                                    setShareInput(
                                                        campaign.org_share_percent != null && campaign.org_share_percent !== ''
                                                            ? String(campaign.org_share_percent)
                                                            : ORG_SHARE_DEFAULT_INPUT
                                                    );
                                                }}
                                                className="text-xs font-bold text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 px-2 py-1.5 -my-1.5 rounded"
                                                title="Edit organization share"
                                            >
                                                Edit
                                            </button>
                                        )}
                                        {orgShareFieldMode({ user: shareUser, campaignClosed: isCampaignClosed({ closed_at: campaign.closed_at ? new Date(campaign.closed_at) : null, status: campaign.status }) }) === 'locked' && (
                                            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400" title={ORG_SHARE_LOCKED_NOTE}>
                                                Locked
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center gap-3 w-full md:w-auto">
                                <div className="flex-1 md:flex-none text-right mr-4">
                                    <p className="text-xs font-medium text-slate-500 uppercase">Total Sales</p>
                                    <p className="text-xl font-black text-emerald-600">${Number(campaign.total_sales).toFixed(2)}</p>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => openBundleEditor(campaign.id)}
                                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 rounded-lg transition-colors"
                                        title="Assign Bundles"
                                    >
                                        <Package className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => {
                                            setEditingBundlesId(null); // close bundles panel if open
                                            setEditingLabelsId(campaign.id);
                                            setEditData({
                                                participant_label: campaign.participant_label || 'Seller',
                                                group_label: campaign.group_label || ''
                                            });
                                        }}
                                        className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 rounded-lg transition-colors"
                                        title="Edit Terminology"
                                    >
                                        <Settings className="w-4 h-4" />
                                    </button>
                                    <a
                                        href={`/shop/${businessSlug}/fundraiser/${campaign.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-lg text-sm font-medium transition-colors"
                                    >
                                        <ExternalLink className="w-4 h-4" /> View Page
                                    </a>
                                    {campaign.status === 'Active' && (
                                        <button
                                            onClick={() => handleCloseOut(campaign)}
                                            className="flex items-center gap-2 px-4 py-2 bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-800 dark:text-amber-300 rounded-lg text-sm font-bold transition-colors"
                                            title="Freeze the settlement total and release held orders to production"
                                        >
                                            Close out fundraiser
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Inline Label Edit */}
                        {editingLabelsId === campaign.id && (
                            <div className="mt-2 pt-4 border-t border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/20 p-4 rounded-xl">
                                <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-3">Update Labels</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Participant Label</label>
                                        <input
                                            className="w-full text-sm px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700"
                                            value={editData.participant_label}
                                            onChange={e => setEditData({ ...editData, participant_label: e.target.value })}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Group Label</label>
                                        <input
                                            className="w-full text-sm px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700"
                                            value={editData.group_label}
                                            onChange={e => setEditData({ ...editData, group_label: e.target.value })}
                                        />
                                    </div>
                                </div>
                                <div className="flex justify-end gap-2 mt-4">
                                    <button
                                        onClick={() => setEditingLabelsId(null)}
                                        className="text-xs font-bold text-slate-400 hover:text-slate-600"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={() => handleUpdateLabels(campaign.id)}
                                        className="text-xs font-bold text-indigo-600 hover:text-indigo-800"
                                    >
                                        Save Labels
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* INV-A: Inline Organization Share Edit — open campaigns,
                            ADMIN/super-admin only (the affordance above is not
                            rendered otherwise; the server re-checks regardless). */}
                        {editingShareId === campaign.id && (
                            <div className="mt-2 pt-4 border-t border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/20 p-4 rounded-xl">
                                <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1">Organization Share</p>
                                <p className="text-[10px] text-slate-400 mb-3">{ORG_SHARE_HELPER_TEXT}</p>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        step={0.01}
                                        className="w-28 text-sm px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700"
                                        value={shareInput}
                                        aria-invalid={editShareError ? true : undefined}
                                        onChange={e => setShareInput(e.target.value)}
                                    />
                                    <span className="text-sm font-bold text-slate-500 dark:text-slate-400">%</span>
                                </div>
                                {editShareError && (
                                    <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-400 mt-2">{editShareError}</p>
                                )}
                                <div className="flex justify-end gap-2 mt-4">
                                    <button
                                        onClick={() => setEditingShareId(null)}
                                        className="text-xs font-bold text-slate-400 hover:text-slate-600"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={() => handleSaveShare(campaign.id)}
                                        disabled={savingShare || editShareError !== null}
                                        className="text-xs font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {savingShare ? 'Saving…' : 'Save Share'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* FR-GOAL-CONFIG-1: Inline Bundle Goal Edit — open campaigns,
                            any tenant user on this tab (no role gate; the server
                            re-checks closeout regardless). */}
                        {editingGoalId === campaign.id && (
                            <div className="mt-2 pt-4 border-t border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/20 p-4 rounded-xl">
                                <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-1">Bundle Goal</p>
                                <p className="text-[10px] text-slate-400 mb-3">Weighted bundles — Serves 5 = 1, Serves 2 = ½. Changing this only moves the target; progress already earned never changes.</p>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="number"
                                        min={1}
                                        step={1}
                                        className="w-28 text-sm px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700"
                                        value={goalInput}
                                        aria-invalid={editGoalError ? true : undefined}
                                        onChange={e => setGoalInput(e.target.value)}
                                    />
                                    <span className="text-sm font-bold text-slate-500 dark:text-slate-400">Bundles</span>
                                </div>
                                {editGoalError && (
                                    <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-400 mt-2">{editGoalError}</p>
                                )}
                                <div className="flex justify-end gap-2 mt-4">
                                    <button
                                        onClick={() => setEditingGoalId(null)}
                                        className="text-xs font-bold text-slate-400 hover:text-slate-600"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={() => handleSaveGoal(campaign.id)}
                                        disabled={savingGoal || editGoalError !== null}
                                        className="text-xs font-bold text-indigo-600 hover:text-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {savingGoal ? 'Saving…' : 'Save Goal'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Inline Bundle Assignment */}
                        {editingBundlesId === campaign.id && (
                            <div className="mt-2 pt-4 border-t border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/20 p-4 rounded-xl">
                                <p className="text-[10px] font-black text-purple-500 uppercase tracking-widest mb-1">Assign Bundles</p>
                                <p className="text-[10px] text-slate-400 mb-3">Select which bundles appear on this campaign's public page. Leave all unchecked to show all bundles.</p>
                                {allBundles.length === 0 ? (
                                    <p className="text-sm text-slate-400 italic">No active bundles found for this business.</p>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                                        {allBundles.map(bundle => (
                                            <label
                                                key={bundle.id}
                                                className={`flex items-center gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-all ${
                                                    selectedBundleIds.has(bundle.id)
                                                        ? 'border-purple-300 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-700'
                                                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                                                }`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedBundleIds.has(bundle.id)}
                                                    onChange={() => toggleBundleSelection(bundle.id)}
                                                    className="rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{bundle.name}</p>
                                                    {bundle.price && (
                                                        <p className="text-[10px] text-slate-400">${Number(bundle.price).toFixed(2)}</p>
                                                    )}
                                                </div>
                                            </label>
                                        ))}
                                    </div>
                                )}
                                <div className="flex items-center justify-between mt-4">
                                    <p className="text-[10px] text-slate-400">
                                        {selectedBundleIds.size === 0
                                            ? 'No bundles selected — all bundles will be shown'
                                            : `${selectedBundleIds.size} bundle${selectedBundleIds.size !== 1 ? 's' : ''} selected`
                                        }
                                    </p>
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => setEditingBundlesId(null)}
                                            className="text-xs font-bold text-slate-400 hover:text-slate-600"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => saveBundleAssignments(campaign.id)}
                                            disabled={savingBundles}
                                            className="text-xs font-bold text-purple-600 hover:text-purple-800 disabled:opacity-50"
                                        >
                                            {savingBundles ? 'Saving...' : 'Save Bundles'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )) : (
                    <div className="text-center py-12 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-dashed border-slate-300 dark:border-slate-700">
                        <Megaphone className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                        <p className="text-slate-500 font-medium">No campaigns found</p>
                        <p className="text-sm text-slate-400">Create one to get started!</p>
                    </div>
                )}
            </div>
        </div>
    );
}
