"use client";

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';

import EmailComposeModal from './EmailComposeModal';
import { ShoppingBag, DollarSign, Mail, Phone, MapPin, User, StickyNote, Plus, Calendar, Eye, Loader2, Archive, RotateCcw, Sparkles, Tag, UtensilsCrossed, Clock } from 'lucide-react';
import StatusPipeline from './StatusPipeline';
import { STATUS_LABELS, STATUS_COLORS, type CustomerStatus } from '@/lib/statusConstants';



const generateSeasonalMenuTemplate = (name: string) => ({
    subject: `Fresh from the Kitchen: Our New Seasonal Menu is Here! 🥘`,
    html: `
<p>Hi ${name || 'there'}!</p>
<p>The seasons are changing, and so is our menu! We've been busy in the kitchen preparing some incredible new dishes that we know your family will love.</p>

<div style="background-color: #f0fdf4; border: 1px solid #dcfce7; border-radius: 12px; padding: 20px; margin: 20px 0;">
    <h3 style="margin-top: 0; color: #166534;">✨ What's New This Season?</h3>
    <ul style="padding-left: 20px;">
        <li><strong>Cozy Comforts:</strong> New family-sized casseroles.</li>
        <li><strong>Fresh & Healthy:</strong> Expanded Keto and Gluten-Free options.</li>
        <li><strong>Chef's Special:</strong> Our limited-time seasonal bundles.</li>
    </ul>
</div>

<p>Skip the meal prep tonight and let us handle the cooking. Our meals are prepared with love, frozen fresh, and ready when you are.</p>

<p><a href="https://freezeriq.com/menu" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Browse the New Menu</a></p>

<p>Warmly,<br>Laurie</p>
`
});

const generateWeMissYouTemplate = (name: string) => ({
    subject: `We miss you! Here's a little something for your next dinner... 🎁`,
    html: `
<p>Hi ${name || 'there'}!</p>
<p>It's been a while since we've seen you at the kitchen! We know life gets busy, and we'd love to help make your weeknights a little easier again.</p>

<p>To welcome you back, please use the code below for <strong>15% OFF</strong> your next order!</p>

<div style="background-color: #eef2ff; border: 2px dashed #4f46e5; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: center;">
    <p style="margin: 0; font-size: 12px; text-transform: uppercase; font-weight: bold; color: #4f46e5;">Your Welcome Back Code</p>
    <h2 style="margin: 10px 0; color: #1e1b4b; letter-spacing: 2px;">WEMISSYOU15</h2>
</div>

<p>Whether it's your old favorites or something new from our seasonal menu, we're ready to stock your freezer with stress-free dinners.</p>

<p>Happy Eating!</p>

<p>Warmly,<br>Laurie</p>
`
});

interface CustomerOverviewProps {
    customer: any;
    onUpdateCustomer: (updates: any) => Promise<void>;
    onEditProfile: () => void;
}

