'use client';

export function DeliveryPrep({
    deliveryDateLabel,
    pickupLocation,
    onDownloadPickupSheet,
}: {
    deliveryDateLabel?: string; pickupLocation?: string; onDownloadPickupSheet: () => void;
}) {
    return (
        <section className="bg-white border border-slate-200 rounded-2xl p-4">
            <h3 className="text-base font-black text-slate-900">Delivery day is close</h3>
            <p className="mt-1 text-xs text-slate-500">
                {deliveryDateLabel ? `Pickup is ${deliveryDateLabel}` : 'Pickup details coming soon'}
                {pickupLocation ? ` at ${pickupLocation}` : ''}. Start collecting what&apos;s owed and print your sheet.
            </p>
            <button onClick={onDownloadPickupSheet}
                className="mt-3 block w-full rounded-xl bg-indigo-50 py-2.5 text-center text-[13px] font-bold text-indigo-700">
                📦 Print pickup sheet
            </button>
        </section>
    );
}

export default DeliveryPrep;
