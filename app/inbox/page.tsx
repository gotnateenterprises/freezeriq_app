"use client";

import { useEffect, useState, useRef, Suspense } from 'react';
import { useSession } from 'next-auth/react';
import { ChefHat, Search, Send, Clock, User, Facebook, Inbox as InboxIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

function InboxContent() {
    const { data: session } = useSession();
    const router = useRouter();
    const searchParams = useSearchParams();
    const initialThreadId = searchParams.get('thread');

    const [threads, setThreads] = useState<any[]>([]);
    const [activeThreadId, setActiveThreadId] = useState<string | null>(initialThreadId);
    const [isLoading, setIsLoading] = useState(true);

    const [replyText, setReplyText] = useState('');
    const [isSending, setIsSending] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const fetchInbox = async () => {
        try {
            const res = await fetch('/api/integrations/meta/inbox');
            if (res.ok) {
                const data = await res.json();
                setThreads(data.threads || []);

                // If there's no active thread but we have threads, select the first one
                if (!activeThreadId && !initialThreadId && data.threads?.length > 0) {
                    setActiveThreadId(data.threads[0].id);
                }
            }
        } catch (e) {
            console.error("Failed to fetch inbox", e);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchInbox();

        // Setup polling every 10 seconds for new messages
        const interval = setInterval(() => {
            fetchInbox();
        }, 10000);

        return () => clearInterval(interval);
    }, [activeThreadId]); // Re-run when active thread changes so it keeps it selected

    const activeThread = threads.find(t => t.id === activeThreadId);

    // Scroll to bottom when conversation changes or new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [activeThread?.messages]);

    const handleSend = async () => {
        if (!replyText.trim() || !activeThreadId) return;
        setIsSending(true);
        try {
            const lastMessage = activeThread?.messages?.[activeThread.messages.length - 1]; // for referencing if needed

            // We need to send recipientId (the Facebook senderId of the customer)
            // The activeThreadId should be the senderId.
            const recipientId = activeThreadId;

            const res = await fetch('/api/integrations/meta/reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recipientId: recipientId,
                    message: replyText,
                    activityId: lastMessage?.id // Mark last inbound message as replied
                })
            });
            if (res.ok) {
                setReplyText('');
                // Instantly fetch to show the new message
                fetchInbox();
            } else {
                const err = await res.json();
                alert(`Failed to send: ${err.error}`);
            }
        } catch (e) {
            alert("Failed to send reply");
        } finally {
            setIsSending(false);
        }
    };

    const formatTime = (isoString: string) => {
        const d = new Date(isoString);
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    };

    const formatDate = (isoString: string) => {
        const d = new Date(isoString);
        // If today, return Time. Else return Date.
        const today = new Date();
        if (d.toDateString() === today.toDateString()) {
            return formatTime(isoString);
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    if (isLoading) {
        return <div className="p-12 text-center text-slate-500 font-medium h-screen flex flex-col justify-center items-center">
            <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-4" />
            Loading Inbox...
        </div>;
    }

    return (
        <div className="h-[calc(100vh-6rem)] -mt-6 -mx-4 md:-mx-8 lg:-mx-12 overflow-hidden flex flex-col bg-slate-50 dark:bg-[#0B1120]">

            {/* Header */}
            <header className="h-16 px-6 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0 z-10 transition-colors">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-lg shadow-sm" style={{ fontFamily: 'sans-serif' }}>
                        f
                    </div>
                    <div>
                        <h1 className="text-lg font-black text-slate-900 dark:text-blue-200 tracking-tight leading-tight">Messenger Inbox</h1>
                        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">Freezer Chef Leads</p>
                    </div>
                </div>
                <Link href="/" className="px-4 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-lg text-sm font-bold transition-colors">
                    Back to Dashboard
                </Link>
            </header>

            {/* Split Screen Container */}
            <div className="flex-1 flex overflow-hidden">

                {/* Left Pane: Conversation List */}
                <div className={`w-full md:w-80 lg:w-96 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col shrink-0 ${activeThreadId ? 'hidden md:flex' : 'flex'}`}>
                    <div className="p-4 border-b border-slate-100 dark:border-slate-800/50">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                            <input
                                type="text"
                                placeholder="Search messages..."
                                className="w-full bg-slate-100 dark:bg-slate-800 border-none rounded-xl py-2 pl-10 pr-4 text-sm focus:ring-2 focus:ring-blue-500 text-slate-900 dark:text-slate-200 placeholder-slate-500"
                            />
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto no-scrollbar">
                        {threads.length === 0 ? (
                            <div className="p-8 text-center text-slate-500">
                                <InboxIcon className="mx-auto mb-3 opacity-20" size={48} />
                                <p className="font-medium text-sm">No conversations yet.</p>
                                <p className="text-xs mt-1">Connect Meta in Settings.</p>
                            </div>
                        ) : (
                            <div className="divide-y divide-slate-50 dark:divide-slate-800/50">
                                {threads.map(thread => {
                                    const latestMessage = thread.messages[thread.messages.length - 1];
                                    const isActive = activeThreadId === thread.id;
                                    return (
                                        <button
                                            key={thread.id}
                                            onClick={() => setActiveThreadId(thread.id)}
                                            className={`w-full text-left p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-start gap-3 relative ${isActive ? 'bg-blue-50/50 dark:bg-blue-900/20' : ''}`}
                                        >
                                            {isActive && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-600 rounded-r-md"></div>}
                                            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900/40 dark:to-indigo-900/40 flex items-center justify-center shrink-0 shadow-sm border border-white/50 dark:border-slate-700/50">
                                                <User className="text-blue-600 dark:text-blue-400" size={20} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex justify-between items-baseline mb-1">
                                                    <p className={`text-sm font-bold truncate ${thread.unread ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-200'}`}>
                                                        {thread.customerName}
                                                    </p>
                                                    <span className={`text-[10px] whitespace-nowrap ml-2 ${thread.unread ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-slate-500'}`}>
                                                        {latestMessage ? formatDate(latestMessage.timestamp) : ''}
                                                    </span>
                                                </div>
                                                <p className={`text-xs truncate ${thread.unread ? 'text-slate-800 dark:text-slate-300 font-semibold' : 'text-slate-500'}`}>
                                                    {latestMessage?.isOutbound ? 'You: ' : ''}{latestMessage?.content}
                                                </p>
                                            </div>
                                            {thread.unread && (
                                                <div className="w-2.5 h-2.5 bg-blue-600 rounded-full shrink-0 align-self-center mt-2" />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* Right Pane: Active Conversation */}
                <div className={`flex-1 flex flex-col bg-slate-50 dark:bg-[#0B1120] ${!activeThreadId ? 'hidden md:flex' : 'flex'}`}>
                    {!activeThread ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
                            <Facebook size={64} className="opacity-10 mb-4" />
                            <p className="font-bold text-lg dark:text-slate-500">Facebook Messenger</p>
                            <p className="text-sm font-medium">Select a conversation to start reading.</p>
                        </div>
                    ) : (
                        <>
                            {/* Chat Header (Mobile visual aid) */}
                            <div className="md:hidden p-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3 shadow-sm">
                                <button onClick={() => setActiveThreadId(null)} className="p-2 -ml-2 text-blue-600 font-bold text-sm">
                                    &larr; Back
                                </button>
                                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center"><User size={16} className="text-blue-600" /></div>
                                <h2 className="font-bold text-slate-900 dark:text-white">{activeThread.customerName}</h2>
                            </div>

                            {/* Messages Scroll Area */}
                            <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
                                {activeThread.messages.map((msg: any, idx: number) => {
                                    const showTime = idx === 0 || (new Date(msg.timestamp).getTime() - new Date(activeThread.messages[idx - 1].timestamp).getTime() > 1000 * 60 * 30); // 30 mins

                                    return (
                                        <div key={msg.id || idx} className="flex flex-col">
                                            {showTime && (
                                                <p className="text-center text-[10px] font-bold uppercase tracking-widest text-slate-400 my-4">
                                                    {formatDate(msg.timestamp)} {formatTime(msg.timestamp)}
                                                </p>
                                            )}
                                            <div className={`flex w-full ${msg.isOutbound ? 'justify-end' : 'justify-start'}`}>
                                                {!msg.isOutbound && (
                                                    <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-800 flex items-center justify-center shrink-0 mr-2 mt-auto">
                                                        <User className="text-slate-500" size={14} />
                                                    </div>
                                                )}
                                                <div className={`max-w-[75%] md:max-w-[60%] rounded-2xl px-5 py-3 shadow-sm ${msg.isOutbound
                                                    ? 'bg-blue-600 text-white rounded-br-sm'
                                                    : 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-100 dark:border-slate-700/50 rounded-bl-sm'
                                                    }`}>
                                                    <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                                <div ref={messagesEndRef} />
                            </div>

                            {/* Input Area */}
                            <div className="p-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 shrink-0 shadow-[0_-10px_40px_rgba(0,0,0,0.03)] dark:shadow-none z-10">
                                <div className="flex items-end gap-2 bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-2 border border-slate-200 dark:border-slate-700/50 relative">
                                    <textarea
                                        value={replyText}
                                        onChange={(e) => setReplyText(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleSend();
                                            }
                                        }}
                                        placeholder="Type a message..."
                                        className="w-full bg-transparent border-none focus:ring-0 resize-none max-h-32 min-h-[44px] py-3 px-3 text-slate-900 dark:text-slate-100 placeholder-slate-400 text-[15px]"
                                    />
                                    <button
                                        onClick={handleSend}
                                        disabled={isSending || !replyText.trim()}
                                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all ${replyText.trim() ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-md' : 'bg-slate-200 dark:bg-slate-800 text-slate-400'
                                            }`}
                                    >
                                        {isSending ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send size={18} className="translate-x-[-1px] translate-y-[1px]" />}
                                    </button>
                                </div>
                                <p className="text-center text-[10px] font-medium text-slate-400 dark:text-slate-500 mt-2">
                                    Press Enter to send. Shift + Enter for new line. Connected to Meta.
                                </p>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function InboxPage() {
    return (
        <Suspense fallback={<div className="p-12 text-center text-slate-500">Loading...</div>}>
            <InboxContent />
        </Suspense>
    );
}
