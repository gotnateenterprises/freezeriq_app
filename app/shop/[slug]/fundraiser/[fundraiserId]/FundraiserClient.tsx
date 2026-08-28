"use client";

import React, { useState, useMemo, useRef } from 'react';
import { formatBundleCount, computeBundleUnitsFromItems, type FundraiserProgressResult } from '@/lib/fundraiserMetrics';
import { resolveVariantSize } from '@/lib/serving_multipliers';

/**
 * FR-ACCEPTANCE-MOBILE-POLISH-1. Display-only formatting for the per-order
 * confirmation sentence — "0.5" reads as an unexplained fraction to a
 * supporter, "½" reads as a portion the way "half a bundle" already does.
 * Purely cosmetic: the weighting engine (getBundleUnitWeight /
 * computeBundleUnitsFromItems in lib/fundraiserMetrics.ts) is untouched, and
 * every value it can ever produce is a multiple of 0.5, so `hasHalf` never
 * needs to handle any other fractional remainder.
 */
function formatBundleCredit(units: number): string {
    const whole = Math.floor(units);
    const hasHalf = Math.abs(units - whole - 0.5) < 1e-9;
    if (!hasHalf) return String(whole);
    return whole === 0 ? '½' : `${whole}½`;
}

// FR-LAUNCH-1B (complete Fable restoration): this page is a full port of the
// APPROVED fundraiser buyer design — the "FUNDRAISER BUYER PAGE" screen of
// docs/ai/prototypes/storefront_prototype.html (markup lines 502-596, shared
// styles lines 2-120, interaction script lines 754-766) as routed by
// docs/ai/STOREFRONT_REDESIGN_HANDOFF.md's FR track (spec §10):
//
//   Topbar (campaign identity · "by {tenant}") → ProgressHero → PayBadge
//     → Fable .bcard bundles ("Add" toggles into the order)
//     → inline OrderForm card → POST /api/public/order
//     → ThanksState (PaymentCard / ShareRow / FounderNote), swapped in place.
//
// No cart drawer, no checkout modal, no mailto ordering, no Stripe/Square.
// The page is the prototype's "warm light world" — cream #faf5ef, ink #3b2a2f,
// line #eee2d6, sage #7d8f72 — with primaryColor standing in for the berry
// accent as the SF-1 token bridge the handoff prescribes (note for SF-1 cleanup).

const SERIF = "Georgia,'Iowan Old Style','Times New Roman',serif";

const fableInput: React.CSSProperties = {
    border: '1px solid #e9d9cb',
    borderRadius: 10,
    padding: '.55rem .7rem',
    fontFamily: 'inherit',
    fontSize: '.76rem',
    background: '#faf5ef',
    color: '#3b2a2f',
    width: '100%',
};

const qtyBtn: React.CSSProperties = {
    width: 24,
    height: 24,
    borderRadius: 8,
    border: '1px solid #e9d9cb',
    background: '#faf5ef',
    color: '#3b2a2f',
    fontWeight: 800,
    cursor: 'pointer',
    lineHeight: 1,
};

const fableCard: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #eee2d6',
    borderRadius: 20,
    padding: '1rem 1.05rem',
};

// One-time confirmation confetti. Ten small pieces in the Fable palette
// ('primary' resolves to the tenant primary color at render). Hand-tuned so the
// stagger reads as a soft scatter rather than a uniform burst; every animation
// runs exactly once and ends transparent.
const CONFETTI_PIECES: {
    left: string; top: string; w: number; h: number; round?: boolean;
    color: string; delay: string; duration: string;
    drift: string; fall: string; spin: string;
}[] = [
    { left: '8%',  top: '4%',  w: 6, h: 9, color: 'primary', delay: '0s',    duration: '1.15s', drift: '-10px', fall: '74px', spin: '210deg' },
    { left: '18%', top: '0%',  w: 5, h: 5, round: true, color: '#7d8f72', delay: '.09s', duration: '1.3s',  drift: '8px',   fall: '82px', spin: '-160deg' },
    { left: '27%', top: '7%',  w: 7, h: 4, color: '#eccfd4', delay: '.18s', duration: '1.05s', drift: '-6px',  fall: '66px', spin: '260deg' },
    { left: '38%', top: '2%',  w: 5, h: 8, color: 'primary', delay: '.05s', duration: '1.25s', drift: '12px',  fall: '78px', spin: '-220deg' },
    { left: '48%', top: '6%',  w: 4, h: 4, round: true, color: '#e5b8c1', delay: '.24s', duration: '1.1s',  drift: '-9px',  fall: '70px', spin: '180deg' },
    { left: '58%', top: '1%',  w: 6, h: 9, color: '#d8c3b5', delay: '.13s', duration: '1.35s', drift: '10px',  fall: '84px', spin: '-190deg' },
    { left: '68%', top: '5%',  w: 5, h: 5, color: '#7d8f72', delay: '.3s',  duration: '1.0s',  drift: '-7px',  fall: '64px', spin: '240deg' },
    { left: '77%', top: '0%',  w: 7, h: 4, color: 'primary', delay: '.2s',  duration: '1.2s',  drift: '9px',   fall: '76px', spin: '-250deg' },
    { left: '86%', top: '8%',  w: 4, h: 7, color: '#eccfd4', delay: '.36s', duration: '1.1s',  drift: '-11px', fall: '68px', spin: '170deg' },
    { left: '93%', top: '3%',  w: 5, h: 5, round: true, color: 'primary', delay: '.28s', duration: '1.28s', drift: '6px',   fall: '80px', spin: '-200deg' },
];

interface OrderLine {
    bundleId: string;
    name: string;
    price: number;
    quantity: number;
    serving_tier: string;
}

interface ThanksData {
    orderRef: string;
    total: number;
    unitsAdded: number;
    participant: string;
    paymentInstructions: string | null;
    externalPaymentLink: string | null;
    orgName: string | null;
}

