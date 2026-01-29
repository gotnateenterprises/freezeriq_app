
import { NextResponse } from 'next/server';
import { getLabelPrinter } from '@/lib/label_printer';

// Force dynamic to prevent caching of print jobs
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { items } = body; // Array of { recipeName, ingredients, expiryDate, quantity }

        if (!items || !Array.isArray(items)) {
            return NextResponse.json({ error: 'Invalid items array' }, { status: 400 });
        }

        const printer = getLabelPrinter();
        const results = [];

        for (const item of items) {
            const result = await printer.printLabel({
                recipeName: item.recipeName,
                ingredients: item.ingredients,
                expiryDate: item.expiryDate,
                quantity: item.quantity,
                user: 'System' // Could come from session later
            });
            results.push(result);
        }

        // If any failed, report partial success (simplified for MVP)
        const failures = results.filter(r => !r.success);
        if (failures.length > 0) {
            return NextResponse.json({
                success: false,
                message: `${failures.length} labels failed to print`,
                details: failures
            }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'All labels printed' });

    } catch (error) {
        console.error('Print Error:', error);
        return NextResponse.json({ error: 'Failed to process print job' }, { status: 500 });
    }
}
