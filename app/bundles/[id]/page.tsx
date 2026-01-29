import BundleEditor from '@/components/BundleEditor';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function BundleDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    let bundle = null;
    let allRecipes = [];

    // Fetch Bundle if editing
    if (id !== 'new') {
        const rawBundle = await prisma.bundle.findUnique({
            where: { id },
            include: { contents: { include: { recipe: true }, orderBy: { position: 'asc' } } }
        });

        if (rawBundle) {
            // Serialize Decimals for Client Component
            bundle = {
                ...rawBundle,
                contents: rawBundle.contents.map(c => ({
                    ...c,
                    recipe: {
                        ...c.recipe,
                        base_yield_qty: Number(c.recipe.base_yield_qty)
                    }
                })),
                price: rawBundle.price ? Number(rawBundle.price) : null
            };
        }
    }

    // Fetch All Recipes for the "Add Item" dropdown
    allRecipes = await prisma.recipe.findMany({
        select: { id: true, name: true, type: true },
        orderBy: { name: 'asc' }
    });

    // Fetch existing Tiers (Distinct Logic)
    const bundles = await prisma.bundle.findMany({
        select: { serving_tier: true },
        distinct: ['serving_tier']
    });
    const knownTiers = bundles.map(b => b.serving_tier).filter(Boolean) as string[];

    return <BundleEditor initialData={bundle} allRecipes={allRecipes} knownTiers={knownTiers} />;
}
