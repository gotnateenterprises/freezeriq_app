"use client";

import { useState, useEffect } from 'react';
import { Plus, Search, Tag, Printer, MoreVertical, Edit, Copy, Trash, FileText } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface LabelTemplate {
    id: string;
    name: string;
    width: number;
    height: number;
    isDefault: boolean;
    _count?: {
        packagingItems: number;
    };
    updatedAt: string;
}

export default function LabelDashboard() {
    const router = useRouter();
    const [templates, setTemplates] = useState<LabelTemplate[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        fetchTemplates();
    }, []);

    const fetchTemplates = async () => {
        try {
            const res = await fetch('/api/delivery/labels');
            if (res.ok) {
                const data = await res.json();
                setTemplates(data);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setIsLoading(false);
        }
    };

    const deleteTemplate = async (id: string) => {
        if (!confirm("Are you sure you want to delete this template?")) return;
        try {
            await fetch(`/api/delivery/labels/${id}`, { method: 'DELETE' });
            fetchTemplates();
        } catch (error) {
            console.error(error);
            alert("Failed to delete template");
        }
    };

    const createNew = async (width: number, height: number, defaultName: string) => {
        const name = prompt("Enter a name for your new label:", defaultName);
        if (!name) return; // Cancelled

        try {
            const res = await fetch('/api/delivery/labels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    width,
                    height,
                    elements: []
                })
            });
            if (res.ok) {
                const newItem = await res.json();
                router.push(`/delivery/labels/${newItem.id}`);
            }
        } catch (error) {
            console.error("Failed to create template", error);
            alert("Failed to create template. Please restart your dev server (npm run dev) to apply database changes.");
        }
    };

    const duplicateTemplate = async (id: string, originalName: string) => {
        const newName = prompt("Enter name for the copy:", `${originalName} (Copy)`);
        if (!newName) return;

        try {
            // 1. Fetch full details (elements aren't in the list view)
            const sourceRes = await fetch(`/api/delivery/labels/${id}`);
            if (!sourceRes.ok) throw new Error("Failed to fetch source");
            const source = await sourceRes.json();

            // 2. Create new
            const res = await fetch('/api/delivery/labels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newName,
                    width: source.width,
                    height: source.height,
                    elements: source.elements
                })
            });

            if (res.ok) {
                fetchTemplates();
            }
        } catch (error) {
            console.error(error);
            alert("Failed to duplicate template");
        }
    };

    return (
        <div className="max-w-6xl mx-auto p-6 space-y-8">
            {/* Header */}
            <div className="flex justify-between items-center">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <Link href="/delivery" className="text-slate-400 hover:text-slate-600 text-sm font-bold">Delivery</Link>
                        <span className="text-slate-300">/</span>
                        <span className="text-slate-400 text-sm font-bold">Labels</span>
                    </div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                        <Printer className="text-indigo-600" />
                        Label Management
                    </h1>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => createNew(4.0, 2.5, 'Shipping Label (Avery 5821)')}
                        className="bg-indigo-600 text-white px-3 py-2.5 rounded-xl font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 flex items-center gap-2 text-xs"
                    >
                        <Plus size={16} /> Avery 5821 (4" × 2.5")
                    </button>
                </div>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {isLoading ? (
                    // Skeletons
                    [1, 2, 3].map(i => (
                        <div key={i} className="h-64 bg-slate-100 rounded-2xl animate-pulse"></div>
                    ))
                ) : templates.length === 0 ? (
                    <div className="col-span-full py-16 text-center border-2 border-dashed border-slate-200 rounded-3xl bg-slate-50">
                        <Tag size={48} className="mx-auto text-slate-300 mb-4" />
                        <h3 className="text-lg font-bold text-slate-600">No label templates yet.</h3>
                        <p className="text-slate-400 mb-6">Create a label for your boxes.</p>
                        <div className="flex justify-center gap-4">
                            <button
                                onClick={() => createNew(4.0, 2.5, 'Shipping Label (Avery 5821)')}
                                className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-lg font-bold border-b-4 hover:border-b active:border-b-0 active:translate-y-1 transition-all"
                            >
                                Create Avery 5821 (4" × 2.5")
                            </button>
                        </div>
                    </div>
                ) : (
                    templates.map(tpl => (
                        <div key={tpl.id} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden group hover:shadow-md transition-shadow">
                            {/* Preview Area (Pseudo-preview) */}
                            <Link href={`/delivery/labels/${tpl.id}`} className="block aspect-[2/3] bg-slate-100 dark:bg-slate-900 flex items-center justify-center relative border-b border-slate-100 dark:border-slate-700 cursor-pointer group-hover:opacity-90 transition-opacity">
                                <div
                                    className="bg-white shadow-sm flex flex-col items-center justify-center text-center p-2"
                                    style={{
                                        width: '60%',
                                        aspectRatio: `${tpl.width}/${tpl.height}`
                                    }}
                                >
                                    <div className="w-8 h-8 bg-slate-100 rounded mb-2"></div>
                                    <div className="w-16 h-2 bg-slate-100 rounded mb-1"></div>
                                    <div className="w-10 h-2 bg-slate-100 rounded"></div>
                                </div>
                                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/5">
                                    <span className="bg-white text-slate-900 px-4 py-2 rounded-lg font-bold shadow-sm">Edit Design</span>
                                </div>
                            </Link>

                            {/* Metadata */}
                            <div className="p-4">
                                <div className="flex justify-between items-start mb-2">
                                    <h3 className="font-bold text-slate-900 dark:text-white truncate pr-2">{tpl.name}</h3>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => duplicateTemplate(tpl.id, tpl.name)}
                                            className="text-slate-300 hover:text-indigo-600 transition-colors p-1"
                                            title="Duplicate Label"
                                        >
                                            <Copy size={16} />
                                        </button>
                                        <button
                                            onClick={() => deleteTemplate(tpl.id)}
                                            className="text-slate-300 hover:text-rose-500 transition-colors p-1"
                                            title="Delete Label"
                                        >
                                            <Trash size={16} />
                                        </button>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-slate-500 font-bold">
                                    <span className="bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-slate-600 dark:text-slate-300">
                                        {tpl.width}" × {tpl.height}"
                                    </span>
                                    {tpl._count && tpl._count.packagingItems > 0 && (
                                        <span className="text-indigo-500 flex items-center gap-1">
                                            <Tag size={12} /> Used by {tpl._count.packagingItems} items
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
