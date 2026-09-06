"use client";

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Printer, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { boxContentLines, formatBoxContentLine, type PhysicalBox } from '@/lib/physicalBoxPacking';

/**
 * OPS-6B — the driver/handoff manifest, on the CANONICAL physical-box authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 Rule 8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG — a signed document that need not add up
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This page carried TWO different box classifiers, in one file, disagreeing
 * with each other and with the rest of the app:
 *
 *   - `isLargeBox()` (manifest rows): `serving_tier` first, SHORT-CIRCUITING on
 *     any explicit non-family tier before the name fallback could run.
 *   - the receipt-page reduce: `variant_size` first, then bundle-NAME
 *     substrings, then `serving_tier`, with `|| !item.variant_size` treating a
 *     missing tier as LARGE.
 *
 * So the same order could print one box count in the manifest table and a
 * different one on its own receipt page, in the same print job. Both counted
 * purchased BUNDLES rather than cartons, so neither ever paired two Serves-2
 * bundles into the single large carton they actually travel in.
 *
 * Worse, the totals row did not sum its own columns:
 *
 *     const totalLarge = stats?.largeBoxesNeeded ?? manifestRows.reduce(...)
 *
 * `??` only falls back when stats is null, so whenever the stats call
 * succeeded the printed footer showed the STATS population (unbounded, no
 * canceled_at) while the rows above came from a different, 30-day-bounded
 * query. A document the driver and the fundraiser manager both SIGN could
 * state a total that contradicted the lines above it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOW
 * ══════════════════════════════════════════════════════════════════════════
 *
 * One population, one authority: the page reads PhysicalBox[] from
 * /api/delivery/packing-slips — the same route the packing slips themselves
 * use — and every number on the page, rows and totals alike, is derived by
 * counting those boxes. The totals row is the sum of the printed rows by
 * construction, because it is computed from the same array.
 *
 * Orders the packing authority could not prove are NOT silently dropped: they
 * are listed explicitly, because a stop missing from a logistics document is
 * how a delivery goes missing.
 *
 * Route order is preserved: the route returns boxes already in delivery
 * sequence, and this page never re-sorts them.
 */

interface ManifestResponse {
    boxes: PhysicalBox[];
    blocked: { orderId: string; reason: string }[];
    physicalBoxCount: number;
    largeBoxCount: number;
    smallBoxCount: number;
}

/** One delivery stop: every physical carton belonging to one source Order. */
interface ManifestStop {
    orderId: string;
    supporterName: string;
    boxes: PhysicalBox[];
    large: number;
    small: number;
}

/**
 * Group boxes into stops, preserving the order the route returned them in
 * (which is delivery sequence). Never re-sorted here.
 */
function groupIntoStops(boxes: readonly PhysicalBox[]): ManifestStop[] {
    const stops: ManifestStop[] = [];
    const byId = new Map<string, ManifestStop>();

    for (const box of boxes || []) {
        let stop = byId.get(box.orderId);
        if (!stop) {
            stop = { orderId: box.orderId, supporterName: box.supporterName, boxes: [], large: 0, small: 0 };
            byId.set(box.orderId, stop);
            stops.push(stop);
        }
        stop.boxes.push(box);
        if (box.boxType === 'large') stop.large += 1;
        else stop.small += 1;
    }

    return stops;
}

