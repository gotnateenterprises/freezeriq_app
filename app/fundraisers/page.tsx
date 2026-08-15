"use client";

import { useState, useEffect, useCallback } from 'react';
import {
    Megaphone,
    Plus,
    Search,
    Filter,
    Calendar,
    Lock,
    Loader2,
    CheckCircle2,
    AlertCircle
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import UpgradeRequired from '@/components/UpgradeRequired';
import { StartFundraiserWizard, type RebookingHandoff } from '@/components/crm2/StartFundraiserWizard';
import { RebookingTab } from '@/components/crm2/rebooking/RebookingTab';
import { OrganizationImpactTab } from '@/components/crm2/OrganizationImpactTab';
import { AttentionStrip } from '@/components/crm2/AttentionStrip';
import { CampaignPriorityList, type PriorityListCampaign } from '@/components/crm2/CampaignPriorityList';
import { CampaignContextDrawer } from '@/components/crm2/CampaignContextDrawer';
import { useDialogFocus } from '@/components/crm2/useDialogFocus';
import type { CampaignTriage } from '@/lib/growth/nextAction';
import { triageCampaign } from '@/lib/growth/nextAction';
import type { CampaignHealth, CampaignHealthReason } from '@/lib/growth/health';

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
    // GE-3: server-derived campaign health. Read-only; optional so any consumer
    // reading an older payload still renders.
    health?: CampaignHealth;
    health_reasons?: CampaignHealthReason[];
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
    // CRM-CC-5: a failed campaigns load must render as an error, never as the
    // fake-healthy "No fundraiser campaigns yet" first-run empty state.
    const [loadError, setLoadError] = useState(false);
    const [searchTerm, setSearchTerm] = useState(searchParams.get('search') || '');
    const [filterStatus, setFilterStatus] = useState('all');

    // ── CRM-4: Start a Fundraiser wizard modal ───────────────────────────
    const [showWizard, setShowWizard] = useState(false);
    // FR-RETENTION-5 — approved rebooking opportunity → existing wizard.
    const [rebookingHandoff, setRebookingHandoff] = useState<RebookingHandoff | null>(null);
    const [handoffError, setHandoffError] = useState<string | null>(null);

    /**
     * Fetches the handoff context for ONE opportunity and opens the existing
     * wizard with it. The server re-derives the organization and re-checks the
     * approval state, so this only decides what the tenant SEES first — it
     * cannot widen what they are allowed to create.
     */
    const startFundraiserFromOpportunity = async (opportunityId: string) => {
        setHandoffError(null);
        try {
            const res = await fetch(`/api/rebooking/opportunities/${opportunityId}/handoff`, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) {
                setHandoffError(data.error || 'That fundraiser could not be started.');
                return;
            }
            setRebookingHandoff(data as RebookingHandoff);
            setShowWizard(true);
        } catch {
            setHandoffError('That fundraiser could not be started. Please try again.');
        }
    };

    // FR-RETENTION-1B-1: primary tab state (Campaigns / Organizations / Rebooking)
    const [activeTab, setActiveTab] = useState<'campaigns' | 'organizations' | 'rebooking'>('campaigns');

    // ── CRM-CC-4: Campaign Context drawer state ───────────────────────────
    const [detailCampaign, setDetailCampaign] = useState<(PriorityListCampaign & { triage: CampaignTriage }) | null>(null);

    // ── Phase 7E-3: Closeout modal state ──────────────────────────────────
    const [closeoutTarget, setCloseoutTarget] = useState<Fundraiser | null>(null);
    const [closeoutLoading, setCloseoutLoading] = useState(false);
    const [closeoutResult, setCloseoutResult] = useState<{
        success: boolean;
        message: string;
        settlement_total?: number;
        promoted_order_count?: number;
    } | null>(null);
    // CRM-CC-5: the closeout modal gets the same focus/scroll treatment as the
    // Campaign Context drawer — focus in on open, Tab contained, focus restored.
    const closeoutDialog = useDialogFocus(closeoutTarget !== null);

    const userPlan = (session?.user as any)?.plan;
    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;
    const hasAccess = userPlan === 'ENTERPRISE' || userPlan === 'ULTIMATE' || userPlan === 'FREE' || isSuperAdmin;

    // CRM-CC-5: extracted so the error state's Retry can re-run the same load
    // without a full page reload.
    const loadCampaigns = useCallback(() => {
        setIsLoading(true);
        setLoadError(false);
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
                setLoadError(true);
                setIsLoading(false);
            });
    }, []);

    useEffect(() => { loadCampaigns(); }, [loadCampaigns]);


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

    // CRM-CC-1: one clock per render so every row is triaged consistently.
    const triageNow = new Date();

    const filtered = fundraisers.filter(f => {
        const matchesSearch = f.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            f.customer.name.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesFilter =
            filterStatus === 'all' ? true :
            filterStatus === 'attention' ? triageCampaign(f, triageNow).priority === 'needs_attention' :
            filterStatus === 'closed' ? isCampaignClosed(f) :
            f.status.toLowerCase() === filterStatus.toLowerCase();
        return matchesSearch && matchesFilter;
    });

    if (status === 'loading') return <div className="p-8 text-center text-slate-400 font-bold">Loading session…</div>;

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

            {/* FR-RETENTION-1B-1: primary navigation — Campaigns / Organizations / Rebooking.
                CRM-CC-5 completes the ARIA tabs contract the roles promise: roving
                tabindex (one tab stop), arrow-key movement, and tab↔panel linkage. */}
            <div
                className="flex gap-2 border-b border-slate-200 dark:border-slate-700 pb-1 overflow-x-auto"
                role="tablist"
                aria-label="Fundraiser CRM"
                onKeyDown={(e) => {
                    const keys = ['campaigns', 'organizations', 'rebooking'] as const;
                    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
                    e.preventDefault();
                    const idx = keys.indexOf(activeTab);
                    const next =
                        e.key === 'ArrowRight' ? keys[(idx + 1) % keys.length]
                        : e.key === 'ArrowLeft' ? keys[(idx + keys.length - 1) % keys.length]
                        : e.key === 'Home' ? keys[0]
                        : keys[keys.length - 1];
                    setActiveTab(next);
                    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
                }}
            >
                {([
                    { key: 'campaigns' as const, label: 'Campaigns' },
                    { key: 'organizations' as const, label: 'Organizations' },
                    { key: 'rebooking' as const, label: 'Rebooking' },
                ]).map(t => (
                    <button
                        key={t.key}
                        id={`tab-${t.key}`}
                        role="tab"
                        aria-selected={activeTab === t.key}
                        aria-controls={`panel-${t.key}`}
                        tabIndex={activeTab === t.key ? 0 : -1}
                        onClick={() => setActiveTab(t.key)}
                        className={`px-5 py-2.5 rounded-t-xl font-bold text-sm whitespace-nowrap transition-all min-h-[44px] ${
                            activeTab === t.key
                                ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                                : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'
                        }`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {activeTab === 'rebooking' && (
                <div role="tabpanel" id="panel-rebooking" aria-labelledby="tab-rebooking">
                    <RebookingTab onStartFundraiser={startFundraiserFromOpportunity} />
                </div>
            )}

            {activeTab === 'organizations' && (
                <div role="tabpanel" id="panel-organizations" aria-labelledby="tab-organizations" className="space-y-6">
                    {/* GE-4 — organization fundraiser history. This tab previously
                        only pointed at the Customers area; the record of what each
                        group has actually sold over time now lives here, next to
                        the campaigns and rebooking work it informs. */}
                    <OrganizationImpactTab />
                    <div className="text-center">
                        <a href="/customers?type=organization" className="inline-block px-5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-800 min-h-[44px]">
                            Manage organizations in Customers
                        </a>
                    </div>
                </div>
            )}

            {activeTab === 'campaigns' && loadError && !isLoading && (
                <div role="tabpanel" id="panel-campaigns" aria-labelledby="tab-campaigns">
                    {/* CRM-CC-5 — a failed load says so, with a bounded retry;
                        the sibling tabs already have this treatment. */}
                    <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm py-14 px-6 text-center space-y-3">
                        <p className="text-sm font-bold text-slate-600 dark:text-slate-300">Couldn&apos;t load campaigns.</p>
                        <p className="text-xs font-medium text-slate-400">Check your connection and try again.</p>
                        <button
                            type="button"
                            onClick={loadCampaigns}
                            className="mt-1 px-5 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 font-bold text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                        >
                            Retry
                        </button>
                    </div>
                </div>
            )}

            {activeTab === 'campaigns' && !(loadError && !isLoading) && (
            <div role="tabpanel" id="panel-campaigns" aria-labelledby="tab-campaigns" className="space-y-8">
            {/* CRM-CC-1 — needs-attention strip. Replaces the three passive KPI
                cards (Active / High Leads / Held Orders): counts told the tenant
                what EXISTS; this band tells them what needs DOING today, and each
                chip goes to the place the work happens. */}
            <AttentionStrip
                fundraisers={fundraisers}
                loading={isLoading}
                onShowAttention={() => setFilterStatus('attention')}
                onGoRebooking={() => setActiveTab('rebooking')}
            />

            {/* Filters */}
            <div className="flex flex-col md:flex-row md:items-center gap-4 justify-between bg-white dark:bg-slate-800 p-4 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-700">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input
                        type="text"
                        aria-label="Search campaigns"
                        placeholder="Search by campaign or organization…"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-12 pr-4 py-3 bg-slate-50 dark:bg-slate-900 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-medium"
                    />
                </div>
                <div className="flex flex-wrap bg-slate-100 dark:bg-slate-900 p-1 rounded-2xl">
                    {/* CRM-CC-1: 'attention' filters to triage === needs_attention,
                        giving the strip's campaign chip a real destination. */}
                    {/* CRM-CC-5: 44px floor + aria-pressed to match the sibling
                        filter groups; labels are words, not raw filter keys. */}
                    {(['all', 'attention', 'active', 'lead', 'closed'] as const).map(status => (
                        <button
                            key={status}
                            type="button"
                            onClick={() => setFilterStatus(status)}
                            aria-pressed={filterStatus === status}
                            className={`px-4 md:px-6 py-2 rounded-xl text-xs font-black uppercase transition-all min-h-[44px] ${filterStatus === status ? 'bg-white dark:bg-slate-800 text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            {{ all: 'All', attention: 'Needs attention', active: 'Active', lead: 'Leads', closed: 'Closed' }[status]}
                        </button>
                    ))}
                </div>
            </div>

            {/* CRM-CC-2 — Campaign Priority List. Replaces the legacy 7-column
                table: campaigns are grouped by CRM-CC-1 triage into priority
                sections, each row carries one primary signal and at most one
                labeled next action, and legacy per-row capabilities live in a
                labeled overflow menu instead of five icon-only buttons. */}
            <CampaignPriorityList
                campaigns={filtered}
                loading={isLoading}
                totalCount={fundraisers.length}
                searchTerm={searchTerm}
                filterStatus={filterStatus}
                now={triageNow}
                onCloseout={(c) => openCloseoutModal(c as Fundraiser)}
                onOpenDetail={setDetailCampaign}
            />
            </div>
            )}
        </div>

        {/* ── CRM-CC-4: Campaign Context drawer. Closeout from inside the
            drawer reuses the SAME Phase 7E modal below — one closeout path. */}
        <CampaignContextDrawer
            campaign={detailCampaign}
            now={triageNow}
            onClose={() => setDetailCampaign(null)}
            onCloseout={(c) => { setDetailCampaign(null); openCloseoutModal(c as Fundraiser); }}
        />

        {/* ── Phase 7E-3: closeout confirmation modal. CRM-CC-5 gives it the
            same dialog semantics and focus treatment as the Campaign Context
            drawer; the closeout rules themselves are untouched. ──────────── */}
        {closeoutTarget && (
            <div
                className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="closeout-modal-title"
                onKeyDown={(e) => {
                    if (e.key === 'Escape' && !closeoutLoading) { dismissCloseoutModal(); return; }
                    closeoutDialog.containTab(e);
                }}
            >
                <div
                    ref={closeoutDialog.panelRef}
                    tabIndex={-1}
                    className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-md p-8 animate-in fade-in zoom-in duration-200 focus:outline-none"
                >

                    {/* Header */}
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-10 h-10 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                            <Lock size={20} className="text-amber-600" aria-hidden="true" />
                        </div>
                        <h3 id="closeout-modal-title" className="text-xl font-black text-slate-900 dark:text-white">
                            Close out fundraiser
                        </h3>
                    </div>
                    <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-6 pl-[3.25rem]">
                        {closeoutTarget.name}
                    </p>

                    {/* Result state — success */}
                    {closeoutResult?.success && (
                        <div role="status" className="mb-6 p-4 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-2xl space-y-1">
                            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-black">
                                <CheckCircle2 size={18} aria-hidden="true" />
                                Campaign closed
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
                        <div role="alert" className="mb-6 p-4 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700 rounded-2xl">
                            <div className="flex items-center gap-2 text-rose-700 dark:text-rose-400 font-black">
                                <AlertCircle size={18} aria-hidden="true" />
                                Error
                            </div>
                            <p className="text-sm text-rose-600 dark:text-rose-400 font-bold mt-1">
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
                                    <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Closing…</>
                                ) : (
                                    <><Lock size={16} aria-hidden="true" /> Close out fundraiser</>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        )}
        {/* CRM-4 — Start a Fundraiser wizard.
            FR-RETENTION-5: the same wizard, optionally opened with an approved
            rebooking request's evidence pre-filled. There is no second creation
            path — `rebooking` only changes what the wizard OPENS with. */}
        {showWizard && (
            <StartFundraiserWizard
                rebooking={rebookingHandoff ?? undefined}
                onClose={() => {
                    setShowWizard(false);
                    setRebookingHandoff(null);
                    // Reload so the new campaign row appears immediately
                    window.location.reload();
                }}
            />
        )}
        {handoffError && (
            <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-max max-w-[calc(100vw-2rem)] sm:max-w-md rounded-2xl border border-rose-200 dark:border-rose-900 bg-white dark:bg-slate-900 px-4 py-3 shadow-lg">
                <p className="text-sm font-bold text-rose-700 dark:text-rose-400">{handoffError}</p>
                <button onClick={() => setHandoffError(null)}
                    className="mt-2 min-h-[44px] px-3 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-bold">
                    Dismiss
                </button>
            </div>
        )}
        </>

    );
}
