"use client";

import { useState } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function SyncOrdersButton() {
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const syncOrders = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/sync/orders', {
                method: 'POST',
            });

            if (res.ok) {
                const data = await res.json();
                console.log('Sync Results:', data);
                router.refresh();

                if (data.success) {
                    alert("Sync Successful!");
                } else {
                    const errorList = data.results?.errors?.join('\n• ') || 'Unknown error';
                    alert(`Sync completed with issues:\n• ${errorList}\n\nSquare orders may have still updated if only QuickBooks failed.`);
                }
            } else {
                alert('Connection error. Please try again.');
            }

        } catch (e) {
            console.error(e);
            alert('Sync failed.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <button
            onClick={syncOrders}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium shadow-sm disabled:opacity-50 transition-all"
        >
            {isLoading ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
            Sync Orders
        </button>
    );
}
