
"use client";

import { useState, useEffect } from 'react';
import { Plus, Trash2, Video, FileText, HelpCircle, Save, X, Search, ExternalLink, BarChart3 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

type ResourceType = 'VIDEO' | 'SOP' | 'FAQ';

interface TrainingResource {
    id: string;
    title: string;
    type: ResourceType;
    category: string;
    url?: string;
    content?: string;
    isActive: boolean;
}

export default function AdminTrainingPage() {
    const router = useRouter();
    const [resources, setResources] = useState<TrainingResource[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [isCreating, setIsCreating] = useState(false);

    // Form State
    const [formData, setFormData] = useState({
        title: '',
        type: 'VIDEO' as ResourceType,
        category: 'General',
        url: '',
        content: '',
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
            console.error("Failed to fetch resources");
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const res = await fetch('/api/admin/training', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            if (res.ok) {
                setIsCreating(false);
                setFormData({ title: '', type: 'VIDEO', category: 'General', url: '', content: '' });
                fetchResources(); // Refresh list
            } else {
                alert("Failed to create resource");
            }
        } catch (error) {
            alert("Error creating resource");
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this resource?")) return;
        try {
            const res = await fetch(`/api/admin/training/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setResources(resources.filter(r => r.id !== id));
            }
        } catch (error) {
            alert("Failed to delete");
        }
    };

    const filteredResources = resources.filter(r =>
        r.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.category.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="p-6 max-w-6xl mx-auto">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-slate-800">Training Resources</h1>
                    <p className="text-slate-500">Manage global training content (Videos, SOPs, FAQs).</p>
                </div>
                <div className="flex gap-2">
                    <Link
                        href="/admin/training/progress"
                        className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                    >
                        <BarChart3 size={18} /> View Progress
                    </Link>
                    <button
                        onClick={() => setIsCreating(true)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors"
                    >
                        <Plus size={18} /> Add Resource
                    </button>
                </div>
            </div>

            {/* Creation Modal/Panel */}
            {isCreating && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 animate-in fade-in zoom-in-95">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-xl font-bold text-slate-800">Add New Resource</h2>
                            <button onClick={() => setIsCreating(false)} className="text-slate-400 hover:text-slate-600">
                                <X size={24} />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 mb-1">Title</label>
                                <input
                                    required
                                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                                    value={formData.title}
                                    onChange={e => setFormData({ ...formData, title: e.target.value })}
                                    placeholder="e.g., How to Print Labels"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
                                    <select
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                                        value={formData.type}
                                        onChange={e => setFormData({ ...formData, type: e.target.value as ResourceType })}
                                    >
                                        <option value="VIDEO">Video</option>
                                        <option value="SOP">SOP (PDF)</option>
                                        <option value="FAQ">FAQ</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
                                    <input
                                        required
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                                        value={formData.category}
                                        onChange={e => setFormData({ ...formData, category: e.target.value })}
                                        placeholder="e.g., Delivery"
                                    />
                                </div>
                            </div>

                            {formData.type === 'FAQ' ? (
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">Answer / Content</label>
                                    <textarea
                                        required
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none h-32"
                                        value={formData.content}
                                        onChange={e => setFormData({ ...formData, content: e.target.value })}
                                        placeholder="Type the answer here..."
                                    />
                                </div>
                            ) : (
                                <div>
                                    <label className="block text-sm font-medium text-slate-700 mb-1">URL (Link)</label>
                                    <input
                                        required
                                        type="url"
                                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                                        value={formData.url}
                                        onChange={e => setFormData({ ...formData, url: e.target.value })}
                                        placeholder={formData.type === 'VIDEO' ? "https://youtube.com/..." : "https://example.com/file.pdf"}
                                    />
                                </div>
                            )}

                            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
                                <button
                                    type="button"
                                    onClick={() => setIsCreating(false)}
                                    className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-50 rounded-lg"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 flex items-center gap-2"
                                >
                                    <Save size={18} /> Save Resource
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Search */}
            <div className="relative mb-6">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                <input
                    type="text"
                    placeholder="Search resources..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 shadow-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
            </div>

            {/* List */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs uppercase font-semibold">
                        <tr>
                            <th className="px-6 py-4">Title</th>
                            <th className="px-6 py-4">Type</th>
                            <th className="px-6 py-4">Category</th>
                            <th className="px-6 py-4">Content/URL</th>
                            <th className="px-6 py-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {filteredResources.map((resource) => (
                            <tr key={resource.id} className="hover:bg-slate-50 transition-colors">
                                <td className="px-6 py-4 font-medium text-slate-800">{resource.title}</td>
                                <td className="px-6 py-4">
                                    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${resource.type === 'VIDEO' ? 'bg-rose-100 text-rose-700' :
                                        resource.type === 'SOP' ? 'bg-indigo-100 text-indigo-700' :
                                            'bg-emerald-100 text-emerald-700'
                                        }`}>
                                        {resource.type === 'VIDEO' && <Video size={12} />}
                                        {resource.type === 'SOP' && <FileText size={12} />}
                                        {resource.type === 'FAQ' && <HelpCircle size={12} />}
                                        {resource.type}
                                    </span>
                                </td>
                                <td className="px-6 py-4 text-slate-500 text-sm">{resource.category}</td>
                                <td className="px-6 py-4 text-sm text-slate-500 max-w-xs truncate">
                                    {resource.url ? (
                                        <a href={resource.url} target="_blank" className="text-blue-600 hover:underline flex items-center gap-1">
                                            {resource.url} <ExternalLink size={12} />
                                        </a>
                                    ) : (
                                        <span title={resource.content}>{resource.content?.substring(0, 50)}...</span>
                                    )}
                                </td>
                                <td className="px-6 py-4 text-right">
                                    <button
                                        onClick={() => handleDelete(resource.id)}
                                        className="text-slate-400 hover:text-red-600 transition-colors p-2 rounded-lg hover:bg-red-50"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {filteredResources.length === 0 && (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                                    No resources found. Click "Add Resource" to create one.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
