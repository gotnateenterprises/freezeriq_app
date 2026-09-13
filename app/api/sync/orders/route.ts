
import { NextResponse } from 'next/server';
import { IngestionDBAdapter } from '@/lib/ingestion_db';
import { SquareOrderHandler } from '@/lib/ingestion/square_handler';
import Stripe from 'stripe';

/**
 * Sync Orders — Square only.
 *
 * QB-INVOICE-1A retired the QuickBooks step that used to run first here. It
 * pulled the 50 newest QuickBooks invoices, paid or not, and turned each one
 * into a `production_ready` kitchen Order. That contradicts HARD RULE 1 of
 * docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md (only a PAID FreezerIQ invoice
 * releases fundraiser food), and once FreezerIQ starts creating invoices in
 * QuickBooks it would have imported them straight back as kitchen work.
 *
 * QuickBooks is now a separate, ADMIN-only connector under
 * app/api/integrations/quickbooks/*. Nothing on this route reads QuickBooks,
 * and no QuickBooks record can become an Order through it.
 */
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
    const square = new SquareOrderHandler(db, businessId);
    const results = { square: 'skipped', errors: [] as string[] };

    // Process Square
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
