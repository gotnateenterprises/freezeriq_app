"use client";

import { useState, useEffect, use } from 'react';
import { format } from 'date-fns';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, ShoppingBag, Calendar, DollarSign, StickyNote, MapPin, Mail, User, Edit2, X, Phone, Check, FileText, Send, Loader2, LayoutDashboard, FileCheck, Clock, Megaphone } from 'lucide-react';
import Link from 'next/link';
import DocumentsTab from '@/components/crm/DocumentsTab';
import ActivityFeed from '@/components/crm/ActivityFeed';
import CustomerOverview from '@/components/crm/CustomerOverview';
import FundraisersTab from '@/components/crm/FundraisersTab';
import AddOrderModal from '@/components/AddOrderModal';
import { STATUS_COLORS, STATUS_LABELS, type CustomerStatus } from '@/lib/statusConstants';

export default function CustomerProfilePage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params);
    const router = useRouter();
    const [customer, setCustomer] = useState<any>(null);
    const [notes, setNotes] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [businessSlug, setBusinessSlug] = useState('');
    const [bundles, setBundles] = useState<any[]>([]);
    const [isAddingOrder, setIsAddingOrder] = useState(false);

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
    const [activeTab, setActiveTab] = useState('overview');

    // Edit Modal State
    const [isEditingProfile, setIsEditingProfile] = useState(false);
    const [editForm, setEditForm] = useState({
        name: '',
        contact_name: '',
        email: '',
        phone: '',
        secondary_phone: '',
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
                    secondary_phone: data.secondary_phone || '',
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
                <div className="text-red-500 font-bold text-xl">{customer?.error || "Customer not found."}</div>
                <p className="text-slate-500">You may have switched businesses or this customer no longer exists.</p>
                <Link href="/customers" className="inline-block px-6 py-2 bg-indigo-600 text-white rounded-xl font-bold">
                    Back to Customers
                </Link>
            </div>
        );
    }

    return (
        <div className="max-w-6xl mx-auto space-y-8 pb-32">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-6">
                    <Link href="/customers" className="p-3 bg-white dark:bg-slate-700 hover:bg-slate-50 dark:hover:bg-slate-600 rounded-full text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition shadow-sm border border-slate-100 dark:border-slate-600">
                        <ArrowLeft size={24} />
                    </Link>
                    <div>
                        <h1 className="text-4xl font-black text-slate-900 dark:text-white flex items-center gap-4 tracking-tight">
                            {customer.name}
                            <span className={`text-sm px-4 py-1.5 rounded-full uppercase font-bold tracking-wide 
                                ${customer.type === 'Organization' ? 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-100' : 'bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-100'}`}>
                                {customer.type}
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
                        onClick={() => setIsAddingOrder(true)}
                        className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-none transition-all hover:scale-105 active:scale-95"
                    >
                        <ShoppingBag size={18} />
                        New Order
                    </button>
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
                    <LayoutDashboard size={18} />
                    Overview
                </button>
                <button
                    onClick={() => setActiveTab('orders')}
                    className={`px-6 py-3 rounded-t-xl font-bold flex items-center gap-2 transition-all ${activeTab === 'orders'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <ShoppingBag size={18} />
                    Orders <span className="bg-slate-200 dark:bg-slate-700 px-2 py-0.5 rounded-full text-xs">{(customer.orders || []).length}</span>
                </button>
                <button
                    onClick={() => setActiveTab('history')}
                    className={`px-6 py-3 rounded-t-xl font-bold flex items-center gap-2 transition-all ${activeTab === 'history'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <Clock size={18} />
                    History
                </button>
                <button
                    onClick={() => setActiveTab('fundraisers')}
                    className={`px-6 py-3 rounded-t-xl font-bold flex items-center gap-2 transition-all ${activeTab === 'fundraisers'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : customer.type === 'ORGANIZATION'
                            ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-50/50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/30'
                            : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <Megaphone size={18} className={customer.type === 'ORGANIZATION' && activeTab !== 'fundraisers' ? 'animate-pulse' : ''} />
                    Campaigns <span className="bg-slate-200 dark:bg-slate-700 px-2 py-0.5 rounded-full text-xs">{(customer.campaigns || []).length}</span>
                </button>
                <button
                    onClick={() => setActiveTab('subscriptions')}
                    className={`px-6 py-3 rounded-t-xl font-bold flex items-center gap-2 transition-all ${activeTab === 'subscriptions'
                        ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 border-b-2 border-indigo-500'
                        : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-700 dark:hover:text-slate-300'}`}
                >
                    <Calendar size={18} />
                    Subscriptions <span className="bg-slate-200 dark:bg-slate-700 px-2 py-0.5 rounded-full text-xs">{(customer.orders || []).flatMap((o: any) => o.orderItems || []).filter((i: any) => i.is_subscription).length}</span>
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
                <CustomerOverview
                    customer={customer}
                    onUpdateCustomer={handleUpdateProfile}
                    onEditProfile={() => setIsEditingProfile(true)}
                />
            )}

            {activeTab === 'orders' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="space-y-4">
                        {(customer.orders || []).map((order: any) => (
                            <div key={order.id} className="glass-panel p-6 rounded-3xl hover:scale-[1.01] hover:shadow-lg transition-all duration-300 group bg-white dark:bg-slate-800 dark:border-slate-700">
                                <div className="flex justify-between items-start mb-5">
                                    <div>
                                        <div className="flex items-center gap-3 mb-1">
                                            <span className="font-black text-slate-900 text-xl">Order #{order.id}</span>
                                            <span className={`px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wide ${order.status === 'pending' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>
                                                {order.status}
                                            </span>
                                            {order.orderItems?.some((i: any) => i.is_subscription) && (
                                                <span className="px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wide bg-indigo-100 text-indigo-700 flex items-center gap-1">
                                                    <Calendar size={12} /> Subscription
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm font-bold text-slate-400">
                                            {format(new Date(order.date), 'EEEE, MMMM d, yyyy')}
                                        </p>
                                    </div>
                                    <div className="flex items-start gap-6">
                                        <div className="flex flex-col items-center gap-1 group/check">
                                            <label className="text-[10px] font-black uppercase text-slate-400 group-hover/check:text-emerald-500 transition-colors">Delivered</label>
                                            <button
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    toggleOrderStatus(order.id, order.status);
                                                }}
                                                className={`w-8 h-8 rounded-xl border-2 flex items-center justify-center transition-all duration-300 ${order.status === 'delivered' ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-slate-200 text-transparent'}`}
                                            >
                                                <Check size={18} strokeWidth={3} className={order.status === 'delivered' ? 'scale-100 opacity-100' : 'scale-50 opacity-0'} />
                                            </button>
                                        </div>
                                        <div className="text-right">
                                            <p className="font-black text-slate-900 text-2xl tracking-tight">{order.total}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="bg-slate-50 dark:bg-slate-900/50 rounded-2xl p-5 border border-slate-100/50 dark:border-slate-600">
                                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
                                        {order.items}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {activeTab === 'subscriptions' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {(customer.orders || [])
                            .flatMap((o: any) => (o.orderItems || []).map((i: any) => ({ ...i, orderDate: o.date, orderId: o.id })))
                            .filter((i: any) => i.is_subscription)
                            .map((item: any, idx: number) => (
                                <div key={idx} className="glass-panel p-6 rounded-3xl bg-white dark:bg-slate-800 border border-indigo-100 dark:border-indigo-900 shadow-sm hover:shadow-md transition-all">
                                    <div className="flex justify-between items-start mb-4">
                                        <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-900/30 rounded-2xl flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                                            <Calendar size={24} />
                                        </div>
                                        <span className="px-3 py-1 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-black uppercase tracking-widest">Active</span>
                                    </div>
                                    <h4 className="font-black text-slate-900 dark:text-white text-lg mb-1">{item.name}</h4>
                                    <p className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">{item.serving_tier}</p>

                                    <div className="space-y-3 pt-4 border-t border-slate-50 dark:border-slate-700">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-slate-400 font-medium">Monthly Price</span>
                                            <span className="font-black text-slate-900 dark:text-white">{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(item.price) || 0)}</span>
                                        </div>
                                        <div className="flex justify-between text-sm">
                                            <span className="text-slate-400 font-medium">Last Order</span>
                                            <span className="font-bold text-slate-600 dark:text-slate-300">{format(new Date(item.orderDate), 'MMM d, yyyy')}</span>
                                        </div>
                                        <div className="flex justify-between text-sm">
                                            <span className="text-slate-400 font-medium">Frequency</span>
                                            <span className="font-bold text-indigo-600">Monthly</span>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        {(customer.orders || []).flatMap((o: any) => o.orderItems || []).filter((i: any) => i.is_subscription).length === 0 && (
                            <div className="col-span-full py-20 text-center">
                                <div className="w-20 h-20 bg-slate-50 dark:bg-slate-900 rounded-full flex items-center justify-center mx-auto mb-6 text-slate-300">
                                    <Calendar size={40} />
                                </div>
                                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">No active subscriptions</h3>
                                <p className="text-slate-500">This customer hasn't chosen the "Subscribe & Save" option yet.</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {activeTab === 'history' && (
                <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <ActivityFeed customerId={customer.id} />
                </div>
            )}

            {activeTab === 'fundraisers' && (
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
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Customer Type</label>
                                    <select
                                        value={editForm.type}
                                        onChange={e => setEditForm({ ...editForm, type: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white appearance-none"
                                    >
                                        <option value="Individual">Individual (Direct)</option>
                                        <option value="Organization">Organization (B2B)</option>
                                        <option value="Fundraiser">Fundraiser Group</option>
                                    </select>
                                </div>
                            </div>

                            {editForm.type !== 'Individual' && (
                                <div>
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">{editForm.type} Name</label>
                                    <input
                                        value={editForm.name}
                                        onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                        placeholder={`e.g. ${editForm.type === 'Fundraiser' ? 'Spring 2026 PTA' : 'Acme Corp'}`}
                                    />
                                </div>
                            )}

                            <div>
                                <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">
                                    {editForm.type === 'Individual' ? 'Customer Name' : 'Primary Contact Person'}
                                </label>
                                <input
                                    value={editForm.type === 'Individual' ? editForm.name : editForm.contact_name}
                                    onChange={e => {
                                        if (editForm.type === 'Individual') {
                                            setEditForm({ ...editForm, name: e.target.value, contact_name: e.target.value });
                                        } else {
                                            setEditForm({ ...editForm, contact_name: e.target.value });
                                        }
                                    }}
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
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Primary Phone</label>
                                    <input
                                        value={editForm.phone}
                                        onChange={e => setEditForm({ ...editForm, phone: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-bold text-slate-900 dark:text-white"
                                    />
                                </div>
                                <div className="col-span-2">
                                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Secondary Phone</label>
                                    <input
                                        value={editForm.secondary_phone}
                                        onChange={e => setEditForm({ ...editForm, secondary_phone: e.target.value })}
                                        placeholder="(Optional) Second Phone Number"
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

            <AddOrderModal
                isOpen={isAddingOrder}
                onClose={() => setIsAddingOrder(false)}
                bundles={bundles}
                initialCustomerName={customer.name}
                initialCustomerId={customer.id}
            />
        </div>
    );
}
