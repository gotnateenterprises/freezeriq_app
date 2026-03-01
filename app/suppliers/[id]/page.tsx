
"use client";

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { ArrowLeft, Save, Truck, Package, MapPin, Mail, Phone, Edit2, X, CreditCard, DollarSign, User, ExternalLink } from 'lucide-react';
import Link from 'next/link';

export default function SupplierDetail() {
    const params = useParams();
    const id = params?.id as string;
    const router = useRouter();
    const [supplier, setSupplier] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    // Edit Modal State
    const [isEditing, setIsEditing] = useState(false);
    const [editForm, setEditForm] = useState({
        name: '',
        contact_email: '',
        phone_number: '',
        logo_url: '',
        address: '',
        website_url: '',
        salesperson_name: '',
        salesperson_email: '',
        salesperson_phone: '',
        billing_address: '',
        account_number: '',
        payment_terms: '',
        portal_type: 'gfs_store',
        search_url_pattern: ''
    });

    useEffect(() => {
        fetch(`/api/suppliers/${id}`)
            .then(res => res.json())
            .then(data => {
                setSupplier(data);
                setEditForm({
                    name: data.name || '',
                    contact_email: data.contact_email || '',
                    phone_number: data.phone_number || '',
                    logo_url: data.logo_url || '',
                    address: data.address || '',
                    website_url: data.website_url || '',
                    salesperson_name: data.salesperson_name || '',
                    salesperson_email: data.salesperson_email || '',
                    salesperson_phone: data.salesperson_phone || '',
                    billing_address: data.billing_address || '',
                    account_number: data.account_number || '',
                    payment_terms: data.payment_terms || '',
                    portal_type: data.portal_type || 'gfs_store',
                    search_url_pattern: data.search_url_pattern || ''
                });
                setIsLoading(false);
            })
            .catch(() => alert("Failed to load supplier"));
    }, [id]);

    const handleUpdate = async () => {
        setIsSaving(true);
        try {
            const res = await fetch(`/api/suppliers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editForm)
            });

            if (res.ok) {
                const updated = await res.json();
                setSupplier({ ...supplier, ...updated }); // Optimistic update of main fields
                setIsEditing(false);
                // Ideally reload to fetch strict state if needed
                window.location.reload();
            } else {
                alert("Failed to update");
            }
        } catch (e) {
            alert("Error updating supplier");
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading Supplier...</div>;
    if (!supplier) return <div className="p-12 text-center text-red-500">Supplier not found.</div>;

    const handleAutoFetchLogo = () => {
        if (!editForm.website_url) return;
        const domain = editForm.website_url.replace(/^https?:\/\//, '').split('/')[0];
        const logoUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
        setEditForm(prev => ({ ...prev, logo_url: logoUrl }));
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-32">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-6">
                    <Link href="/suppliers" className="p-3 bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 rounded-full text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition shadow-sm border border-slate-100 dark:border-slate-600">
                        <ArrowLeft size={24} />
                    </Link>
                    <div className="flex items-center gap-4">
                        {supplier.logo_url ? (
                            <div className="w-16 h-16 rounded-xl overflow-hidden bg-white shadow-sm border border-slate-200 dark:border-slate-700">
                                <img src={supplier.logo_url} alt={supplier.name} className="w-full h-full object-contain p-1" />
                            </div>
                        ) : (
                            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-sm font-black text-2xl">
                                {supplier.name.charAt(0)}
                            </div>
                        )}
                        <div>
                            <h1 className="text-4xl font-black text-slate-900 dark:text-white text-adaptive flex items-center gap-4 tracking-tight">
                                {supplier.name}
                            </h1>
                            {supplier.website_url && (
                                <a href={supplier.website_url} target="_blank" className="flex items-center gap-1 text-sm font-bold text-indigo-600 hover:underline mt-1">
                                    {supplier.website_url.replace(/^https?:\/\//, '')} <ExternalLink size={12} />
                                </a>
                            )}
                        </div>
                    </div>
                </div>
                <button
                    onClick={() => setIsEditing(true)}
                    className="flex items-center gap-2 px-5 py-3 bg-white dark:bg-slate-800 text-slate-700 dark:text-white font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
                >
                    <Edit2 size={18} />
                    Edit Details
                </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Commercial & Contact */}
                <div className="space-y-6">

                    {/* Commercial Info Card */}
                    <div className="glass-panel p-6 rounded-3xl bg-white dark:bg-slate-800 dark:border-slate-700 space-y-5">
                        <h3 className="font-bold text-slate-900 text-adaptive border-b border-slate-100/50 dark:border-slate-700 pb-3 text-lg flex items-center gap-2">
                            <CreditCard size={20} className="text-slate-400" /> Commercial
                        </h3>

                        <div className="space-y-4">
                            <div>
                                <p className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-1">Account Number</p>
                                <p className="font-mono text-lg text-slate-900 dark:text-white font-medium">{supplier.account_number || 'N/A'}</p>
                            </div>
                            <div>
                                <p className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-1">Payment Terms</p>
                                <span className="inline-block px-3 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 font-bold text-sm">
                                    {supplier.payment_terms || 'Standard'}
                                </span>
                            </div>
                            <div>
                                <p className="text-xs text-slate-400 font-bold uppercase tracking-wider mb-1">Billing Address</p>
                                <p className="text-sm font-medium text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line">
                                    {supplier.billing_address || 'Same as physical address'}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* General Contact Card */}
                    <div className="glass-panel p-6 rounded-3xl space-y-5 bg-white dark:bg-slate-800 dark:border-slate-700">
                        <h3 className="font-bold text-slate-900 text-adaptive border-b border-slate-100/50 dark:border-slate-700 pb-3 text-lg flex items-center gap-2">
                            <Truck size={20} className="text-slate-400" /> General Contact
                        </h3>

                        {supplier.contact_email && (
                            <div className="flex items-center gap-4 text-slate-600 text-adaptive">
                                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0"><Mail size={20} /></div>
                                <span className="text-sm font-bold">{supplier.contact_email}</span>
                            </div>
                        )}

                        {supplier.phone_number && (
                            <div className="flex items-center gap-4 text-slate-600 text-adaptive">
                                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0"><Phone size={20} /></div>
                                <span className="text-sm font-bold">{supplier.phone_number}</span>
                            </div>
                        )}

                        {supplier.address && (
                            <div className="flex items-center gap-4 text-slate-600 text-adaptive">
                                <div className="w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0"><MapPin size={20} /></div>
                                <span className="text-sm font-medium leading-relaxed">{supplier.address}</span>
                            </div>
                        )}
                    </div>

                    {/* Sales Rep Card */}
                    <div className="glass-panel p-6 rounded-3xl space-y-5 bg-white dark:bg-slate-800 dark:border-slate-700 border-l-4 border-l-purple-500">
                        <h3 className="font-bold text-slate-900 text-adaptive border-b border-slate-100/50 dark:border-slate-700 pb-3 text-lg flex items-center gap-2">
                            <User size={20} className="text-purple-500" /> Sales Rep
                        </h3>

                        {(!supplier.salesperson_name && !supplier.salesperson_email) ? (
                            <p className="text-slate-400 italic text-sm">No sales rep assigned.</p>
                        ) : (
                            <>
                                {supplier.salesperson_name && <p className="font-bold text-lg text-slate-900 dark:text-white">{supplier.salesperson_name}</p>}
                                <div className="space-y-3">
                                    {supplier.salesperson_email && (
                                        <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-400">
                                            <Mail size={16} /> {supplier.salesperson_email}
                                        </div>
                                    )}
                                    {supplier.salesperson_phone && (
                                        <div className="flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-400">
                                            <Phone size={16} /> {supplier.salesperson_phone}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Right Column: Associated Ingredients */}
                <div className="lg:col-span-2 space-y-6">
                    <h2 className="text-2xl font-black text-slate-900 text-adaptive tracking-tight flex items-center gap-3">
                        <Package className="text-slate-300 dark:text-slate-500" /> Sourced Ingredients
                    </h2>

                    <div className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
                        {supplier.ingredients && supplier.ingredients.length > 0 ? (
                            <table className="w-full text-left">
                                <thead className="bg-slate-50 dark:bg-slate-900/50 text-xs font-bold uppercase text-slate-500 border-b border-slate-200 dark:border-slate-700">
                                    <tr>
                                        <th className="px-6 py-4">Ingredient</th>
                                        <th className="px-6 py-4">SKU</th>
                                        <th className="px-6 py-4 text-right">Purchase Cost</th>
                                        <th className="px-6 py-4 text-right">In Stock</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                                    {supplier.ingredients
                                        .filter((ing: any) => ing.unit.toLowerCase() !== 'batch')
                                        .map((ing: any) => (
                                            <tr key={ing.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                                                <td className="px-6 py-4 font-medium text-slate-900 dark:text-white">{ing.name}</td>
                                                <td className="px-6 py-4 font-mono text-xs text-slate-500">{ing.sku || '-'}</td>
                                                <td className="px-6 py-4 text-right font-medium text-slate-700 dark:text-slate-300">
                                                    {ing.purchase_cost && ing.purchase_unit && ing.purchase_quantity ? (
                                                        <>
                                                            ${Number(ing.purchase_cost || 0).toFixed(2)} / {ing.purchase_unit}
                                                            <span className="block text-xs text-slate-400 mt-0.5">
                                                                ({Number(ing.purchase_quantity).toFixed(2)} {ing.unit} per {ing.purchase_unit})
                                                            </span>
                                                        </>
                                                    ) : (
                                                        <span className="text-slate-400">-</span>
                                                    )}
                                                </td>
                                                <td className="px-6 py-4 text-right text-sm text-slate-600 dark:text-slate-400">
                                                    {Number(ing.stock_quantity || 0).toFixed(2)} {ing.unit}
                                                </td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        ) : (
                            <div className="p-12 text-center text-slate-500">
                                No ingredients linked to this supplier yet.
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Edit Modal */}
            {isEditing && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-8 animate-in fade-in zoom-in duration-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white">Edit Supplier</h3>
                            <button onClick={() => setIsEditing(false)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors">
                                <X size={24} className="text-slate-400" />
                            </button>
                        </div>

                        <div className="space-y-6">
                            {/* Basic Info */}
                            <div className="space-y-4">
                                <h4 className="font-bold text-indigo-600 text-sm uppercase tracking-wide">About</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="col-span-2">
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Company Name</label>
                                        <input
                                            value={editForm.name}
                                            onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Website</label>
                                        <div className="flex gap-2">
                                            <input
                                                value={editForm.website_url}
                                                onChange={e => setEditForm({ ...editForm, website_url: e.target.value })}
                                                placeholder="https://..."
                                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Logo URL</label>
                                        <div className="flex gap-2">
                                            <input
                                                value={editForm.logo_url || ''}
                                                onChange={e => setEditForm({ ...editForm, logo_url: e.target.value })}
                                                placeholder="https://..."
                                                className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                            />
                                            <button
                                                onClick={handleAutoFetchLogo}
                                                disabled={!editForm.website_url}
                                                className="px-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 rounded-xl text-xs font-bold transition disabled:opacity-50 whitespace-nowrap"
                                                title="Try to fetch logo from website"
                                            >
                                                Auto-Fetch
                                            </button>
                                        </div>
                                        {editForm.logo_url && (
                                            <div className="mt-2 flex items-center gap-2">
                                                <div className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-white p-0.5">
                                                    <img src={editForm.logo_url} alt="Preview" className="w-full h-full object-contain" />
                                                </div>
                                                <span className="text-xs text-green-600 dark:text-green-400 font-bold">Preview</span>
                                            </div>
                                        )}
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">General Phone</label>
                                        <input
                                            value={editForm.phone_number}
                                            onChange={e => setEditForm({ ...editForm, phone_number: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Commercial */}
                            <div className="space-y-4">
                                <h4 className="font-bold text-indigo-600 text-sm uppercase tracking-wide pt-4 border-t border-slate-100 dark:border-slate-700">Commercial</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Account Number</label>
                                        <input
                                            value={editForm.account_number}
                                            onChange={e => setEditForm({ ...editForm, account_number: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Payment Terms</label>
                                        <select
                                            value={editForm.payment_terms}
                                            onChange={e => setEditForm({ ...editForm, payment_terms: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 appearance-none"
                                        >
                                            <option value="">Select Terms...</option>
                                            <option value="Net 7">Net 7</option>
                                            <option value="Net 15">Net 15</option>
                                            <option value="Net 30">Net 30</option>
                                            <option value="Net 60">Net 60</option>
                                            <option value="Due on Receipt">Due on Receipt</option>
                                            <option value="Credit Card">Credit Card</option>
                                        </select>
                                    </div>
                                    <div className="col-span-2">
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Billing Address</label>
                                        <textarea
                                            value={editForm.billing_address}
                                            onChange={e => setEditForm({ ...editForm, billing_address: e.target.value })}
                                            rows={2}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                                        />
                                    </div>
                                </div>
                            </div>


                            {/* Sales Rep */}
                            <div className="space-y-4">
                                <h4 className="font-bold text-indigo-600 text-sm uppercase tracking-wide pt-4 border-t border-slate-100 dark:border-slate-700">Sales Representative</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="col-span-2">
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Rep Name</label>
                                        <input
                                            value={editForm.salesperson_name}
                                            onChange={e => setEditForm({ ...editForm, salesperson_name: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Rep Email</label>
                                        <input
                                            value={editForm.salesperson_email}
                                            onChange={e => setEditForm({ ...editForm, salesperson_email: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Rep Phone</label>
                                        <input
                                            value={editForm.salesperson_phone}
                                            onChange={e => setEditForm({ ...editForm, salesperson_phone: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Integration & Portals */}
                            <div className="space-y-4">
                                <h4 className="font-bold text-indigo-600 text-sm uppercase tracking-wide pt-4 border-t border-slate-100 dark:border-slate-700">Integration & Portals</h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Portal Type</label>
                                        <select
                                            value={editForm.portal_type}
                                            onChange={e => setEditForm({ ...editForm, portal_type: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                                        >
                                            <option value="gfs_store">GFS Store</option>
                                            <option value="sysco_shop">Sysco Shop</option>
                                            <option value="usfoods_ordering">US Foods Ordering</option>
                                            <option value="custom">Custom Portal</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Search URL Pattern</label>
                                        <input
                                            value={editForm.search_url_pattern}
                                            onChange={e => setEditForm({ ...editForm, search_url_pattern: e.target.value })}
                                            className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-xs"
                                            placeholder="https://.../search?q={{query}}"
                                        />
                                    </div>
                                    <p className="col-span-2 text-[10px] text-slate-400 italic">
                                        Use `{"{{query}}"}` as a placeholder for the ingredient name to enable deep-linking from the Production Hub.
                                    </p>
                                </div>
                            </div>

                            <div className="pt-6 flex gap-3 justify-end border-t border-slate-100 dark:border-slate-700">
                                <button
                                    onClick={() => setIsEditing(false)}
                                    className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleUpdate}
                                    disabled={isSaving}
                                    className="px-8 py-3 rounded-xl font-bold bg-indigo-600 text-white hover:scale-105 active:scale-95 transition-all shadow-lg shadow-indigo-200 dark:shadow-none"
                                >
                                    {isSaving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
