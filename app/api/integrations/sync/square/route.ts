import { NextResponse } from 'next/server';
import { syncSquareOrders } from '@/lib/square';
import { auth } from '@/auth';

export async function POST() {
    try {
        const session = await auth();
        const businessId = session?.user?.businessId;

        const stats = await syncSquareOrders(businessId);
        return NextResponse.json({ success: true, stats });
    } catch (e: any) {
        console.error("Sync Failed", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
