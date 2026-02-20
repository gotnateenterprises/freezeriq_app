'use client';

import { useEffect, useState } from 'react';
import { Mail, Calendar, User, ChefHat, RefreshCw, ExternalLink } from 'lucide-react';
import Link from 'next/link';

interface BusinessLead {
    id: string;
    name: string;
    email: string;
    type: string;
    status: string;
    created_at: string;
}

export default function AdminLeadsPage() {
    const [leads, setLeads] = useState<BusinessLead[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchLeads = async () => {
        setLoading(true);
        try {
            // Reusing a simple GET endpoint we'll create next, or just server action eventually
            // For now, let's assume we create a GET route at /api/admin/leads
            const res = await fetch('/api/admin/leads');
            const data = await res.json();
            setLeads(data.leads || []);
        } catch (error) {
            console.error('Failed to load leads', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLeads();
    }, []);

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white">New Business Leads</h1>
                    <p className="text-slate-500">Inquiries from the "Start a Business" page.</p>
                </div>
                <button
                    onClick={fetchLeads}
                    className="p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 transition"
                >
                    <RefreshCw size={20} className={loading ? 'animate-spin text-indigo-500' : 'text-slate-500'} />
                </button>
            </div>

            <div className="grid grid-cols-1 gap-4">
                {leads.length === 0 && !loading ? (
                    <div className="text-center py-20 bg-slate-50 dark:bg-slate-900 rounded-3xl border border-dashed border-slate-200 dark:border-slate-700">
                        <p className="text-slate-400">No leads found yet.</p>
                    </div>
                ) : (
                    leads.map(lead => (
                        <div key={lead.id} className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-900/30 rounded-full flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-bold text-lg">
                                    {lead.name.charAt(0)}
                                </div>
                                <div>
                                    <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
                                        {lead.name}
                                        {lead.status === 'NEW' && <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full uppercase tracking-wide font-bold">New</span>}
                                    </h3>
                                    <div className="flex flex-col md:flex-row md:items-center gap-1 md:gap-4 text-sm text-slate-500">
                                        <a href={`mailto:${lead.email}`} className="flex items-center gap-1.5 hover:text-indigo-500 transition-colors">
                                            <Mail size={14} /> {lead.email}
                                        </a>
                                        <span className="hidden md:inline text-slate-300">•</span>
                                        <span className="flex items-center gap-1.5">
                                            <ChefHat size={14} /> {lead.type}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-col items-end gap-1 text-xs font-bold text-slate-400 uppercase tracking-widest">
                                <div className="flex items-center gap-1.5">
                                    <Calendar size={12} />
                                    {new Date(lead.created_at).toLocaleDateString()}
                                </div>
                                <span className="opacity-50">{new Date(lead.created_at).toLocaleTimeString()}</span>
                                <Link
                                    href={`/fundraisers?search=${encodeURIComponent(lead.name)}`}
                                    className="mt-2 flex items-center gap-1.5 text-indigo-600 hover:text-indigo-800 transition-colors"
                                >
                                    <ExternalLink size={12} /> View in CRM
                                </Link>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
