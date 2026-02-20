"use client";

import { useState, useEffect } from 'react';
import { MessageSquare, Phone, Mail, Clock, Send, CheckCircle2, FileText, Plus } from 'lucide-react';

interface Activity {
    id: string;
    type: string;
    content: string;
    timestamp: string;
    source: string;
}

export default function ActivityFeed({ customerId }: { customerId: string }) {
    const [activities, setActivities] = useState<Activity[]>([]);
    const [loading, setLoading] = useState(true);
    const [newNote, setNewNote] = useState('');
    const [noteType, setNoteType] = useState('note');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const fetchActivities = async () => {
        try {
            const res = await fetch(`/api/customers/${customerId}/activities`);
            if (res.ok) {
                const data = await res.json();
                setActivities(data);
            }
        } catch (e) {
            console.error("Failed to load activities");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchActivities();
    }, [customerId]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newNote.trim()) return;

        setIsSubmitting(true);
        try {
            const res = await fetch(`/api/customers/${customerId}/activities`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: noteType,
                    content: newNote
                })
            });

            if (res.ok) {
                setNewNote('');
                fetchActivities(); // Refresh list
            }
        } catch (e) {
            alert("Failed to save note");
        } finally {
            setIsSubmitting(false);
        }
    };

    const getIcon = (type: string) => {
        switch (type) {
            case 'call': return <Phone size={14} />;
            case 'email': return <Mail size={14} />;
            case 'meeting': return <Clock size={14} />;
            case 'document': return <FileText size={14} />;
            default: return <MessageSquare size={14} />;
        }
    };

    const getColor = (type: string) => {
        switch (type) {
            case 'call': return 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400';
            case 'email': return 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400';
            case 'document': return 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400';
            default: return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';
        }
    };

    return (
        <div className="space-y-6">
            {/* Input Area */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm">
                <form onSubmit={handleSubmit}>
                    <div className="flex gap-2 mb-3">
                        {['note', 'call', 'email', 'meeting'].map(t => (
                            <button
                                key={t}
                                type="button"
                                onClick={() => setNoteType(t)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wide transition-all ${noteType === t
                                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200 dark:shadow-none'
                                    : 'bg-slate-50 dark:bg-slate-900 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                                    }`}
                            >
                                {t}
                            </button>
                        ))}
                    </div>
                    <textarea
                        value={newNote}
                        onChange={e => setNewNote(e.target.value)}
                        placeholder={`Log a ${noteType}...`}
                        className="w-full bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-xl p-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none transition-all min-h-[100px] text-slate-900 dark:text-white placeholder:text-slate-400"
                    />
                    <div className="flex justify-end mt-2">
                        <button
                            type="submit"
                            disabled={isSubmitting || !newNote.trim()}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all disabled:opacity-50"
                        >
                            <Send size={14} />
                            Log Activity
                        </button>
                    </div>
                </form>
            </div>

            {/* Timeline */}
            <div className="space-y-4">
                {activities.length === 0 && !loading ? (
                    <div className="text-center py-10 text-slate-400 italic">No history yet. Start logging!</div>
                ) : (
                    activities.map(act => (
                        <div key={act.id} className="group flex gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="flex flex-col items-center">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border-2 border-white dark:border-slate-900 shadow-sm z-10 ${getColor(act.type)}`}>
                                    {getIcon(act.type)}
                                </div>
                                <div className="w-0.5 flex-1 bg-slate-100 dark:bg-slate-800 group-last:hidden mt-2"></div>
                            </div>
                            <div className="flex-1 pb-6">
                                <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-100 dark:border-slate-700 shadow-sm relative group-hover:border-indigo-200 dark:group-hover:border-indigo-800 transition-colors">
                                    <div className="flex justify-between items-start mb-2">
                                        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{act.type}</span>
                                        <span className="text-xs text-slate-400 font-medium">
                                            {new Date(act.timestamp).toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="text-slate-700 dark:text-slate-300 text-sm whitespace-pre-wrap leading-relaxed">
                                        {act.content}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
