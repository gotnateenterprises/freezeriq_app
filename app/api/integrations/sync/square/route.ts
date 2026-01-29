
import { NextResponse } from 'next/server';
import { syncSquareOrders } from '@/lib/square';

export async function POST() {
    try {
        const stats = await syncSquareOrders();
        return NextResponse.json({ success: true, stats });
    } catch (e: any) {
        console.error("Sync Failed", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
