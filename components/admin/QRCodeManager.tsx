"use client";

import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Trash2, Plus, LayoutDashboard } from 'lucide-react';

interface QRCodeManagerProps {
    assignedPackingSlipQrId: string | null;
    onAssignPackingSlipQr: (id: string | null) => void;
}

interface QRCodeItem {
    id: string;
    name: string;
    url_target: string;
}

export default function QRCodeManager({ assignedPackingSlipQrId, onAssignPackingSlipQr }: QRCodeManagerProps) {
    const [qrCodes, setQrCodes] = useState<QRCodeItem[]>([]);
    const [newName, setNewName] = useState("");
    const [newUrl, setNewUrl] = useState("");
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        fetch('/api/settings/qr-codes')
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) setQrCodes(data);
            })
            .catch(console.error);
    }, []);

    const handleCreate = async () => {
        if (!newName || !newUrl) return;
        setIsSaving(true);
        try {
            const res = await fetch('/api/settings/qr-codes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName, url_target: newUrl })
            });
            if (res.ok) {
                const newQr = await res.json();
                setQrCodes([newQr, ...qrCodes]);
                setNewName("");
                setNewUrl("");
            }
        } catch (e) {
            alert("Failed to create QR code");
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this QR code?")) return;
        try {
            const res = await fetch('/api/settings/qr-codes', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            if (res.ok) {
                setQrCodes(qrCodes.filter(q => q.id !== id));
                if (assignedPackingSlipQrId === id) {
                    onAssignPackingSlipQr(null);
                }
            }
        } catch (e) {
            alert("Failed to delete QR code");
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row gap-4">
                <div className="flex-1">
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Name / Identifier</label>
                    <input
                        type="text"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        placeholder="e.g. Spring Promo, Facebook Review"
                        className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg text-sm bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                    />
                </div>
                <div className="flex-[2]">
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Target URL</label>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={newUrl}
                            onChange={e => setNewUrl(e.target.value)}
                            placeholder="https://..."
                            className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg text-sm bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                        />
                        <button
                            onClick={handleCreate}
                            disabled={isSaving || !newName || !newUrl}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg text-sm font-bold shadow-sm transition-all active:scale-95 disabled:opacity-50 flex items-center gap-2 whitespace-nowrap"
                        >
                            <Plus size={16} /> Add QR
                        </button>
                    </div>
                </div>
            </div>

            <div className="pt-4">
                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Assigned Packing Slip QR</label>
                <select
                    value={assignedPackingSlipQrId || ""}
                    onChange={(e) => onAssignPackingSlipQr(e.target.value || null)}
                    className="w-full md:w-1/2 px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-sm rounded-lg focus:ring-2 focus:ring-indigo-500 font-medium cursor-pointer"
                >
                    <option value="">-- None (Standard App QR) --</option>
                    {qrCodes.map(qr => (
                        <option key={qr.id} value={qr.id}>{qr.name}</option>
                    ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">This QR code will be displayed at the bottom of the packing slip generator.</p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 pt-4 border-t border-slate-100 dark:border-slate-700">
                {qrCodes.map(qr => (
                    <div key={qr.id} className="relative group bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-3 flex flex-col items-center gap-2 shadow-sm">
                        <div className="w-full aspect-square bg-white rounded flex items-center justify-center p-2 border border-slate-100 overflow-hidden">
                            <QRCodeSVG value={qr.url_target} className="w-full h-full text-slate-900" />
                        </div>
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate w-full text-center" title={qr.name}>{qr.name}</span>
                        <div className="absolute inset-0 bg-slate-900/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 rounded-xl backdrop-blur-sm">
                            <button
                                onClick={() => handleDelete(qr.id)}
                                className="p-2 bg-rose-600 text-white rounded-full hover:bg-rose-700 shadow-lg transform hover:scale-110 transition-all"
                                title="Delete QR Code"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    </div>
                ))}
                {qrCodes.length === 0 && (
                    <div className="col-span-full flex items-center justify-center w-full py-12 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-2xl text-slate-400 text-sm italic">
                        No custom QR codes created yet.
                    </div>
                )}
            </div>
        </div>
    );
}
