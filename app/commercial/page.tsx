import { prisma } from '@/lib/db';
import CommercialManager from '@/components/CommercialManager';

export const dynamic = 'force-dynamic';

export default async function CommercialPage() {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (!session?.user?.businessId) return <div>Unauthorized</div>;

    // Fetch all Ingredients
    const ingredients = await prisma.ingredient.findMany({
        where: { business_id: session.user.businessId },
        orderBy: { name: 'asc' },
        include: { supplier: true }
    });

    // Fetch all Suppliers (Tenant specific + Global)
    const suppliers = await prisma.supplier.findMany({
        where: {
            OR: [
                { business_id: session.user.businessId },
                { is_global: true }
            ]
        },
        orderBy: { name: 'asc' }
    });

    // Fetch all Packaging
    const packaging = await prisma.packagingItem.findMany({
        where: { business_id: session.user.businessId },
        orderBy: { name: 'asc' }
    });

    // Transform Types for Client Component
    const safeIngredients = ingredients.map(i => ({
        id: i.id,
        name: i.name,
        cost_per_unit: Number(i.cost_per_unit),
        unit: i.unit,
        stock_quantity: Number(i.stock_quantity),
        supplier_id: i.supplier_id,
        sku: i.sku,
        purchase_unit: i.purchase_unit,
        purchase_quantity: Number(i.purchase_quantity),
        purchase_cost: Number(i.purchase_cost),
        needs_review: i.needs_review
    }));

    const safePackaging = packaging.map(p => ({
        ...p,
        cost_per_unit: Number(p.cost_per_unit || 0),
        lowStockThreshold: Number(p.lowStockThreshold || 10),
        quantity: Number(p.quantity || 0)
    }));

    return (
        <div className="space-y-8">
            <div>
                <div className="mb-6">
                    <h2 className="text-3xl font-bold text-slate-900 dark:text-white text-adaptive">Inventory & Costs</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-1">Manage ingredients, packaging, stock levels, and suppliers.</p>
                </div>

                <CommercialManager
                    initialIngredients={safeIngredients}
                    initialSuppliers={suppliers}
                    initialPackaging={safePackaging}
                />
            </div>
        </div>
    );
}
