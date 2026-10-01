/**
 * CLOSEOUT-BUNDLE-SUMMARY-1 — the tenant's Bundle Summary table.
 *
 * Renders a BundleSummary built by lib/bundleSummary.ts and nothing else: it
 * adds no figure of its own. Shared by the closeout modal (the response's
 * frozen lines) and the invoices page (the invoice's frozen items), so the
 * two can never describe the same fundraiser differently.
 *
 * The footer states physical bundles only. Supporter-order and weighted-goal
 * counts are deliberately absent: neither the closeout response nor the
 * invoice carries them, and the Campaigns row's copies use a different order
 * set (source = 'fundraiser' only) and can be stale since page load. A count
 * that cannot be shown authoritatively is omitted, not estimated.
 */

import {
    bundleSummaryShowsCents,
    formatSummaryMoney,
    pluralCount,
    type BundleSummary,
} from '@/lib/bundleSummary';

export function BundleSummaryTable({
    summary,
    showHeading = true,
    className = '',
}: {
    summary: BundleSummary;
    /** Off when the surrounding dialog's own title already says "Bundle Summary". */
    showHeading?: boolean;
    className?: string;
}) {
    const showCents = bundleSummaryShowsCents(summary);
    const money = (v: number) => formatSummaryMoney(v, showCents);

    return (
        <section
            data-bundle-summary
            className={`rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 ${className}`}
        >
            {showHeading && (
                <h4 className="mb-2 text-sm font-black text-slate-900 dark:text-white">Bundle Summary</h4>
            )}
            {summary.rows.length === 0 ? (
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400">No bundles were sold.</p>
            ) : (
                <table className="w-full text-xs text-slate-700 dark:text-slate-200">
                    <thead>
                        <tr className="text-[10px] uppercase tracking-widest text-slate-400">
                            <th scope="col" className="pb-1.5 pr-2 text-left font-black">Bundle</th>
                            <th scope="col" className="pb-1.5 pr-2 text-left font-black">Size</th>
                            <th scope="col" className="pb-1.5 pr-2 text-right font-black">Qty</th>
                            <th scope="col" className="pb-1.5 text-right font-black">Sales</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-700/60">
                        {summary.rows.map((r) => (
                            <tr key={r.key}>
                                <td className="py-1.5 pr-2 font-bold text-slate-800 dark:text-slate-100 [overflow-wrap:anywhere]">{r.bundleName}</td>
                                <td className="py-1.5 pr-2 whitespace-nowrap">{r.sizeLabel ?? '—'}</td>
                                <td className="py-1.5 pr-2 text-right tabular-nums">{r.quantity.toLocaleString('en-US')}</td>
                                <td className="py-1.5 text-right tabular-nums whitespace-nowrap">{money(r.sales)}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="border-t-2 border-slate-200 dark:border-slate-600 font-black text-slate-900 dark:text-white">
                            <th scope="row" className="pt-2 pr-2 text-left">Total</th>
                            <td className="pt-2 pr-2" />
                            <td className="pt-2 pr-2 text-right tabular-nums">{summary.totalQuantity.toLocaleString('en-US')}</td>
                            <td className="pt-2 text-right tabular-nums whitespace-nowrap">{money(summary.totalSales)}</td>
                        </tr>
                    </tfoot>
                </table>
            )}
            {summary.rows.length > 0 && (
                <p className="mt-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
                    {pluralCount(summary.totalQuantity, 'physical bundle', 'physical bundles')}
                </p>
            )}
        </section>
    );
}

export default BundleSummaryTable;
