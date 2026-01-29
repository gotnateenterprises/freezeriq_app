"use client";

import { useState } from 'react';
import { Play, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function SimulateOrderButton() {
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const simulateOrder = async () => {
        setIsLoading(true);
        try {
            // Generate Random ID
            const orderId = `SQ-${Math.floor(Math.random() * 10000)}`;

            // Random Customer
            const customers = ['Alice Smith', 'Bob Jones', 'Charlie Brown', 'Diana Prince'];
            const customer = customers[Math.floor(Math.random() * customers.length)];

            // Random Bundle (We need a known SKU, or we send a dummy Name that we know exists in seed)
            // Assuming "Classic Family Bundle" or "Comfort Classics" exists
            const payload = {
                order_id: orderId,
                customer_name: customer,
                total_money: { amount: 8500 }, // $85.00
                line_items: [
                    {
                        name: "Test Bundle 1",
                        quantity: "1",
                        catalog_object_id: "BUNDLE-TEST-1"
                    }
                ]
            };

            const res = await fetch('/api/integrations/square', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const data = await res.json();
                console.log('Order Simulated:', data);
                router.refresh(); // Refresh server components
            } else {
                alert('Simulation failed. Check console.');
            }

        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <button
            onClick={simulateOrder}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium shadow-sm disabled:opacity-50 transition-all"
        >
            {isLoading ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
            Simulate Order
        </button>
    );
}
