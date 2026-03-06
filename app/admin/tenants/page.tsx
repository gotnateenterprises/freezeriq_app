"use client";

import { useEffect, useState } from 'react';
import { ShieldCheck, Users, Package, BookOpen, Send, CheckCircle2, AlertCircle, Loader2, Eye, EyeOff, Info, Folder, ChevronRight, ChevronDown } from 'lucide-react';

interface Business {
    id: string;
    name: string;
    slug: string;
    plan: string;
    subscription_status: string;
    created_at: string;
    stripe_customer_id?: string;
    current_period_end?: string;
    _count: {
        users: number;
        recipes: number;
        ingredients: number;
    }
}

interface Category {
    id: string;
    name: string;
    children: Category[];
    _count: { recipes: number };
}

export default function AdminTenantsPage() {
    const [businesses, setBusinesses] = useState<Business[]>([]);
    const [loading, setLoading] = useState(true);
    const [deployingId, setDeployingId] = useState<string | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [formData, setFormData] = useState({
        name: '', slug: '', plan: 'PRO', adminName: '', adminEmail: '', adminPassword: ''
    });
    const [showPassword, setShowPassword] = useState(false);

    // New State for Details & Deployment
    const [selectedBusiness, setSelectedBusiness] = useState<Business | null>(null);
    const [showDeployModal, setShowDeployModal] = useState(false);
    const [categories, setCategories] = useState<Category[]>([]);
    const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
    const [deployTargetId, setDeployTargetId] = useState<string | null>(null);

    const fetchBusinesses = async () => {
        try {
            const res = await fetch('/api/admin/tenants');
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Error ${res.status}: ${res.statusText}`);
            }
            const data = await res.json();
            if (Array.isArray(data)) {
                setBusinesses(data);
            } else {
                setBusinesses([]);
                console.error('Data format error:', data);
            }
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message });
        } finally {
            setLoading(false);
        }
    };

    const fetchCategories = async () => {
        try {
            const res = await fetch('/api/admin/categories');
            if (res.ok) {
                const data = await res.json();
                setCategories(data);
            }
        } catch (e) {
            console.error("Failed to fetch categories", e);
        }
    };

    useEffect(() => {
        fetchBusinesses();
        fetchCategories();
    }, []);

    const openDeployModal = (businessId: string) => {
        setDeployTargetId(businessId);
        setSelectedCategories(new Set()); // Reset selection
        setShowDeployModal(true);
    };

    const handleDeploy = async () => {
        if (!deployTargetId) return;

        // Confirmation
        const isPartial = selectedCategories.size > 0;
        const confirmMsg = isPartial
            ? `Connect specific folders? This will clone recipes from ${selectedCategories.size} selected folders.`
            : 'Push EVERYTHING? This will clone the entire Master Library (All Recipes, Ingredients, Suppliers).';

        if (!confirm(confirmMsg)) return;

        setDeployingId(deployTargetId);
        setShowDeployModal(false); // Close modal
        setMessage(null);

        try {
            const payload: any = { targetBusinessId: deployTargetId };
            if (isPartial) {
                // Collect all IDs (parents + children if logic requires, but for now we send exactly what is checked)
                // However, UI logic below will auto-check children. So sending just selectedCategories is fine.
                payload.categoryIds = Array.from(selectedCategories);
            }

            const res = await fetch('/api/admin/deploy-templates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (res.ok) {
                setMessage({ type: 'success', text: `Successfully deployed! Cloned ${data.result.recipesCloned} recipes.` });
                await fetchBusinesses();
            } else {
                setMessage({ type: 'error', text: data.error || 'Deployment failed' });
            }
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message });
        } finally {
            setDeployingId(null);
            setDeployTargetId(null);
        }
    };

    // Toggle Category Logic
    const toggleCategory = (cat: Category) => {
        const newSet = new Set(selectedCategories);
        const isSelected = newSet.has(cat.id);

        if (isSelected) {
            newSet.delete(cat.id);
            // Auto-deselect children
            cat.children.forEach(c => newSet.delete(c.id));
        } else {
            newSet.add(cat.id);
            // Auto-select children
            cat.children.forEach(c => newSet.add(c.id));
        }
        setSelectedCategories(newSet);
    };

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        setMessage(null);
        setLoading(true);

        try {
            const res = await fetch('/api/admin/tenants', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            const data = await res.json();
            if (res.ok) {
                setMessage({ type: 'success', text: 'Business created successfully!' });
                setShowCreateModal(false);
                setFormData({ name: '', slug: '', plan: 'PRO', adminName: '', adminEmail: '', adminPassword: '' });
                await fetchBusinesses();
            } else {
                let errorText = data.error || 'Failed to create';
                // Parse Zod details if available
                if (data.details) {
                    const fieldErrors = Object.entries(data.details)
                        .map(([key, val]: any) => {
                            if (key === '_errors' && val.length > 0) return val.join(', ');
                            if (val && val._errors && val._errors.length > 0) return `${key}: ${val._errors.join(', ')}`;
                            return null;
                        })
                        .filter(Boolean)
                        .join(' | ');
                    if (fieldErrors) errorText += ` (${fieldErrors})`;
                }
                setMessage({ type: 'error', text: errorText });
            }
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message });
        } finally {
            setLoading(false);
        }
    };

    const handleUpdatePlan = async (businessId: string, newPlan: string) => {
        if (!confirm(`Are you sure you want to change the plan to ${newPlan}?`)) return;

        try {
            const res = await fetch(`/api/admin/tenants/${businessId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan: newPlan })
            });
            const data = await res.json();
            if (res.ok) {
                setMessage({ type: 'success', text: 'Plan updated successfully' });
                // Update local state
                setBusinesses(prev => prev.map(b => b.id === businessId ? { ...b, plan: newPlan } : b));
                setSelectedBusiness(prev => prev ? { ...prev, plan: newPlan } : null);
            } else {
                setMessage({ type: 'error', text: data.error || 'Update failed' });
            }
        } catch (e: any) {
            setMessage({ type: 'error', text: e.message });
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-slate-50 dark:bg-slate-950">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
            </div>
        );
    }

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8 relative">
            <header className="flex justify-between items-end">
                <div>
                    <h1 className="text-3xl font-black text-slate-800 dark:text-white flex items-center gap-3">
                        <ShieldCheck className="text-indigo-500" size={32} />
                        Tenant Management
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 mt-2">Manage SaaS subscriptions and deploy data blueprints.</p>
                </div>
                <button
                    onClick={() => setShowCreateModal(true)}
                    className="bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold hover:bg-indigo-700 transition flex items-center gap-2"
                >
                    <Package size={18} />
                    New Business
                </button>
            </header>

            {/* Business Details Modal */}
            {selectedBusiness && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center backdrop-blur-sm p-4" onClick={() => setSelectedBusiness(null)}>
                    <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in-95" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-between items-start mb-6">
                            <div>
                                <h2 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                                    <ShieldCheck className="text-indigo-500" />
                                    {selectedBusiness.name}
                                </h2>
                                <p className="text-slate-400 font-mono text-sm mt-1">{selectedBusiness.id}</p>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400">Current Plan</label>
                                <select
                                    value={selectedBusiness.plan}
                                    onChange={(e) => handleUpdatePlan(selectedBusiness.id, e.target.value)}
                                    className={`px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider border-none focus:ring-2 focus:ring-indigo-500 cursor-pointer ${selectedBusiness.plan === 'PRO' ? 'bg-indigo-100 text-indigo-700' : selectedBusiness.plan === 'ULTIMATE' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`}
                                >
                                    <option value="FREE">Free</option>
                                    <option value="PRO">Pro</option>
                                    <option value="ULTIMATE">Enterprise</option>
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4 mb-6">
                            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
                                <span className="block text-xs uppercase font-bold text-slate-400 mb-1">Status</span>
                                <span className="font-semibold">{selectedBusiness.subscription_status}</span>
                            </div>
                            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
                                <span className="block text-xs uppercase font-bold text-slate-400 mb-1">Slug</span>
                                <span className="font-mono text-sm">{selectedBusiness.slug}</span>
                            </div>
                            <div className="col-span-2 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
                                <span className="block text-xs uppercase font-bold text-slate-400 mb-1">Stripe Customer ID</span>
                                <span className="font-mono text-sm">{selectedBusiness.stripe_customer_id || 'N/A'}</span>
                            </div>
                        </div>

                        <div className="flex justify-end">
                            <button onClick={() => setSelectedBusiness(null)} className="px-5 py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl font-bold transition">
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Deployment Modal */}
            {showDeployModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl p-0 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in-95 overflow-hidden flex flex-col max-h-[85vh]">
                        <div className="p-6 border-b dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
                            <h2 className="text-xl font-bold flex items-center gap-2">
                                <Send className="text-indigo-500" />
                                Push Template Library
                            </h2>
                            <p className="text-slate-500 text-sm mt-1">Select specific folders to deploy, or leave empty to push EVERYTHING.</p>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6">
                            {categories.length === 0 ? (
                                <div className="text-center py-10 text-slate-400">
                                    <Loader2 className="w-8 h-8 mx-auto mb-2 animate-spin" />
                                    Loading folders...
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    {categories.map(cat => (
                                        <div key={cat.id} className="select-none">
                                            <div
                                                className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 ${selectedCategories.has(cat.id) ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}`}
                                                onClick={() => toggleCategory(cat)}
                                            >
                                                <div
                                                    className={`w-5 h-5 rounded border flex items-center justify-center transition ${selectedCategories.has(cat.id) ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600'}`}
                                                >
                                                    {selectedCategories.has(cat.id) && <CheckCircle2 size={12} className="text-white" />}
                                                </div>
                                                <Folder size={18} className={selectedCategories.has(cat.id) ? 'text-indigo-500' : 'text-slate-400'} />
                                                <span className="font-medium flex-1">{cat.name}</span>
                                                <span className="text-xs text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">
                                                    {cat._count.recipes} recipes
                                                </span>
                                            </div>

                                            {/* Children (1 Level Deep) */}
                                            {cat.children && cat.children.length > 0 && (
                                                <div className="ml-9 mt-1 space-y-1 border-l-2 border-slate-100 dark:border-slate-800 pl-2">
                                                    {cat.children.map(child => (
                                                        <div
                                                            key={child.id}
                                                            className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 ${selectedCategories.has(child.id) ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                const newSet = new Set(selectedCategories);
                                                                if (newSet.has(child.id)) newSet.delete(child.id);
                                                                else newSet.add(child.id);
                                                                setSelectedCategories(newSet);
                                                            }}
                                                        >
                                                            <div
                                                                className={`w-4 h-4 rounded border flex items-center justify-center transition ${selectedCategories.has(child.id) ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600'}`}
                                                            >
                                                                {selectedCategories.has(child.id) && <CheckCircle2 size={10} className="text-white" />}
                                                            </div>
                                                            <span className="text-sm text-slate-600 dark:text-slate-300">{child.name}</span>
                                                            <span className="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded-full">
                                                                {child._count.recipes}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="p-6 border-t dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex justify-between items-center">
                            <span className="text-sm font-medium text-slate-500">
                                {selectedCategories.size === 0 ? 'Pushing 100% of Library' : `${selectedCategories.size} folders selected`}
                            </span>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowDeployModal(false)}
                                    className="px-4 py-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 font-bold text-sm text-slate-500"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDeploy}
                                    className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-bold text-sm shadow-lg shadow-indigo-500/20"
                                >
                                    {selectedCategories.size === 0 ? 'Deploy ALL' : 'Deploy Selected'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {showCreateModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-800 animate-in fade-in zoom-in-95">
                        <h2 className="text-xl font-bold mb-4">Onboard New Business</h2>
                        {message && message.type === 'error' && (
                            <div className="mb-4 p-3 bg-red-50 border border-red-100 text-red-600 rounded-lg text-sm flex items-start gap-2 animate-in fade-in slide-in-from-top-1">
                                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                                <span>{message.text}</span>
                            </div>
                        )}
                        <form onSubmit={handleCreate} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Business Name</label>
                                <input
                                    required
                                    className="w-full px-3 py-2 rounded-lg border dark:bg-slate-800 dark:border-slate-700 font-medium"
                                    value={formData.name}
                                    onChange={e => {
                                        const name = e.target.value;
                                        setFormData(prev => ({
                                            ...prev,
                                            name,
                                            slug: name.toLowerCase().replace(/[^a-z0-9]/g, '-')
                                        }));
                                    }}
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Slug (Subdomain)</label>
                                    <input
                                        required
                                        className="w-full px-3 py-2 rounded-lg border dark:bg-slate-800 dark:border-slate-700 font-mono text-sm"
                                        value={formData.slug}
                                        onChange={e => setFormData(prev => ({ ...prev, slug: e.target.value }))}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Plan</label>
                                    <select
                                        className="w-full px-3 py-2 rounded-lg border dark:bg-slate-800 dark:border-slate-700 font-medium"
                                        value={formData.plan}
                                        onChange={e => setFormData(prev => ({ ...prev, plan: e.target.value }))}
                                    >
                                        <option value="FREE">Free</option>
                                        <option value="PRO">Pro</option>
                                        <option value="ULTIMATE">Enterprise</option>
                                    </select>
                                </div>
                            </div>
                            <div className="pt-2 border-t dark:border-slate-800">
                                <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Admin Name</label>
                                <input
                                    required
                                    className="w-full px-3 py-2 rounded-lg border dark:bg-slate-800 dark:border-slate-700"
                                    value={formData.adminName}
                                    onChange={e => setFormData(prev => ({ ...prev, adminName: e.target.value }))}
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Admin Email</label>
                                    <input
                                        required
                                        type="email"
                                        className="w-full px-3 py-2 rounded-lg border dark:bg-slate-800 dark:border-slate-700"
                                        value={formData.adminEmail}
                                        onChange={e => setFormData(prev => ({ ...prev, adminEmail: e.target.value }))}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Password</label>
                                    <div className="relative">
                                        <input
                                            required
                                            type={showPassword ? "text" : "password"}
                                            className="w-full px-3 py-2 rounded-lg border dark:bg-slate-800 dark:border-slate-700 pr-10"
                                            value={formData.adminPassword}
                                            onChange={e => setFormData(prev => ({ ...prev, adminPassword: e.target.value }))}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                                        >
                                            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div className="flex justify-end gap-2 mt-6">
                                <button
                                    type="button"
                                    onClick={() => setShowCreateModal(false)}
                                    className="px-4 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 font-bold text-sm"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-bold text-sm"
                                >
                                    Create Business
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {
                message && (
                    <div className={`p-4 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-rose-50 text-rose-700 border border-rose-100'
                        }`}>
                        {message.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                        <span className="font-medium text-sm">{message.text}</span>
                    </div>
                )
            }


            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {businesses.map(business => (
                    <div
                        key={business.id}
                        onClick={() => setSelectedBusiness(business)}
                        className="glass-card p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md transition-all relative overflow-hidden group cursor-pointer hover:border-indigo-300 dark:hover:border-indigo-800"
                    >
                        {/* Ribbon for Source Business */}
                        {(business.slug === 'freezer-chef' || business.slug === 'freezeriq') && (
                            <div className={`absolute top-0 right-0 ${business.slug === 'freezeriq' ? 'bg-amber-500' : 'bg-indigo-500'} text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl shadow-sm z-10`}>
                                {business.slug === 'freezeriq' ? 'SUPER ADMIN' : 'SOURCE BLUEPRINT'}
                            </div>
                        )}

                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <h3 className="text-lg font-bold text-slate-800 dark:text-white truncate max-w-[180px]">{business.name}</h3>
                                <p className="text-xs text-slate-400 font-medium">Joined {new Date(business.created_at).toLocaleDateString()}</p>
                            </div>
                            <span className={`px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider ${business.plan === 'ULTIMATE' ? 'bg-purple-100 text-purple-700' : business.plan === 'PRO' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600'}`}>
                                {business.plan}
                            </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2 mb-6 text-center">
                            <div className="bg-slate-50 dark:bg-slate-800/50 p-2 rounded-xl">
                                <Users size={16} className="mx-auto mb-1 text-slate-400" />
                                <span className="block text-sm font-bold text-slate-700 dark:text-slate-200">{business._count.users}</span>
                                <span className="text-[10px] text-slate-400 uppercase font-bold">Users</span>
                            </div>
                            <div className="bg-slate-50 dark:bg-slate-800/50 p-2 rounded-xl text-indigo-600">
                                <BookOpen size={16} className="mx-auto mb-1 text-indigo-400" />
                                <span className="block text-sm font-bold">{business._count.recipes}</span>
                                <span className="text-[10px] text-slate-400 uppercase font-bold">Recipes</span>
                            </div>
                            <div className="bg-slate-50 dark:bg-slate-800/50 p-2 rounded-xl">
                                <Package size={16} className="mx-auto mb-1 text-slate-400" />
                                <span className="block text-sm font-bold text-slate-700 dark:text-slate-200">{business._count.ingredients}</span>
                                <span className="text-[10px] text-slate-400 uppercase font-bold">Items</span>
                            </div>
                        </div>

                        {business.slug !== 'freezer-chef' && business.slug !== 'freezeriq' && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation(); // Prevent opening Details modal
                                    openDeployModal(business.id);
                                }}
                                disabled={deployingId !== null}
                                className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all ${deployingId === business.id
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                    : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-500/20 active:scale-[0.98]'
                                    }`}
                            >
                                {deployingId === business.id ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <Send size={16} />
                                )}
                                {deployingId === business.id ? 'Deploying...' : 'Push Template Library'}
                            </button>
                        )}

                        {business.slug === 'freezer-chef' && (
                            <div className="w-full bg-slate-100 dark:bg-slate-800 py-3 rounded-xl font-bold text-xs text-center text-slate-400 border border-dashed border-slate-300 dark:border-slate-700">
                                Global Source Application
                            </div>
                        )}

                        {business.slug === 'freezeriq' && (
                            <div className="w-full bg-amber-50 dark:bg-amber-900/20 py-3 rounded-xl font-black text-xs text-center text-amber-600 border border-amber-200 dark:border-amber-800 uppercase tracking-widest">
                                Platform Administrator
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div >
    );
}
