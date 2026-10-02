"use client";

/**
 * FR-ORG-DASHBOARD-1A — the fundraiser organization page as a mini command center.
 *
 * It answers, in one scan: who this organization is, how much fundraiser
 * business it has done, how many campaigns and supporters it has, how many of
 * those supporters can be invited by email, what happened last time, what is in
 * progress, and what to open next. It is NOT a second place to set up or edit a
 * fundraiser — that work lives in the Leads funnel and the Campaign Context
 * drawer, which "Continue setup", "Open fundraiser" and "View campaign" open.
 *
 * Two reads:
 *   GET /api/customers/[id]                       the editable profile (unchanged)
 *   GET /api/customers/[id]/fundraiser-dashboard  every campaign, KPIs, history,
 *                                                 supporters, outreach (read only)
 *
 * No longer rendered here (the components remain where other pages use them):
 * the CustomerStatus stepper and Relationship Stage panel, the legacy Next Steps
 * card and its intro / info / marketing-packet emails, Create Campaign, the
 * Campaign Details form, manual bundle menus, flyer/tracker previews and their
 * Save Changes, the per-campaign editor tab, and the header's global Save.
 */

import { useState, useEffect, useCallback, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Archive, ArrowLeft, Edit2, Mail, Megaphone, Phone, RotateCcw, User, X } from 'lucide-react';
import { toast } from 'sonner';
import QuickBooksCustomerLinkCard from '@/components/crm/QuickBooksCustomerLinkCard';
import EmailComposeModal from '@/components/crm/EmailComposeModal';
import { STATUS_LABELS } from '@/lib/statusConstants';
import {
    evaluateRebookingEligibility,
    rebookingActionLabel,
    openCampaignNotice,
} from '@/lib/fundraiserRebooking';
import type { CurrentOpportunityCard, OrganizationDashboard } from '@/lib/organizationDashboard';
import { OrgKpiRow } from '@/components/crm2/orgDashboard/OrgKpiRow';
import { CurrentWorkSection } from '@/components/crm2/orgDashboard/CurrentWorkSection';
import { RelationshipIntelligenceCard } from '@/components/crm2/orgDashboard/RelationshipIntelligenceCard';
import { MarketingActivityCard } from '@/components/crm2/orgDashboard/MarketingActivityCard';
import { CampaignHistoryList } from '@/components/crm2/orgDashboard/CampaignHistoryList';
import { OrganizationDetailsSection } from '@/components/crm2/orgDashboard/OrganizationDetailsSection';
import { DiscardDraftDialog } from '@/components/crm2/orgDashboard/DiscardDraftDialog';

const PRIMARY_BUTTON = 'items-center justify-center gap-1.5 min-h-[44px] rounded-xl bg-indigo-600 px-4 text-xs font-black text-white shadow-sm transition-all hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50';
const SECONDARY_BUTTON = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] rounded-xl border border-slate-200 bg-white px-3.5 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800';
const FIELD = 'w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white';

type NotesState = 'idle' | 'saving' | 'saved' | 'error';

