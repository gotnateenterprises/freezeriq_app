"use client";

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import type { CampaignAsset } from '@/lib/campaignAssets';
import type { PromoScriptsResponse } from '@/lib/generatePromoScripts';
import { computeFundraiserProgress, formatBundleCount } from '@/lib/fundraiserMetrics';
import { Instagram } from 'lucide-react';

import {
    Plus,
    TrendingUp,
    Target,
    Calendar,
    Users,
    Share2,
    Link as LinkIcon,
    Copy,
    CheckCircle2,
    Facebook,
    ArrowRight,
    Loader2,
    DollarSign,
    Package,
    User,
    Mail,
    Phone,
    MapPin,
    AlertCircle,
    X,
    Star,
    Settings,
    Smartphone,
    Download,
    MessageSquare,
    FileText,
    Clock,
    Rocket,
    Eye,
    Globe,
    ExternalLink,
    Activity
} from 'lucide-react';
import type { CoordinatorActionSummary } from '@/app/api/coordinator-actions/[token]/summary/route';
import { format } from 'date-fns';
import Link from 'next/link';
import { motion } from 'framer-motion';

import { useParams } from 'next/navigation';
import UpgradeRequired from '@/components/UpgradeRequired';
import MarketingAssetGenerator from '@/components/marketing/MarketingAssetGenerator';
import CopyButton from '@/components/coordinator/CopyButton';

import Leaderboard from '@/components/coordinator/Leaderboard';
import Confetti from 'react-confetti';
import { useWindowSize } from 'react-use';

