'use client';

import { useState } from 'react';
import { PlusCircle } from 'lucide-react';
import AddOrderModal from './AddOrderModal';

interface AddManualOrderButtonProps {
    bundles: any[];
}

export default function AddManualOrderButton({ bundles }: AddManualOrderButtonProps) {
    const [isModalOpen, setIsModalOpen] = useState(false);

    return (
        <>
            <button
                onClick={() => setIsModalOpen(true)}
                className="flex items-center gap-2 px-6 py-3 bg-indigo-600 border border-indigo-600 rounded-2xl text-white hover:bg-indigo-700 font-bold shadow-lg shadow-indigo-200 dark:shadow-none transition-all hover:scale-105 active:scale-95"
            >
                <PlusCircle size={20} strokeWidth={2.5} />
                Add Order
            </button>
            <AddOrderModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                bundles={bundles}
            />
        </>
    );
}
