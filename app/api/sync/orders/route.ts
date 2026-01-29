
import { NextResponse } from 'next/server';
import { IngestionDBAdapter } from '@/lib/ingestion_db';
import { QBOPoller } from '@/lib/ingestion/qbo_poller';
import { SquareOrderHandler } from '@/lib/ingestion/square_handler';


export async function POST() {
    const db = new IngestionDBAdapter();
    const qbo = new QBOPoller(db);
    const square = new SquareOrderHandler(db);
    const results = { qbo: 'skipped', square: 'skipped', errors: [] as string[] };

    // 1. Process QBO
    try {
        await qbo.syncInvoices();
        results.qbo = 'success';
    } catch (e: any) {
        console.error("QBO Sync Failed (Full):", JSON.stringify(e, Object.getOwnPropertyNames(e)));
        results.qbo = 'failed';
        results.errors.push(`QBO: ${e.message || JSON.stringify(e)}`);
    }

    // 2. Process Square
    try {
        await square.syncOrders();
        results.square = 'success';
    } catch (e: any) {
        console.error("Square Sync Failed:", e);
        results.square = 'failed';
        results.errors.push(`Square: ${e.message}`);
    }

    return NextResponse.json({
        success: results.errors.length === 0,
        results
    }, { status: results.errors.length > 0 ? 207 : 200 }); // 207 Multi-Status
}
