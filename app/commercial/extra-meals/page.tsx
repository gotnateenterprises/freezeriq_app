import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { redirect } from "next/navigation";
import Image from "next/image";
import { Search, SlidersHorizontal, Package, Globe, EyeOff, LayoutDashboard, UtensilsCrossed } from "lucide-react";
import Link from "next/link";
import ExtraMealToggleRow from "./ExtraMealToggleRow";

export default async function ExtraMealsPage() {
    const session = await auth();
    if (!session?.user?.businessId) {
        redirect("/login");
    }

    // Fetch recipes that have inventory or are marked as published, or just fetch all menu_items.
    // For "Extra Meals", we likely only care about menu_items that they actually produce.
    const recipes = await prisma.recipe.findMany({
        where: {
            business_id: session.user.businessId,
            type: 'menu_item'
        },
        orderBy: { name: 'asc' }
    });

    const activeCount = recipes.filter(r => (r as any).is_published).length;
    // We don't have inventory_count on recipes yet, use a placeholder 0 for now
    const itemsWithStockCount = recipes.filter(r => false).length;

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
            {/* Header / Breadcrumb */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2 text-sm text-slate-500 mb-2">
                        <Link href="/commercial" className="hover:text-indigo-600 flex items-center gap-1">
                            <LayoutDashboard size={14} /> Commercial Ops
                        </Link>
                        <span>/</span>
                        <span className="font-semibold text-slate-700">Extra Meals</span>
                    </div>

                    <h1 className="text-3xl font-black tracking-tight text-slate-900 flex items-center gap-3">
                        <UtensilsCrossed className="text-indigo-600" size={32} />
                        Extra Meal Inventory
                    </h1>
                    <p className="text-slate-500 mt-1">Manage surplus inventory and control what appears on your public web store.</p>
                </div>

                {/* Quick Stats */}
                <div className="flex gap-4">
                    <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col justify-center min-w-[140px]">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">In Stock</span>
                        <span className="text-2xl font-black text-slate-800 flex items-center gap-2">
                            <Package size={20} className="text-indigo-500" />
                            {itemsWithStockCount}
                        </span>
                    </div>
                    <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200 flex flex-col justify-center min-w-[140px]">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Published</span>
                        <span className="text-2xl font-black text-emerald-600 flex items-center gap-2">
                            <Globe size={20} className="text-emerald-500" />
                            {activeCount}
                        </span>
                    </div>
                </div>
            </div>

            {/* Controls */}
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row gap-4 justify-between items-center">
                <div className="relative w-full sm:max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input
                        type="search"
                        placeholder="Search meals..."
                        className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    />
                </div>

                <div className="flex gap-2 w-full sm:w-auto">
                    <button className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-100 font-medium whitespace-nowrap">
                        <SlidersHorizontal size={16} /> Filter
                    </button>
                    <Link
                        href="/shop" // Placeholder for their storefront root or vanity url
                        target="_blank"
                        className="flex items-center gap-2 px-4 py-2 bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-xl hover:bg-indigo-100 font-bold whitespace-nowrap"
                    >
                        <Globe size={16} /> View Store
                    </Link>
                </div>
            </div>

            {/* Inventory Table */}
            <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                <table className="w-full text-left border-collapse">
                    <thead>
                        <tr className="bg-slate-50/80 border-b border-slate-200 text-xs uppercase tracking-wider font-bold text-slate-500">
                            <th className="px-6 py-4">Meal Item</th>
                            <th className="px-6 py-4 text-center">Category / Type</th>
                            <th className="px-6 py-4 text-center w-32">Current Stock</th>
                            <th className="px-6 py-4 text-right w-48">Store Visibility</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {recipes.map(recipe => (
                            <ExtraMealToggleRow
                                key={recipe.id}
                                recipe={JSON.parse(JSON.stringify(recipe))}
                            />
                        ))}

                        {recipes.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-6 py-12 text-center text-slate-500">
                                    <UtensilsCrossed size={48} className="mx-auto text-slate-200 mb-4" />
                                    <p className="text-lg font-medium">No menu items found.</p>
                                    <p className="text-sm">Create recipes and mark them as "Menu Item" to manage their inventory here.</p>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

        </div>
    );
}
