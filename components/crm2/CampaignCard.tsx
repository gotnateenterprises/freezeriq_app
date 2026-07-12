'use client';
import Link from 'next/link';
import { StageChip } from './StageChip';
import { BundleSelectionStatusCard } from './BundleSelectionStatusCard';

export function CampaignCard({ c, businessSlug }: { c: any; businessSlug?: string }) {
    const closed = Boolean(c.closed_at) || ['Closed', 'Settled', 'Completed', 'Archived'].includes(c.status);
    const daysLeft = c.end_date ? Math.max(Math.ceil((new Date(c.end_date).getTime() - Date.now()) / 864e5), 0) : null;
    return (
        <section className="mb-3.5 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2.5">
                <h3 className="text-[15px] font-black text-slate-900 dark:text-white">{c.name}</h3>
                <StageChip status={closed ? 'Closed' : c.status} />
            </div>
            <p className="mb-2.5 mt-0.5 text-[11px] text-slate-500">
                {closed && c.closed_at ? `Closed ${new Date(c.closed_at).toLocaleDateString()}` :
                 c.end_date ? `Ends ${new Date(c.end_date).toLocaleDateString()}` : 'No end date'}
                {c.bundle_goal ? ` · Goal: ${c.bundle_goal} bundles` : ''}
            </p>

            {!closed && (
                <>
                    <div className="flex gap-2">
                        <Stat v={`$${Number(c.total_sales ?? c.sales_total ?? 0).toLocaleString()}`} l="sales" money />
                        <Stat v={String(c.held_order_count ?? 0)} l="held orders" />
                        {daysLeft != null && <Stat v={String(daysLeft)} l="days left" />}
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {businessSlug && <Kit href={`/shop/${businessSlug}/fundraiser/${c.id}`} label="🛒 Public order page" />}
                        {c.portal_token && <Kit href={`/coordinator/${c.portal_token}`} label="🎯 Coordinator portal" />}
                        {c.public_token && <Kit href={`/fundraiser/${c.public_token}`} label="🏆 Scoreboard" />}
                    </div>
                </>
            )}

            {/* CB-6: Tenant bundle selection status — renders for open and closed campaigns */}
            <BundleSelectionStatusCard campaignId={c.id} />

            {closed && c.settlement_total != null && (
                <div className="mt-1 flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 px-3.5 py-2.5 dark:border-orange-900 dark:bg-orange-950">
                    <span>💰</span>
                    <span className="text-[12px] text-orange-900 dark:text-orange-200">
                        <b className="text-sm tabular-nums">${Number(c.settlement_total).toLocaleString()}</b><br />
                        Settlement frozen at closeout{c.invoice_id ? ' — invoiced ✓' : ' — not yet invoiced'}
                    </span>
                    {!c.invoice_id && (
                        <Link href={`/customers/${c.customer_id}?tab=fundraisers&action=invoice&campaignId=${c.id}&amount=${c.settlement_total}`}
                            className="ml-auto rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-extrabold text-white">Create invoice</Link>
                    )}
                </div>
            )}
        </section>
    );
}

function Stat({ v, l, money = false }: { v: string; l: string; money?: boolean }) {
    return (
        <div className="flex-1 rounded-xl bg-slate-50 px-2 py-1.5 text-center dark:bg-slate-800">
            <b className={`block text-sm tabular-nums ${money ? 'text-emerald-600' : 'text-slate-900 dark:text-white'}`}>{v}</b>
            <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{l}</span>
        </div>
    );
}
function Kit({ href, label }: { href: string; label: string }) {
    return <Link href={href} target="_blank" className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">{label}</Link>;
}
