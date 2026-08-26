"use client";

import { useState, useEffect, use } from 'react';
import { format } from 'date-fns';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Save, Calendar, StickyNote, MapPin, Mail, User, Edit2, X, Phone, Check, FileText, Send, Loader2, FileCheck, Megaphone } from 'lucide-react';
import Link from 'next/link';
import DocumentsTab from '@/components/crm/DocumentsTab';
import FundraisersTab from '@/components/crm/FundraisersTab';
import FundraiserOverview from '@/components/crm/FundraiserOverview';
import { STATUS_COLORS, STATUS_LABELS, type CustomerStatus } from '@/lib/statusConstants';
// CRM-2: Organization profile components
import { PipelineStepper } from '@/components/crm2/PipelineStepper';
import { CampaignCard } from '@/components/crm2/CampaignCard';
import { toast } from 'sonner';
import {
    evaluateRebookingEligibility,
    rebookingActionLabel,
    openCampaignNotice,
} from '@/lib/fundraiserRebooking';

export default function FundraiserProfilePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [customer, setCustomer] = useState<any>(null);
    const [notes, setNotes] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [businessSlug, setBusinessSlug] = useState('');
    const [bundles, setBundles] = useState<any[]>([]);
    const [isAddingOrder, setIsAddingOrder] = useState(false);

    // Default tab to overview for this specialized page
    const searchParams = useSearchParams();
    const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'overview');

    useEffect(() => {
        // Fetch current user/business info to get the slug
        fetch('/api/business')
            .then(async res => {
                const contentType = res.headers.get('content-type');
                if (!res.ok || !contentType?.includes('application/json')) {
                    throw new Error('Failed to load business data');
                }
                return res.json();
            })
            .then(data => {
                if (data.slug) setBusinessSlug(data.slug);
            })
            .catch(err => console.error("[FundraiserOrgProfile] Failed to fetch business:", err));

        // Fetch bundles for order modal
        fetch('/api/bundles')
            .then(res => res.json())
            .then(data => setBundles(data))
            .catch(err => console.error("Failed to fetch bundles:", err));
    }, []);

    // Check if customer can use documents
    const hasDocumentsAccess = customer && (customer.type === 'Fundraiser' || customer.type === 'Organization');

    // Edit Modal State
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [editForm, setEditForm] = useState({
        name: '',
        contact_name: '',
        email: '',
        phone: '',
        delivery_address: '',
        status: 'Active',
        inactive_reason: '',
        tags: '',
        type: 'Individual'
    });

    const fetchCustomer = () => {
        setIsLoading(true);
        fetch(`/api/customers/${id}`, { cache: 'no-store' })
            .then(async res => {
                const data = await res.json();
                if (!res.ok) {
                    // CRM-1A: preserve HTTP status for error discrimination
                    setCustomer({ error: data.error || 'Failed to load customer', httpStatus: res.status });
                    setIsLoading(false);
                    return;
                }
                setCustomer(data);
                setNotes(data.notes || '');
                setEditForm({
                    name: data.name || '',
                    contact_name: data.contact_name || '',
                    email: data.email || '',
                    phone: data.phone || '',
                    delivery_address: data.delivery_address || '',
                    status: data.rawStatus || data.status || 'LEAD',
                    inactive_reason: data.inactive_reason || '',
                    tags: (data.tags || []).join(', '),
                    type: data.type || 'Individual'
                });
                setIsLoading(false);
            })
            .catch(() => {
                setCustomer({ error: "Failed to load customer", httpStatus: 500 });
                setIsLoading(false);
            });
    };

    useEffect(() => {
        fetchCustomer();
    }, [id]);

    // ── FR-REBOOK-1: start (or resume) this organization's next fundraiser.
    //
    // Everything the launch needs about the organization is already stored, so
    // this asks for nothing. It opens a funnel cycle and hands the owner to the
    // SAME date conversation a brand-new lead goes through — the campaign itself
    // is still created by POST /api/opportunities/[id]/launch once a date is
    // confirmed. No second launch pipeline, no fabricated inquiry, no email.
    const [startingNext, setStartingNext] = useState(false);
    const rebookingInput = {
        archived: Boolean(customer?.archived),
        campaigns: (customer?.campaigns ?? []).map((c: any) => ({
            id: c.id,
            status: c.status,
            closed_at: c.closed_at,
            settlement_total: c.settlement_total,
            settled_externally: c.settled_externally,
            invoice_statuses: Array.isArray(c.invoices) ? c.invoices.map((i: any) => String(i.status)) : undefined,
            held_order_count: c.held_order_count,
        })),
    };
    const startNextEligibility = evaluateRebookingEligibility(rebookingInput);
    const canStartNext = startNextEligibility.ok;
    const startNextBlockedReason = startNextEligibility.ok ? null : startNextEligibility.error;
    // Advisory, not a gate: a running fundraiser is worth knowing about before
    // planning the next one, but it is not a reason to refuse. Planning a date is
    // not launching a campaign, and the public inquiry path has never refused it.
    const startNextNotice = startNextEligibility.ok ? openCampaignNotice(rebookingInput) : null;
    const startNextLabel = rebookingActionLabel(rebookingInput);

    const handleStartNextFundraiser = async () => {
        if (startingNext || !canStartNext) return;
        setStartingNext(true);
        try {
            const res = await fetch('/api/opportunities', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerId: id }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(data?.error || 'Could not start the next fundraiser');
                return;
            }
            toast.success(data?.resumed
                ? 'Picking up where this fundraiser left off'
                : `Next fundraiser started for ${data?.organization?.name ?? 'this organization'}`);
            // Straight to the funnel, where the date conversation and the existing
            // Start Fundraiser control already live.
            router.push('/fundraisers?tab=leads');
        } catch {
            toast.error('Could not start the next fundraiser');
        } finally {
            setStartingNext(false);
        }
    };

    const handleUpdateProfile = async (overrideData?: any) => {
        setIsSaving(true);
        try {
            const baseForm = {
                ...editForm,
                tags: typeof editForm.tags === 'string'
                    ? editForm.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                    : editForm.tags,
                notes
            };

            const payload = overrideData ? { ...baseForm, ...overrideData } : baseForm;

            const res = await fetch(`/api/customers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const updated = await res.json();
                setIsEditingProfile(false);
                if (updated.newId && updated.newId !== id) {
                    router.push(`/customers/${updated.newId}`);
                } else {
                    setCustomer((prev: any) => ({ ...prev, ...payload }));
                    setEditForm(prev => ({
                        ...prev,
                        ...payload,
                        tags: Array.isArray(payload.tags) ? payload.tags.join(', ') : prev.tags
                    }));
                    if (!overrideData) {
                        alert("Profile updated successfully!");
                        window.location.reload();
                    }
                }
            } else {
                const err = await res.json();
                alert(err.error || "Failed to update profile");
            }
        } catch (e: any) {
            console.error(e);
            alert(`Error updating profile: ${e.message}`);
        } finally {
            setIsSaving(false);
        }
    };

    const toggleOrderStatus = async (orderId: string, currentStatus: string) => {
        const newStatus = currentStatus === 'delivered' ? 'completed' : 'delivered';
        try {
            const res = await fetch('/api/orders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: orderId, status: newStatus })
            });

            if (res.ok) {
                setCustomer((prev: any) => ({
                    ...prev,
                    orders: prev.orders.map((o: any) =>
                        o.id === orderId ? { ...o, status: newStatus } : o
                    )
                }));
            } else {
                alert("Failed to update status");
            }
        } catch (e) {
            console.error("Failed to update order status", e);
        }
    };

    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading Profile...</div>;
    if (!customer || customer.error) {
        const status = customer?.httpStatus;
        const errorTitle =
            status === 401 ? "Please sign in again to view this profile." :
            status === 403 ? "You do not have access to this profile." :
            status === 404 ? "This fundraiser no longer exists." :
            "Something went wrong loading this profile — try again.";
        const errorBody =
            status === 401 ? "Your session may have expired." :
            status === 403 ? "You may have switched businesses." :
            status === 404 ? "You may have switched businesses or this fundraiser was removed." :
            "Our server hit an unexpected error. If this keeps happening, contact support.";
        return (
            <div className="p-12 text-center space-y-4">
                <div className="text-red-500 font-bold text-xl">{errorTitle}</div>
                <p className="text-slate-500">{errorBody}</p>
                <Link href="/fundraisers" className="inline-block px-6 py-2 bg-indigo-600 text-white rounded-xl font-bold">
                    Back to Campaigns
                </Link>
            </div>
        );
    }

    // CRM-2: Derive initials for org avatar
    const initials = (customer.name || '?')
        .split(' ')
        .filter(Boolean)
        .slice(0, 2)
        .map((w: string) => w[0].toUpperCase())
        .join('');

    // CRM-2: Determine active stage for stepper
    // Closed-family statuses all map to 'Closed' in the stepper
    const stepperStage = (() => {
        const s = customer.status || '';
        if (['Closed', 'Settled', 'Completed', 'Archived'].includes(s)) return 'Closed';
        if (s === 'Production') return 'Production';
        if (s === 'Active') return 'Active';
        if (s === 'Onboarding' || s === 'Send Info' || s === 'Flyers') return 'Onboarding';
        return 'Lead';
    })();

    const campaigns: any[] = customer.campaigns || [];

    return (
        <div className="max-w-6xl mx-auto space-y-5 pb-32">

            {/* ── Breadcrumb ── */}
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm font-bold text-slate-500 dark:text-slate-400">
                <Link href="/fundraisers"
                    className="inline-flex items-center gap-1.5 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors">
                    <ArrowLeft size={15} /> Fundraisers
                </Link>
                <span aria-hidden="true">/</span>
                <span className="truncate text-slate-700 dark:text-slate-300">{customer.name || '—'}</span>
            </nav>

            {/* ── CRM-2: Org Profile Header ── */}
            <div className="relative flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                {/* Avatar */}
                <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 font-black text-base dark:bg-indigo-950 dark:text-indigo-300 select-none">
                    {initials}
                </div>

                {/* Identity */}
                <div className="flex-1 min-w-0">
                    <h1 className="text-xl font-black leading-tight text-slate-900 dark:text-white tracking-tight">
                        {customer.name || '—'}
                    </h1>
                    <p className="mt-0.5 flex items-center gap-2 text-[0.72rem] text-slate-500">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-bold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            Fundraiser Organization
                        </span>
                        <span>{campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}</span>
                    </p>
                    {/* Contact links */}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {customer.contact_name && (
                            <span className="flex items-center gap-1 text-[0.72rem] font-bold text-slate-600 dark:text-slate-300">
                                <User size={11} />  {customer.contact_name}
                            </span>
                        )}
                        {customer.email && (
                            <a href={`mailto:${customer.email}`}
                                className="flex items-center gap-1 text-[0.72rem] font-bold text-indigo-600 hover:underline dark:text-indigo-400">
                                <Mail size={11} /> {customer.email}
                            </a>
                        )}
                        {customer.phone && (
                            <a href={`tel:${customer.phone}`}
                                className="flex items-center gap-1 text-[0.72rem] font-bold text-indigo-600 hover:underline dark:text-indigo-400">
                                <Phone size={11} /> {customer.phone}
                            </a>
                        )}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex flex-none gap-2">
                    <button
                        onClick={() => setIsEditingProfile(true)}
                        className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[0.78rem] font-bold text-slate-600 hover:bg-slate-100 transition dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                        <Edit2 size={13} /> Edit profile
                    </button>
                    <button
                        onClick={() => handleUpdateProfile()}
                        disabled={isSaving}
                        className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3 py-2 text-[0.78rem] font-bold text-white hover:bg-indigo-700 transition disabled:opacity-50">
                        <Save size={13} /> {isSaving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>

            {/* ── CRM-2: Pipeline Stepper ── */}
            <PipelineStepper current={stepperStage} />

            {/* ── CRM-2: Campaign history cards ── */}
            <div className="space-y-1">
                {/* FR-REBOOK-1 — the returning-organization entrance.
                    Placed at the head of Campaign History because that is where an
                    owner already looks when thinking "when did they last run, and
                    when are they running again". Everything this organization is
                    already lives on this page, so there is nothing to re-enter. */}
                <div className="mb-2 flex items-center justify-between gap-3">
                    <h2 className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Campaign History</h2>
                    <button
                        type="button"
                        onClick={handleStartNextFundraiser}
                        disabled={startingNext || !canStartNext}
                        title={startNextBlockedReason || undefined}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-[11px] font-black text-white shadow-sm transition-all hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Megaphone size={13} aria-hidden="true" />
                        {startingNext ? 'Starting…' : startNextLabel}
                    </button>
                </div>
                {startNextBlockedReason && (
                    <p className="mb-2 rounded-xl bg-rose-50 px-3.5 py-2 text-[11px] font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                        {startNextBlockedReason}
                    </p>
                )}
                {/* Information, not an obstacle — the button stays enabled. */}
                {startNextNotice && (
                    <p className="mb-2 rounded-xl bg-slate-50 px-3.5 py-2 text-[11px] font-medium text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                        {startNextNotice}
                    </p>
                )}

                {campaigns.length === 0 && (
                    <p className="py-10 text-center text-sm text-slate-400">No campaigns yet.</p>
                )}

                {campaigns.map((c: any) => (
                    <CampaignCard
                        key={c.id}
                        c={c}
                        businessSlug={businessSlug || undefined}
                    />
                ))}
            </div>

            {/* ── Tabs Navigation (Overview / Campaigns / Documents) ── */}
            <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700 pb-1">
                <button
                    onClick={() => setActiveTab('overview')}
                    className={`px-5 py-2.5 rounded-t-xl font-bold flex items-center gap-2 text-sm transition-all ${
                        activeTab === 'overview'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <Megaphone size={16} /> Overview
                </button>
                <button
                    onClick={() => setActiveTab('campaigns')}
                    className={`px-5 py-2.5 rounded-t-xl font-bold flex items-center gap-2 text-sm transition-all ${
                        activeTab === 'campaigns'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <Megaphone size={16} /> Campaigns
                </button>
                {hasDocumentsAccess && (
                    <button
                        onClick={() => setActiveTab('documents')}
                        className={`px-5 py-2.5 rounded-t-xl font-bold flex items-center gap-2 text-sm transition-all ${
                            activeTab === 'documents'
                            ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                            : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                    >
                        <FileCheck size={16} /> Documents
                    </button>
                )}
            </div>

            {activeTab === 'overview' && (
                <FundraiserOverview
                    customer={customer}
                    onUpdateCustomer={handleUpdateProfile}
                    onEditProfile={() => setIsEditingProfile(true)}
                    onNavigateToCampaigns={() => setActiveTab('campaigns')}
                />
            )}

            {activeTab === 'campaigns' && (
                <FundraisersTab
                    customerId={customer.id}
                    businessSlug={businessSlug}
                />
            )}
            {activeTab === 'documents' && <DocumentsTab customer={customer} />}

            {/* Edit Profile Modal */}
            {isEditingProfile && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-lg p-8 animate-in fade-in zoom-in duration-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white">Edit Customer</h3>
                            <button onClick={() => setIsEditingProfile(false)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors">
                                <X size={24} className="text-slate-400" />
                            </button>
                        </div>
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Status</label>
                                    <select
                                        value={editForm.status}
                                        onChange={e => setEditForm({ ...editForm, status: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white appearance-none"
                                    >
                                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                                            <option key={value} value={value}>{label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Partner Type</label>
                                    <select
                                        value={editForm.type}
                                        onChange={e => setEditForm({ ...editForm, type: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white appearance-none"
                                    >
                                        <option value="Organization">Organization (B2B)</option>
                                        <option value="Fundraiser">Fundraiser Group</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Organization Name</label>
                                <input
                                    value={editForm.name}
                                    onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    placeholder="e.g. Spring 2026 PTA"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                                    Primary Contact Person
                                </label>
                                <input
                                    value={editForm.contact_name}
                                    onChange={e => setEditForm({ ...editForm, contact_name: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    placeholder={editForm.type === 'Individual' ? "e.g. John Doe" : "e.g. Jane Smith"}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Email</label>
                                    <input
                                        value={editForm.email}
                                        onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Phone</label>
                                    <input
                                        value={editForm.phone}
                                        onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Delivery Address</label>
                                <input
                                    value={editForm.delivery_address}
                                    onChange={e => setEditForm({ ...editForm, delivery_address: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    placeholder="123 Fundraiser Lane, Chicago, IL"
                                />
                            </div>

                            <div className="pt-4 flex gap-3 justify-end">
                                <button onClick={() => setIsEditingProfile(false)} className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">Cancel</button>
                                <button onClick={() => handleUpdateProfile()} disabled={isSaving} className="px-8 py-3 rounded-xl font-bold bg-indigo-600 text-white hover:scale-105 active:scale-95 disabled:opacity-50 transition-all">Save</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
