"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer, AlertCircle, Package } from 'lucide-react';
import {
    readBoxLabelBatch,
    clearBoxLabelBatch,
    fetchAuthenticatedBusinessId,
} from '@/lib/printBatchStorage';
import type { SupporterBoxLabel, BlockedBoxOrder } from '@/lib/supporterBoxManifest';

/**
 * OPS-6 — the supporter outer-box label sheet.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7. This is the
 * CUSTOMER OUTER-BOX label, a different system from the meal label at
 * /production/print-batch. It says who the box belongs to, which bundle is
 * inside, what tier was sold, and which box it is — and nothing else. No
 * ingredients, no allergens, no cooking instructions: those are the meal
 * label's job, printed per meal INSIDE the box, and duplicating them here
 * would create a second place for food data to drift.
 *
 * NO SUPPORTER DATA REACHES THIS PAGE FROM THE CLIENT
 *
 * localStorage holds Order IDs; the label content is fetched from
 * /api/production/box-labels, which resolves it from the authenticated
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
 * FAIL CLOSED, IN THE PRINTABLE DOM
 *
 * The print block is `hidden print:block` — CSS-hidden but always mounted — so
 * an operator pressing Ctrl+P bypasses the button entirely and prints whatever
 * is rendered there. Blocked orders therefore render a DO NOT USE sheet rather
 * than being merely absent from the button's handler, which is what actually
 * makes an unprovable box label unprintable.
 */

interface BoxLabelResponse {
    labels: SupporterBoxLabel[];
    blocked: BlockedBoxOrder[];
    requestedCount: number;
    unavailableCount: number;
}

