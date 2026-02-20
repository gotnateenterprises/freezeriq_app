"use client";

import { useState, useRef } from 'react';
import { Upload, HeartHandshake, CheckCircle, AlertCircle, X, RefreshCw, FileText } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export default function FundraiserImporter({ onClose }: { onClose: () => void }) {
    const [file, setFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [logs, setLogs] = useState<string[]>([]);
    const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const router = useRouter();

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0]);
            setStatus('idle');
            setLogs([]);
        }
    };

    const handleUpload = async () => {
        if (!file) return;

        setIsUploading(true);
        setStatus('idle');
        setLogs([]);
        setErrorMessage('');

        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/api/fundraisers/upload', {
                method: 'POST',
                body: formData
            });

            const data = await res.json();

            if (res.ok) {
                setStatus('success');
                setLogs([data.message, ...(data.logs || [])]);
                toast.success('Import completed successfully');
                setTimeout(() => {
                    router.refresh();
                }, 1000);
            } else {
                setStatus('error');
                setErrorMessage(data.error || 'Upload failed');
                toast.error(data.error || 'Import failed');
            }
        } catch (e: any) {
            setStatus('error');
            setErrorMessage(e.message || 'Network error');
            toast.error('Network error during import');
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-2xl w-full flex flex-col max-h-[90vh] overflow-hidden border border-slate-200 dark:border-slate-700">
                {/* Header */}
                <div className="flex justify-between items-center p-6 border-b border-slate-100 dark:border-slate-800">
                    <div>
                        <h2 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                            <HeartHandshake className="text-pink-600 dark:text-pink-400" />
                            Import Fundraisers
                        </h2>
                        <p className="text-slate-500 dark:text-slate-400 mt-1 text-sm">Upload a CSV to create Organizations and Campaigns.</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                        <X size={24} className="text-slate-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-8 overflow-y-auto min-h-[300px]">
                    {status === 'idle' || status === 'error' ? (
                        <div className="space-y-6">
                            <div
                                onClick={() => fileInputRef.current?.click()}
                                className={`border-2 border-dashed rounded-2xl p-12 flex flex-col items-center justify-center cursor-pointer transition-all ${file ? 'border-pink-500 bg-pink-50 dark:bg-pink-900/10' : 'border-slate-300 dark:border-slate-700 hover:border-pink-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                            >
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept=".csv"
                                    className="hidden"
                                />
                                {file ? (
                                    <>
                                        <FileText size={48} className="text-pink-600 dark:text-pink-400 mb-4" />
                                        <p className="font-bold text-lg text-slate-900 dark:text-white">{file.name}</p>
                                        <p className="text-slate-500 text-sm">{(file.size / 1024).toFixed(1)} KB</p>
                                    </>
                                ) : (
                                    <>
                                        <Upload size={48} className="text-slate-300 dark:text-slate-600 mb-4" />
                                        <p className="font-bold text-lg text-slate-700 dark:text-slate-300">Click to Select CSV</p>
                                        <p className="text-slate-400 text-sm mt-1">Columns: Organization Name, Contact Name, Email, Goal...</p>
                                    </>
                                )}
                            </div>

                            {status === 'error' && (
                                <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-xl flex items-center gap-3">
                                    <AlertCircle size={24} />
                                    <p className="font-bold">{errorMessage}</p>
                                </div>
                            )}

                            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 p-4 rounded-xl text-xs text-amber-700 dark:text-amber-400">
                                <strong>Tip:</strong> Required: <code>Organization Name</code>. Optional: <code>Campaign Name</code>, <code>Goal Amount</code>, <code>Email</code>.
                            </div>

                            <div className="flex justify-end pt-4">
                                <button
                                    onClick={handleUpload}
                                    disabled={!file || isUploading}
                                    className="px-8 py-3 bg-pink-600 hover:bg-pink-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-bold transition-all shadow-lg shadow-pink-200 dark:shadow-none flex items-center gap-2"
                                >
                                    {isUploading ? (
                                        <>
                                            <RefreshCw className="animate-spin" size={20} /> Processing...
                                        </>
                                    ) : (
                                        <>
                                            Start Import
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-6 text-center py-8">
                            <div className="w-20 h-20 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-6">
                                <CheckCircle size={40} strokeWidth={3} />
                            </div>
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white">Import Successful!</h3>
                            <p className="text-slate-500 dark:text-slate-400 italic">Fundraisers have been created/updated.</p>

                            <div className="bg-slate-50 dark:bg-slate-950 p-4 rounded-xl text-left max-h-60 overflow-y-auto text-sm font-mono text-slate-600 dark:text-slate-400 border border-slate-100 dark:border-slate-800">
                                {logs.map((log, i) => (
                                    <div key={i} className="py-1 border-b border-slate-100 dark:border-slate-800/50 last:border-0">{log}</div>
                                ))}
                            </div>

                            <button
                                onClick={onClose}
                                className="px-8 py-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-900 dark:text-white rounded-xl font-bold transition-colors mt-4 w-full"
                            >
                                Done
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
