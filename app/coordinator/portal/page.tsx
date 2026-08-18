"use client";

import { useState, useEffect, useCallback } from 'react';
import { toast, Toaster } from 'sonner';
import type { CampaignAsset } from '@/lib/campaignAssets';
import type { PromoScriptsResponse } from '@/lib/generatePromoScripts';
import { computeFundraiserProgress, formatBundleCount } from '@/lib/fundraiserMetrics';

import {
    Plus,
    Target,
    Loader2,
    DollarSign,
    User,
    Phone,
    MapPin,
    AlertCircle,
    X,
    Settings,
    Trash2,
    RotateCcw
} from 'lucide-react';
import type { CoordinatorActionSummary } from '@/app/api/coordinator-actions/summary/route';
import { format } from 'date-fns';

// FR-COORD-SEC-1B: the portal no longer reads a credential from the URL.
// Authority is the coordinator session cookie, sent automatically.

import CopyButton from '@/components/coordinator/CopyButton';
import { ActionBar } from '@/components/coordinator/ActionBar';
import { ProgressHero } from '@/components/coordinator/ProgressHero';
import { SetupChecklist } from '@/components/coordinator/SetupChecklist';
import { ShareCenter } from '@/components/coordinator/ShareCenter';
import { RecentOrders } from '@/components/coordinator/RecentOrders';
import { QuietLinks } from '@/components/coordinator/QuietLinks';
import { DeliveryPrep } from '@/components/coordinator/DeliveryPrep';
import { WhatsNext } from '@/components/coordinator/WhatsNext';
import { BundleSelectionStep } from '@/components/coordinator/BundleSelectionStep';
import Confetti from 'react-confetti';
import { useWindowSize } from 'react-use';

