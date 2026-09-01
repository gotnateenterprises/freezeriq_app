'use client';

export function DeliveryPrep({
    deliveryDateLabel,
    pickupLocation,
    onDownloadPickupSheet,
    /** COORD-FULFILLMENT-2: opens the printable per-supporter pickup tracker.
     *  Optional so any other caller keeps working unchanged. */
    onPrintPickupTracker,
}: {
    deliveryDateLabel?: string;
    pickupLocation?: string;
    onDownloadPickupSheet: () => void;
    onPrintPickupTracker?: () => void;
}) {
    return (
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900">Delivery day is close</h3>
            <p className="mt-1 text-xs text-slate-500">
                {deliveryDateLabel ? `Pickup is ${deliveryDateLabel}` : 'Pickup details coming soon'}
                {pickupLocation ? ` at ${pickupLocation}` : ''}. Start collecting what&apos;s owed and print your sheet.
            </p>
            {/* COORD-FULFILLMENT-2: the primary action is now the real printable
                tracker — one row per supporter with a check-off box. The button
                below it downloads the spreadsheet, which is the same data in a
                bundle-column layout for counting boxes. The old primary said
                "Print pickup sheet" but produced an .xlsx download. */}
            {onPrintPickupTracker && (
                <button onClick={onPrintPickupTracker}
                    className="mt-3 block w-full rounded-xl bg-indigo-600 py-2.5 text-center text-[13px] font-bold text-white hover:bg-indigo-700">
                    🖨️ Print pickup tracker
                </button>
            )}
            <button onClick={onDownloadPickupSheet}
                className="mt-2 block w-full rounded-xl bg-indigo-50 py-2.5 text-center text-[13px] font-bold text-indigo-700">
                📦 Download pickup spreadsheet
            </button>
        </section>
    );
}

export default DeliveryPrep;
