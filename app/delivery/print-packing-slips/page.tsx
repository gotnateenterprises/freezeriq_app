"use client";

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Printer, Box, AlertCircle } from 'lucide-react';
import { type PhysicalBox } from '@/lib/physicalBoxPacking';
import { buildSlipBundleSections, type PackingSlipMeal } from '@/lib/packingSlipContents';
import { chooseBrandHeader, isLogoSettling, type TenantLogoStatus } from '@/lib/tenantLogo';
import {
    fetchAuthenticatedBusinessId,
    readPackingSlipBatch,
    clearPackingSlipBatch,
} from '@/lib/printBatchStorage';

/**
 * PACKING-SLIP-1 — one printed slip per PHYSICAL BOX, not per purchased
 * bundle.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7. This page holds no
 * packing rule, no identity rule and no tier rule of its own — every one of
 * those questions is answered by app/api/delivery/packing-slips/route.ts (the
 * canonical PhysicalBox[] it fetches) and lib/packingSlipContents.ts (the
 * meal-content projection). This file is presentation only.
 *
 * WHAT CHANGED FROM THE PRE-FIX PAGE
 *
 *   - Fanout: was one slip per (item, quantity-index) — i.e. per PURCHASED
 *     BUNDLE. Now one slip per `PhysicalBox`, exactly matching the outer-box
 *     sticker (two paired Serves-2 bundles -> ONE slip listing both).
 *   - Identity: was `order.customer?.contact_name || order.customer?.name ||
 *     order.customer_name` — the mutable mutable Customer relation, which for
 *     a fundraiser is the ORGANIZATION, not the supporter. Now
 *     `box.supporterName`, the same frozen order-time identity the box label
 *     already prints (fail-closed upstream: a box with no printable name
 *     never reaches this page).
 *   - Box N/M: did not exist. Now sourced only from `PhysicalBox.boxNumber` /
 *     `boxTotal`.
 *   - Branding: `businessName`/`signOff`/the review QR no longer default to
 *     literal Freezer Chef identity — see the state initializers below.
 *
 * WHAT DID NOT CHANGE (DELIBERATELY)
 *
 *   - The thank-you note and review-prompt COPY BODIES are the pre-existing
 *     text, unredesigned — this phase fixes the identity field they
 *     substitute (`{businessName}`), not the surrounding customer-experience
 *     copy. That is PACKING-SLIP-2's territory.
 *   - The Quick Tips panel: generic food-safety advice, no identity in it.
 *   - Full US Letter (8.5in x 11in) format, one page per slip. The OL600WX
 *     sticker geometry from BOX-LABEL-SHEET-1 is a different physical medium
 *     and does not apply here.
 *   - Meal contents still read LIVE `Bundle.contents` — see the module doc in
 *     lib/packingSlipContents.ts for why, and its known limitation.
 *
 * BLOCKED ORDERS: PARTIAL PRINT, NOT ALL-OR-NOTHING
 *
 * Unlike box-labels' small hand-picked batch, this page auto-loads a whole
 * week's orders. Refusing to print ANY slip because ONE historical order is
 * unpackable would be worse for the kitchen than it protects against: every
 * provable box prints, and every blocked order is named on-screen so nothing
 * is silently dropped.
 */

interface PackingSlipsResponse {
    boxes: PhysicalBox[];
    blocked: { orderId: string; reason: string }[];
    purchasedBundleCount: number;
    physicalBoxCount: number;
    largeBoxCount: number;
    smallBoxCount: number;
    deliveryDateByOrderId: Record<string, string | null>;
    mealsByOrderItemId: Record<string, PackingSlipMeal[]>;
}

const LOGO_SETTLE_TIMEOUT_MS = 2500;

