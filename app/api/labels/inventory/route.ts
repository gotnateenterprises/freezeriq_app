import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
    try {
        const setting = await prisma.systemSetting.findUnique({
            where: { key: 'label_inventory' }
        });

        const inventory = setting ? parseInt(setting.value) : 0;
        return NextResponse.json({ inventory });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const { action, quantity } = await req.json();

        // Get current inventory
        let setting = await prisma.systemSetting.findUnique({
            where: { key: 'label_inventory' }
        });

        let currentInventory = setting ? parseInt(setting.value) : 0;

        if (action === 'add') {
            // Add labels (purchase)
            currentInventory += quantity;
        } else if (action === 'deduct') {
            // Deduct labels (print)
            if (currentInventory < quantity) {
                return NextResponse.json({
                    error: `Insufficient labels. You have ${currentInventory} labels but need ${quantity}.`
                }, { status: 400 });
            }
            currentInventory -= quantity;
        } else {
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
        }

        // Update or create setting
        await prisma.systemSetting.upsert({
            where: { key: 'label_inventory' },
            update: { value: currentInventory.toString(), updated_at: new Date() },
            create: { key: 'label_inventory', value: currentInventory.toString() }
        });

        return NextResponse.json({ inventory: currentInventory });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
