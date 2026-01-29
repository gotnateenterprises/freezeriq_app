import { PrismaAdapter } from '@/lib/prisma_adapter';
import RecipeEditor from '@/components/RecipeEditor';

export default async function RecipeDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const adapter = new PrismaAdapter();
    const recipe = await adapter.getRecipe(id);

    if (!recipe) {
        return (
            <div className="p-8 text-center bg-white rounded-xl border border-slate-200">
                <h2 className="text-xl font-bold text-slate-800">Recipe Not Found</h2>
                <p className="text-slate-500">The recipe you are looking for does not exist.</p>
            </div>
        );
    }

    // Serialize for Client Component (Decimal -> Number)
    const serializedRecipe = {
        ...recipe,
        base_yield_qty: Number(recipe.base_yield_qty),
        items: recipe.items.map(i => ({
            ...i,
            quantity: Number(i.quantity)
        }))
    };

    // Calculate Financials
    const { calculateRecipeCost } = await import('@/lib/cost_engine'); // Dynamic import to avoid build issues if mixed env
    const costData = await calculateRecipeCost(id);

    return <RecipeEditor initialData={serializedRecipe} costData={costData} />;
}
