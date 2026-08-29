
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// SEC-PUBLIC-ROUTE-1. This handler had no auth() call, and deductItem matched
// packaging rows with `contains` and NO business_id — so findFirst returned
// whichever tenant's row matched the hardcoded name first, platform-wide. That
// made it both an anonymous inventory-decrement primitive AND a live correctness
// bug: the legitimate print-batch flow could already be decrementing another
// tenant's stock. It also echoed the matched row's real name back in the
// response, leaking it.
//
// The caller supplies only quantities — the eight partial names are hardcoded
// below — so adding the tenant predicate needs no client change.
//
// NOTE for whoever touches this next: after the tenant predicate, a tenant whose
// PackagingItem rows are named differently will now silently match nothing
// (deductItem returns quietly when item is null). Moving this matching off
// free-text `name` onto PackagingItem.type is a real follow-up, but it is a
// behaviour change, not a security fix, and is deliberately NOT bundled here.
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const {
            largeBoxes, smallBoxes, sheetsUsed,
            packaging // { largeTrays, largeLids, ... }
        } = await req.json();

        // 1. Calculate Tape Usage (1 unit per 30 boxes total)
        const totalBoxes = (largeBoxes || 0) + (smallBoxes || 0);
        const tapeNeeded = Math.ceil(totalBoxes / 30);

        const updates: any[] = [];
        const deductedItems: any = {};

        // Helper to deduct item by partial name match
        const deductItem = async (partialName: string, qty: number) => {
            if (qty <= 0) return;
            const item = await prisma.packagingItem.findFirst({
                where: { business_id: businessId, name: { contains: partialName, mode: 'insensitive' } },
                orderBy: { name: 'asc' }
            });
            if (item) {
                updates.push(prisma.packagingItem.update({
                    where: { id: item.id },
                    data: { quantity: { decrement: qty } }
                }));
                deductedItems[partialName] = { name: item.name, qty };
            }
        };

        // Standard Items
        await deductItem('Tape', tapeNeeded);
        await deductItem('Avery', sheetsUsed); // Labels

        // New Smart Packaging
        if (packaging) {
            await deductItem('Large Tray', packaging.largeTrays);
            await deductItem('Large Lid', packaging.largeLids);
            await deductItem('Small Container', packaging.smallTrays); // "Small Container" per user request
            await deductItem('Small Lid', packaging.smallLids);
            await deductItem('Gallon Ziplock', packaging.gallonBags); // "Gallon Ziplock"
            await deductItem('Quart Ziplock', packaging.quartBags); // "Quart Ziplock"
        }

        if (updates.length > 0) {
            await prisma.$transaction(updates);
        }

        return NextResponse.json({
            success: true,
            deducted: {
                tape: tapeNeeded,
                sheets: sheetsUsed,
                details: deductedItems
            }
        });

    } catch (e: any) {
        console.error("Print Job Deduction Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
