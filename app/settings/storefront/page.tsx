"use client";

import BrandingSettings from '@/components/admin/BrandingSettings';
import StorefrontSettings from '@/components/admin/StorefrontSettings';
import { Palette, ExternalLink, ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';

export default function StorefrontSettingsPage() {
    const { data: session } = useSession();

    return (
        <div className="p-6 max-w-6xl mx-auto pb-32 space-y-8">
            {/* Header */}
            <div className="flex flex-col gap-2">
                <Link
                    href="/settings"
                    className="flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors text-xs font-bold uppercase tracking-wider w-fit"
                >
                    <ChevronLeft size={14} />
                    Back to Settings
                </Link>
                <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                    <div className="flex items-center gap-4">
                        <div className="w-16 h-16 bg-white dark:bg-slate-800 rounded-2xl border-2 border-indigo-100 dark:border-indigo-900/50 flex items-center justify-center shadow-xl shadow-indigo-100/50 dark:shadow-none animate-in fade-in slide-in-from-left duration-500">
                            <Palette size={32} className="text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <div>
                            <h1 className="text-4xl font-black text-slate-900 dark:text-white tracking-tight">Storefront</h1>
                            <p className="text-slate-500 dark:text-slate-400 mt-1 text-lg">Manage your public brand identity and shop configuration.</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Content Sections */}
            <div className="grid grid-cols-1 gap-8">
                <BrandingSettings isSuperAdmin={session?.user?.isSuperAdmin} />
                <StorefrontSettings />
            </div>

            {/* Help/Tips */}
            <div className="p-6 bg-indigo-50 dark:bg-indigo-900/20 rounded-3xl border border-indigo-100 dark:border-indigo-800/50">
                <h4 className="text-sm font-bold text-indigo-900 dark:text-indigo-300 flex items-center gap-2 mb-2">
                    <Palette size={16} />
                    Pro Tip: Visual Consistency
                </h4>
                <p className="text-xs text-indigo-700/80 dark:text-indigo-400/80 leading-relaxed">
                    Ensure your primary brand color has enough contrast for readability. These settings affect your public storefront, packing slips, and customer emails.
                </p>
            </div>
        </div>
    );
}
