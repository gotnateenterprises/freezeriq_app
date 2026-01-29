
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
    try {
        const recipes = await prisma.recipe.findMany({
            where: {
                name: {
                    contains: 'Marinara',
                    mode: 'insensitive'
                }
            }
        });

        return NextResponse.json({
            count: recipes.length,
            recipes: recipes.map(r => ({ name: r.name, id: r.id, type: r.type }))
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
