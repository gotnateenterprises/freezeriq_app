
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth'; // Assuming auth is available

export async function DELETE(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const supplierId = searchParams.get('id');

        if (!supplierId) {
            return NextResponse.json({ error: "Supplier ID required" }, { status: 400 });
        }

        // 1. Verify supplier belongs to user's business
        const supplier = await prisma.supplier.findUnique({
            where: { id: supplierId }
        });

        if (!supplier) {
            return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
        }

        if (supplier.business_id !== session.user.businessId) {
            return NextResponse.json({ error: "Unauthorized to delete this supplier" }, { status: 403 });
        }

        // 2. Check for usage in ingredients
        const ingredientCount = await prisma.ingredient.count({
            where: { supplier_id: supplierId }
        });

        if (ingredientCount > 0) {
            return NextResponse.json({
                error: `Cannot delete supplier. It is used by ${ingredientCount} ingredients.`
            }, { status: 400 });
        }

        // 3. Delete
        await prisma.supplier.delete({
            where: { id: supplierId }
        });

        return NextResponse.json({ success: true });

    } catch (e) {
        console.error("Delete supplier error:", e);
        return NextResponse.json({ error: "Failed to delete supplier" }, { status: 500 });
    }
}
