'use client';

export function RecentOrders({
    orders,
    onCancel,
    onViewAll,
    limit = 3,
    isClosed = false,
}: {
    orders: any[]; onCancel: (id: string) => void; onViewAll?: () => void; limit?: number;
    /** Phase 7E-4: when true, hides cancel button so closed campaigns are read-only */
    isClosed?: boolean;
}) {
    const active = (orders || []).filter((o: any) => !o.canceled_at);
    const shown = active.slice(0, limit);
    return (
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900 mb-1">Recent orders</h3>
            <div className="divide-y divide-slate-100">
                {shown.length === 0 && (
                    <p className="py-3 text-xs text-slate-500">No orders yet — your first one shows up here.</p>
                )}
                {shown.map((o: any) => (
                    <div key={o.id} className="flex items-center gap-2 py-2.5 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
                            {o.customer_name || 'Supporter'}
                            <span className="text-slate-400"> · {o.items?.length ?? 0} items</span>
                        </span>
                        <span className="font-bold tabular-nums text-slate-900">
                            ${Number(o.total_amount ?? 0).toFixed(0)}
                        </span>
                        {/* Phase 7E-4: hide cancel button when campaign is closed */}
                        {!isClosed && (
                            <button onClick={() => onCancel(o.id)} aria-label="Cancel order"
                                className="text-slate-300 hover:text-red-500">✕</button>
                        )}
                    </div>
                ))}
            </div>
            {active.length > limit && onViewAll && (
                <button onClick={onViewAll} className="w-full pt-2 text-center text-xs font-bold text-indigo-600">
                    View all {active.length} orders →
                </button>
            )}
        </section>
    );
}

export default RecentOrders;
