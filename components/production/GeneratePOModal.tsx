"use client";

import { useState } from "react";
import { Mail, Loader2, X, Send } from "lucide-react";

interface ShoppingItem {
    id: string;
    name: string;
    supplier?: string;
    casesToOrder?: number;
    purchaseUnit?: string;
    purchaseCost?: number;
    toBuy: number;
    unit: string;
}

interface GeneratePOModalProps {
    isOpen: boolean;
    onClose: () => void;
    items: ShoppingItem[];
}

export function GeneratePOModal({ isOpen, onClose, items }: GeneratePOModalProps) {
    const [selectedSupplier, setSelectedSupplier] = useState<string>("");
    const [email, setEmail] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [status, setStatus] = useState<"idle" | "success" | "error">("idle");

    if (!isOpen) return null;

    // Filter items that actually have something to buy
    const itemsToBuy = items.filter(i => i.toBuy > 0);

    // Get unique suppliers
    const suppliers = Array.from(new Set(itemsToBuy.map(i => i.supplier || "Unknown"))).sort();

    // Default to first supplier if none selected
    if (!selectedSupplier && suppliers.length > 0) {
        setSelectedSupplier(suppliers[0]);
    }

    // Items for selected supplier
    const supplierItems = itemsToBuy.filter(i => (i.supplier || "Unknown") === selectedSupplier);

    // Calculate totals
    const totalItems = supplierItems.length;
    const totalEstCost = supplierItems.reduce((sum, i) => {
        if (i.casesToOrder !== undefined && i.purchaseCost !== undefined) {
            return sum + (i.casesToOrder * i.purchaseCost);
        }
        return sum + (i.toBuy * (i.purchaseCost || 0)); // fallback if no cost per unit is passed
    }, 0);

    const handleSend = async () => {
        if (!email || !selectedSupplier) return;

        setIsSending(true);
        setStatus("idle");

        try {
            const res = await fetch("/api/production/generate-po", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    supplier: selectedSupplier,
                    email,
                    items: supplierItems,
                }),
            });

            if (!res.ok) throw new Error("Failed to send PO");

            setStatus("success");
            setTimeout(() => {
                onClose();
                setStatus("idle");
                setEmail("");
            }, 2000);
        } catch (error) {
            console.error("Error sending PO:", error);
            setStatus("error");
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-xl w-full max-w-lg overflow-hidden border border-slate-200 dark:border-slate-700">
                <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-900/50">
                    <h2 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                        <Mail className="text-indigo-600" />
                        Email Purchase Order
                    </h2>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors text-slate-500"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    {/* Supplier Selection */}
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                            Select Supplier
                        </label>
                        <select
                            value={selectedSupplier}
                            onChange={(e) => setSelectedSupplier(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all font-medium"
                        >
                            {suppliers.map(s => (
                                <option key={s} value={s}>{s}</option>
                            ))}
                        </select>
                    </div>

                    {/* Order Summary */}
                    <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl p-4 border border-indigo-100 dark:border-indigo-800/50">
                        <h3 className="font-bold text-indigo-900 dark:text-indigo-300 mb-2">Order Summary</h3>
                        <div className="flex justify-between items-center text-sm text-indigo-700 dark:text-indigo-400">
                            <span>Total Items to Order:</span>
                            <span className="font-bold">{totalItems} items</span>
                        </div>
                        <div className="flex justify-between items-center text-sm text-indigo-700 dark:text-indigo-400 mt-1">
                            <span>Estimated Total Cost:</span>
                            <span className="font-bold">${totalEstCost.toFixed(2)}</span>
                        </div>
                        <p className="text-xs text-indigo-500 dark:text-indigo-500 mt-3 bg-white/50 dark:bg-black/20 p-2 rounded border border-indigo-100 dark:border-indigo-800/50">
                            Note: The attached CSV will automatically group items by the physical purchase units calculated in your Shopping List (e.g., Cases, Bags).
                        </p>
                    </div>

                    {/* Email Input */}
                    <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">
                            Recipient Email Address
                        </label>
                        <input
                            type="email"
                            placeholder="rep@gfs.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all"
                        />
                    </div>

                    {/* Status Messages */}
                    {status === "success" && (
                        <div className="p-3 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 rounded-xl border border-emerald-200 dark:border-emerald-800 text-sm font-medium text-center">
                            Purchase Order sent successfully! Check your email.
                        </div>
                    )}
                    {status === "error" && (
                        <div className="p-3 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded-xl border border-red-200 dark:border-red-800 text-sm font-medium text-center">
                            Failed to send email. Please check the logs.
                        </div>
                    )}
                </div>

                <div className="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-3 rounded-xl font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                        disabled={isSending}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSend}
                        disabled={!email || totalItems === 0 || isSending}
                        className="flex-1 px-4 py-3 rounded-xl font-bold bg-indigo-600 hover:bg-indigo-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
                    >
                        {isSending ? (
                            <>
                                <Loader2 size={18} className="animate-spin" />
                                Sending...
                            </>
                        ) : (
                            <>
                                <Send size={18} />
                                Approve & Send
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
