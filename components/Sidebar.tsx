"use client";

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { useRouter, usePathname } from 'next/navigation';
import {
    LayoutDashboard,
    ShoppingCart,
    UtensilsCrossed,
    BookOpen,
    Settings,
    Calendar,
    Users,
    ChevronLeft,
    ChevronRight,
    LogOut,
    Tag,
    Truck,
    ShieldCheck,
    Globe,
    Package,
    ChefHat,
    Megaphone,
    Printer,
    Palette,
    FileText,
    Sparkles,
    ExternalLink
} from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import TenantSwitcher from './admin/TenantSwitcher';

const navItems = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Orders', href: '/orders', icon: Truck },
    { name: 'Production', href: '/production', icon: ChefHat },
    { name: 'Delivery', href: '/delivery', icon: Truck },
    { type: 'divider' },
    { name: 'Recipes', href: '/recipes', icon: BookOpen },
    { name: 'Bundles', href: '/bundles', icon: Package },
    { name: 'Inventory', href: '/commercial', icon: Package },
    { type: 'divider' },
    { name: 'Customer CRM', href: '/customers', icon: Users, requiredPlan: 'ENTERPRISE' },
    { name: 'Fundraiser CRM', href: '/fundraisers', icon: Megaphone, requiredPlan: 'ENTERPRISE' },
    { name: 'Marketing', href: '/campaigns', icon: Sparkles, requiredPlan: 'ENTERPRISE' },
    { name: 'Invoices', href: '/invoices', icon: FileText, requiredPlan: 'ENTERPRISE' },
    { name: 'Calendar', href: '/calendar', icon: Calendar },
    { type: 'divider' },
    { name: 'Labels', href: '/labels', icon: Printer },

    { name: 'Suppliers', href: '/suppliers', icon: Truck },
    { name: 'Team', href: '/settings/team', icon: Users },
    { name: 'Training', href: '/training', icon: BookOpen },

    // Admin Section
    { name: 'System Settings', href: '/settings', icon: Settings, requiredRole: 'ADMIN' },
    { name: 'Storefront', href: '/settings/storefront', icon: Palette, requiredRole: 'ADMIN' },

    // Platform Admin Group
    { type: 'divider' },
    { name: 'Platform Admin', href: '/admin/tenants', icon: ShieldCheck, is_super_admin: true },
    { name: 'Global Suppliers', href: '/admin/suppliers', icon: Globe, is_super_admin: true },
    { name: 'Training Resources', href: '/admin/training', icon: BookOpen, is_super_admin: true },
];

