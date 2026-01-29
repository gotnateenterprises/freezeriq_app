
"use client";

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, Globe, Phone, Mail, MapPin, User, Store } from 'lucide-react';
import Link from 'next/link';

export default function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    const { id } = use(params);
    const [supplier, setSupplier] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        fetch(`/api/commercial/suppliers/${id}`)
            .then(res => res.json())
            .then(data => {
                setSupplier(data);
                setIsLoading(false);
            })
            .catch(err => {
                alert("Failed to load supplier");
                router.push('/commercial');
            });
    }, [id, router]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const res = await fetch(`/api/commercial/suppliers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(supplier)
            });

            if (res.ok) {
                alert("Supplier updated successfully!");
                router.refresh();
            } else {
                const errData = await res.json();
                throw new Error(errData.details || "Failed to save");
            }
        } catch (e: any) {
            alert("Error saving supplier: " + e.message);
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading Supplier...</div>;
    if (!supplier) return <div className="p-12 text-center text-red-500">Supplier not found.</div>;

    return (
        <div className="max-w-4xl mx-auto space-y-6 pb-20">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Link href="/commercial" className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full text-slate-500 dark:text-slate-400 transition">
                        <ArrowLeft size={24} />
                    </Link>
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
                            <Store className="text-indigo-500" size={32} />
                            {supplier.name}
                        </h1>
                        <p className="text-slate-500 dark:text-slate-400 text-sm">Manage contact details and ordering info.</p>
                    </div>
                </div>
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="bg-slate-900 hover:bg-slate-800 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 shadow-lg transition disabled:opacity-50"
                >
                    <Save size={20} />
                    {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* General Info Card */}
                <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 space-y-4">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-700 pb-2 mb-4">Company Info</h2>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Supplier Name</label>
                        <input
                            value={supplier.name || ''}
                            onChange={e => setSupplier({ ...supplier, name: e.target.value })}
                            className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-lg bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <Mail size={14} /> General Email
                        </label>
                        <input
                            value={supplier.contact_email || ''}
                            onChange={e => setSupplier({ ...supplier, contact_email: e.target.value })}
                            placeholder="orders@supplier.com"
                            className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-600 dark:text-slate-200 bg-white dark:bg-slate-900"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <Globe size={14} /> Website
                        </label>
                        <div className="flex gap-2">
                            <input
                                value={supplier.website_url || ''}
                                onChange={e => setSupplier({ ...supplier, website_url: e.target.value })}
                                placeholder="https://..."
                                className="flex-1 px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-600 dark:text-slate-200 bg-white dark:bg-slate-900"
                            />
                            {supplier.website_url && (
                                <a href={supplier.website_url} target="_blank" rel="noopener noreferrer" className="p-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-lg border border-indigo-100 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 flex items-center justify-center">
                                    <Globe size={20} />
                                </a>
                            )}
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <Phone size={14} /> Main Phone
                        </label>
                        <input
                            value={supplier.phone_number || ''}
                            onChange={e => setSupplier({ ...supplier, phone_number: e.target.value })}
                            placeholder="(555) 123-4567"
                            className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-600 dark:text-slate-200 bg-white dark:bg-slate-900"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <MapPin size={14} /> Address
                        </label>
                        <textarea
                            value={supplier.address || ''}
                            onChange={e => setSupplier({ ...supplier, address: e.target.value })}
                            placeholder="1234 Warehouse Lane..."
                            rows={3}
                            className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-600 dark:text-slate-200 resize-none bg-white dark:bg-slate-900"
                        />
                    </div>
                </div>

                {/* Salesperson / Contact Card */}
                <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 space-y-4">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-700 pb-2 mb-4">Sales Representative</h2>

                    <div className="bg-indigo-50 dark:bg-indigo-900/20 p-4 rounded-lg border border-indigo-100 dark:border-indigo-800 mb-4">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 rounded-full bg-indigo-200 dark:bg-indigo-800 flex items-center justify-center text-indigo-700 dark:text-indigo-300 font-bold">
                                <User size={20} />
                            </div>
                            <div>
                                <p className="text-xs text-indigo-500 dark:text-indigo-300 font-bold uppercase">Dedicated Agent</p>
                                <p className="text-indigo-900 dark:text-indigo-100 font-semibold text-sm">Direct contact for ordering.</p>
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1">Rep Name</label>
                        <input
                            value={supplier.salesperson_name || ''}
                            onChange={e => setSupplier({ ...supplier, salesperson_name: e.target.value })}
                            placeholder="e.g. Jim Halpert"
                            className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-900 dark:text-white font-medium bg-white dark:bg-slate-900"
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <Mail size={14} /> Rep Email
                        </label>
                        <div className="flex gap-2">
                            <input
                                value={supplier.salesperson_email || ''}
                                onChange={e => setSupplier({ ...supplier, salesperson_email: e.target.value })}
                                placeholder="jim@dundermifflin.com"
                                className="flex-1 px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-600 dark:text-slate-200 bg-white dark:bg-slate-900"
                            />
                            {supplier.salesperson_email && (
                                <a href={`mailto:${supplier.salesperson_email}`} className="p-2 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-lg border border-indigo-100 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 flex items-center justify-center">
                                    <Mail size={20} />
                                </a>
                            )}
                        </div>
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase mb-1 flex items-center gap-1">
                            <Phone size={14} /> Rep Direct Line / Cell
                        </label>
                        <input
                            value={supplier.salesperson_phone || ''}
                            onChange={e => setSupplier({ ...supplier, salesperson_phone: e.target.value })}
                            placeholder="(555) 555-0123"
                            className="w-full px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500 text-slate-600 dark:text-slate-200 bg-white dark:bg-slate-900"
                        />
                    </div>

                </div>
            </div>
        </div>
    );
}
