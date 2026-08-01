"use client";

import { useState, useEffect } from 'react';
import {
    Megaphone,
    Plus,
    Search,
    Filter,
    Calendar,
    Target,
    TrendingUp,
    ChevronRight,
    Building2,
    Users,
    ExternalLink,
    Receipt,
    Lock,
    Loader2,
    CheckCircle2,
    AlertCircle
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import { useSession } from 'next-auth/react';
import UpgradeRequired from '@/components/UpgradeRequired';
import { StartFundraiserWizard } from '@/components/crm2/StartFundraiserWizard';
import { formatBundleCount } from '@/lib/fundraiserMetrics';

interface Fundraiser {
    id: string;
    name: string;
    status: string;
    start_date: string;
    end_date: string;
    goal_amount: number;
    bundle_goal: number;
    sales_total: number;
    customer_id: string;
    customer: {
        name: string;
        contact_name?: string | null;
    };
    business_slug: string;
    is_placeholder?: boolean;
    portal_token?: string;
    held_order_count?: number;
    held_order_total?: number;
    // FR-LAUNCH-1C-1: server-computed weighted bundle progress. These measure
    // different things than held_order_count / held_order_total and are never
    // derived from each other or from dollar sales.
    weighted_bundles_sold?: number;
    progress_percent?: number;
    // Phase 7E closeout fields (may not be present until prisma generate runs)
    closed_at?: string | null;
    settlement_total?: number | null;
}

/** Returns true when a campaign cannot be closed again. */
function isCampaignClosed(f: Fundraiser): boolean {
    return Boolean(f.closed_at) ||
        f.status === 'Closed' ||
        f.status === 'Settled' ||
        f.status === 'Completed' ||
        f.status === 'Archived';
}

export default function FundraisersPage() {
    const { data: session, status } = useSession();
    const searchParams = useSearchParams();
    const [fundraisers, setFundraisers] = useState<Fundraiser[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
    const [filterStatus, setFilterStatus] = useState('all');

    // ── CRM-4: Start a Fundraiser wizard modal ───────────────────────────
    const [showWizard, setShowWizard] = useState(false);

    // ── Phase 7E-3: Closeout modal state ──────────────────────────────────
    const [closeoutTarget, setCloseoutTarget] = useState<Fundraiser | null>(null);
    const [closeoutLoading, setCloseoutLoading] = useState(false);
    const [closeoutResult, setCloseoutResult] = useState<{
        success: boolean;
        message: string;
        settlement_total?: number;
        promoted_order_count?: number;
    } | null>(null);

    const userPlan = (session?.user as any)?.plan;
    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;
    const hasAccess = userPlan === 'ENTERPRISE' || userPlan === 'ULTIMATE' || userPlan === 'FREE' || isSuperAdmin;

    useEffect(() => {
        fetch('/api/campaigns')
            .then(async res => {
                const text = await res.text();
                try {
                    const data = JSON.parse(text);
                    if (!res.ok) throw new Error(data.error || res.statusText);
                    return data;
                } catch (e) {
                    console.error("API returned non-JSON:", text.slice(0, 500)); // Log first 500 chars
                    throw new Error(`API returned invalid JSON: ${res.status} ${res.statusText}`);
                }
            })
            .then(data => {
                if (Array.isArray(data)) {
                    setFundraisers(data);
                } else {
                    setFundraisers([]);
                }
                setIsLoading(false);
            })
            .catch(err => {
                console.error("Failed to fetch fundraisers", err);
                setIsLoading(false);
            });
    }, []);

    // ── Phase 7E-3: Closeout handler ──────────────────────────────────────
    const handleCloseout = async () => {
        if (!closeoutTarget) return;
        setCloseoutLoading(true);
        setCloseoutResult(null);
        try {
            const res = await fetch(`/api/campaigns/${closeoutTarget.id}/closeout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (!res.ok) {
                setCloseoutResult({
                    success: false,
                    message: data.error || 'Failed to close campaign. Please try again.'
                });
            } else {
                // Update local list so the row immediately reflects Closed status
                setFundraisers(prev => prev.map(f =>
                    f.id === closeoutTarget.id
                        ? { ...f, status: 'Closed', closed_at: data.closed_at, settlement_total: data.settlement_total }
                        : f
                ));
                setCloseoutResult({
                    success: true,
                    message: 'Campaign closed successfully.',
                    settlement_total: data.settlement_total,
                    promoted_order_count: data.promoted_order_count
                });
            }
        } catch (e: any) {
            setCloseoutResult({
                success: false,
                message: e.message || 'Unexpected error. Please try again.'
            });
        } finally {
            setCloseoutLoading(false);
        }
    };

    const openCloseoutModal = (f: Fundraiser) => {
        setCloseoutTarget(f);
        setCloseoutResult(null);
    };

    const dismissCloseoutModal = () => {
        setCloseoutTarget(null);
        setCloseoutResult(null);
        setCloseoutLoading(false);
    };

    const filtered = fundraisers.filter(f => {
        const matchesSearch = f.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.customer.name.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesFilter =
            filterStatus === 'all' ? true :
            filterStatus === 'closed' ? isCampaignClosed(f) :
            f.status.toLowerCase() === filterStatus.toLowerCase();
        return matchesSearch && matchesFilter;
    });

    const activeCount = fundraisers.filter(f => f.status === 'Active').length;
    const pendingCount = fundraisers.filter(f => f.status === 'Lead').length;
    const totalHeldOrders = fundraisers.reduce((sum, f) => sum + (f.held_order_count || 0), 0);
    const totalHeldValue = fundraisers.reduce((sum, f) => sum + (f.held_order_total || 0), 0);

    if (status === 'loading') return <div className="p-8 text-center text-slate-400">Loading Session...</div>;

    if (!hasAccess) {
        return (
            <UpgradeRequired
                feature="Fundraiser Toolkit"
                description="Coordinate large-scale campaigns, manage volunteer groups, and track organizational goals with ease."
            />
        );
    }

    return (
        <>
        <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h1 className="text-4xl font-black tracking-tight flex items-center gap-3">
                        <Megaphone className="text-indigo-600 dark:text-indigo-400" size={36} />
                        Fundraiser Dashboard
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 font-medium mt-1">
                        Track and manage organization campaigns across your kitchen.
                    </p>
                </div>
                <button
                    id="open-wizard-btn"
                    onClick={() => setShowWizard(true)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-2xl font-black shadow-lg shadow-indigo-500/20 flex items-center gap-2 transition-all hover:scale-[1.02] active:scale-95"
                >
                    <Plus size={20} /> Launch New Fundraiser
                </button>
            </div>

            {/* Quick Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="glass-panel p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
                    <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-2xl flex items-center justify-center mb-4">
                        <TrendingUp size={24} />
                    </div>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Active Campaigns</p>
                    <p className="text-3xl font-black">{activeCount}</p>
                </div>
                <div className="glass-panel p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
                    <div className="w-12 h-12 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-2xl flex items-center justify-center mb-4">
                        <Target size={24} />
                    </div>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">High Leads</p>
                    <p className="text-3xl font-black text-amber-600">{pendingCount}</p>
                </div>
                <div className="glass-panel p-6 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
                    <div className="w-12 h-12 bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 rounded-2xl flex items-center justify-center mb-4">
                        <Receipt size={24} />
                    </div>
                    <p className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Held Orders</p>
                    <p className="text-3xl font-black text-violet-600">{totalHeldOrders}</p>
                    {totalHeldValue > 0 && (
                        <p className="text-xs font-bold text-slate-400 mt-1">${totalHeldValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} awaiting settlement</p>
                    )}
                </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col md:flex-row gap-4 justify-between bg-white dark:bg-slate-800 p-4 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-700">
                <div className="relative flex-1">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input
                        type="text"
                        placeholder="Search by name or school..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 dark:bg-slate-900 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-medium"
                    />
                </div>
                <div className="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-2xl">
                    {['all', 'active', 'lead', 'closed'].map(status => (
                        <button
                            key={status}
                            onClick={() => setFilterStatus(status)}
                            className={`px-6 py-2 rounded-xl text-xs font-black uppercase transition-all ${filterStatus === status ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            {status}
                        </button>
                    ))}
                </div>
            </div>

            {/* Table */}
            <div className="bg-white dark:bg-slate-800 rounded-[2.5rem] overflow-hidden border border-slate-100 dark:border-slate-700 shadow-xl shadow-slate-200/50 dark:shadow-none">
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-700">
                                <th className="px-5 py-3 text-xs font-black text-slate-400 uppercase tracking-widest w-[25%]">Campaign</th>
                                <th className="px-4 py-3 text-xs font-black text-slate-400 uppercase tracking-widest w-[17%]">Coordinator</th>
                                <th className="px-4 py-3 text-xs font-black text-slate-400 uppercase tracking-widest w-[10%]">Status</th>
                                <th className="px-4 py-3 text-xs font-black text-slate-400 uppercase tracking-widest w-[12%]">Dates</th>
                                <th className="px-4 py-3 text-xs font-black text-slate-400 uppercase tracking-widest text-center w-[12%]">Held Orders</th>
                                <th className="px-4 py-3 text-xs font-black text-slate-400 uppercase tracking-widest text-right w-[14%]">Progress</th>
                                <th className="px-2 py-3 text-xs font-black text-slate-400 uppercase tracking-widest w-[10%]"></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                            {isLoading ? (
                                <tr>
                                    <td colSpan={7} className="px-5 py-20 text-center text-slate-400 animate-pulse font-bold">Loading Campaigns...</td>
                                </tr>
                            ) : filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-5 py-20 text-center text-slate-400 italic">No campaigns found.</td>
                                </tr>
                            ) : filtered.map(item => (
                                <tr key={item.id} className="group hover:bg-slate-50/50 dark:hover:bg-slate-900/30 transition-colors">
                                    <td className="px-5 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center text-indigo-600 group-hover:scale-110 transition-transform flex-shrink-0">
                                                <Megaphone size={16} />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="font-black text-slate-900 dark:text-white text-sm leading-tight truncate">{item.name}</p>
                                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">ID: {item.id.slice(0, 8)}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-4 py-4">
                                        <div className="flex items-center gap-2">
                                            <Building2 size={14} className="text-slate-400 flex-shrink-0" />
                                            <div className="min-w-0">
                                                <p className="font-bold text-sm text-slate-700 dark:text-slate-300 truncate">{item.customer.contact_name || item.customer.name}</p>
                                                {item.customer.contact_name && (
                                                    <p className="text-[10px] font-bold text-slate-400 truncate">{item.customer.name}</p>
                                                )}
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-4 py-4">
                                        <span className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest ${
                                            item.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
                                            item.status === 'Lead' ? 'bg-amber-100 text-amber-700' :
                                            item.status === 'Closed' ? 'bg-amber-100 text-amber-800' :
                                            item.status === 'Settled' ? 'bg-violet-100 text-violet-700' :
                                            'bg-slate-100 text-slate-600'
                                        }`}>
                                            {item.status}
                                        </span>
                                    </td>
                                    <td className="px-4 py-4">
                                        <div className="space-y-0.5">
                                            <p className="text-xs font-bold text-slate-600 dark:text-slate-400 whitespace-nowrap">
                                                {item.start_date ? format(new Date(item.start_date), 'MMM d, yyyy') : 'No date'}
                                            </p>
                                            {item.end_date && (
                                                <p className="text-[10px] font-black text-slate-300 uppercase whitespace-nowrap">to {format(new Date(item.end_date), 'MMM d, yyyy')}</p>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-4 text-center">
                                        {(item.held_order_count || 0) > 0 ? (
                                            <div className="flex flex-col items-center gap-0.5">
                                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-400 text-xs font-black">
                                                    {item.held_order_count} held
                                                </span>
                                                <span className="text-[10px] font-bold text-slate-400 font-mono">
                                                    ${(item.held_order_total || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                </span>
                                            </div>
                                        ) : (
                                            <span className="text-xs font-medium text-slate-300 dark:text-slate-600">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-4">
                                        <div className="flex flex-col items-end gap-1">
                                            {/* FR-LAUNCH-1C-1: weighted bundle progress from the
                                                server (weighted_bundles_sold / bundle_goal). The
                                                legacy sales_total ÷ goal_amount dollar calculation
                                                is gone — it always read 0 because total_sales is a
                                                denormalized field public orders never write. */}
                                            <div className="flex justify-between w-full text-[10px] font-black font-mono">
                                                <span className="text-indigo-600">
                                                    {item.bundle_goal > 0
                                                        ? `${formatBundleCount(item.weighted_bundles_sold || 0)} of ${formatBundleCount(item.bundle_goal)} bundles`
                                                        : `${formatBundleCount(item.weighted_bundles_sold || 0)} bundles`}
                                                </span>
                                                <span className="text-slate-400">
                                                    {item.bundle_goal > 0
                                                        ? `${Math.round(Math.min(Math.max(item.progress_percent || 0, 0), 100))}%`
                                                        : 'No bundle goal set'
                                                    }
                                                </span>
                                            </div>
                                            <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-indigo-600 transition-all duration-1000"
                                                    style={{ width: `${Math.min(Math.max(item.progress_percent || 0, 0), 100)}%` }}
                                                />
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-2 py-4 text-right">
                                        <div className="flex items-center justify-end gap-0.5">
                                            {/* FIX-4: Only show public page link when slug exists and row is real */}
                                            {!item.is_placeholder && item.business_slug && (
                                                <Link
                                                    href={`/shop/${item.business_slug}/fundraiser/${item.id}`}
                                                    target="_blank"
                                                    className="p-1.5 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-pink-600 transition-all"
                                                    title="View Public Page"
                                                >
                                                    <ExternalLink size={15} />
                                                </Link>
                                            )}
                                            {!item.is_placeholder && item.portal_token && (
                                                <Link
                                                    href={`/coordinator/${item.portal_token}`}
                                                    target="_blank"
                                                    className="p-1.5 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-purple-600 transition-all"
                                                    title="Coordinator Portal"
                                                >
                                                    <Users size={15} />
                                                </Link>
                                            )}
                                            {/* FIX-4: Only show invoice icon for real (non-placeholder) rows */}
                                            {!item.is_placeholder && (
                                                <Link
                                                    href={`/customers/${item.customer_id}?tab=fundraisers&action=invoice&campaignId=${item.id}`}
                                                    className="p-1.5 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-emerald-600 transition-all"
                                                    title="Create Invoice"
                                                >
                                                    <Receipt size={15} />
                                                </Link>
                                            )}
                                            {/* Phase 7E-3: Close Campaign button — only for non-closed campaigns */}
                                            {!item.is_placeholder && !isCampaignClosed(item) && (
                                                <button
                                                    onClick={() => openCloseoutModal(item)}
                                                    className="p-1.5 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-amber-600 transition-all"
                                                    title="Close Campaign"
                                                >
                                                    <Lock size={15} />
                                                </button>
                                            )}
                                            <Link
                                                href={`/fundraisers/${item.customer_id}`}
                                                className="p-1.5 hover:bg-white dark:hover:bg-slate-700 rounded-lg text-slate-400 hover:text-indigo-600 transition-all"
                                                title="View organization"
                                                aria-label={`View organization for ${item.name}`}
                                            >
                                                <ChevronRight size={15} />
                                            </Link>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        {/* ── Phase 7E-3: Close Campaign Confirmation Modal ──────────────────── */}
        {closeoutTarget && (
            <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-md p-8 animate-in fade-in zoom-in duration-200">

                    {/* Header */}
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                            <Lock size={20} className="text-amber-600" />
                        </div>
                        <h3 className="text-xl font-black text-slate-900 dark:text-white">
                            Close Campaign
                        </h3>
                    </div>
                    <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-6 pl-[3.25rem]">
                        {closeoutTarget.name}
                    </p>

                    {/* Result state — success */}
                    {closeoutResult?.success && (
                        <div className="mb-6 p-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-2xl space-y-1">
                            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-black">
                                <CheckCircle2 size={18} />
                                Campaign Closed
                            </div>
                            {closeoutResult.promoted_order_count !== undefined && (
                                <p className="text-sm text-emerald-700 dark:text-emerald-400 font-bold">
                                    {closeoutResult.promoted_order_count} order{closeoutResult.promoted_order_count !== 1 ? 's' : ''} moved to production.
                                </p>
                            )}
                            {closeoutResult.settlement_total !== undefined && closeoutResult.settlement_total !== null && (
                                <p className="text-sm text-emerald-700 dark:text-emerald-400 font-bold font-mono">
                                    Settlement total: ${Number(closeoutResult.settlement_total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </p>
                            )}
                        </div>
                    )}

                    {/* Result state — error */}
                    {closeoutResult && !closeoutResult.success && (
                        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-2xl">
                            <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-black">
                                <AlertCircle size={18} />
                                Error
                            </div>
                            <p className="text-sm text-red-600 dark:text-red-400 font-bold mt-1">
                                {closeoutResult.message}
                            </p>
                        </div>
                    )}

                    {/* Consequence copy — only shown before success */}
                    {!closeoutResult?.success && (
                        <div className="mb-6 space-y-3 text-sm text-slate-600 dark:text-slate-400 font-medium">
                            <p>Closing this campaign will:</p>
                            <ul className="space-y-2 pl-4">
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-500 font-black mt-0.5">·</span>
                                    Prevent coordinators from adding, canceling, or restoring orders.
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-500 font-black mt-0.5">·</span>
                                    Move active fundraiser orders into production readiness.
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-500 font-black mt-0.5">·</span>
                                    Freeze the settlement total from current non-canceled orders.
                                </li>
                            </ul>
                            <p className="font-bold text-slate-500 dark:text-slate-500">
                                This does not charge anyone or process any payments.
                            </p>
                        </div>
                    )}

                    {/* Footer buttons */}
                    <div className="flex gap-3 justify-end">
                        <button
                            onClick={dismissCloseoutModal}
                            disabled={closeoutLoading}
                            className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
                        >
                            {closeoutResult?.success ? 'Done' : 'Cancel'}
                        </button>
                        {!closeoutResult?.success && (
                            <button
                                onClick={handleCloseout}
                                disabled={closeoutLoading}
                                className="flex items-center gap-2 px-6 py-3 rounded-xl font-black bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/20 transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-60 disabled:scale-100"
                            >
                                {closeoutLoading ? (
                                    <><Loader2 size={16} className="animate-spin" /> Closing...</>
                                ) : (
                                    <><Lock size={16} /> Close Campaign</>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        )}
        {/* CRM-4 — Start a Fundraiser wizard */}
        {showWizard && (
            <StartFundraiserWizard
                onClose={() => {
                    setShowWizard(false);
                    // Reload so the new campaign row appears immediately
                    window.location.reload();
                }}
            />
        )}
        </>

    );
}
