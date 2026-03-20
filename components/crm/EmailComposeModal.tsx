"use client";

import { useState, useEffect } from 'react';
import { X, Send, Loader2 } from 'lucide-react';

interface EmailComposeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSend: (subject: string, html: string, attachments: any[]) => Promise<void>;
    initialSubject: string;
    initialHtml: string;
    recipientEmail: string;
    initialAttachments?: { filename: string; content: string }[];
}

export default function EmailComposeModal({ isOpen, onClose, onSend, initialSubject, initialHtml, recipientEmail, initialAttachments }: EmailComposeModalProps) {
    const [subject, setSubject] = useState(initialSubject);
    const [body, setBody] = useState(initialHtml);
    const [attachments, setAttachments] = useState<{ filename: string; content: string }[]>([]);
    const [isSending, setIsSending] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setSubject(initialSubject);
            setBody(initialHtml);
            setAttachments(initialAttachments || []);
        }
    }, [isOpen, initialSubject, initialHtml, initialAttachments]);

    if (!isOpen) return null;

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const files = Array.from(e.target.files);
            const newAttachments: { filename: string; content: string }[] = [];

            for (const file of files) {
                const reader = new FileReader();
                reader.readAsDataURL(file);
                await new Promise<void>((resolve) => {
                    reader.onload = () => {
                        const result = reader.result as string;
                        // Remove Data URL prefix (e.g., "data:application/pdf;base64,")
                        const content = result.split(',')[1];
                        newAttachments.push({
                            filename: file.name,
                            content: content
                        });
                        resolve();
                    };
                });
            }
            setAttachments([...attachments, ...newAttachments]);
        }
    };

    const removeAttachment = (index: number) => {
        setAttachments(attachments.filter((_, i) => i !== index));
    };

    const handlePreviewAttachment = (file: { filename: string; content: string; contentType?: string }) => {
        try {
            const byteCharacters = atob(file.content);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const mimeType = file.contentType
                || (file.filename.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                : file.filename.endsWith('.pdf') ? 'application/pdf'
                : 'application/octet-stream');
            const blob = new Blob([byteArray], { type: mimeType });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            // Clean up URL after some time
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (e) {
            console.error('Preview error:', e);
            alert('Could not preview this attachment');
        }
    };

    const handleSend = async () => {
        setIsSending(true);
        try {
            await onSend(subject, body, attachments);
            onClose();
        } catch (e) {
            // Error handled by parent usually, but we stop loading
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-slate-100 dark:border-slate-800">
                    <div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white">Compose Email</h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400">To: <span className="font-mono text-indigo-600 dark:text-indigo-400">{recipientEmail}</span></p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                        <X size={20} className="text-slate-400" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 overflow-y-auto space-y-4 flex-1">
                    <div>
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-1.5">Subject Line</label>
                        <input
                            value={subject}
                            onChange={e => setSubject(e.target.value)}
                            className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white font-medium focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all"
                            placeholder="Email Subject"
                        />
                    </div>

                    <div className="flex-1 flex flex-col">
                        <label className="block text-xs font-bold uppercase text-slate-400 mb-1.5">Email Body (HTML Supported)</label>
                        <textarea
                            value={body}
                            onChange={e => setBody(e.target.value)}
                            className="w-full min-h-[300px] px-4 py-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-200 font-mono text-sm leading-relaxed focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all resize-none"
                            placeholder="Write your email content here (HTML supported)..."
                        />
                        <p className="text-xs text-slate-400 mt-2">✨ Tip: You can edit the text inside the HTML tags. Be careful not to break the tags!</p>
                    </div>

                    {/* Attachments Section */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="block text-xs font-bold uppercase text-slate-400">Attachments</label>
                            <label className="cursor-pointer text-xs font-bold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 flex items-center gap-1">
                                + Add File
                                <input type="file" multiple className="hidden" onChange={handleFileChange} />
                            </label>
                        </div>

                        {attachments.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {attachments.map((file, idx) => (
                                    <div key={idx} className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700">
                                        <button
                                            onClick={() => handlePreviewAttachment(file)}
                                            className="text-xs font-bold text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 truncate max-w-[150px] underline decoration-dotted offset-2"
                                            title="Click to preview"
                                        >
                                            {file.filename}
                                        </button>
                                        <button onClick={() => removeAttachment(idx)} className="text-slate-400 hover:text-red-500 ml-1">
                                            <X size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-6 py-2.5 rounded-xl font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSend}
                        disabled={isSending}
                        className="px-8 py-2.5 rounded-xl font-bold bg-indigo-600 text-white hover:bg-indigo-700 transition-colors flex items-center gap-2 disabled:opacity-70 disabled:cursor-wait shadow-lg shadow-indigo-500/20"
                    >
                        {isSending ? (
                            <>
                                <Loader2 size={18} className="animate-spin" />
                                Sending...
                            </>
                        ) : (
                            <>
                                <Send size={18} />
                                Send Email
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
