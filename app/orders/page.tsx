import Link from 'next/link';
import { CreditCard, FileText, Search, Filter, Truck } from 'lucide-react';
import { PrismaAdapter } from '@/lib/prisma_adapter';
import { SyncOrdersButton } from '@/components/SyncOrdersButton';
import AddManualOrderButton from '@/components/AddManualOrderButton';
import { OrdersTable } from '@/components/OrdersTable';

export default async function OrdersPage() {
    const adapter = new PrismaAdapter();
    const orders = await adapter.getOrders();
    const bundles = await adapter.getBundles();

    // Stats (Mocked for now, or calculated from orders)
    const newOrdersCount = orders.length; // Placeholder logic
    const revenue = orders.reduce((acc, o) => {
        const val = typeof o.total === 'string' ? parseFloat(o.total.replace(/[^0-9.-]+/g, "")) : Number(o.total);
        return acc + (isNaN(val) ? 0 : val);
    }, 0);

    const pendingCount = orders.filter(o => o.status === 'Confirmed' || o.status === 'Pending').length;

    return (
        <div className="max-w-7xl mx-auto space-y-8">
            <div className="flex flex-col md:flex-row justify-between items-end gap-6">
                <div>
                    <h2 className="text-4xl font-black text-indigo-900 dark:text-white text-adaptive tracking-tight">Order Management</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-2 text-lg">Process incoming meal prep and fundraiser orders.</p>
                </div>
                <div className="flex gap-4">
                    <AddManualOrderButton bundles={bundles} />
                    <button className="flex items-center gap-2 px-6 py-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 font-bold shadow-sm transition-all hover:scale-105 active:scale-95">
                        <Filter size={20} strokeWidth={2.5} />
                        Filter
                    </button>
                    <SyncOrdersButton />
                </div>
            </div >

            {/* Stats Row */}
            < div className="grid grid-cols-1 md:grid-cols-3 gap-6" >
                <div className="glass-panel p-6 rounded-3xl flex items-center justify-between border border-white/40 dark:border-slate-700/50 bg-white/50 dark:bg-slate-800/40">
                    <div>
                        <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle text-sm font-bold uppercase tracking-wider">New Orders</p>
                        <p className="text-4xl font-black text-indigo-900 dark:text-white text-adaptive mt-2">{newOrdersCount}</p>
                    </div>
                    <div className="p-4 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-2xl shadow-inner">
                        <Truck size={32} strokeWidth={2} />
                    </div>
                </div>
                <Link href="/production/schedule" className="glass-panel p-6 rounded-3xl flex items-center justify-between border border-white/40 dark:border-slate-700/50 bg-white/50 dark:bg-slate-800/40 hover:scale-[1.02] transition-all cursor-pointer group">
                    <div>
                        <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle text-sm font-bold uppercase tracking-wider group-hover:text-amber-600 transition-colors">Pending Tasks</p>
                        <p className="text-4xl font-black text-indigo-900 dark:text-white text-adaptive mt-2">{pendingCount}</p>
                    </div>
                    <div className="p-4 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-2xl shadow-inner group-hover:bg-amber-200 transition-colors">
                        <FileText size={32} strokeWidth={2} />
                    </div>
                </Link>
                <div className="glass-panel p-6 rounded-3xl flex items-center justify-between border border-white/40 dark:border-slate-700/50 bg-white/50 dark:bg-slate-800/40">
                    <div>
                        <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle text-sm font-bold uppercase tracking-wider">Total Revenue</p>
                        <p className="text-4xl font-black text-emerald-600 dark:text-emerald-400 text-adaptive mt-2">${revenue.toFixed(2)}</p>
                    </div>
                    <div className="p-4 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-2xl shadow-inner">
                        <CreditCard size={32} strokeWidth={2} />
                    </div>
                </div>
            </div >

            {/* Orders Table */}
            < div className="glass-panel rounded-3xl shadow-soft border border-white/40 dark:border-slate-700/50 overflow-hidden bg-white/80 dark:bg-slate-900/60 backdrop-blur-xl" >
                {/* Search Header */}
                < div className="p-6 border-b border-slate-100 dark:border-slate-700/50 flex items-center gap-4" >
                    <Search className="text-slate-400 dark:text-slate-500" size={24} />
                    <input
                        type="text"
                        placeholder="Search orders..."
                        className="bg-transparent border-none outline-none text-lg font-medium text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 w-full"
                    />
                </div >

                <div className="overflow-x-auto">
                    <OrdersTable orders={orders} />
                </div>
            </div >
        </div >
    );
}
