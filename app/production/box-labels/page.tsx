"use client";

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer, AlertCircle, Package } from 'lucide-react';
import {
    readBoxLabelBatch,
    clearBoxLabelBatch,
    fetchAuthenticatedBusinessId,
} from '@/lib/printBatchStorage';
import {
    boxContentLines,
    formatBoxContentLine,
    type PhysicalBox,
} from '@/lib/physicalBoxPacking';
import type { BlockedBoxOrder } from '@/lib/supporterBoxManifest';
import { chooseBrandHeader, isLogoSettling, type TenantLogoStatus } from '@/lib/tenantLogo';
import { chooseStickerTypography } from '@/lib/labelTypography';
import {
    OL600_SHEET,
    FIRST_SLOT,
    LAST_SLOT,
    paginateLabelSheets,
    normalizeStartPosition,
    occupiedSlotCount,
    slotOrigin,
} from '@/lib/labelSheetLayout';

/**
 * OPS-6 / OPS-6A — the supporter outer-box label sheet.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7. This is the
 * CUSTOMER OUTER-BOX label, a different system from the meal label at
 * /production/print-batch. It says who the box belongs to, which bundles are
 * inside, what tier each was sold at, and which box it is — and nothing else.
 * No ingredients, no allergens, no cooking instructions: those are the meal
 * label's job, printed per meal INSIDE the box.
 *
 * ONE PHYSICAL BOX = ONE SHEET
 *
 * OPS-6A: a paired Serves-2 box holds two purchased bundles and gets ONE
 * label listing both. Sheets therefore equal PHYSICAL BOXES, which is
 * routinely fewer than purchased bundles. The packing itself is decided by
 * lib/physicalBoxPacking.ts — this page renders, it does not pair.
 *
 * NO SUPPORTER DATA REACHES THIS PAGE FROM THE CLIENT
 *
 * localStorage holds Order IDs; the box contents are fetched from
 * /api/production/box-labels, which resolves them from the authenticated
 * session. So the supporter's name — required printed content — is never in a
 * URL, never in browser storage, and never in this page's own history entry.
 *
 * OWNERSHIP IS PROVEN BEFORE ANYTHING RENDERS
 *
 * The queued batch is verified against the SERVER-authenticated tenant before
 * a label exists on screen, exactly as OPS-5F does for meal labels. The
 * current tenant deliberately does not come from useSession(): OPS-5B/5C/5E
 * each traced a production failure to that value being absent in Production
 * components, and an absent id would degrade a security check into "no
 * opinion".
 *
 * BRANDING FAILS OPEN, PACKING FAILS CLOSED
 *
 * The tenant logo is cosmetic. A missing logo, a failed branding request, or
 * an image that 404s at print time must never stop a kitchen from labelling
 * boxes — so branding is fetched separately, never awaited before the boxes
 * render, and degrades logo -> tenant name -> nothing. Packing truth gets the
 * opposite treatment: a blocked order renders DO NOT USE inside the
 * always-mounted print DOM, so Ctrl+P cannot bypass the gate.
 */

/**
 * How long Print will wait for a still-loading tenant logo before printing
 * the name fallback instead. Bounded on purpose: branding is cosmetic and
 * must never hold up a kitchen.
 */
const LOGO_SETTLE_TIMEOUT_MS = 2500;

/**
 * BOX-LABEL-SHEET-1 — the 4" x 2.5" OL600WX sticker.
 *
 * The label content is unchanged in MEANING from the owner-approved 4x6
 * version; only its typography is re-proportioned for a sticker with a fifth
 * of the area. It is a genuine compact layout, deliberately NOT a CSS
 * transform scale of the old page, which would have produced illegibly small
 * text and hairline strokes on a thermal/laser sticker.
 *
 * SPACE BUDGET, worst case
 *
 * Usable area after 0.12in padding: 3.76in x 2.26in.
 *
 *   header row (logo + Box N/M)  0.40in
 *   supporter name, 2 lines      0.50in
 *   contents, up to 4 rendered   0.54in
 *   LARGE/SMALL BOX              0.11in
 *   gaps                         0.17in
 *                                -------
 *                                ~1.72in against 2.26in
 *
 * CONTENT LENGTH IS BOUNDED BY THE PACKING RULES, NOT BY TRUNCATION
 *
 * A physical box holds at most TWO purchased instances (an S5 alone, or two
 * S2s), and boxContentLines merges identical ones — so a sticker can never
 * need more than TWO content lines. Nothing is ever dropped to make the
 * layout fit; long names wrap instead, and the slot's own `overflow: hidden`
 * exists solely so a pathological name can never bleed into the neighbouring
 * sticker.
 *
 * The logo is re-sized for this medium rather than inheriting the 4x6 value:
 * 1.05in on a 2.5in-tall sticker would have dominated the supporter name,
 * which is the primary operational identifier.
 */
