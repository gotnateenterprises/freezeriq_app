"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ChefHat, ShoppingCart, Truck, Settings, BookOpen, Package, Users, Megaphone, Printer, Calendar } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

const navItems = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Orders', href: '/orders', icon: Truck },
    { name: 'Bundles', href: '/bundles', icon: Package },
    { name: 'Production', href: '/production', icon: ChefHat },
    { name: 'Delivery', href: '/delivery', icon: Truck },
    { type: 'divider' },
    { name: 'Recipes', href: '/recipes', icon: BookOpen },
    { name: 'Inventory', href: '/commercial', icon: Package },
    { type: 'divider' },
    { name: 'CRM', href: '/customers', icon: Users },
    { name: 'Campaigns', href: '/campaigns', icon: Megaphone },
    { name: 'Calendar', href: '/calendar', icon: Calendar },
    { type: 'divider' },
    { name: 'Labels', href: '/labels', icon: Printer },
    { name: 'Suppliers', href: '/suppliers', icon: Truck },
    { name: 'Training', href: '/training', icon: BookOpen },
    { name: 'Settings', href: '/settings', icon: Settings },
];

export default function Sidebar() {
    const pathname = usePathname();
    const [logo, setLogo] = useState<string | null>(null);
    const [appName, setAppName] = useState("FreezerIQ");
    const [showLogoInHeader, setShowLogoInHeader] = useState(false);
    const [activeRecipePath, setActiveRecipePath] = useState<string>('/recipes');

    useEffect(() => {
        // Poll for branding & active recipe
        const checkBranding = () => {
            const savedLogo = localStorage.getItem('kitchenLogo');
            if (savedLogo !== logo) setLogo(savedLogo);

            const savedName = localStorage.getItem('appName');
            if (savedName && savedName !== appName) setAppName(savedName);

            const savedHeaderLoc = localStorage.getItem('showLogoInHeader');
            const showHeader = savedHeaderLoc ? JSON.parse(savedHeaderLoc) : false;
            if (showHeader !== showLogoInHeader) setShowLogoInHeader(showHeader);

            // Check for active recipe draft
            const activeId = localStorage.getItem('active_recipe_id');
            const newPath = activeId ? `/recipes/${activeId}` : '/recipes';
            if (newPath !== activeRecipePath) setActiveRecipePath(newPath);
        };

        checkBranding();
        const interval = setInterval(checkBranding, 2000);
        return () => clearInterval(interval);
    }, [logo, appName, showLogoInHeader]);

    return (
        <aside className="w-[280px] h-screen fixed left-0 top-0 glass-sidebar z-50 flex flex-col transition-all duration-300 print:hidden dark:bg-slate-900/80 dark:border-slate-800">
            <div className="p-8 pb-4">
                <div className="flex items-center gap-3">
                    {/* Header Logo Option */}
                    {showLogoInHeader && logo && (
                        <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700">
                            <img src={logo} alt="Header Logo" className="w-full h-full object-cover" />
                        </div>
                    )}
                    <div>
                        <h1 className="text-2xl font-black bg-gradient-to-r from-indigo-600 to-violet-600 dark:from-indigo-400 dark:to-violet-400 text-transparent bg-clip-text tracking-tight truncate max-w-[180px]">
                            {appName}
                        </h1>
                        <p className="text-slate-400 text-xs mt-1 font-medium tracking-wide uppercase">Kitchen OS v2.0</p>
                    </div>
                </div>
            </div>

            <nav className="flex-1 px-4 flex flex-col gap-3 mt-6 overflow-y-auto no-scrollbar">
                {navItems.map((item, index) => {
                    if ('type' in item && item.type === 'divider') {
                        return (
                            <div key={`divider-${index}`} className="my-3 px-4">
                                <div className="h-px bg-slate-200 dark:bg-slate-700 w-full opacity-100" />
                            </div>
                        );
                    }

                    const navItem = item as { name: string; href: string; icon: any };
                    const Icon = navItem.icon;
                    const href = navItem.name === 'Recipes' ? activeRecipePath : navItem.href;
                    const isActive = pathname === href || (navItem.name === 'Recipes' && pathname.startsWith('/recipes'));

                    return (
                        <Link
                            key={navItem.href}
                            href={href}
                            className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group font-medium text-sm ${isActive
                                ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-lg shadow-indigo-500/20'
                                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-indigo-600 dark:hover:text-indigo-400'
                                }`}
                        >
                            <Icon size={20} strokeWidth={isActive ? 2.5 : 2} className={`transition-colors ${isActive ? 'text-white' : 'text-slate-400 dark:text-slate-500 group-hover:text-indigo-500 dark:group-hover:text-indigo-400'}`} />
                            <span className="tracking-wide">
                                {navItem.name}
                                {navItem.name === 'Recipes' && activeRecipePath !== '/recipes' && (
                                    <span className="ml-2 text-[10px] bg-white/20 px-1.5 py-0.5 rounded-full uppercase font-black">Draft</span>
                                )}
                            </span>
                        </Link>
                    );
                })}
            </nav>

            <div className="p-4 border-t border-slate-100/50 dark:border-slate-800/50">
                <div className="flex items-center justify-between gap-2 px-2">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center overflow-hidden border border-slate-200 dark:border-slate-700 shadow-sm">
                            {logo ? (
                                <img src={logo} alt="Kitchen Logo" className="w-full h-full object-cover" />
                            ) : (
                                <div className="w-full h-full bg-gradient-to-tr from-indigo-500 to-violet-500 flex items-center justify-center text-xs font-bold text-white">
                                    CK
                                </div>
                            )}
                        </div>
                        <div>
                            <p className="text-sm font-bold text-slate-800 dark:text-slate-200">Head Chef</p>
                            <p className="text-xs text-slate-400 font-medium">Kitchen Admin</p>
                        </div>
                    </div>
                    <ThemeToggle />
                </div>
            </div>
        </aside >
    );
}
