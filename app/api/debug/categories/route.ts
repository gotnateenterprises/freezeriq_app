
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const recipes = await prisma.recipe.findMany({
            select: {
                id: true,
                name: true,
                category_id: true,
                categories: { select: { id: true, name: true } }
            }
        });

        let legacyCount = 0;
        let mnCount = 0;
        let bothCount = 0;
        let noneCount = 0;
        const uncategorizedSamples: string[] = [];

        recipes.forEach(r => {
            const hasLegacy = !!r.category_id;
            const hasMN = r.categories.length > 0;

            if (hasLegacy && hasMN) bothCount++;
            else if (hasLegacy) legacyCount++;
            else if (hasMN) mnCount++;
            else {
                noneCount++;
                if (uncategorizedSamples.length < 5) uncategorizedSamples.push(r.name);
            }
        });

        const categories = await prisma.category.findMany();

        return NextResponse.json({
            stats: {
                totalRecipes: recipes.length,
                legacyOnly: legacyCount,
                mnOnly: mnCount,
                both: bothCount,
                none: noneCount,
                totalCategories: categories.length
            },
            uncategorizedSamples
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
