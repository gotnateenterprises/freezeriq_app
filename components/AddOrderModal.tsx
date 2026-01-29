'use client';

import { useState } from 'react';
import { X, Plus, Trash2, Save, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface AddOrderModalProps {
    isOpen: boolean;
    onClose: () => void;
    bundles: any[];
}

export default function AddOrderModal({ isOpen, onClose, bundles }: AddOrderModalProps) {
    const router = useRouter();
    const [isLoading, setIsLoading] = useState(false);
    const [customerName, setCustomerName] = useState('');
    const [deliveryDate, setDeliveryDate] = useState('');
    const [items, setItems] = useState<{ bundle_id: string; quantity: number; variant_size: string }[]>([
        { bundle_id: '', quantity: 1, variant_size: 'serves_5' }
    ]);

    if (!isOpen) return null;

    const addItem = () => {
        setItems([...items, { bundle_id: '', quantity: 1, variant_size: 'serves_5' }]);
    };

    const removeItem = (index: number) => {
        setItems(items.filter((_, i) => i !== index));
    };

    const updateItem = (index: number, field: string, value: any) => {
        const newItems = [...items];
        newItems[index] = { ...newItems[index], [field]: value };
        setItems(newItems);
    };

    const handleSubmit = async () => {
        if (!customerName || items.some(i => !i.bundle_id)) {
            alert('Please fill in all required fields');
            return;
        }

        setIsLoading(true);
        try {
            const res = await fetch('/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer_name: customerName,
                    delivery_date: deliveryDate || null,
                    items
                })
            });

            if (res.ok) {
                router.refresh();
                onClose();
                // Reset form
                setCustomerName('');
                setDeliveryDate('');
                setItems([{ bundle_id: '', quantity: 1, variant_size: 'serves_5' }]);
            } else {
                const err = await res.json();
                alert(`Failed to create order: ${err.error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error(e);
            alert('Error creating order. Check console for details.');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
                    <h2 className="text-xl font-black text-slate-900 dark:text-white">New Manual Order</h2>
                    <button onClick={onClose} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
                        <X size={20} className="text-slate-500" />
                    </button>
                </div>

                <div className="p-6 overflow-y-auto space-y-6 flex-1">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-500 uppercase tracking-wide">Customer Name</label>
                            <input
                                type="text"
                                className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold focus:ring-2 focus:ring-indigo-500 outline-none"
                                placeholder="e.g. John Doe"
                                value={customerName}
                                onChange={(e) => setCustomerName(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-sm font-bold text-slate-500 uppercase tracking-wide">Delivery Date</label>
                            <input
                                type="date"
                                className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold focus:ring-2 focus:ring-indigo-500 outline-none"
                                value={deliveryDate}
                                onChange={(e) => setDeliveryDate(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <label className="text-sm font-bold text-slate-500 uppercase tracking-wide">Order Items</label>
                            <button onClick={addItem} className="text-indigo-600 text-sm font-bold flex items-center gap-1 hover:underline">
                                <Plus size={16} /> Add Item
                            </button>
                        </div>

                        <div className="space-y-3">
                            {items.map((item, index) => (
                                <div key={index} className="flex gap-3 items-start animate-in slide-in-from-left-4 duration-300">
                                    <select
                                        className="flex-1 bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-indigo-500 outline-none"
                                        value={item.bundle_id}
                                        onChange={(e) => updateItem(index, 'bundle_id', e.target.value)}
                                    >
                                        <option value="">Select Bundle...</option>
                                        {bundles.map(b => (
                                            <option key={b.id} value={b.id}>{b.name} (${Number(b.price).toFixed(2)})</option>
                                        ))}
                                    </select>

                                    <select
                                        className="w-32 bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-indigo-500 outline-none"
                                        value={item.variant_size}
                                        onChange={(e) => updateItem(index, 'variant_size', e.target.value)}
                                    >
                                        <option value="serves_5">Family (5)</option>
                                        <option value="serves_2">Couple (2)</option>
                                    </select>

                                    <input
                                        type="number"
                                        min="1"
                                        className="w-20 bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-medium focus:ring-2 focus:ring-indigo-500 outline-none"
                                        value={item.quantity}
                                        onChange={(e) => updateItem(index, 'quantity', parseInt(e.target.value))}
                                    />

                                    <button
                                        onClick={() => removeItem(index)}
                                        className="p-3 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl transition-colors"
                                        disabled={items.length === 1}
                                    >
                                        <Trash2 size={20} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="p-6 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-3 bg-slate-50/50 dark:bg-slate-800/50">
                    <button
                        onClick={onClose}
                        className="px-6 py-3 font-bold text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={isLoading}
                        className="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl shadow-lg shadow-indigo-500/30 transition-all hover:scale-105 active:scale-95 disabled:opacity-70 disabled:scale-100 flex items-center gap-2"
                    >
                        {isLoading ? <Loader2 className="animate-spin" /> : <Save size={20} />}
                        Save Order
                    </button>
                </div>
            </div>
        </div>
    );
}