export default function PrintManifestPage() {
    const [stops, setStops] = useState<ManifestStop[]>([]);
    const [blocked, setBlocked] = useState<{ orderId: string; reason: string }[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [logo, setLogo] = useState<string | null>(null);
    const date = new Date().toLocaleDateString();

    const searchParams = useSearchParams();
    const deliveryWeekStart = searchParams.get('delivery_week_start');
    const weekParamFirst = deliveryWeekStart ? `?delivery_week_start=${deliveryWeekStart}` : '';

    useEffect(() => {
        let cancelled = false;

        const fetchData = async () => {
            try {
                const [slipsRes, bizRes] = await Promise.all([
                    fetch(`/api/delivery/packing-slips${weekParamFirst}`),
                    fetch('/api/business'),
                ]);
                if (cancelled) return;

                if (!slipsRes.ok) {
                    setLoadError(slipsRes.status === 401
                        ? 'Your session has expired, so the manifest was not prepared. Please sign in again.'
                        : 'The manifest could not be prepared. Please return to Delivery and try again.');
                    setStops([]);
                    return;
                }

                const data: ManifestResponse = await slipsRes.json();
                if (cancelled) return;

                setStops(groupIntoStops(data.boxes || []));
                setBlocked(data.blocked || []);

                if (bizRes.ok) {
                    const bizData = await bizRes.json();
                    if (bizData.logo_url) setLogo(bizData.logo_url);
                }
            } catch (err) {
                if (cancelled) return;
                setLoadError('The manifest could not be prepared (the request failed).');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchData();
        // Refetch when the selected week changes. The previous version had an
        // EMPTY dependency array while closing over the week param, so changing
        // week silently reprinted the previous week's manifest.
        return () => { cancelled = true; };
    }, [weekParamFirst]);

    if (loading) return <div className="p-12 text-center">Loading manifest...</div>;

    // Totals are the SUM OF THE PRINTED ROWS, by construction — never a second
    // number from a different population.
    const totalLarge = stops.reduce((sum, s) => sum + s.large, 0);
    const totalSmall = stops.reduce((sum, s) => sum + s.small, 0);

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 print:bg-white p-8">
            {/* No-Print Header */}
            <div className="print:hidden flex justify-between items-center mb-8 max-w-5xl mx-auto">
                <Link href="/delivery" className="flex items-center gap-2 text-slate-500 hover:text-slate-700">
                    <ArrowLeft size={16} /> Back to Dashboard
                </Link>
                <button
                    onClick={() => window.print()}
                    className="bg-indigo-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-indigo-700 flex items-center gap-2"
                >
                    <Printer size={18} /> Print Manifest
                </button>
            </div>

            {loadError && (
                <div className="print:hidden max-w-5xl mx-auto mb-6 bg-amber-50 border-2 border-amber-300 rounded-2xl p-4 text-sm font-bold text-amber-800">
                    {loadError}
                </div>
            )}

            {/* Print Sheet */}
            <div className="bg-white shadow-xl print:shadow-none max-w-5xl mx-auto p-8 min-h-[11in] relative">
                <div className="flex justify-between items-end border-b-4 border-black pb-4 mb-6">
                    <div className="flex flex-col gap-4">
                        {logo && (
                            <div className="h-16 relative w-48">
                                <img src={logo} alt="Logo" className="h-full w-full object-contain object-left" />
                            </div>
                        )}
                        <div>
                            <h1 className="text-4xl font-black uppercase tracking-tighter">Shipping Manifest</h1>
                            <p className="text-xl font-bold text-slate-500 mt-1">Delivery Run: {date}</p>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="font-bold text-lg">Total Boxes</div>
                        <div className="text-sm">Large (Family): <span className="font-bold text-lg">{totalLarge}</span></div>
                        <div className="text-sm">Small (Std): <span className="font-bold text-lg">{totalSmall}</span></div>
                    </div>
                </div>

                {/* A stop that could not be proven is NAMED, not omitted. */}
                {blocked.length > 0 && (
                    <div className="mb-6 border-2 border-black p-4">
                        <div className="flex items-center gap-2 font-black uppercase text-sm mb-2">
                            <AlertCircle size={16} />
                            {blocked.length} order{blocked.length === 1 ? '' : 's'} not on this manifest
                        </div>
                        <ul className="text-xs space-y-1">
                            {blocked.map((b, i) => <li key={i}>{b.reason}</li>)}
                        </ul>
                    </div>
                )}

                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="border-b-2 border-black text-sm uppercase">
                            <th className="py-2 w-12 text-center">#</th>
                            <th className="py-2 w-1/4">Customer</th>
                            <th className="py-2">Bundles (Contents)</th>
                            <th className="py-2 w-20 text-center">Lg Box</th>
                            <th className="py-2 w-20 text-center">Sm Box</th>
                        </tr>
                    </thead>
                    <tbody className="text-sm">
                        {stops.map((stop, index) => (
                            <tr key={stop.orderId} className="border-b border-slate-300">
                                <td className="py-3 text-center font-bold text-slate-500">{index + 1}</td>
                                <td className="py-3 font-bold">{stop.supporterName}</td>
                                <td className="py-3 text-slate-600">
                                    {stop.boxes.flatMap(b => boxContentLines(b).map(formatBoxContentLine)).join(', ')}
                                </td>
                                <td className="py-3 text-center font-mono font-bold text-lg">{stop.large || '-'}</td>
                                <td className="py-3 text-center font-mono font-bold text-lg">{stop.small || '-'}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-black">
                            <td colSpan={3} className="py-3 text-right font-black uppercase text-sm">Totals:</td>
                            <td className="py-3 text-center font-mono font-black text-xl">{totalLarge}</td>
                            <td className="py-3 text-center font-mono font-black text-xl">{totalSmall}</td>
                        </tr>
                    </tfoot>
                </table>

                <div className="absolute bottom-8 left-8 right-8 pt-8 border-t-2 border-black flex justify-between items-end">
                    <div className="flex gap-16">
                        <div>
                            <p className="font-bold">Driver Signature:</p>
                            <div className="border-b border-black w-64 h-8 mt-2"></div>
                        </div>
                        <div>
                            <p className="font-bold">Fundraiser Manager Signature:</p>
                            <div className="border-b border-black w-64 h-8 mt-2"></div>
                        </div>
                        <div>
                            <p className="font-bold">Date:</p>
                            <div className="border-b border-black w-32 h-8 mt-2"></div>
                        </div>
                    </div>
                    <div className="text-right text-xs text-slate-400 pb-2">
                        Delivery Manifest
                    </div>
                </div>
            </div>

            {/* Per-Customer Receipt Pages — same boxes, same counts. */}
            {stops.map((stop, idx) => (
                <div
                    key={stop.orderId}
                    className="bg-white shadow-xl print:shadow-none max-w-5xl mx-auto p-8 min-h-[11in] flex flex-col relative mt-8"
                    style={{ pageBreakBefore: 'always' }}
                >
                    {/* Receipt Header */}
                    <div className="flex justify-between items-end border-b-4 border-black pb-4 mb-6">
                        <div className="flex flex-col gap-4">
                            {logo && (
                                <div className="h-16 relative w-48">
                                    <img src={logo} alt="Logo" className="h-full w-full object-contain object-left" />
                                </div>
                            )}
                            <div>
                                <h1 className="text-3xl font-black uppercase tracking-tighter">Delivery Receipt</h1>
                                <p className="text-lg font-bold text-slate-500 mt-1">{date}</p>
                            </div>
                        </div>
                        <div className="text-right text-sm text-slate-500">
                            Order {idx + 1} of {stops.length}
                        </div>
                    </div>

                    {/* Customer Info */}
                    <div className="border-l-4 border-indigo-600 pl-4 py-2 mb-6">
                        <p className="font-black text-slate-800 text-xl uppercase">{stop.supporterName}</p>
                    </div>

                    {/* Items Table — one row per physical carton. */}
                    <div className="flex-grow">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="border-b-2 border-black text-sm uppercase">
                                    <th className="py-2 w-12 text-center">#</th>
                                    <th className="py-2">Box Contents</th>
                                    <th className="py-2 w-28 text-center">Carton</th>
                                </tr>
                            </thead>
                            <tbody className="text-sm">
                                {stop.boxes.map((box) => (
                                    <tr key={`${box.orderId}-${box.boxNumber}`} className="border-b border-slate-300">
                                        <td className="py-3 text-center font-bold text-slate-500">
                                            {box.boxNumber} of {box.boxTotal}
                                        </td>
                                        <td className="py-3 font-bold">
                                            {boxContentLines(box).map(formatBoxContentLine).join(' + ')}
                                        </td>
                                        <td className="py-3 text-center text-slate-600 uppercase">{box.boxType}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {/* Box Summary */}
                        <div className="mt-4 flex gap-8 text-sm font-bold border-t-2 border-black pt-3">
                            <span>Large Boxes: <span className="text-lg font-mono">{stop.large}</span></span>
                            <span>Small Boxes: <span className="text-lg font-mono">{stop.small}</span></span>
                            <span>Total Boxes: <span className="text-lg font-mono">{stop.large + stop.small}</span></span>
                        </div>
                    </div>

                    {/* Signature Block */}
                    <div className="mt-auto pt-8 border-t-2 border-black">
                        <p className="text-sm text-slate-600 mb-4">
                            By signing below, I confirm that I have received all items listed above in good condition.
                        </p>
                        <div className="flex gap-16">
                            <div>
                                <p className="font-bold">Customer Signature:</p>
                                <div className="border-b border-black w-64 h-8 mt-2"></div>
                            </div>
                            <div>
                                <p className="font-bold">Print Name:</p>
                                <div className="border-b border-black w-48 h-8 mt-2"></div>
                            </div>
                            <div>
                                <p className="font-bold">Date:</p>
                                <div className="border-b border-black w-32 h-8 mt-2"></div>
                            </div>
                        </div>
                        <div className="text-right text-xs text-slate-400 mt-4">
                            Generated by FreezerIQ
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
