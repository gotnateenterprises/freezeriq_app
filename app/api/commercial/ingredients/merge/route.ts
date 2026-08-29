import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// SEC-PUBLIC-ROUTE-1. This handler had no auth() call and looked both
// ingredients up by bare primary key, so two guessed UUIDs were enough for an
// anonymous caller to hard-delete any tenant's ingredient and repoint every
// recipe line that referenced it. Both lookups are now scoped to the session's
// business, which makes a foreign id resolve to null and fall into the existing
// "Ingredient not found" path — fail-closed, and it does not disclose whether
// the foreign row exists.
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const body = await req.json();
        const { sourceId, targetId } = body;

        if (!sourceId || !targetId) {
            return NextResponse.json({ error: "Source and Target IDs are required" }, { status: 400 });
        }

        if (sourceId === targetId) {
            return NextResponse.json({ error: "Cannot merge ingredient into itself" }, { status: 400 });
        }

        // Transaction:
        // 1. Verify existence
        // 2. Re-point all RecipeItems from Source to Target
        // 3. Delete Source Ingredient

        await prisma.$transaction(async (tx) => {
            const source = await tx.ingredient.findFirst({ where: { id: sourceId, business_id: businessId } });
            const target = await tx.ingredient.findFirst({ where: { id: targetId, business_id: businessId } });

            if (!source || !target) {
                throw new Error("Ingredient not found");
            }

            // Update usages.
            // SEC-PUBLIC-ROUTE-1: this updateMany deliberately carries no tenant
            // predicate and CANNOT have one — RecipeItem has no business_id column
            // (scoping for it is always transitive, through parent_recipe). It is
            // safe only because sourceId and targetId were both proven to belong to
            // this business above. Do not "harden" it by inventing a business_id
            // filter here; keep the ownership proof upstream.
            await tx.recipeItem.updateMany({
                where: { child_ingredient_id: sourceId },
                data: { child_ingredient_id: targetId }
            });

            // Delete source
            await tx.ingredient.delete({
                where: { id: sourceId }
            });
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("Merge Error:", e);
        return NextResponse.json({ error: e.message || "Failed to merge" }, { status: 500 });
    }
}
