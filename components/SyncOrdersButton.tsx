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
                console.log('Sync Complete:', data);
                router.refresh(); // Refresh server components
                alert(`Sync Complete! ${data.results?.errors?.length ? 'With Errors: ' + data.results.errors.join(', ') : 'Success'}`);
            } else {
                alert('Sync failed. Check console.');
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
