"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Plus, Calendar, ChevronRight, Loader2, ArrowLeft } from 'lucide-react';

interface ProductionRun {
    id: string;
    name: string;
    run_date: string;
    status: 'planning' | 'active' | 'completed';
    _count?: {
        tasks: number;
    };
}

export default function ProductionSchedule() {
    const [runs, setRuns] = useState<ProductionRun[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showNewModal, setShowNewModal] = useState(false);

    // New Run Form
    const [newName, setNewName] = useState('');
    const [newDate, setNewDate] = useState(new Date().toISOString().split('T')[0]);

    useEffect(() => {
        fetchRuns();
    }, []);

    const fetchRuns = async () => {
        try {
            const res = await fetch('/api/production/runs');
            if (res.ok) {
                const data = await res.json();
                setRuns(data);
            }
        } catch (e) {
            console.error("Failed to fetch runs");
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateRun = async () => {
        if (!newName) return;
        try {
            const res = await fetch('/api/production/runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName, run_date: newDate })
            });
            if (res.ok) {
                const newRun = await res.json();
                setRuns([newRun, ...runs]);
                setShowNewModal(false);
                setNewName('');
            }
        } catch (e) {
            alert("Failed to create run");
        }
    };

    return (
        <div className="max-w-5xl mx-auto p-4 md:p-8">
            <div className="flex items-center gap-4 mb-8">
                <Link href="/production" className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                    <ArrowLeft size={20} className="text-slate-500" />
                </Link>
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">Production Tasks</h1>
                    <p className="text-slate-500 font-medium">Manage your kitchen runs</p>
                </div>
            </div>

            <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold text-slate-800 dark:text-slate-200">Upcoming Runs</h2>
                <button
                    onClick={() => setShowNewModal(true)}
                    className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-bold shadow-lg shadow-indigo-500/20 hover:bg-indigo-700 transition-all active:scale-95"
                >
                    <Plus size={20} />
                    Create New Run
                </button>
            </div>

            {isLoading ? (
                <div className="flex justify-center p-12">
                    <Loader2 size={32} className="animate-spin text-indigo-500" />
                </div>
            ) : runs.length === 0 ? (
                <div className="text-center p-12 bg-slate-50 dark:bg-slate-900 rounded-3xl border border-dashed border-slate-300 dark:border-slate-700">
                    <Calendar size={48} className="mx-auto text-slate-300 mb-4" />
                    <h3 className="text-lg font-bold text-slate-700 dark:text-slate-300">No active tasks</h3>
                    <p className="text-slate-500">Create your first production run to get started.</p>
                </div>
            ) : (
                <div className="grid gap-4">
                    {runs.map(run => (
                        <Link key={run.id} href={`/production/run/${run.id}`}>
                            <div className="group bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-500 transition-all flex items-center justify-between">
                                <div className="flex gap-6 items-center">
                                    <div className="w-16 h-16 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 flex flex-col items-center justify-center text-indigo-600 dark:text-indigo-400 font-bold border border-indigo-100 dark:border-indigo-800/30">
                                        <span className="text-xs uppercase tracking-wider opacity-60">{new Date(run.run_date).toLocaleDateString('en-US', { month: 'short' })}</span>
                                        <span className="text-2xl">{new Date(run.run_date).getDate() + 1}</span>
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-bold text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{run.name}</h3>
                                        <div className="flex items-center gap-3 mt-1">
                                            <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider ${run.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                                                run.status === 'active' ? 'bg-amber-100 text-amber-700' :
                                                    'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                                                }`}>
                                                {run.status}
                                            </span>
                                            <span className="text-sm text-slate-400">{run._count?.tasks || 0} Tasks</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="w-10 h-10 rounded-full bg-slate-50 dark:bg-slate-700 flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                                    <ChevronRight size={20} />
                                </div>
                            </div>
                        </Link>
                    ))}
                </div>
            )}

            {/* New Run Modal */}
            {showNewModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md p-6 border border-slate-200 dark:border-slate-700">
                        <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-6">New Production Run</h2>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Run Name</label>
                                <input
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                    placeholder="e.g. Monday Morning Prep"
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Date</label>
                                <input
                                    type="date"
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                    value={newDate}
                                    onChange={e => setNewDate(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className="flex gap-3 mt-8">
                            <button
                                onClick={() => setShowNewModal(false)}
                                className="flex-1 py-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreateRun}
                                disabled={!newName}
                                className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-50"
                            >
                                Create Run
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
