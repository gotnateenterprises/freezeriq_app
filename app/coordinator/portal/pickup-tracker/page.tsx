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
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { formatServingTier } from '@/lib/coordinatorSupporterOrders';

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
                    {campaign.payment_instructions && (
                        <p className="mt-1 text-[12px] text-slate-600">
                            <strong>Payment:</strong> {campaign.payment_instructions}
                        </p>
                    )}
                    <p className="mt-1 text-[11px] text-slate-500">
                        Contains supporter contact information — handle securely.
                    </p>
                </header>

                {/* ── Supporter rows ───────────────────────────────────────── */}
                {groups.length === 0 ? (
                    <p className="py-8 text-sm text-slate-500">
                        No released orders yet. Orders appear here once this fundraiser&apos;s invoice
                        has been recorded as paid and the food is released for production.
                    </p>
                ) : (
                    <ul className="mt-1">
                        {groups.map((g) => (
                            <li key={g.key} className="supporter-row flex items-start gap-4 border-b border-slate-300 py-3">
                                {/* Check-off box. Paper only — not persisted. */}
                                <span aria-hidden className="mt-0.5 h-7 w-7 shrink-0 border-2 border-slate-900" />

                                <div className="min-w-0 flex-1">
                                    <p className="text-[15px] font-black uppercase tracking-wide text-slate-900">
                                        {g.customer_name || 'Supporter'}
                                    </p>

                                    <p className="text-[12px] text-slate-700">
                                        {g.email && <span className="mr-3">{g.email}</span>}
                                        {g.phone && <span className="mr-3">{g.phone}</span>}
                                        {g.participant_name && <span className="text-slate-600">for {g.participant_name}</span>}
                                    </p>

                                    <ul className="mt-1 text-[13px] text-slate-900">
                                        {g.items.map((it, idx) => {
                                            const tier = formatServingTier(it.variant_size);
                                            return (
                                                <li key={idx}>
                                                    <span className="font-bold">{it.item_name || 'Item'}</span>
                                                    {tier ? <span> | {tier}</span> : null}
                                                    <span> | Qty {it.quantity}</span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>

                                <span className="shrink-0 text-[13px] font-bold tabular-nums text-slate-900">
                                    ${Number(g.total || 0).toFixed(2)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <style jsx global>{`
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
