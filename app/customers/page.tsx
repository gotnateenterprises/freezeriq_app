"use client";

import { useState, useEffect, Suspense } from 'react';
import { RefreshCw, Search, User, Building2, ShoppingBag, DollarSign, Trash, X, Plus, Archive, CheckCircle, Mail, Package } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { STATUS_LABELS, STATUS_COLORS, type CustomerStatus } from '@/lib/statusConstants';
import UpgradeRequired from '@/components/UpgradeRequired';
import EmailComposeModal from '@/components/crm/EmailComposeModal';
import AddOrderModal from '@/components/AddOrderModal';


interface Customer {
    id: string;
    name: string;
    contact_name?: string;
    type: 'Individual' | 'Organization' | 'Fundraiser';
    total_spend: string;
    last_order: string;
    order_count: number;
    email?: string;
    source?: 'Square' | 'QBO' | 'Manual';
    status: CustomerStatus;
    archived: boolean;
    inactive_reason?: string;
    orders?: any[];
    tags?: string[];
}

export default function CustomersPage() {
    return (
        <Suspense fallback={<div className="p-8 text-center text-slate-400">Loading CRM...</div>}>
            <CustomersContent />
        </Suspense>
    );
}

function CustomersContent() {
    const { data: session, status } = useSession();
    const searchParams = useSearchParams();
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);

    // Plan Gating
    const userPlan = (session?.user as any)?.plan;
    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;
    const hasAccess = userPlan === 'ENTERPRISE' || userPlan === 'ULTIMATE' || userPlan === 'FREE' || isSuperAdmin;

    const [searchTerm, setSearchTerm] = useState('');
    const [activeType, setActiveType] = useState<'All' | 'Individual' | 'Completed' | 'Archived' | 'Waitlist'>('All');
    const [activeStatus, setActiveStatus] = useState<'All' | 'LEAD' | 'ACTIVE' | 'PRODUCTION' | 'IN_PROGRESS_VIEW'>('All');

    // New Customer Modal State
    const [isAddingCustomer, setIsAddingCustomer] = useState(false);
    const [formLoading, setFormLoading] = useState(false);
    const [newCustomer, setNewCustomer] = useState({
        name: '',
        contact_name: '',
        email: '',
        phone: '',
        address: '',
        notes: '',
        type: 'Individual'
    });

    // Email Modal State
    const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
    const [emailDraft, setEmailDraft] = useState({ subject: '', html: '' });
    const [blastRecipients, setBlastRecipients] = useState<string[]>([]);
    const [blastCount, setBlastCount] = useState(0);

    const [weeklyRevenue, setWeeklyRevenue] = useState(0);
    const [inProgressOrders, setInProgressOrders] = useState(0);
    const [bundles, setBundles] = useState<any[]>([]);

    // New Order State
    const [isAddingOrder, setIsAddingOrder] = useState(false);
    const [selectedCustomerForOrder, setSelectedCustomerForOrder] = useState<{ id: string, name: string } | null>(null);

    // Deep link handler
    useEffect(() => {
        const action = searchParams.get('action');
        const typeArg = searchParams.get('type');

        if (action === 'new') {
            setIsAddingCustomer(true);
            if (typeArg) {
                // Map query param to valid type
                let mappedType = 'Individual';
                if (typeArg.toUpperCase() === 'ORGANIZATION') mappedType = 'Organization';
                else if (typeArg.toUpperCase() === 'FUNDRAISER') mappedType = 'Fundraiser';

                setNewCustomer(prev => ({ ...prev, type: mappedType as any }));
                if (mappedType !== 'Individual') {
                    setActiveType(mappedType as any);
                }
            }
        }
    }, [searchParams]);

    const fetchCustomers = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/customers', { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                const customersList = data.customers || data;
                setWeeklyRevenue(data.weeklyRevenue || 0);
                setInProgressOrders(data.inProgressCount || 0);

                const enhancedData = customersList.map((c: any) => ({
                    ...c,
                    source: c.source || 'Square',
                    status: (c.status as CustomerStatus) || 'LEAD',
                    archived: c.archived || false,
                    email: c.email || '',
                    tags: c.tags || []
                }));
                setCustomers(enhancedData);
            }
        } catch (e) {
            console.error("Failed to fetch customers", e);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (hasAccess && status === 'authenticated') {
            fetchCustomers();
        }
    }, [hasAccess, session, status]);

    if (status === 'loading') return <div className="p-8 text-center text-slate-400">Loading Session...</div>;

    if (!hasAccess) {
        return (
            <UpgradeRequired
                feature="Customer CRM"
                description="Manage your customer relationships, track purchase habits, and grow your retail business."
            />
        );
    }

    const handleCreateCustomer = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormLoading(true);
        try {
            const res = await fetch('/api/customers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newCustomer.name,
                    contact_name: newCustomer.contact_name,
                    contact_email: newCustomer.email,
                    contact_phone: newCustomer.phone,
                    type: newCustomer.type,
                    delivery_address: newCustomer.address,
                    notes: newCustomer.notes
                })
            });

            if (res.ok) {
                setIsAddingCustomer(false);
                setNewCustomer({ name: '', contact_name: '', email: '', phone: '', address: '', notes: '', type: 'Individual' });
                fetchCustomers();
            } else {
                const err = await res.json();
                alert(err.error || "Failed to create customer");
            }
        } catch (e) {
            alert("Create failed");
        } finally {
            setFormLoading(false);
        }
    };

    const handleSync = async () => {
        setIsSyncing(true);
        try {
            const res = await fetch('/api/sync/orders', { method: 'POST' });
            if (res.ok) {
                fetchCustomers();
            }
        } finally {
            setIsSyncing(false);
        }
    };

    const handleDelete = async (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        if (!confirm("Are you sure you want to delete this customer?")) return;
        try {
            const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setCustomers(prev => prev.filter(c => c.id !== id));
            }
        } catch (e) {
            alert("Delete failed");
        }
    };

    useEffect(() => {
        fetchCustomers();
        // Fetch bundles for the order modal
        fetch('/api/bundles')
            .then(res => res.json())
            .then(data => setBundles(data))
            .catch(err => console.error("Failed to fetch bundles:", err));
    }, []);

    // Filter Logic
    const hasInProgressOrders = (customer: Customer) => {
        const statuses = ['pending', 'production_ready', 'delivery', 'delivered'];
        return (customer.orders || []).some((o: any) =>
            statuses.includes((o.status || '').toLowerCase())
        );
    };

    const filtered = customers.filter(c => {
        // Handle Type Filters (Tabs)
        if (activeType === 'Archived') {
            if (!c.archived) return false;
        } else if (activeType === 'Completed') {
            if (c.status !== 'COMPLETE' || c.archived) return false;
        } else if (activeType === 'Waitlist') {
            if (!c.tags?.includes('surplus_waitlist')) return false;
        } else {
            if (c.archived) return false;

            const matchesType = activeType === 'All' ||
                (activeType === 'Individual' && c.type === 'Individual');
            if (!matchesType) return false;
        }

        // Search Match
        const matchesSearch =
            c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            (c.contact_name && c.contact_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
            (c.email && c.email.toLowerCase().includes(searchTerm.toLowerCase()));

        if (!matchesSearch) return false;

        // Status Match
        let matchesStatus = activeStatus === 'All' || c.status === activeStatus;

        // Special case for "In Progress" filter triggered by metric card
        if (activeStatus === 'IN_PROGRESS_VIEW') {
            matchesStatus = c.status === 'ACTIVE';
        }

        return matchesStatus;
    });

    // Metrics Calculation
    const metrics = {
        weeklyRevenue: weeklyRevenue,
        inProgressOrders: inProgressOrders,
        individuals: customers.filter(c => !c.archived && c.type === 'Individual').length,
        leads: customers.filter(c => !c.archived && c.status === 'LEAD').length
    };

    return (
        <div className="p-8 max-w-7xl mx-auto pb-32">
            {/* New Customer Modal */}
            {isAddingCustomer && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
                        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
                            <h3 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">Add New Customer</h3>
                            <button onClick={() => setIsAddingCustomer(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-2">
                                <X size={24} />
                            </button>
                        </div>
                        <form onSubmit={handleCreateCustomer} className="p-8 space-y-5">
                            {/* Organization Name Input (Conditional) */}
                            {newCustomer.type !== 'Individual' && (
                                <div>
                                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                                        Organization Name
                                    </label>
                                    <input
                                        required
                                        className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-indigo-500 transition font-medium text-slate-900 dark:text-white"
                                        placeholder="e.g. St. Mary's School"
                                        value={newCustomer.name}
                                        onChange={e => setNewCustomer({ ...newCustomer, name: e.target.value })}
                                        autoFocus
                                    />
                                </div>
                            )}

                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">
                                    {newCustomer.type === 'Individual' ? 'Full Name' : 'Primary Contact Name'}
                                </label>
                                <input
                                    required
                                    className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-indigo-500 transition font-medium text-slate-900 dark:text-white"
                                    placeholder={newCustomer.type === 'Individual' ? "e.g. John Smith" : "e.g. Jane Doe (Coordinator)"}
                                    value={newCustomer.type === 'Individual' ? newCustomer.name : newCustomer.contact_name}
                                    onChange={e => {
                                        if (newCustomer.type === 'Individual') {
                                            setNewCustomer({ ...newCustomer, name: e.target.value, contact_name: e.target.value });
                                        } else {
                                            setNewCustomer({ ...newCustomer, contact_name: e.target.value });
                                        }
                                    }}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Email</label>
                                    <input
                                        type="email"
                                        className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-indigo-500 transition font-medium text-slate-900 dark:text-white"
                                        placeholder="john@example.com"
                                        value={newCustomer.email}
                                        onChange={e => setNewCustomer({ ...newCustomer, email: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Phone</label>
                                    <input
                                        type="tel"
                                        className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-indigo-500 transition font-medium text-slate-900 dark:text-white"
                                        placeholder="(555) 000-0000"
                                        value={newCustomer.phone}
                                        onChange={e => setNewCustomer({ ...newCustomer, phone: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div className="pt-4 flex gap-3">
                                <button
                                    type="button"
                                    onClick={() => setIsAddingCustomer(false)}
                                    className="flex-1 px-6 py-4 rounded-xl font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={formLoading}
                                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-4 rounded-xl font-bold transition shadow-lg shadow-indigo-200 dark:shadow-none disabled:opacity-50"
                                >
                                    {formLoading ? 'Creating...' : 'Create Customer'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Header Area */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 mb-10">
                <div>
                    <h1 className="text-5xl font-black text-slate-900 dark:text-white tracking-tight">Customer CRM</h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-2 text-lg">Manage relationships and track growth.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleSync}
                        disabled={isSyncing}
                        className="group flex items-center gap-2 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 px-5 py-3 rounded-2xl font-bold transition shadow-sm active:scale-95 disabled:opacity-50"
                    >
                        <RefreshCw size={18} className={isSyncing ? "animate-spin" : "group-hover:rotate-180 transition-transform duration-500"} />
                        Sync Data
                    </button>
                    <button
                        onClick={() => setIsAddingCustomer(true)}
                        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-2xl font-black transition shadow-xl shadow-indigo-200 dark:shadow-none hover:scale-105 active:scale-95"
                    >
                        <Plus size={20} strokeWidth={3} />
                        New Lead
                    </button>
                </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
                <MetricCard
                    label="Weekly Order Total"
                    value={metrics.weeklyRevenue.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
                    icon={<DollarSign size={20} />}
                    color="bg-emerald-500"
                />
                <MetricCard
                    label="In Progress Customers"
                    value={metrics.inProgressOrders}
                    icon={<Package size={20} />}
                    color="bg-purple-500"
                    onClick={() => {
                        setActiveStatus('IN_PROGRESS_VIEW');
                        setActiveType('All');
                    }}
                    active={activeStatus === 'IN_PROGRESS_VIEW'}
                />
                <MetricCard
                    label="Individuals"
                    value={metrics.individuals}
                    icon={<User size={20} />}
                    color="bg-blue-500"
                />
                <MetricCard
                    label="Active Leads"
                    value={metrics.leads}
                    icon={<ShoppingBag size={20} />}
                    color="bg-amber-500"
                />
            </div>

            <div className="flex flex-col gap-6">
                {/* Visual Filter Bar */}
                <div className="flex flex-col lg:flex-row gap-4">
                    <div className="flex-1 glass-panel p-1 rounded-2xl flex gap-1 bg-white dark:bg-slate-800 border border-slate-200/50 shadow-sm overflow-x-auto no-scrollbar">
                        {['Individual', 'Waitlist', 'All', 'Completed', 'Archived'].map(type => (
                            <button
                                key={type}
                                onClick={() => setActiveType(type as any)}
                                className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-black transition-all whitespace-nowrap ${activeType === type ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-none' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700'}`}
                            >
                                {type === 'Individual' ? 'Individuals' : type}
                            </button>
                        ))}
                    </div>

                    <div className="flex-[0.5] relative">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                        <input
                            placeholder="Quick search..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-11 pr-4 py-3 bg-white dark:bg-slate-800 border border-slate-200/50 rounded-2xl text-sm font-bold text-slate-700 dark:text-white shadow-sm outline-none focus:ring-2 focus:ring-indigo-500"
                        />
                    </div>

                    {/* Blast Waitlist Button */}
                    {activeType === 'Waitlist' && (
                        <button
                            onClick={() => {
                                const waitlistEmails = customers
                                    .filter(c => c.tags?.includes('surplus_waitlist') && c.email)
                                    .map(c => c.email!)
                                    .filter(email => email.length > 0); // Ensure valid emails

                                if (waitlistEmails.length === 0) {
                                    alert("No valid emails found in waitlist.");
                                    return;
                                }

                                setBlastRecipients(waitlistEmails);
                                setBlastCount(waitlistEmails.length);
                                setEmailDraft({
                                    subject: "Surplus Meals Dropped! 🍲",
                                    html: `<p>Hi there!</p><p>Great news! We just dropped new surplus meals in the shop.</p><p><a href="https://freezeriq.com/shop">Click here to grab them before they're gone!</a></p><p>Warmly,<br>The Freezer Chef Team</p>`
                                });
                                setIsEmailModalOpen(true);
                            }}
                            className="flex items-center gap-2 px-4 py-2 bg-rose-500 hover:bg-rose-600 active:bg-rose-700 text-white font-bold rounded-xl shadow-md transform transition-all hover:-translate-y-0.5"
                        >
                            <Mail size={18} />
                            Email Waitlist
                        </button>
                    )}
                </div>

                {/* Sub-Filters (Status) */}
                {activeType !== 'Archived' && activeType !== 'Completed' && (
                    <div className="flex gap-2 pb-2 overflow-x-auto no-scrollbar">
                        <StatusFilter active={activeStatus === 'All'} onClick={() => setActiveStatus('All')} label="All Statuses" />
                        <StatusFilter active={activeStatus === 'LEAD'} onClick={() => setActiveStatus('LEAD')} label="New Leads" color="bg-amber-100 text-amber-700 border-amber-200" />
                        <StatusFilter active={activeStatus === 'ACTIVE'} onClick={() => setActiveStatus('ACTIVE')} label="Active Customers" color="bg-emerald-100 text-emerald-700 border-emerald-200" />
                        <StatusFilter active={activeStatus === 'PRODUCTION'} onClick={() => setActiveStatus('PRODUCTION')} label="In Production" color="bg-indigo-100 text-indigo-700 border-indigo-200" />
                    </div>
                )}

                {/* Main Table */}
                <div className="bg-white dark:bg-slate-800 rounded-[2rem] overflow-hidden border border-slate-200 dark:border-slate-700 shadow-xl transition-all">
                    {isLoading ? (
                        <div className="p-32 text-center">
                            <RefreshCw className="animate-spin text-indigo-500 mx-auto mb-4" size={40} />
                            <p className="text-slate-400 font-bold tracking-tight">Accessing Customer Records...</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left">
                                <thead>
                                    <tr className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-700">
                                        <th className="py-5 px-8 text-[10px] font-black uppercase tracking-widest text-slate-400">Identity</th>
                                        <th className="py-5 px-8 text-[10px] font-black uppercase tracking-widest text-slate-400">Relationship</th>
                                        <th className="py-5 px-8 text-[10px] font-black uppercase tracking-widest text-slate-400">Metrics</th>
                                        <th className="py-5 px-8 text-[10px] font-black uppercase tracking-widest text-slate-400 text-right">Activity</th>
                                        <th className="py-5 px-8 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                                    {filtered.map((c, i) => (
                                        <tr
                                            key={c.id}
                                            className="group cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-all"
                                            onClick={() => window.location.href = `/customers/${c.id}`}
                                        >
                                            <td className="py-6 px-8">
                                                <div className="flex items-center gap-4">
                                                    <div className={`w-12 h-12 rounded-[1rem] flex items-center justify-center text-white font-black text-lg transition-transform group-hover:scale-110 shadow-lg ${(c.type === 'Fundraiser' || c.type === 'Organization') ? 'bg-gradient-to-br from-indigo-500 to-purple-600' : 'bg-gradient-to-br from-blue-400 to-indigo-500'
                                                        }`}>
                                                        {c.name.charAt(0)}
                                                    </div>
                                                    <div>
                                                        <div className="font-extrabold text-slate-900 dark:text-white text-lg group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{c.name}</div>
                                                        <div className="text-xs text-slate-400 font-bold uppercase tracking-wider">{c.source}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="py-6 px-8">
                                                <div className="flex flex-col gap-1.5">
                                                    {(() => {
                                                        const colors = STATUS_COLORS[c.status] || STATUS_COLORS.LEAD;
                                                        return (
                                                            <span className={`inline-flex items-center w-fit px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${colors.bg} ${colors.text} border ${colors.border}`}>
                                                                {STATUS_LABELS[c.status]}
                                                            </span>
                                                        );
                                                    })()}
                                                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                                                        <Mail size={12} />
                                                        <span className="text-xs font-bold truncate max-w-[150px]">{c.email || 'No contact info'}</span>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="py-6 px-8">
                                                <div className="flex flex-col">
                                                    <div className="text-lg font-black text-slate-900 dark:text-white leading-none">{c.total_spend}</div>
                                                    <div className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-1">{c.order_count} Orders Total</div>
                                                </div>
                                            </td>
                                            <td className="py-6 px-8 text-right">
                                                <div className="flex flex-col items-end">
                                                    <div className="text-sm font-black text-slate-600 dark:text-slate-300">{new Date(c.last_order).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                                                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Last Order</div>
                                                </div>
                                            </td>
                                            <td className="py-6 px-8">
                                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-all">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setSelectedCustomerForOrder({ id: c.id, name: c.name });
                                                            setIsAddingOrder(true);
                                                        }}
                                                        className="p-2 text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-xl transition-all"
                                                        title="New Order"
                                                    >
                                                        <ShoppingBag size={18} />
                                                    </button>
                                                    <button
                                                        onClick={(e) => handleDelete(e, c.id)}
                                                        className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-xl transition-all"
                                                    >
                                                        <Trash size={18} />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {filtered.length === 0 && !isLoading && (
                                <div className="p-20 text-center">
                                    <div className="w-20 h-20 bg-slate-50 dark:bg-slate-900 rounded-full flex items-center justify-center mx-auto mb-6">
                                        <Search className="text-slate-200 dark:text-slate-700" size={40} />
                                    </div>
                                    <h3 className="text-2xl font-black text-slate-900 dark:text-white mb-2">No Records Found</h3>
                                    <p className="text-slate-400 max-w-sm mx-auto font-medium">Try adjusting your filters or search terms to find what you're looking for.</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Email Modal */}
            <EmailComposeModal
                isOpen={isEmailModalOpen}
                onClose={() => setIsEmailModalOpen(false)}
                onSend={async (subject, html, attachments) => {
                    if (blastRecipients.length === 0) return;

                    try {
                        const res = await fetch('/api/email/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                to: `Waitlist Members <noreply@freezeriq.com>`,
                                bcc: blastRecipients,
                                subject,
                                html,
                                attachments
                            })
                        });

                        if (res.ok) {
                            alert(`Email sent to ${blastCount} people!`);
                            setIsEmailModalOpen(false);
                        } else {
                            const err = await res.json();
                            alert("Failed to send: " + (err.error || "Unknown error"));
                        }
                    } catch (e) {
                        alert("Error sending email");
                    }
                }}
                initialSubject={emailDraft.subject}
                initialHtml={emailDraft.html}
                recipientEmail={blastCount > 0 ? `Waitlist (${blastCount} people)` : ''}
            />

            <AddOrderModal
                isOpen={isAddingOrder}
                onClose={() => setIsAddingOrder(false)}
                bundles={bundles}
                initialCustomerName={selectedCustomerForOrder?.name}
                initialCustomerId={selectedCustomerForOrder?.id}
            />
        </div>
    );
}

function MetricCard({ label, value, icon, color, onClick, active }: { label: string, value: any, icon: any, color: string, onClick?: () => void, active?: boolean }) {
    return (
        <div
            onClick={onClick}
            className={`cursor-pointer bg-white dark:bg-slate-800 p-6 rounded-[2rem] border transition-all group ${active ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-xl scale-[1.02]' : 'border-slate-200/50 dark:border-slate-700 shadow-sm hover:shadow-xl hover:scale-[1.02]'}`}
        >
            <div className="flex justify-between items-start mb-4">
                <div className={`w-10 h-10 ${color} text-white rounded-[0.75rem] flex items-center justify-center shadow-lg transition-transform group-hover:rotate-12`}>
                    {icon}
                </div>
            </div>
            <div className="text-3xl font-black text-slate-900 dark:text-white tracking-tight leading-none mb-1">{value}</div>
            <div className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</div>
        </div>
    );
}

function StatusFilter({ active, onClick, label, color = "bg-white dark:bg-slate-800 text-slate-600 border-slate-200/50 shadow-sm" }: { active: boolean, onClick: () => void, label: string, color?: string }) {
    return (
        <button
            onClick={onClick}
            className={`whitespace-nowrap px-4 py-2 rounded-xl text-xs font-black transition-all border ${active ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg shadow-indigo-100' : `${color} hover:border-indigo-300`}`}
        >
            {label}
        </button>
    );
}