export default function CoordinatorPortal() {
    const { width, height } = useWindowSize();
    const [campaign, setCampaign] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    // CB-3: true once bundle selection is confirmed by the server (or not required)
    const [bundleSelectionDone, setBundleSelectionDone] = useState(false);
    // CB-3-FIX-B: stable callback prevents the child's useCallback(fetchSelectionState)
    // from re-running every time the parent re-renders after setBundleSelectionDone(true).
    const handleBundleSelectionComplete = useCallback(() => {
        setBundleSelectionDone(true);
    }, []);
    const [showOrderModal, setShowOrderModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
    const [isCanceling, setIsCanceling] = useState(false);
    const [restoreOrderId, setRestoreOrderId] = useState<string | null>(null);
    const [isRestoring, setIsRestoring] = useState(false);
    const [copied, setCopied] = useState(false);
    const [campaignAssets, setCampaignAssets] = useState<CampaignAsset[]>([]);
    const [promoScripts, setPromoScripts] = useState<PromoScriptsResponse | null>(null);
    const [actionSummary, setActionSummary] = useState<CoordinatorActionSummary | null>(null);

    // ── AI Content Generator state ──
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [aiContent, setAiContent] = useState('');
    const [aiChannel, setAiChannel] = useState('');
    const [aiRemaining, setAiRemaining] = useState<number | null>(null);
    const [showAiPanel, setShowAiPanel] = useState(false);
    const [showAllOrders, setShowAllOrders] = useState(false);

    const handleAiGenerate = async (channel: string) => {
        setIsAiGenerating(true);
        setAiChannel(channel);
        try {
            const res = await fetch('/api/coordinator/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel })
            });
            const data = await res.json();
            if (!res.ok) {
                toast.error(data.error || 'Generation failed');
                return;
            }
            setAiContent(data.content);
            setAiRemaining(data.remaining);
            trackAction('ai_generate_' + channel);

            // Auto-copy generated content to clipboard
            const content = data.content as string;
            await navigator.clipboard.writeText(content);

            const channelName = channel.charAt(0).toUpperCase() + channel.slice(1);
            toast.success(`${channelName} message copied! Use the share button below to open your app.`);
        } catch {
            toast.error('Network error. Please try again.');
        } finally {
            setIsAiGenerating(false);
        }
    };

    // ── Non-blocking action tracker ────────────────────────
    const trackAction = (action_type: string) => {
        const isMobile = typeof navigator !== 'undefined' &&
            /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        fetch('/api/coordinator-actions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action_type,
                source: isMobile ? 'mobile' : 'desktop',
            }),
        })
            .then(() => {
                // Refresh summary after successful log
                fetch('/api/coordinator-actions/summary')
                    .then(r => r.ok ? r.json() : null)
                    .then(s => { if (s) setActionSummary(s); })
                    .catch(() => { /* silent */ });
            })
            .catch(() => { /* tracking failure is silent, never blocks UX */ });
    };

    // Form State
    const [formData, setFormData] = useState({
        customerName: '',
        participantName: '', // For Leaderboard attribution
        email: '',
        phone: '',
        totalAmount: '',
        deliveryAddress: ''
    });



    useEffect(() => {
        fetchCampaign();
    }, []);

    // ── Cancel Order Handler ──
    const handleCancelOrder = async () => {
        if (!cancelOrderId) return;
        setIsCanceling(true);
        try {
            const res = await fetch('/api/coordinator', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId: cancelOrderId })
            });
            if (!res.ok) {
                const data = await res.json();
                toast.error(data.error || 'Failed to cancel order');
                return;
            }
            toast.success('Order canceled successfully');
            setCancelOrderId(null);
            fetchCampaign();
        } catch {
            toast.error('Network error. Please try again.');
        } finally {
            setIsCanceling(false);
        }
    };

    // ── Restore Order Handler ──
    const handleRestoreOrder = async () => {
        if (!restoreOrderId) return;
        setIsRestoring(true);
        try {
            const res = await fetch('/api/coordinator', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'restore', orderId: restoreOrderId })
            });
            if (!res.ok) {
                const data = await res.json();
                toast.error(data.error || 'Failed to restore order');
                return;
            }
            toast.success('Order restored successfully');
            setRestoreOrderId(null);
            fetchCampaign();
        } catch {
            toast.error('Network error. Please try again.');
        } finally {
            setIsRestoring(false);
        }
    };

    const fetchCampaign = async () => {
        // FR-COORD-SEC-1B: access is validated server-side by /api/coordinator
        // from the coordinator session cookie. There is nothing to check here —
        // an unauthenticated caller simply gets a 401 and the portal shows the
        // neutral invalid-link state. Coordinators remain external users who
        // arrive by private link (CONSTITUTION §15).

        try {
            const res = await fetch('/api/coordinator');
            const data = await res.json();
            if (!res.ok || data.error) {
                console.error('Coordinator API error:', data.error);
                setCampaign(null);
                setIsLoading(false);
                return;
            }
            setCampaign(data);
            setIsLoading(false);

            // Fetch campaign asset metadata (fail-safe – does not block portal)
            fetch('/api/campaign-assets')
                .then(r => r.ok ? r.json() : null)
                .then(assets => {
                    if (assets?.assets) setCampaignAssets(assets.assets);
                })
                .catch(() => { /* asset fetch failure is non-blocking */ });

            // Fetch promo scripts (fail-safe – does not block portal)
            fetch('/api/promo-scripts')
                .then(r => r.ok ? r.json() : null)
                .then(scripts => {
                    if (scripts?.scripts) setPromoScripts(scripts);
                })
                .catch(() => { /* promo script fetch failure is non-blocking */ });

            // Fetch action summary (fail-safe)
            fetch('/api/coordinator-actions/summary')
                .then(r => r.ok ? r.json() : null)
                .then(s => { if (s) setActionSummary(s); })
                .catch(() => { /* action summary fetch failure is non-blocking */ });
        } catch (err) {
            console.error("Failed to load campaign", err);
            setIsLoading(false);
        }
    };

    // ── URL helpers ── Shop order page (drives sales) vs. scoreboard ──
    const getShopOrderUrl = () => {
        const slug = (campaign?.customer as any)?.business?.slug;
        if (slug && campaign?.id) {
            return `${window.location.origin}/shop/${slug}/fundraiser/${campaign.id}`;
        }
        // Fallback: old scoreboard URL
        return `${window.location.origin}/fundraiser/${campaign?.public_token}`;
    };

    const getScoreboardUrl = () => {
        return `${window.location.origin}/fundraiser/${campaign?.public_token}`;
    };

    const handleCopy = () => {
        const url = getShopOrderUrl();
        navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };



    // URL helper used by AI share-with-content handlers
    const getPublicUrl = () => getShopOrderUrl();

    // ── *WithContent helpers (for re-sharing edited AI content) ──
    const handleFacebookShareWithContent = async (content: string) => {
        await navigator.clipboard.writeText(content);
        toast.success('Copied! Paste into Facebook when it opens.');
        const url = getPublicUrl();
        window.open(
            `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
            '_blank',
            'width=600,height=400'
        );
    };

    const handleSmsShareWithContent = async (content: string) => {
        await navigator.clipboard.writeText(content);
        const isMobile = typeof navigator !== 'undefined' &&
            /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (isMobile) {
            toast.success('Copied! Opening your messages...');
            window.location.href = `sms:?&body=${encodeURIComponent(content)}`;
        } else {
            toast.success('Copied! Paste into your text message to send.');
        }
    };

    const handleEmailShareWithContent = async (content: string) => {
        await navigator.clipboard.writeText(content);
        const subject = encodeURIComponent(`Support ${campaign?.name || 'our fundraiser'}!`);
        const body = encodeURIComponent(content);
        if (content.length < 1800) {
            toast.success('Copied! Paste into your email when it opens.');
            window.location.href = `mailto:?subject=${subject}&body=${body}`;
        } else {
            toast.success('Copied! Paste into your email.');
        }
    };

    const handleInstagramShareWithContent = async (content: string) => {
        await navigator.clipboard.writeText(content);
        toast.success('Copied! Paste into Instagram as your caption.');
    };

    const handleDownloadTracker = async () => {
        if (!campaign) {
            toast.error('Campaign not loaded yet. Please wait.');
            return;
        }
        try {
            // FR-COORD-SEC-1B: no credential in the URL, and none in the console.
            // The removed line here printed the live coordinator token into the
            // browser console, where a screen-share, a support session or a
            // browser extension would have captured it.
            const res = await fetch('/api/tracker/download');
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || `Download failed (${res.status})`);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'order-tracker.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            trackAction('download_tracker');
        } catch (err: any) {
            console.error('Download tracker error:', err);
            toast.error(err.message || 'Failed to download tracker');
        }
    };

    const handleDownloadPickupSheet = async () => {
        if (!campaign) {
            toast.error('Campaign not loaded yet. Please wait.');
            return;
        }
        try {
            const res = await fetch('/api/tracker/pickup-sheet');
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error || `Download failed (${res.status})`);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'pickup-sheet.xlsx';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            trackAction('download_pickup_sheet');
        } catch (err: any) {
            console.error('Download pickup sheet error:', err);
            toast.error(err.message || 'Failed to download pickup sheet');
        }
    };

    // State for selected items in manual order
    const [selectedItems, setSelectedItems] = useState<any[]>([]);

    const toggleItem = (bundle: any) => {
        const exists = selectedItems.find(i => i.id === bundle.id);
        if (exists) {
            setSelectedItems(selectedItems.filter(i => i.id !== bundle.id));
        } else {
            setSelectedItems([...selectedItems, { ...bundle, quantity: 1 }]);
        }
    };

    const updateQty = (id: string, delta: number) => {
        setSelectedItems(selectedItems.map(i =>
            i.id === id ? { ...i, quantity: Math.max(1, i.quantity + delta) } : i
        ));
    };

    // Auto-calculate total
    useEffect(() => {
        const total = selectedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        if (total > 0) {
            setFormData(prev => ({ ...prev, totalAmount: total.toString() }));
        }
    }, [selectedItems]);

    const handleAddOrder = async (e: React.FormEvent) => {
        e.preventDefault();
        if (selectedItems.length === 0) {
            toast.error("Please select at least one bundle");
            return;
        }
        setIsSubmitting(true);
        try {
            const res = await fetch('/api/coordinator', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...formData,
                    totalAmount: parseFloat(formData.totalAmount),
                    items: selectedItems.map(i => ({
                        bundleId: i.id,
                        quantity: i.quantity,
                        serving_tier: i.serving_tier || 'family',
                        name: i.name,
                        price: i.price
                    }))
                })
            });

            if (res.ok) {
                toast.success("Order recorded and goal updated!");
                setShowOrderModal(false);
                setFormData({ customerName: '', participantName: '', email: '', phone: '', totalAmount: '', deliveryAddress: '' });
                setSelectedItems([]);
                fetchCampaign(); // Refresh data
            } else {
                const errBody = await res.json().catch(() => null);
                console.error('Save order failed:', res.status, errBody);
                toast.error(errBody?.error || `Failed to save order (${res.status})`);
            }
        } catch (err: any) {
            console.error("Failed to add order", err);
            toast.error(err?.message || "Network error — please try again");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isLoading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50">
                <Loader2 className="animate-spin text-indigo-600" size={48} />
            </div>
        );
    }



    if (!campaign) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
                <div className="text-center space-y-4">
                    <AlertCircle className="mx-auto text-red-500" size={48} />
                    <h1 className="text-2xl font-black">Portal Not Found</h1>
                    <p className="text-slate-500">This link may be expired or incorrect.</p>
                </div>
            </div>
        );
    }

    const metrics = computeFundraiserProgress(campaign.bundle_goal, campaign.total_sales, campaign.orders || []);
    const progress = metrics.progressPercent;
    const totalBundlesSold = metrics.totalBundlesSold;
    const bundleGoal = metrics.bundleGoal;

    // Days remaining (negative = campaign ended)
    const daysRemaining = campaign.end_date
        ? Math.ceil((new Date(campaign.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null;

    // ── Phase 7E-4: Server-authoritative closed state ──────────────────────
    // Derived from the closeout endpoint fields (Phase 7E-2). Takes priority
    // over all date-based phase logic so a tenant-closed campaign is always
    // shown as complete regardless of its end_date.
    const isClosed: boolean =
        Boolean(campaign.closed_at) ||
        campaign.status === 'Closed' ||
        campaign.status === 'Settled';

    // Read-only settlement total (Decimal from DB → number, may be null/0)
    const settlementTotal: number | null =
        campaign.settlement_total != null
            ? Number(campaign.settlement_total)
            : null;

    // Campaign phase — drives conditional rendering across the panel
    type CampaignPhase = 'setup' | 'launch' | 'push' | 'lastDay' | 'complete';
    const campaignPhase: CampaignPhase = (() => {
        // Server closeout always wins — ignore date math for closed campaigns
        if (isClosed) return 'complete';
        if (daysRemaining !== null && daysRemaining < 0) return 'complete';
        if (daysRemaining === 0) return 'lastDay';
        if (daysRemaining !== null && daysRemaining <= 7) return 'push';
        if ((campaign.orders || []).length === 0) return 'setup';
        return 'launch';
    })();

    // Daily pace: bundles needed per day to hit goal
    const bundlesPerDay = (daysRemaining !== null && daysRemaining > 0 && totalBundlesSold < bundleGoal)
        ? ((bundleGoal - totalBundlesSold) / daysRemaining)
        : null;

    // Dynamic coaching tip — now time-aware
    const getCoachingTip = () => {
        if (campaignPhase === 'complete') {
            return progress >= 100
                ? { emoji: '🏆', text: `You crushed it! ${formatBundleCount(totalBundlesSold)} bundles sold.` }
                : { emoji: '🎉', text: `Great effort! You sold ${formatBundleCount(totalBundlesSold)} of ${bundleGoal} bundles.` };
        }
        if (totalBundlesSold === 0) return { emoji: '💡', text: 'Share your link with 5 people to get your first order.' };
        if (bundlesPerDay !== null && bundlesPerDay > 5) return { emoji: '🔥', text: `You need ~${Math.ceil(bundlesPerDay)} bundles/day. Send a group text NOW!` };
        if (totalBundlesSold >= 0.75 * bundleGoal) return { emoji: '🎉', text: 'Almost there! One more push can hit your goal!' };
        if (bundlesPerDay !== null) return { emoji: '📈', text: `~${Math.ceil(bundlesPerDay)} bundles/day will hit your goal. Share again today!` };
        return { emoji: '📈', text: 'Great progress — keep sharing to grow your sales!' };
    };
    const coachingTip = getCoachingTip();





    // Derive setup-checklist state
    const hasPaymentInfo = !!(campaign.payment_instructions || campaign.external_payment_link);
    const activeOrders = (campaign.orders || []);
    const hasFirstOrder = activeOrders.length > 0;
    const hasSharedOnce = (actionSummary?.totalActions || 0) > 0;

    // Tenant name for ActionBar closed state
    const tenantName = campaign.customer?.business?.name || null;

    // Derive share URLs and asset hrefs for ShareCenter
    const shareUrl = getShopOrderUrl();
    const scoreboardUrl = getScoreboardUrl();
    const qrAsset = campaignAssets.find(a => a.key === 'qr' && a.available);
    const flyerAsset = campaignAssets.find(a => a.key === 'flyer' && a.available);

    // Coordinator first name for setup checklist
    const coordinatorFirstName = campaign?.customer?.contact_name?.split(" ")[0] || undefined;

    // Delivery date label for DeliveryPrep / WhatsNext
    const deliveryDateLabel = campaign.delivery_date
        ? format(new Date(campaign.delivery_date), 'MMMM d')
        : undefined;

    // Org label for ProgressHero
    const orgLabel = campaign.customer?.name || 'your group';

    return (
        <div className="min-h-screen bg-slate-50">
            <Toaster position="top-center" toastOptions={{ duration: 4000 }} />
            {/* Nav */}
            <div className="bg-white/70 backdrop-blur-xl border-b border-white/20 px-6 py-4 sticky top-0 z-10 shadow-sm">
                <div className="max-w-xl mx-auto flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
                            <Target size={16} />
                        </div>
                        <span className="font-black tracking-tight text-lg">Coordinator Portal</span>
                    </div>
                    <button
                        onClick={() => setShowSettingsModal(true)}
                        className="p-2 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-all"
                        title="Payment Settings"
                    >
                        <Settings size={20} />
                    </button>
                </div>
            </div>

            {/* Confetti on Goal Met */}
            {progress >= 100 && campaignPhase !== 'complete' && (
                <Confetti
                    width={width}
                    height={height}
                    recycle={false}
                    numberOfPieces={400}
                    gravity={0.15}
                    colors={['#4f46e5', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6']}
                    className="z-50 pointer-events-none fixed top-0 left-0"
                />
            )}

            <main className="max-w-xl mx-auto px-4 sm:px-6 py-4 pb-24 space-y-4">
                {/* ═══════════════════════════════════════════════
                    CB-3: BUNDLE SELECTION STEP
                    Shown before phase content when selection is required.
                    Legacy (not_required) campaigns: component calls onSelectionComplete()
                    immediately and renders null, so nothing changes for them.
                ═══════════════════════════════════════════════ */}
                <BundleSelectionStep
                    onSelectionComplete={handleBundleSelectionComplete}
                />

                {/* Phase content deferred until selection is confirmed.
                    CB-3 provides UX deferral only — CB-5 adds the server-side order gate. */}
                {bundleSelectionDone && (<>
                {/* Business Logo */}
                {campaign.customer?.business?.logo_url && (
                    <div className="flex flex-col items-center justify-center pt-1 mb-0">
                        <img
                            src={campaign.customer.business.logo_url}
                            alt={campaign.customer.business.name || 'Business Logo'}
                            className="max-h-[48px] max-w-[180px] object-contain"
                        />
                    </div>
                )}

                {/* Phase Banners — exact Fable spec */}
                {(campaignPhase === 'push' || campaignPhase === 'lastDay') && (
                    <div className="rounded-xl bg-amber-50 px-4 py-2.5 text-[13px] font-semibold text-amber-800">
                        {campaignPhase === 'lastDay' ? '🔥 Last day — finish strong!' : `🔥 ${daysRemaining} days left — one more push!`}
                    </div>
                )}
                {/* Phase 7E-4: Closed-state banner — shown when server has closed the campaign */}
                {isClosed && (
                    <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 space-y-0.5">
                        <p className="text-[13px] font-black text-amber-900">🔒 Campaign Closed</p>
                        <p className="text-xs text-amber-800 font-medium leading-relaxed">
                            Orders have been sent to the kitchen. Contact {tenantName || 'the organizer'} for any late changes.
                            No more order edits can be made from this portal.
                        </p>
                        {settlementTotal !== null && settlementTotal > 0 && (
                            <p className="text-xs font-black text-amber-900 pt-0.5">
                                Final campaign total: ${settlementTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </p>
                        )}
                    </div>
                )}
                {!isClosed && campaignPhase === 'complete' && (
                    <div className="rounded-xl bg-emerald-50 px-4 py-2.5 text-[13px] font-semibold text-emerald-800">
                        🏆 Campaign complete{progress >= 100 ? ' — you beat your goal!' : ' — great work!'}
                    </div>
                )}

                {/* ═══════════════════════════════════════════════
                    PHASE: SETUP
                ═══════════════════════════════════════════════ */}
                {campaignPhase === 'setup' && (<>
                    <SetupChecklist
                        coordinatorFirstName={coordinatorFirstName}
                        hasPaymentInfo={hasPaymentInfo}
                        hasSharedOnce={hasSharedOnce}
                        hasFirstOrder={hasFirstOrder}
                        onSetPayment={() => setShowSettingsModal(true)}
                        onShare={() => document.getElementById('share-center')?.scrollIntoView({ behavior: 'smooth' })}
                        onAddOrder={() => setShowOrderModal(true)}
                        orderingAllowed={campaign.orderMode?.allowed === true}
                    />
                    <ProgressHero
                        dimmed
                        sold={totalBundlesSold}
                        goal={bundleGoal}
                        progress={progress}
                        totalSales={metrics.totalSales}
                        orderCount={activeOrders.length}
                        daysRemaining={daysRemaining}
                        orgLabel={orgLabel}
                    />
                    <ShareCenter
                        shareUrl={shareUrl}
                        onCopy={handleCopy}
                        copied={copied}
                        qrHref={qrAsset?.url}
                        flyerHref={flyerAsset?.url}
                        scoreboardHref={scoreboardUrl}
                    />
                </>)}

                {/* ═══════════════════════════════════════════════
                    PHASE: LAUNCH
                ═══════════════════════════════════════════════ */}
                {campaignPhase === 'launch' && (<>
                    <ProgressHero
                        sold={totalBundlesSold}
                        goal={bundleGoal}
                        progress={progress}
                        totalSales={metrics.totalSales}
                        orderCount={activeOrders.length}
                        daysRemaining={daysRemaining}
                        paceText={`${coachingTip.emoji} ${coachingTip.text}`}
                        orgLabel={orgLabel}
                    />
                    <ShareCenter
                        shareUrl={shareUrl}
                        onCopy={handleCopy}
                        copied={copied}
                        qrHref={qrAsset?.url}
                        flyerHref={flyerAsset?.url}
                        scoreboardHref={scoreboardUrl}
                        onOpenAi={() => setShowAiPanel(true)}
                        aiRemaining={aiRemaining}
                    />
                    <RecentOrders
                        orders={activeOrders}
                        onCancel={(id) => setCancelOrderId(id)}
                        onViewAll={() => setShowAllOrders(!showAllOrders)}
                        limit={showAllOrders ? 999 : 3}
                    />
                    <QuietLinks
                        guideHref={'/coordinator/portal/guide'}
                        onOpenDownloads={handleDownloadTracker}
                        activitySummary={actionSummary?.totalActions ? `${actionSummary.totalActions} actions` : undefined}
                    />
                </>)}

                {/* ═══════════════════════════════════════════════
                    PHASE: PUSH / LASTDAY
                ═══════════════════════════════════════════════ */}
                {(campaignPhase === 'push' || campaignPhase === 'lastDay') && (<>
                    <ProgressHero
                        hot
                        sold={totalBundlesSold}
                        goal={bundleGoal}
                        progress={progress}
                        totalSales={metrics.totalSales}
                        orderCount={activeOrders.length}
                        daysRemaining={daysRemaining}
                        paceText={`${coachingTip.emoji} ${coachingTip.text}`}
                        orgLabel={orgLabel}
                    />
                    <DeliveryPrep
                        deliveryDateLabel={deliveryDateLabel}
                        pickupLocation={campaign.pickup_location || undefined}
                        onDownloadPickupSheet={handleDownloadPickupSheet}
                    />
                    <ShareCenter
                        shareUrl={shareUrl}
                        onCopy={handleCopy}
                        copied={copied}
                        qrHref={qrAsset?.url}
                        flyerHref={flyerAsset?.url}
                        scoreboardHref={scoreboardUrl}
                        onOpenAi={() => setShowAiPanel(true)}
                        aiRemaining={aiRemaining}
                        aiLabel='✨ Write a "last chance" message'
                    />
                    <RecentOrders
                        orders={activeOrders}
                        onCancel={(id) => setCancelOrderId(id)}
                        onViewAll={() => setShowAllOrders(!showAllOrders)}
                        limit={showAllOrders ? 999 : 3}
                    />
                </>)}

                {/* ═══════════════════════════════════════════════
                    PHASE: COMPLETE
                ═══════════════════════════════════════════════ */}
                {campaignPhase === 'complete' && (<>
                    <ProgressHero
                        sold={totalBundlesSold}
                        goal={bundleGoal}
                        progress={progress}
                        totalSales={metrics.totalSales}
                        orderCount={activeOrders.length}
                        daysRemaining={daysRemaining}
                        paceText={`${coachingTip.emoji} ${coachingTip.text}`}
                        orgLabel={orgLabel}
                    />
                    <WhatsNext
                        tenantName={tenantName || 'Your fundraiser organizer'}
                        deliveryWindowLabel={deliveryDateLabel}
                        settlementTotal={settlementTotal ?? undefined}
                        isClosed={isClosed}
                    />
                    {/* Delivery Kit: pickup sheet + tracker downloads */}
                    <section className="bg-white border border-slate-200 rounded-2xl p-4">
                        <h3 className="text-base font-black text-slate-900 mb-2">Delivery kit</h3>
                        <div className="flex gap-2">
                            <button onClick={handleDownloadPickupSheet}
                                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-2 text-center text-xs font-semibold text-slate-700">
                                📦 Pickup sheet
                            </button>
                            <button onClick={handleDownloadTracker}
                                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-2 text-center text-xs font-semibold text-slate-700">
                                📥 Order tracker
                            </button>
                        </div>
                    </section>
                    {/* Phase 7E-4: read-only orders — cancel hidden when campaign is closed */}
                    <RecentOrders
                        orders={activeOrders}
                        onCancel={(id) => setCancelOrderId(id)}
                        onViewAll={() => setShowAllOrders(!showAllOrders)}
                        limit={showAllOrders ? 999 : 3}
                        isClosed={isClosed}
                    />
                </>)}
                </>)}
            </main>

            {/* ── Sticky Action Bar ── */}
            {/* CB-3: ActionBar deferred until bundle selection is confirmed. */}
            {/* Phase 7E-4: isClosed forces phase=complete so ActionBar shows read-only copy */}
            {bundleSelectionDone && (
                <ActionBar
                    phase={campaignPhase}
                    onAddOrder={() => { if (!isClosed) setShowOrderModal(true); }}
                    onShare={() => document.getElementById('share-center')?.scrollIntoView({ behavior: 'smooth' })}
                    tenantName={tenantName || undefined}
                    orderingAllowed={campaign.orderMode?.allowed === true}
                />
            )}

            {/* ══════════════════════════════════════════════════════════
                MODALS — unchanged internals, only triggers relocated
            ══════════════════════════════════════════════════════════ */}

            {/* Cancel Order Confirmation Modal — Phase 7E-4: hidden when campaign is closed */}
            {cancelOrderId && !isClosed && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center">
                                <Trash2 size={20} className="text-red-600" />
                            </div>
                            <h3 className="text-lg font-black text-slate-900">Cancel Order?</h3>
                        </div>
                        <p className="text-sm text-slate-500 font-medium leading-relaxed">
                            This will remove the order from your campaign totals, bundle counts, and delivery sheets. The order will not be permanently deleted.
                        </p>
                        <div className="flex gap-3 pt-2">
                            <button
                                onClick={() => setCancelOrderId(null)}
                                disabled={isCanceling}
                                className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-700 font-bold text-sm hover:bg-slate-50 transition-all"
                            >
                                Keep Order
                            </button>
                            <button
                                onClick={handleCancelOrder}
                                disabled={isCanceling}
                                className="flex-1 py-3 rounded-xl bg-red-600 text-white font-bold text-sm hover:bg-red-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {isCanceling ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
                                {isCanceling ? 'Canceling...' : 'Cancel Order'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Restore Order Confirmation Modal — Phase 7E-4: hidden when campaign is closed */}
            {restoreOrderId && !isClosed && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-white w-full max-w-sm rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
                                <RotateCcw size={20} className="text-emerald-600" />
                            </div>
                            <h3 className="text-lg font-black text-slate-900">Restore Order?</h3>
                        </div>
                        <p className="text-sm text-slate-500 font-medium leading-relaxed">
                            This will add the order back into your campaign totals, bundle counts, and delivery sheets.
                        </p>
                        <div className="flex gap-3 pt-2">
                            <button
                                onClick={() => setRestoreOrderId(null)}
                                disabled={isRestoring}
                                className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-700 font-bold text-sm hover:bg-slate-50 transition-all"
                            >
                                Never Mind
                            </button>
                            <button
                                onClick={handleRestoreOrder}
                                disabled={isRestoring}
                                className="flex-1 py-3 rounded-xl bg-emerald-600 text-white font-bold text-sm hover:bg-emerald-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {isRestoring ? <Loader2 className="animate-spin" size={16} /> : <RotateCcw size={16} />}
                                {isRestoring ? 'Restoring...' : 'Restore Order'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Order Modal — CB-3: also hidden until bundle selection is done. Phase 7E-4: cannot be opened when campaign is closed */}
            {showOrderModal && !isClosed && bundleSelectionDone && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-300 overflow-y-auto">
                    <div className="bg-white w-full max-w-lg rounded-t-2xl sm:rounded-2xl p-6 mt-10 shadow-2xl relative animate-in slide-in-from-bottom-10 duration-300">
                        <button
                            onClick={() => setShowOrderModal(false)}
                            className="absolute top-6 right-6 p-2 hover:bg-slate-100 rounded-full text-slate-400 transition-colors"
                        >
                            <X size={24} />
                        </button>

                        <div className="mb-6">
                            <h2 className="text-2xl font-black text-slate-900 flex items-center gap-3">
                                <div className="p-2 bg-indigo-100 text-indigo-600 rounded-xl">
                                    <Plus size={20} strokeWidth={3} />
                                </div>
                                Add Offline Order
                            </h2>
                            <p className="text-slate-500 font-medium mt-1">Record a sale from cash, Venmo, or check.</p>
                        </div>

                        <form onSubmit={handleAddOrder} className="space-y-6">
                            {/* Bundle Selection Section */}
                            <div className="space-y-3">
                                <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Select Items Sold</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {(campaign.availableBundles || []).map((bundle: any) => {
                                        const isSelected = selectedItems.find((i: any) => i.id === bundle.id);
                                        return (
                                            <div
                                                key={bundle.id}
                                                onClick={() => toggleItem(bundle)}
                                                className={`p-3 rounded-2xl border-2 transition-all cursor-pointer ${isSelected
                                                    ? 'border-indigo-600 bg-indigo-50/50 shadow-sm'
                                                    : 'border-slate-100 bg-slate-50 hover:border-slate-300'
                                                    }`}
                                            >
                                                <div className="flex justify-between items-start mb-1">
                                                    <p className="text-xs font-black truncate max-w-[80%]">{bundle.name}</p>
                                                    <span className="text-[10px] font-black opacity-40">${bundle.price}</span>
                                                </div>
                                                {isSelected && (
                                                    <div className="flex items-center gap-2 mt-2" onClick={(e: any) => e.stopPropagation()}>
                                                        <button
                                                            type="button"
                                                            onClick={() => updateQty(bundle.id, -1)}
                                                            className="w-7 h-7 rounded-lg bg-slate-200 text-slate-600 text-sm font-bold flex items-center justify-center"
                                                        >−</button>
                                                        <span className="text-sm font-black w-6 text-center">{isSelected.quantity}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => updateQty(bundle.id, 1)}
                                                            className="w-7 h-7 rounded-lg bg-indigo-100 text-indigo-600 text-sm font-bold flex items-center justify-center"
                                                        >+</button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Order total display */}
                            {selectedItems.length > 0 && (
                                <div className="bg-indigo-50/50 rounded-2xl p-4 border border-indigo-100">
                                    <div className="flex justify-between items-center">
                                        <span className="text-sm font-bold text-slate-600">
                                            {selectedItems.reduce((sum: number, i: any) => sum + i.quantity, 0)} items selected
                                        </span>
                                        <span className="text-xl font-black text-indigo-600">
                                            ${selectedItems.reduce((sum: number, i: any) => sum + (i.price * i.quantity), 0).toFixed(2)}
                                        </span>
                                    </div>
                                </div>
                            )}

                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Buyer Name</label>
                                    <div className="relative">
                                        <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                        <input
                                            required
                                            placeholder="Jane Smith"
                                            className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                            value={formData.customerName}
                                            onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                                        />
                                    </div>
                                </div>

                                {/* Participant Name (for Leaderboard) */}
                                {campaign.participant_label && (
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">{campaign.participant_label} Name</label>
                                        <div className="relative">
                                            <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                            <input
                                                placeholder={`Which ${campaign.participant_label?.toLowerCase() || 'participant'}?`}
                                                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                                value={formData.participantName}
                                                onChange={(e) => setFormData({ ...formData, participantName: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Total Amount</label>
                                        <div className="relative">
                                            <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                            <input
                                                required
                                                type="number"
                                                placeholder="45.00"
                                                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                                value={formData.totalAmount}
                                                onChange={(e) => setFormData({ ...formData, totalAmount: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Phone (Optional)</label>
                                        <div className="relative">
                                            <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                            <input
                                                type="tel"
                                                placeholder="555-0123"
                                                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                                value={formData.phone}
                                                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="space-y-1">
                                    <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Note / Address (Optional)</label>
                                    <div className="relative">
                                        <MapPin className="absolute left-4 top-4 text-slate-400" size={18} />
                                        <textarea
                                            rows={2}
                                            placeholder="Delivery to Room 24..."
                                            className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold resize-none"
                                            value={formData.deliveryAddress}
                                            onChange={(e) => setFormData({ ...formData, deliveryAddress: e.target.value })}
                                        />
                                    </div>
                                </div>

                                <button
                                    disabled={isSubmitting}
                                    type="submit"
                                    className="w-full bg-slate-900 text-white py-5 rounded-3xl font-black text-lg shadow-xl shadow-slate-900/10 hover:bg-black transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {isSubmitting ? <Loader2 className="animate-spin" size={24} /> : 'Save Order & Update Goal'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* AI Content Generator Modal */}
            {showAiPanel && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="bg-indigo-600 w-full max-w-md rounded-2xl p-5 shadow-2xl animate-in zoom-in-95 duration-200 text-white space-y-4 max-h-[85vh] overflow-y-auto">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="w-8 h-8 bg-indigo-400 rounded-xl flex items-center justify-center text-white shadow-lg">✨</div>
                                <div>
                                    <h3 className="font-bold text-sm">AI Content Generator</h3>
                                    <p className="text-indigo-200 text-[10px] font-bold uppercase tracking-widest">Powered by Google Gemini</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-3">
                                {aiRemaining !== null && (
                                    <p className="text-[10px] font-black text-indigo-200 uppercase tracking-widest">
                                        {aiRemaining} of 40 left
                                    </p>
                                )}
                                <button onClick={() => setShowAiPanel(false)} className="text-indigo-200 hover:text-white">
                                    <X size={20} />
                                </button>
                            </div>
                        </div>

                        <p className="text-xs text-indigo-100 leading-relaxed font-medium">
                            Generate custom promo copy for any channel — instantly! Your fundraiser details are included automatically.
                        </p>

                        <div className="grid grid-cols-2 gap-2">
                            {[
                                { channel: 'facebook', label: '📘 Facebook', sub: 'Generate for Facebook' },
                                { channel: 'text', label: '💬 Text / SMS', sub: 'Generate for Text' },
                                { channel: 'email', label: '📧 Email', sub: 'Generate for Email' },
                                { channel: 'instagram', label: '📸 Instagram', sub: 'Generate for Instagram' }
                            ].map(({ channel, label, sub }) => (
                                <button
                                    key={channel}
                                    onClick={() => handleAiGenerate(channel)}
                                    disabled={isAiGenerating || aiRemaining === 0}
                                    className={`p-3 rounded-xl border text-left transition-all ${
                                        aiRemaining === 0
                                            ? 'bg-white/5 border-white/10 opacity-50 cursor-not-allowed'
                                            : 'bg-white/5 border-white/10 hover:bg-white/15 hover:border-indigo-300/50 cursor-pointer active:scale-95'
                                    }`}
                                >
                                    <p className="text-xs font-black">{label}</p>
                                    <p className="text-[10px] text-indigo-200 mt-0.5">
                                        {isAiGenerating && aiChannel === channel ? 'Generating...' : sub}
                                    </p>
                                </button>
                            ))}
                        </div>

                        {aiRemaining === 0 && (
                            <p className="text-center text-xs font-bold text-indigo-200 bg-white/5 rounded-xl p-3">
                                ✅ You&apos;ve used all 40 AI generations!
                            </p>
                        )}

                        {isAiGenerating && (
                            <div className="flex items-center justify-center gap-3 py-4">
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <p className="text-xs font-bold text-indigo-100 animate-pulse">Creating your {aiChannel} content...</p>
                            </div>
                        )}

                        {aiContent && !isAiGenerating && (
                            <div className="bg-indigo-900/40 rounded-2xl p-4 border border-indigo-400/30 space-y-3">
                                <div className="flex items-center justify-between">
                                    <p className="text-[10px] font-black text-indigo-300 uppercase tracking-widest">
                                        {aiChannel ? `${aiChannel.charAt(0).toUpperCase() + aiChannel.slice(1)} Message` : 'Generated Content'}
                                    </p>
                                    <CopyButton text={aiContent} label="Message Copied!" />
                                </div>
                                <textarea
                                    value={aiContent}
                                    onChange={(e) => setAiContent(e.target.value)}
                                    rows={4}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-xs text-white font-medium resize-y focus:outline-none focus:ring-2 focus:ring-indigo-400/50"
                                />
                                <button
                                    onClick={() => {
                                        if (aiChannel === 'facebook') { handleFacebookShareWithContent(aiContent); }
                                        else if (aiChannel === 'text') { handleSmsShareWithContent(aiContent); }
                                        else if (aiChannel === 'email') { handleEmailShareWithContent(aiContent); }
                                        else if (aiChannel === 'instagram') { handleInstagramShareWithContent(aiContent); }
                                        else { navigator.clipboard.writeText(aiContent); toast.success('Message copied!'); }
                                    }}
                                    className="w-full bg-white/10 hover:bg-white/20 text-white text-xs font-bold py-2.5 px-4 rounded-xl transition-all active:scale-95 flex items-center justify-center gap-2"
                                >
                                    {aiChannel === 'facebook' && '📋 Copy & Open Facebook'}
                                    {aiChannel === 'text' && '📋 Copy & Send Text'}
                                    {aiChannel === 'email' && '📋 Copy & Open Email'}
                                    {aiChannel === 'instagram' && '📋 Copy Caption'}
                                    {!['facebook', 'text', 'email', 'instagram'].includes(aiChannel) && '📋 Copy Message'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Settings Modal */}
            <SettingsModal
                isOpen={showSettingsModal}
                onClose={() => setShowSettingsModal(false)}
                initialData={{
                    paymentInstructions: campaign?.payment_instructions,
                    externalPaymentLink: campaign?.external_payment_link
                }}
            />
        </div>
    );
}

function SettingsModal({ isOpen, onClose, initialData }: { isOpen: boolean; onClose: () => void; initialData: any }) {
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        paymentInstructions: initialData.paymentInstructions || '',
        externalPaymentLink: initialData.externalPaymentLink || ''
    });

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/coordinator', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (!res.ok) throw new Error('Failed to update settings');

            toast.success('Settings updated!');
            onClose();
            window.location.reload();
        } catch (e) {
            toast.error('Failed to save settings');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl p-6 animate-in zoom-in-95">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-black">Payment Settings</h2>
                    <button onClick={onClose}><X className="text-slate-400" /></button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5 ml-1">External Payment Link</label>
                        <input
                            className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-500"
                            placeholder="https://venmo.com/..."
                            value={formData.externalPaymentLink}
                            onChange={e => setFormData({ ...formData, externalPaymentLink: e.target.value })}
                        />
                        <p className="text-xs text-slate-400 mt-1 ml-1">E.g., Venmo, PayPal, or School Portal link.</p>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-1.5 ml-1">Payment Instructions</label>
                        <textarea
                            className="w-full px-4 py-3 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-500 min-h-[100px]"
                            placeholder="Please send checks payable to..."
                            value={formData.paymentInstructions}
                            onChange={e => setFormData({ ...formData, paymentInstructions: e.target.value })}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-70"
                    >
                        {loading ? <Loader2 className="animate-spin mx-auto" /> : 'Save Changes'}
                    </button>
                </form>
            </div>
        </div>
    );
}
