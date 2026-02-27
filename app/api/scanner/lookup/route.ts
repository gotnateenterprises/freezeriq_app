import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
    const session = await auth();
    if (!session || !session.user || !session.user.businessId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const type = searchParams.get('type');

    if (!id || !type) {
        return NextResponse.json({ error: "Missing id or type" }, { status: 400 });
    }

    try {
        if (type === 'recipe') {
            const recipe = await prisma.recipe.findFirst({
                where: {
                    id: id,
                    business_id: session.user.businessId
                }
            });

            if (!recipe) {
                return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
            }

            return NextResponse.json({
                id: recipe.id,
                name: recipe.name,
                type: 'recipe',
                currentStock: 0, // Recipes don't have stock yet based on schema.
                unit: recipe.base_yield_unit || 'units'
            });

        } else if (type === 'ingredient') {
            const ingredient = await prisma.ingredient.findFirst({
                where: {
                    id: id,
                    business_id: session.user.businessId
                }
            });

            if (!ingredient) {
                return NextResponse.json({ error: "Ingredient not found" }, { status: 404 });
            }

            return NextResponse.json({
                id: ingredient.id,
                name: ingredient.name,
                type: 'ingredient',
                currentStock: ingredient.stock_quantity ? Number(ingredient.stock_quantity) : 0,
                unit: ingredient.unit || 'units',
                costPerUnit: ingredient.cost_per_unit || 0
            });
        }
        else if (type === 'supply') {
            // Supply Logic (placeholder if not in schema yet)
            return NextResponse.json({ error: "Supply scanning not yet implemented" }, { status: 400 });
        }

        return NextResponse.json({ error: "Unknown type" }, { status: 400 });

    } catch (error) {
        console.error("Scanner Lookup Error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