export default function CustomerOverview({ customer, onUpdateCustomer, onEditProfile }: CustomerOverviewProps) {
    // State
    const [notes, setNotes] = useState(customer.notes || '');
    const [typingTimeout, setTypingTimeout] = useState<NodeJS.Timeout | null>(null);

    // Branding
    const [branding, setBranding] = useState<any>(null);
    // Normalize API status (Title Case) to Enum (UPPER_CASE)
    const normalizedStatus = (customer.status || 'LEAD').toUpperCase().replace(/\s+/g, '_') as CustomerStatus;
    const [status, setStatus] = useState<CustomerStatus>(normalizedStatus);
    const [isArchived, setIsArchived] = useState(customer.archived || false);


    const [isEmailModalOpen, setIsEmailModalOpen] = useState(false);
    const [emailDraft, setEmailDraft] = useState({ subject: '', html: '' });
    const [emailAttachments, setEmailAttachments] = useState<{ filename: string; content: string }[]>([]);
    const [activeEmailContext, setActiveEmailContext] = useState<'custom' | 'seasonal' | 'promotion' | null>(null);

    // Calculate Top Bundle Habit
    const topBundleHabit = (() => {
        const orders = customer.orders || [];
        if (orders.length === 0) return null;

        const bundleCounts: Record<string, number> = {};
        orders.forEach((order: any) => {
            if (!order.items) return;
            // Parse "1x Bundle Name, 2x Other Bundle"
            const parts = order.items.split(',').map((p: string) => p.trim());
            parts.forEach((part: string) => {
                const match = part.match(/^(\d+)x\s+(.+)$/);
                if (match) {
                    const qty = parseInt(match[1], 10);
                    const name = match[2];
                    bundleCounts[name] = (bundleCounts[name] || 0) + qty;
                }
            });
        });

        const sorted = Object.entries(bundleCounts).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) return null;
        return { name: sorted[0][0], count: sorted[0][1] };
    })();

    // Calculate In Progress Orders
    const inProgressStats = (() => {
        const orders = customer.orders || [];
        const filtered = orders.filter((o: any) =>
            ['pending', 'production_ready', 'delivery'].includes((o.status || '').toLowerCase())
        );
        const totalAmount = filtered.reduce((sum: number, o: any) => {
            const amount = parseFloat((o.total || '0').replace(/[^0-9.-]+/g, ""));
            return sum + (isNaN(amount) ? 0 : amount);
        }, 0);
        return {
            count: filtered.length,
            amount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(totalAmount)
        };
    })();

    // Calculate Weekly Order Total (Rolling 7 Days)
    const weeklyOrderTotal = (() => {
        const orders = customer.orders || [];
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const total = orders.reduce((sum: number, o: any) => {
            const orderDate = new Date(o.created_at || o.date);
            if (orderDate >= sevenDaysAgo) {
                const amount = parseFloat((o.total || '0').replace(/[^0-9.-]+/g, ""));
                return sum + (isNaN(amount) ? 0 : amount);
            }
            return sum;
        }, 0);
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(total);
    })();

    // Effects
    useEffect(() => {
        if (notes !== (customer.notes || '')) {
            if (typingTimeout) clearTimeout(typingTimeout);
            const timeout = setTimeout(() => {
                onUpdateCustomer({ notes });
            }, 1000);
            setTypingTimeout(timeout);
        }
    }, [notes]);

    useEffect(() => {
        fetch('/api/tenant/branding').then(res => res.json()).then(data => {
            setBranding(data);
        }).catch(err => console.error('Error fetching branding:', err));
    }, []);

    // Sync state with props (e.g., after global Save Changes)
    useEffect(() => {
        const normalized = (customer.status || 'LEAD').toUpperCase().replace(/\s+/g, '_') as CustomerStatus;
        setStatus(normalized);
        setIsArchived(customer.archived || false);
    }, [customer.status, customer.archived]);

    // Handlers
    const openEmailComposer = (type: 'custom' | 'seasonal' | 'promotion', attachments: any[] = []) => {
        if (!customer.email) {
            alert("Please add an email address to the contact details first.");
            return;
        }

        const firstName = customer.contact_name ? customer.contact_name.split(' ')[0] : '';

        let template;
        if (type === 'seasonal') {
            template = generateSeasonalMenuTemplate(firstName);
        } else if (type === 'promotion') {
            template = generateWeMissYouTemplate(firstName);
        } else {
            template = { subject: '', html: '' };
        }

        setActiveEmailContext(type);
        setEmailDraft({ subject: template.subject, html: template.html });
        setEmailAttachments(attachments);
        setIsEmailModalOpen(true);
    };

    const handleSendEmail = async (subject: string, html: string, attachments: any[] = []) => {
        try {
            const res = await fetch('/api/email/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: customer.email,
                    subject,
                    html,
                    attachments,
                    customerId: customer.id,
                    context: activeEmailContext
                })
            });
            const data = await res.json();
            if (res.ok) {
                alert(data.mocked ? "Email Simulated (No API Key)" : "Email Sent Successfully!");
                setIsEmailModalOpen(false);

                // Update local status based on email context
            } else {
                alert("Failed to send: " + data.error);
            }
        } catch (e) {
            alert("Error sending email");
            throw e;
        }
    };

    const handleManualStatusChange = async (newStatus: CustomerStatus) => {
        if (!confirm(`Are you sure you want to manually change status to ${STATUS_LABELS[newStatus]}?`)) return;

        let statusToSet = newStatus;

        if (newStatus === 'COMPLETE') {
            const choice = confirm("Mark as ACTIVE (OK) or INACTIVE (Cancel)?");
            if (!choice) {
                statusToSet = 'INACTIVE' as CustomerStatus;
            }
        }

        await onUpdateCustomer({ status: statusToSet });
    };

    const handleArchiveToggle = async () => {
        const action = isArchived ? 'unarchive' : 'archive';
        if (!confirm(`Are you sure you want to ${action} this customer?`)) return;

        await onUpdateCustomer({ archived: !isArchived });
    };

    const handleAddTag = async () => {
        const newTag = prompt("Enter new dietary tag (e.g., Dairy Free):");
        if (!newTag) return;

        const currentTags = customer.tags || [];
        if (currentTags.includes(newTag)) {
            alert("Tag already exists");
            return;
        }

        const updatedTags = [...currentTags, newTag];
        await onUpdateCustomer({ tags: updatedTags });
    };

    const handleDeleteTag = async (tagToDelete: string) => {
        if (!confirm(`Remove "${tagToDelete}" tag?`)) return;

        const currentTags = customer.tags || [];
        const updatedTags = currentTags.filter((t: string) => t !== tagToDelete);
        await onUpdateCustomer({ tags: updatedTags });
    };

    const statusColors = STATUS_COLORS[status] || STATUS_COLORS.LEAD;

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            {/* Header Area with Status Pipeline */}
            <div className="bg-white dark:bg-slate-800 rounded-3xl p-8 border border-slate-200 dark:border-slate-700 shadow-sm">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight">{customer.name}</h1>
                            {isArchived ? (
                                <span className="bg-slate-100 dark:bg-slate-700 text-slate-500 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider">
                                    Archived
                                </span>
                            ) : (
                                <span className={`${statusColors.bg} ${statusColors.text} px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider border ${statusColors.border}`}>
                                    {STATUS_LABELS[status]}
                                </span>
                            )}
                            {customer.type === 'Fundraiser' || customer.type === 'Organization' ? (
                                <span className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider">
                                    Fundraiser
                                </span>
                            ) : (
                                <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider">
                                    Individual
                                </span>
                            )}
                        </div>
                        <p className="text-slate-500 dark:text-slate-400 font-medium flex items-center gap-2">
                            {customer.contact_name}
                        </p>
                    </div>

                    <div className="flex gap-3">
                        <button
                            onClick={handleArchiveToggle}
                            className="bg-white dark:bg-slate-700 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border border-slate-200 dark:border-slate-600 px-4 py-2 rounded-xl font-bold flex items-center gap-2 transition-colors"
                        >
                            {isArchived ? <RotateCcw size={18} /> : <Archive size={18} />}
                            {isArchived ? 'Reactivate' : 'Archive'}
                        </button>
                    </div>
                </div>

                {/* Visual Status Pipeline */}
                <div className="border-t border-slate-100 dark:border-slate-700/50 pt-6">
                    <StatusPipeline
                        currentStatus={status}
                        onStatusClick={handleManualStatusChange}
                        allowManualChange={true}
                        stages={['LEAD', 'COMPLETE', 'INACTIVE']}
                    />
                </div>
            </div>

            <EmailComposeModal
                isOpen={isEmailModalOpen}
                onClose={() => setIsEmailModalOpen(false)}
                onSend={handleSendEmail}
                initialSubject={emailDraft.subject}
                initialHtml={emailDraft.html}
                recipientEmail={customer.email}
                initialAttachments={emailAttachments}
            />

            {/* RETAIL ACTIONS: Promotions & Loyalty */}
            {customer.type === 'Individual' && (
                <div className="glass-panel p-8 rounded-3xl bg-white dark:bg-slate-800 dark:border-slate-700 shadow-sm">
                    <div className="flex justify-between items-center mb-6">
                        <div>
                            <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                <Sparkles className="text-indigo-500" size={20} /> Retail Toolkit
                            </h3>
                            <p className="text-sm font-medium text-slate-500 mt-1">
                                Personalized promotions and seasonal re-engagement.
                            </p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        <div className="bg-emerald-50 dark:bg-emerald-900/20 p-6 rounded-2xl border border-emerald-100 dark:border-emerald-800 flex items-center justify-between group hover:border-emerald-300 transition-all">
                            <div>
                                <h4 className="font-bold text-emerald-900 dark:text-emerald-100 mb-1 flex items-center gap-2">
                                    <Mail size={16} /> Seasonal Menu
                                </h4>
                                <p className="text-[10px] text-emerald-600 dark:text-emerald-300 font-bold uppercase tracking-widest">Email Campaign</p>
                            </div>
                            <button
                                onClick={() => openEmailComposer('seasonal')}
                                className="p-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl shadow-sm transition-transform group-hover:scale-110"
                            >
                                <Mail size={18} />
                            </button>
                        </div>

                        <div className="bg-indigo-50 dark:bg-indigo-900/20 p-6 rounded-2xl border border-indigo-100 dark:border-indigo-800 flex items-center justify-between group hover:border-indigo-300 transition-all">
                            <div>
                                <h4 className="font-bold text-indigo-900 dark:text-indigo-100 mb-1 flex items-center gap-2">
                                    <Tag size={16} /> "We Miss You"
                                </h4>
                                <p className="text-[10px] text-indigo-600 dark:text-indigo-300 font-bold uppercase tracking-widest">Discount Promo</p>
                            </div>
                            <button
                                onClick={() => openEmailComposer('promotion')}
                                className="p-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-sm transition-transform group-hover:scale-110"
                            >
                                <Tag size={18} />
                            </button>
                        </div>

                        <div className="bg-slate-50 dark:bg-slate-900/20 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 border-dashed flex flex-col items-center justify-center gap-3 group hover:border-indigo-300 hover:bg-indigo-50/30 transition-all cursor-pointer">
                            <div className="w-12 h-12 rounded-full bg-white dark:bg-slate-800 flex items-center justify-center text-slate-400 group-hover:text-indigo-600 transition-colors shadow-sm">
                                <Plus size={24} />
                            </div>
                            <div className="text-center">
                                <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm">New Campaign</h4>
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Email or SMS</p>
                            </div>
                        </div>
                    </div>

                    {/* Dietary & Habits (Prominent) */}
                    <div className="bg-indigo-50/50 dark:bg-indigo-900/10 p-8 rounded-2xl border border-indigo-100 dark:border-indigo-900/30">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-black text-indigo-900 dark:text-indigo-100 flex items-center gap-2 text-lg">
                                <UtensilsCrossed size={18} /> Dietary Preferences & Habits
                            </h3>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="flex flex-wrap gap-2">
                                {(customer.tags || []).map((tag: string) => (
                                    <div key={tag} className="group/tag relative px-4 py-2 bg-white dark:bg-slate-800 border-2 border-indigo-100 dark:border-indigo-900 rounded-xl text-xs font-black text-indigo-600 shadow-sm flex items-center gap-2">
                                        {tag}
                                        <button
                                            onClick={() => handleDeleteTag(tag)}
                                            className="opacity-0 group-hover/tag:opacity-100 text-slate-400 hover:text-red-500 transition-all p-0.5"
                                        >
                                            <Plus size={14} className="rotate-45" />
                                        </button>
                                    </div>
                                ))}
                                <button
                                    onClick={handleAddTag}
                                    className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-black hover:bg-indigo-700 transition-all flex items-center gap-2"
                                >
                                    <Plus size={14} /> Add Tag
                                </button>
                            </div>
                            <div className="bg-white/50 dark:bg-slate-800/50 p-4 rounded-2xl border border-indigo-50 dark:border-indigo-900/30">
                                <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-1 leading-none">Top Bundle Habit</p>
                                <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                    {topBundleHabit ? `${topBundleHabit.name} (${topBundleHabit.count}x Items)` : 'No orders yet'}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Left Column: Stats & Info */}
                <div className="space-y-6">
                    {/* Subscription & Meal Credits Admin */}
                    {customer.type === 'Individual' && (
                        <div className="glass-panel p-6 rounded-3xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg text-white">
                            <h3 className="font-black flex items-center gap-2 mb-4">
                                <UtensilsCrossed size={18} />
                                Subscription & Credits
                            </h3>

                            <div className="space-y-4">
                                <div>
                                    <p className="text-xs text-indigo-100 font-bold uppercase tracking-wider mb-1">Active Plan</p>
                                    <p className="text-xl font-black">{customer.subscription_status === 'active' ? customer.subscription_plan_id || 'Monthly Subscriber' : 'No Active Plan'}</p>
                                </div>

                                <div className="p-4 bg-white/10 rounded-2xl border border-white/20">
                                    <p className="text-xs text-indigo-100 font-bold uppercase tracking-wider mb-2">Build-A-Box Credits</p>
                                    <div className="flex items-center justify-between">
                                        <div className="text-3xl font-black text-white">{customer.meal_credits || 0}</div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => onUpdateCustomer({ meal_credits: Math.max(0, (customer.meal_credits || 0) - 1) })}
                                                className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors"
                                            >
                                                -
                                            </button>
                                            <button
                                                onClick={() => onUpdateCustomer({ meal_credits: (customer.meal_credits || 0) + 1 })}
                                                className="w-8 h-8 rounded-full bg-white text-indigo-600 hover:bg-indigo-50 flex items-center justify-center font-bold transition-colors"
                                            >
                                                <Plus size={16} />
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-[10px] text-indigo-200 mt-2 italic">*Admin testing only. Overrides live balances.*</p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Quick Stats */}
                    <div className="glass-panel p-6 rounded-3xl bg-white dark:bg-slate-800 dark:border-slate-700 shadow-sm transition-all border border-slate-200">
                        <div className="flex flex-col gap-4">
                            <div className="p-5 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                                <p className="text-xs text-slate-400 font-bold uppercase mb-2 tracking-wider">Total Orders</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 dark:text-white">
                                    <ShoppingBag size={24} className="text-indigo-500" />
                                    <span>{customer.orders?.length || 0}</span>
                                </div>
                            </div>
                            <div className="p-5 bg-slate-50 dark:bg-slate-900/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                                <p className="text-xs text-slate-400 font-bold uppercase mb-2 tracking-wider">Weekly Order Total</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 dark:text-white">
                                    <DollarSign size={24} className="text-emerald-500" />
                                    <span>{weeklyOrderTotal}</span>
                                </div>
                            </div>

                            <div className="p-5 bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl border border-indigo-100 dark:border-indigo-800">
                                <p className="text-xs text-indigo-400 dark:text-indigo-400 font-bold uppercase mb-2 tracking-wider">Orders In Progress</p>
                                <div className="flex items-center gap-3 text-3xl font-black text-slate-900 dark:text-white">
                                    <Clock size={24} className="text-indigo-500" />
                                    <span>{inProgressStats.count}</span>
                                    <span className="text-sm font-bold text-slate-500 dark:text-slate-400 ml-auto">{inProgressStats.amount}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Contact Profile */}
                <div
                    onClick={onEditProfile}
                    className="glass-panel p-6 rounded-3xl space-y-5 bg-white dark:bg-slate-800 dark:border-slate-700 cursor-pointer shadow-sm hover:border-indigo-300 transition-all group relative border border-slate-200"
                >
                    <div className="flex items-center justify-between border-b dark:border-slate-700 pb-3">
                        <h3 className="font-black text-slate-900 dark:text-white uppercase tracking-tight">Contact Profile</h3>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <Plus size={16} className="text-indigo-500" />
                        </div>
                    </div>

                    <div className="space-y-4">
                        {customer.contact_name && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0"><User size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Primary Contact</p>
                                    <span className="text-sm font-bold text-slate-900 dark:text-white">{customer.contact_name}</span>
                                </div>
                            </div>
                        )}

                        {customer.email && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0"><Mail size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Email</p>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); openEmailComposer('custom'); }}
                                        className="text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 transition-colors"
                                    >
                                        {customer.email}
                                    </button>
                                </div>
                            </div>
                        )}

                        {customer.phone && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0"><Phone size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Phone</p>
                                    <span className="text-sm font-bold text-slate-900 dark:text-white">{customer.phone}</span>
                                </div>
                            </div>
                        )}

                        {customer.delivery_address && (
                            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-400">
                                <div className="w-10 h-10 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0"><MapPin size={20} /></div>
                                <div>
                                    <p className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500 tracking-wider mb-0.5">Delivery Address</p>
                                    <span className="text-sm font-medium leading-relaxed text-slate-900 dark:text-slate-100">{customer.delivery_address}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Kitchen Notes */}
                <div className="relative overflow-hidden bg-yellow-50/80 dark:bg-yellow-900/10 backdrop-blur-xl p-6 rounded-3xl border border-yellow-200/50 dark:border-yellow-900/30 shadow-soft">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-yellow-300 to-orange-300 dark:from-yellow-700 dark:to-orange-700"></div>
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="font-black text-yellow-900 dark:text-yellow-100 flex items-center gap-2 text-lg">
                            <StickyNote size={20} className="fill-yellow-400 text-yellow-600 dark:text-yellow-500" /> Customer Notes
                        </h3>
                    </div>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        className="w-full h-40 bg-yellow-100/30 dark:bg-yellow-900/20 border border-yellow-200/50 dark:border-yellow-700/30 rounded-2xl p-4 text-sm text-yellow-900 dark:text-yellow-50 focus:outline-none focus:bg-white/50 dark:focus:bg-yellow-900/40 focus:ring-2 focus:ring-yellow-400/50 transition-all font-medium leading-relaxed"
                        placeholder="Add preferences, allergies, or delivery notes here..."
                    />
                </div>
            </div>
        </div>
    );
}