export default function BoxLabelsPage() {
    const [labels, setLabels] = useState<SupporterBoxLabel[] | null>(null);
    const [blocked, setBlocked] = useState<BlockedBoxOrder[]>([]);
    const [unavailableCount, setUnavailableCount] = useState(0);
    const [batchError, setBatchError] = useState<string | null>(null);
    const [batchName, setBatchName] = useState('Box Labels');
    const [isPrinting, setIsPrinting] = useState(false);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            const currentBusinessId = await fetchAuthenticatedBusinessId();
            if (cancelled) return;

            const queued = readBoxLabelBatch(currentBusinessId);
            if (!queued.ok) {
                // A batch that fails ownership verification is discarded, not
                // merely hidden, so a later reload in this browser cannot pick
                // it up. Only discarded once the tenant is actually known —
                // a transient identity failure must not destroy the operator's
                // queued work.
                if (currentBusinessId) clearBoxLabelBatch();
                setBatchError(queued.reason);
                setLabels(null);
                return;
            }

            if (queued.batch.name) setBatchName(queued.batch.name);

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
                    setLabels(null);
                    return;
                }

                const data: BoxLabelResponse = await res.json();
                if (cancelled) return;

                setBlocked(data.blocked || []);
                setUnavailableCount(data.unavailableCount || 0);

                if (!data.labels || data.labels.length === 0) {
                    setBatchError(
                        (data.blocked || []).length > 0
                            ? 'None of the selected orders could be labelled. See the reasons below.'
                            : 'No box labels could be produced for the selected orders.',
                    );
                    setLabels([]);
                    return;
                }

                setBatchError(null);
                setLabels(data.labels);
            } catch {
                if (cancelled) return;
                setBatchError('These box labels could not be prepared (the request failed). Please return to Production and try again.');
                setLabels(null);
            }
        })();

        return () => { cancelled = true; };
    }, []);

    const handlePrintAll = () => {
        // FAIL CLOSED: an order whose required truth is missing blocks the
        // whole sheet. Printing the provable ones and quietly dropping the rest
        // would hand the kitchen a stack of boxes with no way to notice one is
        // missing its label.
        if (blocked.length > 0) {
            alert(
                'Printing stopped.\n\n'
                + blocked.map(b => b.reason).join('\n\n')
                + '\n\nFix the affected order(s), or remove them from the selection, then queue the labels again.',
            );
            return;
        }
        setIsPrinting(true);
        window.print();
        setTimeout(() => setIsPrinting(false), 1000);
    };

    const totalBoxes = labels?.length ?? 0;
    const supporterCount = new Set((labels || []).map(l => l.orderId)).size;

    if (!labels && batchError) {
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

    if (!labels) return <div className="p-12 text-center print:hidden">Preparing box labels…</div>;

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
                        <p className="text-slate-500 font-medium">
                            {supporterCount} order{supporterCount === 1 ? '' : 's'}
                            {' · '}
                            {totalBoxes} box label{totalBoxes === 1 ? '' : 's'} queued
                        </p>
                    </div>
                </div>

                <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 mb-8">
                    <div className="flex flex-wrap gap-6 items-end justify-between">
                        <div>
                            <div className="text-xs font-bold text-slate-500 uppercase mb-1">Label Size</div>
                            <div className="font-bold text-slate-900 dark:text-white">4&quot; × 6&quot; (Shipping)</div>
                        </div>
                        <button
                            onClick={handlePrintAll}
                            disabled={totalBoxes === 0 || isPrinting || blocked.length > 0}
                            className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-500/20 disabled:opacity-50 flex items-center gap-2"
                        >
                            <Printer size={20} />
                            {blocked.length > 0 ? 'Printing Blocked' : 'Print All'}
                        </button>
                    </div>

                    {blocked.length > 0 && (
                        <div className="mt-6 bg-rose-50 dark:bg-rose-900/20 border-2 border-rose-300 dark:border-rose-800 rounded-xl p-5">
                            <div className="flex items-start gap-3">
                                <AlertCircle size={22} className="text-rose-600 shrink-0 mt-0.5" />
                                <div>
                                    <h4 className="font-black text-rose-900 dark:text-rose-200 mb-2">
                                        Printing stopped — these orders could not be labelled
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

                {/* On-screen queue. Same data as the printed sheet. */}
                <div className="space-y-3">
                    {labels.map((label, i) => (
                        <div key={`${label.orderItemId}-${label.physicalInstanceIndex}`} className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center gap-4">
                            <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-500 font-bold text-xs shrink-0">
                                {i + 1}
                            </div>
                            <div className="min-w-0">
                                <div className="font-bold text-slate-900 dark:text-white truncate">{label.supporterName}</div>
                                <div className="text-xs text-slate-500 font-medium truncate">
                                    {label.bundleName} · {label.servingTier} · Box {label.boxNumber} of {label.boxTotal}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* PRINT OPTIMIZED LAYOUT */}
            <div className="hidden print:block">
                <style dangerouslySetInnerHTML={{
                    __html: `
                        @media print {
                            @page {
                                size: 4in 6in;
                                margin: 0;
                            }
                            body { margin: 0; padding: 0; }
                            /* OPS-5F's rule, reused: the LAST label must not
                               force a break after itself, or an N-label run
                               emits an empty (N+1)th sheet. The exemption
                               out-specifies the general rule (0,2,0 vs 0,1,0)
                               so declaration order cannot defeat it, and the
                               final label still renders in full — only the
                               trailing break is dropped. */
                            .print-page:last-child {
                                break-after: auto;
                                page-break-after: auto;
                            }
                            .print-page {
                                break-after: always;
                                page-break-after: always;
                                width: 4in;
                                height: 6in;
                                overflow: hidden;
                                display: flex;
                                flex-direction: column;
                                justify-content: center;
                                align-items: center;
                                text-align: center;
                                padding: 0.25in;
                                box-sizing: border-box;
                            }
                        }
                    `,
                }} />

                {blocked.length > 0 ? (
                    <div className="print-page">
                        <div style={{ fontSize: '22pt', fontWeight: 900, lineHeight: 1.1, marginBottom: '12px' }}>
                            DO NOT USE
                        </div>
                        <div style={{ fontSize: '11pt', fontWeight: 'bold', lineHeight: 1.35 }}>
                            Box label printing was stopped: {blocked.length} order
                            {blocked.length === 1 ? '' : 's'} could not be labelled truthfully.
                        </div>
                        <div style={{ fontSize: '9pt', marginTop: '12px', lineHeight: 1.35 }}>
                            Return to Production, fix the affected order(s), and queue the labels again.
                        </div>
                    </div>
                ) : (
                    labels.map((label) => (
                        <div
                            key={`${label.orderItemId}-${label.physicalInstanceIndex}`}
                            className="print-page"
                        >
                            {/* Part J visual hierarchy: the supporter name is
                                the strongest element, because the packing
                                question this label answers first is "whose box
                                is this?". */}
                            <div style={{ fontSize: '30pt', fontWeight: 900, lineHeight: 1.05, marginBottom: '0.22in', wordBreak: 'break-word' }}>
                                {label.supporterName}
                            </div>
                            <div style={{ fontSize: '17pt', fontWeight: 700, lineHeight: 1.15, marginBottom: '0.06in', wordBreak: 'break-word' }}>
                                {label.bundleName}
                            </div>
                            <div style={{ fontSize: '15pt', fontWeight: 600, lineHeight: 1.2 }}>
                                {label.servingTier}
                            </div>
                            <div style={{ fontSize: '20pt', fontWeight: 900, marginTop: '0.28in', letterSpacing: '0.01em' }}>
                                Box {label.boxNumber} of {label.boxTotal}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
