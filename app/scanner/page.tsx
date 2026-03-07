"use client";

import { useState, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Scanner } from '@yudiel/react-qr-scanner';
import { ArrowLeft, Save, Plus, Minus, Package, AlertTriangle, Wand2, X } from 'lucide-react';

interface ScanResult {
    id: string;
    type: 'recipe' | 'ingredient' | 'supply';
}

interface ItemDetails {
    id: string;
    name: string;
    type: 'recipe' | 'ingredient' | 'supply';
    currentStock: number;
    unit: string;
    costPerUnit?: number;
    purchaseUnit?: string;
    purchaseQuantity?: number;
}

export default function MobileScannerPage() {
    const { data: session, status } = useSession();
    const router = useRouter();

    const [isScanning, setIsScanning] = useState(true);
    const [scanError, setScanError] = useState('');
    const [scannedItem, setScannedItem] = useState<ItemDetails | null>(null);
    const [isFetching, setIsFetching] = useState(false);

    // Modes
    const [scannerMode, setScannerMode] = useState<'receive' | 'audit'>('receive');
    const [receiveUnit, setReceiveUnit] = useState<'pack' | 'base'>('pack');

    // This value represents either the "amount to add" OR the "new total" depending on scannerMode
    const [displayQty, setDisplayQty] = useState<number>(1);
    const [isSaving, setIsSaving] = useState(false);

    // Authentication Gate
    if (status === 'unauthenticated') {
        router.push('/login?callbackUrl=/scanner');
        return null;
    }

    const parseUrl = (url: string): ScanResult | null => {
        try {
            const parsed = new URL(url);
            const type = parsed.searchParams.get('type') as 'recipe' | 'ingredient' | 'supply' | null;
            const id = parsed.searchParams.get('id');

            if (id && (type === 'recipe' || type === 'ingredient' || type === 'supply')) {
                return { id, type };
            }
            return null;
        } catch (e) {
            return null;
        }
    };

    const fetchItemDetails = async (result: ScanResult) => {
        setIsFetching(true);
        setScanError('');
        try {
            const res = await fetch(`/api/scanner/lookup?id=${result.id}&type=${result.type}`);
            if (res.ok) {
                const data = await res.json();
                setScannedItem(data);
                setIsScanning(false);

                // Defaults
                setScannerMode('receive');
                setReceiveUnit(data.purchaseQuantity && data.purchaseQuantity > 1 ? 'pack' : 'base');
                setDisplayQty(1); // Default to receiving 1 pack/unit

            } else {
                setScanError('Item not found in database.');
            }
        } catch (error) {
            console.error(error);
            setScanError('Failed to fetch item details.');
        } finally {
            setIsFetching(false);
        }
    };

    const handleScan = useCallback((text: string) => {
        if (!text) return;

        const result = parseUrl(text);

        if (result) {
            setScanError('');
            fetchItemDetails(result);
        } else {
            setScanError('Invalid QR Code. Please scan a FreezerIQ Label.');
        }
    }, [isScanning]);


    const handleCloseTray = () => {
        setScannedItem(null);
        setDisplayQty(1);
        setIsScanning(true);
        setScanError('');
        setScannerMode('receive');
    };

    const handleSaveAdjustment = async () => {
        if (!scannedItem) return;

        // Calculate the actual delta to send to the server
        let finalAdjustment = 0;

        if (scannerMode === 'audit') {
            finalAdjustment = displayQty - scannedItem.currentStock;
        } else {
            // Receive mode
            if (receiveUnit === 'pack' && scannedItem.purchaseQuantity) {
                finalAdjustment = displayQty * scannedItem.purchaseQuantity;
            } else {
                finalAdjustment = displayQty;
            }
        }

        if (finalAdjustment === 0) {
            handleCloseTray();
            return;
        }

        setIsSaving(true);
        try {
            const res = await fetch('/api/scanner/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: scannedItem.id,
                    type: scannedItem.type,
                    adjustment: finalAdjustment
                })
            });

            if (res.ok) {
                handleCloseTray();
            } else {
                const data = await res.json();
                setScanError(data.error || 'Failed to update inventory.');
            }
        } catch (error) {
            console.error(error);
            setScanError('Network error updating inventory.');
        } finally {
            setIsSaving(false);
        }
    };


    return (
        <div className="fixed inset-0 bg-slate-900 flex flex-col items-center justify-start z-[100] h-[100dvh]">
            {/* Header */}
            <div className="w-full flex justify-between items-center p-4 bg-slate-900/80 backdrop-blur-md z-10 sticky top-0 border-b border-slate-800">
                <button
                    onClick={() => router.back()}
                    className="p-2 text-slate-400 hover:text-white transition-colors"
                >
                    <ArrowLeft size={24} />
                </button>
                <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-lg tracking-tight">Scanner</span>
                    <span className="text-[10px] font-bold text-indigo-400 bg-indigo-900/50 px-2 py-0.5 rounded-full uppercase tracking-tighter">BETA</span>
                </div>
                <div className="w-10"></div> {/* Spacer for center alignment */}
            </div>

            {/* Error Message */}
            {scanError && !scannedItem && (
                <div className="w-[90%] mx-auto mt-4 z-20">
                    <div className="flex items-center gap-3 bg-rose-500/10 border border-rose-500/50 text-rose-400 p-4 rounded-xl shadow-lg shadow-rose-900/20">
                        <AlertTriangle size={20} className="shrink-0" />
                        <p className="text-sm font-medium">{scanError}</p>
                    </div>
                </div>
            )}

            {/* Scanner Area */}
            {isScanning && (
                <div className="w-full max-w-md aspect-[3/4] relative overflow-hidden bg-black mt-8 rounded-3xl border-2 border-slate-800 shadow-2xl">
                    <Scanner
                        onScan={(result) => handleScan(result[0].rawValue)}
                        onError={(error) => console.log(error)}
                    />

                    {/* Targeting Reticle */}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                        <div className="w-48 h-48 border-2 border-indigo-500/50 rounded-lg relative">
                            {/* Corner Accents */}
                            <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-indigo-500 -mt-1 -ml-1 rounded-tl"></div>
                            <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-indigo-500 -mt-1 -mr-1 rounded-tr"></div>
                            <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-indigo-500 -mb-1 -ml-1 rounded-bl"></div>
                            <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-indigo-500 -mb-1 -mr-1 rounded-br"></div>
                        </div>
                    </div>

                    {isFetching && (
                        <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center">
                            <div className="flex flex-col items-center gap-4">
                                <div className="w-12 h-12 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin"></div>
                                <span className="font-bold text-white tracking-widest uppercase text-sm">Validating...</span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Scan Prompt */}
            {isScanning && !isFetching && (
                <div className="mt-8 text-center text-slate-400 animate-pulse">
                    <p className="font-semibold">Point camera at a FreezerIQ QR Code</p>
                </div>
            )}

            {/* Quick Edit Tray (Slides up when item is scanned) */}
            <div className={`fixed bottom-0 left-0 right-0 bg-white dark:bg-slate-900 rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.3)] border-t border-slate-200 dark:border-slate-800 transition-transform duration-300 ease-out z-50 p-6 will-change-transform ${scannedItem ? 'translate-y-0' : 'translate-y-full'}`}>

                {scannedItem && (
                    <div className="flex flex-col gap-6 max-w-md mx-auto relative relative">
                        {/* Drag Handle purely visual */}
                        <div className="w-12 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto -mt-2 mb-2"></div>

                        <button
                            onClick={handleCloseTray}
                            className="absolute -top-2 right-0 p-2 bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 rounded-full transition-colors"
                        >
                            <X size={20} />
                        </button>

                        {/* Item Header */}
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-[10px] font-black uppercase tracking-widest text-indigo-600 dark:text-indigo-400">
                                    {scannedItem.type.charAt(0).toUpperCase() + scannedItem.type.slice(1)}
                                </span>
                            </div>
                            <h2 className="text-2xl font-black text-slate-900 dark:text-white leading-tight">
                                {scannedItem.name}
                            </h2>
                        </div>

                        {/* Mode Toggles */}
                        <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
                            <button
                                onClick={() => {
                                    setScannerMode('receive');
                                    setDisplayQty(1);
                                }}
                                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-colors ${scannerMode === 'receive' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
                            >
                                Receive
                            </button>
                            <button
                                onClick={() => {
                                    setScannerMode('audit');
                                    setDisplayQty(scannedItem.currentStock);
                                }}
                                className={`flex-1 py-2 text-sm font-bold rounded-lg transition-colors ${scannerMode === 'audit' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
                            >
                                Audit Total
                            </button>
                        </div>

                        {/* Inventory Controls */}
                        <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 space-y-4">

                            <div className="flex justify-between items-end mb-2">
                                <label className="text-sm font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                                    {scannerMode === 'receive' ? 'Amount to Add' : 'New Total Stock'}
                                </label>
                                <span className="text-sm font-semibold text-slate-400 dark:text-slate-500">
                                    Current: {scannedItem.currentStock} {scannedItem.unit}
                                </span>
                            </div>

                            {/* Unit Toggles for Receive Mode */}
                            {scannerMode === 'receive' && scannedItem.type === 'ingredient' && scannedItem.purchaseQuantity && scannedItem.purchaseQuantity > 1 && (
                                <div className="flex gap-2 mb-4">
                                    <button
                                        onClick={() => setReceiveUnit('pack')}
                                        className={`flex-1 py-1.5 text-xs font-bold rounded border transition-colors ${receiveUnit === 'pack' ? 'bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-800 dark:text-indigo-300' : 'bg-transparent border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400'}`}
                                    >
                                        By {scannedItem.purchaseUnit || 'Pack'} (x{scannedItem.purchaseQuantity})
                                    </button>
                                    <button
                                        onClick={() => setReceiveUnit('base')}
                                        className={`flex-1 py-1.5 text-xs font-bold rounded border transition-colors ${receiveUnit === 'base' ? 'bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-800 dark:text-indigo-300' : 'bg-transparent border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400'}`}
                                    >
                                        By {scannedItem.unit || 'Unit'}
                                    </button>
                                </div>
                            )}

                            <div className="flex items-center justify-between gap-4">
                                <button
                                    onClick={() => setDisplayQty(Math.max(0, displayQty - 1))}
                                    className="w-16 h-16 flex items-center justify-center bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 rounded-2xl border border-rose-200 dark:border-rose-800 active:scale-95 transition-all outline-none"
                                >
                                    <Minus size={28} strokeWidth={3} />
                                </button>

                                <div className="flex-1 flex flex-col items-center justify-center">
                                    <input
                                        type="number"
                                        value={displayQty}
                                        onChange={(e) => setDisplayQty(Number(e.target.value) || 0)}
                                        className="w-full text-center text-5xl font-black text-slate-900 dark:text-white bg-transparent border-none outline-none focus:ring-0 p-0 m-0"
                                    />
                                    <span className="text-sm font-bold text-slate-400 dark:text-slate-500 mt-1">
                                        {scannerMode === 'receive' && receiveUnit === 'pack' ? scannedItem.purchaseUnit : scannedItem.unit}
                                    </span>
                                </div>

                                <button
                                    onClick={() => setDisplayQty(displayQty + 1)}
                                    className="w-16 h-16 flex items-center justify-center bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 rounded-2xl border border-emerald-200 dark:border-emerald-800 active:scale-95 transition-all outline-none"
                                >
                                    <Plus size={28} strokeWidth={3} />
                                </button>
                            </div>

                            {/* Summary Math */}
                            {scannerMode === 'receive' && receiveUnit === 'pack' && scannedItem.purchaseQuantity && displayQty > 0 && (
                                <div className="text-center text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 py-2 rounded-lg mt-2">
                                    Adding {displayQty * scannedItem.purchaseQuantity} {scannedItem.unit} total
                                </div>
                            )}
                        </div>

                        {/* Save Button */}
                        <button
                            onClick={handleSaveAdjustment}
                            disabled={isSaving || (scannerMode === 'audit' && displayQty === scannedItem.currentStock) || (scannerMode === 'receive' && displayQty === 0)}
                            className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 dark:disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-2xl font-bold text-lg shadow-lg shadow-indigo-600/20 transition-all flex justify-center items-center gap-2 active:scale-[0.98]"
                        >
                            {isSaving ? (
                                <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin"></div>
                            ) : (
                                <>
                                    <Save size={24} />
                                    {scannerMode === 'audit' && displayQty === scannedItem.currentStock ? 'No Changes' :
                                        scannerMode === 'audit' ? 'Update Total' : 'Add to Inventory'}
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>

        </div>
    );
}
