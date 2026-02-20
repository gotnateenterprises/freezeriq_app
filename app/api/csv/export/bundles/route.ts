
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const businessId = session.user.businessId;

        const bundles = await prisma.bundle.findMany({
            where: { business_id: businessId },
            include: {
                contents: {
                    include: {
                        recipe: true
                    }
                }
            }
        });

        const headers = ["Bundle Name", "SKU", "Price", "Item Name", "Item Qty"];
        let csvContent = headers.join(",") + "\n";

        bundles.forEach(bundle => {
            const bundleName = `"${bundle.name.replace(/"/g, '""')}"`;
            const sku = `"${(bundle.sku || '').replace(/"/g, '""')}"`;
            const price = Number(bundle.price || 0).toFixed(2);

            if (bundle.contents.length === 0) {
                csvContent += `${bundleName},${sku},${price},,\n`;
            } else {
                bundle.contents.forEach(content => {
                    const itemName = `"${(content.recipe?.name || '').replace(/"/g, '""')}"`;
                    const itemQty = content.quantity || 1;
                    csvContent += `${bundleName},${sku},${price},${itemName},${itemQty}\n`;
                });
            }
        });

        return new NextResponse(csvContent, {
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': 'attachment; filename=bundles.csv'
            }
        });

    } catch (e: any) {
        console.error("Bundle Export Error:", e);
        return NextResponse.json({ error: e.message || 'Server Error' }, { status: 500 });
    }
}
