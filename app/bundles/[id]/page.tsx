import BundleEditor from '@/components/BundleEditor';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function BundleDetailPage({ params }: { params: Promise<{ id: string }> }) {
    // BUNDLE-SECURITY-1. Bundle administration is a tenant-scoped surface, so
    // this page authenticates itself rather than relying on the middleware
    // allowlist alone — the same defense-in-depth shape as app/recipes/[id].
    const session = await auth();
    if (!session?.user?.businessId) return <div>Unauthorized</div>;
    const businessId = session.user.businessId;

    const { id } = await params;

    let bundle = null;

    // Fetch Bundle if editing
    if (id !== 'new') {
        // Ownership is proven by the query itself, not by a post-hoc comparison:
        // another tenant's bundle simply does not resolve, so a guessed or
        // leaked UUID is indistinguishable from one that does not exist.
        const rawBundle = await prisma.bundle.findFirst({
            where: { id, business_id: businessId },
            include: { contents: { include: { recipe: true }, orderBy: { position: 'asc' } } }
        });

        if (!rawBundle) {
            return (
                <div className="p-8 text-center bg-white rounded-xl border border-slate-200">
                    <h2 className="text-xl font-bold text-slate-800">Bundle Not Found</h2>
                    <p className="text-slate-500">The bundle you are looking for does not exist.</p>
                </div>
            );
        }

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
            price: rawBundle.price ? Number(rawBundle.price) : null,
            stock_on_hand: Number(rawBundle.stock_on_hand)
        };
    }

    // Fetch this tenant's Recipes for the "Add Item" dropdown. Unowned legacy
    // rows (business_id = NULL) are deliberately excluded rather than shared
    // globally — offering them here is what let a foreign recipe be attached.
    const allRecipes = await prisma.recipe.findMany({
        where: { business_id: businessId },
        select: { id: true, name: true, type: true },
        orderBy: { name: 'asc' }
    });

    // Fetch existing Tiers (Distinct Logic) — this tenant's vocabulary only.
    const bundles = await prisma.bundle.findMany({
        where: { business_id: businessId },
        select: { serving_tier: true },
        distinct: ['serving_tier']
    });
    const knownTiers = bundles.map(b => b.serving_tier).filter(Boolean) as string[];

    return <BundleEditor initialData={bundle} allRecipes={allRecipes} knownTiers={knownTiers} />;
}
