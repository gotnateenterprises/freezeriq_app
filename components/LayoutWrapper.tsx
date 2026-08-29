"use client";

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import Sidebar from '@/components/Sidebar';

interface LayoutWrapperProps {
    children: React.ReactNode;
    hasSession: boolean;
}

export default function LayoutWrapper({ children, hasSession }: LayoutWrapperProps) {
    const pathname = usePathname();
    const isShopPage = pathname?.startsWith('/shop/');
    // FR-SHARE-COPY-1 mobile-overflow fix: the coordinator portal and the
    // public scoreboard are self-contained "edge to edge" shells (their own
    // sticky nav, their own max-w-xl mx-auto column) the same way storefront
    // pages are — but unlike storefront pages they never got the same
    // responsive padding exemption, so they stacked an UNCONDITIONAL 32px/side
    // wrapper padding on top of their own page-level padding, well past what
    // a phone viewport can spare. Sidebar visibility is intentionally NOT
    // widened by this — showSidebar below still keys off isShopPage alone.
    const isEdgeToEdgePage = isShopPage || pathname?.startsWith('/coordinator/') || pathname?.startsWith('/fundraiser/');

    // Hide sidebar and remove margin for storefront pages
    const showSidebar = hasSession && !isShopPage;

    // Off-canvas sidebar state, used below the `lg` breakpoint only. At `lg`
    // and above the sidebar stays persistent and this state has no effect.
    const [sidebarOpen, setSidebarOpen] = useState(false);

    // Selecting a nav destination should close the drawer rather than leave
    // it open over the newly-loaded page.
    useEffect(() => {
        setSidebarOpen(false);
    }, [pathname]);

    // Escape closes the drawer, consistent with dismiss behavior elsewhere
    // in the app.
    useEffect(() => {
        if (!sidebarOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSidebarOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [sidebarOpen]);

    return (
        <div className="flex h-full print:block print:h-auto w-full">
            {showSidebar && (
                <div className="print:hidden">
                    <button
                        type="button"
                        onClick={() => setSidebarOpen(true)}
                        aria-label="Open navigation menu"
                        className={`fixed top-4 left-4 z-30 w-11 h-11 items-center justify-center rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg text-slate-600 dark:text-slate-300 lg:hidden ${sidebarOpen ? 'hidden' : 'flex'}`}
                    >
                        <Menu size={20} />
                    </button>

                    {sidebarOpen && (
                        <div
                            className="lg:hidden fixed inset-0 bg-slate-900/50 z-40"
                            onClick={() => setSidebarOpen(false)}
                            aria-hidden="true"
                        />
                    )}

                    <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
                </div>
            )}
            {/* MOBILE-LAYOUT-FIX-2 — `min-w-0` is load-bearing, do not remove.
                This <main> is a FLEX ITEM (the row above is `flex`). Per the
                Flexbox spec a flex item's default `min-width: auto` resolves to
                its MIN-CONTENT width, so <main> refused to shrink below the
                widest unbreakable thing on the page and expanded past the
                viewport — measured at 647px on a 412px phone, i.e. 235px of the
                page pushed off-screen. `overflow-x-clip` below then DELETED
                those pixels instead of revealing them, which is why
                `scrollWidth <= clientWidth` kept passing in automated checks
                while real phones stayed broken. min-w-0 restores the viewport
                as the real constraint, which is what finally lets the
                ellipsis/wrap guards already present on the inner elements
                actually engage. */}
            <main className={`flex-1 min-w-0 ${!isEdgeToEdgePage ? 'h-full overflow-y-auto p-8' : 'min-h-screen p-4 sm:p-8'} overflow-x-clip ${showSidebar ? 'pt-20 lg:pt-8 lg:ml-[280px]' : 'ml-0'} print:ml-0 print:p-0 print:h-auto print:overflow-visible transition-all duration-300`}>
                {children}
            </main>
        </div>
    );
}
