import { getCustomerSession } from '@/lib/customerAuth';
import { prisma } from '@/lib/db';
import { redirect } from 'next/navigation';
import BoxBuilder from './BoxBuilder';
import { Store } from 'lucide-react';

export default async function BuildABoxPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const session = await getCustomerSession();

    if (!session) {
        redirect(`/shop/${slug}/login`);
    }

    // Fetch full customer details
    const customer = await prisma.customer.findUnique({
        where: { id: session.customerId }
    });

    if (!customer) {
        redirect(`/shop/${slug}/login`);
    }

    // Fetch active catalog and its bundles/recipes
    const activeCatalog = await prisma.catalog.findFirst({
        where: {
            business_id: session.businessId,
            is_active: true
        },
        include: {
            bundles: {
                where: { is_active: true },
                include: {
                    contents: {
                        include: { recipe: true }
                    }
                }
            }
        }
    });

    // Extract unique recipes from the active catalog bundles to create a "Menu"
    const menuItemsMap = new Map();

    if (activeCatalog) {
        activeCatalog.bundles.forEach(bundle => {
            bundle.contents.forEach(content => {
                if (content.recipe && !menuItemsMap.has(content.recipe.id)) {
                    menuItemsMap.set(content.recipe.id, content.recipe);
                }
            });
        });
    }

    const menuItems = Array.from(menuItemsMap.values());

    return (
        <div className="max-w-5xl mx-auto">
            <header className="mb-8">
                <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
                    Build Your Box
                </h1>
                <p className="text-slate-500 font-medium">Select your meals for the upcoming delivery.</p>
            </header>

            {((customer as any).meal_credits || 0) <= 0 ? (
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-12 text-center border border-slate-200 dark:border-slate-700">
                    <Store size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                    <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-2">No Meal Credits Available</h2>
                    <p className="text-slate-500 max-w-md mx-auto">
                        You currently have no meal credits. Your credits will automatically reload when your next billing cycle clears.
                    </p>
                </div>
            ) : menuItems.length === 0 ? (
                <div className="bg-white dark:bg-slate-800 rounded-3xl p-12 text-center border border-slate-200 dark:border-slate-700">
                    <Store size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                    <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-2">Menu is Updating</h2>
                    <p className="text-slate-500 max-w-md mx-auto">
                        We are currently finalizing the menu for this delivery cycle. Please check back shortly!
                    </p>
                </div>
            ) : (
                <BoxBuilder
                    credits={(customer as any).meal_credits || 0}
                    menuItems={menuItems}
                    slug={slug}
                    businessId={session.businessId}
                />
            )}
        </div>
    );
}