const DEFAULT_THANK_YOU_NOTE = 'Dear Friend, We just wanted to take a moment to send a giant, freezer-packed THANK YOU! Every time you choose {businessName}, you\'re doing more than just making dinnertime easier (and tastier)—you\'re supporting a small, local business with a big heart. Whether you\'re stocking your freezer for a busy week, gifting meals to someone special, or just giving yourself a well-deserved break from cooking—we’re so grateful to be part of your home.';
const DEFAULT_REVIEW_PROMPT = 'If you enjoyed your {businessName} experience, we’d be so grateful if you left us a 5-star review. Your kind words help more families discover deliciously easy dinners—and keep our small business growing strong.';

export default function PrintPackingSlipsPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const deliveryWeekStart = searchParams.get('delivery_week_start');
    /**
     * OPS-6B.2: which access context this print is. `packed-ready` is the
     * PRIMARY pre-handoff print queued from Production; anything else is the
     * Delivery reprint of the active Delivery population.
     */
    const isPreHandoff = searchParams.get('source') === 'packed-ready';

    const [boxes, setBoxes] = useState<PhysicalBox[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [blocked, setBlocked] = useState<{ orderId: string; reason: string }[]>([]);
    const [counts, setCounts] = useState({ purchased: 0, physical: 0, large: 0, small: 0 });
    const [deliveryDateByOrderId, setDeliveryDateByOrderId] = useState<Record<string, string | null>>({});
    const [mealsByOrderItemId, setMealsByOrderItemId] = useState<Record<string, PackingSlipMeal[]>>({});
    const [isPreparingPrint, setIsPreparingPrint] = useState(false);

    /**
     * Tenant branding. No tenant name or logo is ever hardcoded — a null here
     * simply omits that piece of the header, exactly as
     * app/production/box-labels/page.tsx already established.
     */
    const [branding, setBranding] = useState<{ logoUrl: string | null; businessName: string | null }>({
        logoUrl: null,
        businessName: null,
    });
    const [logoStatus, setLogoStatus] = useState<TenantLogoStatus>('idle');
    const logoSettledRef = useRef<Promise<void> | null>(null);

    /**
     * Optional tenant-configurable branding elements. Each is `null` (i.e.
     * "omit this section") until this tenant's own /api/tenant/branding
     * response says otherwise — never a hardcoded identity default. The two
     * copy BODIES below are the exception: their pre-existing fallback text
     * is deliberately preserved (see the module doc above), only the
     * `{businessName}` token they substitute is fixed.
     */
    const [tagline, setTagline] = useState<string | null>(null);
    const [thankYouNote, setThankYouNote] = useState<string>(DEFAULT_THANK_YOU_NOTE);
    const [reviewPrompt, setReviewPrompt] = useState<string>(DEFAULT_REVIEW_PROMPT);
    const [signOff, setSignOff] = useState<string | null>(null);
    const [reviewQrUrl, setReviewQrUrl] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                /**
                 * OPS-6B.2 — TWO ACCESS CONTEXTS, ONE PAGE.
                 *
                 * `?source=packed-ready` is the PRIMARY pre-handoff print: the
                 * operator explicitly queued specific Packed & Ready orders in
                 * Production, and the slips go INSIDE the boxes before release.
                 * It sends opaque Order IDs to the Production route, which
                 * re-checks Packed & Ready eligibility server-side.
                 *
                 * Without it, this is the Delivery REPRINT: the shared active
                 * Delivery population for the selected week, exactly as
                 * OPS-6B.1 established.
                 *
                 * The rendering below is identical either way — deliberately.
                 * The two contexts differ only in which orders are eligible;
                 * everything the slip SAYS comes from one shared payload
                 * builder, so a reprint is the document the packer put in the box.
                 *
                 * PART H: the pre-handoff path sends NO delivery-week param.
                 * The operator picked these orders by hand; whatever week the
                 * Delivery dashboard is showing is unrelated client state and
                 * must never hide a box someone is holding.
                 */
                let res: Response;

                if (isPreHandoff) {
                    const ownerBusinessId = await fetchAuthenticatedBusinessId();
                    if (cancelled) return;
                    if (!ownerBusinessId) {
                        setLoadError('Your business could not be confirmed, so no packing slips were opened. Please reload and sign in again.');
                        setBoxes(null);
                        return;
                    }

                    const queued = readPackingSlipBatch(ownerBusinessId);
                    if (!queued.ok) {
                        // A batch that fails ownership verification is discarded,
                        // not merely hidden, so a later reload cannot pick it up.
                        clearPackingSlipBatch();
                        setLoadError(queued.reason);
                        setBoxes(null);
                        return;
                    }

                    res = await fetch('/api/production/packing-slips', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ orderIds: queued.batch.orderIds }),
                    });
                } else {
                    const qs = deliveryWeekStart ? `?delivery_week_start=${encodeURIComponent(deliveryWeekStart)}` : '';
                    res = await fetch(`/api/delivery/packing-slips${qs}`);
                }
                if (cancelled) return;

                if (!res.ok) {
                    setLoadError(
                        res.status === 401
                            ? 'Your session has expired, so packing slips were not opened. Please sign in again.'
                            : isPreHandoff
                                ? 'These packing slips could not be prepared. Please return to Production and try again.'
                                : 'Packing slips could not be prepared. Please return to Delivery and try again.',
                    );
                    setBoxes(null);
                    return;
                }

                const data: PackingSlipsResponse = await res.json();
                if (cancelled) return;

                setBlocked(data.blocked || []);
                setCounts({
                    purchased: data.purchasedBundleCount || 0,
                    physical: data.physicalBoxCount || 0,
                    large: data.largeBoxCount || 0,
                    small: data.smallBoxCount || 0,
                });
                setDeliveryDateByOrderId(data.deliveryDateByOrderId || {});
                setMealsByOrderItemId(data.mealsByOrderItemId || {});
                setBoxes(data.boxes || []);
            } catch {
                if (cancelled) return;
                setLoadError('Packing slips could not be prepared (the request failed). Please return to Delivery and try again.');
                setBoxes(null);
            }
        })();

        // Branding is deliberately a separate, un-awaited fetch: cosmetic
        // only, and must never block or fail the slips themselves — same
        // reasoning as app/production/box-labels/page.tsx.
        fetch('/api/tenant/branding')
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (cancelled || !data) return;
                setBranding({
                    logoUrl: typeof data.logo_url === 'string' && data.logo_url ? data.logo_url : null,
                    businessName: typeof data.business_name === 'string' && data.business_name.trim()
                        ? data.business_name.trim()
                        : null,
                });
                if (typeof data.tagline === 'string' && data.tagline.trim()) setTagline(data.tagline.trim());
                if (typeof data.thank_you_note === 'string' && data.thank_you_note.trim()) setThankYouNote(data.thank_you_note);
                if (typeof data.review_prompt === 'string' && data.review_prompt.trim()) setReviewPrompt(data.review_prompt);
                if (typeof data.sign_off === 'string' && data.sign_off.trim()) setSignOff(data.sign_off.trim());
                if (typeof data.review_qr_url === 'string' && data.review_qr_url.trim()) setReviewQrUrl(data.review_qr_url.trim());
            })
            .catch(() => { /* cosmetic only — never blocks printing */ });

        return () => { cancelled = true; };
    }, [deliveryWeekStart, isPreHandoff]);

    /**
     * OPS-6A.2 preload pattern, reused verbatim (see
     * app/production/box-labels/page.tsx and lib/tenantLogo.ts for why a bare
     * `onError`-only `<img>` cannot express "still loading").
     */
    useEffect(() => {
        const url = branding.logoUrl;
        if (!url) {
            setLogoStatus('idle');
            logoSettledRef.current = null;
            return;
        }

        let cancelled = false;
        setLogoStatus('pending');

        logoSettledRef.current = new Promise<void>((resolve) => {
            const probe = new window.Image();
            probe.onload = () => {
                if (!cancelled) setLogoStatus('ok');
                resolve();
            };
            probe.onerror = () => {
                if (!cancelled) setLogoStatus('failed');
                resolve();
            };
            probe.src = url;
        });

        return () => { cancelled = true; };
    }, [branding.logoUrl]);

    const handlePrint = async () => {
        setIsPreparingPrint(true);
        // Give a logo that is still in flight a BOUNDED moment to settle —
        // never waits forever, since branding is cosmetic and fails open.
        if (isLogoSettling(branding.logoUrl, logoStatus) && logoSettledRef.current) {
            await Promise.race([
                logoSettledRef.current,
                new Promise<void>((resolve) => setTimeout(resolve, LOGO_SETTLE_TIMEOUT_MS)),
            ]);
        }
        window.print();
        setIsPreparingPrint(false);
    };

    /**
     * The printed header: tenant logo, else tenant name, else nothing. Never
     * another tenant's identity, and never a hardcoded default.
     */
    const renderBrandHeader = () => {
        const choice = chooseBrandHeader(branding.logoUrl, branding.businessName, logoStatus);

        if (choice === 'logo') {
            return (
                <div className="h-28 relative w-80 mb-1">
                    <img
                        src={branding.logoUrl as string}
                        alt={branding.businessName || ''}
                        onError={() => setLogoStatus('failed')}
                        className="h-full w-full object-contain object-center"
                    />
                </div>
            );
        }
        if (choice === 'name') {
            return (
                <div className="text-3xl font-black text-slate-900 tracking-tight mb-1">
                    {branding.businessName}
                </div>
            );
        }
        return null;
    };

    if (!boxes && loadError) {
        return (
            <div className="p-12 max-w-xl mx-auto text-center print:hidden">
                <div className="flex justify-center mb-4 text-amber-500">
                    <AlertCircle size={40} />
                </div>
                <h1 className="text-2xl font-black text-slate-900 dark:text-white mb-2">No packing slips to print</h1>
                <p className="text-slate-500 font-medium mb-8">{loadError}</p>
                <button
                    onClick={() => router.back()}
                    className="inline-flex items-center gap-2 bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors"
                >
                    <ArrowLeft size={18} />
                    Back to Delivery
                </button>
            </div>
        );
    }

    if (!boxes) return <div className="p-12 text-center print:hidden">Loading packing slips...</div>;

    const supporterCount = new Set(boxes.map((b) => b.orderId)).size;
    const businessNameForCopy = branding.businessName || 'us';

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 print:bg-white">
            {/* Print Control Bar (Hidden when printing) */}
            <div className="print-hidden sticky top-0 z-50 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 p-4 shadow-sm mb-8">
                <div className="max-w-4xl mx-auto flex justify-between items-center">
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium transition-colors"
                    >
                        <ArrowLeft size={20} />
                        Back to Dashboard
                    </button>

                    <div className="flex items-center gap-4">
                        {/* OPS-6A / PACKING-SLIP-1: purchased bundles and physical
                            boxes are different numbers, and the operational one is
                            BOXES — one slip per box, not per bundle. */}
                        <div className="text-sm text-slate-500 font-medium">
                            {supporterCount} order{supporterCount === 1 ? '' : 's'}
                            {' · '}
                            {counts.purchased} bundle{counts.purchased === 1 ? '' : 's'}
                            {' · '}
                            {counts.physical} box{counts.physical === 1 ? '' : 'es'}
                        </div>
                        <button
                            onClick={handlePrint}
                            disabled={boxes.length === 0 || isPreparingPrint}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-full font-bold shadow-lg hover:shadow-indigo-500/30 transition-all flex items-center gap-2 disabled:opacity-50"
                        >
                            <Printer size={20} />
                            Print Packing Slips
                        </button>
                    </div>
                </div>

                {blocked.length > 0 && (
                    <div className="max-w-4xl mx-auto mt-4 bg-rose-50 dark:bg-rose-900/20 border-2 border-rose-300 dark:border-rose-800 rounded-xl p-5">
                        <div className="flex items-start gap-3">
                            <AlertCircle size={22} className="text-rose-600 shrink-0 mt-0.5" />
                            <div>
                                <h4 className="font-black text-rose-900 dark:text-rose-200 mb-2">
                                    {blocked.length} order{blocked.length === 1 ? '' : 's'} could not be packed — printing everything else
                                </h4>
                                <ul className="space-y-1.5">
                                    {blocked.map((b, i) => (
                                        <li key={i} className="text-sm font-medium text-rose-800 dark:text-rose-300">
                                            {b.reason}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    </div>
                )}

                {boxes.length === 0 && blocked.length === 0 && (
                    <div className="max-w-4xl mx-auto mt-4 text-sm text-slate-500 font-medium text-center">
                        No orders are due for packing slips right now.
                    </div>
                )}
            </div>

            {/* ... Print logic ... */}
            <div className="print-area">
                <style dangerouslySetInnerHTML={{
                    __html: `
                    @media print {
                        @page { margin: 0; size: 8.5in 11in; }
                        body { background: white; -webkit-print-color-adjust: exact; }
                        .print-hidden { display: none !important; }
                        .page-break { page-break-after: always; }
                        .page-break:last-child { page-break-after: auto; }
                    }
                `}} />

                {boxes.map((box) => {
                    const sections = buildSlipBundleSections(box, mealsByOrderItemId);

                    // Date Logic: Campaign > Order > Today — unchanged, now
                    // resolved server-side per order instead of per (pre-fix)
                    // slip. See lib/packingSlipContents.ts#resolveSlipDeliveryDate.
                    const rawDate = deliveryDateByOrderId[box.orderId];
                    const displayDate = rawDate
                        ? new Date(rawDate).toLocaleDateString(undefined, { timeZone: 'UTC' })
                        : new Date().toLocaleDateString();

                    return (
                        <div key={`${box.orderId}-${box.boxNumber}`} className="page-break bg-white w-[8.5in] h-[11in] mx-auto p-[0.4in] relative box-border mb-8 print:mb-0 shadow-lg print:shadow-none flex flex-col">

                            {/* Header: Centered Logo & Slogan */}
                            <div className="flex flex-col items-center border-b border-slate-100 pb-2 mb-2">
                                {renderBrandHeader()}
                                {tagline && (
                                    <div className="text-center font-medium italic text-slate-600 text-xs">
                                        "{tagline}"
                                    </div>
                                )}
                            </div>

                            {/* Supporter Info + Box N of M: Compact */}
                            <div className="bg-slate-50 px-4 py-2 rounded-lg mb-2 flex justify-between items-center border border-slate-100">
                                <div>
                                    <div className="text-[10px] uppercase font-bold text-slate-400">Prepared For</div>
                                    <div className="text-lg font-bold text-slate-900 truncate max-w-md leading-tight">{box.supporterName}</div>
                                </div>
                                <div className="text-center px-4">
                                    <div className="text-[10px] uppercase font-bold text-slate-400">Box</div>
                                    <div className="font-mono font-bold text-base leading-tight">{box.boxNumber} of {box.boxTotal}</div>
                                </div>
                                <div className="text-right">
                                    <div className="text-[10px] uppercase font-bold text-slate-400">Delivery Date</div>
                                    <div className="font-mono font-bold text-base leading-tight">{displayDate}</div>
                                </div>
                            </div>

                            {/* Thank You Section */}
                            <div className="mb-4 text-justify">
                                <div className="text-sm text-slate-600 leading-relaxed space-y-2">
                                    <p>
                                        {thankYouNote.replace(/{businessName}/g, businessNameForCopy)}
                                    </p>
                                </div>
                            </div>

                            {/* Contents: one section per DISTINCT bundle physically in this box */}
                            <div className="flex-1 min-h-0 overflow-visible">
                                <h3 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2 uppercase tracking-wider border-b border-slate-100 pb-1">
                                    <Box size={14} className="text-indigo-500" />
                                    Box Contents
                                </h3>

                                <div className="space-y-3">
                                    {sections.map((section, sIdx) => (
                                        <div key={sIdx}>
                                            <div className="text-xs text-indigo-600 font-black mb-1">
                                                {section.bundleName} — {section.servingTier}
                                                {section.count > 1 ? ` ×${section.count}` : ''}
                                            </div>
                                            {section.meals.length > 0 ? (
                                                <table className="w-full text-xs">
                                                    <tbody>
                                                        {section.meals.map((m, mIdx) => (
                                                            <tr key={mIdx} className="border-b border-dashed border-slate-100">
                                                                <td className="py-1 font-medium text-slate-700">
                                                                    {m.recipeName}
                                                                </td>
                                                                <td className="py-1 text-right font-mono text-[10px] text-slate-400 w-16">
                                                                    Qty: {m.quantity}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            ) : (
                                                <div className="text-slate-400 italic py-2 text-xs">Contents not listed.</div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Footer: Quick Tips & Review */}
                            <div className="mt-auto pt-4 border-t-2 border-slate-100 space-y-4">
                                {/* Quick Tips (Centered) — generic, no identity, unchanged */}
                                <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100">
                                    <h4 className="font-bold text-indigo-700 text-sm uppercase mb-3 text-center">
                                        💡 Quick Tips: Before Freezing & Cooking
                                    </h4>

                                    <div className="grid grid-cols-2 gap-6 text-xs text-indigo-900/80 font-medium leading-relaxed">
                                        <div className="text-center">
                                            <h5 className="font-bold text-indigo-800 mb-2">Before you put in freezer:</h5>
                                            <ul className="space-y-1 list-none">
                                                <li>• Wipe down any condensation on bag.</li>
                                                <li>• If you plan on eating one of the OVEN meals this week, place it in the fridge.</li>
                                            </ul>
                                        </div>
                                        <div className="text-center">
                                            <h5 className="font-bold text-indigo-800 mb-2">Before you Eat:</h5>
                                            <ul className="space-y-1 list-none">
                                                <li>• Please note cooking directions on each label.</li>
                                                <li>• "Serves 2" trays: replace lid with foil.</li>
                                                <li>• Only thaw instructed meals; otherwise crockpot frozen.</li>
                                                <li>• Proper thawing can take up to 36 hours.</li>
                                            </ul>
                                        </div>
                                    </div>
                                </div>

                                {/* Review / Footer Text */}
                                <div className="text-center space-y-2">
                                    <p className="font-bold text-indigo-600 text-base">💬 Love your meals? Let others know!</p>
                                    <p className="text-xs text-slate-600 max-w-2xl mx-auto leading-normal">
                                        {reviewPrompt.replace(/{businessName}/g, businessNameForCopy)} <strong className="text-indigo-600 uppercase">Review Us!</strong>
                                    </p>

                                    {reviewQrUrl && (
                                        <div className="flex justify-center items-center gap-1 pt-2">
                                            <img src={reviewQrUrl} alt="Review QR" className="w-16 h-16 object-contain" />
                                        </div>
                                    )}

                                    {signOff && (
                                        <p className="text-[10px] text-slate-400 italic mt-1">– {signOff}</p>
                                    )}

                                    {branding.businessName && (
                                        <div className="pt-2 border-t border-slate-100 flex flex-col items-center gap-1 text-[9px] text-slate-300 font-bold uppercase tracking-widest">
                                            <span>Real Meals. Real Easy. Really Local.</span>
                                            <span>{branding.businessName} © {new Date().getFullYear()}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
