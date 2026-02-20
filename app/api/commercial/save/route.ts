import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';

import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const body = await req.json();
        const { ingredients, suppliers } = body;

        console.log("Saving Ingredients Count:", ingredients?.length);
        console.log("Saving Suppliers Count:", suppliers?.length);

        const isUUID = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        // 1. Save Suppliers
        if (suppliers && Array.isArray(suppliers)) {
            for (const s of suppliers) {
                if (!s.id) continue;
                try {
                    await prisma.supplier.upsert({
                        where: { id: s.id },
                        create: {
                            id: s.id,
                            name: s.name,
                            website_url: s.website_url,
                            business_id: businessId
                        },
                        update: { name: s.name, website_url: s.website_url }
                    });
                } catch (supError: any) {
                    console.error(`Error saving supplier ${s.name}:`, supError.message);
                }
            }
        }

        // 2. Save Ingredients
        if (ingredients && Array.isArray(ingredients)) {
            for (const ing of ingredients) {
                if (!ing.id) continue;

                // Handle Decimal conversion safely
                const toDecimal = (val: any, fallback: number = 0) => {
                    const num = parseFloat(val);
                    if (isNaN(num)) return new Prisma.Decimal(fallback);
                    return new Prisma.Decimal(num);
                };

                const data: any = {
                    name: ing.name,
                    cost_per_unit: toDecimal(ing.cost_per_unit),
                    stock_quantity: toDecimal(ing.stock_quantity),
                    unit: ing.unit || 'oz',
                    supplier_id: ing.supplier_id || null, // Removed potentially flaky isUUID check
                    sku: ing.sku || null,
                    purchase_unit: ing.purchase_unit || null,
                    purchase_quantity: (ing.purchase_quantity === null || ing.purchase_quantity === undefined)
                        ? new Prisma.Decimal(1)
                        : toDecimal(ing.purchase_quantity, 1),
                    purchase_cost: (ing.purchase_cost === null || ing.purchase_cost === undefined || ing.purchase_cost === '')
                        ? null
                        : toDecimal(ing.purchase_cost),
                    needs_review: false // Review is considered complete if saved here
                };

                try {
                    await prisma.ingredient.upsert({
                        where: { id: ing.id },
                        create: { ...data, id: ing.id, business_id: businessId },
                        update: data
                    });
                } catch (ingError: any) {
                    console.error(`Error saving ingredient ${ing.name}:`, {
                        message: ingError.message,
                        code: ingError.code,
                        meta: ingError.meta
                    });
                    return NextResponse.json({
                        error: `Error saving "${ing.name}": ${ingError.message}`,
                        code: ingError.code,
                        meta: ingError.meta
                    }, { status: 500 });
                }
            }
        }

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("Critical Save API Error:", e);
        return NextResponse.json({
            error: e.message || "An unexpected database error occurred",
            code: e.code || "UNKNOWN_ERROR"
        }, { status: 500 });
    }
}
