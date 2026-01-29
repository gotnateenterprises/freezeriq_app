
"use client";

import { useState, useEffect } from 'react';
import { X, Printer, AlertTriangle } from 'lucide-react';
import { getLabelPrinter } from '@/lib/label_printer';
import { Uuid } from '@/types';

interface FinalLabelModalProps {
    isOpen: boolean;
    onClose: () => void;
    batchId: string;
    recipeName: string;
    ingredients: string; // Pre-formatted or raw list
    allergens: string;
    expiryDate: string;
    quantity: number;
    unit: string;
    mealSize?: string;
    instructions?: string;
}

export default function FinalLabelModal({
    isOpen,
    onClose,
    batchId,
    recipeName,
    ingredients,
    allergens,
    expiryDate,
    quantity,
    unit,
    mealSize,
    instructions: initialInstructions
}: FinalLabelModalProps) {
    const [logoUrl, setLogoUrl] = useState<string>('');
    const [notes, setNotes] = useState<string>('');
    const [instructions, setInstructions] = useState<string>(initialInstructions || '');
    const [isPrinting, setIsPrinting] = useState(false);

    // Load Logo & Smart Match Instructions
    useEffect(() => {
        // Logo
        const savedLogo = localStorage.getItem('kitchenLogo');
        if (savedLogo) setLogoUrl(savedLogo);

        // Smart Match Instructions (Only if not provided)
        if (!initialInstructions) {
            const savedSets = localStorage.getItem('instructionSets');
            if (savedSets) {
                const sets: { name: string, text: string }[] = JSON.parse(savedSets);
                const normalizedName = recipeName.toLowerCase();
                const normalizedSize = (mealSize || '').toLowerCase();

                let bestMatch = null;
                let maxScore = 0;

                for (const set of sets) {
                    const setName = set.name.toLowerCase();
                    let score = 0;

                    // Matches "Family" or "Serves 2"
                    if (normalizedSize && setName.includes(normalizedSize)) score += 5;

                    // Matches Recipe Name parts
                    const parts = normalizedName.split(' ');
                    for (const part of parts) {
                        if (part.length > 3 && setName.includes(part)) score += 2;
                    }

                    if (score > maxScore) {
                        maxScore = score;
                        bestMatch = set;
                    }
                }

                if (bestMatch && maxScore > 0) {
                    setInstructions(bestMatch.text);
                }
            }
        }
    }, [initialInstructions, recipeName, mealSize]);

    if (!isOpen) return null;

    const handlePrint = async () => {
        setIsPrinting(true);
        try {
            const jobData = {
                recipeName,
                ingredients,
                expiryDate,
                quantity,
                user: 'User', // Mock for now
                allergens: allergens,
                notes: notes,
                isFinalLabel: true,
                metadata: {
                    mealSize: mealSize,
                    instructions: instructions
                }
            };

            const res = await fetch('/api/production/print-label', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job: jobData })
            });

            const result = await res.json();

            if (res.ok && result.success) {
                alert(result.message);
                onClose();
            } else {
                alert('Print Failed: ' + (result.error || result.message || 'Unknown Error'));
            }
        } catch (error) {
            console.error(error);
            alert('Failed to print label');
        } finally {
            setIsPrinting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-700">

                {/* Header */}
                <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
                    <h3 className="text-xl font-black text-slate-900 dark:text-white">Print Final Label</h3>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors text-slate-500">
                        <X size={20} />
                    </button>
                </div>

                <div className="p-8 space-y-6">
                    {/* Live Preview of Label */}
                    <div className="border-4 border-slate-900 rounded-xl p-6 bg-white shadow-lg space-y-4 relative overflow-hidden">
                        {/* Mock Logo Header */}
                        <div className="flex flex-col items-center border-b-2 border-slate-900 pb-3 mb-3 text-center">
                            {logoUrl ? (
                                <div className="w-12 h-12 mb-2 rounded-xl overflow-hidden border border-slate-200">
                                    <img src={logoUrl} alt="Logo" className="w-full h-full object-cover" />
                                </div>
                            ) : (
                                <div className="w-12 h-12 bg-slate-900 rounded-xl flex items-center justify-center text-white font-black text-[10px] mb-2">
                                    LOGO
                                </div>
                            )}
                            <h2 className="text-xl font-black text-slate-900 uppercase leading-tight text-center break-words w-full">{recipeName}</h2>
                            <p className="text-[10px] font-bold text-slate-500 mt-1 uppercase tracking-wider">{new Date().toLocaleDateString()}</p>
                        </div>

                        {/* Ingredients */}
                        <div>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Ingredients</p>
                            <p className="text-xs font-medium text-slate-800 leading-snug">
                                {ingredients}
                            </p>
                        </div>

                        {/* Allergens */}
                        {allergens && (
                            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex items-start gap-2">
                                <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-[10px] font-bold text-amber-800 uppercase tracking-wider mb-0.5">Allergens</p>
                                    <p className="text-xs font-bold text-amber-900">{allergens}</p>
                                </div>
                            </div>
                        )}

                        {/* Footer Stats */}
                        <div className="grid grid-cols-2 gap-4 pt-4 border-t-2 border-slate-900 border-dashed">
                            <div>
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Use By</p>
                                <p className="text-lg font-black text-slate-900">{expiryDate}</p>
                            </div>
                            <div className="text-right">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                    {mealSize ? 'Meal Size' : 'Net Weight'}
                                </p>
                                <p className="text-lg font-black text-slate-900">
                                    {mealSize || `${quantity} ${unit}`}
                                </p>
                            </div>
                        </div>

                        {/* Cooking Instructions (Overlays Notes area) */}
                        {instructions && (
                            <div className="absolute inset-x-0 bottom-0 bg-white/95 p-2 text-center border-t-2 border-slate-900 z-10">
                                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-0.5">Preparation</p>
                                <p className="text-[9px] font-bold text-slate-900 leading-tight line-clamp-2">
                                    {instructions}
                                </p>
                            </div>
                        )}
                        {/* Notes Fallback */}
                        {!instructions && notes && (
                            <div className="absolute inset-x-0 bottom-0 bg-yellow-100/90 p-2 text-center text-xs font-bold text-yellow-900 border-t border-yellow-200">
                                NOTE: {notes}
                            </div>
                        )}
                    </div>

                    {/* Inputs */}
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Preparation Instructions (Auto-filled)</label>
                            <textarea
                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-xl outline-none font-medium text-slate-900 dark:text-white text-sm"
                                rows={2}
                                value={instructions}
                                onChange={(e) => setInstructions(e.target.value)}
                                placeholder="Select a preset or type instructions..."
                            />
                        </div>

                        <div>
                            <label className="text-sm font-bold text-slate-700 dark:text-slate-300">Add Notes (Optional)</label>
                            <input
                                type="text"
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-xl outline-none font-medium text-slate-900 dark:text-white placeholder:text-slate-400"
                                placeholder="e.g. Keep Refrigerated..."
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                            />
                        </div>
                    </div>
                </div>

                {/* Footer Actions */}
                <div className="p-6 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-700 flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-6 py-3 font-bold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handlePrint}
                        disabled={isPrinting}
                        className="flex items-center gap-2 px-8 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
                    >
                        {isPrinting ? 'Printing...' : <><Printer size={20} /> Print Label</>}
                    </button>
                </div>
            </div>
        </div>
    );
}
