'use client';

import { useState } from 'react';
import { Trash2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface DeleteOrderButtonProps {
    orderId: string;
}

export default function DeleteOrderButton({ orderId }: DeleteOrderButtonProps) {
    const router = useRouter();
    const [isDeleting, setIsDeleting] = useState(false);

    const handleDelete = async (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent row click navigation

        if (!confirm('Are you sure you want to delete this order? This cannot be undone.')) {
            return;
        }

        setIsDeleting(true);
        try {
            const res = await fetch(`/api/orders?id=${orderId}`, {
                method: 'DELETE'
            });

            if (res.ok) {
                router.refresh();
            } else {
                const err = await res.json();
                alert(`Failed to delete order: ${err.error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error(e);
            alert('Error deleting order');
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <button
            onClick={handleDelete}
            disabled={isDeleting}
            className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-full transition-colors"
            title="Delete Order"
        >
            {isDeleting ? <Loader2 size={20} className="animate-spin" /> : <Trash2 size={20} />}
        </button>
    );
}
