
import { NextResponse } from 'next/server';
import { IngestionDBAdapter } from '@/lib/ingestion_db';
import { QBOPoller } from '@/lib/ingestion/qbo_poller';
import { SquareOrderHandler } from '@/lib/ingestion/square_handler';
import Stripe from 'stripe';


export async function POST() {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (!session?.user?.businessId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const businessId = session.user.businessId;

    // Initialize Stripe conditionally to prevent crashes if key is missing
    let stripe = null;
    if (process.env.STRIPE_SECRET_KEY) {
        try {
            stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
                apiVersion: '2026-01-28.clover' as any, // Preserve version but guard against lack of key
                typescript: true
            });
        } catch (e) {
            console.error("Stripe initialization failed:", e);
        }
    } else {
        console.warn("Stripe Sync skipped: STRIPE_SECRET_KEY not found.");
    }

    const db = new IngestionDBAdapter(businessId);
    const qbo = new QBOPoller(db, businessId);
    const square = new SquareOrderHandler(db, businessId);
    const results = { qbo: 'skipped', square: 'skipped', errors: [] as string[] };

    // 1. Process QBO
    try {
        await qbo.syncInvoices();
        results.qbo = 'success';
    } catch (e: any) {
        console.error("QBO Sync Failed (Detail):", e);
        results.qbo = 'failed';
        results.errors.push(`QuickBooks: ${e.message || 'Connection Error'}`);
    }

    // 2. Process Square
    try {
        await square.syncOrders();
        results.square = 'success';
    } catch (e: any) {
        console.error("Square Sync Failed (Detail):", e);
        results.square = 'failed';
        results.errors.push(`Square: ${e.message || 'Sync Error'}`);
    }

    return NextResponse.json({
        success: results.errors.length === 0,
        results
    }, { status: 200 }); // Always 200 if we returned results, button handles content
}
