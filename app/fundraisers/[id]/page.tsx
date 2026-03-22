"use client";

import { useState, useEffect, use } from 'react';
import { format } from 'date-fns';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Save, Calendar, StickyNote, MapPin, Mail, User, Edit2, X, Phone, Check, FileText, Send, Loader2, FileCheck, Megaphone } from 'lucide-react';
import Link from 'next/link';
import DocumentsTab from '@/components/crm/DocumentsTab';
import FundraisersTab from '@/components/crm/FundraisersTab';
import FundraiserOverview from '@/components/crm/FundraiserOverview';
import { STATUS_COLORS, STATUS_LABELS, type CustomerStatus } from '@/lib/statusConstants';

export default function FundraiserProfilePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [customer, setCustomer] = useState<any>(null);
    const [notes, setNotes] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [businessSlug, setBusinessSlug] = useState('');
    const [bundles, setBundles] = useState<any[]>([]);
    const [isAddingOrder, setIsAddingOrder] = useState(false);

    // Default tab to overview for this specialized page
    const searchParams = useSearchParams();
    const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'overview');

    useEffect(() => {
        // Fetch current user/business info to get the slug
        fetch('/api/business')
            .then(async res => {
                const contentType = res.headers.get('content-type');
                if (!res.ok || !contentType?.includes('application/json')) {
                    throw new Error('Failed to load business data');
                }
                return res.json();
            })
            .then(data => {
                if (data.slug) setBusinessSlug(data.slug);
            })
            .catch(err => console.error("[CustomerProfile] Failed to fetch business:", err));

        // Fetch bundles for order modal
        fetch('/api/bundles')
            .then(res => res.json())
            .then(data => setBundles(data))
            .catch(err => console.error("Failed to fetch bundles:", err));
    }, []);

    // Check if customer can use documents
    const hasDocumentsAccess = customer && (customer.type === 'Fundraiser' || customer.type === 'Organization');

    // Edit Modal State
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [editForm, setEditForm] = useState({
        name: '',
        contact_name: '',
        email: '',
        phone: '',
        delivery_address: '',
        status: 'Active',
        inactive_reason: '',
        tags: '',
        type: 'Individual'
    });

    const fetchCustomer = () => {
        setIsLoading(true);
        fetch(`/api/customers/${id}`, { cache: 'no-store' })
            .then(async res => {
                const data = await res.json();
                if (!res.ok) {
                    setCustomer({ error: data.error || 'Failed to load customer' });
                    setIsLoading(false);
                    return;
                }
                setCustomer(data);
                setNotes(data.notes || '');
                setEditForm({
                    name: data.name || '',
                    contact_name: data.contact_name || '',
                    email: data.email || '',
                    phone: data.phone || '',
                    delivery_address: data.delivery_address || '',
                    status: data.rawStatus || data.status || 'LEAD',
                    inactive_reason: data.inactive_reason || '',
                    tags: (data.tags || []).join(', '),
                    type: data.type || 'Individual'
                });
                setIsLoading(false);
            })
            .catch(() => {
                setCustomer({ error: "Failed to load customer" });
                setIsLoading(false);
            });
    };

    useEffect(() => {
        fetchCustomer();
    }, [id]);

    const handleUpdateProfile = async (overrideData?: any) => {
        setIsSaving(true);
        try {
            const baseForm = {
                ...editForm,
                tags: typeof editForm.tags === 'string'
                    ? editForm.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
                    : editForm.tags,
                notes
            };

            const payload = overrideData ? { ...baseForm, ...overrideData } : baseForm;

            const res = await fetch(`/api/customers/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const updated = await res.json();
                setIsEditingProfile(false);
                if (updated.newId && updated.newId !== id) {
                    router.push(`/customers/${updated.newId}`);
                } else {
                    setCustomer((prev: any) => ({ ...prev, ...payload }));
                    setEditForm(prev => ({
                        ...prev,
                        ...payload,
                        tags: Array.isArray(payload.tags) ? payload.tags.join(', ') : prev.tags
                    }));
                    if (!overrideData) {
                        alert("Profile updated successfully!");
                        window.location.reload();
                    }
                }
            } else {
                const err = await res.json();
                alert(err.error || "Failed to update profile");
            }
        } catch (e: any) {
            console.error(e);
            alert(`Error updating profile: ${e.message}`);
        } finally {
            setIsSaving(false);
        }
    };

    const toggleOrderStatus = async (orderId: string, currentStatus: string) => {
        const newStatus = currentStatus === 'delivered' ? 'completed' : 'delivered';
        try {
            const res = await fetch('/api/orders', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: orderId, status: newStatus })
            });

            if (res.ok) {
                setCustomer((prev: any) => ({
                    ...prev,
                    orders: prev.orders.map((o: any) =>
                        o.id === orderId ? { ...o, status: newStatus } : o
                    )
                }));
            } else {
                alert("Failed to update status");
            }
        } catch (e) {
            console.error("Failed to update order status", e);
        }
    };

    if (isLoading) return <div className="p-12 text-center text-slate-500">Loading Profile...</div>;
    if (!customer || customer.error) {
        return (
            <div className="p-12 text-center space-y-4">
                <div className="text-red-500 font-bold text-xl">{customer?.error || "Partner not found."}</div>
                <p className="text-slate-500">You may have switched businesses or this fundraiser no longer exists.</p>
                <Link href="/fundraisers" className="inline-block px-6 py-2 bg-indigo-600 text-white rounded-xl font-bold">
                    Back to Campaigns
                </Link>
            </div>
        );
    }

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-32">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-6">
                    <Link href="/fundraisers" className="p-3 bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 rounded-full text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition shadow-sm border border-slate-100 dark:border-slate-600">
                        <ArrowLeft size={24} />
                    </Link>
                    <div>
                        <h1 className="text-4xl font-black text-slate-900 dark:text-white flex items-center gap-4 tracking-tight">
                            {customer.name}
                            <span className="text-sm px-4 py-1.5 rounded-full uppercase font-bold tracking-wide bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-100">
                                Fundraiser Partner
                            </span>
                            {customer.status && (
                                (() => {
                                    const normalized = customer.status.toUpperCase().replace(/\s+/g, '_') as CustomerStatus;
                                    const colors = STATUS_COLORS[normalized] || STATUS_COLORS.LEAD;
                                    const label = STATUS_LABELS[normalized] || customer.status;
                                    return (
                                        <span className={`text-sm px-4 py-1.5 rounded-full uppercase font-bold tracking-wide border ${colors.border} ${colors.bg} ${colors.text}`}>
                                            {label}
                                        </span>
                                    );
                                })()
                            )}
                        </h1>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => handleUpdateProfile()}
                        disabled={isSaving}
                        className="flex items-center gap-2 px-6 py-3 bg-white dark:bg-slate-800 text-slate-700 dark:text-white font-bold rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
                    >
                        <Save size={18} />
                        {isSaving ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button
                        onClick={() => setIsEditingProfile(true)}
                        className="flex items-center gap-2 px-5 py-3 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
                    >
                        <Edit2 size={18} />
                        Edit Profile
                    </button>
                </div>
            </div>

            {/* Tabs Navigation */}
            <div className="flex gap-2 border-b border-slate-200 dark:border-slate-700 pb-1">
                <button
                    onClick={() => setActiveTab('overview')}
                    className={`px-6 py-3 rounded-t-xl font-bold flex items-center gap-2 transition-all ${activeTab === 'overview'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <Megaphone size={18} />
                    Overview
                </button>
                <button
                    onClick={() => setActiveTab('campaigns')}
                    className={`px-6 py-3 rounded-t-xl font-bold flex items-center gap-2 transition-all ${activeTab === 'campaigns'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <Megaphone size={18} />
                    Campaigns
                </button>
                {hasDocumentsAccess && (
                    <button
                        onClick={() => setActiveTab('documents')}
                        className={`px-6 py-3 rounded-t-xl font-bold flex items-center gap-2 transition-all ${activeTab === 'documents'
                            ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                            : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                    >
                        <FileCheck size={18} />
                        Documents
                    </button>
                )}
            </div>

            {/* TAB CONTENT */}
            {activeTab === 'overview' && (
                <FundraiserOverview
                    customer={customer}
                    onUpdateCustomer={handleUpdateProfile}
                    onEditProfile={() => setIsEditingProfile(true)}
                    onNavigateToCampaigns={() => setActiveTab('campaigns')}
                />
            )}

            {activeTab === 'campaigns' && (
                <FundraisersTab
                    customerId={customer.id}
                    businessSlug={businessSlug}
                />
            )}

            {activeTab === 'documents' && <DocumentsTab customer={customer} />}

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
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Status</label>
                                    <select
                                        value={editForm.status}
                                        onChange={e => setEditForm({ ...editForm, status: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white appearance-none"
                                    >
                                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                                            <option key={value} value={value}>{label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Partner Type</label>
                                    <select
                                        value={editForm.type}
                                        onChange={e => setEditForm({ ...editForm, type: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white appearance-none"
                                    >
                                        <option value="Organization">Organization (B2B)</option>
                                        <option value="Fundraiser">Fundraiser Group</option>
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Organization Name</label>
                                <input
                                    value={editForm.name}
                                    onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    placeholder="e.g. Spring 2026 PTA"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                                    Primary Contact Person
                                </label>
                                <input
                                    value={editForm.contact_name}
                                    onChange={e => setEditForm({ ...editForm, contact_name: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    placeholder={editForm.type === 'Individual' ? "e.g. John Doe" : "e.g. Jane Smith"}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Email</label>
                                    <input
                                        value={editForm.email}
                                        onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Phone</label>
                                    <input
                                        value={editForm.phone}
                                        onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Delivery Address</label>
                                <input
                                    value={editForm.delivery_address}
                                    onChange={e => setEditForm({ ...editForm, delivery_address: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    placeholder="123 Fundraiser Lane, Chicago, IL"
                                />
                            </div>

                            <div className="pt-4 flex gap-3 justify-end">
                                <button onClick={() => setIsEditingProfile(false)} className="px-6 py-3 rounded-xl font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700">Cancel</button>
                                <button onClick={() => handleUpdateProfile()} disabled={isSaving} className="px-8 py-3 rounded-xl font-bold bg-indigo-600 text-white hover:scale-105 active:scale-95 disabled:opacity-50 transition-all">Save</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