const LOGO_MAX_HEIGHT_IN = '0.55in';
const LOGO_MAX_WIDTH_IN = '1.70in';

/** Inner padding of one sticker, keeping content off the die-cut edge. */
const LABEL_PADDING_IN = '0.12in';

interface BoxLabelResponse {
    boxes: PhysicalBox[];
    blocked: BlockedBoxOrder[];
    purchasedBundleCount: number;
    physicalBoxCount: number;
    largeBoxCount: number;
    smallBoxCount: number;
    requestedCount: number;
    unavailableCount: number;
}

export default function BoxLabelsPage() {
    const [boxes, setBoxes] = useState<PhysicalBox[] | null>(null);
    const [blocked, setBlocked] = useState<BlockedBoxOrder[]>([]);
    const [counts, setCounts] = useState({ purchased: 0, physical: 0, large: 0, small: 0 });
    const [unavailableCount, setUnavailableCount] = useState(0);
    const [batchError, setBatchError] = useState<string | null>(null);
    const [batchName, setBatchName] = useState('Box Labels');
    const [isPrinting, setIsPrinting] = useState(false);

    /**
     * BOX-LABEL-SHEET-1: which slot on the FIRST sheet to begin at, so a
     * part-used OL600WX sheet is not wasted. Print placement only — it can
     * never change how many physical boxes exist or their Box N of M.
     */
    const [startPosition, setStartPosition] = useState<number>(FIRST_SLOT);
    /**
     * Screen-only alignment mode: prints one sheet of empty slot outlines so
     * the operator can check registration on plain paper before committing
     * real label stock. Carries no supporter data whatsoever.
     */
    const [alignmentMode, setAlignmentMode] = useState(false);

    /**
     * Tenant branding, from the ONE canonical authority (/api/tenant/branding,
     * which resolves the customer-facing name through
     * lib/tenantBrand.ts customerFacingBusinessName and is scoped to the
     * server session). No second outer-label logo setting is introduced, and
     * no tenant name or logo is ever hardcoded — a null here simply prints no
     * header.
     *
     * OPS-6A.2: knowing the URL is NOT the same as knowing the image will
     * paint. `logoStatus` tracks the image itself — see the preload effect
     * below and lib/tenantLogo.ts for why the previous `logoBroken` boolean
     * could not express the state that actually broke: still loading.
     */
    const [branding, setBranding] = useState<{ logoUrl: string | null; businessName: string | null }>({
        logoUrl: null,
        businessName: null,
    });
    const [logoStatus, setLogoStatus] = useState<TenantLogoStatus>('idle');
    /**
     * Resolves once the logo has settled either way. The print handler awaits
     * this (bounded) so a fast operator does not print the name fallback for
     * a logo that was a few hundred milliseconds from being ready.
     */
    const logoSettledRef = useRef<Promise<void> | null>(null);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            const currentBusinessId = await fetchAuthenticatedBusinessId();
            if (cancelled) return;

            const queued = readBoxLabelBatch(currentBusinessId);
            if (!queued.ok) {
                // A batch that fails ownership verification is discarded, not
                // merely hidden, so a later reload in this browser cannot pick
                // it up. Only discarded once the tenant is actually known — a
                // transient identity failure must not destroy queued work.
                if (currentBusinessId) clearBoxLabelBatch();
                setBatchError(queued.reason);
                setBoxes(null);
                return;
            }

            if (queued.batch.name) setBatchName(queued.batch.name);

            // Branding is deliberately NOT awaited: it is cosmetic, and the
            // boxes below must render even if this never resolves.
            fetch('/api/tenant/branding')
                .then(res => (res.ok ? res.json() : null))
                .then(data => {
                    if (cancelled || !data) return;
                    setBranding({
                        logoUrl: typeof data.logo_url === 'string' && data.logo_url ? data.logo_url : null,
                        businessName: typeof data.business_name === 'string' && data.business_name.trim()
                            ? data.business_name.trim()
                            : null,
                    });
                })
                .catch(() => { /* cosmetic only — never blocks packing or printing */ });

            try {
                const res = await fetch('/api/production/box-labels', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderIds: queued.batch.orderIds }),
                });
                if (cancelled) return;

                if (!res.ok) {
                    setBatchError(
                        res.status === 401
                            ? 'Your session has expired, so these box labels were not opened. Please sign in again.'
                            : 'These box labels could not be prepared. Please return to Production and try again.',
                    );
                    setBoxes(null);
                    return;
                }

                const data: BoxLabelResponse = await res.json();
                if (cancelled) return;

                setBlocked(data.blocked || []);
                setUnavailableCount(data.unavailableCount || 0);
                setCounts({
                    purchased: data.purchasedBundleCount || 0,
                    physical: data.physicalBoxCount || 0,
                    large: data.largeBoxCount || 0,
                    small: data.smallBoxCount || 0,
                });

                if (!data.boxes || data.boxes.length === 0) {
                    setBatchError(
                        (data.blocked || []).length > 0
                            ? 'None of the selected orders could be packed. See the reasons below.'
                            : 'No box labels could be produced for the selected orders.',
                    );
                    setBoxes([]);
                    return;
                }

                setBatchError(null);
                setBoxes(data.boxes);
            } catch {
                if (cancelled) return;
                setBatchError('These box labels could not be prepared (the request failed). Please return to Production and try again.');
                setBoxes(null);
            }
        })();

        return () => { cancelled = true; };
    }, []);

    /**
     * OPS-6A.2 — prove the logo loads BEFORE it is ever rendered.
     *
     * The image is fetched off-DOM here. Only once its bytes have actually
     * arrived does `logoStatus` become 'ok' and the <img> get rendered — by
     * which point the browser already holds it, so it paints immediately
     * rather than being an empty box in the print capture.
     *
     * This is what makes the header impossible to blank: while the image is
     * in flight the tenant NAME is on the label, and it is only replaced once
     * there is something real to replace it with. A failure simply leaves the
     * name there permanently.
     *
     * Deliberately a plain Image() and not a hidden <img> in the tree: the
     * label's print block is display:none until @media print activates, and
     * an image that has never been asked to paint is exactly the thing that
     * was arriving unpainted at print time.
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
                // Cosmetic only. The name fallback is already on the label and
                // simply stays there.
                if (!cancelled) setLogoStatus('failed');
                resolve();
            };
            probe.src = url;
        });

        return () => { cancelled = true; };
    }, [branding.logoUrl]);

    const handlePrintAll = async () => {
        // FAIL CLOSED: an order whose required truth is missing blocks the
        // whole sheet. Printing the provable ones and quietly dropping the
        // rest would hand the kitchen a stack of boxes with no way to notice
        // one is missing its label.
        if (blocked.length > 0) {
            alert(
                'Printing stopped.\n\n'
                + blocked.map(b => b.reason).join('\n\n')
                + '\n\nFix the affected order(s), or remove them from the selection, then queue the labels again.',
            );
            return;
        }
        setIsPrinting(true);

        // OPS-6A.2: give a logo that is still in flight a BOUNDED moment to
        // settle, so an operator who clicks Print immediately does not get the
        // name fallback for a logo that was about to be ready. Never waits
        // forever — branding is cosmetic and fails open, so a slow or hanging
        // image prints the name rather than blocking the kitchen.
        if (isLogoSettling(branding.logoUrl, logoStatus) && logoSettledRef.current) {
            await Promise.race([
                logoSettledRef.current,
                new Promise<void>((resolve) => setTimeout(resolve, LOGO_SETTLE_TIMEOUT_MS)),
            ]);
        }

        window.print();
        setTimeout(() => setIsPrinting(false), 1000);
    };

    /**
     * Print one sheet of empty slot outlines so the operator can check
     * registration on plain paper before committing real label stock.
     * Carries no supporter data at all.
     */
    const handleAlignmentTest = () => {
        setAlignmentMode(true);
        setIsPrinting(true);
        // Let React commit the alignment DOM before the print snapshot.
        setTimeout(() => {
            window.print();
            setAlignmentMode(false);
            setIsPrinting(false);
        }, 100);
    };

    const supporterCount = new Set((boxes || []).map(b => b.orderId)).size;

    /**
     * BOX-LABEL-SHEET-1: physical boxes -> OL600WX sheets.
     *
     * The box list arrives already in its canonical physical order from
     * lib/physicalBoxPacking.ts; pagination preserves that order exactly and
     * neither drops nor repeats a box. One physical box remains one sticker.
     */
    const sheets = paginateLabelSheets(boxes || [], startPosition);

    /**
     * The printed header: tenant logo, else tenant name, else nothing.
     *
     * Never another tenant's identity, and never a hardcoded default — both
     * values come from this tenant's own authenticated branding response.
     *
     * OPS-6A.2: the choice lives in lib/tenantLogo.ts so it is testable. The
     * image renders ONLY on a proven-loaded status, so a configured-but-not-
     * yet-loaded logo shows the tenant name rather than a blank header.
     */
    const renderBrandHeader = () => {
        const choice = chooseBrandHeader(branding.logoUrl, branding.businessName, logoStatus);

        if (choice === 'logo') {
            return (
                <img
                    src={branding.logoUrl as string}
                    alt={branding.businessName || ''}
                    // Belt and braces: the preload already proved this loads,
                    // so this only catches an image evicted between the probe
                    // and the paint. Falling back to the name, never to blank.
                    onError={() => setLogoStatus('failed')}
                    style={{ maxHeight: LOGO_MAX_HEIGHT_IN, maxWidth: LOGO_MAX_WIDTH_IN, objectFit: 'contain', display: 'block' }}
                />
            );
        }
        if (choice === 'name') {
            return (
                <div style={{ fontSize: '12pt', fontWeight: 700, letterSpacing: '0.02em' }}>
                    {branding.businessName}
                </div>
            );
        }
        return null;
    };

    if (!boxes && batchError) {
        return (
            <div className="p-12 max-w-xl mx-auto text-center print:hidden">
                <div className="flex justify-center mb-4 text-amber-500">
                    <AlertCircle size={40} />
                </div>
                <h1 className="text-2xl font-black text-slate-900 dark:text-white mb-2">No box labels to print</h1>
                <p className="text-slate-500 font-medium mb-8">{batchError}</p>
                <Link
                    href="/production"
                    className="inline-flex items-center gap-2 bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors"
                >
                    <ArrowLeft size={18} />
                    Back to Production
                </Link>
            </div>
        );
    }

    if (!boxes) return <div className="p-12 text-center print:hidden">Preparing box labels…</div>;

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 print:bg-white">
            {/* Operator controls — never printed. */}
            <div className="print:hidden max-w-4xl mx-auto p-6">
                <div className="flex items-center gap-4 mb-8">
                    <Link href="/production" className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                        <ArrowLeft size={20} className="text-slate-500" />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
                            <Package className="text-indigo-600" />
                            {batchName}
                        </h1>
                        {/* OPS-6A: purchased bundles and physical boxes are
                            different numbers, and the operational one is
                            BOXES. Both are named so neither can be mistaken
                            for the other. */}
                        <p className="text-slate-500 font-medium">
                            {supporterCount} order{supporterCount === 1 ? '' : 's'}
                            {' · '}
                            {counts.purchased} bundle{counts.purchased === 1 ? '' : 's'}
                            {' · '}
                            {counts.physical} physical box{counts.physical === 1 ? '' : 'es'}
                            {counts.physical > 0 && ` (${counts.large} large · ${counts.small} small)`}
                        </p>
                    </div>
                </div>

                <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 mb-8">
                    <div className="flex flex-wrap gap-6 items-end justify-between">
                        <div>
                            <div className="text-xs font-bold text-slate-500 uppercase mb-1">Label Stock</div>
                            <div className="font-bold text-slate-900 dark:text-white">
                                OL600WX — 4&quot; × 2.5&quot;, 8 per sheet
                            </div>
                            <div className="text-xs text-slate-500 font-medium mt-0.5">
                                {sheets.length} sheet{sheets.length === 1 ? '' : 's'} · US Letter
                            </div>
                        </div>

                        {/* BOX-LABEL-SHEET-1: use up a part-used sheet. Print
                            placement only — it cannot change box counts or
                            Box N of M. */}
                        <div>
                            <label htmlFor="startPosition" className="block text-xs font-bold text-slate-500 uppercase mb-1">
                                Start at label position
                            </label>
                            <select
                                id="startPosition"
                                value={startPosition}
                                onChange={(e) => setStartPosition(normalizeStartPosition(e.target.value))}
                                className="p-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold"
                            >
                                {Array.from({ length: LAST_SLOT }, (_, i) => i + FIRST_SLOT).map((p) => (
                                    <option key={p} value={p}>
                                        {p === FIRST_SLOT ? 'Position 1 — New sheet' : `Position ${p}`}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <button
                            onClick={handlePrintAll}
                            disabled={counts.physical === 0 || isPrinting || blocked.length > 0}
                            className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center gap-2"
                        >
                            <Printer size={20} />
                            {blocked.length > 0 ? 'Printing Blocked' : 'Print All'}
                        </button>
                    </div>

                    {/* Printer settings the operator MUST use. Screen only —
                        never on a sticker. */}
                    <div className="mt-6 bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
                        <h4 className="font-black text-slate-900 dark:text-white text-sm mb-2">
                            Before printing on label stock
                        </h4>
                        <ul className="text-xs font-medium text-slate-600 dark:text-slate-300 space-y-1">
                            <li>Load <strong>OnlineLabels OL600 / OL600WX</strong> sheets.</li>
                            <li>Paper: <strong>US Letter 8.5 × 11</strong>, Portrait.</li>
                            <li>Scale: <strong>100% / Actual Size</strong>.</li>
                            <li>Margins: <strong>None</strong> (browser margins off).</li>
                            <li>Do <strong>not</strong> select Fit to Page or Shrink to Fit.</li>
                        </ul>
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mt-2">
                            This stock has 0.18&quot; side margins, which sit inside some printers&apos;
                            non-printable area. Run the alignment test on plain paper first.
                        </p>
                        <button
                            onClick={handleAlignmentTest}
                            disabled={isPrinting}
                            className="mt-3 border border-slate-300 dark:border-slate-600 px-4 py-2 rounded-lg font-bold text-xs hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
                        >
                            Print Alignment Test (plain paper)
                        </button>
                    </div>

                    {blocked.length > 0 && (
                        <div className="mt-6 bg-rose-50 dark:bg-rose-900/20 border-2 border-rose-300 dark:border-rose-800 rounded-xl p-5">
                            <div className="flex items-start gap-3">
                                <AlertCircle size={22} className="text-rose-600 shrink-0 mt-0.5" />
                                <div>
                                    <h4 className="font-black text-rose-900 dark:text-rose-200 mb-2">
                                        Printing stopped — these orders could not be packed
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

                    {unavailableCount > 0 && (
                        <div className="mt-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-800 rounded-xl p-4 flex items-start gap-3">
                            <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
                            <p className="text-xs font-bold text-amber-800 dark:text-amber-300">
                                {unavailableCount} selected order{unavailableCount === 1 ? ' is' : 's are'} no longer
                                available to label and {unavailableCount === 1 ? 'was' : 'were'} skipped.
                            </p>
                        </div>
                    )}
                </div>

                {/* On-screen sheet preview. Same pagination the printer gets —
                    both come from paginateLabelSheets, so what is shown here
                    and what lands on the stock cannot disagree. */}
                <div className="space-y-8">
                    {sheets.map((sheet) => (
                        <div key={sheet.sheetNumber}>
                            <div className="flex items-baseline justify-between mb-3">
                                <h3 className="font-black text-slate-900 dark:text-white">
                                    Sheet {sheet.sheetNumber} of {sheets.length}
                                </h3>
                                <span className="text-xs font-bold text-slate-500">
                                    {occupiedSlotCount(sheet)} of {OL600_SHEET.labelsPerSheet} positions used
                                </span>
                            </div>

                            {/* 2 x 4, mirroring the physical sheet's reading order. */}
                            <div className="grid grid-cols-2 gap-2">
                                {sheet.slots.map((slot) => (
                                    <div
                                        key={slot.position}
                                        className={
                                            slot.label
                                                ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-3 min-h-[4.5rem]'
                                                : 'border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-3 min-h-[4.5rem] flex items-center justify-center'
                                        }
                                    >
                                        {slot.label ? (
                                            <div className="min-w-0">
                                                <div className="flex items-baseline justify-between gap-2">
                                                    <span className="font-bold text-slate-900 dark:text-white truncate">
                                                        {slot.label.supporterName}
                                                    </span>
                                                    <span className="text-[10px] font-bold text-slate-400 shrink-0">
                                                        #{slot.position}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-slate-500 font-medium">
                                                    Box {slot.label.boxNumber} of {slot.label.boxTotal}
                                                    <span className="ml-2 uppercase text-[10px] font-bold text-slate-400">
                                                        {slot.label.boxType}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-slate-500 font-medium truncate">
                                                    {boxContentLines(slot.label).map(formatBoxContentLine).join(' + ')}
                                                </div>
                                            </div>
                                        ) : (
                                            <span className="text-xs font-bold text-slate-400">
                                                Position {slot.position} — blank
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* PRINT OPTIMIZED LAYOUT — OL600WX 8-up US Letter sheets */}
            <div className="hidden print:block">
                <style dangerouslySetInnerHTML={{
                    __html: `
                        @media print {
                            /* BOX-LABEL-SHEET-1: the printed page is now the
                               STOCK SHEET (US Letter), not a single sticker.
                               margin:0 is essential — the OL600 geometry below
                               positions every sticker from the true sheet
                               corner, so any browser margin would shift the
                               whole grid off the die-cut. */
                            @page {
                                size: 8.5in 11in;
                                margin: 0;
                            }
                            body { margin: 0; padding: 0; }
                            /* OPS-5F's rule, carried forward to sheets: the
                               LAST sheet must not force a break after itself,
                               or an N-sheet run emits an empty (N+1)th page.
                               The exemption out-specifies the general rule
                               (0,2,0 vs 0,1,0) so declaration order cannot
                               defeat it. */
                            .label-sheet:last-child {
                                break-after: auto;
                                page-break-after: auto;
                            }
                            .label-sheet {
                                break-after: always;
                                page-break-after: always;
                                position: relative;
                                width: 8.5in;
                                height: 11in;
                                overflow: hidden;
                                box-sizing: border-box;
                            }
                            /* Each sticker is absolutely placed at its exact
                               manufacturer origin. Absolute inches rather than
                               a CSS grid: a grid's rounding and gap handling
                               would drift against a die-cut sheet. */
                            .label-slot {
                                position: absolute;
                                width: ${OL600_SHEET.labelWidthIn}in;
                                height: ${OL600_SHEET.labelHeightIn}in;
                                overflow: hidden;
                                box-sizing: border-box;
                                display: flex;
                                flex-direction: column;
                                /* BOX-LABEL-SHEET-1A: share the leftover
                                   height between the blocks rather than
                                   pooling it all above the box type, which
                                   is what produced the empty canyon. The
                                   OUTER rectangle is untouched — this only
                                   affects distribution inside it, so print
                                   registration cannot move. */
                                justify-content: space-between;
                                padding: ${LABEL_PADDING_IN};
                            }
                            .align-slot {
                                position: absolute;
                                width: ${OL600_SHEET.labelWidthIn}in;
                                height: ${OL600_SHEET.labelHeightIn}in;
                                box-sizing: border-box;
                                border: 1px dashed #999;
                                border-radius: ${OL600_SHEET.cornerRadiusIn}in;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            }
                        }
                    `,
                }} />

                {blocked.length > 0 ? (
                    /* FAIL CLOSED, unchanged in intent: a batch that cannot be
                       packed truthfully prints a single refusal sheet rather
                       than any sticker at all. */
                    <div className="label-sheet" style={{ padding: '1in', textAlign: 'center' }}>
                        <div style={{ fontSize: '28pt', fontWeight: 900, lineHeight: 1.1, marginBottom: '0.2in' }}>
                            DO NOT USE
                        </div>
                        <div style={{ fontSize: '13pt', fontWeight: 'bold', lineHeight: 1.35 }}>
                            Box label printing was stopped: {blocked.length} order
                            {blocked.length === 1 ? '' : 's'} could not be packed truthfully.
                        </div>
                        <div style={{ fontSize: '11pt', marginTop: '0.15in', lineHeight: 1.35 }}>
                            Return to Production, fix the affected order(s), and queue the labels again.
                        </div>
                    </div>
                ) : alignmentMode ? (
                    /* ALIGNMENT TEST: one sheet of empty slot outlines, for
                       checking registration on plain paper before committing
                       real stock. Deliberately carries NO supporter data. */
                    <div className="label-sheet">
                        {Array.from({ length: OL600_SHEET.labelsPerSheet }, (_, i) => {
                            const position = i + FIRST_SLOT;
                            const { leftIn, topIn } = slotOrigin(position);
                            return (
                                <div
                                    key={position}
                                    className="align-slot"
                                    style={{ left: `${leftIn}in`, top: `${topIn}in` }}
                                >
                                    <div style={{ textAlign: 'center', fontSize: '10pt', fontWeight: 700 }}>
                                        <div style={{ fontSize: '20pt', fontWeight: 900 }}>{position}</div>
                                        <div style={{ opacity: 0.7 }}>
                                            {OL600_SHEET.labelWidthIn}&quot; × {OL600_SHEET.labelHeightIn}&quot;
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    sheets.map((sheet) => (
                        <div key={sheet.sheetNumber} className="label-sheet">
                            {sheet.slots.map((slot) => {
                                // A blank slot is a deliberately skipped
                                // sticker (a part-used sheet), never a missing
                                // physical box. Nothing is rendered into it.
                                if (!slot.label) return null;
                                const box = slot.label;
                                const contentLines = boxContentLines(box);
                                // BOX-LABEL-SHEET-1A: size the two variable
                                // elements from facts already known here —
                                // name length and content count — so the
                                // print result stays deterministic. No DOM
                                // measurement, no shrink-to-fit.
                                const type = chooseStickerTypography(box.supporterName, contentLines.length);
                                return (
                                    <div
                                        key={slot.position}
                                        className="label-slot"
                                        style={{ left: `${slot.leftIn}in`, top: `${slot.topIn}in` }}
                                    >
                                        {/* Header row: brand on the left, Box N of M
                                            on the right. Sharing one row is what buys
                                            the vertical space the supporter name needs
                                            on a 2.5in sticker. */}
                                        <div style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                            gap: '0.08in', minHeight: LOGO_MAX_HEIGHT_IN, marginBottom: '0.04in',
                                        }}>
                                            <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                                                {renderBrandHeader()}
                                            </div>
                                            <div style={{ fontSize: '10pt', fontWeight: 900, whiteSpace: 'nowrap', letterSpacing: '0.01em' }}>
                                                Box {box.boxNumber} of {box.boxTotal}
                                            </div>
                                        </div>

                                        {/* The primary operational identifier: whose
                                            box is this, readable from several feet
                                            away. Always the largest text here. */}
                                        <div style={{
                                            fontSize: `${type.nameSizePt}pt`, fontWeight: 900, lineHeight: 1.05,
                                            marginBottom: '0.06in', wordBreak: 'break-word',
                                        }}>
                                            {box.supporterName}
                                        </div>

                                        {/* Everything physically in this carton. A
                                            paired Serves-2 box lists both bundles;
                                            identical purchases merge to "... ×2".
                                            Bounded to two entries by the packing
                                            rules, so nothing is ever dropped to fit. */}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.02in' }}>
                                            {contentLines.map((line, i) => (
                                                <div
                                                    key={i}
                                                    style={{ fontSize: `${type.contentSizePt}pt`, fontWeight: 700, lineHeight: 1.25, wordBreak: 'break-word' }}
                                                >
                                                    {formatBoxContentLine(line)}
                                                </div>
                                            ))}
                                        </div>

                                        {/* Operationally useful, deliberately
                                            subordinate to the supporter name.
                                            BOX-LABEL-SHEET-1A: no longer pushed to
                                            the floor with marginTop:auto — the slot
                                            distributes its slack instead, so the
                                            sticker reads as composed rather than as
                                            content stranded above an empty canyon. */}
                                        <div style={{
                                            fontSize: '8pt', fontWeight: 800, letterSpacing: '0.08em',
                                            textTransform: 'uppercase', opacity: 0.75,
                                        }}>
                                            {box.boxType} box
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
