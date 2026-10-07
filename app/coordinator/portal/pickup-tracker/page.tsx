'use client';

/**
 * COORD-FULFILLMENT-2 — the printable day-of pickup tracker.
 *
 * The coordinator opens this, hits Print, and either prints it or saves it as a
 * PDF from the browser's own print dialog. No PDF library: the browser already
 * does this well, and adding a document-generation subsystem to maintain would
 * cost far more than the print stylesheet below.
 *
 * All data comes from /api/coordinator/pickup-tracker, which resolves the
 * campaign from the coordinator session — there is no campaign id in this URL
 * for anyone to tamper with.
 *
 * The checkbox is PAPER ONLY. Nothing about it is persisted; there is no
 * per-supporter picked-up state in FreezerIQ, and this phase deliberately does
 * not invent one.
 *
 * FR-SUPPORTER-PAYMENT-STATUS-1: the PAYMENT column is different — it prints
 * what the coordinator recorded in FreezerIQ (Order.paid_at). It is read-only
 * here; marking happens in the portal's order list. When nothing is marked it
 * prints an empty box, so a volunteer can still tick it by hand at the table.
 * It never prints "UNPAID": no order carries evidence that a supporter did not
 * pay, only whether the coordinator has recorded that they did.
 *
 * COORD-CLOSEOUT-PICKUP-1: closeout, not invoice payment, makes this the final
 * list. The page now says which it is — not final yet, or the final list with
 * its production-release state — in a screen-only callout plus one compact
 * printed line, so the paper stays usable on pickup day.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import {
    formatServingTier,
    PICKUP_DOCUMENT_STATUS_COPY,
    type PickupDocumentState,
} from '@/lib/coordinatorSupporterOrders';
import type { GroupPaymentSummary } from '@/lib/supporterPayment';

/** The one printed line: final list or not, and the production-release state. */
const PRINTED_STATUS: Readonly<Record<PickupDocumentState, string>> = {
    not_final: 'Not final — ordering is still open.',
    final_pending_release: 'Final order list — food not yet released to production.',
    final_released: 'Final order list — food released to production.',
    final_empty: 'Final order list — no orders were placed.',
};

const STATUS_TONE: Readonly<Record<PickupDocumentState, string>> = {
    not_final: 'border-slate-200 bg-slate-50 text-slate-700',
    final_pending_release: 'border-amber-200 bg-amber-50 text-amber-900',
    final_released: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    final_empty: 'border-slate-200 bg-slate-50 text-slate-700',
};

interface ManifestItem {
    quantity: number;
    variant_size: string | null;
    item_name: string | null;
}

interface ManifestGroup {
    key: string;
    customer_name: string | null;
    participant_name: string | null;
    email: string | null;
    phone: string | null;
    items: ManifestItem[];
    total: number;
    firstOrderedAt: string | null;
    /** FR-SUPPORTER-PAYMENT-STATUS-1. Optional so a response cached from before
     *  this field existed renders as "not marked" instead of failing. */
    payment?: GroupPaymentSummary;
}

interface Manifest {
    campaign: {
        name: string | null;
        organization_name: string | null;
        tenant_name: string | null;
        delivery_date: string | null;
        delivery_time: string | null;
        pickup_location: string | null;
        payment_instructions: string | null;
    };
    /** COORD-CLOSEOUT-PICKUP-1. Optional so a response from before this field
     *  existed still renders. */
    document?: { final: boolean; state: PickupDocumentState };
    groups: ManifestGroup[];
    supporterCount: number;
    totalBundles: number;
    generatedAt: string;
}

/** DATE column: render in UTC so a date-only value cannot slip a day. */
function formatDeliveryDate(value: string | null): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
}

function formatGeneratedAt(value: string): string {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
}

