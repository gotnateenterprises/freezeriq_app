'use client';

export function ActionBar({
    phase,
    onAddOrder,
    onShare,
    tenantName,
    orderingAllowed,
}: {
    phase: string;
    onAddOrder: () => void;
    onShare: () => void;
    tenantName?: string;
    orderingAllowed?: boolean;
}) {
    if (phase === 'complete') {
        return (
            <div className="fixed bottom-0 inset-x-0 z-20 border-t border-slate-200 bg-white/90 backdrop-blur px-4 py-3">
                <p className="max-w-xl mx-auto text-center text-xs text-slate-500">
                    Campaign closed · Late order?{' '}
                    <span className="font-bold text-indigo-600">Contact {tenantName || 'the organizer'} →</span>
                </p>
            </div>
        );
    }
    return (
        <div className="fixed bottom-0 inset-x-0 z-20 border-t border-slate-200 bg-white/90 backdrop-blur px-4 py-3">
            <div className="max-w-xl mx-auto flex gap-3">
                {orderingAllowed === true && (
                    <button
                        onClick={onAddOrder}
                        className="flex-1 rounded-xl bg-indigo-600 py-3 text-sm font-extrabold text-white active:scale-[0.98] transition"
                    >
                        + Add Order
                    </button>
                )}
                <button
                    onClick={onShare}
                    className="flex-1 rounded-xl bg-indigo-50 py-3 text-sm font-extrabold text-indigo-700 active:scale-[0.98] transition"
                >
                    Share
                </button>
            </div>
        </div>
    );
}

export default ActionBar;
