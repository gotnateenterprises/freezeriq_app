'use client';

import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Search, Loader2, Package, Tag, DollarSign, Calendar } from 'lucide-react';
import { toast } from 'sonner';

interface Item {
    bundle_id?: string;
    description: string;
    quantity: number;
    unit_price: number;
    total: number;
}

interface Customer {
    id: string;
    name: string;
    email: string;
}

interface Bundle {
    id: string;
    name: string;
    price: number | string;
}

interface InvoiceComposeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (invoice: any) => void;
    invoiceToEdit?: any;
    preselectedCustomerId?: string;
    prefilledItems?: Item[];
}

export default function InvoiceComposeModal({
    isOpen,
    onClose,
    onSuccess,
    invoiceToEdit,
    preselectedCustomerId,
    prefilledItems
}: InvoiceComposeModalProps) {
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [bundles, setBundles] = useState<Bundle[]>([]);
    const [selectedCustomerId, setSelectedCustomerId] = useState('');
    const [items, setItems] = useState<Item[]>([{ description: '', quantity: 1, unit_price: 0, total: 0 }]);
    const [taxAmount, setTaxAmount] = useState(0);
    const [dueDate, setDueDate] = useState('');
    const [paymentMethod, setPaymentMethod] = useState('check');
    const [profitPercent, setProfitPercent] = useState(20);
    const [isTaxExempt, setIsTaxExempt] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoadingData, setIsLoadingData] = useState(false);

    useEffect(() => {
        if (isOpen) {
            fetchInitialData();
            if (invoiceToEdit) {
                setSelectedCustomerId(invoiceToEdit.customer_id);
                setItems(invoiceToEdit.items.map((i: any) => ({
                    bundle_id: i.bundle_id,
                    description: i.description,
                    quantity: Number.isNaN(Number(i.quantity)) ? 1 : Number(i.quantity),
                    unit_price: Number.isNaN(Number(i.unit_price)) ? 0 : Number(i.unit_price),
                    total: Number.isNaN(Number(i.total)) ? 0 : Number(i.total)
                })));
                setTaxAmount(Number.isNaN(Number(invoiceToEdit.tax_amount)) ? 0 : Number(invoiceToEdit.tax_amount));
                setDueDate(invoiceToEdit.due_date ? new Date(invoiceToEdit.due_date).toISOString().split('T')[0] : '');
                setPaymentMethod(invoiceToEdit.payment_method || 'check');
                setProfitPercent(Number.isNaN(Number(invoiceToEdit.fundraiser_profit_percent)) ? 0 : Number(invoiceToEdit.fundraiser_profit_percent));
                setIsTaxExempt(Number(invoiceToEdit.tax_amount) === 0);
            } else if (preselectedCustomerId) {
                setSelectedCustomerId(preselectedCustomerId);
                setItems(prefilledItems || [{ description: '', quantity: 1, unit_price: 0, total: 0 }]);
                setTaxAmount(0);
                setDueDate('');
                setPaymentMethod('check');
                setProfitPercent(20);
                setIsTaxExempt(false);
            } else {
                setSelectedCustomerId('');
                setItems(prefilledItems || [{ description: '', quantity: 1, unit_price: 0, total: 0 }]);
                setTaxAmount(0);
                setDueDate('');
                setPaymentMethod('check');
                setProfitPercent(20);
                setIsTaxExempt(false);
            }
        }
    }, [isOpen, invoiceToEdit, preselectedCustomerId, prefilledItems]);

    const subtotal = items.reduce((acc, curr) => acc + curr.total, 0);

    // Auto-calculate 1% tax
    useEffect(() => {
        if (isTaxExempt) {
            setTaxAmount(0);
        } else {
            const calculatedTax = Number((subtotal * 0.01).toFixed(2));
            setTaxAmount(calculatedTax);
        }
    }, [subtotal, isTaxExempt]);

    const fetchInitialData = async () => {
        setIsLoadingData(true);
        try {
            const [custRes, bundleRes] = await Promise.all([
                fetch('/api/customers?type=organization'),
                fetch('/api/bundles')
            ]);

            if (custRes.ok) {
                const data = await custRes.json();
                setCustomers(Array.isArray(data) ? data : (data.customers || []));
            }
            if (bundleRes.ok) {
                const data = await bundleRes.json();
                setBundles(data);
            }
        } catch (error) {
            toast.error('Failed to load customers or bundles');
        } finally {
            setIsLoadingData(false);
        }
    };

    const handleAddItem = () => {
        setItems([...items, { description: '', quantity: 1, unit_price: 0, total: 0 }]);
    };

    const handleRemoveItem = (index: number) => {
        setItems(items.filter((_, i) => i !== index));
    };

    const handleUpdateItem = (index: number, updates: Partial<Item>) => {
        const newItems = [...items];
        newItems[index] = { ...newItems[index], ...updates };
        newItems[index].total = newItems[index].quantity * newItems[index].unit_price;
        setItems(newItems);
    };

    const handleBundleSelect = (bundleId: string) => {
        const bundle = bundles.find(b => b.id === bundleId);
        if (!bundle) return;

        // Add to items or update last empty item
        const lastItem = items[items.length - 1];
        if (items.length === 1 && !lastItem.description) {
            handleUpdateItem(0, {
                bundle_id: bundle.id,
                description: bundle.name,
                unit_price: Number(bundle.price),
                total: Number(bundle.price)
            });
        } else {
            setItems([...items, {
                bundle_id: bundle.id,
                description: bundle.name,
                quantity: 1,
                unit_price: Number(bundle.price),
                total: Number(bundle.price)
            }]);
        }
    };

    const profitAmount = Number((subtotal * (profitPercent / 100)).toFixed(2));
    const finalBalance = subtotal - profitAmount + Number(taxAmount);

    const handleSave = async () => {
        if (!selectedCustomerId) return toast.error('Please select a customer');
        if (items.some(i => !i.description)) return toast.error('All items must have a description');

        setIsSaving(true);
        try {
            const res = await fetch('/api/tenant/invoices', {
                method: invoiceToEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: invoiceToEdit?.id,
                    customer_id: selectedCustomerId,
                    items,
                    total_amount: finalBalance,
                    tax_amount: taxAmount,
                    due_date: dueDate || null,
                    payment_method: paymentMethod,
                    fundraiser_profit_percent: profitPercent,
                    fundraiser_profit_amount: profitAmount,
                    status: invoiceToEdit?.status || 'PENDING'
                })
            });

            if (res.ok) {
                const result = await res.json();
                console.log('Invoice saved successfully:', result);
                toast.success(invoiceToEdit ? 'Invoice updated successfully' : 'Invoice created successfully');
                onClose(); // Close modal FIRST
                onSuccess(result); // Then trigger preview
            } else {
                const errText = await res.text();
                let err;
                try {
                    err = JSON.parse(errText);
                } catch (e) {
                    err = { error: errText };
                }
                console.error('Save failed detailed:', JSON.stringify(err, null, 2));
                toast.error(err.error || err.details || 'Failed to save invoice');
            }
        } catch (error) {
            toast.error('An error occurred');
        } finally {
            setIsSaving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 w-full max-w-4xl max-h-[90vh] rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden border border-white/20">
                {/* Header */}
                <div className="p-8 border-b dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
                    <div>
                        <h2 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                            <Tag className="w-8 h-8 text-indigo-500" />
                            {invoiceToEdit ? 'Edit Invoice' : 'Create New Invoice'}
                        </h2>
                        <p className="text-slate-500 font-medium text-sm mt-1">
                            {invoiceToEdit ? 'Update details for this invoice.' : 'Issue a professional invoice and manage loyalty rewards.'}
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors">
                        <X className="w-6 h-6 text-slate-400" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-8 space-y-8">
                    {/* Customer Selection */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <div>
                            <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 px-1">Customer</label>
                            <div className="relative">
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                                <select
                                    value={selectedCustomerId}
                                    onChange={(e) => setSelectedCustomerId(e.target.value)}
                                    className="w-full pl-11 pr-4 py-4 rounded-2xl bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-indigo-500/20 focus:ring-0 text-sm font-bold transition-all appearance-none"
                                >
                                    <option value="">Select a customer...</option>
                                    {customers.map(c => (
                                        <option key={c.id} value={c.id}>{c.name} ({c.email})</option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 px-1">Bundle Selector (Auto-fill)</label>
                            <div className="relative">
                                <Package className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-500" />
                                <select
                                    onChange={(e) => handleBundleSelect(e.target.value)}
                                    value=""
                                    className="w-full pl-11 pr-4 py-4 rounded-2xl bg-indigo-50/50 dark:bg-indigo-900/10 border-2 border-indigo-100 dark:border-indigo-900/30 focus:border-indigo-500/20 focus:ring-0 text-sm font-bold text-indigo-600 transition-all appearance-none"
                                >
                                    <option value="">Choose a Bundle...</option>
                                    {bundles.map(b => (
                                        <option key={b.id} value={b.id}>{b.name} - ${Number(b.price).toFixed(2)}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Items Table */}
                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest px-1">Line Items</h3>
                            <button
                                onClick={handleAddItem}
                                className="text-xs font-black text-indigo-600 hover:text-indigo-700 uppercase tracking-widest flex items-center gap-1.5 transition-colors"
                            >
                                <Plus className="w-3 h-3" /> Add Row
                            </button>
                        </div>
                        <div className="space-y-3">
                            {items.map((item, index) => (
                                <div key={index} className="flex gap-4 items-end animate-in slide-in-from-top-1 duration-200">
                                    <div className="flex-1">
                                        <input
                                            type="text"
                                            placeholder="Item description..."
                                            value={item.description}
                                            onChange={(e) => handleUpdateItem(index, { description: e.target.value })}
                                            className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-indigo-500/20 focus:ring-0 text-sm font-medium"
                                        />
                                    </div>
                                    <div className="w-24 text-center">
                                        <label className="block text-[10px] font-black text-slate-300 uppercase mb-1">Qty</label>
                                        <input
                                            type="number"
                                            value={Number.isNaN(item.quantity) ? '' : item.quantity}
                                            onChange={(e) => handleUpdateItem(index, { quantity: parseFloat(e.target.value) || 0 })}
                                            className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-indigo-500/20 focus:ring-0 text-sm font-bold text-center"
                                        />
                                    </div>
                                    <div className="w-32">
                                        <label className="block text-[10px] font-black text-slate-300 uppercase mb-1">Price</label>
                                        <div className="relative">
                                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                            <input
                                                type="number"
                                                value={Number.isNaN(item.unit_price) ? '' : item.unit_price}
                                                onChange={(e) => handleUpdateItem(index, { unit_price: parseFloat(e.target.value) || 0 })}
                                                className="w-full pl-8 pr-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-2 border-transparent focus:border-indigo-500/20 focus:ring-0 text-sm font-bold"
                                            />
                                        </div>
                                    </div>
                                    <div className="w-32">
                                        <label className="block text-[10px] font-black text-slate-300 uppercase mb-1">Total</label>
                                        <div className="px-4 py-3 rounded-xl bg-slate-100 dark:bg-slate-800/50 text-sm font-black text-slate-600 dark:text-slate-400">
                                            ${item.total.toFixed(2)}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleRemoveItem(index)}
                                        disabled={items.length === 1}
                                        className="p-3 text-slate-300 hover:text-rose-500 disabled:opacity-30 disabled:hover:text-slate-300 transition-colors"
                                    >
                                        <Trash2 className="w-5 h-5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Settings & Totals */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-12 pt-8 border-t dark:border-slate-800">
                        <div className="space-y-6">
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">Due Date</label>
                                    <input
                                        type="date"
                                        value={dueDate}
                                        onChange={(e) => setDueDate(e.target.value)}
                                        className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-none focus:ring-2 focus:ring-indigo-500/20 text-sm font-bold"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">Payment</label>
                                    <select
                                        value={paymentMethod}
                                        onChange={(e) => setPaymentMethod(e.target.value)}
                                        className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-none focus:ring-2 focus:ring-indigo-500/20 text-sm font-bold"
                                    >
                                        <option value="check">Check</option>
                                        <option value="venmo">Venmo</option>
                                        <option value="paypal">PayPal</option>
                                        <option value="ach">ACH</option>
                                        <option value="credit">Credit Card</option>
                                        <option value="debit">Debit Card</option>
                                        <option value="cash">Cash</option>
                                        <option value="other">Other</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-2">Fundraiser Profit %</label>
                                    <div className="relative">
                                        <input
                                            type="number"
                                            value={Number.isNaN(profitPercent) ? '' : profitPercent}
                                            onChange={(e) => setProfitPercent(parseFloat(e.target.value) || 0)}
                                            className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border-none focus:ring-2 focus:ring-indigo-500/20 text-sm font-bold"
                                        />
                                        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold">%</span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700">
                                <input
                                    type="checkbox"
                                    id="taxExempt"
                                    checked={isTaxExempt}
                                    onChange={(e) => setIsTaxExempt(e.target.checked)}
                                    className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                                <label htmlFor="taxExempt" className="text-sm font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                                    Tax Exempt (Remove 1% Food Tax)
                                </label>
                            </div>

                            <div className="p-4 bg-amber-50 dark:bg-amber-900/10 rounded-2xl border border-amber-100 dark:border-amber-900/30 flex items-start gap-3">
                                <DollarSign className="w-5 h-5 text-amber-600 mt-1 shrink-0" />
                                <p className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed font-medium">
                                    **Note**: Marking this invoice as PAID will automatically issue loyalty points to the customer's account.
                                </p>
                            </div>
                        </div>

                        <div className="bg-slate-50 dark:bg-slate-800/50 p-8 rounded-[2rem] space-y-4">
                            <div className="flex justify-between items-center text-sm">
                                <span className="font-bold text-slate-500 uppercase tracking-widest text-[10px]">Subtotal</span>
                                <span className="font-bold text-slate-700 dark:text-slate-300">${subtotal.toFixed(2)}</span>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="font-bold text-slate-500 uppercase tracking-widest text-[10px]">Tax Amount</span>
                                <input
                                    type="number"
                                    value={Number.isNaN(taxAmount) ? '' : taxAmount}
                                    onChange={(e) => setTaxAmount(parseFloat(e.target.value) || 0)}
                                    className="w-24 text-right bg-transparent border-b border-slate-200 dark:border-slate-700 focus:border-indigo-500 focus:ring-0 text-sm font-bold p-0"
                                />
                            </div>
                            <div className="pt-4 border-t dark:border-slate-700 space-y-2">
                                <div className="flex justify-between items-center text-sm">
                                    <span className="font-bold text-emerald-500 uppercase tracking-widest text-[10px]">Less Fundraiser Profit ({profitPercent}%)</span>
                                    <span className="font-bold text-emerald-600">-${profitAmount.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                    <span className="font-bold text-slate-500 uppercase tracking-widest text-[10px]">Tax Amount</span>
                                    <span className="font-bold text-slate-700 dark:text-slate-300">${taxAmount.toFixed(2)}</span>
                                </div>
                                <div className="pt-4 border-t border-dashed dark:border-slate-700 flex justify-between items-center">
                                    <span className="font-black text-slate-900 dark:text-white uppercase tracking-widest text-xs">Final Balance Due to Freezer IQ</span>
                                    <span className="text-3xl font-black text-indigo-600">${finalBalance.toFixed(2)}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-8 border-t dark:border-slate-800 flex justify-end gap-4 bg-slate-50/50 dark:bg-slate-800/50">
                    <button
                        onClick={onClose}
                        className="px-6 py-3 rounded-2xl font-black text-slate-400 hover:text-slate-600 transition-colors uppercase tracking-widest text-xs"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving || !selectedCustomerId}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-4 rounded-2xl font-black shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:scale-100 flex items-center gap-2"
                    >
                        {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : (invoiceToEdit ? <Calendar className="w-5 h-5" /> : <Plus className="w-5 h-5" />)}
                        {invoiceToEdit ? 'Update Invoice' : 'Generate Invoice'}
                    </button>
                </div>
            </div>
        </div>
    );
}
