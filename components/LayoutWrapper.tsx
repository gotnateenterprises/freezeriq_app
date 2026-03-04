"use client";

import { usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';

interface LayoutWrapperProps {
    children: React.ReactNode;
    hasSession: boolean;
}

export default function LayoutWrapper({ children, hasSession }: LayoutWrapperProps) {
    const pathname = usePathname();
    const isShopPage = pathname?.startsWith('/shop/');

    // Hide sidebar and remove margin for storefront pages
    const showSidebar = hasSession && !isShopPage;

    return (
        <div className="flex h-full print:block print:h-auto w-full max-w-[100vw]">
            {showSidebar && (
                <div className="print:hidden">
                    <Sidebar />
                </div>
            )}
            <main className={`p-4 md:p-8 h-full overflow-y-auto overflow-x-hidden ${showSidebar ? 'ml-0 md:ml-[280px] w-full md:w-[calc(100vw-280px)]' : 'ml-0 w-full'} print:ml-0 print:w-full print:p-0 print:h-auto print:overflow-visible transition-all duration-300 min-w-0`}>
                {children}
            </main>
        </div>
    );
}
