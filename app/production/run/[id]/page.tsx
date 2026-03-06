"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle, Circle, Trash2, Plus, Loader2, Printer } from 'lucide-react';

interface ProductionTask {
    id: string;
    item_id: string;
    item_type: 'recipe' | 'ingredient';
    total_qty_needed: number;
    unit: string;
    status: 'todo' | 'in_progress' | 'done';
}

interface ProductionRun {
    id: string;
    name: string;
    run_date: string;
    status: 'planning' | 'active' | 'completed';
    tasks: ProductionTask[];
}

export default function RunDetail() {
    const params = useParams();
    const router = useRouter();
    const [run, setRun] = useState<ProductionRun | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const [showAddModal, setShowAddModal] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemQty, setNewItemQty] = useState('');
    const [newItemUnit, setNewItemUnit] = useState('ea');

    useEffect(() => {
        if (params.id) {
            fetchRun(params.id as string);
        }
    }, [params]);

    const fetchRun = async (id: string) => {
        try {
            const res = await fetch(`/api/production/runs/${id}`);
            if (res.ok) {
                const data = await res.json();
                setRun(data);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const toggleTaskStatus = async (task: ProductionTask) => {
        const newStatus = task.status === 'done' ? 'todo' : 'done';

        setRun(prev => prev ? ({
            ...prev,
            tasks: prev.tasks.map(t => t.id === task.id ? { ...t, status: newStatus } : t)
        }) : null);

        try {
            await fetch('/api/production/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: task.id, status: newStatus })
            });
        } catch (e) {
            fetchRun(params.id as string);
        }
    };

    const addTask = async () => {
        if (!run || !newItemName) return;

        try {
            const res = await fetch('/api/production/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    production_run_id: run.id,
                    item_id: newItemName,
                    item_type: 'recipe',
                    total_qty_needed: Number(newItemQty) || 1,
                    unit: newItemUnit
                })
            });

            if (res.ok) {
                const newTask = await res.json();
                setRun(prev => prev ? ({ ...prev, tasks: [...prev.tasks, newTask] }) : null);
                setShowAddModal(false);
                setNewItemName('');
                setNewItemQty('');
            }
        } catch (e) {
            alert("Failed to add task");
        }
    };

    const deleteTask = async (taskId: string) => {
        if (!confirm("Remove this task?")) return;
        setRun(prev => prev ? ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) }) : null);
        await fetch(`/api/production/tasks?id=${taskId}`, { method: 'DELETE' });
    };

    if (isLoading) return <div className="flex justify-center p-12"><Loader2 className="animate-spin" /></div>;
    if (!run) return <div className="p-8">Run not found</div>;

    const allTasksDone = run.tasks.length > 0 && run.tasks.every(t => t.status === 'done');

    return (
        <div className="max-w-4xl mx-auto p-4 md:p-8">
            <Link href="/production/schedule" className="flex items-center gap-2 text-slate-500 hover:text-slate-800 mb-6 font-bold transition-colors">
                <ArrowLeft size={20} />
                Back to Tasks
            </Link>

            <div className="flex justify-between items-start mb-8">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white mb-2">{run.name}</h1>
                    <div className="flex items-center gap-3">
                        <div className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-lg text-sm font-bold">
                            {new Date(run.run_date).toLocaleDateString()}
                        </div>
                        <div className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-lg text-sm font-bold uppercase">
                            {run.status}
                        </div>
                    </div>
                </div>
                <button
                    onClick={() => setShowAddModal(true)}
                    className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-5 py-3 rounded-xl font-bold hover:opacity-90 transition-all flex items-center gap-2"
                >
                    <Plus size={20} />
                    Add Task
                </button>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                {run.tasks.length === 0 ? (
                    <div className="p-12 text-center text-slate-400">
                        <p>No tasks yet.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-700">
                        {run.tasks.map(task => (
                            <div key={task.id} className="p-4 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                                <div className="flex items-center gap-4">
                                    <button onClick={() => toggleTaskStatus(task)} className={`transition-colors ${task.status === 'done' ? 'text-emerald-500' : 'text-slate-300 hover:text-emerald-500'}`}>
                                        {task.status === 'done' ? <CheckCircle size={24} className="fill-current" /> : <Circle size={24} />}
                                    </button>
                                    <div>
                                        <div className={`font-bold text-lg ${task.status === 'done' ? 'text-slate-400 line-through decoration-2' : 'text-slate-900 dark:text-white'}`}>
                                            {task.item_id}
                                        </div>
                                        <div className="text-sm font-bold text-slate-500">
                                            {task.total_qty_needed} {task.unit}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {task.item_type === 'recipe' && (
                                        <Link
                                            href={`/labels?recipeId=${task.item_id}&printQty=${task.total_qty_needed}`}
                                            className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                                            title="Print Labels"
                                        >
                                            <Printer size={18} />
                                        </Link>
                                    )}
                                    <button
                                        onClick={() => deleteTask(task.id)}
                                        className="p-2 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {allTasksDone && (
                <div className="mt-8 flex justify-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <button
                        onClick={async () => {
                            if (confirm("All tasks are done! Remove this production run from your schedule?")) {
                                try {
                                    const res = await fetch(`/api/production/runs/${run.id}`, { method: 'DELETE' });
                                    if (res.ok) {
                                        router.push('/production/schedule');
                                    }
                                } catch (e) {
                                    alert("Failed to remove run");
                                }
                            }
                        }}
                        className="flex items-center gap-2 px-8 py-4 bg-rose-600 text-white rounded-2xl font-black shadow-xl shadow-rose-500/20 hover:bg-rose-700 transition-all hover:scale-105 active:scale-95 uppercase tracking-wider"
                    >
                        <Trash2 size={20} strokeWidth={2.5} />
                        Remove Completed Run
                    </button>
                </div>
            )}

            {showAddModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
                    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md p-6 border border-slate-200 dark:border-slate-700">
                        <h3 className="text-xl font-black mb-4">Add Production Task</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Item Name</label>
                                <input
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                    placeholder="e.g. Diced Onions"
                                    value={newItemName}
                                    onChange={e => setNewItemName(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <div className="flex gap-4">
                                <div className="flex-1">
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Qty</label>
                                    <input
                                        type="number"
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                        placeholder="10"
                                        value={newItemQty}
                                        onChange={e => setNewItemQty(e.target.value)}
                                    />
                                </div>
                                <div className="w-24">
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Unit</label>
                                    <input
                                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl font-bold outline-none focus:ring-2 focus:ring-indigo-500"
                                        placeholder="kg"
                                        value={newItemUnit}
                                        onChange={e => setNewItemUnit(e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-3 mt-8">
                            <button
                                onClick={() => setShowAddModal(false)}
                                className="flex-1 py-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={addTask}
                                disabled={!newItemName}
                                className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 disabled:opacity-50"
                            >
                                Add Task
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
