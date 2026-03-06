"use client";

import { useState } from 'react';
import { Upload, Loader2, FileJson, CheckCircle, AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function DashboardImporter({ minimal = false }: { minimal?: boolean }) {
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!confirm("Start Import?\n\nThis will create new Bundles and Catalogs from the file. Existing items with the same name will be updated.\n\nThis action cannot be undone.")) {
            // Reset input
            e.target.value = '';
            return;
        }

        setIsLoading(true);
        const reader = new FileReader();

        reader.onload = async (event) => {
            try {
                const json = JSON.parse(event.target?.result as string);

                // Validate structure roughly
                if (!json.bundles && !json.catalogs && !Array.isArray(json)) {
                    throw new Error("Invalid file format. Expected { bundles: [], catalogs: [] } or Array.");
                }

                // Normalize input (handle old array-only format)
                const payload = Array.isArray(json)
                    ? { bundles: json, catalogs: [] }
                    : json;

                const res = await fetch('/api/bundles/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const result = await res.json();

                if (res.ok) {
                    let msg = "Import Successful!\n\n";
                    if (result.results) {
                        msg += `Catalogs: ${result.results.catalogsCreated} created, ${result.results.catalogsUpdated} updated\n`;
                        msg += `Bundles: ${result.results.bundlesCreated} created, ${result.results.bundlesUpdated} updated`;
                    }
                    alert(msg);
                    router.refresh();
                } else {
                    throw new Error(result.error || "Import failed");
                }

            } catch (err: any) {
                console.error(err);
                alert(`Import Failed: ${err.message}`);
            } finally {
                setIsLoading(false);
                // Reset input
                e.target.value = '';
            }
        };

        reader.onerror = () => {
            alert("Failed to read file");
            setIsLoading(false);
            e.target.value = '';
        };

        reader.readAsText(file);
    };

    if (minimal) {
        return (
            <label className={`cursor-pointer flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 font-bold text-slate-700 dark:text-slate-300 transition-colors shadow-sm ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                <input
                    type="file"
                    accept=".json"
                    onChange={handleImport}
                    disabled={isLoading}
                    className="hidden"
                />
                {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={18} className="text-indigo-600" />}
                <span className="hidden sm:inline">Import JSON</span>
            </label>
        );
    }

    return (
        <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm flex items-center justify-between gap-4">
            <div>
                <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                    <FileJson className="text-indigo-500" size={20} />
                    Data Import
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Restore Bundles & Catalogs from JSON backup.
                </p>
            </div>

            <label className={`cursor-pointer flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm transition-all shadow-sm ${isLoading ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-600'}`}>
                <input
                    type="file"
                    accept=".json"
                    onChange={handleImport}
                    disabled={isLoading}
                    className="hidden"
                />
                {isLoading ? (
                    <>
                        <Loader2 size={16} className="animate-spin" />
                        Importing...
                    </>
                ) : (
                    <>
                        <Upload size={16} />
                        Import JSON
                    </>
                )}
            </label>
        </div>
    );
}
