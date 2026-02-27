"use client";

import { useState, useEffect } from 'react';
import { X, Send, Loader2, MessageSquare } from 'lucide-react';

interface SmsComposeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSend: (message: string) => Promise<void>;
    initialMessage: string;
    recipientPhoneNumbers: string;
}

export default function SmsComposeModal({ isOpen, onClose, onSend, initialMessage, recipientPhoneNumbers }: SmsComposeModalProps) {
    const [body, setBody] = useState(initialMessage);
    const [isSending, setIsSending] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setBody(initialMessage);
        }
    }, [isOpen, initialMessage]);

    if (!isOpen) return null;

    const handleSend = async () => {
        setIsSending(true);
        try {
            await onSend(body);
            onClose();
        } catch (e) {
            // Error handled by parent usually, but we stop loading
        } finally {
            setIsSending(false);
        }
    };

    // Calculate approximate segment count (simplified 160 chars per segment)
    const segmentCount = Math.ceil(body.length / 160) || 1;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-slate-100 dark:border-slate-800">
                    <div>
                        <h3 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            <MessageSquare size={20} className="text-emerald-500" />
                            Compose Text Message
                        </h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">To: <span className="font-mono text-emerald-600 dark:text-emerald-400">{recipientPhoneNumbers}</span></p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">
                        <X size={20} className="text-slate-400" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-6 overflow-y-auto space-y-4 flex-1">
                    <div className="flex-1 flex flex-col">
                        <div className="flex justify-between items-end mb-1.5">
                            <label className="block text-xs font-bold uppercase text-slate-400">Message Body</label>
                            <span className={`text-xs font-bold ${body.length > 160 ? 'text-amber-500' : 'text-slate-400'}`}>
                                {body.length} chars ({segmentCount} segment{segmentCount !== 1 ? 's' : ''})
                            </span>
                        </div>
                        <textarea
                            value={body}
                            onChange={e => setBody(e.target.value)}
                            className="w-full min-h-[150px] px-4 py-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-200 text-sm leading-relaxed focus:ring-2 focus:ring-emerald-500 focus:outline-none transition-all resize-none"
                            placeholder="Type your SMS message here..."
                        />
                        <p className="text-xs text-slate-400 mt-2">✨ Tip: Keep text messages short and always include a link to your shop.</p>
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
                        disabled={isSending || body.trim().length === 0}
                        className="px-8 py-2.5 rounded-xl font-bold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors flex items-center gap-2 disabled:opacity-70 disabled:cursor-wait shadow-lg shadow-emerald-500/20"
                    >
                        {isSending ? (
                            <>
                                <Loader2 size={18} className="animate-spin" />
                                Sending...
                            </>
                        ) : (
                            <>
                                <Send size={18} />
                                Send Text
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
