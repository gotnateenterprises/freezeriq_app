/**
 * CLOSEOUT-BUNDLE-SUMMARY-1 — the coordinator's bundle totals, above Recent orders.
 *
 * Totals the FULL order list the portal already holds (app/api/coordinator's
 * GET returns every non-canceled order of the campaign). It is handed the same
 * array RecentOrders is, never RecentOrders' three-row preview, and it keeps
 * no state of its own: every 30-second portal refresh re-renders it from the
 * new list, so a new order shows up here as soon as it shows up below.
 *
 * Quantities only. The coordinator is shown no price, invoice, organization
 * share or accounting figure here — only the order count and the sales total
 * the portal already displays in its progress card.
 */

import {
    activeSummaryOrders,
    bundleSummaryFromSupporterOrders,
    formatDollars,
    pluralCount,
    type SummaryOrder,
} from '@/lib/bundleSummary';

export function BundleTotalsCard({
    orders,
    isClosed,
    totalSales,
}: {
    /** The campaign's full order list — not a display-limited subset. */
    orders: readonly SummaryOrder[] | null | undefined;
    /** Server closeout (coordinatorPortalGate). Only a closed campaign's totals are final. */
    isClosed: boolean;
    /** The payload's own total_sales (pre-tax, active orders). Omitted when absent. */
    totalSales?: number | string | null;
}) {
    // A canceled order never counts, even if one were ever handed in.
    const active = activeSummaryOrders(orders);
    if (active.length === 0) return null;

    const summary = bundleSummaryFromSupporterOrders(active);
    const sales = totalSales === null || totalSales === undefined || totalSales === '' ? NaN : Number(totalSales);

    return (
        <section data-bundle-totals className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900">
                {isClosed ? 'Final bundle totals' : 'Current bundle totals'}
            </h3>
            <p className="mb-2 text-[11px] font-medium text-slate-400">
                {isClosed
                    ? 'Ordering is closed. These totals reflect the completed fundraiser.'
                    : 'Updates as orders are added.'}
            </p>
            {summary.rows.length === 0 ? (
                <p className="py-2 text-xs text-slate-500">No bundles recorded on these orders yet.</p>
            ) : (
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                            <th scope="col" className="pb-1 pr-2 text-left font-bold">Bundle</th>
                            <th scope="col" className="pb-1 pr-2 text-left font-bold">Size</th>
                            <th scope="col" className="pb-1 text-right font-bold">Qty</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {summary.rows.map((r) => (
                            <tr key={r.key}>
                                <td className="py-1.5 pr-2 text-slate-800 [overflow-wrap:anywhere]">{r.bundleName}</td>
                                <td className="py-1.5 pr-2 whitespace-nowrap text-slate-500">{r.sizeLabel ?? '—'}</td>
                                <td className="py-1.5 text-right font-bold tabular-nums text-slate-900">{r.quantity.toLocaleString('en-US')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <p className="mt-2 border-t border-slate-100 pt-2 text-sm font-black text-slate-900">
                Total physical bundles: {summary.totalQuantity.toLocaleString('en-US')}
            </p>
            {Number.isFinite(sales) && (
                <p className="text-[12px] font-medium text-slate-500">
                    {pluralCount(active.length, 'supporter order', 'supporter orders')} · {formatDollars(sales)} in orders
                </p>
            )}
        </section>
    );
}

export default BundleTotalsCard;
