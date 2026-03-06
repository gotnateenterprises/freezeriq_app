"use client";

import { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, FileText, PlayCircle, BookOpen, ExternalLink, Download, Search, RefreshCw, CheckCircle, Circle, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';

// Local type definition since Prisma Client might not be generated yet
type ResourceType = 'VIDEO' | 'SOP' | 'FAQ';

interface TrainingResource {
    id: string;
    title: string;
    description: string | null;
    type: ResourceType;
    category: string;
    url: string | null;
    content: string | null;
    thumbnail: string | null;
    isActive: boolean;
    created_at: string;
    isCompleted?: boolean;
}

export default function TrainingHub() {
    const [openFaq, setOpenFaq] = useState<number | null>(0);
    const [resources, setResources] = useState<TrainingResource[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [showAddModal, setShowAddModal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const { data: session } = useSession();
    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;

    const [newResource, setNewResource] = useState({
        title: '',
        description: '',
        type: 'SOP' as ResourceType,
        category: '',
        url: '',
        content: ''
    });

    useEffect(() => {
        fetchResources();
    }, []);

    const fetchResources = async () => {
        try {
            const res = await fetch('/api/training');
            if (res.ok) {
                const data = await res.json();
                setResources(data);
            }
        } catch (error) {
            console.error("Failed to fetch training resources", error);
        } finally {
            setLoading(false);
        }
    };

    const toggleProgress = async (resourceId: string, currentStatus: boolean, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // Optimistic update
        setResources(prev => prev.map(r =>
            r.id === resourceId ? { ...r, isCompleted: !currentStatus } : r
        ));

        try {
            await fetch('/api/training/progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resourceId, completed: !currentStatus })
            });
        } catch (error) {
            console.error("Failed to update progress");
            // Revert on error
            setResources(prev => prev.map(r =>
                r.id === resourceId ? { ...r, isCompleted: currentStatus } : r
            ));
        }
    };

    // Calculate Progress
    const totalItems = resources.length;
    const completedItems = resources.filter(r => r.isCompleted).length;
    const progressPercentage = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

    // Filter resources
    const filteredResources = resources.filter(r =>
        r.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.category.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const videos = filteredResources.filter(r => r.type === 'VIDEO');
    const sops = filteredResources.filter(r => r.type === 'SOP');
    const faqs = filteredResources.filter(r => r.type === 'FAQ');

    const handleCreateResource = async () => {
        if (!newResource.title || !newResource.category) {
            alert("Title and Category are required");
            return;
        }

        setIsSaving(true);
        try {
            const res = await fetch('/api/training', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newResource)
            });

            if (res.ok) {
                setShowAddModal(false);
                setNewResource({ title: '', description: '', type: 'SOP', category: '', url: '', content: '' });
                fetchResources();
            } else {
                const err = await res.json();
                alert("Failed: " + err.error);
            }
        } catch (e) {
            console.error(e);
            alert("Error creating resource");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="max-w-6xl mx-auto p-4 md:p-8">
            <div className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                        <BookOpen className="text-indigo-600" />
                        Training Hub
                    </h1>
                    <p className="text-slate-500 font-medium">Resources, guides, and tutorials for the team.</p>
                </div>

                {isSuperAdmin && (
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-indigo-200 dark:shadow-none transition-all active:scale-95"
                    >
                        <Plus size={20} />
                        Add Resource
                    </button>
                )}

                {/* Progress Card */}
                <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm flex items-center gap-4 min-w-[300px]">
                    <div className="relative w-12 h-12 flex items-center justify-center">
                        <svg className="w-full h-full transform -rotate-90">
                            <circle cx="24" cy="24" r="20" className="text-slate-100 dark:text-slate-700" strokeWidth="4" fill="none" />
                            <circle cx="24" cy="24" r="20" className="text-indigo-600" strokeWidth="4" fill="none" strokeDasharray={126} strokeDashoffset={126 - (126 * progressPercentage) / 100} strokeLinecap="round" />
                        </svg>
                        <span className="absolute text-xs font-bold text-slate-700 dark:text-slate-300">{progressPercentage}%</span>
                    </div>
                    <div>
                        <div className="text-sm font-bold text-slate-800 dark:text-gray-200">Your Progress</div>
                        <div className="text-xs text-slate-500">{completedItems} of {totalItems} completed</div>
                    </div>
                </div>

                <div className="relative w-full md:w-64">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                    <input
                        type="text"
                        placeholder="Search resources..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                    />
                </div>
            </div>

            {loading ? (
                <div className="flex justify-center py-20">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                    {/* Main Content (Videos & SOPs) */}
                    <div className="lg:col-span-2 space-y-8">

                        {/* Video Section */}
                        {videos.length > 0 && (
                            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
                                <h2 className="text-xl font-bold flex items-center gap-2 mb-4">
                                    <PlayCircle className="text-rose-500" /> Video Tutorials
                                </h2>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {videos.map((video) => (
                                        <div key={video.id} className="group cursor-pointer relative">
                                            <a href={video.url || '#'} target="_blank" rel="noopener noreferrer" className="block">
                                                <div className={`aspect-video rounded-xl bg-slate-100 dark:bg-slate-700 mb-3 flex items-center justify-center group-hover:opacity-90 transition-opacity relative overflow-hidden`}>
                                                    {video.thumbnail ? (
                                                        <img src={video.thumbnail} alt={video.title} className="w-full h-full object-cover" />
                                                    ) : (
                                                        <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                                                            <PlayCircle className="text-slate-900 ml-1" />
                                                        </div>
                                                    )}
                                                    {/* Completion check overlay */}
                                                    {video.isCompleted && (
                                                        <div className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 shadow-md">
                                                            <CheckCircle size={16} />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex justify-between items-start gap-2">
                                                    <div>
                                                        <h3 className="font-bold text-slate-800 dark:text-gray-200 group-hover:text-indigo-600 transition-colors line-clamp-2">{video.title}</h3>
                                                        <p className="text-xs text-slate-500 mt-1">{video.category}</p>
                                                    </div>
                                                    <button
                                                        onClick={(e) => toggleProgress(video.id, !!video.isCompleted, e)}
                                                        className={`shrink-0 p-1 rounded-full transition-colors ${video.isCompleted ? 'text-green-500 hover:text-green-600' : 'text-slate-300 hover:text-slate-400'}`}
                                                    >
                                                        {video.isCompleted ? <CheckCircle size={20} /> : <Circle size={20} />}
                                                    </button>
                                                </div>
                                            </a>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* SOP Downloads */}
                        {sops.length > 0 && (
                            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
                                <h2 className="text-xl font-bold flex items-center gap-2 mb-4">
                                    <FileText className="text-indigo-600" /> Standard Operating Procedures (SOPs)
                                </h2>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {sops.map((sop) => (
                                        <div key={sop.id} className="relative group">
                                            <a href={sop.url || '#'} target="_blank" rel="noopener noreferrer" className="flex items-center p-3 rounded-xl border border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors cursor-pointer pr-10">
                                                <div className="w-10 h-10 bg-slate-100 dark:bg-slate-700 text-slate-500 rounded-lg flex items-center justify-center mr-3">
                                                    <FileText size={20} />
                                                </div>
                                                <div className="flex-1">
                                                    <div className="font-bold text-slate-700 dark:text-slate-200 line-clamp-1">{sop.title}</div>
                                                    <div className="text-xs text-slate-400">{sop.category}</div>
                                                </div>
                                            </a>
                                            <button
                                                onClick={(e) => toggleProgress(sop.id, !!sop.isCompleted, e)}
                                                className={`absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full transition-colors ${sop.isCompleted ? 'text-green-500 hover:text-green-600' : 'text-slate-300 hover:text-slate-400'}`}
                                                title={sop.isCompleted ? "Mark as Incomplete" : "Mark as Complete"}
                                            >
                                                {sop.isCompleted ? <CheckCircle size={20} /> : <Circle size={20} />}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {videos.length === 0 && sops.length === 0 && (
                            <div className="text-center py-12 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                                <BookOpen className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                                <h3 className="text-lg font-medium text-slate-600">No resources found</h3>
                                <p className="text-slate-400">Try adjusting your search terms.</p>
                            </div>
                        )}
                    </div>

                    {/* Sidebar (FAQs) */}
                    <div className="space-y-6">
                        <div className="bg-indigo-900 text-white p-6 rounded-2xl shadow-lg relative overflow-hidden">
                            <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-10 -mt-10 blur-2xl"></div>
                            <h3 className="font-bold text-lg mb-2 relative">Need Help?</h3>
                            <p className="text-indigo-200 text-sm mb-4 relative">
                                Can't find what you're looking for? Contact support directly.
                            </p>
                            <a href="mailto:support@example.com" className="inline-block bg-white text-indigo-900 px-4 py-2 rounded-lg font-bold text-sm hover:bg-indigo-50 transition-colors relative">
                                Contact Support
                            </a>
                        </div>

                        {faqs.length > 0 && (
                            <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
                                <h2 className="text-xl font-bold mb-4">Frequently Asked Questions</h2>
                                <div className="space-y-2">
                                    {faqs.map((faq, i) => (
                                        <div key={faq.id} className="border-b border-slate-100 dark:border-slate-700 last:border-0 pb-2 last:pb-0">
                                            <div className="flex items-center gap-2">
                                                <button
                                                    className="flex-1 flex items-center justify-between text-left font-bold text-slate-700 dark:text-slate-300 py-2 hover:text-indigo-600"
                                                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                                                >
                                                    <span className="flex-1 pr-4">{faq.title}</span>
                                                    {openFaq === i ? <ChevronUp size={16} className="shrink-0" /> : <ChevronDown size={16} className="shrink-0" />}
                                                </button>
                                                <button
                                                    onClick={(e) => toggleProgress(faq.id, !!faq.isCompleted, e)}
                                                    className={`shrink-0 p-1 rounded-full transition-colors ${faq.isCompleted ? 'text-green-500 hover:text-green-600' : 'text-slate-300 hover:text-slate-400'}`}
                                                >
                                                    {faq.isCompleted ? <CheckCircle size={16} /> : <Circle size={16} />}
                                                </button>
                                            </div>
                                            {openFaq === i && (
                                                <div className="text-sm text-slate-500 pb-2 leading-relaxed animate-in fade-in slide-in-from-top-1 whitespace-pre-wrap">
                                                    {faq.content}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                </div>
            )}

            {/* Add Resource Modal */}
            {showAddModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-slate-800 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center">
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">Add New Training Resource</h2>
                            <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600"><X size={24} /></button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Resource Title</label>
                                    <input
                                        type="text"
                                        className="w-full px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
                                        placeholder="e.g. Closing Procedures"
                                        value={newResource.title}
                                        onChange={e => setNewResource({ ...newResource, title: e.target.value })}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Category</label>
                                    <input
                                        type="text"
                                        className="w-full px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
                                        placeholder="e.g. Operations"
                                        value={newResource.category}
                                        onChange={e => setNewResource({ ...newResource, category: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div className="space-y-1">
                                <label className="text-xs font-black uppercase tracking-widest text-slate-400">Type</label>
                                <select
                                    className="w-full px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
                                    value={newResource.type}
                                    onChange={e => setNewResource({ ...newResource, type: e.target.value as ResourceType })}
                                >
                                    <option value="SOP">SOP (PDF/Link)</option>
                                    <option value="VIDEO">Video (YouTube/Vimeo)</option>
                                    <option value="FAQ">FAQ (Text Content)</option>
                                </select>
                            </div>

                            <div className="space-y-1">
                                <label className="text-xs font-black uppercase tracking-widest text-slate-400">Description (Optional)</label>
                                <textarea
                                    className="w-full px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 min-h-[80px]"
                                    placeholder="Short summary..."
                                    value={newResource.description}
                                    onChange={e => setNewResource({ ...newResource, description: e.target.value })}
                                />
                            </div>

                            {newResource.type !== 'FAQ' ? (
                                <div className="space-y-1">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">Resource URL</label>
                                    <input
                                        type="text"
                                        className="w-full px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
                                        placeholder="https://..."
                                        value={newResource.url}
                                        onChange={e => setNewResource({ ...newResource, url: e.target.value })}
                                    />
                                </div>
                            ) : (
                                <div className="space-y-1">
                                    <label className="text-xs font-black uppercase tracking-widest text-slate-400">FAQ Content (Markdown)</label>
                                    <textarea
                                        className="w-full px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 outline-none focus:ring-2 focus:ring-indigo-500 min-h-[120px]"
                                        placeholder="Detailed answer or instructions..."
                                        value={newResource.content}
                                        onChange={e => setNewResource({ ...newResource, content: e.target.value })}
                                    />
                                </div>
                            )}
                        </div>
                        <div className="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 flex justify-end gap-3">
                            <button
                                onClick={() => setShowAddModal(false)}
                                className="px-5 py-2 rounded-xl font-bold text-slate-600 hover:bg-slate-200 transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreateResource}
                                disabled={isSaving}
                                className="px-8 py-2 bg-indigo-600 text-white rounded-xl font-bold shadow-lg shadow-indigo-200 dark:shadow-none hover:bg-indigo-700 transition-all disabled:opacity-50"
                            >
                                {isSaving ? "Saving..." : "Create Resource"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