export default function PickupTrackerPage() {
    const router = useRouter();
    const [manifest, setManifest] = useState<Manifest | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch('/api/coordinator/pickup-tracker');
                if (!res.ok) {
                    const body = await res.json().catch(() => null);
                    throw new Error(body?.error || `Could not load the pickup tracker (${res.status})`);
                }
                const data = await res.json();
                if (!cancelled) setManifest(data);
            } catch (e: any) {
                if (!cancelled) setError(e.message || 'Could not load the pickup tracker');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (loading) {
        return <div className="p-8 text-sm text-slate-500">Loading pickup tracker…</div>;
    }

    if (error || !manifest) {
        return (
            <div className="p-8">
                <p className="text-sm text-red-600">{error || 'Pickup tracker unavailable.'}</p>
                <button onClick={() => router.push('/coordinator/portal')}
                    className="mt-4 text-sm font-bold text-indigo-600">← Back to portal</button>
            </div>
        );
    }

    const { campaign, groups } = manifest;
    const deliveryDate = formatDeliveryDate(campaign.delivery_date);
    const documentState = manifest.document?.state ?? null;

    return (
        <div className="min-h-screen bg-slate-50 print:bg-white">
            {/* Screen-only toolbar. `no-print` removes it from the printout. */}
            <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
                <button onClick={() => router.push('/coordinator/portal')}
                    className="flex items-center gap-1.5 text-sm font-bold text-slate-600 hover:text-slate-900">
                    <ArrowLeft size={16} /> Back
                </button>
                <button onClick={() => window.print()}
                    className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700">
                    <Printer size={16} /> Print / Save as PDF
                </button>
            </div>

            <div className="mx-auto max-w-4xl bg-white p-6 print:max-w-none print:p-0">
                {/* COORD-CLOSEOUT-PICKUP-1 — screen-only: what this list is. The
                    printed sheet carries the one-line version in its header. */}
                {documentState && (
                    <div role="status" data-document-state={documentState}
                        className={`no-print mb-4 rounded-xl border px-4 py-3 text-[13px] font-semibold leading-relaxed ${STATUS_TONE[documentState]}`}>
                        {PICKUP_DOCUMENT_STATUS_COPY[documentState]}
                    </div>
                )}

                {/* ── Campaign header ─────────────────────────────────────── */}
                <header className="border-b-2 border-slate-900 pb-3">
                    <h1 className="text-2xl font-black text-slate-900">
                        {campaign.name || 'Fundraiser'} — Pickup Tracker
                    </h1>
                    <p className="mt-0.5 text-sm text-slate-700">
                        {campaign.organization_name}
                        {campaign.tenant_name ? ` · ${campaign.tenant_name}` : ''}
                    </p>
                    <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-slate-800">
                        {deliveryDate && (
                            <div><dt className="inline font-bold">Pickup date: </dt><dd className="inline">{deliveryDate}</dd></div>
                        )}
                        {campaign.delivery_time && (
                            <div><dt className="inline font-bold">Time: </dt><dd className="inline">{campaign.delivery_time}</dd></div>
                        )}
                        {campaign.pickup_location && (
                            <div><dt className="inline font-bold">Location: </dt><dd className="inline">{campaign.pickup_location}</dd></div>
                        )}
                    </dl>
                    <p className="mt-2 text-[12px] text-slate-600">
                        <strong>{manifest.supporterCount}</strong> supporter{manifest.supporterCount === 1 ? '' : 's'}
                        {' · '}<strong>{manifest.totalBundles}</strong> bundle{manifest.totalBundles === 1 ? '' : 's'}
                        {' · '}Printed {formatGeneratedAt(manifest.generatedAt)}
                    </p>
                    {/* COORD-CLOSEOUT-PICKUP-1: the final list and the production
                        release are separate facts; one small line keeps both. */}
                    {documentState && (
                        <p className="mt-1 text-[12px] font-bold text-slate-800" data-printed-status={documentState}>
                            {PRINTED_STATUS[documentState]}
                        </p>
                    )}
                    {campaign.payment_instructions && (
                        <p className="mt-1 text-[12px] text-slate-600">
                            <strong>Payment:</strong> {campaign.payment_instructions}
                        </p>
                    )}
                    {/* FR-SUPPORTER-PAYMENT-STATUS-1: says what the column means,
                        so nobody reads an empty box as "this person did not pay". */}
                    <p className="mt-1 text-[11px] text-slate-600">
                        <strong>✓ Paid</strong> = marked paid in your FreezerIQ order list. An empty box
                        means payment has not been marked yet.
                    </p>
                    <p className="mt-1 text-[11px] text-slate-500">
                        Contains supporter contact information — handle securely.
                    </p>
                </header>

                {/* ── Supporter rows ───────────────────────────────────────── */}
                {groups.length === 0 ? (
                    // COORD-CLOSEOUT-PICKUP-1: closeout, not invoice payment, fills
                    // this list — so an empty list says which side of closeout it is on.
                    <p className="py-8 text-sm text-slate-500" data-empty-state={documentState ?? 'unknown'}>
                        {manifest.document?.final
                            ? 'No orders were placed in this fundraiser.'
                            : 'Your final pickup list fills in with every order as soon as this fundraiser closes. Until then, new orders appear in Recent orders on your portal.'}
                    </p>
                ) : (
                    <div className="mt-2 overflow-x-auto print:overflow-visible">
                        {/* PICKUP-TRACKER-READABILITY-1: one black-ruled grid so a row can be
                            followed across the page on paper. Presentation only — the same
                            groups, in the same order, with the same cells' content as the
                            list this replaced. The grid and the alternating shade are styled
                            by .pickup-grid in the style block below and nowhere else. */}
                        <table className="pickup-grid w-full text-left" data-pickup-grid>
                            <thead>
                                <tr>
                                    <th scope="col" className="pickup-col-check">Picked up</th>
                                    <th scope="col" className="pickup-col-supporter">Supporter</th>
                                    <th scope="col" className="pickup-col-order">Order</th>
                                    <th scope="col" className="pickup-col-total">Total</th>
                                    <th scope="col" className="pickup-col-pay">Payment</th>
                                </tr>
                            </thead>
                            <tbody>
                                {groups.map((g) => (
                                    <tr key={g.key} className="supporter-row">
                                        <td className="pickup-col-check">
                                            {/* Check-off box. Paper only — not persisted. */}
                                            <span aria-hidden className="mx-auto block h-7 w-7 border-2 border-slate-900" />
                                        </td>

                                        <td>
                                            <p className="text-[15px] font-black uppercase tracking-wide text-slate-900">
                                                {g.customer_name || 'Supporter'}
                                            </p>

                                            <p className="text-[12px] text-slate-700">
                                                {g.email && <span className="mr-3 [overflow-wrap:anywhere]">{g.email}</span>}
                                                {g.phone && <span className="mr-3 whitespace-nowrap">{g.phone}</span>}
                                                {g.participant_name && <span className="text-slate-600">for {g.participant_name}</span>}
                                            </p>
                                        </td>

                                        <td>
                                            <ul className="text-[13px] text-slate-900">
                                                {g.items.map((it, idx) => {
                                                    const tier = formatServingTier(it.variant_size);
                                                    return (
                                                        <li key={idx}>
                                                            <span className="font-bold">{it.item_name || 'Item'}</span>
                                                            {tier ? <span> | <span className="whitespace-nowrap">{tier}</span></span> : null}
                                                            <span> | <span className="whitespace-nowrap">Qty {it.quantity}</span></span>
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </td>

                                        <td className="pickup-col-total">
                                            <span className="text-[13px] font-bold tabular-nums text-slate-900">
                                                ${Number(g.total || 0).toFixed(2)}
                                            </span>
                                        </td>

                                        <td className="pickup-col-pay">
                                            {/* FR-SUPPORTER-PAYMENT-STATUS-1: what the coordinator
                                                recorded. Blank box when not marked — tickable by hand. */}
                                            {g.payment?.state === 'paid' ? (
                                                <span className="whitespace-nowrap text-[12px] font-black uppercase tracking-wide text-slate-900" data-payment-state="paid">
                                                    ✓ Paid
                                                </span>
                                            ) : g.payment?.state === 'partly_marked' ? (
                                                <span className="whitespace-nowrap text-[12px] font-black uppercase tracking-wide text-slate-900" data-payment-state="partly_marked">
                                                    Paid {g.payment.paidCount} of {g.payment.orderCount}
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide text-slate-700" data-payment-state="not_marked">
                                                    Paid
                                                    <span aria-hidden className="inline-block h-5 w-5 border-2 border-slate-900" />
                                                </span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <style jsx global>{`
                /* PICKUP-TRACKER-READABILITY-1 — every rule below is scoped to
                   .pickup-grid, so no other FreezerIQ table is touched.
                   Grid: solid black, 1px, on the table, header and every cell.
                   Stripe: #E2E8F0 (Tailwind slate-200) on every even body row —
                   white, gray, white, gray. It is set on the cells, not the row,
                   so every printed cell carries its own background, and
                   print-color-adjust keeps that background on paper. */
                .pickup-grid {
                    /* On a phone the wrapper scrolls sideways instead of crushing the
                       columns to a word per line. Paper is wider than this: no effect. */
                    min-width: 42rem;
                    border-collapse: collapse;
                    border: 1px solid #000;
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                }
                .pickup-grid th,
                .pickup-grid td {
                    border: 1px solid #000;
                    padding: 0.4rem 0.5rem;
                    vertical-align: top;
                    text-align: left;
                }
                .pickup-grid th {
                    background-color: #fff;
                    font-size: 11px;
                    font-weight: 800;
                    letter-spacing: 0.06em;
                    text-transform: uppercase;
                }
                .pickup-grid thead { display: table-header-group; }
                .pickup-grid tbody tr:nth-child(even) > td { background-color: #E2E8F0; }
                .pickup-grid .pickup-col-check { width: 3.75rem; text-align: center; }
                .pickup-grid .pickup-col-supporter { width: 24%; }
                .pickup-grid .pickup-col-order { width: 42%; }
                .pickup-grid .pickup-col-total { width: 4.5rem; text-align: right; }
                .pickup-grid .pickup-col-pay { width: 7.5rem; }
                @media print {
                    /* Toolbar and any other chrome must not reach paper. */
                    .no-print { display: none !important; }
                    @page { margin: 0.5in; }
                    body { background: #fff; }
                    /* Keep one supporter's whole order on one page where it fits. */
                    .supporter-row {
                        break-inside: avoid;
                        page-break-inside: avoid;
                    }
                    /* Black on white: no ink-heavy backgrounds. */
                    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                }
            `}</style>
        </div>
    );
}
