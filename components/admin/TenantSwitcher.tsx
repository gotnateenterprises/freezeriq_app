
"use client";

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { Building2, ChevronDown, Check, Loader2, LogOut } from 'lucide-react';

export default function TenantSwitcher() {
    const { data: session, update } = useSession();
    const [businesses, setBusinesses] = useState<any[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    useEffect(() => {
        const fetchBusinesses = async () => {
            try {
                const res = await fetch('/api/admin/switch-tenant');
                if (res.ok) {
                    const data = await res.json();
                    setBusinesses(data);
                }
            } catch (e) {
                console.error("Failed to fetch businesses", e);
            }
        };

        if ((session?.user as any)?.isSuperAdmin) {
            fetchBusinesses();
        }
    }, [session]);

    if (!(session?.user as any)?.isSuperAdmin) return null;

    const currentBusinessId = (session?.user as any)?.businessId;
    const currentBusiness = businesses.find(b => b.id === currentBusinessId) || { name: (session?.user as any)?.businessName || 'Platform' };
    const isViewingAsTenant = !!(session?.user as any)?.isViewingAsTenant;
    const baseBusinessName = (session?.user as any)?.baseBusinessName;

    const handleSwitch = async (business: any) => {
        if (business.id === currentBusinessId) return;

        setIsLoading(true);
        try {
            // The server validates the target exists and returns its REAL
            // display values; we relay those rather than inventing any.
            const res = await fetch('/api/admin/switch-tenant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ businessId: business.id })
            });

            if (res.ok) {
                const { grant } = await res.json();

                // SEC-TENANT-1 — we relay the server's SIGNED grant, not a set of
                // loose fields. The browser cannot compose, tamper with, or
                // partially apply it: the target id and the tenant's real name and
                // plan are all inside one signature, and a bare `businessId` or
                // `viewAsBusinessId` in this payload would be ignored.
                await update({ viewAsGrant: grant });

                // Force a redirect to dashboard to refresh all data & branding
                window.location.href = '/';
            }
        } catch (e) {
            console.error("Switch failed", e);
        } finally {
            setIsLoading(false);
            setIsMenuOpen(false);
        }
    };

    const handleExit = async () => {
        setIsLoading(true);
        try {
            await update({ exitViewAs: true });
            window.location.href = '/';
        } catch (e) {
            console.error("Exit failed", e);
        } finally {
            setIsLoading(false);
            setIsMenuOpen(false);
        }
    };

    return (
        <div className="relative px-4 pb-4 border-b border-slate-200 dark:border-slate-800 mb-4 h-[60px]">
            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1 block px-1">
                Super Admin: View As
            </label>
            <button
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                disabled={isLoading}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl hover:border-indigo-500 dark:hover:border-indigo-400 transition-all text-sm font-bold shadow-sm"
            >
                <div className="flex items-center gap-2 truncate">
                    {isLoading ? <Loader2 size={16} className="animate-spin text-indigo-500" /> : <Building2 size={16} className="text-indigo-500" />}
                    <span className="truncate">{currentBusiness.name}</span>
                </div>
                <ChevronDown size={14} className={`transition-transform duration-200 ${isMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {isMenuOpen && (
                <div className="absolute top-full left-4 right-4 mt-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 py-2 max-h-[300px] overflow-y-auto no-scrollbar animate-in fade-in slide-in-from-top-2 duration-200">
                    {isViewingAsTenant && (
                        <button
                            onClick={handleExit}
                            className="w-full flex items-center gap-2 px-4 py-2 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 border-b border-slate-100 dark:border-slate-700 mb-1"
                        >
                            <LogOut size={14} />
                            <span className="truncate">Return to {baseBusinessName || 'my account'}</span>
                        </button>
                    )}
                    {businesses.map((b) => (
                        <button
                            key={b.id}
                            onClick={() => handleSwitch(b)}
                            className={`w-full flex items-center justify-between px-4 py-2 text-sm transition-colors ${b.id === currentBusinessId
                                ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 font-black'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 font-medium'
                                }`}
                        >
                            <span className="truncate">{b.name}</span>
                            {b.id === currentBusinessId && <Check size={14} />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
