import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { calculateRecipeCost } from '@/lib/cost_engine';

export async function GET() {
    try {
        const bundles = await prisma.bundle.findMany({
            where: { is_active: true },
            include: {
                contents: {
                    include: {
                        recipe: true
                    }
                }
            },
            orderBy: { name: 'asc' }
        });

        const marginsData = await Promise.all(bundles.map(async (bundle) => {
            let totalCogs = 0;

            for (const content of bundle.contents) {
                try {
                    const costResult = await calculateRecipeCost(content.recipe_id);
                    // The cost to include in the bundle is the costPerUnit * the quantity included in the bundle
                    const recipeCostInBundle = costResult.costPerUnit * Number(content.quantity);
                    totalCogs += recipeCostInBundle;
                } catch (err) {
                    console.error(`Failed to calculate cost for recipe ${content.recipe.name}:`, err);
                }
            }

            const price = Number(bundle.price) || 0;
            let marginPercentage = 0;

            if (price > 0) {
                marginPercentage = ((price - totalCogs) / price) * 100;
            }

            return {
                id: bundle.id,
                name: bundle.name,
                sku: bundle.sku,
                serving_tier: bundle.serving_tier,
                price: parseFloat(price.toFixed(2)),
                totalCogs: parseFloat(totalCogs.toFixed(2)),
                marginPercentage: parseFloat(marginPercentage.toFixed(2)),
                is_active: bundle.is_active
            };
        }));

        return NextResponse.json(marginsData);
    } catch (e: any) {
        console.error('Profit margin analytics error:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