export default function FundraiserProfilePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [customer, setCustomer] = useState<any>(null);
    const [notes, setNotes] = useState('');
    const [notesState, setNotesState] = useState<NotesState>('idle');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    // FR-ORG-DASHBOARD-1A: the complete history and its figures, read separately
    // from the profile so a dashboard failure never blocks editing the profile.
    const [dashboard, setDashboard] = useState<OrganizationDashboard | null>(null);
    const [dashboardState, setDashboardState] = useState<'loading' | 'ready' | 'error'>('loading');

    // Customer Notes autosave: the last value the server accepted, and the debounce timer.
    const savedNotesRef = useRef('');
    const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    const fetchCustomer = useCallback((opts: { quiet?: boolean } = {}) => {
        if (!opts.quiet) setIsLoading(true);
        return fetch(`/api/customers/${id}`, { cache: 'no-store' })
            .then(async res => {
                const data = await res.json();
                if (!res.ok) {
                    // CRM-1A: preserve HTTP status for error discrimination
                    if (!opts.quiet) setCustomer({ error: data.error || 'Failed to load customer', httpStatus: res.status });
                    setIsLoading(false);
                    return;
                }
                setCustomer(data);
                if (!opts.quiet) {
                    setNotes(data.notes || '');
                    savedNotesRef.current = data.notes || '';
                }
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
                if (!opts.quiet) setCustomer({ error: "Failed to load customer", httpStatus: 500 });
                setIsLoading(false);
            });
    }, [id]);

    const fetchDashboard = useCallback(() => {
        return fetch(`/api/customers/${id}/fundraiser-dashboard`, { cache: 'no-store' })
            .then(async res => {
                if (!res.ok) throw new Error(String(res.status));
                setDashboard(await res.json());
                setDashboardState('ready');
            })
            .catch(() => setDashboardState('error'));
    }, [id]);

    useEffect(() => {
        fetchCustomer();
        fetchDashboard();
    }, [fetchCustomer, fetchDashboard]);

    // ── FR-REBOOK-1: start (or resume) this organization's next fundraiser.
    //
    // Everything the launch needs about the organization is already stored, so
    // this asks for nothing. It opens a funnel cycle and hands the owner to the
    // SAME date conversation a brand-new lead goes through — the campaign itself
    // is still created by POST /api/opportunities/[id]/launch once a date is
    // confirmed. No second launch pipeline, no fabricated inquiry, no email.
    //
    // FR-ORG-DASHBOARD-1A: the campaigns come from the dashboard read, which
    // carries EVERY campaign; the profile read returns only the newest five.
    const [startingNext, setStartingNext] = useState(false);
    const rebookingInput = {
        archived: Boolean(dashboard?.rebooking?.archived ?? customer?.archived),
        campaigns: dashboard
            ? dashboard.rebooking.campaigns
            : (customer?.campaigns ?? []).map((c: any) => ({
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

    // ── The organization save path (PUT /api/customers/[id], unchanged) ──────
    // The whole profile form travels with every save, exactly as before, with the
    // CURRENT notes — so saving the profile can never revert notes typed since
    // the page loaded.
    const putProfile = async (overrideData?: any): Promise<{ ok: boolean; error?: string; newId?: string }> => {
        const baseForm = {
            ...editForm,
            tags: typeof editForm.tags === 'string'
                ? editForm.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                : editForm.tags,
            notes
        };
        const payload = overrideData ? { ...baseForm, ...overrideData } : baseForm;
        try {
            const res = await fetch(`/api/customers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return { ok: false, error: data?.error || 'Failed to update profile' };
            return { ok: true, newId: data?.newId };
        } catch (e: any) {
            return { ok: false, error: e?.message || 'Failed to update profile' };
        }
    };

    const saveProfile = async (overrideData?: any, successMessage = 'Profile updated'): Promise<boolean> => {
        setIsSaving(true);
        try {
            const result = await putProfile(overrideData);
            if (!result.ok) {
                toast.error(result.error);
                return false;
            }
            if (result.newId && result.newId !== id) {
                router.push(`/customers/${result.newId}`);
                return true;
            }
            toast.success(successMessage);
            await fetchCustomer({ quiet: true });
            return true;
        } finally {
            setIsSaving(false);
        }
    };

    // ── Customer Notes: saved automatically, one second after typing stops ───
    useEffect(() => () => { if (notesTimer.current) clearTimeout(notesTimer.current); }, []);
    const handleNotesChange = (value: string) => {
        setNotes(value);
        if (notesTimer.current) clearTimeout(notesTimer.current);
        notesTimer.current = setTimeout(async () => {
            if (value === savedNotesRef.current) return;
            setNotesState('saving');
            const result = await putProfile({ notes: value });
            if (result.ok) {
                savedNotesRef.current = value;
                setCustomer((prev: any) => (prev ? { ...prev, notes: value } : prev));
                setNotesState('saved');
            } else {
                setNotesState('error');
            }
        }, 1000);
    };

    // ── Archive / restore — the only refusal Start Next Fundraiser can give ──
    const handleArchiveToggle = async () => {
        const archived = Boolean(customer?.archived);
        const name = customer?.name || 'this organization';
        const message = archived
            ? `Restore ${name}? You will be able to start fundraisers with them again.`
            : `Archive ${name}? Their campaigns, orders and history are kept, but you can't start a new fundraiser until you restore them.`;
        if (!confirm(message)) return;
        const ok = await saveProfile({ archived: !archived }, archived ? 'Organization restored' : 'Organization archived');
        if (ok) {
            setIsEditingProfile(false);
            fetchDashboard();
        }
    };

    // ── Custom email from the Contact Profile (context 'custom' never moves a stage) ─
    const [isEmailOpen, setIsEmailOpen] = useState(false);
    const handleSendEmail = async (subject: string, html: string, attachments: any[] = []) => {
        const res = await fetch('/api/email/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: customer.email,
                subject,
                html,
                attachments,
                customerId: customer.id,
                context: 'custom'
            })
        });
        const data = await res.json().catch(() => ({} as any));
        if (!res.ok) {
            toast.error(data?.error ? `Failed to send: ${data.error}` : 'Failed to send the email');
            throw new Error('send failed');
        }
        if (data.mocked) {
            toast.warning('No email was sent — email sending is switched off for this environment. Nothing reached this contact.');
            return;
        }
        toast.success('Email sent');
    };

    // ── Discard an empty planning draft (never a real inquiry) ───────────────
    const [discardTarget, setDiscardTarget] = useState<CurrentOpportunityCard | null>(null);
    const [discarding, setDiscarding] = useState(false);
    const [discardError, setDiscardError] = useState<string | null>(null);
    const confirmDiscard = async () => {
        if (!discardTarget || discarding) return;
        setDiscarding(true);
        setDiscardError(null);
        try {
            const res = await fetch(`/api/opportunities/${discardTarget.id}/discard-draft`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setDiscardError(data?.error || 'Could not discard the draft.');
                if (res.status === 409 || res.status === 404) fetchDashboard();
                return;
            }
            setDiscardTarget(null);
            toast.success('Draft discarded');
            fetchDashboard();
        } catch {
            setDiscardError('Could not discard the draft. Please try again.');
        } finally {
            setDiscarding(false);
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

    const startNextButton = (extra: string) => (
        <button
            type="button"
            onClick={handleStartNextFundraiser}
            disabled={startingNext || !canStartNext}
            title={startNextBlockedReason || undefined}
            className={`${PRIMARY_BUTTON} ${extra}`}
        >
            <Megaphone size={14} aria-hidden="true" />
            {startingNext ? 'Starting…' : startNextLabel}
        </button>
    );

    return (
        <div className="max-w-6xl mx-auto space-y-5 pb-28 sm:pb-10">

            {/* ── Breadcrumb ── */}
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm font-bold text-slate-500 dark:text-slate-400">
                <Link href="/fundraisers"
                    className="inline-flex items-center gap-1.5 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors">
                    <ArrowLeft size={15} /> Fundraisers
                </Link>
                <span aria-hidden="true">/</span>
                <span className="truncate text-slate-700 dark:text-slate-300">{customer.name || '—'}</span>
            </nav>

            {/* ── Organization header: who this is, and the two actions ── */}
            <header className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    <div className="flex min-w-0 flex-1 items-start gap-4">
                        <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 font-black text-base dark:bg-indigo-950 dark:text-indigo-300 select-none">
                            {initials}
                        </div>
                        <div className="min-w-0 flex-1">
                            <h1 className="break-words text-xl font-black leading-tight text-slate-900 dark:text-white tracking-tight">
                                {customer.name || '—'}
                            </h1>
                            <p className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                                    Fundraiser Organization
                                </span>
                                {customer.archived && (
                                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                                        Archived
                                    </span>
                                )}
                            </p>
                            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
                                {customer.contact_name && (
                                    <span className="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-300">
                                        <User size={12} aria-hidden="true" className="text-slate-400" /> {customer.contact_name}
                                    </span>
                                )}
                                {customer.email && (
                                    // Truncated in this compact strip; Contact Profile below shows it in full.
                                    <a href={`mailto:${customer.email}`} title={customer.email}
                                        className="flex min-w-0 max-w-full items-center gap-1.5 text-xs font-bold text-indigo-600 hover:underline dark:text-indigo-400">
                                        <Mail size={12} aria-hidden="true" className="shrink-0" />
                                        <span className="truncate">{customer.email}</span>
                                    </a>
                                )}
                                {customer.phone && (
                                    <a href={`tel:${customer.phone}`}
                                        className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:underline dark:text-indigo-400">
                                        <Phone size={12} aria-hidden="true" /> {customer.phone}
                                    </a>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="flex gap-2 sm:flex-none">
                        <button
                            type="button"
                            onClick={() => setIsEditingProfile(true)}
                            className={`${SECONDARY_BUTTON} flex-1 sm:flex-none`}>
                            <Edit2 size={13} aria-hidden="true" /> Edit Profile
                        </button>
                        {/* On phones the same action lives in the bar pinned to the bottom. */}
                        {startNextButton('hidden sm:inline-flex')}
                    </div>
                </div>
            </header>

            {startNextBlockedReason && (
                <p className="rounded-xl bg-rose-50 px-3.5 py-2 text-[11px] font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                    {startNextBlockedReason}
                </p>
            )}
            {/* Information, not an obstacle — the button stays enabled. */}
            {startNextNotice && (
                <p className="rounded-xl bg-slate-50 px-3.5 py-2 text-[11px] font-medium text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                    {startNextNotice}
                </p>
            )}

            {dashboardState === 'loading' && (
                <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm font-bold text-slate-400 dark:border-slate-800 dark:bg-slate-900">
                    Loading fundraiser history…
                </div>
            )}
            {dashboardState === 'error' && (
                <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-5 sm:flex-row sm:items-center dark:border-rose-900 dark:bg-rose-950/30">
                    <p className="flex-1 text-sm font-bold text-rose-800 dark:text-rose-300">
                        Fundraiser history could not be loaded. The profile below is still up to date.
                    </p>
                    <button type="button" onClick={() => { setDashboardState('loading'); fetchDashboard(); }} className={SECONDARY_BUTTON}>
                        Try again
                    </button>
                </div>
            )}

            {dashboard && (
                <>
                    <OrgKpiRow kpis={dashboard.kpis} />

                    <CurrentWorkSection
                        current={dashboard.current}
                        onDiscardDraft={(o) => { setDiscardError(null); setDiscardTarget(o); }}
                    />

                    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3 lg:items-start">
                        {/* ── Campaign History: the wide column on desktop ── */}
                        <section
                            aria-labelledby="campaign-history-heading"
                            className="order-2 min-w-0 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 lg:order-1 lg:col-span-2 lg:row-span-2 dark:border-slate-800 dark:bg-slate-900"
                        >
                            <div className="mb-1 flex items-center justify-between gap-3">
                                <h2 id="campaign-history-heading" className="text-[11px] font-black uppercase tracking-widest text-slate-400">Campaign History</h2>
                                {dashboard.history.length > 0 && (
                                    <span className="text-[11px] font-bold text-slate-400">
                                        {dashboard.history.length} {dashboard.history.length === 1 ? 'campaign' : 'campaigns'}
                                    </span>
                                )}
                            </div>
                            {dashboard.history.length > 0 ? (
                                <CampaignHistoryList rows={dashboard.history} />
                            ) : (
                                <div className="py-8 text-center">
                                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">No fundraisers yet</p>
                                    <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                                        This organization’s campaigns will appear here once the first one is launched.
                                    </p>
                                    <div className="mt-4 flex justify-center">{startNextButton('inline-flex')}</div>
                                </div>
                            )}
                        </section>

                        <div className="order-1 min-w-0 lg:order-2">
                            <RelationshipIntelligenceCard intelligence={dashboard.intelligence} />
                        </div>
                        <div className="order-3 min-w-0">
                            <MarketingActivityCard entries={dashboard.marketing} />
                        </div>
                    </div>
                </>
            )}

            {/* ── Organization Details: permanent records ── */}
            <OrganizationDetailsSection
                customer={customer}
                notes={notes}
                notesState={notesState}
                onNotesChange={handleNotesChange}
                onSaveTax={async (updates) => {
                    // The panel shows its own success toast and reports a thrown error.
                    const result = await putProfile(updates);
                    if (!result.ok) throw new Error(result.error || 'Failed to save tax status');
                    await fetchCustomer({ quiet: true });
                }}
                onTaxDocumentChanged={() => fetchCustomer({ quiet: true })}
                onEditProfile={() => setIsEditingProfile(true)}
                onComposeEmail={() => setIsEmailOpen(true)}
                quickBooks={
                    /* QB-INVOICE-1B card, on the canonical organization profile (CRM-2/CRM-3: Customer CRM →
                       Organizations opens this page). `customer.id` is the organization's own id — the id its
                       campaigns, their invoices and its one QuickBooks customer link all carry. Tenant admins
                       only; renders nothing when QuickBooks is unavailable. */
                    <QuickBooksCustomerLinkCard customerId={customer.id} />
                }
            />

            {/* ── Phones: Start Next Fundraiser stays one tap away ── */}
            <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:hidden dark:border-slate-800 dark:bg-slate-900/95">
                {startNextButton('flex w-full')}
            </div>

            <EmailComposeModal
                isOpen={isEmailOpen}
                onClose={() => setIsEmailOpen(false)}
                onSend={handleSendEmail}
                initialSubject=""
                initialHtml=""
                recipientEmail={customer.email || ''}
            />

            <DiscardDraftDialog
                open={discardTarget !== null}
                organizationName={customer.name || 'This organization'}
                busy={discarding}
                error={discardError}
                onCancel={() => { if (!discarding) setDiscardTarget(null); }}
                onConfirm={confirmDiscard}
            />

            {/* Edit Profile Modal */}
            {isEditingProfile && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="edit-profile-title"
                        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl sm:p-8 dark:bg-slate-800 animate-in fade-in zoom-in duration-200"
                    >
                        <div className="flex justify-between items-center mb-6">
                            <h3 id="edit-profile-title" className="text-2xl font-black text-slate-900 dark:text-white">Edit Profile</h3>
                            <button
                                type="button"
                                onClick={() => setIsEditingProfile(false)}
                                aria-label="Close"
                                className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                            >
                                <X size={22} className="text-slate-400" />
                            </button>
                        </div>
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    {/* CustomerStatus is the sales relationship — never the fundraiser's state. */}
                                    <label htmlFor="edit-relationship-stage" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Relationship stage</label>
                                    <select
                                        id="edit-relationship-stage"
                                        value={editForm.status}
                                        onChange={e => setEditForm({ ...editForm, status: e.target.value })}
                                        className={`${FIELD} appearance-none`}
                                    >
                                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                                            <option key={value} value={value}>{label}</option>
                                        ))}
                                    </select>
                                    <p className="mt-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                                        Your sales relationship with them — not a fundraiser’s status.
                                    </p>
                                </div>
                                <div>
                                    <label htmlFor="edit-partner-type" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Partner Type</label>
                                    <select
                                        id="edit-partner-type"
                                        value={editForm.type}
                                        onChange={e => setEditForm({ ...editForm, type: e.target.value })}
                                        className={`${FIELD} appearance-none`}
                                    >
                                        <option value="Organization">Organization (B2B)</option>
                                        <option value="Fundraiser">Fundraiser Group</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label htmlFor="edit-org-name" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Organization Name</label>
                                <input
                                    id="edit-org-name"
                                    value={editForm.name}
                                    onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                    className={FIELD}
                                    placeholder="e.g. Spring 2026 PTA"
                                />
                            </div>

                            <div>
                                <label htmlFor="edit-contact-name" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                                    Primary Contact Person
                                </label>
                                <input
                                    id="edit-contact-name"
                                    value={editForm.contact_name}
                                    onChange={e => setEditForm({ ...editForm, contact_name: e.target.value })}
                                    className={FIELD}
                                    placeholder="e.g. Jane Smith"
                                />
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label htmlFor="edit-email" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Email</label>
                                    <input
                                        id="edit-email"
                                        value={editForm.email}
                                        onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                                        className={FIELD}
                                    />
                                </div>
                                <div>
                                    <label htmlFor="edit-phone" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Phone</label>
                                    <input
                                        id="edit-phone"
                                        value={editForm.phone}
                                        onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                                        className={FIELD}
                                    />
                                </div>
                            </div>

                            <div>
                                <label htmlFor="edit-delivery-address" className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Delivery Address</label>
                                <input
                                    id="edit-delivery-address"
                                    value={editForm.delivery_address}
                                    onChange={e => setEditForm({ ...editForm, delivery_address: e.target.value })}
                                    className={FIELD}
                                    placeholder="123 Fundraiser Lane, Chicago, IL"
                                />
                            </div>

                            <div className="flex flex-col-reverse gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                                <button
                                    type="button"
                                    onClick={handleArchiveToggle}
                                    disabled={isSaving}
                                    className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-700"
                                >
                                    {customer.archived
                                        ? <><RotateCcw size={16} aria-hidden="true" /> Restore organization</>
                                        : <><Archive size={16} aria-hidden="true" /> Archive organization</>}
                                </button>
                                <div className="flex gap-3 sm:justify-end">
                                    <button type="button" onClick={() => setIsEditingProfile(false)} className="min-h-[44px] flex-1 rounded-xl px-6 font-bold text-slate-500 hover:bg-slate-100 sm:flex-none dark:hover:bg-slate-700">Cancel</button>
                                    <button
                                        type="button"
                                        onClick={async () => { if (await saveProfile()) setIsEditingProfile(false); }}
                                        disabled={isSaving}
                                        className="min-h-[44px] flex-1 rounded-xl bg-indigo-600 px-8 font-bold text-white transition-all hover:bg-indigo-700 disabled:opacity-50 sm:flex-none"
                                    >
                                        {isSaving ? 'Saving…' : 'Save'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
