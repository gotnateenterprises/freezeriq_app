import { prisma } from '@/lib/db';
import CommercialManager from '@/components/CommercialManager';

export const dynamic = 'force-dynamic';

export default async function CommercialPage() {
    // Fetch all Ingredients
    const ingredients = await prisma.ingredient.findMany({
        orderBy: { name: 'asc' },
        include: { supplier: true }
    });

    // Fetch all Suppliers
    const suppliers = await prisma.supplier.findMany({
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
        purchase_cost: Number(i.purchase_cost)
    }));

    return (
        <div className="space-y-8">
            <div>
                <div>
                    <h2 className="text-3xl font-bold text-slate-900 dark:text-white text-adaptive">Inventory & Costs</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-adaptive-subtle mt-1">Manage ingredient costs, stock levels, and suppliers.</p>
                </div>

                <CommercialManager
                    initialIngredients={safeIngredients}
                    initialSuppliers={suppliers}
                />
            </div>
        </div>
    );
}
