
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
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
                where: { name: { contains: partialName, mode: 'insensitive' } }
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
