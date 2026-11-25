import BundleEditor from '@/components/BundleEditor';
import BundlePosterPanel, { type BundlePosterPanelProps } from '@/components/bundles/BundlePosterPanel';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { posterBadge, posterPhotoHosts, posterPhotoSource, posterSizeLabel, POSTER_MAX_MEALS } from '@/lib/poster/posterModel';
import { defaultPosterTheme } from '@/lib/poster/posterThemes';

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
    // BUNDLE-POSTER-FROM-RECIPES-1: the poster section, shown for saved bundles only.
    let poster: BundlePosterPanelProps | null = null;

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

        const hosts = posterPhotoHosts();
        const shown = rawBundle.contents.filter((c) => c.recipe).slice(0, POSTER_MAX_MEALS);
        poster = {
            bundleId: rawBundle.id,
            bundleName: rawBundle.name,
            // A fundraiser add-on has no serving size, so its poster never says Serves 5 (posterSizeLabel).
            sizeLabel: posterSizeLabel(rawBundle.serving_tier, (rawBundle as any).bundle_type),
            mealCount: shown.length,
            photoCount: shown.filter((c) => posterPhotoSource(c.recipe.image_url, hosts).url).length,
            defaultTheme: defaultPosterTheme(rawBundle.name),
            derivedBadge: posterBadge(rawBundle.name),
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

    // BUNDLE-EDITOR-UX-1: the Poster Studio sits in the editor's right column ("Create Bundle Poster" scrolls to
    // it). A new bundle has none yet — the editor shows a save-first card in its place.
    return (
        <BundleEditor
            initialData={bundle}
            allRecipes={allRecipes}
            knownTiers={knownTiers}
            posterStudio={poster ? <BundlePosterPanel {...poster} /> : undefined}
        />
    );
}
