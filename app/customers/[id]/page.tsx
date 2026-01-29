"use client";

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, ShoppingBag, Calendar, DollarSign, StickyNote, MapPin, Mail, User, Edit2, X, Phone } from 'lucide-react';
import Link from 'next/link';

export default function CustomerProfilePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [customer, setCustomer] = useState<any>(null);
    const [notes, setNotes] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    // Edit Modal State
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [editForm, setEditForm] = useState({
        name: '',
        email: '',
        phone: '',
        address: '',
        status: 'Active',
        inactive_reason: '',
        tags: '',
        type: 'Organization'
    });

    useEffect(() => {
        fetch(`/api/customers/${id}`)
            .then(res => res.json())
            .then(data => {
                setCustomer(data);
                setNotes(data.notes || '');
                setEditForm({
                    name: data.name || '',
                    email: data.email || '',
                    phone: data.phone || '',
                    address: data.address || '',
                    status: data.status || 'Active',
                    inactive_reason: data.inactive_reason || '',
                    tags: (data.tags || []).join(', '),
                    type: data.type || 'Organization'
                });
                setIsLoading(false);
            })
            .catch(() => alert("Failed to load customer"));
    }, [id]);

    const handleUpdateProfile = async () => {
        setIsSaving(true);
        try {
            const res = await fetch(`/api/customers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...editForm,
                    tags: editForm.tags.split(',').map(t => t.trim()).filter(Boolean),
                    notes // Include current notes to avoid overwriting if API expects full object
                })
            });

            if (res.ok) {
                // Refresh data
                const updated = await res.json();
                setIsEditingProfile(false);
                if (updated.newId && updated.newId !== id) {
                    // Redirect if ID changed (Promotion from Name to UUID)
                    router.push(`/customers/${updated.newId}`);
                } else {
                    alert("Profile updated successfully!");
                    window.location.reload();
                }
            } else {
                const err = await res.json();
                alert(err.error || "Failed to update profile");
            }
        } catch (e) {
            alert("Error updating profile");
        } finally {
            setIsSaving(false);
        }
    };


    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading Profile...</div>;
    if (!customer) return <div className="p-12 text-center text-red-500">Customer not found.</div>;

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-32">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-6">
                    <Link href="/customers" className="p-3 bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 rounded-full text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition shadow-sm border border-slate-100 dark:border-slate-600">
                        <ArrowLeft size={24} />
                    </Link>
                    <div>
                        <h1 className="text-4xl font-black text-slate-900 dark:text-white text-adaptive flex items-center gap-4 tracking-tight">
                            {customer.name}
                            <span className={`text-sm px-4 py-1.5 rounded-full uppercase font-bold tracking-wide cursor-default shadow-sm 
                                ${customer.type === 'Organization' ? 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-100' : 'bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-100'}`}>
                                {customer.type}
                            </span>
                            {customer.status && (
                                <span className={`text-sm px-4 py-1.5 rounded-full uppercase font-bold tracking-wide cursor-default shadow-sm 
                                    ${customer.status === 'Active' ? 'bg-emerald-100 text-emerald-700' :
                                        customer.status === 'At-Risk' ? 'bg-amber-100 text-amber-700' :
                                            customer.status === 'Inactive' ? 'bg-slate-100 text-slate-600' :
                                                customer.status === 'Lead' ? 'bg-blue-100 text-blue-700' :
                                                    'bg-rose-100 text-rose-700'}`}>
                                    {customer.status}
                                </span>
                            )}
                        </h1>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleUpdateProfile}
                        disabled={isSaving}
                        className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-none transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
                    >
                        <Save size={18} />
                        {isSaving ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button
                        onClick={() => setIsEditingProfile(true)}
                        className="flex items-center gap-2 px-5 py-3 bg-white dark:bg-slate-800 text-slate-700 dark:text-white font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
                    >
                        <Edit2 size={18} />
                        Edit Profile
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Stats & Info */}
                <div className="space-y-6">
                    {/* Quick Stats */}
                    <div className="glass-panel p-6 rounded-3xl bg-white dark:bg-slate-800 dark:border-slate-700">
                        <div className="flex flex-col gap-4">
                            <div className="p-5 bg-white bg-adaptive rounded-2xl border border-white/40 dark:border-slate-600">
                                <p className="text-xs text-slate-400 text-adaptive-subtle font-bold uppercase mb-2 tracking-wider">Total Orders</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 text-adaptive">
                                    <ShoppingBag size={24} className="text-indigo-500 dark:text-indigo-400 shrink-0" />
                                    <span className="text-slate-900 text-adaptive">{customer.orders.length}</span>
                                </div>
                            </div>
                            <div className="p-5 bg-white bg-adaptive rounded-2xl border border-white/40 dark:border-slate-600">
                                <p className="text-xs text-slate-400 text-adaptive-subtle font-bold uppercase mb-2 tracking-wider">Lifetime Spend</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 text-adaptive">
                                    <DollarSign size={24} className="text-emerald-500 dark:text-emerald-400 shrink-0" />
                                    <span className="text-slate-900 text-adaptive">{customer.total_spend || '$0.00'}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Contact Card */}
                <div className="glass-panel p-6 rounded-3xl space-y-5 bg-white dark:bg-slate-800 dark:border-slate-700">
                    <h3 className="font-bold text-slate-900 text-adaptive border-b border-slate-100/50 dark:border-slate-700 pb-3 text-lg">Contact Details</h3>

                    {customer.email && (
                        <Link
                            href={`/campaigns?to=${encodeURIComponent(customer.email)}&name=${encodeURIComponent(customer.name)}`}
                            className="flex items-center gap-4 text-slate-600 text-adaptive group hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors pointer-events-auto"
                        >
                            <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform"><Mail size={20} /></div>
                            <span className="text-sm font-bold underline decoration-slate-200 group-hover:decoration-indigo-400 underline-offset-4 decoration-2 transition-all">{customer.email}</span>
                        </Link>
                    )}

                    {customer.phone && (
                        <div className="flex items-center gap-4 text-slate-600 text-adaptive">
                            <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0"><Phone size={20} /></div>
                            <span className="text-sm font-bold">{customer.phone}</span>
                        </div>
                    )}

                    {customer.address && (
                        <div className="flex items-center gap-4 text-slate-600 text-adaptive">
                            <div className="w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0"><MapPin size={20} /></div>
                            <span className="text-sm font-medium leading-relaxed">{customer.address}</span>
                        </div>
                    )}

                    <div className="flex items-center gap-4 text-slate-400 text-adaptive-subtle pt-2 border-t border-slate-100/50 dark:border-slate-700">
                        <div className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-slate-800 text-slate-400 text-adaptive-subtle flex items-center justify-center shrink-0"><User size={20} /></div>
                        <span className="text-xs font-mono text-slate-500 text-adaptive-subtle">ID: {customer.id}</span>
                    </div>
                </div>

                {/* Kitchen Notes */}
                <div className="relative overflow-hidden bg-yellow-50/80 dark:bg-yellow-900/10 backdrop-blur-xl p-6 rounded-3xl border border-yellow-200/50 dark:border-yellow-900/30 shadow-soft">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-yellow-300 to-orange-300 dark:from-yellow-700 dark:to-orange-700"></div>
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="font-black text-yellow-900 dark:text-yellow-100 flex items-center gap-2 text-lg">
                            <StickyNote size={20} className="fill-yellow-400 text-yellow-600 dark:text-yellow-500" /> Kitchen Notes
                        </h3>
                    </div>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        className="w-full bg-yellow-100/30 dark:bg-yellow-900/20 border border-yellow-200/50 dark:border-yellow-700/30 rounded-2xl p-4 text-sm text-yellow-900 dark:text-yellow-50 placeholder:text-yellow-600/50 dark:placeholder:text-yellow-100/30 focus:outline-none focus:bg-white/50 dark:focus:bg-yellow-900/40 focus:ring-2 focus:ring-yellow-400/50 transition-all min-h-[180px] font-medium leading-relaxed"
                        placeholder="Add preferences, allergies, or delivery notes here..."
                    />
                </div>
            </div>

            {/* Right Column: Order History */}
            <div className="lg:col-span-2 space-y-6">
                <h2 className="text-2xl font-black text-slate-900 text-adaptive tracking-tight flex items-center gap-3">
                    <Calendar className="text-slate-300 dark:text-slate-500" /> Order History
                </h2>

                <div className="space-y-4">
                    {customer.orders.map((order: any) => (
                        <div key={order.id} className="glass-panel p-6 rounded-3xl hover:scale-[1.01] hover:shadow-lg transition-all duration-300 group bg-white dark:bg-slate-800 dark:border-slate-700">
                            <div className="flex justify-between items-start mb-5">
                                <div>
                                    <div className="flex items-center gap-3 mb-1">
                                        <span className="font-black text-slate-900 text-adaptive text-xl">Order #{order.id}</span>
                                        <span className={`px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wide ${order.status === 'pending' ? 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300' : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'}`}>
                                            {order.status}
                                        </span>
                                    </div>
                                    <p className="text-sm font-bold text-slate-400 text-adaptive-subtle">
                                        {new Date(order.date).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="font-black text-slate-900 text-adaptive text-2xl tracking-tight">{order.total}</p>
                                </div>
                            </div>

                            <div className="bg-slate-50 bg-adaptive rounded-2xl p-5 border border-slate-100/50 dark:border-slate-600">
                                <p className="text-sm font-medium text-slate-600 text-adaptive">
                                    {order.items}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            {/* Edit Profile Modal */}
            {isEditingProfile && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl w-full max-w-lg p-8 animate-in fade-in zoom-in duration-200">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white">Edit Customer</h3>
                            <button onClick={() => setIsEditingProfile(false)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition-colors">
                                <X size={24} className="text-slate-400" />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Name</label>
                                <input
                                    value={editForm.name}
                                    onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Status</label>
                                    <select
                                        value={editForm.status}
                                        onChange={e => setEditForm({ ...editForm, status: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold appearance-none"
                                    >
                                        <option value="Active">Active</option>
                                        <option value="Lead">Lead</option>
                                        <option value="At-Risk">At-Risk</option>
                                        <option value="Inactive">Inactive</option>
                                        <option value="Churned">Churned</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Customer Type</label>
                                    <select
                                        value={editForm.type}
                                        onChange={e => setEditForm({ ...editForm, type: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold appearance-none"
                                    >
                                        <option value="Individual">Individual</option>
                                        <option value="Organization">Organization</option>
                                    </select>
                                </div>
                                {editForm.status === 'Inactive' && (
                                    <div className="animate-in fade-in slide-in-from-top-2 duration-200">
                                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Reason</label>
                                        <select
                                            value={editForm.inactive_reason}
                                            onChange={e => setEditForm({ ...editForm, inactive_reason: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold appearance-none"
                                        >
                                            <option value="">Select Reason...</option>
                                            <option value="On Pause">On Pause</option>
                                            <option value="Seasonal">Seasonal</option>
                                            <option value="Price">Price</option>
                                            <option value="Timing">Timing</option>
                                            <option value="No Longer Needs Service">No Longer Needs Service</option>
                                        </select>
                                    </div>
                                )}
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Source</label>
                                    <input
                                        disabled
                                        value={customer.source || 'Manual'}
                                        className="w-full px-4 py-3 bg-slate-100 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-500 cursor-not-allowed"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Email</label>
                                <input
                                    value={editForm.email}
                                    onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Phone</label>
                                <input
                                    value={editForm.phone}
                                    onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Shipping Address</label>
                                <textarea
                                    value={editForm.address}
                                    onChange={e => setEditForm({ ...editForm, address: e.target.value })}
                                    rows={3}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-medium resize-none"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Tags (Comma separated)</label>
                                <input
                                    value={editForm.tags}
                                    onChange={e => setEditForm({ ...editForm, tags: e.target.value })}
                                    placeholder="VIP, Wholesale, Local..."
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-medium"
                                />
                            </div>

                            <div className="pt-4 flex gap-3 justify-end">
                                <button
                                    onClick={() => setIsEditingProfile(false)}
                                    className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleUpdateProfile}
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
