'use client';

import { useState, useEffect } from 'react';
import { Plus, ExternalLink, Calendar, Target, Megaphone, Loader2, Settings, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useParams, useRouter } from 'next/navigation';

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
}

export default function FundraisersTab({ customerId, businessSlug }: { customerId: string, businessSlug: string }) {
    const router = useRouter();
    const [campaigns, setCampaigns] = useState<Fundraiser[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [editingLabelsId, setEditingLabelsId] = useState<string | null>(null);
    const [newCampaign, setNewCampaign] = useState({
        name: '',
        bundleGoal: '',
        endDate: '',
        participantLabel: 'Seller',
        groupLabel: ''
    });

    const [editData, setEditData] = useState({
        participant_label: '',
        group_label: ''
    });

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

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/campaigns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerId,
                    name: newCampaign.name,
                    bundleGoal: newCampaign.bundleGoal ? Number(newCampaign.bundleGoal) : undefined,
                    endDate: newCampaign.endDate,
                    participantLabel: newCampaign.participantLabel,
                    groupLabel: newCampaign.groupLabel
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            toast.success('Campaign created!');
            setNewCampaign({ name: '', bundleGoal: '', endDate: '', participantLabel: 'Seller', groupLabel: '' });
            setIsCreating(false);
            fetchCampaigns();
        } catch (error: any) {
            toast.error(error.message);
        } finally {
            setLoading(false);
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

    async function handleCloseAndInvoice(campaign: Fundraiser) {
        if (!confirm(`Are you sure you want to close "${campaign.name}"? This will move it to Production state and start an Invoice.`)) {
            return;
        }

        try {
            const res = await fetch(`/api/campaigns/${campaign.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'Production' })
            });

            if (res.ok) {
                toast.success('Campaign Closed!');
                // Redirect to Invoices with pre-filled parameters
                router.push(`/invoices?action=new&customerId=${customerId}&name=${encodeURIComponent(campaign.name)}&amount=${campaign.total_sales}`);
            } else {
                toast.error('Failed to close campaign');
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
                    onClick={() => setIsCreating(!isCreating)}
                    className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                    <Plus className="w-4 h-4" /> New Campaign
                </button>
            </div>

            {isCreating && (
                <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-xl border border-slate-200 dark:border-slate-700 animate-in slide-in-from-top-2">
                    <form onSubmit={handleCreate} className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Campaign Name</label>
                                <input
                                    required
                                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold"
                                    placeholder="e.g. Spring 2026 Fundraiser"
                                    value={newCampaign.name}
                                    onChange={e => setNewCampaign({ ...newCampaign, name: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Bundle Goal</label>
                                <input
                                    type="number"
                                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold"
                                    placeholder="e.g. 100"
                                    value={newCampaign.bundleGoal}
                                    onChange={e => setNewCampaign({ ...newCampaign, bundleGoal: e.target.value })}
                                />
                                <p className="text-[10px] text-slate-400 mt-1">How many bundles does this campaign aim to sell?</p>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">End Date</label>
                                <input
                                    type="date"
                                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold"
                                    value={newCampaign.endDate}
                                    onChange={e => setNewCampaign({ ...newCampaign, endDate: e.target.value })}
                                />
                            </div>
                        </div>

                        {/* Terminology Settings */}
                        <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
                            <h4 className="text-xs font-black text-indigo-500 uppercase tracking-widest mb-4">Terminology Settings</h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Participant Label</label>
                                    <input
                                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold"
                                        placeholder="e.g. Student, Seller, Athlete"
                                        value={newCampaign.participantLabel}
                                        onChange={e => setNewCampaign({ ...newCampaign, participantLabel: e.target.value })}
                                    />
                                    <p className="text-[10px] text-slate-400 mt-1">What do you call the individuals selling?</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Group Label (Optional)</label>
                                    <input
                                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold"
                                        placeholder="e.g. Classroom, Team, Squad"
                                        value={newCampaign.groupLabel}
                                        onChange={e => setNewCampaign({ ...newCampaign, groupLabel: e.target.value })}
                                    />
                                    <p className="text-[10px] text-slate-400 mt-1">Use for classrooms or groups (Enterprise Only).</p>
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end gap-2 pt-2">
                            <button
                                type="button"
                                onClick={() => setIsCreating(false)}
                                className="px-4 py-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-sm font-medium"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 font-bold"
                            >
                                Create Campaign
                            </button>
                        </div>
                    </form>
                </div>
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
                                        <span>Goal: {campaign.bundle_goal || 100} Bundles</span>
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
                                            onClick={() => handleCloseAndInvoice(campaign)}
                                            className="flex items-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded-lg text-sm font-bold transition-colors"
                                            title="Close Campaign and Generate Invoice"
                                        >
                                            Close & Invoice
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
