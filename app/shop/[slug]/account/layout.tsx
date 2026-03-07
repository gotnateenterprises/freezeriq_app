import { redirect } from 'next/navigation';
import { getCustomerSession } from '@/lib/customerAuth';
import { prisma } from '@/lib/db';
import Link from 'next/link';
import { Store, User, LogOut, Package, CreditCard } from 'lucide-react';
// @ts-ignore
import { LogoutButton } from './LogoutButton';

export default async function CustomerAccountLayout({
    children,
    params
}: {
    children: React.ReactNode;
    params: Promise<{ slug: string }>;
}) {
    const { slug } = await params;
    const session = await getCustomerSession();

    if (!session) {
        redirect(`/shop/${slug}/login`);
    }

    // Fetch the business details for branding
    const business = await prisma.business.findUnique({
        where: { slug: slug },
        include: { storefrontConfig: true }
    });

    if (!business || business.id !== session.businessId) {
        redirect(`/shop/${slug}/login`);
    }

    // @ts-ignore
    const branding: any = business.storefrontConfig?.branding ?
        // @ts-ignore
        JSON.parse(business.storefrontConfig.branding as string) : {};

    const primaryColor = branding.primary_color || '#4F46E5';

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col md:flex-row">
            {/* Sidebar Navigation */}
            <aside className="w-full md:w-64 bg-white dark:bg-slate-800 border-r border-slate-200 dark:border-slate-700 flex flex-col pt-6 flex-shrink-0">
                <div className="px-6 mb-8 flex items-center justify-between">
                    <Link href={`/shop/${slug}`} className="flex items-center gap-3">
                        {branding.logo_url ? (
                            <img src={branding.logo_url} alt="Logo" className="w-10 h-10 object-contain" />
                        ) : (
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white" style={{ backgroundColor: primaryColor }}>
                                <Store size={20} />
                            </div>
                        )}
                        <span className="font-black text-slate-900 dark:text-white truncate">
                            {business.name}
                        </span>
                    </Link>
                </div>

                <nav className="flex-1 px-4 space-y-2">
                    <Link
                        href={`/shop/${slug}/account`}
                        className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700/50 text-slate-700 dark:text-slate-300 font-bold transition-colors"
                    >
                        <User size={18} /> Overview
                    </Link>
                    <Link
                        href={`/shop/${slug}/account/box`}
                        className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700/50 text-slate-700 dark:text-slate-300 font-bold transition-colors"
                    >
                        <Package size={18} /> Build Your Box
                    </Link>
                    <div className="pt-4 mt-4 border-t border-slate-100 dark:border-slate-700">
                        <LogoutButton slug={slug} />
                    </div>
                </nav>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 p-4 md:p-8 overflow-y-auto">
                {children}
            </main>
        </div>
    );
}
