"use client";

import { useState, useEffect } from 'react';
import { FileText, Plus, Edit2, Trash2, Calendar, FileCheck, Send, Loader2, AlertCircle, Link as LinkIcon } from 'lucide-react';
import DocumentCenter from '../DocumentCenter';

interface DocumentsTabProps {
    customer: any;
}

export default function DocumentsTab({ customer }: DocumentsTabProps) {
    const [documents, setDocuments] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [viewMode, setViewMode] = useState<'list' | 'create' | 'edit'>('list');
    const [selectedDoc, setSelectedDoc] = useState<any>(null);

    const fetchDocuments = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`/api/documents?customerId=${customer.id}`);
            if (res.ok) {
                const data = await res.json();
                setDocuments(data);
            }
        } catch (e) {
            console.error("Failed to load documents");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchDocuments();
    }, [customer.id]);

    const handleDelete = async (id: string) => {
        if (!confirm("Are you sure you want to delete this document?")) return;
        try {
            await fetch(`/api/documents/${id}`, { method: 'DELETE' });
            fetchDocuments();
        } catch (e) {
            alert("Failed to delete");
        }
    }

    const handleEdit = (doc: any) => {
        setSelectedDoc(doc);
        setViewMode('edit');
    }

    const handleCreate = () => {
        setSelectedDoc(null);
        setViewMode('create');
    }

    const onSaveComplete = () => {
        setViewMode('list');
        fetchDocuments();
    }

    if (viewMode === 'create' || viewMode === 'edit') {
        return (
            <div className="space-y-4 animate-in slide-in-from-right duration-300">
                <button
                    onClick={() => setViewMode('list')}
                    className="text-sm font-bold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 flex items-center gap-2 mb-4"
                >
                    &larr; Back to Documents
                </button>
                <DocumentCenter
                    customer={customer}
                    existingDoc={selectedDoc}
                    onSave={() => onSaveComplete()}
                />
            </div>
        )
    }

    if (isLoading) return <div className="p-12 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>;

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
            <div className="flex justify-between items-center">
                <h3 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                    <FileCheck className="text-indigo-500" />
                    Documents & Forms
                </h3>
                <button
                    onClick={handleCreate}
                    className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-none transition-all"
                >
                    <Plus size={18} />
                    Create New
                </button>
            </div>

            {documents.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border border-slate-100 dark:border-slate-700 text-center">
                    <div className="w-16 h-16 bg-white dark:bg-slate-700 rounded-full flex items-center justify-center mb-4 shadow-sm">
                        <FileText size={32} className="text-slate-300" />
                    </div>
                    <h4 className="font-bold text-slate-900 dark:text-white mb-2">No documents yet</h4>
                    <p className="text-slate-500 dark:text-slate-400 max-w-sm mb-6">Start by creating a Fundraiser Agreement or Sales Sheet for this customer.</p>
                    <button
                        onClick={handleCreate}
                        className="text-indigo-600 dark:text-indigo-400 font-bold hover:underline"
                    >
                        Create your first document
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {documents.map(doc => (
                        <div key={doc.id} className="group bg-white dark:bg-slate-800 p-5 rounded-2xl border border-slate-100 dark:border-slate-700 hover:border-indigo-200 dark:hover:border-indigo-500/30 hover:shadow-lg transition-all relative overflow-hidden">
                            <div className="flex justify-between items-start mb-3">
                                <div className="p-3 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-xl">
                                    <FileText size={24} />
                                </div>
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onClick={() => handleEdit(doc)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg text-slate-500 hover:text-indigo-600 transition-colors">
                                        <Edit2 size={16} />
                                    </button>
                                    <button onClick={() => handleDelete(doc.id)} className="p-2 hover:bg-rose-50 dark:hover:bg-rose-900/20 rounded-lg text-slate-400 hover:text-rose-500 transition-colors">
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            </div>

                            <h4 className="font-bold text-slate-900 dark:text-white truncate mb-1">{doc.name}</h4>
                            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-4">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide 
                                    ${doc.status === 'Sent' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                                    {doc.status}
                                </span>
                                <span>•</span>
                                <span>{new Date(doc.updated_at).toLocaleDateString()}</span>
                            </div>

                            <button
                                onClick={() => {
                                    if (doc.external_link) {
                                        window.open(doc.external_link, '_blank');
                                    } else {
                                        handleEdit(doc);
                                    }
                                }}
                                className="w-full py-2 bg-slate-50 dark:bg-slate-700/50 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 font-bold rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
                            >
                                {doc.external_link ? (
                                    <>
                                        {/* @ts-ignore */}
                                        <LinkIcon size={16} /> Open Link
                                    </>
                                ) : (
                                    <>Open Document</>
                                )}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