export default function FundraiserClient({
    business,
    campaign,
    bundleProgress,
    orderMode,
    slug,
    fundraiserId
}: any) {

    const { totalBundlesSold, bundleGoal } = bundleProgress as FundraiserProgressResult;

    const primaryColor = business.branding?.primary_color || '#4f46e5';
    const tenantName = (business.branding?.business_name
        && business.branding.business_name !== 'FreezerIQ'
        && business.branding.business_name !== 'Freezer IQ')
        ? business.branding.business_name
        : (business.name || 'Freezer Chef');
    const tenantLogo = business.branding?.logo_url || business.logo_url || null;
    const campaignTitle = campaign.name || `${campaign.organization_name} Fundraiser`;

    // ── Fundraiser order state (Fable's inline "order engine") ────────────────
    // Component-local and fully isolated: never reads or writes the shared
    // regular-store cart (context/CartContext.tsx / localStorage 'freezeriq_cart'),
    // so regular-store items can't enter a fundraiser order, fundraiser items
    // can't leak into the storefront cart, and nothing persists across campaigns.
    const [orderLines, setOrderLines] = useState<OrderLine[]>([]);
    const [buyerName, setBuyerName] = useState('');
    const [buyerEmail, setBuyerEmail] = useState('');
    const [buyerPhone, setBuyerPhone] = useState('');
    const [participant, setParticipant] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [thanks, setThanks] = useState<ThanksData | null>(null);
    // Presentation-only: shows once per successful order, dismissed by the
    // customer. Never re-shown by a replay (no new setThanks call occurs on a
    // replay) and never tied to any API request of its own.
    const [showSuccessModal, setShowSuccessModal] = useState(false);
    const [copied, setCopied] = useState(false);
    // Presentation-only: keeps Step 1 of the share guide visibly "complete"
    // after the 2-second `copied` flash resets. No behavioral meaning.
    const [step1Done, setStep1Done] = useState(false);
    const [shareStatus, setShareStatus] = useState<string | null>(null);

    const bundles = business.bundles || [];
    // Defense-in-depth: only the exact coordinator-approved bundle ids this page
    // was given can ever enter the order (the server enforces CB-5 regardless).
    const approvedBundleIds = useMemo(
        () => new Set(bundles.map((b: any) => b.id)),
        [bundles]
    );

    const orderTotal = orderLines.reduce((sum, l) => sum + l.price * l.quantity, 0);

    // One derived bundle total drives every progress display so the hero and the
    // confirmation can never disagree after a submission.
    const displayBundlesSold = totalBundlesSold + (thanks?.unitsAdded ?? 0);
    const displayProgressPercent = bundleGoal > 0
        ? Math.min((displayBundlesSold / bundleGoal) * 100, 100)
        : 0;

    // Truthful motivational copy derived only from the displayed bundle values.
    const remainingBundles = Math.max(bundleGoal - displayBundlesSold, 0);
    const progressMotivation = displayBundlesSold >= bundleGoal
        ? 'Goal reached — thank you!'
        : displayProgressPercent >= 75
            ? 'Almost at the goal!'
            : displayProgressPercent >= 50
                ? 'Halfway there!'
                : `Only ${formatBundleCount(remainingBundles)} bundle${remainingBundles === 1 ? '' : 's'} to go`;

    // Near-term milestone for the confirmation impact panel — derived ONLY from
    // displayBundlesSold and bundleGoal (no dollars, never beyond the goal).
    // Weighted progress can only land on 0.5-bundle increments (serves_5 = 1.0,
    // serves_2 = 0.5), so a raw 25/50/75% target — e.g. 18.75 of a 75-bundle
    // goal — may not be reachable. Each raw percentage target is rounded UP to
    // the first attainable half-bundle value before it's used as a boundary or
    // displayed, so the campaign can always actually reach the named milestone
    // and no .25/.75 fraction ever appears in customer-facing copy.
    const milestoneMessage = (() => {
        if (bundleGoal <= 0) return null;

        const EPSILON = 0.0001;
        const isAt = (a: number, b: number) => Math.abs(a - b) < EPSILON;
        // Subtracting EPSILON before ceiling keeps an already-attainable value
        // (e.g. 12.5) from being pushed up to 13 by floating-point drift.
        const toAttainableHalf = (rawTarget: number) => Math.ceil((rawTarget - EPSILON) * 2) / 2;
        const remainingTo = (target: number) => {
            // target and displayBundlesSold are both on the 0.5 grid here, so
            // this only clears float drift — it can no longer misround a raw
            // quarter-bundle fraction such as 8.75 into 9.
            const remaining = Math.max(Math.round((target - displayBundlesSold) * 2) / 2, 0);
            return `${formatBundleCount(remaining)} more bundle${remaining === 1 ? '' : 's'}`;
        };

        const t25 = toAttainableHalf(bundleGoal * 0.25);
        const t50 = toAttainableHalf(bundleGoal * 0.5);
        const t75 = toAttainableHalf(bundleGoal * 0.75);
        const tGoal = toAttainableHalf(bundleGoal);

        if (displayBundlesSold >= tGoal - EPSILON) return 'Goal reached — thank you!';
        if (isAt(displayBundlesSold, t75)) return `75% milestone reached — only ${remainingTo(tGoal)} until the fundraiser goal!`;
        if (isAt(displayBundlesSold, t50)) return `Halfway there — only ${remainingTo(t75)} until the 75% milestone!`;
        if (isAt(displayBundlesSold, t25)) return `25% milestone reached — only ${remainingTo(t50)} until halfway!`;
        if (displayBundlesSold > t75) return `Only ${remainingTo(tGoal)} until the fundraiser goal!`;
        if (displayBundlesSold > t50) return `Only ${remainingTo(t75)} until the 75% milestone!`;
        if (displayBundlesSold > t25) return `Only ${remainingTo(t50)} until halfway!`;
        return `Only ${remainingTo(t25)} until the 25% milestone!`;
    })();

    // ── FR-LAUNCH-1E: submission key lifecycle ────────────────────────────────
    // One key identifies one logical submission. It is generated at the first
    // submit attempt, REUSED across retries (so a lost response replays instead
    // of creating a second order), cleared after a confirmed success, and
    // cleared whenever the logical payload changes (so a changed cart can never
    // collide with the server's fingerprint check).
    //
    // Deliberately a ref, not state: it must not trigger a re-render, and it must
    // not persist across a reload — the cart is component-local with no storage,
    // so a refresh is already a new logical submission.
    const submissionKeyRef = useRef<string | null>(null);
    const resetSubmissionKey = () => { submissionKeyRef.current = null; };

    const toggleLine = (bundle: any) => {
        if (!approvedBundleIds.has(bundle.id)) return;
        setSubmitError(null);
        resetSubmissionKey();
        setOrderLines(prev => {
            const exists = prev.some(l => l.bundleId === bundle.id);
            if (exists) return prev.filter(l => l.bundleId !== bundle.id);
            return [...prev, {
                bundleId: bundle.id,
                name: bundle.name,
                price: Number(bundle.price || 0),
                quantity: 1,
                serving_tier: bundle.serving_tier || 'family',
            }];
        });
    };

    const changeQty = (bundleId: string, delta: number) => {
        resetSubmissionKey();
        setOrderLines(prev => prev
            .map(l => l.bundleId === bundleId ? { ...l, quantity: l.quantity + delta } : l)
            .filter(l => l.quantity >= 1));
    };

    const removeLine = (bundleId: string) => {
        resetSubmissionKey();
        setOrderLines(prev => prev.filter(l => l.bundleId !== bundleId));
    };

    const canSubmit = orderLines.length > 0
        && buyerName.trim().length > 0
        && buyerEmail.trim().length > 0
        && !submitting;

    const submitOrder = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        setSubmitError(null);
        // Generated once per logical submission; a retry after a failure reuses it
        // so the server replays the original order instead of creating a second.
        if (!submissionKeyRef.current) {
            submissionKeyRef.current = crypto.randomUUID();
        }
        try {
            // Same hardened endpoint as before (FR-LAUNCH-1A): the server resolves
            // the campaign, enforces CB-5 eligibility and pricing, and writes
            // source='fundraiser' / status='fundraiser_hold'. No Stripe or Square
            // path exists anywhere in this component.
            const res = await fetch('/api/public/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    submissionKey: submissionKeyRef.current,
                    items: orderLines.map(l => ({
                        bundleId: l.bundleId,
                        quantity: l.quantity,
                        serving_tier: l.serving_tier,
                        name: l.name,
                    })),
                    customer: {
                        name: buyerName.trim(),
                        email: buyerEmail.trim(),
                        phone: buyerPhone.trim(),
                        participantCode: participant.trim() || undefined,
                    },
                    slug,
                    campaignId: campaign.id,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                // FR-LAUNCH-1E: a conflict means this key can never succeed again,
                // so retire it — a retry must start a fresh logical submission.
                if (data.code === 'SUBMISSION_CONFLICT'
                    || data.code === 'INVALID_SUBMISSION_KEY'
                    || data.code === 'CAMPAIGN_CLOSED') {
                    resetSubmissionKey();
                }
                const message = data.code === 'CAMPAIGN_NOT_FOUND'
                    ? 'This fundraiser could not be found — please refresh and try again.'
                    : data.code === 'INVALID_QUANTITY'
                        ? 'Quantities must be whole numbers of 1 or more.'
                        : data.code === 'CAMPAIGN_CLOSED'
                            ? 'This fundraiser has closed and is no longer accepting orders.'
                            : (data.error || 'We could not place your order — please try again.');
                throw new Error(message);
            }

            const unitsAdded = computeBundleUnitsFromItems(
                orderLines.map(l => ({ quantity: l.quantity, serving_tier: l.serving_tier }))
            );
            // The amount shown to the buyer (and owed to the coordinator) is the
            // SERVER-persisted order total, not the browser's running figure. The
            // client total is only a fallback if an older response omits it.
            const serverTotal = Number(data.total);
            const authoritativeTotal = Number.isFinite(serverTotal) ? serverTotal : orderTotal;
            setThanks({
                // Fable's orderRef format is last-6-uppercased; the API returns the
                // internal order id (not external_id), so the same format is applied
                // to the id we do have.
                orderRef: String(data.orderId || '').slice(-6).toUpperCase(),
                total: authoritativeTotal,
                unitsAdded,
                participant: participant.trim(),
                paymentInstructions: data.paymentData?.paymentInstructions ?? campaign.payment_instructions ?? null,
                externalPaymentLink: data.paymentData?.externalPaymentLink ?? campaign.external_payment_link ?? null,
                orgName: data.paymentData?.orgName ?? campaign.organization_name ?? null,
            });
            // Confirmed order success only — never shown for a failed submission,
            // a replay conflict, a closed-campaign rejection, or a validation error,
            // since those all throw below and never reach this line.
            setShowSuccessModal(true);
            // Confirmed success — retire the key so any later order is a new
            // logical submission rather than a replay of this one.
            resetSubmissionKey();
            // Clear ONLY the fundraiser order state (success path).
            setOrderLines([]);
            if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (e: any) {
            // Failure preserves the order lines untouched.
            setSubmitError(e?.message || 'We could not place your order — please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    // ── ShareRow actions ──────────────────────────────────────────────────────
    // One suggested caption drives Text / Facebook / Copy. Facebook does not
    // permit prefilling the user's post text, so the caption is copied to the
    // clipboard and the URL Share Dialog is opened with the fundraiser URL; the
    // link PREVIEW itself comes from the page's Open Graph metadata and can only
    // be built by Facebook from a public HTTPS URL (never from localhost).
    const pageUrl = () => (typeof window !== 'undefined' ? window.location.href : '');
    const isLocalhost = () => typeof window !== 'undefined'
        && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
    const shareCaption = () =>
        `Help ${campaign.organization_name} reach ${formatBundleCount(bundleGoal)} bundles!\n\n` +
        `We're currently at ${formatBundleCount(displayBundlesSold)} bundles. Choose delicious freezer meal ` +
        `bundles and support the fundraiser. Payment is collected separately by the coordinator.\n\n` +
        `Order here:\n${pageUrl()}`;

    const handleTextIt = () => {
        window.location.href = `sms:?&body=${encodeURIComponent(shareCaption())}`;
    };

    // Guards browsers/contexts (e.g. non-HTTPS, older WebViews) where
    // navigator.clipboard or writeText is missing entirely, so calling it
    // can't throw synchronously and block the Facebook share below.
    const copyShareCaption = (): Promise<boolean> => {
        if (
            typeof navigator === 'undefined'
            || !navigator.clipboard
            || typeof navigator.clipboard.writeText !== 'function'
        ) {
            return Promise.resolve(false);
        }

        return navigator.clipboard
            .writeText(shareCaption())
            .then(() => true)
            .catch(() => false);
    };

    const handleFacebook = async () => {
        // Start the clipboard write from the click itself, BEFORE any await, so the
        // browser's user-activation is still valid when window.open runs (awaiting
        // first would let the popup blocker cancel it).
        const captionCopyPromise = copyShareCaption();

        // Localhost can't produce a real link preview, so opening the sharer only
        // yields an empty-looking composer — copy the caption and stop here.
        if (isLocalhost()) {
            const copiedLocally = await captionCopyPromise;
            setShareStatus(copiedLocally
                ? 'Facebook previews require the public Vercel or live page. Caption copied — test Facebook after deployment.'
                : 'Facebook previews require the public Vercel or live page, and the caption could not be copied. Use Copy or Text it instead.');
            return;
        }

        window.open(
            `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(pageUrl())}`,
            '_blank',
            'noopener,noreferrer'
        );

        const captionCopied = await captionCopyPromise;
        setShareStatus(captionCopied
            ? 'Caption copied — paste it into your Facebook post.'
            : 'Facebook opened. Add a short message before sharing.');
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(shareCaption());
            setCopied(true);
            setStep1Done(true);
            setShareStatus('Caption copied — ready to paste anywhere.');
            setTimeout(() => setCopied(false), 2000);
        } catch {
            try {
                await navigator.clipboard.writeText(pageUrl());
                setShareStatus('Caption copy failed — the link was copied instead.');
            } catch {
                setShareStatus('Copy is unavailable in this browser — long-press the address bar to share the link.');
            }
        }
    };

    // ── Fundraiser date helpers (pre-existing) ────────────────────────────────
    // Anchor date-only values to noon to prevent timezone drift.
    const formatDate = (dateVal: any) => {
        if (!dateVal) return null;
        try {
            const str = dateVal instanceof Date ? dateVal.toISOString() : String(dateVal);
            const dateOnly = str.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
            const d = dateOnly ? new Date(dateOnly + 'T12:00:00') : new Date(str);
            if (isNaN(d.getTime())) return null;
            return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        } catch { return null; }
    };

    const formatTime = (dateVal: any) => {
        if (!dateVal) return null;
        try {
            const d = new Date(dateVal);
            if (isNaN(d.getTime())) return null;
            const hours = d.getHours();
            const mins = d.getMinutes();
            if (hours === 0 && mins === 0) return null; // midnight = no time set
            return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        } catch { return null; }
    };

    const daysLeft = useMemo(() => {
        const endDate = campaign.end_date;
        if (!endDate) return null;
        try {
            const str = endDate instanceof Date ? endDate.toISOString() : String(endDate);
            const dateOnly = str.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
            const end = dateOnly ? new Date(dateOnly + 'T12:00:00') : new Date(str);
            if (isNaN(end.getTime())) return null;
            const now = new Date();
            const diff = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            return Math.max(0, diff);
        } catch { return null; }
    }, [campaign.end_date]);

    const endDateStr = formatDate(campaign.end_date);

    // Fallback: CRM stores these in customer.fundraiser_info (JSONB).
    const fi = campaign.customer_fundraiser_info || {};
    const deliveryDateStr = formatDate(campaign.delivery_date) || formatDate(fi.delivery_date);
    // FR-FLOW-3 — the pickup time, in the order of who actually knows it.
    //
    // The coordinator's confirmed campaign value comes first. The organization
    // profile is the fallback for fundraisers that predate coordinator setup.
    //
    // formatTime(campaign.delivery_date) used to lead this chain and has been
    // removed: delivery_date is a DATE column, so it arrives as UTC midnight, and
    // reading it with LOCAL getters yields a real-looking clock time for every
    // supporter west of Greenwich. A Chicago visitor was shown "7:00 PM" for a
    // fundraiser with no pickup time recorded at all — and because it led the
    // chain, it also outranked the true value once one existed.
    const deliveryTimeStr = (campaign.delivery_time ? String(campaign.delivery_time) : null)
        || (fi.delivery_time ? String(fi.delivery_time) : null);
    const pickupLocation = campaign.pickup_location || fi.pickup_location || null;

    const blocked = orderMode?.mode === 'closed' || orderMode?.mode === 'pending'
        || orderMode?.mode === 'invalid' || (orderMode?.mode === 'selected' && bundles.length === 0);

    return (
        <div style={{ minHeight: '100vh', background: '#faf5ef', color: '#3b2a2f', paddingBottom: '4rem', fontSize: 14, lineHeight: 1.5 }}>

            {/* ── Topbar (prototype lines 504-507): campaign identity + tenant chip ──
                 FR-SHARE-COPY-1: horizontal padding removed here for the same
                 reason as the page column below — it duplicated LayoutWrapper's
                 `main` padding (`p-4 sm:p-8`), stacking to 2rem/side on mobile. ── */}
            <div style={{ position: 'sticky', top: 0, zIndex: 30, display: 'flex', alignItems: 'center', gap: '.55rem', background: 'rgba(250,245,239,.92)', backdropFilter: 'blur(8px)', padding: '.75rem 0 .6rem', borderBottom: '1px solid #eee2d6' }}>
                <span style={{ width: 30, height: 30, borderRadius: 99, background: primaryColor, color: '#fff', display: 'grid', placeItems: 'center', fontSize: '.85rem', flex: 'none', overflow: 'hidden' }} aria-hidden="true">
                    {tenantLogo
                        ? <img src={tenantLogo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        : '🍲'}
                </span>
                <b style={{ fontFamily: SERIF, fontSize: '1rem', letterSpacing: '.01em', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{campaignTitle}</b>
                {/* FR-SHARE-COPY-1 mobile-overflow fix: flex:'none' held this at
                    full content width with no shrink/ellipsis guard, so a tenant
                    brand name longer than a short example could push the whole
                    topbar row past the viewport with no way to scroll to it. */}
                <span style={{ marginLeft: 'auto', flex: '0 1 auto', minWidth: 0, maxWidth: '40%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.66rem', fontWeight: 800, background: '#fdf3ee', color: primaryColor, borderRadius: 99, padding: '.3rem .6rem' }}>by {tenantName}</span>
            </div>

            {/* ── Page column (the prototype is a single warm editorial column) ── */}
            {/* FR-ACCEPTANCE-MOBILE-POLISH-1: horizontal padding here used to
                duplicate components/LayoutWrapper.tsx's `main` element, which
                already applies `p-4 sm:p-8` (1rem/2rem) to every /shop/* page
                — stacking to 2rem per side instead of the intended 1rem, and
                narrowing usable width most on the smallest phones. `main`'s
                padding is now the single source of horizontal spacing. */}
            <div style={{ maxWidth: '36rem', margin: '0 auto', padding: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>

                {thanks ? (
                    /* ============ ThanksState (prototype lines 570-594) ============
                       Swapped in place of the ordering body, exactly as the prototype
                       swaps fundbody → fundthanks (topbar remains). */
                    <section aria-live="polite">
                        {/* One-time success modal — presentation only. Sits over the
                            existing confetti/confirmation experience; dismissing it does
                            not alter anything underneath and triggers no request. */}
                        {showSuccessModal && (
                            <div
                                style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(59,42,47,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
                                onClick={() => setShowSuccessModal(false)}
                            >
                                <div
                                    role="dialog"
                                    aria-modal="true"
                                    aria-labelledby="fr-success-modal-title"
                                    onClick={e => e.stopPropagation()}
                                    style={{ background: '#fff', border: '1px solid #eee2d6', borderRadius: 20, boxShadow: '0 20px 45px rgba(59,42,47,.25)', padding: '1.5rem 1.3rem', maxWidth: '22rem', width: '100%', textAlign: 'center' }}
                                >
                                    <div style={{ fontSize: '2rem' }} aria-hidden="true">🎉</div>
                                    <h2 id="fr-success-modal-title" style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.15rem', margin: '.4rem 0 .5rem', color: '#3b2a2f' }}>
                                        Order received! 🎉
                                    </h2>
                                    <p style={{ margin: '0 0 1.1rem', fontSize: '.78rem', color: '#7a6258', lineHeight: 1.5 }}>
                                        Check your inbox for your order details and payment instructions. If you don&rsquo;t see the email in a few minutes, check your spam folder. Your order is still safely confirmed.
                                    </p>
                                    <button
                                        onClick={() => setShowSuccessModal(false)}
                                        style={{ width: '100%', background: primaryColor, color: '#fff', border: 0, borderRadius: 11, fontSize: '.76rem', fontWeight: 800, padding: '.7rem', cursor: 'pointer', fontFamily: 'inherit' }}
                                    >
                                        View my order summary
                                    </button>
                                </div>
                            </div>
                        )}

                        <div style={{ padding: '1.4rem .2rem .6rem', textAlign: 'center' }}>
                            <div style={{ fontSize: '2.4rem' }}>🎉</div>
                            <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.35rem', margin: '.3rem 0 .2rem', color: '#3b2a2f' }}>
                                You just backed {thanks.orgName || campaign.organization_name}!
                            </h2>
                            <p style={{ margin: 0, fontSize: '.78rem', color: '#7a6258' }}>
                                That's <b>{formatBundleCount(displayBundlesSold)} of {formatBundleCount(bundleGoal)} bundles</b>
                                {thanks.participant ? <> — {thanks.participant} gets the credit 🏅</> : null}
                            </p>
                        </div>

                        {/* One-time celebration: gentle entrance on the impact panel plus a
                            short confetti fall over the heading/impact area. Both play once
                            (forwards fill, no iteration count) and end fully transparent.
                            prefers-reduced-motion disables the entrance and hides confetti. */}
                        <style>{`
                            .fr-impact { animation: frImpactIn .5s ease both; }
                            .fr-confetti-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
                            .fr-confetti { position: absolute; opacity: 0; will-change: transform, opacity;
                                animation-name: frConfetti; animation-timing-function: cubic-bezier(.25,.6,.4,1);
                                animation-iteration-count: 1; animation-fill-mode: forwards; }
                            @keyframes frImpactIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
                            @keyframes frConfetti {
                                0%   { opacity: 0; transform: translate3d(0, -10px, 0) rotate(0deg) scale(.85); }
                                18%  { opacity: 1; }
                                75%  { opacity: 1; }
                                100% { opacity: 0; transform: translate3d(var(--fr-drift, 0px), var(--fr-fall, 70px), 0) rotate(var(--fr-spin, 200deg)) scale(1); }
                            }
                            @media (prefers-reduced-motion: reduce) {
                                .fr-impact { animation: none; }
                                .fr-confetti-layer { display: none; }
                            }
                        `}</style>

                        {/* ImpactPanel — personal contribution + live confirmation progress.
                            Reuses displayBundlesSold / displayProgressPercent / bundleGoal
                            (the single derived progress source) — no second formula. */}
                        <div className="fr-impact" style={{ position: 'relative', margin: '.2rem 0 .8rem', background: '#fff', border: '1px solid #eee2d6', borderRadius: 18, padding: '.95rem 1.05rem' }}>
                            {/* Confetti — 10 small pieces in the Fable palette, staggered,
                                each drifting/rotating once then fading out. Decorative only. */}
                            <div className="fr-confetti-layer" aria-hidden="true" style={{ borderRadius: 18 }}>
                                {CONFETTI_PIECES.map((p, i) => (
                                    <span
                                        key={i}
                                        className="fr-confetti"
                                        style={{
                                            left: p.left,
                                            top: p.top,
                                            width: p.w,
                                            height: p.h,
                                            borderRadius: p.round ? 99 : 2,
                                            background: p.color === 'primary' ? primaryColor : p.color,
                                            boxShadow: '0 1px 2px rgba(59,42,47,.18)',
                                            animationDelay: p.delay,
                                            animationDuration: p.duration,
                                            ['--fr-drift' as any]: p.drift,
                                            ['--fr-fall' as any]: p.fall,
                                            ['--fr-spin' as any]: p.spin,
                                        } as React.CSSProperties}
                                    />
                                ))}
                            </div>

                            <b style={{ display: 'block', fontFamily: SERIF, fontWeight: 400, fontSize: '1rem', color: '#3b2a2f', textAlign: 'center' }}>
                                Your order added {formatBundleCredit(thanks.unitsAdded)} bundle{thanks.unitsAdded <= 1 ? '' : 's'} toward the fundraiser goal 🎉
                            </b>
                            {/* FR-ACCEPTANCE-MOBILE-POLISH-1: the sentence above is
                                mathematically correct (thanks.unitsAdded is the actual
                                weighted total of everything in this order — see
                                computeBundleUnitsFromItems, called at submit time), but
                                unexplained on its own. This is that explanation. */}
                            <p style={{ margin: '.3rem 0 0', fontSize: '.68rem', color: '#9a8075', textAlign: 'center' }}>
                                Fundraiser goal credit: serves 5 = 1 bundle · serves 2 = ½ bundle
                            </p>

                            {/* Same visual language as the ordering-page hero bar: warm
                                #eee2d6 track, primary fill with soft glow, rounded ends. */}
                            <div
                                style={{ position: 'relative', height: 10, borderRadius: 99, background: '#eee2d6', overflow: 'hidden', margin: '.7rem 0 .4rem' }}
                                role="progressbar"
                                aria-label="Fundraiser bundle progress"
                                aria-valuenow={Math.round(displayProgressPercent)}
                                aria-valuemin={0}
                                aria-valuemax={100}
                            >
                                <i style={{ display: 'block', height: '100%', width: `${displayProgressPercent}%`, background: primaryColor, borderRadius: 99, boxShadow: `0 0 10px ${primaryColor}55`, transition: 'width .8s ease' }} />
                            </div>

                            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', fontSize: '.7rem', fontWeight: 700, color: '#6b4d3f', fontVariantNumeric: 'tabular-nums' }}>
                                <span>{formatBundleCount(displayBundlesSold)} of {formatBundleCount(bundleGoal)} bundles</span>
                                {milestoneMessage && <span style={{ marginLeft: 'auto', color: primaryColor }}>{milestoneMessage}</span>}
                            </div>

                            <p style={{ margin: '.55rem 0 0', fontSize: '.7rem', color: '#7a6258', textAlign: 'center', lineHeight: 1.4 }}>
                                You moved this fundraiser closer to its goal. Share it and help keep the momentum going.
                            </p>
                        </div>

                        {/* PaymentCard — 2px primary border per the FR handoff */}
                        <div style={{ margin: '.8rem 0', background: '#fff', border: `2px solid ${primaryColor}`, borderRadius: 18, padding: '.95rem 1.05rem', overflowWrap: 'anywhere' }}>
                            <b style={{ fontSize: '.82rem', color: '#3b2a2f' }}>💵 One last step — pay your coordinator</b>
                            <p style={{ margin: '.35rem 0 .5rem', fontSize: '.76rem', color: '#5d463d' }}>
                                {thanks.paymentInstructions
                                    ? <>{thanks.paymentInstructions} — <b>${thanks.total.toFixed(2)}</b> for order <b>#{thanks.orderRef}</b>.</>
                                    : <>Please pay {thanks.orgName || 'your coordinator'} directly — <b>${thanks.total.toFixed(2)}</b> for order <b>#{thanks.orderRef}</b>. They'll confirm the easiest way to pay.</>}
                            </p>
                            {thanks.externalPaymentLink && (
                                <a
                                    href={thanks.externalPaymentLink}
                                    target="_blank" rel="noopener noreferrer"
                                    style={{ display: 'inline-block', background: '#f6ede2', color: primaryColor, borderRadius: 10, fontSize: '.7rem', fontWeight: 800, padding: '.5rem .8rem', textDecoration: 'none', maxWidth: '100%' }}
                                >
                                    Open payment link →
                                </a>
                            )}
                        </div>

                        {/* ShareGuide — guided step-by-step replacement for the compact
                            three-button ShareRow. Same warm Fable card shell; each step is
                            a numbered row (pill + heading + one sentence + one action).
                            All three handlers are the existing hardened ones — the steps
                            are guidance only and none is a prerequisite for another. */}
                        <div style={{ margin: '0 0 .8rem', background: '#fff', border: '1px solid #eee2d6', borderRadius: 18, padding: '1rem 1.05rem .9rem' }}>
                            <b style={{ display: 'block', fontFamily: SERIF, fontWeight: 400, fontSize: '.95rem', color: '#3b2a2f' }}>Help us keep the momentum going</b>
                            <p style={{ margin: '.3rem 0 .85rem', fontSize: '.72rem', color: '#7a6258', lineHeight: 1.45 }}>
                                Every share can bring in another order and help {campaign.organization_name} move
                                closer to its {formatBundleCount(bundleGoal)}-bundle goal.
                            </p>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
                                {/* Step 1 — copy the message. Each pill column carries a thin
                                    warm connector line down to the next step (sage once the
                                    step completes); the last step has none. */}
                                <div style={{ display: 'flex', gap: '.65rem', alignItems: 'stretch' }}>
                                    <span aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
                                        <span style={{ width: 24, height: 24, borderRadius: 99, display: 'grid', placeItems: 'center', fontSize: '.66rem', fontWeight: 800, background: step1Done ? '#e8ede2' : '#f6ede2', color: step1Done ? '#4f6142' : primaryColor }}>
                                            {step1Done ? '✓' : '1'}
                                        </span>
                                        <span style={{ flex: 1, width: 2, marginTop: 4, borderRadius: 99, background: step1Done ? '#7d8f72' : '#eee2d6' }} />
                                    </span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <b style={{ fontSize: '.76rem', color: step1Done ? '#4f6142' : '#3b2a2f' }}>Copy the fundraiser message</b>
                                        <p style={{ margin: '.15rem 0 .45rem', fontSize: '.68rem', color: '#7a6258', lineHeight: 1.4 }}>
                                            We've written a short message and included the fundraiser ordering link.
                                        </p>
                                        <button onClick={handleCopy} aria-label="Copy the fundraiser share message and link" style={{ width: '100%', background: '#f6ede2', color: primaryColor, border: 0, borderRadius: 11, fontSize: '.7rem', fontWeight: 800, padding: '.6rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                                            {step1Done ? '✓ Message copied' : '🔗 Copy share message'}
                                        </button>
                                    </div>
                                </div>

                                {/* Step 2 — Facebook (still copies the caption itself, so this
                                    works even when Step 1 was skipped) */}
                                <div style={{ display: 'flex', gap: '.65rem', alignItems: 'stretch' }}>
                                    <span aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
                                        <span style={{ width: 24, height: 24, borderRadius: 99, display: 'grid', placeItems: 'center', fontSize: '.66rem', fontWeight: 800, background: '#f6ede2', color: primaryColor }}>2</span>
                                        <span style={{ flex: 1, width: 2, marginTop: 4, borderRadius: 99, background: '#eee2d6' }} />
                                    </span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <b style={{ fontSize: '.76rem', color: '#3b2a2f' }}>Share it on Facebook</b>
                                        <p style={{ margin: '.15rem 0 .45rem', fontSize: '.68rem', color: '#7a6258', lineHeight: 1.4 }}>
                                            Open Facebook, paste the message, and share it with friends and family.
                                        </p>
                                        <button onClick={handleFacebook} aria-label="Open Facebook to share the fundraiser (copies the caption first)" style={{ width: '100%', background: '#3b5998', color: '#fff', border: 0, borderRadius: 11, fontSize: '.7rem', fontWeight: 800, padding: '.6rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                                            📘 Open Facebook
                                        </button>
                                    </div>
                                </div>

                                {/* Step 3 — text friends */}
                                <div style={{ display: 'flex', gap: '.65rem', alignItems: 'flex-start' }}>
                                    <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 99, flex: 'none', display: 'grid', placeItems: 'center', fontSize: '.66rem', fontWeight: 800, background: '#f6ede2', color: primaryColor }}>3</span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <b style={{ fontSize: '.76rem', color: '#3b2a2f' }}>Text a few friends</b>
                                        <p style={{ margin: '.15rem 0 .45rem', fontSize: '.68rem', color: '#7a6258', lineHeight: 1.4 }}>
                                            Send the fundraiser directly to people who would enjoy an easy freezer meal.
                                        </p>
                                        <button onClick={handleTextIt} aria-label="Text the fundraiser message to friends" style={{ width: '100%', background: '#3b2a2f', color: '#fff', border: 0, borderRadius: 11, fontSize: '.7rem', fontWeight: 800, padding: '.6rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                                            💬 Text friends
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Shared status region — announces copy/Facebook/localhost outcomes */}
                            <div aria-live="polite">
                                {shareStatus && (
                                    <p style={{ margin: '.7rem 0 0', fontSize: '.66rem', fontWeight: 700, color: '#7a6258' }}>{shareStatus}</p>
                                )}
                            </div>

                            <p style={{ margin: '.75rem 0 0', fontFamily: SERIF, fontStyle: 'italic', fontSize: '.72rem', color: '#9a8075', textAlign: 'center' }}>
                                Even one additional order helps the fundraiser raise more. Thank you for spreading the word. 🧡
                            </p>
                        </div>

                        {/* FounderNote (tenant variant — founder identity is not in the data,
                            so the tenant display name signs the approved thank-you note) */}
                        <div style={{ margin: '0 0 .9rem', background: '#fff', border: '1px solid #eee2d6', borderRadius: 20, padding: '1rem 1.05rem', display: 'flex', gap: '.8rem' }}>
                            <span style={{ width: 44, height: 44, borderRadius: 99, flex: 'none', background: 'linear-gradient(135deg,#eccfd4,#e5b8c1)', display: 'grid', placeItems: 'center', fontSize: '1.2rem' }} aria-hidden="true">👩‍🍳</span>
                            <p style={{ margin: 0, fontFamily: SERIF, fontStyle: 'italic', fontSize: '.82rem', color: '#5d463d', lineHeight: 1.5 }}>
                                "Thank you for supporting {thanks.orgName || campaign.organization_name} — and if your freezer ever needs a refill after the fundraiser, we're here all year."
                                <span style={{ display: 'block', marginTop: '.3rem', fontFamily: 'system-ui,sans-serif', fontStyle: 'normal', fontSize: '.66rem', fontWeight: 700, color: '#9a8075' }}>
                                    — {tenantName} · <a href={`/shop/${slug}`} style={{ color: 'inherit' }}><u>visit our storefront →</u></a>
                                </span>
                            </p>
                        </div>
                    </section>
                ) : (
                <>
                    {/* ── ProgressHero card (prototype lines 510-520, with the approved
                         emphasis pass: live badge, display-scale sold count, warm stat
                         pills, thicker milestone bar). md:-mx-12 lets the hero breathe
                         slightly wider than the order column on desktop only. ── */}
                    {!blocked && (
                        <div className="md:-mx-12">
                            <div style={{ ...fableCard, padding: '1.05rem 1.15rem 1rem' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.35rem', background: '#fdf3ee', color: primaryColor, borderRadius: 99, padding: '.28rem .6rem', fontSize: '.58rem', fontWeight: 800, letterSpacing: '.12em' }}>
                                    <span style={{ width: 6, height: 6, borderRadius: 99, background: primaryColor }} aria-hidden="true" />
                                    LIVE FUNDRAISER
                                </span>

                                <h1 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.45rem', lineHeight: 1.2, margin: '.55rem 0 0', color: '#3b2a2f' }}>
                                    Help us hit <em style={{ fontStyle: 'italic', color: primaryColor }}>{formatBundleCount(bundleGoal)} bundles</em> 🧡
                                </h1>

                                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '.9rem', flexWrap: 'wrap', margin: '.75rem 0 .6rem' }}>
                                    <div>
                                        <p style={{ margin: 0, fontFamily: SERIF, fontWeight: 400, fontSize: '2.7rem', lineHeight: 1, color: primaryColor, fontVariantNumeric: 'tabular-nums' }}>
                                            {formatBundleCount(displayBundlesSold)}
                                        </p>
                                        <p style={{ margin: '.2rem 0 0', fontSize: '.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.12em', color: '#9a8075' }}>Bundles Sold</p>
                                    </div>
                                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '.45rem', flexWrap: 'wrap' }}>
                                        <div style={{ background: '#faf5ef', border: '1px solid #e9d9cb', borderRadius: 12, padding: '.4rem .7rem', textAlign: 'center' }}>
                                            <b style={{ display: 'block', fontSize: '.9rem', color: '#3b2a2f', fontVariantNumeric: 'tabular-nums' }}>{formatBundleCount(bundleGoal)}</b>
                                            <span style={{ fontSize: '.55rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: '#9a8075' }}>Bundle Goal</span>
                                        </div>
                                        {daysLeft !== null && (
                                            <div style={{ background: '#faf5ef', border: '1px solid #e9d9cb', borderRadius: 12, padding: '.4rem .7rem', textAlign: 'center' }}>
                                                <b style={{ display: 'block', fontSize: '.9rem', color: '#3b2a2f', fontVariantNumeric: 'tabular-nums' }}>{daysLeft}</b>
                                                <span style={{ fontSize: '.55rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: '#9a8075' }}>Day{daysLeft !== 1 ? 's' : ''} Left</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div
                                    style={{ position: 'relative', height: 14, borderRadius: 99, background: '#eee2d6', overflow: 'hidden' }}
                                    role="progressbar"
                                    aria-label="Fundraiser bundle progress"
                                    aria-valuenow={Math.round(displayProgressPercent)}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                >
                                    <i style={{ display: 'block', height: '100%', width: `${displayProgressPercent}%`, background: primaryColor, borderRadius: 99, boxShadow: `0 0 10px ${primaryColor}55`, transition: 'width .8s ease' }} />
                                    {/* Milestone ticks at 25 / 50 / 75 and the goal edge */}
                                    {[25, 50, 75].map(m => (
                                        <span key={m} aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: `${m}%`, width: 2, background: 'rgba(59,42,47,.15)' }} />
                                    ))}
                                    <span aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, right: 2, width: 2, background: 'rgba(59,42,47,.25)' }} />
                                </div>

                                <div style={{ display: 'flex', gap: '.5rem', margin: '.5rem 0 0', fontSize: '.7rem', fontWeight: 700, color: '#6b4d3f', flexWrap: 'wrap' }}>
                                    <span>{formatBundleCount(displayBundlesSold)} of {formatBundleCount(bundleGoal)} bundles</span>
                                    <span style={{ marginLeft: 'auto' }}>🧡 {progressMotivation}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── Blocked states (functional gating unchanged; warm neutrals) ── */}
                    {orderMode?.mode === 'closed' ? (
                        <section style={{ ...fableCard, padding: '2rem 1.2rem', textAlign: 'center' }}>
                            <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.25rem', margin: '0 0 .5rem', color: '#3b2a2f' }}>Campaign Closed</h2>
                            <p style={{ margin: 0, fontSize: '.8rem', color: '#7a6258' }}>
                                {orderMode.safeMessage || 'This campaign is closed. Order changes are no longer permitted.'}
                            </p>
                        </section>
                    ) : orderMode?.mode === 'pending' ? (
                        <section style={{ ...fableCard, padding: '2rem 1.2rem', textAlign: 'center' }}>
                            <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.25rem', margin: '0 0 .5rem', color: '#3b2a2f' }}>Bundle Selection Pending</h2>
                            <p style={{ margin: 0, fontSize: '.8rem', color: '#7a6258' }}>
                                {orderMode.safeMessage || 'The coordinator is currently selecting the bundles for this fundraiser. Please check back later to place your order.'}
                            </p>
                        </section>
                    ) : orderMode?.mode === 'invalid' || (orderMode?.mode === 'selected' && bundles.length === 0) ? (
                        <section style={{ ...fableCard, padding: '2rem 1.2rem', textAlign: 'center' }}>
                            <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1.25rem', margin: '0 0 .5rem', color: '#3b2a2f' }}>Temporarily Unavailable</h2>
                            <p style={{ margin: 0, fontSize: '.8rem', color: '#7a6258' }}>
                                {orderMode.safeMessage || "This fundraiser's bundle configuration is being updated. Please check back shortly."}
                            </p>
                        </section>
                    ) : bundles.length > 0 ? (
                        <>
                            {/* PayBadge — prototype lines 523-525.
                                FR-ACCEPTANCE-MOBILE-POLISH-1: no longer names a
                                specific payment method. This banner shows before
                                the supporter has even added anything to their
                                order, so it never had campaign-specific payment
                                data to draw on in the first place — it was simply
                                assuming "Venmo or check" for every organization.
                                The actual configured-vs-generic payment copy is
                                the PaymentCard below (rendered after ordering,
                                once the real total/campaign data is known). */}
                            <div style={{ background: '#e8ede2', borderRadius: 14, padding: '.6rem .85rem', fontSize: '.72rem', fontWeight: 700, color: '#4f6142' }}>
                                💵 No card needed here — you'll pay your coordinator directly. We'll show you how after you order.
                            </div>

                            {/* FR-ACCEPTANCE-MOBILE-POLISH-1: same explanation as
                                the post-order confirmation, offered once here too
                                — near the actual serves-5/serves-2 choice — since
                                that's the point a supporter would otherwise have
                                to guess what their pick counts toward. */}
                            <p style={{ margin: '-.2rem 0 0', fontSize: '.68rem', color: '#9a8075', textAlign: 'center' }}>
                                Fundraiser goal credit: serves 5 = 1 bundle · serves 2 = ½ bundle
                            </p>

                            {/* Bundle cards — prototype .cards / .bcard (single warm column) */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '.85rem' }}>
                                {bundles.map((bundle: any) => (
                                    <BundleCard
                                        key={bundle.id}
                                        bundle={bundle}
                                        primaryColor={primaryColor}
                                        inOrder={orderLines.some(l => l.bundleId === bundle.id)}
                                        onToggle={() => toggleLine(bundle)}
                                    />
                                ))}
                            </div>

                            {/* OrderForm card — prototype lines 554-567 */}
                            <div style={fableCard}>
                                <b style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '1rem', color: '#3b2a2f' }}>
                                    Your order · <span>${orderTotal.toFixed(2)}</span>
                                </b>

                                {orderLines.length === 0 ? (
                                    <p style={{ margin: '.6rem 0 0', fontSize: '.72rem', color: '#9a8075' }}>
                                        Tap "Add" on a bundle above to start your order.
                                    </p>
                                ) : (
                                    <div style={{ marginTop: '.6rem' }}>
                                        {orderLines.map(line => (
                                            /* FR-SHARE-COPY-1 mobile-overflow fix: the qty stepper,
                                               line total, and remove button have no shrink floor —
                                               flexWrap lets this row drop to a second line as its
                                               escape valve rather than pushing content off-screen
                                               with no way to scroll to it (a 2-digit quantity, a
                                               3-digit total, or OS font scaling can exceed the row). */
                                            <div key={line.bundleId} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '.6rem', padding: '.55rem 0', borderBottom: '1px dashed #eee2d6' }}>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <b style={{ fontSize: '.76rem', color: '#3b2a2f', display: 'block' }}>{line.name}</b>
                                                    <span style={{ fontSize: '.66rem', color: '#9a8075' }}>${line.price.toFixed(2)} each</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '.45rem' }}>
                                                    <button aria-label={`Decrease ${line.name} quantity`} onClick={() => changeQty(line.bundleId, -1)} style={qtyBtn}>−</button>
                                                    <span style={{ fontSize: '.8rem', fontWeight: 800, minWidth: '1rem', textAlign: 'center', color: '#3b2a2f' }}>{line.quantity}</span>
                                                    <button aria-label={`Increase ${line.name} quantity`} onClick={() => changeQty(line.bundleId, +1)} style={qtyBtn}>+</button>
                                                </div>
                                                <b style={{ fontSize: '.8rem', color: '#3b2a2f', fontVariantNumeric: 'tabular-nums' }}>${(line.price * line.quantity).toFixed(2)}</b>
                                                <button aria-label={`Remove ${line.name}`} onClick={() => removeLine(line.bundleId)} style={{ color: '#d8c3b5', background: 'none', border: 0, cursor: 'pointer', padding: '0 .2rem', fontSize: '.8rem' }}>✕</button>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.5rem', marginTop: '.6rem' }}>
                                    <input placeholder="Your name" aria-label="Your name" value={buyerName} onChange={e => { resetSubmissionKey(); setBuyerName(e.target.value); }} style={fableInput} />
                                    <input placeholder="Phone" aria-label="Phone" value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)} style={fableInput} />
                                </div>
                                {/* Email is required by the order API (customer record + confirmation
                                    email); Fable's prototype form omitted it — same input style, reported. */}
                                <input type="email" placeholder="Email (for your confirmation)" aria-label="Email" value={buyerEmail} onChange={e => { resetSubmissionKey(); setBuyerEmail(e.target.value); }} style={{ ...fableInput, marginTop: '.5rem' }} />

                                <label style={{ display: 'block', marginTop: '.55rem', fontSize: '.64rem', fontWeight: 800, color: '#9a8075', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                                    Who are you supporting? 🏅
                                    <input
                                        placeholder={`${campaign.participant_label || 'Participant'} name (optional)`}
                                        value={participant}
                                        onChange={e => { resetSubmissionKey(); setParticipant(e.target.value); }}
                                        style={{ ...fableInput, marginTop: '.25rem', textTransform: 'none', letterSpacing: 'normal' }}
                                    />
                                </label>

                                <button
                                    onClick={submitOrder}
                                    disabled={!canSubmit}
                                    style={{ width: '100%', marginTop: '.8rem', background: primaryColor, color: '#fff', border: 0, borderRadius: 14, padding: '.85rem', fontSize: '.9rem', fontWeight: 800, cursor: canSubmit ? 'pointer' : 'default', fontFamily: 'inherit', opacity: canSubmit ? 1 : .55 }}
                                >
                                    {submitting ? 'Placing your order…' : 'Place my order →'}
                                </button>
                                {submitError && (
                                    <p role="alert" style={{ margin: '.5rem 0 0', textAlign: 'center', fontSize: '.7rem', fontWeight: 700, color: primaryColor }}>{submitError}</p>
                                )}
                                <p style={{ margin: '.5rem 0 0', textAlign: 'center', fontSize: '.62rem', color: '#b09484' }}>
                                    No payment taken online · your order counts toward the goal instantly
                                </p>
                            </div>
                        </>
                    ) : null}

                    {/* ── Fundraiser details (required campaign data, in Fable's card idiom) ── */}
                    {(endDateStr || deliveryDateStr || pickupLocation) && (
                        <section style={fableCard}>
                            <b style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '.95rem', color: '#3b2a2f' }}>Fundraiser details</b>
                            <div style={{ marginTop: '.45rem' }}>
                                {endDateStr && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.6rem', padding: '.4rem 0', borderBottom: '1px dashed #eee2d6', fontSize: '.74rem' }}>
                                        <span style={{ color: '#9a8075', fontWeight: 700 }}>Order deadline</span>
                                        <b style={{ color: '#3b2a2f', textAlign: 'right' }}>{endDateStr}</b>
                                    </div>
                                )}
                                {deliveryDateStr && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.6rem', padding: '.4rem 0', borderBottom: '1px dashed #eee2d6', fontSize: '.74rem' }}>
                                        <span style={{ color: '#9a8075', fontWeight: 700 }}>Pickup / delivery</span>
                                        <b style={{ color: '#3b2a2f', textAlign: 'right' }}>{deliveryDateStr}{deliveryTimeStr ? ` · ${deliveryTimeStr}` : ''}</b>
                                    </div>
                                )}
                                {pickupLocation && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '.6rem', padding: '.4rem 0', fontSize: '.74rem' }}>
                                        <span style={{ color: '#9a8075', fontWeight: 700 }}>Location</span>
                                        <b style={{ color: '#3b2a2f', textAlign: 'right' }}>{pickupLocation}</b>
                                    </div>
                                )}
                            </div>
                        </section>
                    )}

                    {/* ── About (required campaign data, in Fable's card idiom) ── */}
                    {campaign.about_text && (
                        <section style={fableCard}>
                            <b style={{ fontFamily: SERIF, fontWeight: 400, fontSize: '.95rem', color: '#3b2a2f' }}>About this fundraiser</b>
                            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '.45rem 0 0', fontSize: '.78rem', color: '#5d463d', lineHeight: 1.55 }}>{campaign.about_text}</p>
                        </section>
                    )}
                </>
                )}
            </div>
        </div>
    );
}

// ─── Fable bundle card (prototype .bcard, lines 79-95 / 529-551) ─────────────
function BundleCard({ bundle, primaryColor, inOrder, onToggle }: {
    bundle: any;
    primaryColor: string;
    inOrder: boolean;
    onToggle: () => void;
}) {
    const meals = (bundle.items || [])
        .map((i: any) => i.recipe)
        .filter((r: any) => r && r.name);
    // Fable's .inside line lists what's in the bundle; meal names when we have
    // them, otherwise the bundle description.
    const inside = meals.length > 0
        ? meals.map((m: any) => m.name).join(' · ')
        : (bundle.description || '');
    // FR-COORD-123 — the label must say what the ORDER will actually record.
    //
    // This was `bundle.serving_tier === 'family' ? 'serves 5' : 'serves 2'`,
    // which recognized exactly one family spelling and defaulted everything
    // else to "serves 2". bundles.serving_tier is a free-form column, so the
    // canonical 'serves_5' — and the aliases 'family_size'/'Family Size'/
    // 'start_fresh' a tenant can pick or type in the bundle editor — would
    // have labelled a FAMILY bundle "serves 2" on the supporter page.
    //
    // resolveVariantSize is the same resolver /api/public/order uses to set
    // order_items.variant_size, so the printed label and the recorded order
    // can no longer disagree about which size this is.
    const servesLabel = resolveVariantSize(bundle.serving_tier) === 'serves_5' ? 'serves 5' : 'serves 2';
    const hasPrice = Number(bundle.price || 0) > 0;

    return (
        <div style={{ background: '#fff', border: '1px solid #eee2d6', borderRadius: 20, overflow: 'hidden' }}>
            {/* .img band — real bundle photo fills the prototype's image slot;
                warm gradient placeholder when none exists */}
            <div style={{ height: 120, display: 'grid', placeItems: 'center', fontSize: '2.2rem', background: 'linear-gradient(135deg,#f3d8c8,#eec3ad)', position: 'relative' }}>
                {bundle.image_url
                    ? <img src={bundle.image_url} alt={bundle.name} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span aria-hidden="true">🍲</span>}
            </div>
            <div style={{ padding: '.8rem .95rem .9rem' }}>
                <h3 style={{ margin: 0, fontFamily: SERIF, fontWeight: 400, fontSize: '1.05rem', color: '#3b2a2f' }}>{bundle.name}</h3>
                {inside && (
                    <p style={{ margin: '.25rem 0 .4rem', fontSize: '.7rem', color: '#9a8075', lineHeight: 1.45 }}>{inside}</p>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: '.95rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: '#3b2a2f' }}>
                            {hasPrice ? `$${Number(bundle.price).toFixed(2)}` : 'Contact for price'}
                        </span>{' '}
                        <span style={{ fontSize: '.66rem', color: '#9a8075' }}>· {servesLabel}</span>
                    </span>
                    <button
                        onClick={onToggle}
                        disabled={!hasPrice}
                        aria-pressed={inOrder}
                        aria-label={inOrder ? `Remove ${bundle.name} from your order` : `Add ${bundle.name} to your order`}
                        style={{ marginLeft: 'auto', flexShrink: 0, background: inOrder ? '#7d8f72' : primaryColor, color: '#fff', border: 0, borderRadius: 12, fontSize: '.74rem', fontWeight: 800, padding: '.55rem .95rem', cursor: hasPrice ? 'pointer' : 'default', fontFamily: 'inherit', opacity: hasPrice ? 1 : .55, whiteSpace: 'nowrap' }}
                    >
                        {inOrder ? '✓ Added' : 'Add'}
                    </button>
                </div>
            </div>
        </div>
    );
}
