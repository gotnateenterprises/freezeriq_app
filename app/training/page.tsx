"use client";

import { useState } from 'react';
import { ChevronDown, ChevronUp, FileText, PlayCircle, BookOpen, ExternalLink, Download } from 'lucide-react';
import Link from 'next/link';

// Mock Data
const FAQS = [
    {
        q: "How do I print labels for a new order?",
        a: "Go to the Delivery tab, click 'Print Labels', select your bundle size, and hit Print. Make sure your printer is set to 4x6 label size."
    },
    {
        q: "Can I use the Production Calculator offline?",
        a: "No, the calculator requires an internet connection to fetch real-time inventory and save your plans to the database."
    },
    {
        q: "How do I add a new supplier?",
        a: "Navigate to the Suppliers tab, click the '+ Add Supplier' button in the top right, and fill in their contact details."
    }
];

const SOPS = [
    { title: "Kitchen Opening Checklist", category: "Daily Ops", size: "1.2 MB" },
    { title: "Box Packing Standards", category: "Delivery", size: "3.4 MB" },
    { title: "Sanitation Guidelines", category: "Daily Ops", size: "0.8 MB" },
    { title: "Updating Inventory Manual", category: "Admin", size: "5.1 MB" },
];

const VIDEOS = [
    { title: "App Overview: Getting Started", duration: "5:20", thumbnail: "bg-indigo-100" },
    { title: "How to run a Production Plan", duration: "12:45", thumbnail: "bg-amber-100" },
    { title: "Printing Labels Tutorial", duration: "3:10", thumbnail: "bg-emerald-100" },
];

export default function TrainingHub() {
    const [openFaq, setOpenFaq] = useState<number | null>(0);

    return (
        <div className="max-w-6xl mx-auto p-4 md:p-8">
            <div className="mb-8">
                <h1 className="text-3xl font-black text-slate-900 dark:text-white flex items-center gap-3">
                    <BookOpen className="text-indigo-600" />
                    Training Hub
                </h1>
                <p className="text-slate-500 font-medium">Resources, guides, and tutorials for the team.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* Main Content (Videos & SOPs) */}
                <div className="lg:col-span-2 space-y-8">

                    {/* Video Section */}
                    <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
                        <h2 className="text-xl font-bold flex items-center gap-2 mb-4">
                            <PlayCircle className="text-rose-500" /> Video Tutorials
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {VIDEOS.map((video, i) => (
                                <div key={i} className="group cursor-pointer">
                                    <div className={`aspect-video rounded-xl ${video.thumbnail} mb-3 flex items-center justify-center group-hover:opacity-90 transition-opacity relative overflow-hidden`}>
                                        <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                                            <PlayCircle className="text-slate-900 ml-1" />
                                        </div>
                                        <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs font-bold px-2 py-1 rounded">
                                            {video.duration}
                                        </div>
                                    </div>
                                    <h3 className="font-bold text-slate-800 dark:text-gray-200 group-hover:text-indigo-600 transition-colors">{video.title}</h3>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* SOP Downloads */}
                    <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
                        <h2 className="text-xl font-bold flex items-center gap-2 mb-4">
                            <FileText className="text-indigo-600" /> Standard Operating Procedures (SOPs)
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {SOPS.map((sop, i) => (
                                <div key={i} className="flex items-center p-3 rounded-xl border border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors cursor-pointer group">
                                    <div className="w-10 h-10 bg-slate-100 dark:bg-slate-700 text-slate-500 rounded-lg flex items-center justify-center mr-3">
                                        <FileText size={20} />
                                    </div>
                                    <div className="flex-1">
                                        <div className="font-bold text-slate-700 dark:text-slate-200">{sop.title}</div>
                                        <div className="text-xs text-slate-400">{sop.category} • {sop.size}</div>
                                    </div>
                                    <Download size={18} className="text-slate-300 group-hover:text-indigo-600" />
                                </div>
                            ))}
                        </div>
                    </div>
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

                    <div className="bg-white dark:bg-slate-800 rounded-2xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm">
                        <h2 className="text-xl font-bold mb-4">Frequently Asked Questions</h2>
                        <div className="space-y-2">
                            {FAQS.map((faq, i) => (
                                <div key={i} className="border-b border-slate-100 dark:border-slate-700 last:border-0 pb-2 last:pb-0">
                                    <button
                                        className="w-full flex items-center justify-between text-left font-bold text-slate-700 dark:text-slate-300 py-2 hover:text-indigo-600"
                                        onClick={() => setOpenFaq(openFaq === i ? null : i)}
                                    >
                                        {faq.q}
                                        {openFaq === i ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                                    </button>
                                    {openFaq === i && (
                                        <div className="text-sm text-slate-500 pb-2 leading-relaxed animate-in fade-in slide-in-from-top-1">
                                            {faq.a}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}
