import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { calculateRecipeCost } from '@/lib/cost_engine';

/**
 * GET /api/recipes/costs
 * Returns a map of recipe IDs to their total costs
 * Used by Bundle Editor to show individual recipe costs
 */
export async function GET() {
    try {
        const recipes = await prisma.recipe.findMany({
            select: { id: true, name: true }
        });

        const costs: Record<string, number> = {};

        for (const recipe of recipes) {
            try {
                const result = await calculateRecipeCost(recipe.id);
                costs[recipe.id] = result.totalCost;
            } catch (e) {
                console.error(`Failed to calculate cost for recipe ${recipe.name}:`, e);
                costs[recipe.id] = 0; // Fallback to 0 if calculation fails
            }
        }

        return NextResponse.json(costs);
    } catch (e: any) {
        console.error('Recipe costs API error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
