'use client';

import { useState, useEffect } from 'react';
import { Plus, ExternalLink, Calendar, Target, Megaphone, Loader2, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { useParams, useRouter } from 'next/navigation';

interface Fundraiser {
    id: string;
    name: string;
    status: string;
    goal_amount: number | null;
    total_sales: number;
    end_date: string | null;
    public_token: string | null;
    participant_label?: string;
    group_label?: string;
    is_group_enabled?: boolean;
    bundles?: any[];
    bundle_stats?: { name: string, count: number }[];
}

export default function FundraisersTab({ customerId, businessSlug }: { customerId: string, businessSlug: string }) {
    const router = useRouter();
    const [campaigns, setCampaigns] = useState<Fundraiser[]>([]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [editingLabelsId, setEditingLabelsId] = useState<string | null>(null);
    const [newCampaign, setNewCampaign] = useState({
        name: '',
        goalAmount: '',
        endDate: '',
        participantLabel: 'Seller',
        groupLabel: '',
        bundleIds: [] as string[]
    });

    const [editData, setEditData] = useState<{
        participant_label: string;
        group_label: string;
        bundleIds?: string[];
    }>({
        participant_label: '',
        group_label: ''
    });

    const [availableBundles, setAvailableBundles] = useState<{ id: string, name: string }[]>([]);

    useEffect(() => {
        fetchCampaigns();
        fetchBundles();
    }, [customerId]);

    async function fetchBundles() {
        try {
            const res = await fetch('/api/bundles');
            const data = await res.json();
            if (res.ok) setAvailableBundles(data.filter((b: any) => b.is_active));
        } catch (error) {
            console.error('Failed to load bundles', error);
        }
    }

    async function fetchCampaigns() {
        try {
            const res = await fetch(`/api/campaigns?customerId=${customerId}`);
            const data = await res.json();
            if (res.ok) setCampaigns(data);
        } catch (error) {
            console.error('Failed to load campaigns', error);
        } finally {
            setLoading(false);
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
                    goalAmount: newCampaign.goalAmount,
                    endDate: newCampaign.endDate,
                    participantLabel: newCampaign.participantLabel,
                    groupLabel: newCampaign.groupLabel,
                    bundleIds: newCampaign.bundleIds
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            toast.success('Campaign created!');
            setNewCampaign({ name: '', goalAmount: '', endDate: '', participantLabel: 'Seller', groupLabel: '', bundleIds: [] });
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
                    is_group_enabled: !!editData.group_label,
                    bundleIds: editData.bundleIds
                })
            });
            if (res.ok) {
                toast.success('Campaign updated!');
                setEditingLabelsId(null);
                fetchCampaigns();
            }
        } catch (error) {
            toast.error('Failed to update campaign');
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
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Fundraising Goal ($)</label>
                                <input
                                    type="number"
                                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 font-bold"
                                    placeholder="5000"
                                    value={newCampaign.goalAmount}
                                    onChange={e => setNewCampaign({ ...newCampaign, goalAmount: e.target.value })}
                                />
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

                        {/* Bundle Selection */}
                        <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
                            <h4 className="text-xs font-black text-indigo-500 uppercase tracking-widest mb-4">Select Bundles</h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {availableBundles.map(bundle => (
                                    <label key={bundle.id} className="flex items-center gap-3 p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors">
                                        <input
                                            type="checkbox"
                                            className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                                            checked={newCampaign.bundleIds.includes(bundle.id)}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    setNewCampaign(prev => ({ ...prev, bundleIds: [...prev.bundleIds, bundle.id] }));
                                                } else {
                                                    setNewCampaign(prev => ({ ...prev, bundleIds: prev.bundleIds.filter(id => id !== bundle.id) }));
                                                }
                                            }}
                                        />
                                        <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{bundle.name}</span>
                                    </label>
                                ))}
                                {availableBundles.length === 0 && (
                                    <div className="text-sm text-slate-500 col-span-3">No active bundles found. Add bundles in the Catalog first.</div>
                                )}
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
                        <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <h4 className="font-bold text-base text-slate-900 dark:text-white truncate">{campaign.name}</h4>
                                    <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${campaign.status === 'Active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
                                        }`}>
                                        {campaign.status}
                                    </span>
                                </div>
                                <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                                    <div className="flex items-center gap-1.5">
                                        <Target className="w-3.5 h-3.5 text-slate-400" />
                                        <span>Goal: ${campaign.goal_amount?.toLocaleString() || 'N/A'}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                                        <span>Ends: {campaign.end_date ? new Date(campaign.end_date).toLocaleDateString() : 'No date set'}</span>
                                    </div>
                                </div>
                                {/* Live Bundle Sales Counters */}
                                {campaign.bundle_stats && campaign.bundle_stats.length > 0 && (
                                    <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-slate-100 dark:border-slate-700/50">
                                        {campaign.bundle_stats.map((stat, idx) => (
                                            <span key={idx} className="px-2 py-1 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-md text-[10px] font-black tracking-wide border border-indigo-100 dark:border-indigo-800">
                                                {stat.name} - {stat.count}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="flex flex-wrap items-center justify-start xl:justify-end gap-3 w-full xl:w-auto mt-1 xl:mt-0">
                                <div className="text-left sm:text-right shrink-0">
                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Raised</p>
                                    <p className="text-lg font-black text-emerald-600 leading-none">${Number(campaign.total_sales).toFixed(2)}</p>
                                </div>
                                <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                                    <button
                                        onClick={() => {
                                            setEditingLabelsId(campaign.id);
                                            setEditData({
                                                participant_label: campaign.participant_label || 'Seller',
                                                group_label: campaign.group_label || '',
                                                bundleIds: campaign.bundles?.map((b: any) => b.id) || []
                                            });
                                        }}
                                        className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 rounded-lg transition-colors shrink-0"
                                        title="Edit Campaign Details"
                                    >
                                        <Settings className="w-4 h-4" />
                                    </button>
                                    <a
                                        href={`/shop/${businessSlug}/fundraiser/${campaign.id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-bold transition-colors whitespace-nowrap"
                                    >
                                        <ExternalLink className="w-3.5 h-3.5 shrink-0" /> View Page
                                    </a>
                                    {campaign.status === 'Active' && (
                                        <button
                                            onClick={() => handleCloseAndInvoice(campaign)}
                                            className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:hover:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 rounded-lg text-xs font-black transition-colors whitespace-nowrap shadow-sm"
                                            title="Close Campaign and Generate Invoice"
                                        >
                                            Invoice
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Inline Edit Mode */}
                        {editingLabelsId === campaign.id && (
                            <div className="mt-2 pt-4 border-t border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-900/20 p-4 rounded-xl">
                                <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-3">Update Campaign Details</p>
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
                                <div className="mt-4 pt-4 border-t border-slate-200/50 dark:border-slate-700/50">
                                    <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Campaign Bundles</label>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        {availableBundles.map(bundle => (
                                            <label key={bundle.id} className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors">
                                                <input
                                                    type="checkbox"
                                                    className="w-3.5 h-3.5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                                                    checked={editData.bundleIds?.includes(bundle.id) || false}
                                                    onChange={(e) => {
                                                        const currentIds = editData.bundleIds || [];
                                                        if (e.target.checked) {
                                                            setEditData(prev => ({ ...prev, bundleIds: [...currentIds, bundle.id] }));
                                                        } else {
                                                            setEditData(prev => ({ ...prev, bundleIds: currentIds.filter(id => id !== bundle.id) }));
                                                        }
                                                    }}
                                                />
                                                <span className="text-xs font-bold text-slate-700 dark:text-slate-300 line-clamp-1">{bundle.name}</span>
                                            </label>
                                        ))}
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
                                        Save Changes
                                    </button>
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
