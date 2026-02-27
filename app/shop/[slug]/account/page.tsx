import { getCustomerSession } from '@/lib/customerAuth';
import { prisma } from '@/lib/db';
import { redirect } from 'next/navigation';
import { Package, Utensils, Calendar, MapPin, ReceiptText } from 'lucide-react';
import Link from 'next/link';
import SubscriptionManagerCard from '@/components/shop/account/SubscriptionManagerCard';

export default async function CustomerDashboardPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const session = await getCustomerSession();

    if (!session) {
        redirect(`/shop/${slug}/login`);
    }

    // Fetch full customer details
    const customer = await prisma.customer.findUnique({
        where: { id: session.customerId },
        include: {
            orders: {
                orderBy: { created_at: 'desc' },
                take: 5
            }
        }
    });

    if (!customer) {
        redirect(`/shop/${slug}/login`);
    }

    return (
        <div className="max-w-4xl mx-auto space-y-8">
            <header>
                <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                    Welcome back, {customer.contact_name?.split(' ')[0] || 'Friend'}!
                </h1>
                <p className="text-slate-500 font-medium">Manage your subscription and upcoming deliveries.</p>
            </header>

            {/* Quick Stats Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

                {/* Meal Credits Card */}
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-4 mb-4">
                        <div className="w-12 h-12 bg-indigo-100 dark:bg-indigo-900/40 rounded-2xl flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                            <Utensils size={24} />
                        </div>
                        <div>
                            <p className="text-sm font-bold text-slate-500">Meal Credits</p>
                            <h3 className="text-2xl font-black text-slate-900 dark:text-white">{customer.meal_credits} Available</h3>
                        </div>
                    </div>
                    {customer.meal_credits > 0 ? (
                        <Link
                            href={`/shop/${slug}/account/box`}
                            className="block w-full text-center py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition-colors"
                        >
                            Build Your Box Now
                        </Link>
                    ) : (
                        <div className="w-full text-center py-3 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 font-bold rounded-xl">
                            Next credits drop soon
                        </div>
                    )}
                </div>

                {/* Subscription Status Card */}
                <SubscriptionManagerCard
                    customerId={customer.id}
                    subscriptionStatus={customer.subscription_status}
                    subscriptionPlanId={customer.subscription_plan_id}
                    stripeSubscriptionId={customer.stripe_subscription_id}
                />

                {/* Loyalty Balance Card */}
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-6 shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col justify-between">
                    <div>
                        <p className="text-sm font-bold text-slate-500 mb-1">Loyalty Points</p>
                        <h3 className="text-2xl font-black text-emerald-600 dark:text-emerald-400">
                            {customer.loyalty_balance.toString()} pts
                        </h3>
                    </div>
                    <Link href={`/shop/${slug}`} className="text-left text-sm font-bold text-emerald-600 hover:text-emerald-700 mt-4">
                        Redeem in Store &rarr;
                    </Link>
                </div>
            </div>

            {/* Order History */}
            <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                        <ReceiptText className="text-indigo-600" />
                        Recent Deliveries
                    </h2>
                </div>

                {customer.orders.length === 0 ? (
                    <div className="p-12 text-center text-slate-500 font-medium">
                        No orders found yet.
                    </div>
                ) : (
                    <div className="divide-y divide-slate-100 dark:divide-slate-700">
                        {customer.orders.map(order => (
                            <div key={order.id} className="p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-3">
                                        <span className="font-bold text-slate-900 dark:text-white">Order #{order.external_id}</span>
                                        <span className={`px-2.5 py-1 text-xs font-black rounded-lg uppercase tracking-wider
                                            ${order.status === 'delivered' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' :
                                                order.status === 'production_ready' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' :
                                                    'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}`}
                                        >
                                            {order.status.replace(/_/g, ' ')}
                                        </span>
                                    </div>
                                    <p className="text-sm font-medium text-slate-500 flex items-center gap-2">
                                        <Calendar size={14} />
                                        {order.created_at ? new Date(order.created_at).toLocaleDateString() : 'Unknown Date'}
                                    </p>
                                </div>

                                <div className="text-right">
                                    <div className="font-black text-slate-900 dark:text-white">
                                        ${order.total_amount.toString()}
                                    </div>
                                    <button className="text-sm font-bold text-indigo-600 hover:text-indigo-700">
                                        View Receipt
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

        </div>
    );
}