export default function Sidebar() {
    const pathname = usePathname();
    const [logo, setLogo] = useState<string | null>(() => {
        if (typeof window !== 'undefined') return localStorage.getItem('kitchenLogo');
        return null;
    });
    const [appName, setAppName] = useState(() => {
        if (typeof window !== 'undefined') return localStorage.getItem('appName') || 'FreezerIQ';
        return 'FreezerIQ';
    });
    const [businessSlug, setBusinessSlug] = useState<string | null>(null);
    const [showLogoInHeader, setShowLogoInHeader] = useState(false);


    useEffect(() => {
        // Poll for branding & active recipe
        const checkBranding = async () => {
            if (document.hidden) return;

            // Fetch latest branding from API
            try {
                const res = await fetch('/api/tenant/branding');
                if (res.ok) {
                    const data = await res.json();

                    // Update Logo
                    if (data.logo_url && data.logo_url !== logo) {
                        setLogo(data.logo_url);
                        localStorage.setItem('kitchenLogo', data.logo_url);
                    }

                    // Update App Name
                    // Prefer business_name from branding, fallback to default "FreezerIQ"
                    const newName = data.business_name || "FreezerIQ";
                    if (newName !== appName) {
                        setAppName(newName);
                        localStorage.setItem('appName', newName); // Persist for next load
                    }

                    if (data.business_slug) {
                        setBusinessSlug(data.business_slug);
                    }
                }
            } catch (e) {
                console.error("Failed to fetch branding", e);
            }

            const savedHeaderLoc = localStorage.getItem('showLogoInHeader');
            const showHeader = savedHeaderLoc ? JSON.parse(savedHeaderLoc) : false;
            if (showHeader !== showLogoInHeader) setShowLogoInHeader(showHeader);

        };

        checkBranding();
        // Polling interval for updates
        const interval = setInterval(checkBranding, 5000);

        return () => clearInterval(interval);
    }, [logo, appName, showLogoInHeader]);

    const { data: session, status } = useSession();

    // Wait for session to be ready to avoid "flicker" of missing items
    if (status === 'loading') {
        return (
            <aside className="w-[280px] h-screen fixed left-0 top-0 glass-sidebar z-50 flex flex-col transition-all duration-300 print:hidden dark:bg-slate-900/80 dark:border-slate-800">
                <div className="p-8 pb-4 animate-pulse">
                    <div className="flex items-center gap-3">
                        <div className="w-14 h-14 bg-slate-200 dark:bg-slate-800 rounded-xl" />
                        <div className="space-y-2">
                            <div className="h-4 w-24 bg-slate-200 dark:bg-slate-800 rounded" />
                            <div className="h-3 w-16 bg-slate-200 dark:bg-slate-800 rounded" />
                        </div>
                    </div>
                </div>
            </aside>
        );
    }

    // Prefer session data for branding, UNLESS local appName has been updated by Tenant Branding
    // businessLogo was removed from session token (too large for cookie), so rely on API state
    const displayLogo = logo || '/images/placeholder-logo.png';
    // Fix: Strictly use local state `appName` which is managed by the effect.
    // Initial state is "FreezerIQ", but effect will update it from localStorage/API immediately.
    // If session has a business name, we could use it as initial state, but `useEffect` is safer source of truth.
    const displayAppName = appName;
    const planName = (session?.user as any)?.plan || 'BASE';

    // ... (getPlanDisplay logic removed as it is replaced)

    const [resumeRecipeId, setResumeRecipeId] = useState<string | null>(null);

    useEffect(() => {
        // Check for active recipe to allow resuming
        const checkResume = () => {
            const activeId = localStorage.getItem('active_recipe_id');
            if (activeId && activeId !== 'new') {
                setResumeRecipeId(activeId);
            } else {
                setResumeRecipeId(null);
            }
        };
        checkResume();
        // Poll for updates (e.g. if I open a recipe in another tab)
        const interval = setInterval(checkResume, 2000);
        return () => clearInterval(interval);
    }, []);

    const formatBrandName = (name: string) => {
        if (!name) return name;
        const normalized = name.trim().replace(/\s/g, '').replace(/™/g, '').toLowerCase();
        if (normalized === 'freezeriq') {
            return (
                <span className="flex items-baseline">
                    <span className="bg-gradient-to-r from-indigo-600 to-violet-600 dark:from-indigo-400 dark:to-violet-400 text-transparent bg-clip-text">
                        FreezerIQ
                    </span>
                    <span className="text-indigo-600 dark:text-indigo-400 text-[0.7em] ml-px self-start mt-0.5 font-black leading-none drop-shadow-sm">
                        ™
                    </span>
                </span>
            );
        }
        return name;
    };

    return (
        <aside className="w-[280px] h-screen fixed left-0 top-0 glass-sidebar z-50 flex flex-col transition-all duration-300 print:hidden dark:bg-slate-900/80 dark:border-slate-800">
            <div className="p-8 pb-4">
                <div className="flex items-center gap-3">
                    {/* Header Logo Option - Always show if businessLogo exists, otherwise follow setting */}
                    {(displayLogo) && (
                        <Link
                            href={businessSlug ? `/shop/${businessSlug}` : '#'}
                            target="_blank"
                            className="w-14 h-14 rounded-xl overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700 bg-white shadow-sm hover:scale-105 transition-transform"
                        >
                            <img
                                src={displayLogo}
                                alt="Header Logo"
                                className="w-full h-full object-contain p-1"
                                onError={(e) => {
                                    const target = e.target as HTMLImageElement;
                                    target.src = '/images/placeholder-logo.png';
                                    target.onerror = null; // Prevent infinite loop
                                }}
                            />
                        </Link>
                    )}
                    <div>
                        <div className="flex items-center gap-2">
                            <h1 className={`${displayAppName.length > 15 ? 'text-lg' : displayAppName.length > 10 ? 'text-xl' : 'text-2xl'} font-black tracking-tight whitespace-nowrap overflow-hidden text-ellipsis max-w-[190px]`}>
                                {formatBrandName(displayAppName)}
                            </h1>
                            {businessSlug && (
                                <Link
                                    href={`/shop/${businessSlug}`}
                                    target="_blank"
                                    className="p-1 px-1.5 bg-slate-100 dark:bg-slate-800 rounded-md text-slate-400 hover:text-indigo-600 transition-colors"
                                    title="Visit Shop"
                                >
                                    <ExternalLink size={12} />
                                </Link>
                            )}
                        </div>
                        <div className="flex flex-col mt-0.5 opacity-90">
                            <span className="text-slate-400 text-[8px] font-black tracking-wider uppercase leading-none">
                                Powered by:
                            </span>
                            <span className="flex items-baseline -mt-0.5">
                                <span className="bg-gradient-to-r from-indigo-600 to-violet-600 dark:from-indigo-400 dark:to-violet-400 text-transparent bg-clip-text text-[14px] font-black tracking-tighter">
                                    FreezerIQ
                                </span>
                                <span className="text-indigo-600 dark:text-indigo-400 text-[8px] ml-px self-start mt-0.5 font-black leading-none drop-shadow-sm">
                                    ™
                                </span>
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <TenantSwitcher />

            <nav className="flex-1 px-4 flex flex-col gap-3 mt-6 overflow-y-auto no-scrollbar">
                {navItems.map((item, index) => {
                    const navItem = item as { name: string; href: string; icon: any; is_super_admin?: boolean; requiredPlan?: string; requiredRole?: string };

                    // Super Admin Gating
                    if (navItem.is_super_admin && !(session?.user as any)?.isSuperAdmin) {
                        return null;
                    }

                    // Role Gating
                    if (navItem.requiredRole && (session?.user as any)?.role !== navItem.requiredRole) {
                        return null;
                    }

                    // Plan Gating - Allow SuperAdmin bypass OR Free plan (which serves as Enterprise Trial/Comp)
                    const isSuperAdmin = (session?.user as any)?.isSuperAdmin;
                    const userPlan = (session?.user as any)?.plan;

                    if (navItem.requiredPlan) {
                        const planHierarchy: Record<string, number> = { 'BASE': 0, 'PRO': 1, 'ENTERPRISE': 2, 'ULTIMATE': 3, 'FREE': 4 };
                        const userPlanLevel = planHierarchy[userPlan] || 0;
                        const requiredLevel = planHierarchy[navItem.requiredPlan] || 0;

                        if (userPlanLevel < requiredLevel && !isSuperAdmin && userPlan !== 'FREE') {
                            return null;
                        }
                    }

                    if ('type' in item && item.type === 'divider') {
                        return (
                            <div key={`divider-${index}`} className="my-3 px-4">
                                <div className="h-0.5 bg-slate-200 dark:bg-slate-700 w-full opacity-100" />
                            </div>
                        );
                    }

                    const Icon = navItem.icon;
                    const href = navItem.href;
                    const isActive = pathname === href || (navItem.name === 'Recipes' && pathname.startsWith('/recipes'));

                    return (
                        <Fragment key={navItem.href}>
                            <Link
                                href={href}
                                className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group font-medium text-sm ${isActive
                                    ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-lg shadow-indigo-500/20'
                                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-indigo-600 dark:hover:text-indigo-400'
                                    }`}
                            >
                                <Icon size={20} strokeWidth={isActive ? 2.5 : 2} className={`transition-colors ${isActive ? 'text-white' : 'text-slate-400 dark:text-slate-500 group-hover:text-indigo-500 dark:group-hover:text-indigo-400'}`} />
                                <span className="tracking-wide">{navItem.name}</span>
                            </Link>
                            {navItem.name === 'Recipes' && resumeRecipeId && (
                                <Link
                                    key="resume-recipe"
                                    href={`/recipes/${resumeRecipeId}`}
                                    className={`flex items-center gap-3 px-4 py-2 ml-4 mt-1 rounded-xl transition-all duration-200 group font-medium text-xs text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800/50`}
                                >
                                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                    <span className="tracking-wide">Resume Recipe</span>
                                </Link>
                            )}
                        </Fragment>
                    );
                })}
            </nav>

            <div className="shrink-0 pt-4 border-t border-slate-100 dark:border-slate-800">
                <UserProfileSection />
            </div>
        </aside >
    );
}

function UserProfileSection() {
    const { data: session, status } = useSession();
    const router = useRouter(); // Import useRouter
    const [isOpen, setIsOpen] = useState(false);

    // Close on click outside could be added here, but for simplicity:
    useEffect(() => {
        const close = () => setIsOpen(false);
        if (isOpen) window.addEventListener('click', close);
        return () => window.removeEventListener('click', close);
    }, [isOpen]);

    if (!session) return null; // Or a loading skeleton

    return (
        <div className="relative" onClick={(e) => e.stopPropagation()}>
            {isOpen && (
                <div className="absolute bottom-full left-0 w-full mb-2 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
                    <Link
                        href="/settings"
                        onClick={() => setIsOpen(false)}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-700/50 text-sm font-medium text-slate-700 dark:text-slate-300 transition-colors"
                    >
                        <Settings size={16} />
                        Settings
                    </Link>
                    <button
                        onClick={() => signOut({ callbackUrl: '/login' })}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-rose-50 dark:hover:bg-rose-900/20 text-sm font-medium text-rose-600 dark:text-rose-400 transition-colors border-t border-slate-100 dark:border-slate-700/50"
                    >
                        <LogOut size={16} />
                        Sign Out
                    </button>
                </div>
            )}

            <div className="flex items-center justify-between gap-1 px-1">
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="flex-1 flex items-center gap-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 p-1.5 rounded-lg transition-colors outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer min-w-0"
                >
                    <div className="w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm shrink-0">
                        <div className="w-full h-full bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-base font-bold text-white">
                            {session.user?.name ? session.user.name.charAt(0).toUpperCase() : 'U'}
                        </div>
                    </div>
                    <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate">
                            {session.user?.name || 'User'}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate capitalize">
                            {session.user?.role?.toLowerCase() || 'Team Member'}
                        </p>
                    </div>
                </button>

                <div
                    onClick={() => window.location.href = '/settings'}
                    className="p-2 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded-lg transition-all cursor-pointer relative z-10"
                    title="Settings"
                >
                    <Settings size={20} />
                </div>

                <ThemeToggle />
            </div>
        </div>
    );
}