export default function CoordinatorPortal() {
    const { width, height } = useWindowSize();
    const params = useParams();
    const token = params.token as string;
    const [campaign, setCampaign] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [showOrderModal, setShowOrderModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [copied, setCopied] = useState(false);
    const [copiedFb, setCopiedFb] = useState(false);
    const [copiedText, setCopiedText] = useState(false);
    const [campaignAssets, setCampaignAssets] = useState<CampaignAsset[]>([]);
    const [promoScripts, setPromoScripts] = useState<PromoScriptsResponse | null>(null);
    const [copiedEmail, setCopiedEmail] = useState(false);
    const [copiedScoreboard, setCopiedScoreboard] = useState(false);
    const [actionSummary, setActionSummary] = useState<CoordinatorActionSummary | null>(null);

    // ── AI Content Generator state ──
    const [isAiGenerating, setIsAiGenerating] = useState(false);
    const [aiContent, setAiContent] = useState('');
    const [aiChannel, setAiChannel] = useState('');
    const [aiRemaining, setAiRemaining] = useState<number | null>(null);

    const handleAiGenerate = async (channel: string) => {
        setIsAiGenerating(true);
        setAiChannel(channel);
        try {
            const res = await fetch(`/api/coordinator/${token}/generate`, {
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
                token,
                action_type,
                source: isMobile ? 'mobile' : 'desktop',
            }),
        })
            .then(() => {
                // Refresh summary after successful log
                fetch(`/api/coordinator-actions/${token}/summary`)
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

    const [hasAccess, setHasAccess] = useState(true);

    useEffect(() => {
        fetchCampaign();
    }, [token]);

    const fetchCampaign = async () => {
        if (!token) return;

        // Access is validated server-side by the /api/coordinator/[token] route
        // via portal_token lookup. No client-side plan gating needed — coordinators
        // are external users who access via private links (CONSTITUTION §15).

        try {
            const res = await fetch(`/api/coordinator/${token}`);
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
            fetch(`/api/campaign-assets/${token}`)
                .then(r => r.ok ? r.json() : null)
                .then(assets => {
                    if (assets?.assets) setCampaignAssets(assets.assets);
                })
                .catch(() => { /* asset fetch failure is non-blocking */ });

            // Fetch promo scripts (fail-safe – does not block portal)
            fetch(`/api/promo-scripts/${token}`)
                .then(r => r.ok ? r.json() : null)
                .then(scripts => {
                    if (scripts?.scripts) setPromoScripts(scripts);
                })
                .catch(() => { /* promo script fetch failure is non-blocking */ });

            // Fetch action summary (fail-safe)
            fetch(`/api/coordinator-actions/${token}/summary`)
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

    const handleCopyScoreboard = () => {
        const url = getScoreboardUrl();
        navigator.clipboard.writeText(url);
        setCopiedScoreboard(true);
        toast.success('Scoreboard link copied!');
        setTimeout(() => setCopiedScoreboard(false), 2000);
    };

    const handleCopyTextMessage = () => {
        if (!promoScripts?.scripts?.textMessage) {
            toast.error('Promo scripts are still loading. Try again in a moment.');
            return;
        }
        navigator.clipboard.writeText(promoScripts.scripts.textMessage);
        setCopiedText(true);
        toast.success('Text message copied!');
        trackAction('copy_text_message');
        setTimeout(() => setCopiedText(false), 2000);
    };

    const handleCopyFacebookPost = () => {
        if (!promoScripts?.scripts?.facebook) {
            toast.error('Promo scripts are still loading. Try again in a moment.');
            return;
        }
        navigator.clipboard.writeText(promoScripts.scripts.facebook);
        setCopiedFb(true);
        toast.success('Facebook post copied!');
        trackAction('copy_facebook_post');
        setTimeout(() => setCopiedFb(false), 2000);
    };

    const handleCopyEmailBlurb = () => {
        if (!promoScripts?.scripts?.emailBlurb) {
            toast.error('Promo scripts are still loading. Try again in a moment.');
            return;
        }
        navigator.clipboard.writeText(promoScripts.scripts.emailBlurb);
        setCopiedEmail(true);
        toast.success('Email blurb copied!');
        trackAction('copy_email_blurb');
        setTimeout(() => setCopiedEmail(false), 2000);
    };

    // ── Smart Share Handlers ───────────────────────────────

    const getPublicUrl = () => {
        // Prefer shop order page URL (drives sales)
        return getShopOrderUrl();
    };

    const handleShareUniversal = async () => {
        const url = getPublicUrl();
        const text = promoScripts?.scripts?.textMessage || `Check out this fundraiser! ${url}`;
        if (typeof navigator !== 'undefined' && navigator.share) {
            try {
                await navigator.share({
                    title: campaign?.customer?.name || campaign?.name || 'Fundraiser',
                    text,
                    url,
                });
            } catch (err: any) {
                // User cancelled — do nothing
                if (err?.name === 'AbortError') return;
                // Fallback: copy
                await navigator.clipboard.writeText(`${text}\n\n${url}`);
                toast.success('Message & link copied to clipboard!');
            }
        } else {
            await navigator.clipboard.writeText(`${text}\n\n${url}`);
            toast.success('Message & link copied — paste anywhere!');
        }
        trackAction('share_fundraiser');
    };

    const handleSmsShare = () => {
        const url = getPublicUrl();
        const text = promoScripts?.scripts?.textMessage || `Check out this fundraiser!`;
        const body = `${text}\n\n${url}`;
        // Mobile: open SMS app. Desktop: copy to clipboard.
        const isMobile = typeof navigator !== 'undefined' &&
            /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (isMobile) {
            window.location.href = `sms:?&body=${encodeURIComponent(body)}`;
        } else {
            navigator.clipboard.writeText(body);
            toast.success('Text copied — paste into your messages!');
        }
        trackAction('send_text_blast');
    };

    const handleFacebookShare = async () => {
        const url = getPublicUrl();
        const fbText = promoScripts?.scripts?.facebook;
        if (fbText) {
            await navigator.clipboard.writeText(fbText);
            toast.success('Copied! Paste into Facebook when it opens.');
        }
        window.open(
            `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
            '_blank',
            'width=600,height=400'
        );
        trackAction('share_facebook');
    };

    const handleEmailShare = async () => {
        const url = getPublicUrl();
        const emailText = promoScripts?.scripts?.emailBlurb;
        const fullMessage = emailText || `Check out this fundraiser!\n\nOrder here:\n${url}`;
        await navigator.clipboard.writeText(fullMessage);
        const subject = encodeURIComponent(`Support ${campaign?.name || 'our fundraiser'}!`);
        const body = encodeURIComponent(fullMessage);
        if (fullMessage.length < 1800) {
            toast.success('Copied! Paste into your email when it opens.');
            window.location.href = `mailto:?subject=${subject}&body=${body}`;
        } else {
            toast.success('Copied! Paste into your email.');
        }
        trackAction('share_email');
    };

    const handleInstagramShare = async () => {
        const url = getPublicUrl();
        const igText = promoScripts?.scripts?.textMessage || `Support our fundraiser! Link in bio: ${url}`;
        await navigator.clipboard.writeText(igText);
        toast.success('Copied! Paste into Instagram as your caption.');
        trackAction('share_instagram');
    };

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
        if (!token || !campaign) {
            toast.error('Campaign not loaded yet. Please wait.');
            return;
        }
        try {
            // Use the campaign's own portal_token (from loaded data) to guarantee match
            const downloadToken = campaign.portal_token || token;
            console.log('[Tracker] downloading with token:', downloadToken);
            const res = await fetch(`/api/tracker/download?token=${downloadToken}`);
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
            const res = await fetch(`/api/coordinator/${token}`, {
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
                toast.error("Failed to save order");
            }
        } catch (err) {
            console.error("Failed to add order", err);
            toast.error("An error occurred");
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

    if (!hasAccess) {
        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
                <UpgradeRequired
                    feature="Coordinator Portal"
                    description="Provide your organization leads with a private dashboard to track their sales, goals, and team performance."
                />
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

    // Days remaining
    const daysRemaining = campaign.end_date
        ? Math.max(0, Math.ceil((new Date(campaign.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null;

    // Dynamic coaching tip
    const getCoachingTip = () => {
        if (totalBundlesSold === 0) return { emoji: '💡', text: 'Share your link with 5 people to get your first order.' };
        if (totalBundlesSold < 0.5 * bundleGoal) return { emoji: '🔥', text: "You're gaining momentum! Share again today to keep it going." };
        if (totalBundlesSold >= 0.75 * bundleGoal) return { emoji: '🎉', text: 'Almost there! One more push can hit your goal!' };
        return { emoji: '📈', text: 'Great progress — keep sharing to grow your sales!' };
    };
    const coachingTip = getCoachingTip();



    return (
        <div className="min-h-screen bg-slate-50 pb-20">
            {/* Nav: Premium Glassmorphism */}
            <div className="bg-white/70 backdrop-blur-xl border-b border-white/20 px-6 py-4 sticky top-0 z-10 shadow-sm">
                <div className="max-w-xl mx-auto flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white">
                            <Target size={16} />
                        </div>
                        <span className="font-black tracking-tight text-lg">Coordinator Portal</span>
                    </div>
                </div>
            </div>

            {/* Gamification: Confetti on Goal Met */}
            {progress >= 100 && (
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

            <main className="max-w-xl mx-auto px-4 sm:px-6 py-4 space-y-5">
                {/* Tenant/Business Logo */}
                {campaign.customer?.business?.logo_url && (
                    <div className="flex flex-col items-center justify-center pt-1 mb-0">
                        <img
                            src={campaign.customer.business.logo_url}
                            alt={campaign.customer.business.name || 'Business Logo'}
                            className="max-h-[48px] max-w-[180px] object-contain"
                        />
                    </div>
                )}

                {/* Personalized Header */}
                <div className="mb-1">
                    <p className="text-sm text-slate-500 font-medium mb-0.5">
                        Hey {campaign?.customer?.contact_name?.split(" ")[0] || "there"} 👋
                    </p>
                    <h1 className="text-xl md:text-2xl font-bold text-slate-900 leading-tight">
                        Here&apos;s your Coordinator Panel
                    </h1>
                </div>

                {/* Scoreboard Card */}
                {/* ── SECTION: Start Here ── */}
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1">📍 Start Here</p>

                <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-md shadow-indigo-500/5 border border-slate-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-50 rounded-full -translate-y-10 translate-x-10 opacity-40" />

                    <div className="relative">
                        <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-1">Live Progress</p>
                        <h2 className="text-xl sm:text-2xl font-black text-slate-900 mb-4 leading-tight">{campaign.name}</h2>

                        <div className="flex justify-between items-end mb-2">
                            <div>
                                <p className="text-3xl sm:text-4xl font-black text-slate-900">{formatBundleCount(totalBundlesSold)}</p>
                                <p className="text-xs font-bold text-slate-400">Bundles Sold</p>
                            </div>
                            <div className="text-right">
                                <p className="text-base font-black text-slate-300">{bundleGoal} goal</p>
                            </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden mb-1">
                            <motion.div
                                className="h-full bg-indigo-600 rounded-full"
                                initial={{ width: 0 }}
                                animate={{ width: `${progress}%` }}
                                transition={{ type: 'spring', bounce: 0.25, duration: 1.5, delay: 0.2 }}
                            />
                        </div>
                        <p className="text-right text-[10px] font-bold text-indigo-500">
                            {progress.toFixed(0)}%
                        </p>

                        {/* Estimated Earnings */}
                        {metrics.estimatedEarnings > 0 && (
                            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-1.5">
                                <p className="text-sm font-bold text-slate-500">
                                    💰 You&apos;ve earned: <span className="text-emerald-600 font-black">${metrics.estimatedEarnings.toFixed(2)}</span> so far
                                </p>
                            </div>
                        )}

                        {/* Progressive Coaching Tips */}
                        <div className="mt-3 bg-indigo-50 rounded-xl p-2.5 space-y-0.5">
                            {(() => {
                                const actions = actionSummary?.totalActions || 0;
                                if (progress >= 100) return (
                                    <>
                                        <p className="text-sm font-bold text-indigo-700">🎉 Goal reached!</p>
                                        <p className="text-sm font-medium text-indigo-600">Keep sharing — every extra order counts toward your fundraiser.</p>
                                    </>
                                );
                                if (totalBundlesSold >= 0.5 * bundleGoal) return (
                                    <>
                                        <p className="text-sm font-bold text-indigo-700">🔥 Almost there!</p>
                                        <p className="text-sm font-medium text-indigo-600">One more push to hit your goal — share again today.</p>
                                    </>
                                );
                                if (totalBundlesSold >= 1) return (
                                    <>
                                        <p className="text-sm font-bold text-indigo-700">📈 Step 3: Great start!</p>
                                        <p className="text-sm font-medium text-indigo-600">Most sales come from 3+ touches — share your link again today.</p>
                                    </>
                                );
                                if (totalBundlesSold === 0 && actions > 0) return (
                                    <>
                                        <p className="text-sm font-bold text-indigo-700">📣 Step 2: Expand your reach</p>
                                        <p className="text-sm font-medium text-indigo-600">Post to Facebook or send a group text to get your first order.</p>
                                    </>
                                );
                                return (
                                    <>
                                        <p className="text-sm font-bold text-indigo-700">🚀 Step 1: Share your fundraiser</p>
                                        <p className="text-sm font-medium text-indigo-600">Send your link to 5 family members or friends to get started.</p>
                                    </>
                                );
                            })()}
                        </div>

                        {/* Days Remaining */}
                        {daysRemaining !== null && (
                            <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-slate-400">
                                <Clock size={14} />
                                <span>
                                    {daysRemaining === 0
                                        ? '⏰ Last day — make it count!'
                                        : `⏳ ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} left — now is the time to push!`}
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Leaderboard - Only show if name collection is enabled */}
                {campaign.participant_label && (
                    <Leaderboard
                        orders={campaign.orders || []}
                        participantLabel={campaign.participant_label}
                    />
                )}

                {/* ── SECTION: Share & Promote ── */}
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1">📣 Share & Promote</p>

                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    <h2 className="text-base font-black flex items-center gap-2">
                        <Rocket size={18} className="text-indigo-600" />
                        Quick Actions
                    </h2>

                    {/* ── 📢 Share Online ── */}
                    <div className="space-y-3">
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">📢 Share Online</p>
                        <button
                            onClick={handleShareUniversal}
                            className="w-full bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white p-5 rounded-2xl font-black text-base flex items-center justify-center gap-3 transition-all active:scale-95 shadow-lg shadow-indigo-500/20"
                        >
                            <Share2 size={24} />
                            🚀 Share Your Fundraiser
                        </button>
                        <div className="grid grid-cols-2 gap-3">
                            <button
                                onClick={handleFacebookShare}
                                className="bg-blue-50 hover:bg-blue-100 text-blue-700 p-4 rounded-2xl font-black text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-blue-100"
                            >
                                <Facebook size={24} />
                                <span>📘 Facebook</span>
                            </button>
                            <button
                                onClick={handleSmsShare}
                                className="bg-emerald-50 hover:bg-emerald-100 text-emerald-700 p-4 rounded-2xl font-black text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-emerald-100"
                            >
                                <Smartphone size={24} />
                                <span>📱 Text / SMS</span>
                            </button>
                            <button
                                onClick={handleEmailShare}
                                className="bg-purple-50 hover:bg-purple-100 text-purple-700 p-4 rounded-2xl font-black text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-purple-100"
                            >
                                <Mail size={24} />
                                <span>📧 Email</span>
                            </button>
                            <button
                                onClick={handleInstagramShare}
                                className="bg-pink-50 hover:bg-pink-100 text-pink-700 p-4 rounded-2xl font-black text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-pink-100"
                            >
                                <Instagram size={24} />
                                <span>📸 Instagram</span>
                            </button>
                        </div>
                    </div>

                    {/* Divider */}
                    <div className="border-t border-slate-100" />

                    {/* ── 🗂️ Offline Tools ── */}
                    <div className="space-y-2">
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">🗂️ Offline Tools</p>
                        <div className="grid grid-cols-2 gap-3">
                            <button
                                onClick={() => setShowOrderModal(true)}
                                className="bg-white hover:bg-slate-50 text-slate-700 p-4 rounded-2xl font-bold text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-slate-200"
                            >
                                <Plus size={22} strokeWidth={3} />
                                <span>Add Order</span>
                            </button>
                            <button
                                onClick={handleCopy}
                                className="bg-white hover:bg-slate-50 text-slate-700 p-4 rounded-2xl font-bold text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-slate-200"
                            >
                                {copied ? <CheckCircle2 size={22} className="text-emerald-500" /> : <LinkIcon size={22} />}
                                <span>{copied ? 'Copied!' : 'Copy Order Link'}</span>
                            </button>
                            <button
                                onClick={handleCopyScoreboard}
                                className="bg-white hover:bg-slate-50 text-slate-700 p-4 rounded-2xl font-bold text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-slate-200"
                            >
                                <Activity size={22} />
                                <span>{copiedScoreboard ? 'Copied!' : 'Copy Scoreboard'}</span>
                            </button>
                            <Link
                                href={`/coordinator/${token}/guide`}
                                className="bg-white hover:bg-slate-50 text-slate-700 p-4 rounded-2xl font-bold text-sm flex flex-col items-center gap-2 transition-all active:scale-95 border border-slate-200"
                            >
                                <Eye size={22} />
                                <span>View Scripts</span>
                            </Link>
                        </div>
                    </div>
                </div>

                {/* ── AI Content Generator ── */}
                <div className="bg-indigo-600 rounded-2xl p-4 text-white space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 bg-indigo-400 rounded-xl flex items-center justify-center text-white shadow-lg">
                                <Rocket size={16} />
                            </div>
                            <div>
                                <h3 className="font-bold text-sm">AI Content Generator</h3>
                                <p className="text-indigo-200 text-[10px] font-bold uppercase tracking-widest">Powered by Google Gemini</p>
                            </div>
                        </div>
                        {aiRemaining !== null && (
                            <p className="text-[10px] font-black text-indigo-200 uppercase tracking-widest">
                                {aiRemaining} of 40 left
                            </p>
                        )}
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
                    <p className="text-[10px] text-indigo-200/70 font-medium text-center">
                        Generate, then the message is copied and your app opens automatically.
                    </p>

                    {aiRemaining === 0 && (
                        <p className="text-center text-xs font-bold text-indigo-200 bg-white/5 rounded-xl p-3">
                            ✅ You&apos;ve used all 40 AI generations! Use the copy scripts below or edit previous results.
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
                            {/* Channel-aware re-share action */}
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

                {/* 📋 Copy Scripts & Downloads */}
                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm space-y-4">
                    {/* Section Header */}
                    <div>
                        <h2 className="text-lg font-black flex items-center gap-2">
                            <Copy size={20} className="text-slate-600" />
                            📋 Copy Scripts & Downloads
                        </h2>
                    </div>

                    {/* ── Copy Scripts (Secondary) ── */}
                    <div className="space-y-2">
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                            <Copy size={12} />
                            Copy Scripts — Manual Paste
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <button
                                onClick={handleCopyTextMessage}
                                className="bg-slate-50 hover:bg-slate-100 text-slate-600 p-3 rounded-xl font-bold text-xs flex items-center gap-2.5 transition-all active:scale-95 border border-slate-200"
                            >
                                <MessageSquare size={14} className="flex-shrink-0" />
                                <span>{copiedText ? '✅ Copied!' : 'Copy Text Message'}</span>
                            </button>
                            <button
                                onClick={handleCopyFacebookPost}
                                className="bg-slate-50 hover:bg-slate-100 text-slate-600 p-3 rounded-xl font-bold text-xs flex items-center gap-2.5 transition-all active:scale-95 border border-slate-200"
                            >
                                <Facebook size={14} className="flex-shrink-0" />
                                <span>{copiedFb ? '✅ Copied!' : 'Copy Facebook Post'}</span>
                            </button>
                            <button
                                onClick={handleCopyEmailBlurb}
                                className="bg-slate-50 hover:bg-slate-100 text-slate-600 p-3 rounded-xl font-bold text-xs flex items-center gap-2.5 transition-all active:scale-95 border border-slate-200"
                            >
                                <Mail size={14} className="flex-shrink-0" />
                                <span>{copiedEmail ? '✅ Copied!' : 'Copy Email Blurb'}</span>
                            </button>
                        </div>
                        <p className="text-xs text-slate-400 font-medium mt-1 pl-1">
                            💡 Each message includes your bundles, link, and deadline — ready to paste.
                        </p>
                    </div>

                    {/* Divider */}
                    <div className="border-t border-slate-100" />

                    {/* ── Secondary Actions: Downloads ── */}
                    <div className="space-y-2">
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                            <Download size={12} />
                            Printable Downloads
                        </p>
                        {(() => {
                            const trackerAsset = campaignAssets.find(a => a.key === 'tracker');
                            const flyerAsset = campaignAssets.find(a => a.key === 'flyer');
                            const qrAsset = campaignAssets.find(a => a.key === 'qr');
                            return (
                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                    <button
                                        onClick={handleDownloadTracker}
                                        disabled={campaignAssets.length > 0 && !trackerAsset?.available}
                                        className={`p-3 rounded-xl font-bold text-xs flex flex-col items-center justify-center gap-1.5 transition-all border ${
                                            trackerAsset?.available !== false
                                                ? 'bg-slate-50 hover:bg-slate-100 text-slate-600 border-slate-200 active:scale-95'
                                                : 'bg-slate-50 text-slate-400 border-slate-100 cursor-not-allowed opacity-60'
                                        }`}
                                    >
                                        <Download size={14} />
                                        <span>{trackerAsset?.label || 'Download Tracker'}</span>
                                    </button>
                                    <button
                                        disabled={!flyerAsset?.available}
                                        onClick={flyerAsset?.available ? () => { window.open(flyerAsset.url, '_blank'); trackAction('download_flyer'); } : undefined}
                                        className={`p-3 rounded-xl font-bold text-xs flex flex-col items-center justify-center gap-1.5 transition-all border ${
                                            flyerAsset?.available
                                                ? 'bg-slate-50 hover:bg-slate-100 text-slate-600 border-slate-200 active:scale-95'
                                                : 'bg-slate-50 text-slate-400 border-slate-100 cursor-not-allowed opacity-60'
                                        }`}
                                        title={flyerAsset?.available ? '' : 'Flyer download coming soon'}
                                    >
                                        <FileText size={14} />
                                        <span>{flyerAsset?.label || 'Download Flyer'}</span>
                                    </button>
                                    <button
                                        disabled={!qrAsset?.available}
                                        onClick={qrAsset?.available ? () => { window.open(qrAsset.url, '_blank'); trackAction('download_qr'); } : undefined}
                                        className={`p-3 rounded-xl font-bold text-xs flex flex-col items-center justify-center gap-1.5 transition-all border ${
                                            qrAsset?.available
                                                ? 'bg-slate-50 hover:bg-slate-100 text-slate-600 border-slate-200 active:scale-95'
                                                : 'bg-slate-50 text-slate-400 border-slate-100 cursor-not-allowed opacity-60'
                                        }`}
                                        title={qrAsset?.available ? '' : 'QR code download coming soon'}
                                    >
                                        <LinkIcon size={14} />
                                        <span>{qrAsset?.label || 'Download QR Code'}</span>
                                    </button>
                                </div>
                            );
                        })()}
                    </div>

                    {/* ── Full Packet (tertiary) ── */}
                    {(() => {
                        const packetAsset = campaignAssets.find(a => a.key === 'packet');
                        return (
                            <button
                                disabled={!packetAsset?.available}
                                onClick={packetAsset?.available ? () => { window.open(packetAsset.url, '_blank'); trackAction('download_packet'); } : () => toast('Full packet download coming soon!')}
                                className={`w-full p-2.5 rounded-xl font-medium text-xs flex items-center justify-center gap-1.5 transition-all ${
                                    packetAsset?.available
                                        ? 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                                        : 'text-slate-400 hover:text-slate-500'
                                }`}
                            >
                                <FileText size={13} />
                                {packetAsset?.label || 'Download Full Packet (All Files)'}
                            </button>
                        );
                    })()}
                </div>

                {/* ── Engagement Insight ── */}
                <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
                    <div className="flex items-center gap-2 mb-3">
                        <div className="w-8 h-8 rounded-xl bg-emerald-50 flex items-center justify-center">
                            <Activity size={16} className="text-emerald-600" />
                        </div>
                        <h3 className="font-bold text-sm text-slate-700">Your Activity</h3>
                    </div>
                    {actionSummary && actionSummary.totalActions > 0 ? (
                        <div className="space-y-2">
                            <div className="flex items-baseline justify-between">
                                <span className="text-2xl font-black text-emerald-600">{actionSummary.totalActions}</span>
                                <span className="text-xs text-slate-400 font-medium">
                                    {actionSummary.totalActions === 1 ? 'action taken' : 'actions taken'}
                                </span>
                            </div>
                            {actionSummary.lastActionAt && (
                                <p className="text-xs text-slate-400">
                                    Last action: {(() => {
                                        const diff = Date.now() - new Date(actionSummary.lastActionAt).getTime();
                                        const mins = Math.floor(diff / 60000);
                                        if (mins < 1) return 'just now';
                                        if (mins < 60) return `${mins}m ago`;
                                        const hrs = Math.floor(mins / 60);
                                        if (hrs < 24) return `${hrs}h ago`;
                                        return `${Math.floor(hrs / 24)}d ago`;
                                    })()}
                                </p>
                            )}
                            {actionSummary.mostUsedAction && (
                                <p className="text-xs text-slate-500 font-medium">⭐ Most used: {actionSummary.mostUsedAction}</p>
                            )}
                        </div>
                    ) : (
                        <p className="text-xs text-slate-400 leading-relaxed">
                            No promo actions yet — start with the text message or fundraiser link above! 🚀
                        </p>
                    )}
                </div>

                <button
                    onClick={() => setShowSettingsModal(true)}
                    className="w-full bg-white hover:bg-slate-50 text-slate-900 p-4 rounded-2xl font-bold border border-slate-200 shadow-sm flex items-center justify-center gap-2 transition-all active:scale-95"
                >
                    <Settings size={20} />
                    <span>Payment Settings</span>
                </button>

                {/* ── SECTION: Info & Details ── */}
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-1">📄 Info & Details</p>

                {/* Success Toolkit CTA */}
                <Link
                    href={`/coordinator/${token}/guide`}
                    className="bg-gradient-to-br from-indigo-600 to-indigo-800 text-white p-6 rounded-[2rem] shadow-xl flex items-center justify-between group hover:scale-[1.02] transition-all overflow-hidden relative"
                >
                    <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -translate-y-8 translate-x-8 blur-2xl group-hover:bg-white/20 transition-colors" />
                    <div className="relative flex items-center gap-4">
                        <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center">
                            <Star className="text-white" fill="white" size={24} />
                        </div>
                        <div>
                            <h3 className="font-black text-lg leading-tight uppercase tracking-tight">Success Toolkit</h3>
                            <p className="text-indigo-100/80 text-xs font-bold">How-To Guide & Social Scripts</p>
                        </div>
                    </div>
                    <ArrowRight className="group-hover:translate-x-1 transition-transform" />
                </Link>

                {/* Info Section */}
                <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
                    <h2 className="text-lg font-black mb-4 flex items-center gap-2">
                        <TrendingUp size={20} className="text-indigo-600" />
                        Campaign Details
                    </h2>
                    <div className="space-y-4">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
                                <Calendar size={18} />
                            </div>
                            <div>
                                <p className="text-xs font-black text-slate-300 uppercase">Ends On</p>
                                <p className="font-bold text-slate-700">
                                    {campaign.end_date ? format(new Date(campaign.end_date), 'MMMM d, yyyy') : 'No date set'}
                                </p>
                                {daysRemaining !== null && daysRemaining > 0 && (
                                    <p className="text-xs font-bold text-amber-600 mt-0.5">⏳ {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} remaining</p>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400">
                                <Target size={18} />
                            </div>
                            <div>
                                <p className="text-xs font-black text-slate-300 uppercase">Organization</p>
                                <p className="font-bold text-slate-700">{campaign.customer?.name}</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Recent Activity */}
                <div id="recent-orders" className="space-y-4 pb-20">
                    <h2 className="text-lg font-black px-2 flex items-center justify-between">
                        Recent Orders
                        <span className="bg-slate-200 px-2 py-0.5 rounded-full text-[10px] text-slate-600">
                            {(campaign.orders || []).length}
                        </span>
                    </h2>
                    {(campaign.orders || []).length === 0 ? (
                        <div className="bg-white rounded-2xl p-8 text-center border-2 border-dashed border-slate-200 space-y-2">
                            <p className="text-slate-500 font-bold">No orders yet — let&apos;s get your first one!</p>
                            <p className="text-slate-400 text-sm">Use <span className="font-bold text-slate-500">Quick Actions</span> above to share your order page link and start selling.</p>
                        </div>
                    ) : (
                        (campaign.orders || []).map((order: any) => (
                            <div key={order.id} className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm group">
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-4">
                                        <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600 font-black">
                                            {order.customer_name?.[0] || 'O'}
                                        </div>
                                        <div>
                                            <p className="font-black text-slate-900">{order.customer_name || 'Anonymous'}</p>
                                            <p className="text-xs font-bold text-slate-400">
                                                {format(new Date(order.created_at), 'MMM d, h:mm a')}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className="font-black text-lg text-slate-900">${order.total_amount}</p>
                                        <span className="text-[10px] font-black uppercase text-slate-300 tracking-tighter">{order.source}</span>
                                    </div>
                                </div>
                                {order.items && order.items.length > 0 && (
                                    <div className="mt-3 pt-3 border-t border-slate-100">
                                        <div className="flex flex-wrap gap-1.5">
                                            {order.items.map((item: any, idx: number) => (
                                                <span key={idx} className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg text-xs font-bold">
                                                    {item.item_name || 'Bundle'} × {item.quantity}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </main>

            {/* Offline Order Modal */}
            {showOrderModal && (
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
                                        const isSelected = selectedItems.find(i => i.id === bundle.id);
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
                                                    <div className="flex items-center gap-2 mt-2" onClick={e => e.stopPropagation()}>
                                                        <button
                                                            type="button"
                                                            onClick={() => updateQty(bundle.id, -1)}
                                                            className="w-6 h-6 rounded-lg bg-white border border-slate-200 flex items-center justify-center font-bold text-xs"
                                                        >-</button>
                                                        <span className="text-sm font-black w-4 text-center">{isSelected.quantity}</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => updateQty(bundle.id, 1)}
                                                            className="w-6 h-6 rounded-lg bg-indigo-600 text-white flex items-center justify-center font-bold text-xs"
                                                        >+</button>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="h-px bg-slate-100 w-full" />

                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Customer Name</label>
                                    <div className="relative">
                                        <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                        <input
                                            required
                                            type="text"
                                            placeholder="Jane Doe"
                                            className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                            value={formData.customerName}
                                            onChange={(e) => setFormData({ ...formData, customerName: e.target.value })}
                                        />
                                    </div>
                                </div>

                                {/* Participant / Student Name */}
                                {campaign?.participant_label && (
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">
                                            {campaign.participant_label} Name <span className="text-slate-300">(Optional - for Leaderboard)</span>
                                        </label>
                                        <div className="relative">
                                            <Target className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                            <input
                                                type="text"
                                                placeholder={`e.g. ${campaign.participant_label} Name`}
                                                className="w-full pl-12 pr-4 py-4 bg-slate-50 border-none rounded-2xl focus:ring-2 focus:ring-indigo-500/20 font-bold"
                                                value={formData.participantName}
                                                onChange={(e) => setFormData({ ...formData, participantName: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="space-y-1">
                                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Amount ($)</label>
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

            {/* Settings Modal */}
            <SettingsModal
                isOpen={showSettingsModal}
                onClose={() => setShowSettingsModal(false)}
                token={token}
                initialData={{
                    paymentInstructions: campaign?.payment_instructions,
                    externalPaymentLink: campaign?.external_payment_link
                }}
            />
        </div>
    );
}

function SettingsModal({ isOpen, onClose, token, initialData }: { isOpen: boolean; onClose: () => void; token: string; initialData: any }) {
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
            const res = await fetch(`/api/coordinator/${token}`, {
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
