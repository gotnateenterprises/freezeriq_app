
"use client";

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Truck } from 'lucide-react';
import DeleteOrderButton from './DeleteOrderButton';

export function OrdersTable({ orders }: { orders: any[] }) {
    const router = useRouter();

    return (
        <table className="w-full">
            <thead>
                <tr className="bg-slate-50/50 dark:bg-slate-800/50 text-left text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    <th className="px-8 py-5">Order ID</th>
                    <th className="px-6 py-5">Date</th>
                    <th className="px-6 py-5">Customer</th>
                    <th className="px-6 py-5">Items</th>
                    <th className="px-6 py-5 text-right">Total</th>
                    <th className="px-6 py-5 text-center">Status</th>
                    <th className="px-6 py-5"></th>
                </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {orders.map((order) => (
                    <tr
                        key={order.id}
                        onClick={() => order.customerId && router.push(`/customers/${order.customerId}`)}
                        className="hover:bg-indigo-50/50 dark:hover:bg-slate-800/50 transition-colors group cursor-pointer"
                    >
                        <td className="px-8 py-5">
                            <div className="font-bold text-indigo-900 dark:text-white">{order.id}</div>
                            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mt-0.5">{order.source}</div>
                        </td>
                        <td className="px-6 py-5 text-sm font-semibold text-slate-700 dark:text-slate-300">{order.date}</td>
                        <td className="px-6 py-5 font-bold text-slate-900 dark:text-white">
                            {order.customerId ? (
                                <Link
                                    href={`/customers/${order.customerId}`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline transition-all"
                                >
                                    {order.customer}
                                </Link>
                            ) : (
                                order.customer
                            )}
                        </td>
                        <td className="px-6 py-5 text-sm font-medium text-slate-600 dark:text-slate-400">{order.items}</td>
                        <td className="px-6 py-5 text-right font-bold text-slate-900 dark:text-white tabular-nums">{order.total}</td>
                        <td className="px-6 py-5 text-center">
                            <span className={`inline-flex px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider
                                ${order.status === 'Confirmed' || order.status === 'Paid' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' : ''}
                                ${order.status === 'Pending' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400' : ''}
                            `}>
                                {order.status}
                            </span>
                        </td>
                        <td className="px-6 py-5 text-right" onClick={(e) => e.stopPropagation()}>
                            <DeleteOrderButton orderId={order.id} />
                        </td>
                    </tr>
                ))}
                {orders.length === 0 && (
                    <tr>
                        <td colSpan={7} className="px-6 py-16 text-center">
                            <div className="w-20 h-20 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                                <Truck size={40} strokeWidth={1.5} />
                            </div>
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white">No active orders</h3>
                            <p className="text-slate-500 dark:text-slate-400 mt-1">Connect a sales channel to see data here.</p>
                        </td>
                    </tr>
                )}
            </tbody>
        </table>
    );
}
